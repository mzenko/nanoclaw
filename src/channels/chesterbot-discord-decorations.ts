/**
 * Chesterbot-specific Discord decorations: progress embed renderer + ❌
 * reaction-cancel.
 *
 * These live in their own module so `src/channels/discord.ts` stays small
 * enough to re-fetch from upstream's channels branch (when one ships) without
 * a merge headache. The pattern:
 *
 *   const deco = chesterbotDiscordDecorations(botToken);
 *   const bridge = createChatSdkBridge({ ..., onReaction: deco.onReaction });
 *   deco.attach(bridge);
 *
 * The `onReaction` field has to ride in the bridge config (the chat-sdk
 * registers reaction handlers at setup time). Everything else (`progress`,
 * `setup` sweep) is patched onto the constructed bridge.
 */
import { isContainerRunning } from '../container-runner.js';
import { log } from '../log.js';
import { cancelSession } from '../session-manager.js';
import type { ChannelAdapter } from './adapter.js';
import type { ReactionHandler } from './chat-sdk-bridge.js';
import { createDiscordProgressRenderer } from './discord-progress.js';

const CANCEL_EMOJI = '❌';

export interface ChesterbotDiscordDecoration {
  /** Pass this to ChatSdkBridgeConfig.onReaction at bridge construction. */
  onReaction: ReactionHandler;
  /** Patch progress + setup-sweep onto the constructed bridge. Call once. */
  attach(bridge: ChannelAdapter): void;
}

export function chesterbotDiscordDecorations(botToken: string): ChesterbotDiscordDecoration {
  const renderer = createDiscordProgressRenderer(botToken);

  return {
    onReaction: (event) => {
      if (event.added !== true) return;
      if (event.rawEmoji !== CANCEL_EMOJI) return;
      const sessionId = renderer.findHostSessionIdByMessageId(event.messageId);
      if (!sessionId) return;
      log.info('Cancel reaction received', {
        messageId: event.messageId,
        sessionId,
        userId: event.userId,
      });
      cancelSession(sessionId, `discord:${event.userId}`);
    },

    attach(bridge: ChannelAdapter): void {
      bridge.progress = (hostSessionId, platformId, threadId, event) =>
        renderer.handle(hostSessionId, platformId, threadId, event);
      // Sweep orphan embeds left over from a previous host crash. Live-session
      // predicate checks this process' active containers; DB container_status
      // can be stale immediately after a crash/restart.
      const originalSetup = bridge.setup.bind(bridge);
      bridge.setup = async (config) => {
        await originalSetup(config);
        await renderer.sweepStale(isContainerRunning);
      };
    },
  };
}
