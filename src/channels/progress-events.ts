/**
 * Mirror of container/agent-runner/src/progress-events.ts.
 *
 * Both files declare the same wire-format type. They live in two places
 * because container and host are separate TypeScript projects; the type is
 * not imported across them — it is encoded as JSON in the kind='progress'
 * messages_out row's content field. Keep both files in sync.
 *
 * See docs/progress-lane.md.
 */

export type ProgressEvent =
  | { type: 'begin'; sessionId: string }
  | { type: 'tool_use'; toolName: string; subagentId?: string; description?: string }
  | { type: 'text_delta'; preview: string; subagentId?: string }
  | { type: 'subagent_begin'; subagentId: string; description: string }
  | { type: 'subagent_end'; subagentId: string }
  | { type: 'end'; success: boolean; reason?: 'cancelled' | 'failed' };
