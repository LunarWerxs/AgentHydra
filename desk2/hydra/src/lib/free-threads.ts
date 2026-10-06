import type { FreeInstance, FreeThread } from '@desk/shared/free-instances'
import type { CliMayteWorkerView } from '@/lib/api'

/** Display adapter only. A Free row never goes to the CLI worker API. */
export function freeThreadRow(thread: FreeThread, instance?: FreeInstance): CliMayteWorkerView & { free: FreeThread } {
  return { id: `free:${thread.id}`, group: 'free', title: thread.title, cwd: '', prompt: '', pending: [],
    model: thread.provider === 'claude' ? 'Claude · Incognito' : 'ChatGPT · Temporary', effort: null, accounts: null,
    status: thread.status, sessionId: null, accountId: null, account: instance ? `#${instance.num} ${instance.name}` : null,
    attempts: [], result: null, error: thread.error, lastActivity: null, costUsd: 0, turns: 0, moves: 0, retries: 0,
    notBefore: null, ranS: 0, createdAt: thread.createdAt, updatedAt: thread.updatedAt, kind: 'private-chat', verdicts: [], free: thread }
}
