/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Chesterbot-specific bits (progress embeds, ❌-cancel) live in
 * `chesterbot-discord-decorations.ts` so this file stays close to what an
 * upstream channels-branch discord.ts would look like — the only downstream
 * differences here are the two `deco` lines.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { chesterbotDiscordDecorations } from './chesterbot-discord-decorations.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    const deco = chesterbotDiscordDecorations(env.DISCORD_BOT_TOKEN);
    const bridge = createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      // Discord caps text messages at 2000 chars and rejects (vs silently
      // truncating) longer payloads. Without this, long agent replies disappear.
      maxTextLength: 2000,
      // Discord's free-tier file limit is 10 MiB. Boosted servers go up to
      // 25/50/100 MiB but the floor protects everyone — the bridge skips
      // oversized files with a per-file note instead of failing the whole turn.
      maxFileSize: 10 * 1024 * 1024,
      onReaction: deco.onReaction,
    });
    deco.attach(bridge);
    return bridge;
  },
});
