import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

import {
  Attachment,
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Message,
  MessageReaction,
  Partials,
  PartialMessageReaction,
  PartialUser,
  TextChannel,
  User,
} from 'discord.js';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  ProgressEvent,
  ProgressHandle,
  RegisteredGroup,
} from '../types.js';

// Discord rate limit: ~5 edits / 5s per message → 1.1s gap stays safely under.
const PROGRESS_EDIT_GAP_MS = 1100;
const PROGRESS_TOOL_HISTORY = 5;
const PROGRESS_PREVIEW_CHARS = 280;
// Discord caps a single message at 10 embeds. Slot 0 is the parent embed, so
// the subagent map can only display this many entries — extras evict the
// oldest (longest-running) subagent's section.
const MAX_VISIBLE_SUBAGENTS = 9;
const COLOR_PENDING = 0x5865f2; // Discord blurple
const COLOR_DONE = 0x57f287; // green
const COLOR_FAILED = 0xed4245; // red
const COLOR_INTERRUPTED = 0x95a5a6; // grey

interface DiscordProgressData {
  channelId: string;
  messageId: string;
}

interface PendingProgressRecord {
  channelId: string;
  messageId: string;
  jid: string;
  startedAt: number;
}

interface ToolCall {
  name: string;
  summary?: string;
}

interface SubagentSection {
  id: string;
  name: string;
  toolCalls: ToolCall[]; // ring-buffered, length ≤ PROGRESS_TOOL_HISTORY
}

interface ProgressState {
  channelId: string;
  messageId: string;
  jid: string;
  startedAt: number;
  preview: string;
  toolCalls: ToolCall[]; // parent agent's calls, ring-buffered
  subagents: Map<string, SubagentSection>; // open subagents, in insertion order
  status: string;
  lastEditAt: number;
  pendingTimer: NodeJS.Timeout | null;
  // Promise for any in-flight applyProgressEdit. endProgress awaits this so a
  // mid-flight edit can't land after the terminal delete/red-fail edit and
  // overwrite it with stale "Thinking…" state.
  inFlightEdit: Promise<void> | null;
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onStopRequest?: (chatJid: string) => void;
}

