import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createDiscordProgressRenderer } from './discord-progress.js';

// ---- fake fetch -------------------------------------------------------------
//
// The renderer talks to Discord REST. We stub global.fetch and record every
// call: method, URL, JSON body. Channel/message ids are extracted from the
// URL so tests stay readable.

interface FetchCall {
  method: string;
  url: string;
  body?: unknown;
}

function installFakeFetch(seedMsgId = 'msg-fake-1') {
  const calls: FetchCall[] = [];
  let counter = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    if (method === 'POST') {
      counter++;
      const id = counter === 1 ? seedMsgId : `${seedMsgId}-${counter}`;
      return new Response(JSON.stringify({ id }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 204 });
  };
  return calls;
}

function discordPosts(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.method === 'POST');
}
function discordEdits(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.method === 'PATCH');
}
function discordDeletes(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.method === 'DELETE');
}

function embedTitle(call: FetchCall | undefined): string {
  return ((call?.body as { embeds?: Array<{ title?: string }> })?.embeds?.[0]?.title ?? '') as string;
}
function embedDescription(call: FetchCall | undefined): string {
  return ((call?.body as { embeds?: Array<{ description?: string }> })?.embeds?.[0]?.description ?? '') as string;
}
function embedColor(call: FetchCall | undefined): number {
  return ((call?.body as { embeds?: Array<{ color?: number }> })?.embeds?.[0]?.color ?? 0) as number;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
});

