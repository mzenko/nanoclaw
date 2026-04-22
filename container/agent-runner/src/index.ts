/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Markers carry a per-spawn random suffix (NANOCLAW_MARKER_NONCE, set by
// the host runner). Required — if missing, the host parser would never match
// our markers and every turn would silently look like it produced no output.
// Better to fail loud at boot than to ship empty replies.
const NONCE_FROM_ENV = process.env.NANOCLAW_MARKER_NONCE;
if (!NONCE_FROM_ENV) {
  throw new Error(
    'NANOCLAW_MARKER_NONCE is not set. The host container-runner must pass ' +
      'this env so output/progress markers match what it parses. Refusing to ' +
      'start.',
  );
}
const MARKER_NONCE = `_${NONCE_FROM_ENV}`;
const OUTPUT_START_MARKER = `---NANOCLAW_OUTPUT_START${MARKER_NONCE}---`;
const OUTPUT_END_MARKER = `---NANOCLAW_OUTPUT_END${MARKER_NONCE}---`;
const PROGRESS_START_MARKER = `---NANOCLAW_PROGRESS_START${MARKER_NONCE}---`;
const PROGRESS_END_MARKER = `---NANOCLAW_PROGRESS_END${MARKER_NONCE}---`;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

type ProgressEvent =
  | { kind: 'begin'; turnId: string }
  | {
      kind: 'tool_use';
      turnId: string;
      name: string;
      summary?: string;
      subagentId?: string;
    }
  | {
      kind: 'subagent_begin';
      turnId: string;
      subagentId: string;
      name: string;
    }
  | { kind: 'subagent_end'; turnId: string; subagentId: string }
  | { kind: 'text_chunk'; turnId: string; text: string }
  | { kind: 'status'; turnId: string; label: string }
  | { kind: 'end'; turnId: string; success: boolean; error?: string };

function writeProgress(event: ProgressEvent): void {
  console.log(PROGRESS_START_MARKER);
  console.log(JSON.stringify(event));
  console.log(PROGRESS_END_MARKER);
}

// Build a one-line "what is this tool doing" summary suitable for showing in
// progress UIs. Skips fields that would dump file bodies or large content,
// truncates aggressively. The MCP servers in this stack receive stub
// credentials (proxied by OneCLI) so the agent itself doesn't hold live
// secrets, but a user pasting a token into chat can still flow into a tool
// arg — so we explicitly redact secret-looking key names.
const SECRET_KEY_RE =
  /^(token|api[_-]?key|apikey|secret|password|passwd|authorization|auth|bearer|credential|x[-_]api[-_]key)$/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

// Scrub embedded secrets from arbitrary tool-arg strings (Bash commands in
// particular). Catches Authorization headers, common <key><sep><value>
// secret patterns, and the http://x:<token>@host OneCLI proxy syntax. The
// rules are intentionally narrow: they only match where the surrounding
// syntax strongly implies "secret here", to avoid clobbering benign content.
type RedactRule = {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
};

const REDACT_RULES: RedactRule[] = [
  // Authorization: Bearer X  /  Authorization: Basic X  /  Authorization: <raw>
  // The scheme keyword is now optional so a bare `Authorization: token123`
  // also redacts.
  {
    re: /(Authorization\s*:\s*(?:(?:Bearer|Basic)\s+)?)(\S+)/gi,
    replace: (_m, prefix) => `${prefix}<redacted>`,
  },
  // curl: -H 'Authorization: ...'  /  --header "Authorization: ..."
  {
    re: /(-H\s+["']?Authorization\s*:\s*(?:(?:Bearer|Basic)\s+)?)(\S+)/gi,
    replace: (_m, prefix) => `${prefix}<redacted>`,
  },
  // <key><sep><value> with sep ∈ {=, :}; key ends with one of the secret
  // suffixes (token, secret, password, etc.). Catches FOO_TOKEN=x,
  // mytoken=x, apiKey: "x", api_key=x, --secret xxx, etc. Anchored on
  // start-of-string OR a non-word char so identifiers like `mytoken` (where
  // \b doesn't fire between letters) still match.
  {
    re: /(^|[^A-Za-z0-9_])((?:[A-Za-z][A-Za-z0-9_]*)?(?:token|api[_-]?key|apikey|secret|password|passwd|bearer|credential))(\s*[:=]\s*["']?)([^"'\s,;}\]]+)/gi,
    replace: (_m, pre, key, sep) => `${pre}${key}${sep}<redacted>`,
  },
  // OneCLI proxy creds embedded in URLs: http://user:token@host
  {
    re: /(https?:\/\/[^:@\s/]+:)[^@\s]+(@)/gi,
    replace: (_m, pre, suf) => `${pre}<redacted>${suf}`,
  },
];

function redactSecrets(s: string): string {
  let out = s;
  for (const { re, replace } of REDACT_RULES) {
    out = out.replace(re, replace);
  }
  return out;
}

function summarizeToolInput(
  name: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  // Drop bulky content fields regardless of tool — Write/Edit/etc. would dump
  // entire file bodies into the embed.
  const SKIP_KEYS = new Set([
    'content',
    'new_string',
    'old_string',
    'file_text',
    'body',
  ]);
  // Per-tool "headline" field — the one identifier most useful for status.
  const HEADLINE: Record<string, string> = {
    Bash: 'command',
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    Glob: 'pattern',
    Grep: 'pattern',
    WebFetch: 'url',
    WebSearch: 'query',
  };
  const headline = HEADLINE[name];
  let text: string;
  if (headline && typeof input[headline] === 'string') {
    text = `${headline}=${redactSecrets(input[headline] as string)}`;
  } else {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (SKIP_KEYS.has(k)) continue;
      if (isSecretKey(k)) {
        parts.push(`${k}=<redacted>`);
        continue;
      }
      if (typeof v === 'string') parts.push(`${k}=${redactSecrets(v)}`);
      else if (typeof v === 'number' || typeof v === 'boolean')
        parts.push(`${k}=${v}`);
      // skip arrays/objects — too noisy for a one-liner
    }
    if (parts.length === 0) return undefined;
    text = parts.join(' ');
  }
  if (text.length > 80) text = text.slice(0, 79) + '…';
  return text;
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
interface McpTokens {
  workspace: string;
  playwright: string;
  ha: string;
  // seats.aero uses a non-standard `Partner-Authorization` header which
  // OneCLI doesn't rewrite, so the API key lives in container env. Captured
  // and scrubbed from process.env in main() like the others (M7 pattern).
  seats: string;
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  seatsMcpPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  mcpTokens: McpTokens,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  // turnId rotates per turn boundary — at the initial prompt and again every
  // time a follow-up IPC message is pushed into the stream. End is emitted
  // when each `result` message arrives. The host uses turnId to scope its
  // per-turn UI handle (e.g. one Discord embed per turn).
  let turnId = randomUUID();
  writeProgress({ kind: 'begin', turnId });

  // Track open subagents so we can emit subagent_end when the parent receives
  // the matching tool_result. Keyed by the parent's Task() tool_use.id.
  const openSubagents = new Set<string>();

  // AbortController for the entire query. When the user signals stop (close
  // sentinel from the host), abort fires and the SDK exits the for-await
  // loop with a terminal 'aborted_*' subtype. The orchestrator will spawn a
  // fresh container on the next message; session state is preserved by
  // resume:sessionId so the user's context is not lost.
  const abortController = new AbortController();

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, aborting current turn');
      closedDuringQuery = true;
      abortController.abort();
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      // New IPC message = new turn beginning.
      turnId = randomUUID();
      writeProgress({ kind: 'begin', turnId });
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      // Cancellation: abort() from pollIpcDuringQuery unwinds the SDK loop on
      // user-requested stop.
      abortController,
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Agent',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__workspace__*',
        'mcp__playwright__*',
        'mcp__homeassistant__*',
        'mcp__seats__*',
        'mcp__kiwi-flights__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        workspace: {
          type: 'http',
          url:
            process.env.WORKSPACE_MCP_URL ??
            'http://workspace-mcp:8000/mcp',
          headers: {
            Authorization: `Bearer ${mcpTokens.workspace}`,
          },
        },
        playwright: {
          type: 'http',
          url:
            process.env.PLAYWRIGHT_MCP_URL ??
            'http://playwright-mcp:8000/mcp',
          headers: {
            Authorization: `Bearer ${mcpTokens.playwright}`,
          },
        },
        homeassistant: {
          type: 'http',
          url: process.env.HA_MCP_URL ?? 'http://ha-mcp:8000/mcp',
          headers: {
            Authorization: `Bearer ${mcpTokens.ha}`,
          },
        },
        seats: {
          command: 'node',
          args: [seatsMcpPath],
          // Pass the API key into the seats MCP subprocess only; the parent
          // process.env has already been scrubbed in main().
          env: { SEATS_API_KEY: mcpTokens.seats },
        },
        // Kiwi.com's official remote MCP for cash-flight search.
        // No auth, no key — Kiwi hosts and rate-limits it themselves.
        // See: https://github.com/alpic-ai/kiwi-mcp-server-public
        'kiwi-flights': {
          type: 'http',
          url: 'https://mcp.kiwi.com',
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // Subagent attribution: parent_tool_use_id is set on every assistant
      // message coming from a Task()-spawned subagent. Null means the parent
      // agent itself.
      const subagentId =
        (message as { parent_tool_use_id?: string | null })
          .parent_tool_use_id ?? undefined;
      const blocks = ((message as unknown as {
        message?: { content?: Array<Record<string, unknown>> };
      }).message?.content ?? []) as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          // The parent inviting a subagent — emit subagent_begin so the host
          // can open a new section. The SDK currently exposes this tool as
          // `Agent` (older names: `Task`). Accept both so a future rename
          // doesn't silently break subagent attribution again. The tool's
          // `description` field is the human-friendly label.
          if (
            (block.name === 'Agent' || block.name === 'Task') &&
            !subagentId &&
            typeof block.id === 'string'
          ) {
            const input = block.input as Record<string, unknown> | undefined;
            const desc =
              (input && typeof input.description === 'string'
                ? input.description
                : undefined) ?? 'subagent';
            openSubagents.add(block.id);
            writeProgress({
              kind: 'subagent_begin',
              turnId,
              subagentId: block.id,
              name: desc,
            });
          }
          const summary = summarizeToolInput(
            block.name,
            block.input as Record<string, unknown> | undefined,
          );
          writeProgress({
            kind: 'tool_use',
            turnId,
            name: block.name,
            ...(summary ? { summary } : {}),
            ...(subagentId ? { subagentId } : {}),
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          writeProgress({
            kind: 'text_chunk',
            turnId,
            text: block.text.slice(0, 280),
          });
        }
      }
    }

    // Subagent end: the parent's user message contains tool_result blocks for
    // its own outstanding tool_use ids. When one matches an open subagent,
    // that subagent's work has wrapped — close its section.
    if (message.type === 'user') {
      const blocks = ((message as unknown as {
        message?: { content?: Array<Record<string, unknown>> };
      }).message?.content ?? []) as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string' &&
          openSubagents.has(block.tool_use_id)
        ) {
          openSubagents.delete(block.tool_use_id);
          writeProgress({
            kind: 'subagent_end',
            turnId,
            subagentId: block.tool_use_id,
          });
        }
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'compact_boundary'
    ) {
      writeProgress({ kind: 'status', turnId, label: 'compacting' });
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
      // Each result closes a turn — flip the embed and clear typing.
      writeProgress({
        kind: 'end',
        turnId,
        success: message.subtype === 'success',
      });
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Capture MCP sidecar bearer tokens then DELETE them from process.env.
  // The SDK and any Bash subprocess it spawns inherit env at fork time —
  // once these are out of process.env, an `echo $HA_MCP_TOKEN` returns
  // empty. The captured locals stay in this process for the mcpServers
  // Authorization headers. HTTPS_PROXY is intentionally left in env because
  // legitimate subprocess HTTPS calls go through OneCLI.
  const mcpTokens: McpTokens = {
    workspace: process.env.WORKSPACE_MCP_TOKEN ?? '',
    playwright: process.env.PLAYWRIGHT_MCP_TOKEN ?? '',
    ha: process.env.HA_MCP_TOKEN ?? '',
    seats: process.env.SEATS_API_KEY ?? '',
  };
  delete process.env.WORKSPACE_MCP_TOKEN;
  delete process.env.PLAYWRIGHT_MCP_TOKEN;
  delete process.env.HA_MCP_TOKEN;
  delete process.env.SEATS_API_KEY;

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const seatsMcpPath = path.join(__dirname, 'seats-aero', 'server.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        seatsMcpPath,
        containerInput,
        sdkEnv,
        mcpTokens,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
