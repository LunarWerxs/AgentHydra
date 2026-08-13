// scripts/audit.ts — `bun run audit`. Prove the numbers against the store, or say why not.
//
// Exits non-zero when the reconciliation fails, so this is usable as a gate rather than as a report
// somebody has to remember to read.

import { reconcile } from '../server/src/reconcile'

const started = performance.now()
const result = reconcile()
const seconds = ((performance.now() - started) / 1000).toFixed(1)

const B = (n: number) => `${(n / 1e9).toFixed(2)}B`

console.log(`\nStore audit — ${result.stores.length} store(s), ${seconds}s\n`)
for (const s of result.stores) {
  const accounted = s.sessions + s.siblings
  const excluded = Object.entries(s.excluded)
  console.log(`  ${s.tool}`)
  console.log(
    `    files ${s.filesOnDisk}  =  ${s.sessions} session(s) + ${s.siblings} attached` +
      `${excluded.length ? ` + ${excluded.map(([k, v]) => `${v} ${k}`).join(' + ')}` : ''}` +
      `${s.unaccounted.length ? `  +  ${s.unaccounted.length}+ UNACCOUNTED` : ''}`,
  )
  if (s.tokensIndependent > 0) {
    const drift = s.drift === null ? 'not scanned yet' : `${(s.drift * 100).toFixed(2)}%`
    console.log(
      `    tokens ${B(s.tokensIndependent)} counted independently` +
        `${s.tokensReported === null ? '' : `, ${B(s.tokensReported)} reported — drift ${drift}`}`,
    )
  }
  for (const p of s.unaccounted.slice(0, 3)) console.log(`      unaccounted: ${p}`)
  void accounted
}

if (result.ok) {
  console.log('\n✓ every file accounted for, every total agrees with an independent count\n')
  process.exit(0)
}
console.log('\n✗ reconciliation failed:')
for (const p of result.problems) console.log(`  - ${p}`)
console.log()
process.exit(1)
