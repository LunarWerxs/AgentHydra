// The session header's calls to AgentHydra, through Desk 2's own /ah/api (server/src/plugins/45-agenthydra.ts
// hands them to the one AgentHydra daemon). The same endpoints AgentHydra's Sessions tab calls.
import type { AhInstance, AhSecrets, AhSessionRow, AhUsage } from './logic'

const BASE = '/ah/api'

// An answer that is not JSON (a dev server's index page sent back for an address it does not know) is an error, apart
// from a JSON null, which some calls answer (instanceAccount): before, it came back as null and the instance list's .map
// threw outside any catch.
const NOT_JSON = Symbol('not JSON')

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init?.body ? { ...init, headers: { 'content-type': 'application/json' } } : init)
  const read = (await res.json().catch(() => NOT_JSON)) as (T & { error?: unknown }) | null | typeof NOT_JSON
  const body = read === NOT_JSON ? null : read
  if (!res.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `${res.status} ${res.statusText}`)
  if (read === NOT_JSON) throw new Error(`${res.status} ${res.statusText}: not a JSON answer`)
  return body as T
}

/** `?source=…&locator=…`: a locator names the exact store when two products can hold the same id. */
function where(row: Pick<AhSessionRow, 'source' | 'locator'>): string {
  return `?source=${encodeURIComponent(row.source)}${row.locator ? `&locator=${encodeURIComponent(row.locator)}` : ''}`
}
const sid = (row: Pick<AhSessionRow, 'session_id'>) => encodeURIComponent(row.session_id)

export const ah = {
  /** The session's row; no source finds the newest session with that id. */
  session: (id: string, source?: string) => call<AhSessionRow>(`/sessions/${encodeURIComponent(id)}${source ? `?source=${encodeURIComponent(source)}` : ''}`),
  usage: (row: AhSessionRow) => call<AhUsage>(`/sessions/${sid(row)}/usage${where(row)}`),
  secrets: (row: AhSessionRow) => call<AhSecrets>(`/sessions/${sid(row)}/secrets${where(row)}`),
  fileLocation: (row: AhSessionRow) => call<{ path: string }>(`/sessions/${sid(row)}/file-location${where(row)}`),
  /** Opens the transcript with the PC's own program for it. */
  openFile: (row: AhSessionRow) => call<{ ok: boolean }>(`/sessions/${sid(row)}/open-file${where(row)}`, { method: 'POST' }),
  /** Puts the file itself (not its text) on the PC's clipboard, which a page cannot do. */
  copyFile: (row: AhSessionRow) => call<{ ok: boolean; filename?: string; reason?: string }>(`/sessions/${sid(row)}/copy-file${where(row)}`, { method: 'POST' }),
  /** Opens a terminal on `claude --resume <id>`; the command comes back either way. */
  resumeInTerminal: (row: AhSessionRow) => call<{ ok: boolean; command: string; reason?: string }>(`/sessions/${sid(row)}/resume-terminal${where(row)}`, { method: 'POST' }),
  instances: () => call<AhInstance[]>('/instances'),
  /** The account an instance is signed into, from what is on disk (no sign-in request). */
  instanceAccount: (dir: string) => call<AhInstance['account']>(`/instances/${encodeURIComponent(dir)}/account?noNetwork=1`),
  focusInstance: (dir: string) => call<{ ok: boolean; message?: string }>(`/instances/${encodeURIComponent(dir)}/focus`, { method: 'POST' }),
  openInstance: (dir: string) => call<{ ok: boolean; message?: string }>(`/instances/${encodeURIComponent(dir)}/open`, { method: 'POST' }),
  /** Moves the chat to another account's desktop app; its current title restated is the required title decision. */
  migrate: (row: AhSessionRow, instanceRef: string) =>
    call<{ ok: boolean; error?: string; sourceStillShown?: string[] }>(`/sessions/${sid(row)}/migrate`, {
      method: 'POST',
      body: JSON.stringify({ instance_ref: instanceRef, confirm_title: row.title })
    }),
  exportUrl: (row: AhSessionRow, format: 'markdown' | 'html') => `${BASE}/sessions/${sid(row)}/export${where(row)}&format=${format}`,
  fileUrl: (row: AhSessionRow) => `${BASE}/sessions/${sid(row)}/file${where(row)}`
}

/** Migrate by the session's id alone (the row menu's Move to account): AgentHydra's row first, whose title the move restates. */
export async function moveSession(sessionId: string, instanceRef: string): ReturnType<typeof ah.migrate> {
  return ah.migrate(await ah.session(sessionId, 'claude'), instanceRef)
}
