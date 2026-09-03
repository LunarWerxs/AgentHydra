/**
 * The remote gateway. `bun run remote` from the repo root.
 *
 *   loopback :7790  ->  this gateway  ->  scripts/dashboard.py :7799 (data, read-only)
 *   cloudflared     ->  https://<quick>.trycloudflare.com  ->  this gateway (owner session required)
 *   app.repoyeti.com/r/<id>  ->  the permanent address, and the OAuth return route
 *
 * ORCH_REMOTE_PORT overrides the port; ORCH_NO_TUNNEL=1 serves loopback only; CF_TUNNEL_TOKEN with
 * `tunnel.hostname` in state/remote/config.json runs a named tunnel on the owner's own domain.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { DEFAULT_PORT, loadConfig, REPO_ROOT, STATE_DIR } from './config.ts'
import { dashboardUp, ensureDashboard } from './dashboard.ts'
import { buildApp } from './http.ts'
import { startRemote } from './remote.ts'
import { watchTray } from './switch.ts'

/**
 * WRITE OUR OWN LOG, rather than trusting an inherited stdout.
 *
 * The gateway is started detached and window-less (scripts/remote.py, and the tray through it),
 * and although that spawn hands over a file handle, nothing of ours arrived in the file: bun
 * re-execs, and the log stayed at its two header lines while the daemon ran perfectly. That is
 * the worst shape of gap - every failure path in remote.py and every error balloon in the tray
 * says "see state/logs/remote-gateway.log", so an empty file reads as "nothing happened" exactly
 * when something did. Appending here is independent of how the process was launched.
 */
function teeConsoleToLog(): void {
  const dir = join(STATE_DIR, 'logs')
  const file = join(dir, 'remote-gateway.log')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return // an unwritable log must never stop the gateway from serving
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      try {
        const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
        appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
      } catch {
        /* the log is a convenience, never a dependency */
      }
    }
  }
}
teeConsoleToLog()

const cfg = loadConfig()
const port = Number(process.env.ORCH_REMOTE_PORT) || cfg.port || DEFAULT_PORT
const webDist = join(REPO_ROOT, 'web', 'dist')

const app = buildApp(cfg, { version: pkg.version, webDist })
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
  // Bun's default idle timeout is 10 s; the accounts survey alone can take 80+ s. 255 is the max.
  idleTimeout: 255,
})
console.log(
  `[orchestrator-remote] v${pkg.version} serving http://127.0.0.1:${server.port}${existsSync(webDist) ? '' : '  (web/dist missing - run `bun run remote:build`)'}`,
)

void dashboardUp().then((up) => {
  if (!up) ensureDashboard()
})
const tunnel = startRemote(cfg, port)

function shutdown(): void {
  tunnel?.stop()
  server.stop(true)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// DIE WITH THE ICON - BY DEFAULT, however this process was started.
//
// This used to be opt-IN (ORCH_TRAY_SUPERVISED=1, set only by the tray), which left a hole the
// audit found on 2026-09-03: remote.py's own status output tells a person to run
// `remote.py --start`, that copy carried no supervision, and the tray then ADOPTED it - its
// Start-Remote returns early when the port already answers - so the icon could be sitting there
// believing it owned a gateway that would outlive it. `orch.py disarm` did not close it either.
// One unsupervised gateway is enough to undo the whole guarantee, because this process can arm
// the machine from a phone. So supervision is now the default and opting out is explicit and
// deliberate: ORCH_NO_TRAY_SUPERVISION=1, for a developer running it in the foreground.
const supervised = process.env.ORCH_NO_TRAY_SUPERVISION !== '1'
if (supervised) {
  watchTray((why) => {
    console.log(`[orchestrator-remote] ${why} - shutting the gateway down with it`)
    shutdown()
  })
  console.log('[orchestrator-remote] tray-supervised: this gateway stops when the icon does')
} else {
  console.warn(
    '[orchestrator-remote] ORCH_NO_TRAY_SUPERVISION=1 - this gateway will KEEP SERVING with no tray icon on screen. Development only.',
  )
}
