/**
 * Structured progress events emitted by the agent provider, written to
 * outbound.db as kind='progress' rows, and consumed by Discord's progress
 * embed renderer. See docs/progress-lane.md.
 *
 * The host side declares a mirror of this type in
 * src/channels/progress-events.ts. Keep them in sync — they are not the same
 * file because container and host are separate TypeScript projects, and
 * the wire format is JSON anyway.
 */

export type ProgressEvent =
  | { type: 'begin'; sessionId: string }
  | { type: 'tool_use'; toolName: string; subagentId?: string; description?: string }
  | { type: 'text_delta'; preview: string; subagentId?: string }
  | { type: 'subagent_begin'; subagentId: string; description: string }
  | { type: 'subagent_end'; subagentId: string }
  | { type: 'end'; success: boolean; reason?: 'cancelled' | 'failed' };
