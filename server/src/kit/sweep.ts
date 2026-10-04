// The analytics toolkit's sweep, owned by the daemon (docs/ANALYTICS-PLAN.md §4.6): on boot, then a minute
// after each sweep ends, read Claude transcripts, the foreign stores and the HSwarm ledger into
// analytics.db, one after another. Waiting for the end of a sweep before timing the next means two
// never run at once, and the first (which reads tens of GB, ingest-claude.ts) simply takes as long as it
// takes. One source failing is logged and the others still run.
import { hostname } from 'node:os'
import {
  type ClaudeIngestSummary,
  climayteSessionIds,
  discoverClaudeRoots,
  ingestClaude,
} from './ingest-claude'
import { discoverForeignSources, ingestForeign } from './ingest-foreign'
import { hswarmLedgerPath, ingestHswarm } from './ingest-hswarm'
import { sharedKitStore } from './query'
import type { KitStore } from './store'

const EVERY_MS = 60_000
/** Every this-many-th sweep stats every transcript; the sweeps between skip those quiet for an hour. */
const FULL_PASS_EVERY = 5

/** This machine's id, the way HSwarm names it (hswarm/vault.py machine_name). */
export function machineId(): string {
  return (
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/, '') || 'machine'
  )
}

let sweeping: Promise<string> | null = null
let sweepNo = 0

async function sweepOnce(store: KitStore): Promise<string> {
  const t0 = performance.now()
  const pc = machineId()
  sweepNo++
  const parts: string[] = []
  const guarded = async (name: string, fn: () => Promise<string> | string) => {
    try {
      parts.push(await fn())
    } catch (err) {
      parts.push(`${name} FAILED: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await guarded('claude', async () => {
    const s: ClaudeIngestSummary = await ingestClaude(store, await discoverClaudeRoots(), {
      pc,
      climayte: await climayteSessionIds(),
      fullPass: sweepNo % FULL_PASS_EVERY === 1,
    })
    return `claude files=${s.files} unchanged=${s.unchanged} bytes=${s.bytes} events=${s.events} old=${s.hourly}`
  })
  await guarded('foreign', async () => {
    const s = await ingestForeign(store, { ...discoverForeignSources(), hswarm: [] }, { pc })
    return `foreign files=${s.files} events=${Object.values(s.events).reduce((a, b) => a + b, 0)}`
  })
  await guarded(
    'hswarm',
    () => `hswarm events=${ingestHswarm(store, hswarmLedgerPath(), { pc }) ?? 0}`,
  )
  await guarded('maintenance', () => {
    const m = store.runMaintenance()
    return `rolled=${m.rolledUp} pruned=${m.pruned}`
  })
  return `[kit] sweep ${parts.join(' | ')} ms=${Math.round(performance.now() - t0)}`
}

/** One sweep now. A second caller while one runs joins it. */
export function runKitSweep(store: KitStore = sharedKitStore()): Promise<string> {
  sweeping ??= sweepOnce(store)
    .then((line) => {
      console.log(line)
      return line
    })
    .finally(() => {
      sweeping = null
    })
  return sweeping
}

/** Boot hook: sweep now, then a minute after each sweep ends. Returns a stop function. */
export function startKitSweep(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const loop = async () => {
    try {
      await runKitSweep()
    } catch (err) {
      console.log(`[kit] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!stopped) timer = setTimeout(() => void loop(), EVERY_MS)
  }
  void loop()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
