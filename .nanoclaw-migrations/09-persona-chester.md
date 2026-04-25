# 09 — Persona: Chester (CLAUDE.md → v2 fragments)

## Intent

The "Chester" persona, his capabilities list, internal-thoughts conventions, message formatting per channel, flight-search tool family guidance, task-script frequency rules, and workspace conventions.

## Source files (v1)

- `groups/global/CLAUDE.md` — 158 lines, applied to all groups
- `groups/main/CLAUDE.md` — 309 lines, applied to the main group (a richer/longer version of global with main-channel-specific bits like email handling)

Both start with the same opening:
```
# Chester
You are Chester, a personal assistant. You help with tasks, answer questions, and can schedule reminders.
```

The `main` variant is longer — diff `groups/global/CLAUDE.md` vs `groups/main/CLAUDE.md` to extract the main-channel-specific delta.

## V2's solution: fragment composition

V2 introduced commit `c8fc1da refactor(claude-md): compose per-group CLAUDE.md from shared base + fragments` and `e64bdb3 refactor(claude-md): split shared base into module fragments, inject name at runtime`.

The composer is `src/claude-md-compose.ts` (read in Phase C).

This **solves the per-channel CLAUDE.md staleness problem** that we deferred fixing in our project memory — fragment composition means we don't have to copy-paste persona content into each channel's CLAUDE.md.

## V2 reapplication

1. Read v2's `src/claude-md-compose.ts` to understand the fragment file structure (likely something like `src/claude-md/{base,channels,personas}/*.md`)
2. Create a Chester persona fragment (e.g. `src/claude-md/personas/chester.md`) containing the persona content from `groups/global/CLAUDE.md`
3. Inject "Chester" as the agent name at runtime (the v2 commit message mentions name injection)
4. For the main-channel-specific extra content (gmail email-notification handling — see `groups/main/CLAUDE.md` lines we'd find via diff), make a second fragment specifically for the main group
5. Make sure all per-group CLAUDE.md files are auto-composed, not authored

## What gets DROPPED in v2

- The hand-maintained `groups/discord_vacation-with-chester/CLAUDE.md` (and any other per-channel snapshots) — those exist as data and we leave them, but they should be regenerated under v2's composer model. Verify after migration that each channel's CLAUDE.md is composed correctly.

## Persona content (extracted highlights for fast lookup)

From `groups/global/CLAUDE.md`:

- Chester is a personal assistant
- Can browse with `agent-browser`, read/write files, run bash, schedule tasks
- Has `mcp__nanoclaw__send_message` for mid-work acknowledgments
- Uses `<internal>` tags for internal reasoning (not sent to user)
- When working as sub-agent, only sends messages if main agent says so
- **Flight search**: dual MCP families — `mcp__kiwi-flights__*` (cash) and `mcp__seats__*` (award). Run both in parallel for "miles vs cash" comparisons. Detailed Kiwi capabilities/limitations + seats.aero workflow notes
- **Workspace**: files saved in `/workspace/group/`
- **Memory**: `conversations/` folder for past conversation history
- **Message formatting**: per-channel rules (Slack mrkdwn, WhatsApp/Telegram, Discord standard markdown)
- **Task scripts**: prefer `script` field on `schedule_task` for cheap pre-checks; explanation of when scripts help vs hurt; frequency-guidance rules

## V2 mapping notes

- The seats.aero MCP carries its own server-level `instructions` (≤2048 chars, auto-injected). So v2's persona fragment for flight search can be **shorter** — much of the workflow content lives in MCP instructions now.
- The Kiwi MCP doesn't have instructions — keep the channel-side guidance for it.
- Move per-channel formatting rules into a `src/claude-md/channels/{discord,slack,whatsapp,telegram}.md` fragment if v2's composer supports per-channel-type fragments.

## Verification

In Discord testing channel: ask Chester an identity question. Verify he replies as Chester with persona intact, and that flight-search dual MCP behavior works.
