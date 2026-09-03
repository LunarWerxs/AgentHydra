import { fleetStatus } from '../fleet'
import { fleetGit } from '../fleet-git'
import { fleetInstances } from '../fleet-instances'
import { fleetUsage } from '../fleet-usage'
import { app } from '../http-app'
import {
  getMonitorSettings,
  listMonitorAccounts,
  monitorStatus,
  runMonitorOnce,
  setMonitorForAccount,
  setMonitorSettings,
} from '../monitor'
import { jsonBody } from '../route-helpers'
import type { MonitorView } from '../types'

/** The auto-resume monitor (Feature E) and the read-only fleet observation summary. See index.ts
 *  for the app-wide middleware these routes run behind. */
// --- auto-resume monitor (Feature E) ----------------------------------------
const monitorView = (): MonitorView => ({
  settings: getMonitorSettings(),
  status: monitorStatus(),
  accounts: listMonitorAccounts(),
})
app.get('/api/monitor', (c) => c.json(monitorView()))
app.post('/api/monitor', async (c) => {
  const body = await jsonBody(c)
  setMonitorSettings({
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined,
    resumeBufferMin: typeof body.resumeBufferMin === 'number' ? body.resumeBufferMin : undefined,
    resumePrompt: typeof body.resumePrompt === 'string' ? body.resumePrompt : undefined,
  })
  return c.json(monitorView())
})
app.post('/api/monitor/account', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.accountId !== 'string' || typeof body.enabled !== 'boolean')
    return c.json({ error: 'accountId and enabled are required' }, 400)
  setMonitorForAccount(body.accountId, body.enabled)
  return c.json(monitorView())
})
// Force one monitor pass now (manual "check for resumable stops").
app.post('/api/monitor/check', async (c) => {
  await runMonitorOnce()
  return c.json({ ok: true, ...monitorView() })
})

// --- fleet observation (see server/src/fleet.ts) ------------------------------------------
// Deterministic and read-only: the observation core every later rebuild piece reads. Grows one
// key per landed piece: sessions (piece 1, fleet.ts), usage (piece 2, fleet-usage.ts), git
// (piece 3, fleet-git.ts), instances (piece 4, fleet-instances.ts - account identity). Zero
// AI, zero writes, zero settings.
app.get('/api/fleet', async (c) => {
  const status = fleetStatus()
  // Sections fail INDEPENDENTLY: one broken store must not 500 the sessions/usage that already
  // resolved. A failed section is null plus a named entry in `errors` - reported, never hidden.
  const errors: string[] = []
  const section = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  const [git, instances] = await Promise.all([
    section('git', () => fleetGit(status.sessions.map((s) => s.cwd))),
    section('instances', () => fleetInstances()),
  ])
  return c.json({ ...status, usage: fleetUsage(), git, instances, errors })
})
