/**
 * The data layer is scripts/dashboard.py - READ-ONLY BY CONSTRUCTION (it defines no POST handler
 * and calls only the daemon's GET endpoints). This gateway does not re-implement one line of its
 * gating or planning; it proxies the named `/data/<name>` answers and nothing else.
 *
 * If the dashboard is not serving, the gateway starts it the same way the scheduled keepalive
 * lane does (`pythonw dashboard.py --port 7799`, detached, no window) and retries once.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DASHBOARD_PORT, REPO_ROOT } from './config.ts'

const DASHBOARD_BASE = `http://127.0.0.1:${DASHBOARD_PORT}`
/** The only names the gateway will forward. Anything else is a 404 here, not a probe of the Python server. */
export const DATA_ROUTES = new Set([
  'plan',
  'chats',
  'instances',
  'suppressed',
  'accounts',
  'rules',
  'scripts',
  'health',
])
/** The accounts survey can take well over a minute on the real fleet (~80 s measured). */
const DATA_TIMEOUT_MS = 240_000
const PROBE_TIMEOUT_MS = 4_000
const START_COOLDOWN_MS = 30_000
let lastStartAt = 0

export interface ProxyResult {
  status: number
  body: unknown
}

function pythonExecutable(): string {
  if (process.env.ORCH_PYTHON) return process.env.ORCH_PYTHON
  // pythonw has no console, so the dashboard survives without ever owning a window (the same
  // reason schedule_jobs.py uses it). Falls back to python where pythonw is absent.
  return process.platform === 'win32' ? 'pythonw' : 'python3'
}

/** Start dashboard.py detached. Idempotent enough: a second copy fails to bind the port and exits. */
export function ensureDashboard(): boolean {
  const now = Date.now()
  if (now - lastStartAt < START_COOLDOWN_MS) return false
  lastStartAt = now
  try {
    const child = spawn(
      pythonExecutable(),
      [join(REPO_ROOT, 'scripts', 'dashboard.py'), '--port', String(DASHBOARD_PORT)],
      {
        cwd: REPO_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // The dashboard has no business holding the tunnel credential. Children inherit the whole
        // environment by default, so supplying the token via CF_TUNNEL_TOKEN would otherwise widen
        // its reach rather than narrow it (audit, 2026-09-03).
        env: { ...process.env, CF_TUNNEL_TOKEN: undefined } as NodeJS.ProcessEnv,
      },
    )
    child.on('error', (err) =>
      console.warn(`[orchestrator-remote] could not start dashboard.py: ${String(err)}`),
    )
    child.unref()
    console.log(`[orchestrator-remote] started scripts/dashboard.py on :${DASHBOARD_PORT}`)
    return true
  } catch (err) {
    console.warn(`[orchestrator-remote] could not start dashboard.py: ${String(err)}`)
    return false
  }
}

export async function dashboardUp(): Promise<boolean> {
  try {
    // A HEAD-less probe: `/` is the static page, answered without touching the daemon.
    const res = await fetch(`${DASHBOARD_BASE}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

function isRefused(err: unknown): boolean {
  const s = String((err as { cause?: unknown })?.cause ?? err)
  return /ECONNREFUSED|ConnectionRefused|Unable to connect|fetch failed/i.test(s)
}

/** Forward one named data query. Returns the dashboard's own status + JSON, or a 502 shaped like its errors. */
export async function dashboardData(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyResult> {
  if (!DATA_ROUTES.has(name)) return { status: 404, body: { error: 'no such route' } }
  const url = `${DASHBOARD_BASE}/data/${name}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(DATA_TIMEOUT_MS) })
      const body = await res
        .json()
        .catch(() => ({ error: `dashboard answered ${res.status} without JSON` }))
      return { status: res.status, body }
    } catch (err) {
      if (attempt === 0 && isRefused(err) && ensureDashboard()) {
        await new Promise((r) => setTimeout(r, 2_500))
        continue
      }
      // A failed read must never render as an empty fleet - the page shows this loudly.
      return {
        status: 502,
        body: {
          error: isRefused(err)
            ? `the dashboard data layer (scripts/dashboard.py on :${DASHBOARD_PORT}) is not answering`
            : `dashboard read failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
  }
  return { status: 502, body: { error: 'dashboard read failed' } }
}
