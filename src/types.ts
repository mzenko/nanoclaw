export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  // Optional: send a message with file attachments. Channels that don't
  // implement this fall back to sendMessage(text-only); the agent-supplied
  // file paths are dropped silently.
  sendAttachment?(
    jid: string,
    text: string,
    files: Array<{ hostPath: string; name: string }>,
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: warm any per-channel client cache for this JID. Discord uses
  // this to pre-fetch DM channels (works around discord.js v14.26.x dropping
  // MESSAGE_CREATE for uncached DMs). Other channels can no-op.
  warmChannel?(jid: string): Promise<void>;
  // Optional: per-turn progress display. Channels that don't implement these
  // simply don't show progress; the agent runs as before.
  beginProgress?(jid: string): Promise<ProgressHandle | null>;
  updateProgress?(handle: ProgressHandle, event: ProgressEvent): Promise<void>;
  endProgress?(
    handle: ProgressHandle,
    success: boolean,
    reason?: 'cancelled',
  ): Promise<void>;
  // Optional: at boot, mark any embeds left orphaned by a crash/restart so the
  // user knows the agent didn't finish that turn.
  sweepStaleProgress?(): Promise<void>;
}

// --- Progress events ---

export type ProgressEvent =
  | { kind: 'begin'; turnId: string }
  | {
      kind: 'tool_use';
      turnId: string;
      name: string;
      summary?: string;
      // When this tool_use originated from a subagent, the id of the parent
      // agent's `Task()` tool_use that spawned it. The host groups tool calls
      // by this id in the embed.
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

export interface ProgressHandle {
  channel: string;
  data: unknown;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
