/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');
  const seatsMcpPath = path.join(__dirname, 'seats-aero', 'server.ts');

  // Capture-and-scrub seats.aero key so the agent's bash subprocesses can't
  // echo it. seats.aero uses a non-standard `Partner-Authorization` header
  // that OneCLI's MITM model can't proxy cleanly, so the key has to live in
  // the MCP subprocess env directly.
  const seatsApiKey = process.env.SEATS_API_KEY ?? '';
  delete process.env.SEATS_API_KEY;

  // Build MCP servers config: nanoclaw built-in + always-on Chesterbot MCPs +
  // any from container.json.
  type StdioMcp = { command: string; args: string[]; env: Record<string, string> };
  type HttpMcp = { type: 'http'; url: string; headers?: Record<string, string> };
  const mcpServers: Record<string, StdioMcp | HttpMcp> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    // Kiwi.com cash-flight search via their hosted remote MCP. No auth.
    'kiwi-flights': {
      type: 'http',
      url: 'https://mcp.kiwi.com',
    },
  };
  // seats.aero (award flight search). Skipped silently when no key — the MCP
  // subprocess would just fail every call with "SEATS_API_KEY not set".
  if (seatsApiKey) {
    mcpServers.seatsaero = {
      command: 'bun',
      args: ['run', seatsMcpPath],
      env: { SEATS_API_KEY: seatsApiKey },
    };
  }

  // Long-running HTTP MCP sidecars on the shared `nanoclaw` docker network.
  // Each is gated on its bearer token being present — when the host hasn't
  // started the sidecar (missing creds, docker down) the agent simply lacks
  // those tools. URL is overridable for tests / non-default sidecar names.
  const haToken = process.env.HA_MCP_TOKEN ?? '';
  if (haToken) {
    mcpServers.homeassistant = {
      type: 'http',
      url: process.env.HA_MCP_URL ?? 'http://ha-mcp:8000/mcp',
      headers: { Authorization: `Bearer ${haToken}` },
    };
  }
  const workspaceToken = process.env.WORKSPACE_MCP_TOKEN ?? '';
  if (workspaceToken) {
    mcpServers.workspace = {
      type: 'http',
      url: process.env.WORKSPACE_MCP_URL ?? 'http://workspace-mcp:8000/mcp',
      headers: { Authorization: `Bearer ${workspaceToken}` },
    };
  }
  const playwrightToken = process.env.PLAYWRIGHT_MCP_TOKEN ?? '';
  if (playwrightToken) {
    mcpServers.playwright = {
      type: 'http',
      url: process.env.PLAYWRIGHT_MCP_URL ?? 'http://playwright-mcp:8000/mcp',
      headers: { Authorization: `Bearer ${playwrightToken}` },
    };
  }

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${'type' in serverConfig ? serverConfig.type : serverConfig.command})`);
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
