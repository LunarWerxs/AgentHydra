import type { TranscriptItem } from '@shared/protocol'

/** What an undo at one message takes out of the chat: the messages from it to the end. */
export interface UndoCount {
  yours: number
  replies: number
  total: number
}

export function undoCount(items: TranscriptItem[], itemId: string): UndoCount | null {
  const from = items.findIndex((it) => it.id === itemId)
  if (from < 0) return null
  let yours = 0
  let replies = 0
  for (const it of items.slice(from)) {
    if (it.parentToolUseId) continue
    if (it.kind === 'user') yours++
    else if (it.kind === 'assistant_text') replies++
  }
  return { yours, replies, total: yours + replies }
}
