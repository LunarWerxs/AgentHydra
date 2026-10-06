// server/src/dev-servers-tool.ts - the `dev_servers` MCP tool: one copy of each project's dev servers for every
// session on this PC, wherever it runs (Claude Desktop, a CLI, a terminal). The manager lives in AgentHydra 2.0
// (Desk, desk2/server/src/devservers), so this file keeps no state: it calls Desk's /dw/api on 127.0.0.1 with no
// Origin header (Desk's own-page rule lets a local client that sends none through) and answers in a few lines
// of text a model can act on. Desk starts its dev-servers service itself on the first ask.
import { S, str } from './mcp-client'
import type { McpEngineTool } from './mcp-stdio.mjs'

// The parts of desk2/shared/devwebui.ts this reads. Not imported: a release build may carry no desk2/.
interface DevProcess {
  id: string
  localId: string
  name: string
  status: string
  owner: 'desk' | 'outside' | null
  port?: number
  url?: string
  conflict: string | null
}
interface DevProject {
  name: string
  processes: DevProcess[]
}
interface DevLocalServer {
  port: number
  process: string | null
  url: string
}
interface DevServers {
  project: DevProject | null
  projects: DevProject[]
  others: DevLocalServer[]
}
interface DevEnsure {
  ok: boolean
  reused?: boolean
  process?: DevProcess
  url?: string | null
  error?: string
  logTail?: string[]
  choices?: string[]
}
interface DevLogs {
  lines?: { line: string }[]
}

export const DEV_SERVERS_NOT_RUNNING =
  'AgentHydra 2.0 is not running on this PC, so dev servers cannot be shared; open AgentHydra.'
// Desk's ensure waits up to ~45 s for a server to answer; this stays under the MCP call budget (50 s).
const START_TIMEOUT_MS = 48_000
const ASK_TIMEOUT_MS = 10_000
const LOG_LINES_DEFAULT = 60
const LOG_LINES_MAX = 500
const UP = new Set(['running', 'starting', 'waiting'])

/** Desk's address, read at each call so HYDRA_DESK_PORT (and a test's stand-in Desk) is honoured. */
const deskBase = (): string => `http://127.0.0.1:${process.env.HYDRA_DESK_PORT || 7798}`

class DeskDown extends Error {}
/** Desk took longer than the call allows: what was asked may still be under way. */
class DeskSlow extends Error {}

