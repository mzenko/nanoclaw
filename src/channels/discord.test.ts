import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Per-process unique data dir so concurrent test workers can't stomp each
// other's pending-progress file.
const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `nanoclaw-test-data-${process.pid}`,
);

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: path.join(os.tmpdir(), `nanoclaw-test-data-${process.pid}`),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- discord.js mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    MessageReactionAdd: 'messageReactionAdd',
    ClientReady: 'ready',
    Error: 'error',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
    GuildMessageReactions: 16,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;

    constructor(_opts: any) {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      this._ready = true;
      // Fire the ready event
      const readyHandlers = this.eventHandlers.get('ready') || [];
      for (const h of readyHandlers) {
        h({ user: this.user });
      }
    }

    isReady() {
      return this._ready;
    }

    // Per-channel state, keyed by channel id, so progress tests can find the
    // embed message they "sent" via beginProgress.
    channelState: Record<
      string,
      { sent: any[]; messages: Record<string, any> }
    > = {};

    channels = {
      fetch: vi.fn(async (id: string) => {
        if (!this.channelState[id]) {
          this.channelState[id] = { sent: [], messages: {} };
        }
        const state = this.channelState[id];
        const send = vi.fn(async (payload: any) => {
          const msgId = `embed_${state.sent.length + 1}`;
          const msg = {
            id: msgId,
            channelId: id,
            author: { id: '999888777', bot: true },
            payload,
            edit: vi.fn(async (next: any) => {
              msg.payload = next;
            }),
            delete: vi.fn().mockResolvedValue(undefined),
          };
          state.sent.push(msg);
          state.messages[msgId] = msg;
          return msg;
        });
        return {
          send,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          messages: {
            fetch: vi.fn(async (mid: string) => state.messages[mid]),
          },
        };
      }),
    };

    destroy() {
      this._ready = false;
    }
  }

  // Mock TextChannel type
  class TextChannel {}

  // Minimal builder — captures what the SUT set so tests can introspect.
  class EmbedBuilder {
    data: any = {};
    setColor(c: number) {
      this.data.color = c;
      return this;
    }
    setTitle(t: string) {
      this.data.title = t;
      return this;
    }
    setDescription(d: string) {
      this.data.description = d;
      return this;
    }
    addFields(...fs: any[]) {
      this.data.fields = (this.data.fields || []).concat(fs);
      return this;
    }
    setFooter(f: any) {
      this.data.footer = f;
      return this;
    }
  }

  // Captures the path/name pair the SUT passed so tests can assert on the
  // exact files included in a sendAttachment call.
  class AttachmentBuilder {
    constructor(
      public attachment: string,
      public opts?: { name?: string },
    ) {}
  }

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    Partials: { Channel: 0, Message: 1, Reaction: 2, User: 3 },
    TextChannel,
    EmbedBuilder,
    AttachmentBuilder,
  };
});

