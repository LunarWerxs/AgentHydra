// The RepoYeti connector: LunarWerxs/RepoYeti, a git app (repos, changes, commits, pull requests), hooked in as it
// is. Nothing of it is copied or changed; Desk finds it, installs it from its GitHub release on request, starts it
// hidden, shows its own page in the right pane (web/src/components/connectors/RepoYetiPane.vue) and gives every
// chat its MCP tools while it runs.
//
// What RepoYeti's source says (v1.3.0), and what this file does with it:
// - Its daemon listens on 127.0.0.1:7171 (or another free port) and records the port it really bound in
//   <REPOYETI_HOME or ~/.repoyeti>/runtime.json { port, url, pid }, a file that outlives the daemon, so a runtime
//   file alone proves nothing: running means GET <url>/api/health answers { service: 'repoyeti' }.
// - `repoyeti start` runs the daemon; only a bare double-click of the release exe (no arguments) opens a browser, so
//   Desk passes `start` and REPOYETI_NO_OPEN=1.
// - Its MCP is in the daemon too: POST <url>/api/mcp (JSON-RPC, plain JSON), open on loopback and gated only by the
//   daemon's own approval gate for mutations. Chats get that HTTP form rather than `repoyeti mcp` (stdio): it needs no
//   second process, no path to the exe, and no credential, since the stdio form is only a proxy to the same daemon.
// - It sends no X-Frame-Options or frame-ancestors, so the pane frames its page as it is. The page has no URL for a
//   chosen repo, so the pane opens it on the whole app.
// An existing install is found through REPOYETI_EXE, the usual install folders and PATH, besides Desk's own copy.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorDef, ConnectorFactory, Detected } from '../types'
import { installedApp, installFromRelease, startHidden, whichOnce } from '../release'

const REPO = 'LunarWerxs/RepoYeti'
const ASSET = 'repoyeti-windows-x64.exe'
const PROBE_MS = 1500

/** RepoYeti's own state folder (it honours REPOYETI_HOME), read at call time so a test can point it elsewhere. */
const stateDir = (): string => process.env.REPOYETI_HOME || join(homedir(), '.repoyeti')

/** The url its runtime.json records, or null without one (it always writes it when it listens). A stale file only costs a failed probe. */
function runtimeUrl(): string | null {
  try {
    const url = (JSON.parse(readFileSync(join(stateDir(), 'runtime.json'), 'utf8')) as { url?: unknown }).url
    if (typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(url)) return url
  } catch {
    /* no file: it never ran, or exited cleanly */
  }
  return null
}

/** The version when `url` answers as RepoYeti, else null. */
async function probe(url: string): Promise<{ version: string | null } | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_MS) })
    if (!res.ok) return null
    const body = (await res.json()) as { service?: unknown; version?: unknown }
    if (body.service !== 'repoyeti') return null
    return { version: typeof body.version === 'string' ? body.version : null }
  } catch {
    return null
  }
}

/** The machine's own RepoYeti exe: REPOYETI_EXE, then the places an installer or a download puts it. */
function machineExe(): string | null {
  const local = process.env.LOCALAPPDATA
  const candidates = [
    process.env.REPOYETI_EXE,
    local && join(local, 'Programs', 'RepoYeti', 'RepoYeti.exe'),
    local && join(local, 'Programs', 'RepoYeti', 'repoyeti.exe'),
    local && join(local, 'RepoYeti', 'RepoYeti.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'RepoYeti', 'RepoYeti.exe')
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return whichOnce('repoyeti') ?? whichOnce('repoyeti-windows-x64')
}

const repoyeti: ConnectorFactory = ({ home }): ConnectorDef => {
  const dest = join(home, 'apps', 'repoyeti')
  const log = join(home, 'logs', 'repoyeti.log')
  const exe = (): string | null => installedApp(dest)?.file ?? machineExe()

  const waitRunning = async (ms: number): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const url = runtimeUrl()
      if (url && (await probe(url))) return
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`RepoYeti did not answer within ${Math.round(ms / 1000)} s; see ${log}`)
  }

  const start = async (): Promise<void> => {
    const file = exe()
    if (!file) throw new Error('RepoYeti is not installed')
    const running = runtimeUrl()
    if (running && (await probe(running))) return
    if (startHidden([file, 'start'], { log, env: { REPOYETI_NO_OPEN: '1' } }) === null) throw new Error(`RepoYeti would not start; see ${log}`)
    await waitRunning(30_000)
  }

  return {
    info: {
      id: 'repoyeti',
      name: 'RepoYeti',
      blurb: 'Your repos, changes, commits and pull requests, in its own pane; chats use its git tools.',
      homepage: 'https://github.com/LunarWerxs/RepoYeti',
      installable: true,
      pane: true
    },

    async detect(): Promise<Detected> {
      const url = runtimeUrl()
      const up = url ? await probe(url) : null
      if (url && up) return { state: 'running', url, version: up.version ?? installedApp(dest)?.version ?? null }
      if (installedApp(dest) || machineExe()) return { state: 'installed', url: null, version: installedApp(dest)?.version ?? null }
      return { state: 'absent', url: null, version: null, reason: 'not on this machine' }
    },

    async install(progress): Promise<void> {
      await installFromRelease({ repo: REPO, asset: ASSET, dest, progress })
      progress('Starting RepoYeti')
      await start()
    },

    start,

    chat(_cwd, status) {
      if (status.state !== 'running' || !status.url) return null
      return {
        mcpServers: { repoyeti: { type: 'http', url: `${status.url}/api/mcp` } },
        prompt:
          "RepoYeti (the person's git app) is connected. For git work (status, diff, commit, branches, pull requests) prefer its repoyeti tools. " +
          'A change it makes for an agent waits in its approval gate: when one is waiting, say so, because the person approves it in the RepoYeti pane.'
      }
    }
  }
}

export default repoyeti
