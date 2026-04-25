# 05 — Other channel adapters (Gmail, Telegram, Slack, WhatsApp)

These are lower-priority than Discord. Chester rarely uses them.

## Status check before doing anything

Before re-applying ANY of these, ask: do we still want this channel active? If not, **skip** the adapter entirely. Removing a channel is one less thing to maintain.

If we do want it, install v2's adapter from the `channels` branch via the corresponding `add-*` skill in v2's setup flow.

## Per-channel notes

### Gmail
- v1 has `src/channels/gmail.ts` from the qwibitai/nanoclaw-gmail repo
- **In v2's `channels` branch, gmail.ts is NOT present** — gmail in v2 is exposed as a tool (`mcp__gmail__*`) via the `add-gmail-tool` skill, not as a full channel that can trigger the agent
- **Decision needed**: do we want emails to trigger Chester (channel mode), or just give Chester gmail tools (tool mode)?
- If channel mode is needed, the v1 polling logic in `src/channels/gmail.ts` would need porting (maybe via webhook for v2)
- If tool-only is fine, install upstream's `add-gmail-tool` skill — done

### Telegram
- v1 has `src/channels/telegram.ts` + tests from qwibitai/nanoclaw-telegram (frozen at pre-v2)
- v2's `channels` branch has its own `telegram.ts` + adapter pattern
- **Action**: drop v1 file, install via v2 skill (likely `/add-telegram-v2` per upstream skill names)
- Re-register the Telegram chat with the v2 register command
- v2 adds telegram-specific features we don't have: pairing flow (`telegram-pairing.ts`), markdown sanitizer (`telegram-markdown-sanitize.ts`)

### Slack
- v1 has `src/channels/slack.ts` from qwibitai/nanoclaw-slack
- v2 has `slack.ts` on channels branch
- **Action**: drop v1 file, install via v2 skill
- v2 has DM-thread reply fix (commit `fdece80 fix: reply in the Slack DM thread the user wrote in`) — pure win

### WhatsApp
- v1 has `src/channels/whatsapp.ts` + tests from qwibitai/nanoclaw-whatsapp
- v2 has `whatsapp.ts` (Baileys-based) AND `whatsapp-cloud.ts` (Cloud API) on channels branch — picks two implementations
- **Decision**: stick with Baileys (per WhatsApp Business research already done — Chester's use case is wrong fit for Cloud API)
- **Action**: install v2's Baileys whatsapp adapter via skill
- v2's commit `e55ed0f fix(whatsapp): upgrade Baileys 6.7→6.17, fix proto import and 515 restart` is a pure win
- v2 has the notification-suppression fix from jonazri (PR #91) which we already had locally — no regression

## V2 reapplication

For each channel we keep:
1. Install via skill: `/add-<channel>-v2` (or whatever the v2 install path is)
2. Re-register the chat with v2's register command
3. Smoke test: send a message in the channel, verify response

## Files to drop entirely (v1 → v2)

- `src/channels/gmail.ts`, `gmail.test.ts` (replace with tool or v2 adapter)
- `src/channels/telegram.ts`, `telegram.test.ts`
- `src/channels/slack.ts`, `slack.test.ts`
- `src/channels/whatsapp.ts`, `whatsapp.test.ts`
- `src/channels/index.ts` (replaced by v2's channel-registry.ts)
- `src/channels/registry.ts` (replaced by v2's channel-registry.ts)

## What was historically lost

The `whatsapp` remote merge was reverted at one point (commit `89e22a6 Revert "Merge remote-tracking branch 'whatsapp/main'"`). The notification-suppression fix from jonazri (`9777d29` on the channel branch) was the value worth keeping — verify v2 has equivalent.
