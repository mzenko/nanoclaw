/**
 * Grant Matt (discord:131970585923158016) the global owner role and a
 * membership row for the chesterbot-test agent group, so the access gate
 * lets his messages through. One-shot fixup for the v2 worktree test.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUserRoles, grantRole } from '../src/modules/permissions/db/user-roles.js';

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const USER_ID = 'discord:131970585923158016';
const AGENT_GROUP_FOLDER = 'chesterbot-test';
const now = new Date().toISOString();
const agentGroup = getAgentGroupByFolder(AGENT_GROUP_FOLDER);

if (!agentGroup) {
  throw new Error(`Agent group not found: ${AGENT_GROUP_FOLDER}`);
}

const existing = getUserRoles(USER_ID);
const isOwner = existing.some((r) => r.role === 'owner' && r.agent_group_id === null);
if (!isOwner) {
  grantRole({ user_id: USER_ID, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  console.log('Granted global owner role');
} else {
  console.log('Already global owner');
}

addMember({ user_id: USER_ID, agent_group_id: agentGroup.id, added_by: null, added_at: now });
console.log(`Added membership for ${agentGroup.id}`);

console.log('Current roles:', JSON.stringify(getUserRoles(USER_ID), null, 2));
