import type { ProviderEvent } from './types.js';

type ProgressProviderEvent = Extract<ProviderEvent, { type: 'progress' }>;

function progress(event: ProgressProviderEvent['event']): ProgressProviderEvent {
  return { type: 'progress', event };
}

function contentBlocks(message: unknown): Array<Record<string, unknown>> {
  const raw = (message as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

export class ClaudeProgressTracker {
  private openSubagents = new Set<string>();
  private backgroundSubagents = new Set<string>();
  private taskIdToToolUseId = new Map<string, string>();
  private lastProgressTool = new Map<string, string>();
  private turnActive = false;
  private sessionId = 'unknown';

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  onAssistant(message: unknown): ProgressProviderEvent[] {
    const events = this.startTurn();
    const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
    const subagentForMessage = parentToolUseId && this.openSubagents.has(parentToolUseId) ? parentToolUseId : undefined;

    for (const block of contentBlocks(message)) {
      if (block.type === 'tool_use') {
        const toolName = String(block.name ?? '');
        const id = String(block.id ?? '');
        const input = (block.input as Record<string, unknown> | undefined) ?? {};
        if (toolName === 'Agent' || toolName === 'Task') {
          const isBackground = input.run_in_background === true;
          const description = String(input.description ?? input.prompt ?? 'subagent').slice(0, 100);
          this.openSubagents.add(id);
          if (isBackground) this.backgroundSubagents.add(id);
          events.push(progress({ type: 'subagent_begin', subagentId: id, description }));
        } else {
          events.push(progress({ type: 'tool_use', toolName, subagentId: subagentForMessage }));
        }
      } else if (block.type === 'text') {
        const preview = String(block.text ?? '').slice(-280);
        if (preview) events.push(progress({ type: 'text_delta', preview, subagentId: subagentForMessage }));
      }
    }
    return events;
  }

  onUser(message: unknown): ProgressProviderEvent[] {
    const events: ProgressProviderEvent[] = [];
    for (const block of contentBlocks(message)) {
      if (block.type !== 'tool_result') continue;
      const id = String(block.tool_use_id ?? '');
      if (this.openSubagents.has(id) && !this.backgroundSubagents.has(id)) {
        this.openSubagents.delete(id);
        events.push(progress({ type: 'subagent_end', subagentId: id }));
      }
    }
    return events;
  }

  onTaskStarted(message: unknown): void {
    const m = message as { task_id?: string; tool_use_id?: string };
    if (m.task_id && m.tool_use_id) this.taskIdToToolUseId.set(m.task_id, m.tool_use_id);
  }

  onTaskProgress(message: unknown): ProgressProviderEvent[] {
    const m = message as { task_id?: string; tool_use_id?: string; description?: string };
    const subagentId = m.tool_use_id ?? (m.task_id ? this.taskIdToToolUseId.get(m.task_id) : undefined);
    if (!subagentId || !this.backgroundSubagents.has(subagentId)) return [];

    const summary = (m.description || '').trim();
    if (!summary || this.lastProgressTool.get(subagentId) === summary) return [];

    this.lastProgressTool.set(subagentId, summary);
    return [progress({ type: 'tool_use', toolName: summary, subagentId })];
  }

  onTaskNotification(message: unknown): ProgressProviderEvent[] {
    const m = message as { task_id?: string; tool_use_id?: string };
    const subagentId = m.tool_use_id ?? (m.task_id ? this.taskIdToToolUseId.get(m.task_id) : undefined);
    if (!subagentId || !this.backgroundSubagents.has(subagentId)) return [];

    this.backgroundSubagents.delete(subagentId);
    this.openSubagents.delete(subagentId);
    return [progress({ type: 'subagent_end', subagentId })];
  }

  end(success: boolean, reason?: 'cancelled' | 'failed'): ProgressProviderEvent[] {
    if (!this.turnActive) return [];

    const events: ProgressProviderEvent[] = [];
    for (const id of this.openSubagents) {
      events.push(progress({ type: 'subagent_end', subagentId: id }));
    }
    this.openSubagents.clear();
    this.backgroundSubagents.clear();
    this.taskIdToToolUseId.clear();
    this.lastProgressTool.clear();
    this.turnActive = false;
    events.push(progress(success ? { type: 'end', success } : { type: 'end', success, reason }));
    return events;
  }

  private startTurn(): ProgressProviderEvent[] {
    if (this.turnActive) return [];
    this.turnActive = true;
    return [progress({ type: 'begin', sessionId: this.sessionId })];
  }
}
