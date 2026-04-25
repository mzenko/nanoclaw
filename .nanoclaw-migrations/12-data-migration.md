# 12 — V1 → V2 data migration plan

Output of Phase G research subagent. Spans the actual data carry-over from `/home/chesterbot/nanoclaw/store/messages.db` (v1) into `/home/chesterbot/nanoclaw-v2-stage/data/v2.db` (v2) plus the per-group filesystem.

## Scope

| v1 entity | Count | v2 destination |
|---|---|---|
| `registered_groups` | 3 | `agent_groups` × 3 + `messaging_groups` × 3 + `messaging_group_agents` × 3 |
| `chats` | 7 | Subset of 3 (only registered) → `messaging_groups`. Rest dropped. |
| `messages` | 170+ | **No central table in v2.** Conversation history lives in per-session inbound.db. Preserved implicitly via `groups/<folder>/conversations/` markdown files (copy as-is). |
| `scheduled_tasks` | 1 | None — only existing task is already `status='completed'`. Skip. |
| `sessions` | n | None — drop. v2 creates new sessions on demand. |
| `task_run_logs` | n | None — archive v1 DB if audit history needed later. |

## Channel JID translation table

| Folder | v1 JID | v2 platform_id | Type |
|---|---|---|---|
| `discord_main` | `dc:1495449635777413281` | `discord:1475482865943969957:1495449635777413281` | Guild |
| `discord_dm_matt` | `dc:1495623052459905207` | `discord:@me:1495623052459905207` | DM (format inferred — see risk below) |
| `discord_vacation-time` | `dc:1496339355856277574` | `discord:1475482865943969957:1496339355856277574` | Guild |

Guild ID `1475482865943969957` is the same for all three channels (and the test channel) — hardcode as a constant in the script.

**Open risk:** DM platform_id format is inferred from the `@chat-adapter/discord` TypeScript types but not verified against a live event. Mitigation: have Matt DM the v2 test bot once before running the migration; read what platform_id gets auto-stored in v2's tables; either confirm the format or correct the script.

## Wiring translation

v1's `(requires_trigger, is_main)` flags → v2 `(engage_mode, engage_pattern)`:

| v1 | v2 |
|---|---|
| `requires_trigger=0` | `engage_mode='pattern'`, `engage_pattern='.'` |
| `requires_trigger=1` | `engage_mode='mention'`, `engage_pattern=NULL` |

Note: v1's `trigger_pattern='@Chester'` is the display name for mentions, NOT a routing regex. Don't use it as `engage_pattern`.

`is_main=1` has no v2 equivalent. Drop.

`unknown_sender_policy` is required in v2 but absent in v1. Pick per-channel:
- DM: `'strict'` (only Matt sends)
- Guild channels: `'allow'` (matches v2 test seed)

## Filesystem operations per folder

For each registered v1 group:
1. Create `groups/<folder>/` if missing
2. Copy v1's `groups/<folder>/CLAUDE.md` → `CLAUDE.local.md` (NEVER `CLAUDE.md` — v2 auto-overwrites that file every spawn)
3. Copy all other files/dirs (`conversations/`, attachments, etc.) as-is
4. Run `initGroupFilesystem(ag, {})` so v2 creates the rest of the scaffold (`container.json`, `.claude-shared/`, `settings.json`, `skills/`)

Folder names stay as-is (`discord_main` etc.) — passes `isValidGroupFolder()` regex, no risk to in-conversation self-references.

## User & permissions

Matt's user already exists in v2 staging (`discord:131970585923158016` with global owner). Migration uses `upsertUser()` + `getUserRoles()` check + `addMember()` (all idempotent).

For the DM channel: insert a `user_dms` row linking Matt → DM messaging group.

## Special-case folders

- **`groups/global/`** — `'global'` is reserved by `isValidGroupFolder()`. Cannot become a v2 group. Action: review content, manually fold into per-channel `CLAUDE.local.md` files OR drop.
- **`groups/main/`** — already exists as a v2 group folder. Don't overwrite; merge content carefully.
- **`groups/discord_vacation-with-chester/`** — orphaned (folder exists, has v1 sessions row, has Discord channel ID `1496309640810463436` in `chats`, but NOT in `registered_groups`). Either wire as a real channel (`discord:1475482865943969957:1496309640810463436`) or copy files to archive only. Decision needed.

## Script structure

Single file: `scripts/migrate-v1-to-v2.ts` in the v2 worktree.

- Read v1 DB read-only; write v2 DB via existing helpers
- Idempotent throughout (gate every write on a getXXX check)
- `--dry-run` flag that logs actions without writing
- `db.transaction()` per channel for atomic DB writes
- Filesystem copies are purely additive (safe to re-run)

Order of operations per channel:
1. `createAgentGroup` (or get existing)
2. `initGroupFilesystem(ag, {})`
3. Copy `CLAUDE.md` → `CLAUDE.local.md`
4. Copy other workspace files
5. `createMessagingGroup` (or get existing)
6. `createMessagingGroupAgent` — auto-creates `agent_destinations` row (use the helper, NOT raw SQL)
7. If DM: insert `user_dms` row

## Top risks (carry into Phase G)

1. **Silent message drops if platform_id format is wrong** — most dangerous failure mode. The router does an exact-match lookup; one character off and the bot goes deaf with no error log.
2. **DM format unverified** — inferred from types only. Mitigation: have Matt DM the v2 test bot first.
3. **Existing v2 staging data must not collide** — idempotent helpers protect this, but only if the v1 folder names differ from the v2 staging names. They do (v1 has `discord_main`, v2 staging has `chester-test` and `main`), so no collision.
4. **`task_run_logs` not migrated** — archive v1 DB before deleting.
5. **Workspace file copy** — `discord_main/` has PNGs, JPGs, and a `polar_bear.zip`. Need graceful error handling on cp failures.
6. **In-flight session state lost** — first v2 message starts a fresh session. Time the cutover to a quiet moment.

## Cutover sequence

1. Have Matt DM the v2 test bot once → confirm DM platform_id format → adjust script if needed
2. Stop v1 service
3. Run migration script in dry-run mode
4. Review dry-run output with Matt
5. Run migration script for real
6. Update v2's .env with v1's bot tokens (so v2 takes over Matt's real bot)
7. Stop v2 test bot, restart v2 service against the real bot tokens
8. Send test message in `#chester-town` to verify
9. Roll back if needed via `pre-v2-migration` tag + restoring `~/chesterbot-v1-state-2026-04-25.tgz`
