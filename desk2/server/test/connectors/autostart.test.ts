// A connector that is installed and enabled starts by itself when Desk starts, and when its switch is turned back on.
// Fake defs only: no real exe is spawned and the data home is a temp folder.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorId } from '@shared/connectors'
import { startConnectors } from '../../src/connectors/registry'
import type { ConnectorDef, Detected } from '../../src/connectors/types'
import type { ServerContext } from '../../src/context'

const temps: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fake(id: ConnectorId, state: Detected['state'], start?: () => Promise<void>): ConnectorDef & { starts: number } {
  const def: ConnectorDef & { starts: number } = {
    info: { id, name: id, blurb: '', homepage: 'https://example.com', installable: false, pane: false },
    detect: async () => ({ state, url: state === 'running' ? 'http://127.0.0.1:1' : null, version: '1.0.0' }),
    starts: 0,
    start: async () => {
      def.starts++
      await start?.()
    }
  }
  return def
}

async function boot(defs: ConnectorDef[], disabled: ConnectorId[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'desk-autostart-'))
  temps.push(home)
  if (disabled.length) writeFileSync(join(home, 'connectors.json'), JSON.stringify({ disabled }))
  const ctx = { home, deps: { connectors: defs, connectorsPollMs: 60_000 }, onStop: (fn: () => void) => stops.push(fn) } as unknown as ServerContext
  return startConnectors(ctx)
}

test('an enabled installed connector is started once; disabled, absent and running ones are not', async () => {
  const installed = fake('repoyeti', 'installed')
  const off = fake('redesign', 'installed')
  const absent = fake('devwebui', 'absent')
  const running = fake('connections', 'running')
  await boot([installed, off, absent, running], ['redesign'])
  expect([installed.starts, off.starts, absent.starts, running.starts]).toEqual([1, 0, 0, 0])
})

test('turning the switch back on starts an installed connector', async () => {
  const d = fake('repoyeti', 'installed')
  const r = await boot([d], ['repoyeti'])
  expect(d.starts).toBe(0)
  await r.action('repoyeti', 'enable')
  expect(d.starts).toBe(1)
  expect(r.list()[0]?.state).toBe('starting')
})

test('a start that throws shows failed with its reason and startConnectors still resolves', async () => {
  const d = fake('repoyeti', 'installed', async () => {
    throw new Error('app.exe would not launch\nmore')
  })
  const r = await boot([d])
  const end = Date.now() + 3000
  while (r.list()[0]?.state !== 'failed' && Date.now() < end) await new Promise((x) => setTimeout(x, 10))
  expect(r.list()[0]).toMatchObject({ state: 'failed', reason: 'app.exe would not launch' })
})
