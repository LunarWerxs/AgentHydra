// The caller's current Claude Code session, for the tab ledger: a Desk chat's first session, or a CliMayte worker's `sessionId`.

export interface CallerIds {
  chat?: string
  worker?: string
}

export interface CallerSessionDeps {
  /** Desk's chatSessions: the chat's current session first, then the earlier ones. */
  chatSessions: (chatId: string) => readonly string[]
  /** The bridge's workers; `sessionId` is the worker's current session, `sessions` only the earlier ones. */
  workers: () => Promise<readonly { id: string; sessionId: string | null }[]>
}

export async function callerSession(ids: CallerIds, deps: CallerSessionDeps): Promise<string | undefined> {
  if (ids.chat) return deps.chatSessions(ids.chat)[0] || undefined
  if (ids.worker) return (await deps.workers()).find((w) => w.id === ids.worker)?.sessionId || undefined
  return undefined
}
