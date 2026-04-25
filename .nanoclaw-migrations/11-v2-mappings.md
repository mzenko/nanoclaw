# 11 — V2 Mappings (Phase C output)

This file is the output of Phase C research. It supplements files 01–10 with concrete v2 file paths and architectural changes that affect how each customization needs to be reapplied.

**Research targets used**: `/tmp/nanoclaw-research/upstream/` (main) and `/tmp/nanoclaw-research/upstream-channels/` (channels branch) — both at the upstream HEAD recorded in `.meta`.

---

## Architecture changes that hit our customizations hardest

### A. `ensureSidecar()` is GONE; Docker bridge network is GONE

V2 boot sequence (`src/index.ts`): init DB → run migrations → `ensureContainerRuntimeRunning()` → `cleanupOrphans()` → start adapters → start delivery polls → start host sweep. **No sidecar startup. No `nanoclaw` Docker network. No `--network nanoclaw` on container spawn.**

`src/container-runtime.ts` is 91 lines and contains zero network management. Containers reach external services via `--add-host=host.docker.internal:host-gateway` only.

**Implications for sidecar migration (files 06–08)**:
- Old service-discovery via `http://ha-mcp:8080/...` no longer resolves — hostname does not exist
- Two viable v2 patterns:
  - **Option 1: HTTP via host-gateway**. Sidecars still run as separate Docker containers but expose ports on the host's loopback. Agent reaches them via `http://host.docker.internal:<port>/mcp`. Requires the sidecar's `start.sh` to bind port to host (not `--network nanoclaw`).
  - **Option 2: Convert to stdio MCPs**. Drop the Caddy bearer-gate (no longer needed since stdio is in-process), drop the separate container, register as stdio entries in `container.json`. Cleaner but requires repackaging each sidecar's binary for direct invocation.
- **Default per architectural decision**: Option 1 (least change to sidecars themselves; sidecars stay separate skill-installable repos per philosophy). Each `start.sh` adjusted to `-p 127.0.0.1:<port>:8000` instead of `--network nanoclaw`.
- Token injection moves from `-e HA_MCP_TOKEN=...` (gone) to `groups/<folder>/container.json` `mcpServers[name].env` (per-group config file)

### B. MCP `mcpServers` config moved to per-group `container.json`

V2's `container/agent-runner/src/index.ts` lines 76–87:

```ts
const mcpServers = {
  nanoclaw: { command: 'bun', args: ['run', mcpServerPath], env: {} },
};
for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
  mcpServers[name] = serverConfig;
}
```

Where `config` comes from `/workspace/agent/container.json` mounted into the container. Schema (`src/container-config.ts` `ContainerConfig.mcpServers`):

```ts
mcpServers: Record<string, McpServerConfig>;
// McpServerConfig = { command, args, env, instructions? }
```

**Implications**:
- The `mcpServers.kiwi-flights` (HTTP) and `mcpServers.seats` (stdio) entries we added to v1's `index.ts` should move into the per-group `container.json` for any group that wants them
- Or — for Chesterbot specifically, since we want flight tools available to ALL groups — the cleanest path is to **add them as defaults inside the v2 agent-runner's index.ts** alongside the built-in nanoclaw MCP (a single-line edit), rather than per-group config
- The `instructions` field on each `McpServerConfig` is what gets composed into CLAUDE.md as a fragment. Use this for seats.aero's existing `INSTRUCTIONS` constant.

### C. `allowedTools` now hardcoded in `container/agent-runner/src/providers/claude.ts` lines 38–58

```ts
const TOOL_ALLOWLIST = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage', 'TodoWrite',
  'ToolSearch', 'Skill', 'NotebookEdit',
  'mcp__nanoclaw__*',
];
```

**Action**: add `'mcp__seats__*'`, `'mcp__kiwi-flights__*'`, `'mcp__homeassistant__*'`, `'mcp__playwright__*'`, `'mcp__workspace__*'` to this list (one line each).

### D. No env-scrub pattern needed in v2

V2 doesn't `delete process.env.SEATS_API_KEY`. Secrets for stdio MCPs are never in process env at all — they live in `mcpServers[name].env` in container.json, and the SDK passes that env map only to the specific stdio MCP subprocess. **The M7 env-scrub pattern is OBSOLETE in v2** (file `01-marker-nonce.md` has wider implications too — see below).

