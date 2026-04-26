/**
 * Discord progress embed renderer. Consumes structured ProgressEvent stream
 * from the agent container and maintains a live "thinking" embed per session.
 *
 * See docs/progress-lane.md for the wire format and design rationale.
 *
 * Uses Discord's REST API directly (not the Chat SDK Card primitive)
 * because the SDK adapter unconditionally renders Card to BOTH the message
 * content AND an embed (`payload.content = cardToFallbackText(card)` in
 * @chat-adapter/discord). Sending content + embed gives a duplicated UI;
 * we want embed-only. As a bonus, raw REST lets us set the embed `color`,
 * which Card doesn't expose.
 *
 * - One embed per session (parent), edited as the agent works
 * - Subagent activity rolled into the same embed (up to MAX_VISIBLE_SUBAGENTS
 *   sections, oldest evicted past that)
 * - Discord API edits rate-limited to PROGRESS_EDIT_GAP_MS per session
 * - JSON-persisted at data/progress-pending.json so a host crash leaves a
 *   sweepable record instead of an orphan blurple embed
 *
 * Status communicated via embed color + title emoji:
 *   blurple "🤔 Thinking…"  → in flight
 *   red     "❌ Failed"     → SDK / network / agent error
 *   gray    "🚫 Cancelled"  → user-cancelled (e.g. ❌ reaction)
 *   (deleted)               → success: clean up so the channel stays uncluttered
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ProgressEvent } from './progress-events.js';

const PROGRESS_EDIT_GAP_MS = 1100;
const TOOL_HISTORY_LIMIT = 5;
const TEXT_PREVIEW_LIMIT = 280;
const MAX_VISIBLE_SUBAGENTS = 9;
const DEFAULT_PERSIST_FILE = path.join(DATA_DIR, 'progress-pending.json');

const COLOR_THINKING = 0x5865f2; // Discord blurple
const COLOR_FAILED = 0xed4245; // Discord red
const COLOR_CANCELLED = 0x99aab5; // Discord light gray

interface SubagentSection {
  description: string;
  toolHistory: string[];
  textPreview: string;
}

type Status = 'thinking' | 'success' | 'failed' | 'cancelled';

interface ProgressState {
  hostSessionId: string;
  sessionId: string;
  platformId: string;
  threadId: string | null;
  /** Discord channel id that the message lives in (the platform-specific
   * channel id parsed out of platformId/threadId). */
  discordChannelId: string;
  /** Discord message id for the embed. */
  messageId: string;
  toolHistory: string[];
  textPreview: string;
  subagents: Map<string, SubagentSection>;
  status: Status;
  pendingEdit?: NodeJS.Timeout;
  inFlightEdit?: Promise<void>;
  startedAt: string;
}

interface PersistedSubagent {
  id: string;
  description: string;
  toolHistory: string[];
  textPreview: string;
}

interface PersistRecord {
  hostSessionId: string | null;
  sessionId: string;
  platformId: string;
  threadId: string | null;
  discordChannelId: string;
  messageId: string;
  startedAt: string;
  /** All fields below were added to support cancel-after-restart and live-state
   * rehydration. Records read from a pre-existing file without them default to
   * the in-flight / empty values at load. */
  status: Status;
  toolHistory: string[];
  textPreview: string;
  /** Serialized in insertion order — the renderer's eviction-on-insert logic
   * relies on iteration order matching insertion order. */
  subagents: PersistedSubagent[];
}

/** Discord REST embed shape — only the fields we use. */
interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
}

export interface DiscordProgressRenderer {
  handle(hostSessionId: string, platformId: string, threadId: string | null, event: ProgressEvent): Promise<void>;
  /**
   * On host startup, walk the persistence file. Any record whose session is
   * gone (host died mid-turn) gets a terminal gray "Interrupted" edit.
   * Pass a predicate that returns true if the NanoClaw host session is still
   * live.
   */
  sweepStale(isLive: (hostSessionId: string) => boolean): Promise<void>;
  /**
   * Look up the NanoClaw host session for a Discord progress embed message.
   * Used by ❌ reaction-cancel.
   */
  findHostSessionIdByMessageId(messageId: string): string | null;
}

