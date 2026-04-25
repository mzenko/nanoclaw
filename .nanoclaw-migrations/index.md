# Chesterbot v1 → v2 Migration Guide

This is the source of truth for re-applying Chesterbot's customizations on top of NanoClaw v2 (which is a ground-up rewrite, not mergeable from v1). Follow the order below; each file captures one customization cluster with intent + implementation detail.

## Anchors

- **Base commit (last common with upstream)**: `eba94b721ab8c7476e97d6600ca7ee4c0e53249c`
- **Upstream HEAD at extraction time**: `0bc082a17cad3064bd9af395a61f1db959b85c1d` (NanoClaw v2.0.13)
- **Fork HEAD at extraction time**: `29b690893ac2852611f38920fdacf57112ad96ae`
- **Pre-migration rollback tag**: `pre-v2-migration` (also pushed to `origin`)
- **Persistent state snapshot**: `~/chesterbot-v1-state-2026-04-25.tgz`

## Architectural decisions taken (locked in for the migration)

1. **Sidecars stay as separate skill-installable repos** under mzenko org (matches v2's per-channel-skill philosophy). The 4 mzenko forks (`nanoclaw-home-assistant`, `nanoclaw-playwright`, `nanoclaw-google-workspace`, `nanoclaw-channel-progress`) get rebased on v2 patterns rather than inlined.
2. **Discord channel-progress fork**: default to v2's Chat SDK Discord adapter. Re-implement only the Discord features v2 lacks (likely: progress embeds, subagent embeds, attachment plumbing, ❌ cancel, DM cache warming, reply context). Confirm during Phase C.
3. **Test channel**: Discord `#🔧testing-mr-chesterbot` (ID `1497696244934508594`, jid `dc:1497696244934508594`). Register so it responds without @-mention.
4. **No npm**: v2 uses pnpm 10.33.0 — install pnpm via corepack before Phase D.

## Migration clusters (apply in this order)

| # | Guide | Rough effort |
|---|---|---|
| 01 | [Marker nonce + agent-runner protections](01-marker-nonce.md) — applies once, prerequisite for almost everything else | 30 min |
| 02 | [Stdio MCP: seats.aero](02-mcp-seats-aero.md) | 1–2 hr |
| 03 | [Remote MCP: Kiwi flights](03-mcp-kiwi.md) | 15 min |
| 04 | [Discord channel — base + progress UI + subagent embeds + ❌ cancel + attachments](04-channel-discord.md) | 1 day |
| 05 | [Other channel adapters (Gmail, Telegram, Slack, WhatsApp)](05-channel-other.md) | 4–8 hr |
| 06 | [Sidecar: ha-mcp (Home Assistant)](06-sidecar-ha-mcp.md) | 3–4 hr |
| 07 | [Sidecar: playwright-mcp + /workspace path fix](07-sidecar-playwright-mcp.md) | 4–6 hr |
| 08 | [Sidecar: workspace-mcp (Google)](08-sidecar-workspace-mcp.md) | 4–6 hr |
| 09 | [Persona: Chester (CLAUDE.md → v2 fragments)](09-persona-chester.md) | 1–2 hr |
| 10 | [Skill edits + workflow deletions](10-skills-and-workflows.md) | 1 hr |

## What is NOT in this guide (intentionally)

- Anything in `store/`, `data/`, `groups/`, `.env` — never touched by NanoClaw, persists across migrations.
- Auto-memory at `~/.claude/projects/-home-chesterbot-nanoclaw/memory/` — outside repo.
- Channel-skill merge commits from `discord/main`, `gmail/main`, `whatsapp/main` — those branches are frozen at pre-v2 era; v2 has its own `channels` branch with replacement adapters.
- Upstream PRs that are already in v2 (security fixes, npm-audit fixes, etc.).

## V2 mapping notes (Phase C output goes here)

This section will be appended after Phase C research is done. For now, key reference paths in v2:

- v2 channel adapters: `channels` branch on qwibitai/nanoclaw → `src/channels/{discord,telegram,slack,whatsapp,...}.ts`
- v2 multi-provider: `providers` branch → `src/providers/`
- v2 CLAUDE.md fragment composer: `src/claude-md-compose.ts` on origin/main
- v2 container shared-RO source mount: see commit `8a12fa6 refactor: shared source — replace per-group agent-runner copies with single RO mount`
- v2 entity model: see upstream `CLAUDE.md` "Entity Model" section
- v2 two-DB session split: `data/v2-sessions/<session_id>/{inbound,outbound}.db`