// Reacting with this emoji on a bot message asks the orchestrator to stop the
// current turn (gracefully — current SDK message finishes, then the stream
// ends).
const STOP_REACTION = '❌';

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  // Keyed by Discord message ID — the placeholder embed's own ID.
  private progressStates = new Map<string, ProgressState>();
  private pendingProgressFile = path.join(
    DATA_DIR,
    'discord-progress-pending.json',
  );
  // Serializes all reads + writes to pendingProgressFile so concurrent turns
  // don't lose records via interleaved read-modify-write.
  private pendingMutex: Promise<void> = Promise.resolve();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      // Discord doesn't push reactions on messages cached before this process
      // started unless we accept partials. Partials.Channel is also required
      // to receive DMs — DM channels aren't pre-cached at startup like guild
      // channels are, so without it MessageCreate never fires for DMs.
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
        Partials.User,
      ],
    });

    this.client.on(
      Events.MessageReactionAdd,
      (
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
      ) => this.handleReaction(reaction, user),
    );

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — download into the group folder and surface the
      // in-container path so the agent can Read the file directly.
      if (message.attachments.size > 0) {
        const group = this.opts.registeredGroups()[chatJid];
        const descriptions = await Promise.all(
          [...message.attachments.values()].map((att) =>
            this.downloadAttachment(att, msgId, group?.folder),
          ),
        );
        const joined = descriptions.join('\n');
        content = content ? `${content}\n${joined}` : joined;
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        await this.warmChannelCache();
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  // Discord's MESSAGE_CREATE packet for DMs has no `type` or `recipients`
  // fields, so discord.js' createChannel() can't construct a DMChannel from
  // the packet alone and silently drops the messageCreate emit. Once a DM
  // channel is in the client cache (via explicit fetch), subsequent
  // MESSAGE_CREATE packets hit ChannelManager._add's existing-channel fast
  // path and emit normally. Pre-fetching is needed both at boot (for already-
  // registered channels) and when a new dc: channel is registered at runtime.
  async warmChannel(jid: string): Promise<void> {
    if (!this.client) return;
    if (!jid.startsWith('dc:')) return;
    const channelId = jid.replace(/^dc:/, '');
    try {
      await this.client.channels.fetch(channelId);
    } catch (err) {
      logger.warn(
        { jid, err },
        'Discord: failed to warm channel cache (bot may lack access)',
      );
    }
  }

  private async warmChannelCache(): Promise<void> {
    const jids = Object.keys(this.opts.registeredGroups()).filter((j) =>
      j.startsWith('dc:'),
    );
    for (const jid of jids) {
      await this.warmChannel(jid);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async sendAttachment(
    jid: string,
    text: string,
    files: Array<{ hostPath: string; name: string }>,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }
      const textChannel = channel as TextChannel;

      // Discord's default per-message upload cap is 10 MiB for non-Nitro /
      // non-boosted servers (raised from 8 MiB in April 2024). Boost-tier-2
      // gives 25 MiB, Nitro 50 MiB. We use the safe lower bound; per-guild
      // detection would require querying Guild.premiumTier. Drop oversize
      // files individually so the agent's text still goes through.
      const MAX_FILE_BYTES = 10 * 1024 * 1024;
      const builders: AttachmentBuilder[] = [];
      for (const f of files) {
        try {
          const stat = fs.statSync(f.hostPath);
          if (stat.size > MAX_FILE_BYTES) {
            logger.warn(
              { jid, file: f.name, size: stat.size },
              'Discord attachment exceeds 10 MiB, dropping',
            );
            continue;
          }
          builders.push(new AttachmentBuilder(f.hostPath, { name: f.name }));
        } catch (err) {
          logger.warn(
            { jid, file: f.name, err },
            'Discord attachment unreadable, dropping',
          );
        }
      }

      // Discord's 2000-char text limit still applies. If text overflows,
      // attach files to the FIRST chunk (where the agent's message lands)
      // so they're visually grouped with the relevant content.
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send({ content: text || undefined, files: builders });
      } else {
        const first = text.slice(0, MAX_LENGTH);
        await textChannel.send({ content: first, files: builders });
        for (let i = MAX_LENGTH; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info(
        { jid, length: text.length, attachments: builders.length },
        'Discord attachment message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord attachment');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  private kindLabel(contentType: string): string {
    if (contentType.startsWith('image/')) return 'Image';
    if (contentType.startsWith('video/')) return 'Video';
    if (contentType.startsWith('audio/')) return 'Audio';
    return 'File';
  }

  private async downloadAttachment(
    att: Attachment,
    msgId: string,
    folder: string | undefined,
  ): Promise<string> {
    const kind = this.kindLabel(att.contentType || '');
    const safeName = (att.name || `${kind.toLowerCase()}.bin`).replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    );

    // Unregistered chats: still surface that something arrived, but don't write to disk.
    if (!folder) return `[${kind}: ${safeName} (chat not registered)]`;

    try {
      const dir = path.join(resolveGroupFolderPath(folder), 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      const hostPath = path.join(dir, `${msgId}-${safeName}`);
      const containerPath = `/workspace/group/attachments/${msgId}-${safeName}`;

      const res = await fetch(att.url);
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      await pipeline(
        res.body as unknown as NodeJS.ReadableStream,
        fs.createWriteStream(hostPath),
      );

      return `[${kind}: ${safeName} — read from ${containerPath}]`;
    } catch (err) {
      logger.warn(
        { err, attachment: safeName },
        'Discord attachment download failed',
      );
      return `[${kind}: ${safeName} (download failed)]`;
    }
  }

  // --- Stop reaction -----------------------------------------------------

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot) return;
    if (reaction.emoji.name !== STOP_REACTION) return;
    try {
      // Hydrate partials so we can read message.author.
      const full = reaction.partial ? await reaction.fetch() : reaction;
      const msg = full.message.partial
        ? await full.message.fetch()
        : full.message;
      // Only honor reactions on our own messages — random ❌ reactions on user
      // messages aren't a stop signal.
      if (!this.client?.user || msg.author?.id !== this.client.user.id) return;

      const chatJid = `dc:${msg.channelId}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      logger.info({ chatJid, by: user.id }, 'Discord stop reaction received');
      this.opts.onStopRequest?.(chatJid);
    } catch (err) {
      logger.debug({ err }, 'Failed to handle Discord reaction');
    }
  }

  // --- Progress (edited-embed) UI ----------------------------------------

  async beginProgress(jid: string): Promise<ProgressHandle | null> {
    if (!this.client) return null;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return null;

      const placeholder = new EmbedBuilder()
        .setColor(COLOR_PENDING)
        .setTitle('Thinking…')
        .setDescription('_Working on your request._');
      const sent = await (channel as TextChannel).send({
        embeds: [placeholder],
      });

      const state: ProgressState = {
        channelId,
        messageId: sent.id,
        jid,
        startedAt: Date.now(),
        preview: '',
        toolCalls: [],
        subagents: new Map(),
        status: '',
        // Init to 0 so the first updateProgress fires its edit immediately —
        // otherwise the user stares at "Working on your request." for the
        // full PROGRESS_EDIT_GAP_MS window before any activity renders.
        lastEditAt: 0,
        pendingTimer: null,
        inFlightEdit: null,
      };
      this.progressStates.set(sent.id, state);
      await this.persistPending(state);

      return { channel: 'discord', data: { channelId, messageId: sent.id } };
    } catch (err) {
      logger.warn({ jid, err }, 'Discord beginProgress failed');
      return null;
    }
  }

  async updateProgress(
    handle: ProgressHandle,
    event: ProgressEvent,
  ): Promise<void> {
    if (handle.channel !== 'discord') return;
    const data = handle.data as DiscordProgressData;
    const state = this.progressStates.get(data.messageId);
    if (!state) return; // handle was reaped (deleted, error, etc.)

    switch (event.kind) {
      case 'tool_use': {
        const call: ToolCall = { name: event.name, summary: event.summary };
        const target = event.subagentId
          ? state.subagents.get(event.subagentId)?.toolCalls
          : state.toolCalls;
        // If the event references an unknown subagent (out-of-order delivery),
        // fall back to the parent list so nothing is silently dropped.
        const list = target ?? state.toolCalls;
        list.push(call);
        if (list.length > PROGRESS_TOOL_HISTORY) list.shift();
        break;
      }
      case 'subagent_begin':
        // If a parent aborts mid-subagent, the matching tool_result never
        // returns, so subagent_end never fires and the slot lingers. Without
        // eviction, a long turn that spawns more than MAX_VISIBLE_SUBAGENTS
        // would silently drop later subagents from the UI. Evict oldest by
        // insertion order — Map preserves it.
        // Guarded against MAX_VISIBLE_SUBAGENTS=0 (would loop forever since
        // size >= 0 is always true and the inner break would never fire).
        while (
          state.subagents.size > 0 &&
          state.subagents.size >= MAX_VISIBLE_SUBAGENTS
        ) {
          const oldest = state.subagents.keys().next().value;
          if (oldest === undefined) break;
          state.subagents.delete(oldest);
        }
        state.subagents.set(event.subagentId, {
          id: event.subagentId,
          name: event.name,
          toolCalls: [],
        });
        break;
      case 'subagent_end':
        state.subagents.delete(event.subagentId);
        break;
      case 'text_chunk':
        state.preview = event.text.slice(0, PROGRESS_PREVIEW_CHARS);
        break;
      case 'status':
        state.status = event.label;
        break;
      // begin/end carried by host explicitly via beginProgress/endProgress.
      default:
        return;
    }
    this.scheduleProgressEdit(state);
  }

  async endProgress(
    handle: ProgressHandle,
    success: boolean,
    reason?: 'cancelled',
  ): Promise<void> {
    if (handle.channel !== 'discord') return;
    const data = handle.data as DiscordProgressData;
    const state = this.progressStates.get(data.messageId);
    if (!state) return;
    // Remove from progressStates BEFORE draining/terminal edit. Otherwise an
    // updateProgress arriving during the await passes its !state guard, calls
    // scheduleProgressEdit, and may kick a fresh applyProgressEdit that lands
    // *after* the terminal edit/delete and resurrects "Thinking…" or hits
    // 10008 on the deleted message.
    this.progressStates.delete(data.messageId);
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    // Drain any edit that scheduleProgressEdit kicked off but hasn't finished
    // yet — otherwise it can land *after* the terminal delete/red-fail edit
    // below and resurrect a stale "Thinking…" embed.
    if (state.inFlightEdit) {
      try {
        await state.inFlightEdit;
      } catch {
        /* applyProgressEdit logs its own errors */
      }
    }

    if (success) {
      // Successful turn: the actual reply went out via sendMessage; the embed
      // is just stale UI. Delete it so the chat stays clean.
      try {
        const channel = await this.client?.channels.fetch(state.channelId);
        if (channel && 'messages' in channel) {
          const msg = await (channel as TextChannel).messages.fetch(
            state.messageId,
          );
          await msg.delete();
        }
      } catch (err: unknown) {
        // 10008 = Unknown Message (already deleted) — fine.
        const code = (err as { code?: number })?.code;
        if (code !== 10008) {
          logger.debug(
            { err, messageId: state.messageId },
            'Embed delete failed',
          );
        }
      }
    } else {
      // Failure / cancelled: keep the embed as a breadcrumb but drop the live
      // tool-call fields so it's a status placeholder, not a wall of stale
      // activity. Cancellation gets a neutral grey ❌ to distinguish it from
      // a real crash — a user-pressed stop isn't an error.
      state.toolCalls = [];
      state.subagents.clear();
      const elapsedSec = Math.round((Date.now() - state.startedAt) / 1000);
      const isCancelled = reason === 'cancelled';
      await this.applyProgressEdit(state, {
        color: isCancelled ? COLOR_INTERRUPTED : COLOR_FAILED,
        title: isCancelled ? 'Cancelled' : 'Failed',
        footer: `${elapsedSec}s`,
      });
    }

    await this.removePending(data.messageId);
  }

  async sweepStaleProgress(): Promise<void> {
    if (!this.client) return;
    const records = this.readPending();
    if (records.length === 0) return;
    logger.info(
      { count: records.length },
      'Sweeping orphaned Discord progress embeds from prior run',
    );
    for (const rec of records) {
      try {
        const channel = await this.client.channels.fetch(rec.channelId);
        if (!channel || !('messages' in channel)) continue;
        const msg = await (channel as TextChannel).messages.fetch(
          rec.messageId,
        );
        const elapsedSec = Math.round((Date.now() - rec.startedAt) / 1000);
        const embed = new EmbedBuilder()
          .setColor(COLOR_INTERRUPTED)
          .setTitle('Interrupted')
          .setDescription(
            '_Restart interrupted this turn — no reply was sent._',
          )
          .setFooter({ text: `${elapsedSec}s elapsed before interrupt` });
        await msg.edit({ embeds: [embed] });
      } catch (err) {
        logger.debug({ rec, err }, 'Could not edit orphaned embed');
      }
    }
    await this.clearAllPending();
  }

  // --- Progress helpers --------------------------------------------------

  private scheduleProgressEdit(state: ProgressState): void {
    const elapsed = Date.now() - state.lastEditAt;
    if (elapsed >= PROGRESS_EDIT_GAP_MS) {
      this.kickEdit(state);
      return;
    }
    if (state.pendingTimer) return; // already scheduled
    const wait = PROGRESS_EDIT_GAP_MS - elapsed;
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      this.kickEdit(state);
    }, wait);
  }

  // Fire applyProgressEdit and stash the promise on state.inFlightEdit so
  // endProgress can await it before applying terminal state.
  private kickEdit(state: ProgressState): void {
    const p = this.applyProgressEdit(state).finally(() => {
      // Only clear if no newer edit has overwritten it.
      if (state.inFlightEdit === p) state.inFlightEdit = null;
    });
    state.inFlightEdit = p;
  }

  private async applyProgressEdit(
    state: ProgressState,
    overrides?: { color?: number; title?: string; footer?: string },
  ): Promise<void> {
    if (!this.client) return;
    state.lastEditAt = Date.now();

    const renderToolCalls = (calls: ToolCall[]): string =>
      calls
        .map((tc) => {
          const head = `🔧 \`${tc.name}\``;
          if (!tc.summary) return head;
          // Inline-code-wrap so Discord renders raw text without parsing
          // markdown / pinging users / honoring spoiler tags.
          const safe = tc.summary.replace(/`/g, "'");
          return `${head} \`${safe}\``;
        })
        .join('\n');

    // Parent embed: description + parent's own tool calls.
    const parent = new EmbedBuilder()
      .setColor(overrides?.color ?? COLOR_PENDING)
      .setTitle(overrides?.title ?? (state.status || 'Thinking…'))
      .setDescription(state.preview || '_Working on your request._');
    if (state.toolCalls.length > 0) {
      parent.addFields({
        name: 'Activity',
        value: renderToolCalls(state.toolCalls),
      });
    }
    if (overrides?.footer) parent.setFooter({ text: overrides.footer });

    // One embed per active subagent. Eviction in subagent_begin keeps the map
    // ≤ MAX_VISIBLE_SUBAGENTS so this is just defense in depth.
    const embeds = [parent];
    for (const sa of state.subagents.values()) {
      if (embeds.length >= 1 + MAX_VISIBLE_SUBAGENTS) break;
      const safeName = sa.name.replace(/`/g, "'").slice(0, 240);
      embeds.push(
        new EmbedBuilder()
          .setColor(COLOR_PENDING)
          .setTitle(`🤖 ${safeName}`)
          .setDescription(
            sa.toolCalls.length > 0
              ? renderToolCalls(sa.toolCalls)
              : '_starting…_',
          ),
      );
    }

    try {
      const channel = await this.client.channels.fetch(state.channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(
        state.messageId,
      );
      await msg.edit({ embeds });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code === 10008) {
        // Unknown Message — user deleted the embed; stop trying.
        this.progressStates.delete(state.messageId);
        void this.removePending(state.messageId);
        logger.debug({ messageId: state.messageId }, 'Progress embed deleted');
      } else {
        logger.debug(
          { err, messageId: state.messageId },
          'Progress edit failed',
        );
      }
    }
  }

  private readPending(): PendingProgressRecord[] {
    try {
      const text = fs.readFileSync(this.pendingProgressFile, 'utf-8');
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Atomic write: stage to a sibling .tmp then rename. Rename is atomic on
  // POSIX, so a crash mid-write leaves the previous file intact rather than
  // a truncated JSON that readPending would silently swallow as `[]`.
  private writePendingAtomic(records: PendingProgressRecord[]): void {
    try {
      fs.mkdirSync(path.dirname(this.pendingProgressFile), { recursive: true });
      const tmp = `${this.pendingProgressFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
      fs.renameSync(tmp, this.pendingProgressFile);
    } catch (err) {
      logger.warn({ err }, 'Failed to write Discord progress pending file');
    }
  }

  // All pending-file mutations route through pendingMutex so concurrent
  // begins/ends in different channels can't race on read-modify-write.
  private withPendingLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.pendingMutex.then(fn);
    // Swallow the result so the chain itself stays Promise<void>; errors are
    // already surfaced to the caller via `next`.
    this.pendingMutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private persistPending(state: ProgressState): Promise<void> {
    return this.withPendingLock(() => {
      const records = this.readPending();
      records.push({
        channelId: state.channelId,
        messageId: state.messageId,
        jid: state.jid,
        startedAt: state.startedAt,
      });
      this.writePendingAtomic(records);
    });
  }

  private removePending(messageId: string): Promise<void> {
    return this.withPendingLock(() => {
      const records = this.readPending().filter(
        (r) => r.messageId !== messageId,
      );
      this.writePendingAtomic(records);
    });
  }

  private clearAllPending(): Promise<void> {
    return this.withPendingLock(() => {
      this.writePendingAtomic([]);
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
