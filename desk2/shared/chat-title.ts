import type { CreateChatRequest } from './protocol'

export const TITLE_MAX = 60
/** A chat's title until its first message names it. */
export const NEW_TITLE = 'New session'

/** The first line of the prompt, at most 60 chars (SPEC "Titles"). */
export function titleFrom(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  if (line.length <= TITLE_MAX) return line
  return line.slice(0, TITLE_MAX - 1).trimEnd() + '…'
}

/** The title the server gives a chat made from this request. */
export function newChatTitle(req: Pick<CreateChatRequest, 'title' | 'prompt'>): string {
  return req.title?.trim() || (req.prompt?.trim() ? titleFrom(req.prompt) : NEW_TITLE)
}
