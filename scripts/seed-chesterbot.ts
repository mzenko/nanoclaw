/**
 * Seed Chesterbot's v2 test wiring: agent group "Chesterbot" + messaging group
 * pointed at the #🔧testing-mr-chesterbot Discord channel + a group-channel
 * wiring with engage_mode='pattern' (responds to all messages, no @-mention
 * required).
 *
 * Mirrors seed-discord.ts but tailored for Chesterbot's setup.
 *
 * Usage: pnpm exec tsx scripts/seed-chesterbot.ts
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { initGroupFilesystem } from '../src/group-init.js';

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const now = new Date().toISOString();

// 1. Agent group
const FOLDER = 'chesterbot-test';
let ag = getAgentGroupByFolder(FOLDER);
if (!ag) {
  const id = `ag-${Date.now()}-chesterbot`;
  createAgentGroup({
    id,
    name: 'Chesterbot',
    folder: FOLDER,
    agent_provider: 'claude',
    created_at: now,
  });
  ag = getAgentGroupByFolder(FOLDER)!;
  console.log(`Created agent group: ${ag.id}`);
} else {
  console.log(`Reusing agent group: ${ag.id}`);
}
initGroupFilesystem(ag, {
  instructions:
    '# Chesterbot (v2 testing)\n\nMatt is testing the v2 migration in this channel. Be your normal self.',
});

// 2. Messaging group — guild text channel, is_group=1
const PLATFORM_ID = 'discord:1475482865943969957:1497696244934508594';
let mg = getMessagingGroupByPlatform('discord', PLATFORM_ID);
if (!mg) {
  const id = `mg-${Date.now()}-tmrc`;
  createMessagingGroup({
    id,
    channel_type: 'discord',
    platform_id: PLATFORM_ID,
    name: '🔧testing-mr-chesterbot',
    is_group: 1,
    unknown_sender_policy: 'allow',
    created_at: now,
  });
  mg = getMessagingGroupByPlatform('discord', PLATFORM_ID)!;
  console.log(`Created messaging group: ${mg.id} (${PLATFORM_ID})`);
} else {
  console.log(`Reusing messaging group: ${mg.id}`);
}

// 3. Wiring — engage_mode='pattern' with '.' so the bot responds to every
// message in the channel (no @-mention required). Matches the user's
// expressed intent for this test channel.
const existingWiring = getMessagingGroupAgentByPair(mg.id, ag.id);
if (existingWiring) {
  console.log(`Wiring already exists: ${existingWiring.id}`);
} else {
  const id = `mga-${Date.now()}-chesterbot-tmrc`;
  createMessagingGroupAgent({
    id,
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired: ${mg.id} -> ${ag.id} (pattern '.')`);
}

console.log('Done.');
