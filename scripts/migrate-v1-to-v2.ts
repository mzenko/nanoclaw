/**
 * Migrate Chesterbot's v1 install (the live one at ~/nanoclaw) into v2.
 *
 * Reads from v1's messages.db + groups/, writes into v2's central DB +
 * groups/. Idempotent throughout — re-runs are safe and re-runs after a
 * partial failure resume cleanly.
 *
 * Usage (from inside the v2 worktree):
 *   pnpm exec tsx scripts/migrate-v1-to-v2.ts --v1-root /home/chesterbot/nanoclaw [--dry-run]
 *
 * Hard requirements before running:
 *   - v1 service stopped (the v1 DB is opened read-only but live writes
 *     would race with our reads in WAL mode)
 *   - v2 service running OR stopped (helpers handle both — v2 will pick
 *     up new wirings on next sweep tick)
 *
 * What it does (in order, per channel):
 *   1. Translate v1 JID `dc:<channelId>` → v2 platform_id
 *      `discord:<guildId>:<channelId>` (guild) or `discord:@me:<channelId>` (DM)
 *   2. Get-or-create agent_group, initialize its filesystem
 *   3. Copy v1 `groups/<folder>/CLAUDE.md` → v2 `CLAUDE.local.md`
 *   4. Copy other workspace files (conversations/, attachments, etc.)
 *   5. Get-or-create messaging_group + messaging_group_agent (wiring)
 *   6. If DM, insert user_dms row
 *
 * Plus a one-shot: ensure Matt's user exists with global owner role and
 * agent-group membership in every group.
 *
 * Decisions made for this specific install (hardcoded — change if reused):
 *   - Discord guild ID: 1475482865943969957 (Matt's server)
 *   - Matt's user: discord:131970585923158016, display 'Matt'
 *   - Skip the orphaned discord_vacation-with-chester folder (chat deleted from server)
 *   - Skip the orphaned global/ folder (`global` is reserved in v2's group-folder validator)
 *   - Skip groups/main — already exists in v2 staging
 *   - Skip task migration — only one v1 task and it's already completed
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  createAgentGroup,
  getAgentGroupByFolder,
} from '../src/db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUserRoles, grantRole } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

// --- install-specific constants -------------------------------------

const DISCORD_GUILD_ID = '1475482865943969957';
const MATT_USER_ID = 'discord:131970585923158016';
const MATT_DISPLAY = 'Matt';

const SKIP_FOLDERS = new Set(['discord_vacation-with-chester', 'global', 'main']);

// --- args -----------------------------------------------------------

interface Args {
  v1Root: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--v1-root') {
      out.v1Root = argv[++i];
    } else if (argv[i] === '--dry-run') {
      out.dryRun = true;
    }
  }
  if (!out.v1Root) {
    console.error('Missing --v1-root <path>');
    process.exit(2);
  }
  return out as Args;
}

// --- helpers --------------------------------------------------------

function log(msg: string): void {
  console.log(msg);
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface V1RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  requires_trigger: number;
  is_main: number;
}

interface V1Chat {
  jid: string;
  name: string;
  is_group: number;
}

function translateJid(v1Jid: string, isGroup: number): string {
  // v1 form: dc:<channelId>. v2 form: discord:<guildId|@me>:<channelId>.
  if (!v1Jid.startsWith('dc:')) {
    throw new Error(`Unexpected v1 JID prefix: ${v1Jid}`);
  }
  const channelId = v1Jid.slice(3);
  const guildPart = isGroup === 1 ? DISCORD_GUILD_ID : '@me';
  return `discord:${guildPart}:${channelId}`;
}

// Skip noisy or v1-specific files: container debug logs (v1's container
// runner left these in groups/<folder>/logs/ — irrelevant to v2 since v2
// stores its container logs elsewhere) and macOS .DS_Store turds.
const SKIP_FILE_PATTERNS = [
  /^container-.*\.log$/,
  /^\.DS_Store$/,
];

function shouldSkipFile(name: string): boolean {
  return SKIP_FILE_PATTERNS.some((re) => re.test(name));
}

function copyDirRecursive(src: string, dest: string, dryRun: boolean, skipNames: Set<string>): number {
  if (!fs.existsSync(src)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    if (shouldSkipFile(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!dryRun) fs.mkdirSync(destPath, { recursive: true });
      copied += copyDirRecursive(srcPath, destPath, dryRun, skipNames);
    } else if (entry.isFile()) {
      if (fs.existsSync(destPath)) {
        log(`    skip (exists): ${entry.name}`);
        continue;
      }
      if (!dryRun) fs.copyFileSync(srcPath, destPath);
      copied++;
      log(`    copy: ${entry.name}`);
    }
  }
  return copied;
}

// --- main -----------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tag = args.dryRun ? '[DRY-RUN]' : '[REAL]';
  log(`${tag} Migrating from ${args.v1Root}`);

  // Open v1 DB read-only.
  const v1DbPath = path.join(args.v1Root, 'store', 'messages.db');
  if (!fs.existsSync(v1DbPath)) {
    console.error(`v1 DB not found: ${v1DbPath}`);
    process.exit(1);
  }
  const v1Db = new Database(v1DbPath, { readonly: true });

  // Initialize v2 DB.
  const v2Db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(v2Db);

  const now = new Date().toISOString();

  // 1. Ensure Matt's user + global owner role.
  if (!args.dryRun) {
    upsertUser({
      id: MATT_USER_ID,
      kind: 'discord',
      display_name: MATT_DISPLAY,
      created_at: now,
    });
  }
  log(`${tag} User ensured: ${MATT_USER_ID}`);

  const existingRoles = args.dryRun ? [] : getUserRoles(MATT_USER_ID);
  const isOwner = existingRoles.some((r) => r.role === 'owner' && r.agent_group_id === null);
  if (!isOwner) {
    if (!args.dryRun) {
      grantRole({ user_id: MATT_USER_ID, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
    }
    log(`${tag} Granted global owner role`);
  } else {
    log(`${tag} Already global owner`);
  }

  // 2. Iterate registered groups from v1.
  const registered = v1Db
    .prepare('SELECT jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main FROM registered_groups')
    .all() as V1RegisteredGroup[];

  // For each registered group, JOIN to chats to get is_group.
  const chatByJid = new Map<string, V1Chat>();
  for (const row of v1Db.prepare('SELECT jid, name, is_group FROM chats').all() as V1Chat[]) {
    chatByJid.set(row.jid, row);
  }

  log(`${tag} Found ${registered.length} registered groups`);

  for (const r of registered) {
    log(`\n${tag} === ${r.folder} (${r.jid}) ===`);

    if (SKIP_FOLDERS.has(r.folder)) {
      log(`${tag} Skipping (in SKIP_FOLDERS)`);
      continue;
    }

    const chat = chatByJid.get(r.jid);
    if (!chat) {
      log(`${tag} WARN: no chats row for jid=${r.jid}; assuming guild channel (is_group=1)`);
    }
    const isGroup = chat?.is_group ?? 1;
    const platformId = translateJid(r.jid, isGroup);
    log(`${tag} platform_id: ${platformId} (is_group=${isGroup})`);

    // 2a. Agent group.
    let ag = getAgentGroupByFolder(r.folder);
    if (!ag) {
      const agId = generateId('ag');
      if (!args.dryRun) {
        createAgentGroup({
          id: agId,
          name: 'Chesterbot',
          folder: r.folder,
          agent_provider: 'claude',
          created_at: r.added_at,
        });
        ag = getAgentGroupByFolder(r.folder)!;
      } else {
        ag = {
          id: agId,
          name: 'Chesterbot',
          folder: r.folder,
          agent_provider: 'claude',
          created_at: r.added_at,
        } as AgentGroup;
      }
      log(`${tag} Created agent group: ${ag.id}`);
    } else {
      log(`${tag} Reusing agent group: ${ag.id}`);
    }

    // 2b. Init group filesystem (writes container.json, .claude-shared/, etc.)
    if (!args.dryRun) {
      initGroupFilesystem(ag, {});
    }
    log(`${tag} initGroupFilesystem`);

    // 2c. Copy v1 CLAUDE.md → v2 CLAUDE.local.md (don't overwrite).
    const v1FolderPath = path.join(args.v1Root, 'groups', r.folder);
    const v2FolderPath = path.join(GROUPS_DIR, r.folder);
    const v1ClaudeMd = path.join(v1FolderPath, 'CLAUDE.md');
    const v2ClaudeLocalMd = path.join(v2FolderPath, 'CLAUDE.local.md');
    if (fs.existsSync(v1ClaudeMd)) {
      // initGroupFilesystem may have created an empty CLAUDE.local.md. Treat
      // an empty file as not-present so we still bring v1's content over.
      const existing = fs.existsSync(v2ClaudeLocalMd) ? fs.statSync(v2ClaudeLocalMd).size : 0;
      if (existing === 0) {
        if (!args.dryRun) fs.copyFileSync(v1ClaudeMd, v2ClaudeLocalMd);
        log(`${tag} Copied CLAUDE.md → CLAUDE.local.md`);
      } else {
        log(`${tag} CLAUDE.local.md already has content (${existing}b) — leaving alone`);
      }
    }

    // 2d. Copy all other workspace files (skip CLAUDE.md and any v2-managed
    // files that initGroupFilesystem already wrote).
    const skip = new Set(['CLAUDE.md', 'CLAUDE.local.md', '.claude-shared.md', '.claude-fragments', 'container.json', '.claude']);
    const copied = copyDirRecursive(v1FolderPath, v2FolderPath, args.dryRun, skip);
    log(`${tag} Copied ${copied} workspace file(s) from ${v1FolderPath}`);

    // 2e. Messaging group.
    let mg = getMessagingGroupByPlatform('discord', platformId);
    if (!mg) {
      const mgId = generateId('mg');
      if (!args.dryRun) {
        createMessagingGroup({
          id: mgId,
          channel_type: 'discord',
          platform_id: platformId,
          name: r.name,
          is_group: isGroup,
          unknown_sender_policy: isGroup === 1 ? 'allow' : 'strict',
          created_at: r.added_at,
        });
        mg = getMessagingGroupByPlatform('discord', platformId)!;
      } else {
        mg = {
          id: mgId,
          channel_type: 'discord',
          platform_id: platformId,
          name: r.name,
          is_group: isGroup,
          unknown_sender_policy: isGroup === 1 ? 'allow' : 'strict',
          created_at: r.added_at,
          denied_at: null,
        } as MessagingGroup;
      }
      log(`${tag} Created messaging group: ${mg.id}`);
    } else {
      log(`${tag} Reusing messaging group: ${mg.id}`);
    }

    // 2f. Wiring.
    const wiring = args.dryRun ? null : getMessagingGroupAgentByPair(mg.id, ag.id);
    if (!wiring) {
      // v1's requires_trigger=0 → respond to all (engage_mode='pattern',
      // engage_pattern='.'). requires_trigger=1 → mention-only.
      const engageMode = r.requires_trigger === 0 ? 'pattern' : 'mention';
      const engagePattern = r.requires_trigger === 0 ? '.' : null;
      if (!args.dryRun) {
        createMessagingGroupAgent({
          id: generateId('mga'),
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: engageMode,
          engage_pattern: engagePattern,
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: r.added_at,
        });
      }
      log(`${tag} Wired: ${mg.id} -> ${ag.id} (engage=${engageMode})`);
    } else {
      log(`${tag} Wiring already exists`);
    }

    // 2g. Membership row for Matt.
    if (!args.dryRun) {
      addMember({ user_id: MATT_USER_ID, agent_group_id: ag.id, added_by: null, added_at: now });
    }
    log(`${tag} Added member: ${MATT_USER_ID} → ${ag.id}`);

    // 2h. user_dms entry for the DM channel.
    if (isGroup === 0) {
      // Avoid an explicit insert if v2 already auto-populated the row from
      // an inbound DM event. Use raw SQL since there's no helper that's
      // both upsert-style and DM-specific.
      const exists = args.dryRun
        ? false
        : v2Db
            .prepare('SELECT 1 FROM user_dms WHERE user_id = ? AND channel_type = ? LIMIT 1')
            .get(MATT_USER_ID, 'discord');
      if (!exists) {
        if (!args.dryRun) {
          v2Db
            .prepare(
              'INSERT OR IGNORE INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)',
            )
            .run(MATT_USER_ID, 'discord', mg.id, now);
        }
        log(`${tag} Inserted user_dms row`);
      } else {
        log(`${tag} user_dms row already exists`);
      }
    }
  }

  v1Db.close();
  log(`\n${tag} Done.`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