async function ask(
  method: 'GET' | 'POST',
  path: string,
  timeoutMs: number,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  let res: Response
  try {
    res = await fetch(`${deskBase()}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      throw new DeskSlow(
        `AgentHydra 2.0 did not answer in ${Math.round(timeoutMs / 1000)} s (${method} ${path.split('?')[0]}).`,
      )
    throw new DeskDown(DEV_SERVERS_NOT_RUNNING)
  }
  return { status: res.status, json: await res.json().catch(() => null) }
}

const errorOf = (json: unknown, status: number): string =>
  (json as { error?: string } | null)?.error ?? `AgentHydra answered HTTP ${status}.`

const address = (p: Pick<DevProcess, 'port' | 'url'>): string | null =>
  p.url && /^https?:\/\//i.test(p.url)
    ? p.url
    : p.port
      ? `http://localhost:${p.port}${p.url?.startsWith('/') ? p.url : ''}`
      : null

function describe(p: DevProcess): string {
  const at = address(p)
  const who = p.owner === 'outside' ? ', started outside AgentHydra' : ''
  const why = p.conflict ? ` - ${p.conflict}` : ''
  return `- ${p.localId} (${p.name}): ${p.status}${at && UP.has(p.status) ? ` at ${at}` : ''}${who}${why}`
}

function projectLines(project: DevProject): string[] {
  return [`${project.name}:`, ...project.processes.map(describe)]
}

async function servers(cwd: string, all: boolean): Promise<DevServers> {
  const q = `cwd=${encodeURIComponent(cwd)}${all ? '&all=1' : ''}`
  const r = await ask('GET', `/dw/api/servers?${q}`, ASK_TIMEOUT_MS)
  if (r.status !== 200) throw new Error(errorOf(r.json, r.status))
  return r.json as DevServers
}

async function list(cwd: string, all: boolean): Promise<string> {
  const s = await servers(cwd, all)
  const lines: string[] = []
  if (all) for (const p of s.projects) lines.push(...projectLines(p))
  else if (s.project) lines.push(...projectLines(s.project))
  else lines.push(`No dev-servers project covers ${cwd}.`)
  if (s.others.length)
    lines.push(
      'Other dev servers on this PC that no project lists:',
      ...s.others.map((o) => `- ${o.url}${o.process ? ` (${o.process})` : ''}`),
    )
  return lines.join('\n')
}

async function start(cwd: string, server: string | undefined): Promise<string> {
  let r: { status: number; json: unknown }
  try {
    r = await ask('POST', '/dw/api/ensure', START_TIMEOUT_MS, {
      cwd,
      ...(server ? { server } : {}),
    })
  } catch (e) {
    if (!(e instanceof DeskSlow)) throw e
    // Desk keeps starting it after this call gives up: a shell start now would be the second copy.
    return `${e.message} The server is probably still starting: check with \`list\` or \`logs\` in a moment, and do not start it from the shell (a second copy fights the first for its port).`
  }
  const a = r.json as DevEnsure | null
  if (!a) throw new Error(errorOf(a, r.status))
  if (!a.ok) {
    const out = [a.error ?? errorOf(a, r.status)]
    if (a.choices?.length) out.push(`Choose one of: ${a.choices.join(', ')}.`)
    if (a.logTail?.length) out.push('Log tail:', ...a.logTail)
    return out.join('\n')
  }
  const p = a.process
  const name = p?.name ?? 'The server'
  const at = a.url ?? (p ? address(p) : null)
  if (a.reused) {
    const who =
      p?.owner === 'outside' ? ' (started outside AgentHydra)' : ' (started by AgentHydra)'
    return at
      ? `Already running at ${at}${who}; use it.`
      : `${name} is already running${who}; it has no port to open.`
  }
  return at ? `Started ${name} at ${at}.` : `Started ${name} (it has no port).`
}

/** The one server an id, local id or name (any case) names in the folder's project, or why not. */
async function resolve(
  cwd: string,
  server: string | undefined,
): Promise<{ proc: DevProcess } | { say: string }> {
  const { project } = await servers(cwd, false)
  if (!project) return { say: `No dev-servers project covers ${cwd}.` }
  const procs = project.processes
  const exist = `${project.name} has: ${procs.map((p) => `${p.localId} (${p.name})`).join(', ')}.`
  // Never guessed among several, not even the one that runs: other sessions may be using it.
  if (!server?.trim()) {
    if (procs.length === 1) return { proc: procs[0] as DevProcess }
    return { say: `Name the server with \`server\`. ${exist}` }
  }
  const want = server.trim().toLowerCase()
  const hits = procs.filter(
    (p) =>
      p.id.toLowerCase() === want ||
      p.localId.toLowerCase() === want ||
      p.name.toLowerCase() === want,
  )
  if (hits.length === 1) return { proc: hits[0] as DevProcess }
  if (hits.length > 1)
    return {
      say: `"${server}" matches more than one server: ${hits.map((p) => p.localId).join(', ')}. Use a local id. ${exist}`,
    }
  return { say: `No server "${server}" in ${project.name}. ${exist}` }
}

async function stop(cwd: string, server: string | undefined): Promise<string> {
  const found = await resolve(cwd, server)
  if ('say' in found) return found.say
  const p = found.proc
  const r = await ask(
    'POST',
    `/dw/api/processes/${encodeURIComponent(p.id)}/stop`,
    ASK_TIMEOUT_MS,
    {},
  )
  if (r.status !== 200) return errorOf(r.json, r.status)
  const co = (r.json as { coStopped?: string[] } | null)?.coStopped ?? []
  const who = p.owner === 'outside' ? ' (it was started outside AgentHydra)' : ''
  return `Stopped ${p.name}${who}.${co.length ? ` Also stopped: ${co.join(', ')}.` : ''}`
}

async function logs(cwd: string, server: string | undefined, lines: unknown): Promise<string> {
  const found = await resolve(cwd, server)
  if ('say' in found) return found.say
  const p = found.proc
  const n = Math.min(LOG_LINES_MAX, Math.max(1, Math.floor(Number(lines)) || LOG_LINES_DEFAULT))
  const r = await ask('GET', `/dw/api/processes/${encodeURIComponent(p.id)}/logs`, ASK_TIMEOUT_MS)
  if (r.status !== 200) return errorOf(r.json, r.status)
  const all = ((r.json as DevLogs | null)?.lines ?? []).map((l) => l.line)
  if (!all.length) return `${p.name} (${p.status}) has printed nothing yet.`
  const tail = all.slice(-n)
  const head = `Last ${tail.length} line${tail.length === 1 ? '' : 's'} of ${p.name} (${p.status}):`
  return [head, ...tail].join('\n')
}

export async function devServers(a: Record<string, unknown>): Promise<string> {
  const action = str(a.action)
  const cwd = str(a.cwd).trim()
  if (!['list', 'start', 'stop', 'logs'].includes(action))
    return 'action must be one of list, start, stop, logs.'
  // A drive or share path, or `/x` off Windows (on Windows it is relative to the current drive).
  if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(cwd) && !(process.platform !== 'win32' && cwd.startsWith('/')))
    return 'cwd must be the absolute folder of the work (for example C:/Users/me/app).'
  const server = a.server == null ? undefined : str(a.server)
  try {
    if (action === 'list') return await list(cwd, a.all === true)
    if (action === 'start') return await start(cwd, server)
    if (action === 'stop') return await stop(cwd, server)
    return await logs(cwd, server, a.lines)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export const DEV_SERVERS_TOOLS: McpEngineTool[] = [
  {
    name: 'dev_servers',
    description:
      "MUTATES: (start, stop) one shared copy of each project's dev servers (vite, next, `bun run dev`...). AgentHydra 2.0 runs them for every session on this PC. `start` returns the address of the copy already running, whoever started it, or starts it; call it BEFORE starting a dev server from the shell, never start one yourself (a second copy fights the first for its port). `list` shows the folder's servers (all: every project's, plus other localhost dev servers), `stop` ends one, `logs` returns its last output. Needs AgentHydra 2.0 open.",
    inputSchema: S(
      {
        action: { type: 'string', enum: ['list', 'start', 'stop', 'logs'] },
        cwd: {
          type: 'string',
          description: 'Absolute folder of the work (your working directory).',
        },
        server: {
          type: 'string',
          description:
            "Which server: its id, local id or name (any case). Optional for start and list when the folder's project has one; stop and logs need it when it has several.",
        },
        all: { type: 'boolean', description: 'list: every project, not only the one for cwd.' },
        lines: {
          type: 'number',
          description: `logs: how many of the last lines (default ${LOG_LINES_DEFAULT}, max ${LOG_LINES_MAX}).`,
        },
      },
      ['action', 'cwd'],
    ),
    run: (a) => devServers(a),
  },
]
