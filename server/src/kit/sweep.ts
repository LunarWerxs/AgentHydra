// The analytics toolkit's sweep, owned by the daemon (docs/ANALYTICS-PLAN.md §4.6): on boot, then a minute
// after each sweep ends, read Claude transcripts, the foreign stores and the HSwarm ledger into
// analytics.db, one after another. Waiting for the end of a sweep before timing the next means two
// never run at once, and the first (which reads tens of GB, ingest-claude.ts) simply takes as long as it
// takes. One source failing is logged and the others still run.
import {
  type ClaudeIngestSummary,
  climayteAttemptRuns,
  discoverClaudeRoots,
  ingestClaude,
} from './ingest-claude'
import { discoverForeignSources, ingestForeign } from './ingest-foreign'
import { hswarmLedgerPath, ingestHswarm } from './ingest-hswarm'
import { ingestLegacy } from './ingest-legacy'
import { machineId } from './machine'
import { sharedKitStore } from './query'
import type { KitStore } from './store'

export { machineId }

const EVERY_MS = 60_000
/**
 * Every this-many-th sweep lists every folder and stats every transcript; the sweeps between list only the
 * folders whose mtime moved and stat only the transcripts written within the last hour.
 */
const FULL_PASS_EVERY = 10

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
  try {
    await store.ensureIndexes()
  } catch (err) {
    parts.push(`indexes FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
  // Rows written before schema 4 get their unbilled_usd / cost_usd (sliced; a no-op once done).
  await guarded('backfill', async () => {
    await store.backfillAsync()
    return 'backfill ok'
  })
  await guarded('claude', async () => {
    const s: ClaudeIngestSummary = await ingestClaude(store, await discoverClaudeRoots(), {
      pc,
      attempts: await climayteAttemptRuns(),
      fullPass: sweepNo % FULL_PASS_EVERY === 1,
    })
    await store.rollupAsync() // what this source touched, so the next one starts with a current rollup
    return `claude files=${s.files} unchanged=${s.unchanged} bytes=${s.bytes} events=${s.events} old=${s.hourly}`
  })
  await guarded('foreign', async () => {
    const s = await ingestForeign(store, { ...discoverForeignSources(), hswarm: [] }, { pc })
    await store.rollupAsync()
    return `foreign files=${s.files} events=${Object.values(s.events).reduce((a, b) => a + b, 0)}`
  })
  await guarded('hswarm', async () => {
    const n = (await ingestHswarm(store, hswarmLedgerPath(), { pc })) ?? 0
    await store.rollupAsync()
    return `hswarm events=${n}`
  })
  await guarded('maintenance', async () => {
    const m = await store.runMaintenanceAsync()
    return `rolled=${m.rolledUp} pruned=${m.pruned}`
  })
  // Once, after the first full ingest and the prune: the history session_stats holds and the kit cannot see.
  await guarded('legacy', async () => {
    if (parts.some((p) => p.startsWith('claude FAILED')))
      return 'legacy waits for a clean claude ingest'
    const s = await ingestLegacy(store, (await import('../db')).db, { pc })
    return s.skipped ? 'legacy done' : `legacy sessions=${s.sessions} written=${s.written}`
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
