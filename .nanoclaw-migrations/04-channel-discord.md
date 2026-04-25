# 04 — Discord channel (BIGGEST customization)

This is the channel-progress fork's contribution plus our own additions on top. Discord is Chester's **primary** channel — this is the priority cluster.

## Approach for v2 (per user directive)

**Default to v2's Chat SDK Discord adapter.** Re-implement only the features v2 lacks. For each feature below, the Phase C investigation must compare against v2's adapter (on the `channels` branch of qwibitai/nanoclaw) and flag what's missing.

If v2's adapter is materially worse, modify it rather than swap it out.

## Features to verify and (re-)implement

### Core adapter (likely in v2)
- Connect via `discord.js` Client
- `MessageCreate` listener → route to `onMessage(jid)`
- `sendMessage` chunks at 2000-char Discord limit
- Read `DISCORD_BOT_TOKEN` from env

### Attachment download (likely NOT in v2)
- For each inbound `Attachment`: stream via `fetch()` + `pipeline()` into `<group-folder>/attachments/<msgId>-<name>`
- Append descriptor to message: `[Image: photo.png — read from /workspace/group/attachments/<msgId>-<name>]`
- Handles oversized + unregistered-chat attachment cases with plain-text notes
- **Source**: discord.ts lines 197-211, 437-477 in v1

### Outbound attachment send (`sendAttachment`)
- Enforces 10 MiB/file Discord limit
- Discards oversize files individually with text note
- **Source**: discord.ts lines 348-420 in v1

### Reply context (likely NOT in v2)
- If `message.reference.messageId` is present, fetch referenced message
- Prepend `[Reply to <name>] <content>` to the agent's prompt
- **Source**: discord.ts lines 212-225 in v1

### DM cache warming (likely NOT in v2 — discord.js quirk)
- discord.js silently drops `MessageCreate` for DM channels not pre-cached
- At startup: `warmChannelCache()` calls `client.channels.fetch()` for every registered `dc:` JID
- At runtime: `warmChannel(jid)` called from `src/index.ts` line 179 when a new group is registered
- Declared on `Channel` interface: `src/types.ts` line 109
- **Source**: discord.ts lines 293-314

### Progress embed UI (DEFINITELY NOT in v2 — our work)
**Why**: Users see real-time blurple "Thinking…" embed updating with tool call names + text previews while agent works. Success → delete cleanly. Failure → red. User cancel → grey.

**Mechanism**:
- `beginProgress(jid)` posts placeholder embed, stores `ProgressState` keyed by message ID. Persists to `DATA_DIR/discord-progress-pending.json` so orphans can be swept after a crash.
- `updateProgress(handle, event)` mutates state (tool calls ring-buffered at 5, text preview capped at 280 chars), calls `scheduleProgressEdit()` which rate-limits Discord API edits to 1 per 1100 ms.
- `applyProgressEdit()` builds embed array: slot 0 = parent, slots 1-9 = open subagent embeds. Calls `msg.edit({ embeds })`.
- `endProgress(handle, success, reason?)` cancels pending timers, awaits in-flight edit (`inFlightEdit` promise), then deletes (success) or terminal red/grey edit (failure/cancelled).
- `sweepStaleProgress()` runs at startup → updates JSON-persisted orphans to grey "Interrupted".

**Constants**: `PROGRESS_EDIT_GAP_MS=1100`, `PROGRESS_TOOL_HISTORY=5`, `PROGRESS_PREVIEW_CHARS=280`, `MAX_VISIBLE_SUBAGENTS=9`.

**Persistent state file**: `DATA_DIR/discord-progress-pending.json` (mutex-guarded via `pendingMutex` promise chain)

**Source**: discord.ts lines 507-893 + host wiring `src/index.ts` lines 323-411 + interface declarations `src/types.ts` lines 112-121

### Subagent embed cards (DEFINITELY NOT in v2 — our work, commit 02c91f1)