### E. Marker nonce IPC is OBSOLETE

V2's two-DB session split (`inbound.db` / `outbound.db`) replaces stdout-marker IPC entirely. There is no stdout marker parsing in v2's host. **File `01-marker-nonce.md` is OBSOLETE — drop it**. The agent-runner writes to `outbound.db`, the host reads from `outbound.db`. Stale-stdout collision can't happen.

### F. Discord adapter is `@chat-adapter/discord`, not raw discord.js

V2's `src/channels/discord.ts` (channels branch) imports `createDiscordAdapter` from `@chat-adapter/discord` v4.24.0. All Discord API calls go through Chat SDK primitives (`postMessage`, `editMessage`, `addReaction`, `startTyping`).

**Implications for our progress UI / subagent embeds / ❌ cancel port**:
- We can't directly use discord.js's `EmbedBuilder` — must work through `@chat-adapter/discord`'s primitives or extend the bridge
- Reaction listener must be added to `chat-sdk-bridge.ts`'s `handleForwardedEvent` (currently only handles `ncq:` button interactions per `chat-sdk-bridge.ts:238–263`)
- Progress embeds need to be built via the Chat SDK's `editMessage` API

---

## Per-cluster v2 mapping notes

### Discord (file 04) — feature-by-feature parity vs v2

