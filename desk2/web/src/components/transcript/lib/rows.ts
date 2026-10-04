// Turning the flat item list into what the transcript renders. Pure: no Vue, no DOM.
import type { TranscriptItem } from '@shared/protocol'

export interface Rows {
  /** Items rendered at the top level, in order. */
  top: TranscriptItem[]
  /** Sub-agent items by the Agent/Task tool_use id they run under. */
  children: Map<string, TranscriptItem[]>
}

const isAgentTool = (it: TranscriptItem) => it.kind === 'tool_use' && (it.name === 'Agent' || it.name === 'Task')

/**
 * Items with a parentToolUseId nest under that Agent/Task card (recursively: a sub-agent's own
 * sub-agent nests in its card). An item whose parent is not in the list stays at the top level so
 * nothing is ever hidden.
 */
export function buildRows(items: TranscriptItem[]): Rows {
  const agentIds = new Set<string>()
  for (const it of items) if (isAgentTool(it)) agentIds.add(it.id)
  const top: TranscriptItem[] = []
  const children = new Map<string, TranscriptItem[]>()
  for (const it of items) {
    const p = it.parentToolUseId
    if (p && p !== it.id && agentIds.has(p)) {
      let list = children.get(p)
      if (!list) children.set(p, (list = []))
      list.push(it)
    } else top.push(it)
  }
  return { top, children }
}

/** A first guess at a row's height in px, used until the row has been measured. */
export function estimateHeight(it: TranscriptItem): number {
  switch (it.kind) {
    case 'user':
      return 52 + 20 * Math.min(20, Math.floor(it.text.length / 90)) + (it.images?.length ? 104 : 0)
    case 'assistant_text':
      return 32 + 22 * Math.min(60, Math.ceil(it.text.length / 95) + (it.text.match(/\n/g)?.length ?? 0) / 2)
    case 'thinking':
    case 'tool_use':
    case 'system':
    case 'result':
      return 30
    case 'todos':
      return 40 + 24 * it.todos.length
    case 'task':
      return it.taskKind === 'workflow' ? 81 : 56
    case 'permission':
    case 'question':
    case 'plan':
    case 'elicitation':
      return 32 // pending ones render in the composer dock; the transcript keeps one line
  }
}
