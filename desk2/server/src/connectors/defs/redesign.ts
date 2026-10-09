// The ReDesign connector (LunarWerxs/ReDesign: generates several redesign options of a UI with image models, keys
// are the person's own). ReDesign is never copied or changed; Desk finds it, installs its release, starts it and
// gives chats two tools so that before a chat builds or restyles a UI it first sees 4-5 options inline.
//
//   find:    GET /api/health answering {service:'redesign'} at REDESIGN_URL, else the url in its runtime.json
//            (<REDESIGN_HOME or ~/.redesign>/runtime.json: it writes where it really bound, port hops included),
//            else http://127.0.0.1:<PORT or 5178>. Not answering: installed when Desk's own copy
//            (<home>/apps/redesign, from installFromRelease) or REDESIGN_EXE / `redesign` on PATH is there.
//   install: release asset redesign-windows-x64.exe of LunarWerxs/ReDesign (checked against SHA256SUMS.txt), then start.
//   start:   `<exe> serve` hidden, REDESIGN_NO_OPEN=1 so it opens no browser, log <home>/logs/redesign.log.
//   chat:    MCP server redesign-mcp.ts (design_options, design_pick) served over HTTP by Desk's own process at
//            /mcp/redesign (plugins/68-mcp.ts), pointed at the running ReDesign, its pictures written to
//            <home>/design-options; plus one paragraph. (Until 2026-10-09 a bun child per chat: 19 of them, ~1.6 GB.)
//   keys:    real runs need provider keys, added in ReDesign's own page (the pane); `mock: true` needs none.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorDef, ConnectorFactory, Detected } from '../types'
import { installedApp, installFromRelease, startHidden, whichOnce } from '../release'

const ASSET = 'redesign-windows-x64.exe'
const PROBE_MS = 1500

const PROMPT =
  'Design first. Before you build or restyle a user interface (a page, screen, component or an app\'s whole look), ' +
  'get perspective: call design_options with a short brief and a screenshot or URL of what exists. The chat shows ' +
  'the options to the person as a ReDesign card, so do not paste the images. By default you decide: say which one you ' +
  'pick and why, then call design_pick. When the person asked to see or choose options, or the look is a matter of ' +
  'their taste, pass ask_owner true, end your turn and wait: their choice, notes or request for more arrives as their next ' +
  'message. Then call design_pick with the ' +
  'chosen option and build to the spec it returns. Skip it for a one-line style fix. If design_options says there is no ' +
  'provider key, tell the person to add one in ReDesign (Settings → Connectors → ReDesign → Open); never ask for a key in chat.'

/** The addresses ReDesign may be at, most specific first. */
function candidates(): string[] {
  const urls: string[] = []
  const env = process.env.REDESIGN_URL?.trim()
  if (env) urls.push(env)
  try {
    const dir = process.env.REDESIGN_HOME?.trim() || join(homedir(), '.redesign')
    const url = (JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')) as { url?: unknown }).url
    if (typeof url === 'string' && url) urls.push(url)
  } catch {
    // not running, or never ran
  }
  urls.push(`http://127.0.0.1:${process.env.PORT?.trim() || 5178}`)
  return [...new Set(urls.map((u) => u.replace(/\/+$/, '')))]
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_MS) })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: unknown; service?: unknown }
    return body.ok === true && body.service === 'redesign'
  } catch {
    return false
  }
}

/** The address ReDesign answers at right now, or null. */
export async function runningRedesignUrl(): Promise<string | null> {
  for (const url of candidates()) if (await answers(url)) return url
  return null
}

const factory: ConnectorFactory = ({ home }): ConnectorDef => {
  const dest = join(home, 'apps', 'redesign')
  const log = join(home, 'logs', 'redesign.log')

  /** Desk's own copy, else a machine install named by REDESIGN_EXE or found on PATH. */
  const exe = (): { file: string; version: string | null } | null => {
    const own = installedApp(dest)
    if (own) return own
    const named = process.env.REDESIGN_EXE?.trim() || whichOnce('redesign')
    return named && existsSync(named) ? { file: named, version: null } : null
  }

  const detect = async (): Promise<Detected> => {
    const installed = exe()
    for (const url of candidates()) {
      if (await answers(url)) return { state: 'running', url, version: installed?.version ?? null }
    }
    if (installed) return { state: 'installed', url: null, version: installed.version }
    return { state: 'absent', url: null, version: null, reason: 'ReDesign is not installed on this machine' }
  }

  const start = async (): Promise<void> => {
    const app = exe()
    if (!app) throw new Error('ReDesign is not installed')
    if ((await detect()).state === 'running') return
    const pid = startHidden([app.file, 'serve'], { log, env: { REDESIGN_NO_OPEN: '1' } })
    if (pid === null) throw new Error(`ReDesign would not start (see ${log})`)
    // It writes its runtime.json once bound; give it a while to answer before saying it is up.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if ((await detect()).state === 'running') return
    }
    throw new Error(`ReDesign did not answer within 20 s (see ${log})`)
  }

  return {
    info: {
      id: 'redesign',
      name: 'ReDesign',
      blurb: 'Before a chat builds a UI it sees 4-5 design options first, and builds to the one chosen.',
      homepage: 'https://github.com/LunarWerxs/ReDesign',
      installable: true,
      pane: true
    },
    detect,
    async install(progress) {
      await installFromRelease({ repo: 'LunarWerxs/ReDesign', asset: ASSET, dest, progress })
      progress('Starting ReDesign')
      await start()
    },
    start,
    chat(_cwd, status) {
      if (status.state !== 'running' || !status.url) return null
      return {
        mcpServers: {
          // Served by Desk itself (plugins/68-mcp.ts), writing to <home>/design-options: no bun child per chat.
          redesign: { type: 'http', url: `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}/mcp/redesign?url=${encodeURIComponent(status.url)}` }
        },
        prompt: PROMPT
      }
    }
  }
}

export default factory
