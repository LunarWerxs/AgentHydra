// Prefix tax (server/src/prefix-tax.ts) over HTTP: GET lists the homes and the last readings and
// spawns nothing; POST /measure runs the sink against one home (or all) because a person asked.
//
// Readings live in memory only: they describe a loadout that changes whenever an MCP server is
// added, so a reading from a previous daemon run would be a stale number dressed as a fresh one.
// One measurement at a time, because each probe boots a whole MCP roster.
import { app } from '../http-app'
import { measurePrefixTax, type PrefixTaxRow, prefixTaxTargets } from '../prefix-tax'

const readings = new Map<string, PrefixTaxRow>()
let running: string | null = null

app.get('/api/prefix-tax', (c) =>
  c.json({
    running,
    rows: prefixTaxTargets().map((t) => ({ ...t, reading: readings.get(t.ref) ?? null })),
  }),
)

app.post('/api/prefix-tax/measure', async (c) => {
  if (running) return c.json({ error: `already measuring ${running}` }, 409)
  const body = (await c.req.json().catch(() => ({}))) as { ref?: unknown }
  const only = typeof body.ref === 'string' && body.ref ? body.ref : null
  const targets = prefixTaxTargets().filter((t) => !only || t.ref === only)
  if (only && targets.length === 0) return c.json({ error: `no managed home has ref ${only}` }, 404)
  const measured: PrefixTaxRow[] = []
  try {
    for (const target of targets) {
      running = target.ref
      const row = await measurePrefixTax(target)
      readings.set(row.ref, row)
      measured.push(row)
    }
  } finally {
    running = null
  }
  return c.json({ rows: measured })
})