describe('Discord progress renderer', () => {
  it('begin posts an embed-only message (no `content`)', async () => {
    const calls = installFakeFetch();
    const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer.handle('host-1', 'discord:guild:chan-A', null, { type: 'begin', sessionId: 'sess-1' });

    const posts = discordPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain('/channels/chan-A/messages');
    // Body has embeds but NOT content — that was the v1 Card duplication bug.
    expect(posts[0].body).toHaveProperty('embeds');
    expect(posts[0].body).not.toHaveProperty('content');
    expect(embedTitle(posts[0])).toContain('Thinking');
  });

  it('coalesces tool_use into a single rate-limited PATCH', async () => {
    vi.useFakeTimers();
    try {
      const calls = installFakeFetch();
      const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
      await renderer.handle('host-2', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-2' });
      for (const t of ['Read', 'Bash', 'Edit', 'Glob', 'Grep']) {
        await renderer.handle('host-2', 'discord:g:c', null, { type: 'tool_use', toolName: t });
      }

      // Before timer fires: only the begin POST has run, no PATCH yet.
      expect(discordEdits(calls)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1100);
      // Drain microtasks so the timer's awaited fetch resolves before assert.
      await Promise.resolve();
      await Promise.resolve();

      const edits = discordEdits(calls);
      expect(edits.length).toBeGreaterThanOrEqual(1);
      expect(embedTitle(edits[edits.length - 1])).toContain('Thinking');
    } finally {
      vi.useRealTimers();
    }
  });

  it('end success deletes the message', async () => {
    const calls = installFakeFetch();
    const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer.handle('host-3', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-3' });
    await renderer.handle('host-3', 'discord:g:c', null, { type: 'end', success: true });

    expect(discordDeletes(calls)).toHaveLength(1);
  });

  it('end failed leaves a red terminal embed', async () => {
    const calls = installFakeFetch();
    const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer.handle('host-4', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-4' });
    await renderer.handle('host-4', 'discord:g:c', null, { type: 'end', success: false, reason: 'failed' });

    const edits = discordEdits(calls);
    expect(edits).toHaveLength(1);
    expect(embedTitle(edits[0])).toContain('Failed');
    expect(embedColor(edits[0])).toBe(0xed4245);
    expect(discordDeletes(calls)).toHaveLength(0);
  });

  it('end cancelled uses the cancelled emoji + gray color', async () => {
    const calls = installFakeFetch();
    const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer.handle('host-5', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-5' });
    await renderer.handle('host-5', 'discord:g:c', null, { type: 'end', success: false, reason: 'cancelled' });

    const edits = discordEdits(calls);
    expect(embedTitle(edits[0])).toContain('Cancelled');
    expect(embedColor(edits[0])).toBe(0x99aab5);
  });

  it('sweepStale edits orphans whose sessions are gone', async () => {
    const calls1 = installFakeFetch();
    const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer.handle('host-6', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-6' });
    // Don't fire 'end' — simulate a host crash. The state is in the persistence file.
    // Drop the in-memory state by creating a fresh renderer that reads from disk.
    const calls2 = installFakeFetch();
    const renderer2 = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer2.sweepStale(() => false);

    const sweepEdits = discordEdits(calls2);
    expect(sweepEdits.length).toBeGreaterThanOrEqual(1);
    expect(embedTitle(sweepEdits[0])).toContain('Interrupted');
    expect(discordDeletes(calls1)).toHaveLength(0);
  });

  it('sweepStale rehydrates records whose host session is still live', async () => {
    installFakeFetch('msg-live-1');
    const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer.handle('host-live', 'discord:g:c', null, { type: 'begin', sessionId: 'claude-sdk-session' });

    const calls2 = installFakeFetch();
    const renderer2 = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer2.sweepStale((sessionId) => sessionId === 'host-live');

    expect(discordEdits(calls2)).toHaveLength(0);
    expect(renderer2.findHostSessionIdByMessageId('msg-live-1')).toBe('host-live');
  });

  it('subagent_begin spawns a separate embed with the 🤖 prefix', async () => {
    vi.useFakeTimers();
    try {
      const calls = installFakeFetch();
      const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
      await renderer.handle('host-7', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-7' });
      await renderer.handle('host-7', 'discord:g:c', null, {
        type: 'subagent_begin',
        subagentId: 'tu-1',
        description: 'Researcher',
      });
      await vi.advanceTimersByTimeAsync(1100);
      await Promise.resolve();
      await Promise.resolve();

      const lastEdit = discordEdits(calls).at(-1);
      // Expect TWO embeds in the message: parent + 1 subagent.
      const embeds = (lastEdit?.body as { embeds?: Array<{ title?: string }> })?.embeds ?? [];
      expect(embeds).toHaveLength(2);
      expect(embeds[0].title).toContain('Thinking');
      expect(embeds[1].title).toContain('🤖');
      expect(embeds[1].title).toContain('Researcher');

      await renderer.handle('host-7', 'discord:g:c', null, { type: 'subagent_end', subagentId: 'tu-1' });
      await vi.advanceTimersByTimeAsync(1100);
      await Promise.resolve();
      await Promise.resolve();

      const lastEditAfter = discordEdits(calls).at(-1);
      const embedsAfter = (lastEditAfter?.body as { embeds?: Array<{ title?: string }> })?.embeds ?? [];
      // Only the parent remains.
      expect(embedsAfter).toHaveLength(1);
      expect(embedsAfter[0].title).toContain('Thinking');
    } finally {
      vi.useRealTimers();
    }
  });

  it('eviction at insertion: more than 9 subagents drops oldest', async () => {
    vi.useFakeTimers();
    try {
      const calls = installFakeFetch();
      const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
      await renderer.handle('host-9', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-9' });
      // Spawn 11 subagents — first 2 should evict.
      for (let i = 0; i < 11; i++) {
        await renderer.handle('host-9', 'discord:g:c', null, {
          type: 'subagent_begin',
          subagentId: `tu-${i}`,
          description: `Sub ${i}`,
        });
      }
      // Flush the rate-limited edit while the turn is still in flight —
      // terminal statuses (cancelled / failed) collapse subagents away, so
      // we have to assert mid-stream to see them rendered.
      await vi.advanceTimersByTimeAsync(1100);
      await Promise.resolve();
      await Promise.resolve();
      const finalEdit = discordEdits(calls).at(-1);
      const embeds = (finalEdit?.body as { embeds?: Array<{ title?: string }> })?.embeds ?? [];
      // Parent + 9 subagents = 10 embeds (Discord per-message cap).
      expect(embeds).toHaveLength(10);
      // Subagent embeds 0 and 1 should have been evicted; surviving descriptions
      // should include "Sub 2" through "Sub 10" (9 of them).
      const titles = embeds.slice(1).map((e) => e.title ?? '');
      expect(titles.some((t) => t.includes('Sub 2'))).toBe(true);
      expect(titles.some((t) => t.includes('Sub 10'))).toBe(true);
      // Use word-boundary regex; literal "Sub 1" matches "Sub 10" too.
      expect(titles.some((t) => /\bSub 0\b/.test(t))).toBe(false);
      expect(titles.some((t) => /\bSub 1\b/.test(t))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('begin twice on same session: prior turn finalized as cancelled', async () => {
    const calls = installFakeFetch();
    const renderer = createDiscordProgressRenderer('bot-token', { persistFile: path.join(tmpDir, 'progress.json') });
    await renderer.handle('host-8', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-8' });
    await renderer.handle('host-8', 'discord:g:c', null, { type: 'begin', sessionId: 'sess-8' });

    // First POST = first begin. Then a PATCH (finalize prior to gray cancelled).
    // Then a second POST = second begin's fresh embed.
    expect(discordPosts(calls)).toHaveLength(2);
    const finalizePatch = discordEdits(calls).at(0);
    expect(embedTitle(finalizePatch)).toContain('Cancelled');
  });
});
