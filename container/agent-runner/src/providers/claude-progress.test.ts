import { describe, expect, it } from 'bun:test';

import { ClaudeProgressTracker } from './claude-progress.js';

function assistant(content: Array<Record<string, unknown>>, parentToolUseId?: string) {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: { content },
  };
}

function user(content: Array<Record<string, unknown>>) {
  return {
    type: 'user',
    message: { content },
  };
}

describe('ClaudeProgressTracker', () => {
  it('opens a turn and emits text preview from assistant text', () => {
    const tracker = new ClaudeProgressTracker();
    tracker.setSessionId('claude-session');

    expect(tracker.onAssistant(assistant([{ type: 'text', text: 'hello' }]))).toEqual([
      { type: 'progress', event: { type: 'begin', sessionId: 'claude-session' } },
      { type: 'progress', event: { type: 'text_delta', preview: 'hello', subagentId: undefined } },
    ]);
  });

  it('tracks foreground Task subagents and attributes child tool use', () => {
    const tracker = new ClaudeProgressTracker();

    expect(
      tracker.onAssistant(
        assistant([{ type: 'tool_use', name: 'Task', id: 'tu-1', input: { description: 'investigate' } }]),
      ),
    ).toContainEqual({
      type: 'progress',
      event: { type: 'subagent_begin', subagentId: 'tu-1', description: 'investigate' },
    });

    expect(tracker.onAssistant(assistant([{ type: 'tool_use', name: 'Read', id: 'read-1' }], 'tu-1'))).toContainEqual({
      type: 'progress',
      event: { type: 'tool_use', toolName: 'Read', subagentId: 'tu-1' },
    });

    expect(tracker.onUser(user([{ type: 'tool_result', tool_use_id: 'tu-1' }]))).toEqual([
      { type: 'progress', event: { type: 'subagent_end', subagentId: 'tu-1' } },
    ]);
  });

  it('deduplicates background task progress and ends on notification', () => {
    const tracker = new ClaudeProgressTracker();
    tracker.onAssistant(
      assistant([
        { type: 'tool_use', name: 'Task', id: 'tu-bg', input: { description: 'background', run_in_background: true } },
      ]),
    );
    tracker.onTaskStarted({ task_id: 'task-1', tool_use_id: 'tu-bg' });

    expect(tracker.onTaskProgress({ task_id: 'task-1', description: 'reading files' })).toEqual([
      { type: 'progress', event: { type: 'tool_use', toolName: 'reading files', subagentId: 'tu-bg' } },
    ]);
    expect(tracker.onTaskProgress({ task_id: 'task-1', description: 'reading files' })).toEqual([]);
    expect(tracker.onTaskNotification({ task_id: 'task-1' })).toEqual([
      { type: 'progress', event: { type: 'subagent_end', subagentId: 'tu-bg' } },
    ]);
  });

  it('emits cancelled end only for an active turn', () => {
    const tracker = new ClaudeProgressTracker();
    expect(tracker.end(false, 'cancelled')).toEqual([]);

    tracker.onAssistant(assistant([{ type: 'text', text: 'working' }]));
    expect(tracker.end(false, 'cancelled')).toEqual([
      { type: 'progress', event: { type: 'end', success: false, reason: 'cancelled' } },
    ]);
  });
});
