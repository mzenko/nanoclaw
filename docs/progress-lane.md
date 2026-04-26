# Progress Lane (Discord)

A separate outbound message lane carrying structured progress events from the agent container to the Discord channel adapter, used to render a live "thinking" embed and per-subagent embed cards.

## Why a separate lane

The existing `messages_out` rows for normal text replies, system actions, and edits all flow through the same delivery path. Progress events are different:

- **High frequency** — multiple per second mid-turn, vs ~1 per turn for replies
- **Discardable** — losing one update is fine; losing a reply is a bug
- **Discord-specific UX** — other channels (Slack, Telegram) get nothing today; future per-channel renderers can subscribe later
- **Rate-limited** — Discord throttles edits; the lane needs its own batching/coalescing distinct from delivery's per-message behavior

Putting them on the same kind would force the delivery loop to know about progress semantics. Separating keeps `delivery.deliver()` clean and lets the bridge handle progress as a first-class concern.

## Data flow

```
SDK message stream (claude.ts)
  ├─ assistant w/ tool_use   ──► subagent_begin  (Agent / Task tools)
  ├─ user w/ tool_result     ──► subagent_end    (foreground only)
  ├─ system/task_started     ──► track task_id → tool_use_id
  ├─ system/task_progress    ──► tool_use (deduped)  + subagent attribution
  ├─ system/task_notification──► subagent_end (background)
  └─ assistant text          ──► text_delta (capped)
                                       │
                                       ▼
                          poll-loop.ts handleEvent
                                       │
                                       ▼
                          messages_out (kind='progress',
                                        content=ProgressEvent JSON)
                                       │
                                       ▼
                          delivery.ts deliverMessage
                          ── if kind==='progress' ──►
                                       │
                                       ▼
                          ChannelAdapter.progress?(...)
                                       │
                                       ▼
                          discord-progress.ts
                          (per-session ProgressState,
                           rate-limited Card edits,
                           crash-recovery JSON)
                                       │
                                       ▼
                          Discord embed (Card → editMessage)
```

## ProgressEvent schema

```ts
type ProgressEvent =
  | { type: 'begin'; sessionId: string }
  | { type: 'tool_use'; toolName: string; subagentId?: string; description?: string }
  | { type: 'text_delta'; preview: string; subagentId?: string }
  | { type: 'subagent_begin'; subagentId: string; description: string }
  | { type: 'subagent_end'; subagentId: string }
  | { type: 'end'; success: boolean; reason?: 'cancelled' | 'failed' };
```

`subagentId` on `tool_use` / `text_delta` ties the event to a specific subagent's embed slot. Absent = parent embed.

## Rendering decision: Card primitive (no color)

The Chat SDK's `Card` element has `title`, `subtitle`, `imageUrl`, `children` — but no `color` field. Discord embeds default to gray.

**Trade-off taken**: status communicated via emoji in title (🤔 Thinking… / ✅ / ❌ Failed / 🚫 Cancelled) rather than embed color. Loses the v1 fork's blurple-to-red visual. Cleaner cross-channel future (Slack/Teams cards have different color models anyway).

If Discord-default gray turns out to look bad in practice, fall back to bypassing Card and calling Discord REST `PATCH /channels/.../messages/...` directly with raw embed JSON.

## Per-session state

`Map<sessionId, ProgressState>` in the bridge:

```ts
interface ProgressState {
  platformId: string;        // for delivery
  threadId: string | null;
  messageId: string;         // Discord message id of parent embed
  toolHistory: string[];     // ring buffer, max 5
  textPreview: string;       // capped at 280 chars
  subagents: Map<string, SubagentSection>;  // up to 9 visible
  status: 'thinking' | 'success' | 'failed' | 'cancelled';
  pendingEdit?: NodeJS.Timeout;
  inFlightEdit?: Promise<void>;
}
interface SubagentSection {
  description: string;
  toolHistory: string[];     // ring buffer, max 5
  messageId?: string;        // separate Discord message; undefined while pending creation
}
```

## Rate limit + edit batching

`PROGRESS_EDIT_GAP_MS = 1100` — minimum gap between Discord API edits per session. `pendingEdit` timer coalesces rapid updates. `inFlightEdit` promise prevents overlap.

Discord 429: catch, log, back off 5s, retry once.

## Persistence

`data/progress-pending.json` — list of `{ sessionId, platformId, threadId, messageId, startedAt }`. Written on `begin`, removed on `end`. Mutex (promise chain) serializes file writes.

On host startup, `sweepStaleProgress()` walks the file. For each entry whose session is no longer running, edit the embed to gray "🚫 Interrupted (host restarted)" and remove from JSON.

## Cross-channel policy

`ChannelAdapter.progress?()` is **optional**. Adapters that don't implement it (Slack, Telegram, CLI, etc.) silently drop progress events at the delivery dispatch point — no breakage. Future: per-channel renderers.

## Skipped from v1 fork

- Embed color transitions — not supported by Card primitive
- The marker-nonce stdout machinery — v2's two-DB IPC removes the staleness problem

## Future work (not in this implementation)

- Slack progress renderer (Block Kit blocks instead of Discord embeds)
- Telegram progress renderer (edit a normal message with markdown)
- Discord interaction button on the progress embed: "Stop" — pairs with #42 reaction-cancellation