import { DiscordChannel, DiscordChannelOpts } from './discord.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<DiscordChannelOpts>,
): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'dc:1234567890123456': {
        name: 'Test Server #general',
        folder: 'test-server',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
}) {
  const channelId = overrides.channelId ?? '1234567890123456';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777'; // matches mock client user id

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, { id: botId });
  }

  return {
    channelId,
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName ? { name: overrides.guildName } : null,
    channel: {
      name: overrides.channelName ?? 'general',
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

// --- Tests ---

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Test Server #general',
        'discord',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'dc:1234567890123456',
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.any(String),
        expect.any(String),
        'discord',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({ isBot: true, content: 'I am a bot' });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses member displayName when available (server nickname)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Nickname' }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: undefined,
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Global' }),
      );
    });

    it('uses sender name for DM chats (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Alice',
        'discord',
        false,
      );
    });

    it('uses guild name + channel name for server messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'My Server #bot-chat',
        'discord',
        true,
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '@Andy hello <@999888777>',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Should NOT prepend @Andy — already starts with trigger
      // But the <@botId> should still be stripped
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@!999888777> check this',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy check this',
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('flags unregistered chat in image attachment placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.png', contentType: 'image/png' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: photo.png (download failed)]',
        }),
      );
    });

    it('flags unregistered chat in video attachment placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Video: clip.mp4 (download failed)]',
        }),
      );
    });

    it('flags unregistered chat in file attachment placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'report.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[File: report.pdf (download failed)]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.jpg', contentType: 'image/jpeg' }],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'Check this out\n[Image: photo.jpg (download failed)]',
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'a.png', contentType: 'image/png' }],
        ['att2', { name: 'b.txt', contentType: 'text/plain' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content:
            '[Image: a.png (download failed)]\n[File: b.txt (download failed)]',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Reply to Bob] I agree with that',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      const fetchedChannel =
        await currentClient().channels.fetch('1234567890123456');
      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('strips dc: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:9876543210', 'Test');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('9876543210');
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Channel not found'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('dc:1234567890123456', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect — client is null
      await channel.sendMessage('dc:1234567890123456', 'No client');

      // No error, no API call
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      expect(mockChannel.send).toHaveBeenNthCalledWith(1, 'x'.repeat(2000));
      expect(mockChannel.send).toHaveBeenNthCalledWith(2, 'x'.repeat(1000));
    });
  });

  // --- sendAttachment ---

  describe('sendAttachment', () => {
    // Ensure a real file exists for fs.statSync inside sendAttachment.
    const tmpFile = path.join(
      os.tmpdir(),
      `nanoclaw-attach-${process.pid}.txt`,
    );
    const bigTmpFile = path.join(
      os.tmpdir(),
      `nanoclaw-attach-big-${process.pid}.bin`,
    );

    beforeEach(() => {
      fs.writeFileSync(tmpFile, 'hello world');
    });

    afterEach(() => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* */
      }
      try {
        fs.unlinkSync(bigTmpFile);
      } catch {
        /* */
      }
    });

    it('sends text + one file as a single message', async () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendAttachment('dc:1234567890123456', 'here you go', [
        { hostPath: tmpFile, name: 'note.txt' },
      ]);

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const payload = mockChannel.send.mock.calls[0][0];
      expect(payload.content).toBe('here you go');
      expect(payload.files).toHaveLength(1);
      expect(payload.files[0].attachment).toBe(tmpFile);
      expect(payload.files[0].opts.name).toBe('note.txt');
    });

    it('drops oversize (>10 MiB) files, still sends text', async () => {
      // 11 MiB sparse file — exceeds the 10 MiB cap.
      const fd = fs.openSync(bigTmpFile, 'w');
      fs.ftruncateSync(fd, 11 * 1024 * 1024);
      fs.closeSync(fd);

      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendAttachment('dc:1234567890123456', 'caption', [
        { hostPath: bigTmpFile, name: 'big.bin' },
      ]);

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const payload = mockChannel.send.mock.calls[0][0];
      expect(payload.content).toBe('caption');
      expect(payload.files).toHaveLength(0);
    });

    it('drops unreadable files (statSync throws) and still sends text', async () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendAttachment('dc:1234567890123456', 'caption', [
        { hostPath: '/nonexistent/path.png', name: 'ghost.png' },
      ]);

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const payload = mockChannel.send.mock.calls[0][0];
      expect(payload.files).toHaveLength(0);
    });

    it('handles empty files array', async () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendAttachment('dc:1234567890123456', 'just text', []);

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const payload = mockChannel.send.mock.calls[0][0];
      expect(payload.content).toBe('just text');
      expect(payload.files).toHaveLength(0);
    });

    it('attaches files only to first chunk when text > 2000 chars', async () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendAttachment('dc:1234567890123456', longText, [
        { hostPath: tmpFile, name: 'note.txt' },
      ]);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      // First call carries the file, second is text-only
      const first = mockChannel.send.mock.calls[0][0];
      expect(first.files).toHaveLength(1);
      const second = mockChannel.send.mock.calls[1][0];
      // Second call is sent as a plain string (not a payload object)
      expect(typeof second).toBe('string');
      expect(second).toBe('x'.repeat(1000));
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns dc: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc:1234567890123456')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      // Warm-cache pre-fetch happens during connect(); reset so the
      // assertion below only measures setTyping's behavior.
      currentClient().channels.fetch.mockClear();

      await channel.setTyping('dc:1234567890123456', false);

      // channels.fetch should NOT be called
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('dc:1234567890123456', true);

      // No error
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });
  });

  // --- Progress lifecycle ---

  describe('progress lifecycle', () => {
    const PENDING_FILE = path.join(
      TEST_DATA_DIR,
      'discord-progress-pending.json',
    );

    beforeEach(() => {
      try {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    afterEach(() => {
      try {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    async function flushTimers(): Promise<void> {
      // Let the rate-limit setTimeout in scheduleProgressEdit fire — needs to
      // be longer than PROGRESS_EDIT_GAP_MS (1100ms).
      await new Promise((r) => setTimeout(r, 1200));
    }

    it('beginProgress sends placeholder embed and persists pending record', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const handle = await channel.beginProgress('dc:1234567890123456');

      expect(handle).not.toBeNull();
      expect(handle!.channel).toBe('discord');
      const data = handle!.data as { channelId: string; messageId: string };
      expect(data.channelId).toBe('1234567890123456');
      expect(data.messageId).toMatch(/^embed_/);

      // The placeholder was actually "sent"
      const state = currentClient().channelState['1234567890123456'];
      expect(state.sent.length).toBe(1);
      expect(state.sent[0].payload.embeds.length).toBe(1);

      // And recorded to the pending file
      expect(fs.existsSync(PENDING_FILE)).toBe(true);
      const records = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
      expect(records).toHaveLength(1);
      expect(records[0].messageId).toBe(data.messageId);
    });

    it('updateProgress(tool_use) edits embed with the tool call', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      const handle = await channel.beginProgress('dc:1234567890123456');
      const turnId = 't1';

      // First updateProgress should fire immediately (lastEditAt=0 fix).
      await channel.updateProgress(handle!, {
        kind: 'tool_use',
        turnId,
        name: 'Bash',
        summary: 'command=ls',
      });
      // Give the in-flight edit a tick to settle.
      await Promise.resolve();
      await Promise.resolve();

      const state = currentClient().channelState['1234567890123456'];
      const msg = state.sent[0];
      // edit was called at least once
      expect(msg.edit).toHaveBeenCalled();
      const lastPayload =
        msg.edit.mock.calls[msg.edit.mock.calls.length - 1][0];
      const parentEmbed = lastPayload.embeds[0];
      const activity = parentEmbed.data.fields?.find(
        (f: any) => f.name === 'Activity',
      );
      expect(activity).toBeDefined();
      expect(activity.value).toContain('Bash');
      expect(activity.value).toContain('command=ls');
    });

    it('subagent_begin renders an extra embed; subagent_end removes it', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      const handle = await channel.beginProgress('dc:1234567890123456');
      const turnId = 't1';

      await channel.updateProgress(handle!, {
        kind: 'subagent_begin',
        turnId,
        subagentId: 'task-1',
        name: 'researcher',
      });
      await flushTimers();

      const state = currentClient().channelState['1234567890123456'];
      const msg = state.sent[0];
      let lastPayload = msg.edit.mock.calls[msg.edit.mock.calls.length - 1][0];
      expect(lastPayload.embeds.length).toBe(2);
      expect(lastPayload.embeds[1].data.title).toContain('researcher');

      await channel.updateProgress(handle!, {
        kind: 'subagent_end',
        turnId,
        subagentId: 'task-1',
      });
      await flushTimers();

      lastPayload = msg.edit.mock.calls[msg.edit.mock.calls.length - 1][0];
      expect(lastPayload.embeds.length).toBe(1);
    });

    it('subagent_begin past cap evicts the oldest subagent', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      const handle = await channel.beginProgress('dc:1234567890123456');
      const turnId = 't1';

      // Open 9 (cap) + 1 (overflow) → first one should be evicted.
      for (let i = 0; i < 10; i++) {
        await channel.updateProgress(handle!, {
          kind: 'subagent_begin',
          turnId,
          subagentId: `task-${i}`,
          name: `agent-${i}`,
        });
      }
      await flushTimers();

      const state = currentClient().channelState['1234567890123456'];
      const msg = state.sent[0];
      const lastPayload =
        msg.edit.mock.calls[msg.edit.mock.calls.length - 1][0];
      // 1 parent + 9 subagents = 10 embeds
      expect(lastPayload.embeds.length).toBe(10);
      // Oldest (`agent-0`) should have been evicted; newest (`agent-9`) kept.
      const titles = lastPayload.embeds.slice(1).map((e: any) => e.data.title);
      expect(titles.some((t: string) => t.includes('agent-0'))).toBe(false);
      expect(titles.some((t: string) => t.includes('agent-9'))).toBe(true);
    });

    it('endProgress(success) deletes the embed and clears pending', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      const handle = await channel.beginProgress('dc:1234567890123456');

      await channel.endProgress(handle!, true);

      const state = currentClient().channelState['1234567890123456'];
      const msg = state.sent[0];
      expect(msg.delete).toHaveBeenCalled();

      // Pending file emptied
      const records = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
      expect(records).toHaveLength(0);
    });

    it('endProgress(failure) keeps embed as red breadcrumb and clears subagent fields', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      const handle = await channel.beginProgress('dc:1234567890123456');
      const turnId = 't1';

      // Add some activity
      await channel.updateProgress(handle!, {
        kind: 'tool_use',
        turnId,
        name: 'Bash',
        summary: 'command=true',
      });
      await channel.updateProgress(handle!, {
        kind: 'subagent_begin',
        turnId,
        subagentId: 'sub-1',
        name: 'helper',
      });
      await channel.endProgress(handle!, false);

      const state = currentClient().channelState['1234567890123456'];
      const msg = state.sent[0];
      // Should NOT have been deleted
      expect(msg.delete).not.toHaveBeenCalled();
      // Last edit should be the failure breadcrumb
      const lastPayload =
        msg.edit.mock.calls[msg.edit.mock.calls.length - 1][0];
      const parent = lastPayload.embeds[0];
      expect(parent.data.title).toBe('Failed');
      expect(parent.data.color).toBe(0xed4245); // COLOR_FAILED
      // Subagent embeds and Activity field cleared
      expect(lastPayload.embeds.length).toBe(1);
      expect(parent.data.fields ?? []).toHaveLength(0);
    });

    it('endProgress(failure, "cancelled") renders grey Cancelled breadcrumb', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      const handle = await channel.beginProgress('dc:1234567890123456');
      await channel.endProgress(handle!, false, 'cancelled');

      const state = currentClient().channelState['1234567890123456'];
      const msg = state.sent[0];
      expect(msg.delete).not.toHaveBeenCalled();
      const lastPayload =
        msg.edit.mock.calls[msg.edit.mock.calls.length - 1][0];
      const parent = lastPayload.embeds[0];
      expect(parent.data.title).toBe('Cancelled');
      expect(parent.data.color).toBe(0x95a5a6); // COLOR_INTERRUPTED
    });

    it('endProgress awaits in-flight edit before applying terminal state', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      const handle = await channel.beginProgress('dc:1234567890123456');

      const state = currentClient().channelState['1234567890123456'];
      const msg = state.sent[0];
      // Make the in-flight edit slow so the race window is large.
      let editResolve: () => void = () => {};
      const editGate = new Promise<void>((r) => {
        editResolve = r;
      });
      msg.edit.mockImplementationOnce(async () => {
        await editGate;
      });

      // Fire-and-forget update kicks off a slow edit.
      void channel.updateProgress(handle!, {
        kind: 'tool_use',
        turnId: 't1',
        name: 'Bash',
        summary: 'command=sleep',
      });
      // Give the kick a tick to register inFlightEdit.
      await Promise.resolve();
      await Promise.resolve();

      // endProgress(success) should wait for the slow edit to resolve before
      // calling delete().
      const endPromise = channel.endProgress(handle!, true);
      // Delete shouldn't have been called yet — endProgress is blocked on the
      // gated edit.
      expect(msg.delete).not.toHaveBeenCalled();
      editResolve();
      await endPromise;
      expect(msg.delete).toHaveBeenCalled();
    });

    it('sweepStaleProgress edits orphaned embeds to "Interrupted" and clears pending', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      // Pre-populate as if a prior run crashed mid-turn.
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
      const stale = [
        {
          channelId: '1234567890123456',
          messageId: 'orphan-msg-1',
          jid: 'dc:1234567890123456',
          startedAt: Date.now() - 10_000,
        },
      ];
      fs.writeFileSync(PENDING_FILE, JSON.stringify(stale));

      // Seed the channel mock with that orphan message so messages.fetch()
      // resolves it.
      const state = currentClient().channelState['1234567890123456'] ?? {
        sent: [],
        messages: {},
      };
      const orphan = {
        id: 'orphan-msg-1',
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      state.messages['orphan-msg-1'] = orphan;
      currentClient().channelState['1234567890123456'] = state;

      await channel.sweepStaleProgress();

      expect(orphan.edit).toHaveBeenCalled();
      const editPayload = orphan.edit.mock.calls[0][0];
      expect(editPayload.embeds[0].data.title).toBe('Interrupted');
      const records = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
      expect(records).toHaveLength(0);
    });

    it('atomic pending writes survive an interleaved persist+remove', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      // Two parallel begins → both must end up in the pending file in order.
      const [h1, h2] = await Promise.all([
        channel.beginProgress('dc:1234567890123456'),
        channel.beginProgress('dc:1234567890123456'),
      ]);
      expect(h1).not.toBeNull();
      expect(h2).not.toBeNull();

      const records = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
      expect(records).toHaveLength(2);
      const ids = records.map((r: any) => r.messageId);
      expect(ids).toContain((h1!.data as any).messageId);
      expect(ids).toContain((h2!.data as any).messageId);
    });
  });

  // --- Stop reaction (❌) ---

  describe('stop reaction', () => {
    function createReaction(opts: {
      emoji?: string;
      partial?: boolean;
      messagePartial?: boolean;
      msgChannelId?: string;
      msgAuthorId?: string;
    }) {
      const msg = {
        partial: opts.messagePartial ?? false,
        channelId: opts.msgChannelId ?? '1234567890123456',
        author: {
          id: opts.msgAuthorId ?? '999888777', // bot id by default
        },
        fetch: vi.fn(async function (this: any) {
          this.partial = false;
          return this;
        }),
      };
      const reaction: any = {
        emoji: { name: opts.emoji ?? '❌' },
        partial: opts.partial ?? false,
        message: msg,
        fetch: vi.fn(async function (this: any) {
          this.partial = false;
          return this;
        }),
      };
      return reaction;
    }

    async function triggerReaction(reaction: any, user: any) {
      const handlers =
        currentClient().eventHandlers.get('messageReactionAdd') || [];
      for (const h of handlers) await h(reaction, user);
    }

    it('calls onStopRequest when bot user receives ❌ on its own message', async () => {
      const onStopRequest = vi.fn();
      const opts = createTestOpts({ onStopRequest });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerReaction(createReaction({}), { id: 'user-1', bot: false });

      expect(onStopRequest).toHaveBeenCalledWith('dc:1234567890123456');
    });

    it('ignores reactions from bots', async () => {
      const onStopRequest = vi.fn();
      const opts = createTestOpts({ onStopRequest });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerReaction(createReaction({}), { id: 'user-2', bot: true });

      expect(onStopRequest).not.toHaveBeenCalled();
    });

    it('ignores non-❌ emojis', async () => {
      const onStopRequest = vi.fn();
      const opts = createTestOpts({ onStopRequest });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerReaction(createReaction({ emoji: '👍' }), {
        id: 'user-1',
        bot: false,
      });

      expect(onStopRequest).not.toHaveBeenCalled();
    });

    it('ignores reactions on messages not authored by the bot', async () => {
      const onStopRequest = vi.fn();
      const opts = createTestOpts({ onStopRequest });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerReaction(
        createReaction({ msgAuthorId: 'some-other-user' }),
        { id: 'user-1', bot: false },
      );

      expect(onStopRequest).not.toHaveBeenCalled();
    });

    it('ignores reactions on unregistered channels', async () => {
      const onStopRequest = vi.fn();
      const opts = createTestOpts({ onStopRequest });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerReaction(
        createReaction({ msgChannelId: '9999999999999999' }),
        { id: 'user-1', bot: false },
      );

      expect(onStopRequest).not.toHaveBeenCalled();
    });

    it('hydrates partial reaction + message before checking', async () => {
      const onStopRequest = vi.fn();
      const opts = createTestOpts({ onStopRequest });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const reaction = createReaction({
        partial: true,
        messagePartial: true,
      });
      await triggerReaction(reaction, { id: 'user-1', bot: false });

      expect(reaction.fetch).toHaveBeenCalled();
      expect(reaction.message.fetch).toHaveBeenCalled();
      expect(onStopRequest).toHaveBeenCalled();
    });
  });
});