export interface DiscordProgressRendererOptions {
  /** Override the default `data/progress-pending.json` path. Tests use this
   * to point persistence at a tmpdir so they don't race the live host. */
  persistFile?: string;
}

/** Create a renderer that uses raw Discord REST. Bot token required. */
export function createDiscordProgressRenderer(
  botToken: string,
  options: DiscordProgressRendererOptions = {},
): DiscordProgressRenderer {
  const states = new Map<string, ProgressState>();
  let persistMutex: Promise<void> = Promise.resolve();
  const persistFile = options.persistFile ?? DEFAULT_PERSIST_FILE;
  const persistDir = path.dirname(persistFile);

  const auth = `Bot ${botToken}`;
  const api = 'https://discord.com/api/v10';

  // ---- Discord REST helpers ----------------------------------------------
  //
  // Discord allows up to 10 embeds per message. We use slot 0 for the parent
  // and slots 1-9 for one card per active subagent — matches the v1 fork's
  // visual where each subagent gets its own side-bar block instead of being
  // a bullet inside the parent's description.

  async function postEmbeds(channelId: string, embeds: DiscordEmbed[]): Promise<string | null> {
    try {
      const res = await fetch(`${api}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds }),
      });
      if (!res.ok) {
        log.warn('Progress embed post failed', { channelId, status: res.status });
        return null;
      }
      const body = (await res.json()) as { id?: string };
      return body.id ?? null;
    } catch (err) {
      log.warn('Progress embed post threw', { channelId, err: String(err) });
      return null;
    }
  }

  async function editEmbeds(channelId: string, messageId: string, embeds: DiscordEmbed[]): Promise<void> {
    try {
      const res = await fetch(`${api}/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds }),
      });
      if (!res.ok) {
        log.debug('Progress embed edit non-2xx', { channelId, messageId, status: res.status });
      }
    } catch (err) {
      log.debug('Progress embed edit threw', { messageId, err: String(err) });
    }
  }

  async function deleteEmbed(channelId: string, messageId: string): Promise<void> {
    try {
      const res = await fetch(`${api}/channels/${channelId}/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        log.debug('Progress embed delete non-2xx', { channelId, messageId, status: res.status });
      }
    } catch (err) {
      log.debug('Progress embed delete threw', { messageId, err: String(err) });
    }
  }

  // ---- Embed rendering ----------------------------------------------------

  /**
   * Extract Discord channel id from v2 platform_id/thread_id encoding.
   *
   *   Guild channel: platform_id = "discord:<guildId>:<channelId>", threadId same
   *   DM:            platform_id = "discord:@me:<channelId>", threadId same
   *
   * The threadId we receive from the bridge is the encoded form; the raw
   * Discord channel id is the last colon-segment.
   */
  function discordChannelIdFrom(platformId: string, threadId: string | null): string {
    const encoded = threadId ?? platformId;
    const idx = encoded.lastIndexOf(':');
    return idx >= 0 ? encoded.slice(idx + 1) : encoded;
  }

  /**
   * Render one Discord embed per active conversation participant: the parent
   * agent at slot 0, then one embed per active subagent (max
   * MAX_VISIBLE_SUBAGENTS more, capped at 10 total to fit Discord's limit).
   *
   * Insertion-time eviction in the `subagent_begin` handler keeps
   * state.subagents bounded, so this just iterates without a hard cap —
   * the cap is also enforced defensively here.
   */
  function buildEmbeds(state: ProgressState): DiscordEmbed[] {
    const titleEmoji =
      state.status === 'thinking'
        ? '🤔'
        : state.status === 'failed'
          ? '❌'
          : state.status === 'cancelled'
            ? '🚫'
            : '✅';
    const titleText =
      state.status === 'thinking'
        ? 'Thinking…'
        : state.status === 'failed'
          ? 'Failed'
          : state.status === 'cancelled'
            ? 'Cancelled'
            : 'Done';
    const parentColor =
      state.status === 'thinking' ? COLOR_THINKING : state.status === 'failed' ? COLOR_FAILED : COLOR_CANCELLED;

    // Parent embed — text preview + parent's own tool history. Subagent
    // sections live in their own embeds below.
    const parentLines: string[] = [];
    if (state.textPreview) parentLines.push(state.textPreview);
    if (state.toolHistory.length > 0) {
      parentLines.push(`**Tools:** ${state.toolHistory.map((t) => `\`${t}\``).join(' → ')}`);
    }
    const parent: DiscordEmbed = {
      title: `${titleEmoji} ${titleText}`,
      description: parentLines.join('\n').slice(0, 4000) || undefined,
      color: parentColor,
    };

    const embeds: DiscordEmbed[] = [parent];
    // Only show subagent cards while the turn is in flight — on a terminal
    // status (cancelled / failed) collapse to just the parent so the channel
    // doesn't keep a wall of mid-stream subagent state forever.
    if (state.status !== 'thinking') return embeds;
    let i = 0;
    for (const [, sub] of state.subagents) {
      if (i >= MAX_VISIBLE_SUBAGENTS) break;
      i++;
      const subLines: string[] = [];
      if (sub.textPreview) subLines.push(sub.textPreview);
      if (sub.toolHistory.length > 0) {
        subLines.push(`**Tools:** ${sub.toolHistory.map((t) => `\`${t}\``).join(' → ')}`);
      }
      embeds.push({
        title: `🤖 ${truncate(sub.description, 240)}`,
        description: subLines.join('\n').slice(0, 4000) || undefined,
        color: COLOR_THINKING,
      });
    }
    return embeds;
  }

  function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  function rangeShift(arr: string[], item: string, limit: number): void {
    arr.push(item);
    while (arr.length > limit) arr.shift();
  }

  function scheduleEdit(state: ProgressState): void {
    if (state.pendingEdit) return; // already queued
    state.pendingEdit = setTimeout(() => {
      state.pendingEdit = undefined;
      void applyEdit(state);
    }, PROGRESS_EDIT_GAP_MS);
  }

  async function applyEdit(state: ProgressState): Promise<void> {
    // Serialize edits per session so we never overlap on the same message.
    const prev = state.inFlightEdit ?? Promise.resolve();
    const next = prev.then(async () => {
      await editEmbeds(state.discordChannelId, state.messageId, buildEmbeds(state));
      // Snapshot after the embed write so the on-disk view matches what's on
      // Discord. Fire-and-forget — chaining through the same persistMutex
      // serializes snapshot writes, but we don't want the next applyEdit's
      // chain to wait on real fs I/O (it makes fake-timer tests deadlock and
      // doesn't change correctness — a host crash before the next edit
      // re-fires loses at most PROGRESS_EDIT_GAP_MS of state).
      void persistSnapshot().catch((err) => log.debug('Persist snapshot threw', { err: String(err) }));
    });
    state.inFlightEdit = next;
    await next;
    if (state.inFlightEdit === next) state.inFlightEdit = undefined;
  }

  // ---- Persistence --------------------------------------------------------
  //
  // Strategy: snapshot the full `states` Map after every meaningful change
  // (begin, end, and each scheduleEdit flush). One file write per ~1.1 s of
  // active streaming is cheap and lets a host restart rehydrate live
  // sessions — both for ❌-cancel lookups and for "still working"
  // sweepStale rendering instead of "Interrupted".

  function snapshotState(state: ProgressState): PersistRecord {
    return {
      hostSessionId: state.hostSessionId,
      sessionId: state.sessionId,
      platformId: state.platformId,
      threadId: state.threadId,
      discordChannelId: state.discordChannelId,
      messageId: state.messageId,
      startedAt: state.startedAt,
      status: state.status,
      toolHistory: [...state.toolHistory],
      textPreview: state.textPreview,
      subagents: Array.from(state.subagents, ([id, sub]) => ({
        id,
        description: sub.description,
        toolHistory: [...sub.toolHistory],
        textPreview: sub.textPreview,
      })),
    };
  }

  async function persistSnapshot(): Promise<void> {
    persistMutex = persistMutex.then(async () => {
      const records = Array.from(states.values(), snapshotState);
      await writePersist(records);
    });
    await persistMutex;
  }

  async function persistRemove(sessionId: string): Promise<void> {
    persistMutex = persistMutex.then(async () => {
      const records = await readPersist();
      const filtered = records.filter((r) => r.sessionId !== sessionId);
      if (filtered.length !== records.length) await writePersist(filtered);
    });
    await persistMutex;
  }

  async function readPersist(): Promise<PersistRecord[]> {
    try {
      const raw = await fs.promises.readFile(persistFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Backfill defaults for the cancel-after-restart fields so a file written
      // by the previous schema still loads cleanly. The first persistSnapshot
      // after this read will rewrite the file in the new schema.
      return (parsed as Partial<PersistRecord>[]).map((r) => ({
        hostSessionId: r.hostSessionId ?? null,
        sessionId: r.sessionId ?? '',
        platformId: r.platformId ?? '',
        threadId: r.threadId ?? null,
        discordChannelId: r.discordChannelId ?? '',
        messageId: r.messageId ?? '',
        startedAt: r.startedAt ?? new Date().toISOString(),
        status: r.status ?? 'thinking',
        toolHistory: r.toolHistory ?? [],
        textPreview: r.textPreview ?? '',
        subagents: r.subagents ?? [],
      }));
    } catch {
      return [];
    }
  }

  async function writePersist(records: PersistRecord[]): Promise<void> {
    if (!fs.existsSync(persistDir)) fs.mkdirSync(persistDir, { recursive: true });
    const tmp = `${persistFile}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(records, null, 2));
    await fs.promises.rename(tmp, persistFile);
  }

  function rehydrateState(record: PersistRecord): ProgressState {
    const subagents = new Map<string, SubagentSection>();
    for (const sub of record.subagents) {
      subagents.set(sub.id, {
        description: sub.description,
        toolHistory: [...sub.toolHistory],
        textPreview: sub.textPreview,
      });
    }
    return {
      hostSessionId: record.hostSessionId ?? '',
      sessionId: record.sessionId,
      platformId: record.platformId,
      threadId: record.threadId,
      discordChannelId: record.discordChannelId,
      messageId: record.messageId,
      toolHistory: [...record.toolHistory],
      textPreview: record.textPreview,
      subagents,
      status: record.status,
      startedAt: record.startedAt,
    };
  }

  // ---- Public API ---------------------------------------------------------

  return {
    async handle(
      hostSessionId: string,
      platformId: string,
      threadId: string | null,
      event: ProgressEvent,
    ): Promise<void> {
      switch (event.type) {
        case 'begin': {
          // If we already have a state for this session, the previous turn
          // didn't end cleanly. Finalize it (gray) and start fresh — avoids
          // leaking the prior messageId.
          const existing = states.get(event.sessionId);
          if (existing) {
            existing.status = 'cancelled';
            await editEmbeds(existing.discordChannelId, existing.messageId, buildEmbeds(existing));
            states.delete(event.sessionId);
            await persistRemove(event.sessionId);
          }
          const channelId = discordChannelIdFrom(platformId, threadId);
          const messageId = await postEmbeds(channelId, [
            {
              title: '🤔 Thinking…',
              description: 'Working on it.',
              color: COLOR_THINKING,
            },
          ]);
          if (!messageId) {
            log.warn('Progress begin: failed to post embed', { sessionId: event.sessionId, channelId });
            return;
          }
          const state: ProgressState = {
            hostSessionId,
            sessionId: event.sessionId,
            platformId,
            threadId,
            discordChannelId: channelId,
            messageId,
            toolHistory: [],
            textPreview: '',
            subagents: new Map(),
            status: 'thinking',
            startedAt: new Date().toISOString(),
          };
          states.set(event.sessionId, state);
          await persistSnapshot();
          return;
        }

        case 'tool_use': {
          // tool_use / text_delta / subagent_* events don't carry sessionId.
          // Look up the active progress state for this host delivery route.
          const state = findStateByRoute(states, platformId, threadId);
          if (!state) return;
          if (event.subagentId) {
            const sub = state.subagents.get(event.subagentId);
            if (sub) rangeShift(sub.toolHistory, event.toolName, TOOL_HISTORY_LIMIT);
          } else {
            rangeShift(state.toolHistory, event.toolName, TOOL_HISTORY_LIMIT);
          }
          scheduleEdit(state);
          return;
        }

        case 'text_delta': {
          const state = findStateByRoute(states, platformId, threadId);
          if (!state) return;
          const preview = event.preview.slice(-TEXT_PREVIEW_LIMIT);
          if (event.subagentId) {
            const sub = state.subagents.get(event.subagentId);
            if (sub) sub.textPreview = preview;
          } else {
            state.textPreview = preview;
          }
          scheduleEdit(state);
          return;
        }

        case 'subagent_begin': {
          const state = findStateByRoute(states, platformId, threadId);
          if (!state) return;
          // Evict oldest at insertion time (matches v1 fork behavior). Keeps
          // the Map bounded and lets the array-of-embeds renderer iterate
          // without a hard cap.
          while (state.subagents.size >= MAX_VISIBLE_SUBAGENTS) {
            const oldestKey = state.subagents.keys().next().value;
            if (oldestKey === undefined) break;
            state.subagents.delete(oldestKey);
          }
          state.subagents.set(event.subagentId, {
            description: event.description,
            toolHistory: [],
            textPreview: '',
          });
          scheduleEdit(state);
          return;
        }

        case 'subagent_end': {
          const state = findStateByRoute(states, platformId, threadId);
          if (!state) return;
          state.subagents.delete(event.subagentId);
          scheduleEdit(state);
          return;
        }

        case 'end': {
          const state = findStateByRoute(states, platformId, threadId);
          if (!state) return;
          // Cancel any pending edit and wait for in-flight to finish so we
          // don't fight ourselves on the terminal action.
          if (state.pendingEdit) {
            clearTimeout(state.pendingEdit);
            state.pendingEdit = undefined;
          }
          if (state.inFlightEdit) {
            try {
              await state.inFlightEdit;
            } catch {
              /* swallow */
            }
          }
          state.status = event.success ? 'success' : event.reason === 'cancelled' ? 'cancelled' : 'failed';
          if (state.status === 'success') {
            // Clean up — don't leave a "Done" embed cluttering the channel.
            await deleteEmbed(state.discordChannelId, state.messageId);
          } else {
            await editEmbeds(state.discordChannelId, state.messageId, buildEmbeds(state));
          }
          states.delete(state.sessionId);
          await persistRemove(state.sessionId);
          return;
        }
      }
    },

    findHostSessionIdByMessageId(messageId: string): string | null {
      for (const state of states.values()) {
        if (state.messageId === messageId) {
          return state.hostSessionId || null;
        }
      }
      return null;
    },

    async sweepStale(isLive: (hostSessionId: string) => boolean): Promise<void> {
      const records = await readPersist();
      const survivors: PersistRecord[] = [];
      for (const r of records) {
        if (r.hostSessionId && isLive(r.hostSessionId)) {
          // Container is still running — rehydrate the in-memory state so
          // ❌-cancel reactions on this embed can resolve the session, and so
          // subsequent progress events update the embed correctly instead of
          // creating a fresh duplicate.
          if (!states.has(r.sessionId)) {
            states.set(r.sessionId, rehydrateState(r));
          }
          survivors.push(r);
          continue;
        }
        await editEmbeds(r.discordChannelId, r.messageId, [
          {
            title: '🚫 Interrupted',
            description: 'Host restarted before the agent finished this turn.',
            color: COLOR_CANCELLED,
          },
        ]);
      }
      if (survivors.length !== records.length) await writePersist(survivors);
    },
  };
}

/**
 * For events that arrive without a sessionId (tool_use, text_delta,
 * subagent_*, end), find the active state by host delivery route.
 *
 * Single-session-per-thread is the common case — Chesterbot uses
 * session_mode='shared' or 'per-thread' which both produce at most one
 * active session per (platformId, threadId). Multi-session-per-thread
 * (rare config) breaks this lookup; revisit if needed.
 */
function findStateByRoute(
  states: Map<string, ProgressState>,
  platformId: string,
  threadId: string | null,
): ProgressState | undefined {
  for (const state of states.values()) {
    if (state.platformId === platformId && state.threadId === threadId) {
      return state;
    }
  }
  return undefined;
}