| # | v1 Feature | v2 Status | Action |
|---|---|---|---|
| 1 | Core send/receive | PARTIAL | DELTA_PATCH: add `maxTextLength: 2000` to `createChatSdkBridge` call in `discord.ts:30-37` (chunking is currently disabled in v2) |
| 2 | Inbound attachment download | PARTIAL | v2 base64-encodes into message JSON instead of writing to disk. Verify container agent reads `attachments[].data`. If not, port v1's disk-write+descriptor pattern. |
| 3 | Outbound attachment send | PARTIAL | DELTA_PATCH: add 10 MiB gate (v2 doesn't enforce explicitly) |
| 4 | Reply context | PRESENT | KEEP_V2 — `discord.ts:12-19` `extractReplyContext` writes `serialized.replyTo`. Confirm agent-side prompt formats it. |
| 5 | DM cache warming | ABSENT | PORT_FROM_V1 (likely needed since `@chat-adapter/discord` may have same discord.js underlying quirk) |
| 6 | Progress embed UI | ABSENT | PORT_FROM_V1 — biggest port. Build via `editMessage` through Chat SDK adapter. |
| 7 | Subagent embed cards | ABSENT | PORT_FROM_V1 — depends on #6. Agent-runner emission code (`agentProgressSummaries`, task_started/progress/notification) also doesn't exist in v2 — port both sides together. |
| 8 | ❌ reaction-cancel | ABSENT | PORT_FROM_V1 — extend `handleForwardedEvent` to listen for `MESSAGE_REACTION_ADD` events. Wire `onStopRequest` → session close path. |
| 9 | Typing indicator | PRESENT (better) | KEEP_V2 — `src/modules/typing/index.ts` 4s cadence > our 7s cadence; heartbeat-gated auto-stop is a bonus. |
| 10 | JID format | DIFFERENT | DELTA_PATCH: `dc:<channel-id>` → whatever `@chat-adapter/discord` uses (likely `discord:<guildId>:<channelId>`). Audit registered group rows in DB and remigrate. |
| 11 | `onChatMetadata` for unregistered | PARTIAL | DELTA_PATCH: wire Chat SDK's metadata discovery through `onMetadata` |

**Bigger question for Phase E1**: the v2 SDK + Chat SDK bridge may have its own progress/streaming infra we haven't found yet. Before reimplementing the embed system from scratch, grep for `progress`, `streaming`, `partial` in `delivery.ts` and `chat-sdk-bridge.ts`. There may be a v2-native event stream we can hook into.

### seats.aero (file 02) — drop-in port

- `container/agent-runner/src/seats-aero/` files port unchanged
- Add a single entry in `container/agent-runner/src/index.ts` mcpServers map (or in per-group `container.json`)
- `command: 'bun'` instead of `'node'` if the seats source stays as TypeScript (`bun run server.ts`)
- Add `'mcp__seats__*'` to `TOOL_ALLOWLIST` in `providers/claude.ts:38-58`
- `SEATS_API_KEY` lives in `container.json` `mcpServers.seats.env.SEATS_API_KEY`, NOT in `.env`. Provision via OneCLI or per-group setting.
- Use `instructions: SERVER_INSTRUCTIONS` field on the McpServerConfig so the existing INSTRUCTIONS constant becomes a CLAUDE.md fragment automatically

### Kiwi (file 03) — one-liner

- Same single entry pattern: `'kiwi-flights': { command: '...', args: [...], env: {} }`
- Wait — Kiwi is a remote HTTP MCP. Verify v2's `McpServerConfig` supports `type: 'http'` or only stdio. If only stdio, we need to keep Kiwi entries in agent-runner's index.ts hardcoded merge.
- Add `'mcp__kiwi-flights__*'` to allowlist

### Sidecars (files 06, 07, 08)

For each sidecar:
1. Modify `start.sh` to expose port on host loopback: `docker run -d -p 127.0.0.1:<port>:8000 --restart unless-stopped` (drop `--network nanoclaw`)
2. Update `container.json` for any group that needs the sidecar (or default group):
   ```json
   {
     "mcpServers": {
       "homeassistant": {
         "command": "bun",
         "args": ["run", "/app/scripts/http-mcp-proxy.ts", "http://host.docker.internal:8081/mcp"],
         "env": { "HA_MCP_TOKEN": "..." }
       }
     }
   }
   ```
   *(or whatever wrapper the v2 agent-runner provides for HTTP MCPs from stdio config)*
3. Skill installation moves to v2-style — the mzenko sidecar repo's skill should write the `container.json` entries on install
4. Per-architectural-decision: keep sidecars as separate mzenko-org skill-installable repos. Each repo's skill writes the right container.json updates.

### Persona (file 09) — major model change

V2's `src/claude-md-compose.ts` writes per-group:
- `CLAUDE.md` with only `@./` import directives (auto-generated)
- `.claude-shared.md` (symlink to `/app/CLAUDE.md`)
- `.claude-fragments/{mcp,module,skill}-<name>.md` (one per source)

**To add Chester persona content**: 
- Either write a `container/skills/chester-persona/instructions.md` that gets included in every group's composed CLAUDE.md
- Or add it as a custom MCP server `instructions` field (less appropriate)
- Or use `groups/<folder>/CLAUDE.local.md` for per-group overrides (per the composer's "do not edit CLAUDE.md, edit CLAUDE.local.md" comment)

The agent's name ("Chester") is injected at runtime via system-prompt addendum from `config.assistantName` (set in container.json). NOT into CLAUDE.md content. Set `assistantName: "Chester"` per-group.

### Skills (file 10) — diffs against v2

V2's setup skill (`new-setup`/`setup`) has 16+ commits. Our setup tweaks are tiny (6 line removals). Most likely those lines are already gone in v2 — re-check during E6. Likely action: **drop our setup tweaks entirely**.

The two workflows we deleted (`bump-version.yml`, `update-tokens.yml`) — re-delete after v2 import.

## Dependency / build flow

- Host: pnpm 10.33.0 + tsc (no bun on host)
- Container: bun for agent-runner (`bun install` in Dockerfile)
- Setup: `pnpm install`, `pnpm run build`, `pnpm run dev`
- Install pnpm: corepack should work (`corepack enable && corepack prepare pnpm@10.33.0 --activate`)

## Things that are now OBSOLETE and should NOT be ported

- Marker nonce IPC (file 01) — replaced by two-DB
- M7 env-scrub pattern — replaced by container.json mcpServers env
- Per-group `agent-runner-src` copies — replaced by RO mount at `/app/src`
- Per-group hand-edited `groups/<folder>/CLAUDE.md` — replaced by composer
- Channel files at `src/channels/{discord,gmail,telegram,slack,whatsapp}.ts` — replaced by v2 adapter pattern
- `.github/workflows/bump-version.yml` and `update-tokens.yml` — re-delete

## Next: Phase D

Stage v2 in a worktree (`git worktree add ../nanoclaw-v2-stage upstream/main`), install pnpm + deps, build clean, run any v1→v2 data migration script if present. Then proceed to Phase E.