**Why**: Each active subagent (spawned via `Agent`/`Task`) gets its own embed card with description + recent tool calls. Users see parallel work happening.

**Agent-runner emission** (`container/agent-runner/src/index.ts` lines 559-929):
- Scan every `assistant` message for `tool_use` blocks
- `Agent`/`Task` block on parent → emit `subagent_begin`
- Matching `tool_result` in `user` message → emit `subagent_end`
- **Background subagents** (`run_in_background: true`):
  - Immediate `tool_result` is just an ack → withhold `subagent_end`
  - `system/task_started` → build `task_id → tool_use_id` map
  - `system/task_progress` (requires `agentProgressSummaries: true` SDK option) → fire per-subagent tool_name + summary as tool_use events (deduped on tool name)
  - `system/task_notification` → fire real `subagent_end`

**Channel-side rendering** (discord.ts lines 548-607):
- `updateProgress` events with `event.subagentId` route to matching `SubagentSection` in `state.subagents`
- `subagent_begin` inserts new section (evict oldest if ≥9)
- `subagent_end` removes
- `applyProgressEdit` renders one embed per section

**Required state**: agent-runner in-memory: `openSubagents: Set`, `backgroundSubagents: Set`, `taskIdToToolUseId: Map`, `lastProgressToolBySubagent: Map`, `turnId: string` (rotated per IPC turn boundary).

**Required SDK option**: `agentProgressSummaries: true`

### ❌ Reaction-cancellation (DEFINITELY NOT in v2 — our work)

**Emoji**: `❌` (Unicode U+274C, `STOP_REACTION` constant)

**Cancels**: current in-progress agent turn for the channel where the reaction was added

**Flow**:
1. `handleReaction()` fires on `MessageReactionAdd`. Ignores bot users + non-❌ emojis.
2. Hydrate partials. Verify the reacted-to message was authored by the bot (prevents random user ❌ on user messages from being a stop signal).
3. Call `opts.onStopRequest?.(chatJid)`.
4. `src/index.ts` lines 816-820: `onStopRequest` adds `chatJid` to `userStoppedChats` Set, calls `queue.closeStdin(chatJid)` → close sentinel to container.
5. Agent-runner's `pollIpcDuringQuery` detects `shouldClose()`, calls `abortController.abort()`, ends SDK stream.
6. Progress embed's `end` event arrives with `success=false`. Host checks `userStoppedChats.has(chatJid)`, passes `reason='cancelled'` to `endProgress`, renders grey "Cancelled" embed instead of red "Failed".

**Source**: discord.ts lines 478-506 (handleReaction) + src/index.ts lines 816-820 (wiring), 335-342 (cancelled tagging) + container/agent-runner/src/index.ts lines 600-610 (abort on close sentinel).

### Typing indicator
- `setTyping(jid, on)` in discord.ts lines 873-886
- Host calls every 7 seconds via typing keepalive (Discord's `sendTyping()` expires after 10s)
- v2 has typing handling per commit `d656b5c` — **verify** the 7s keepalive cadence matches; modify if not.

## Test channel

Register `#🔧testing-mr-chesterbot` (Discord channel ID `1497696244934508594`) as a main-style channel — responds to all messages without @-mention requirement.

```bash
# pseudo-command, syntax depends on v2's register flow
register --jid "dc:1497696244934508594" --name "🔧testing-mr-chesterbot" --folder "discord_testing-mr-chesterbot" --no-trigger-required --is-main
```

## V2 reapplication order

1. Install v2's Discord adapter from `channels` branch via skill (likely `/add-discord` or `/add-discord-v2`)
2. Register the test channel
3. Send a basic message — confirm v2 adapter works
4. Compare each feature above against the v2 adapter source — for missing ones, port the v1 implementation
5. The agent-runner subagent emission code is the most tightly coupled to the SDK plumbing — port it carefully and verify with a `Task`/`Agent` spawn test
