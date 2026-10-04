// What the real AgentHydra daemon (HYDRA_URL, default http://127.0.0.1:7787) returns through the
// bridge's mappings. Counts only: no emails, tokens, prompts, titles or paths. Read-only (GETs).
//
//   bun server/scripts/bridge-live.ts

import { createBridge } from '../src/bridge'

const b = createBridge()
function count<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1
  return out
}

const up = await b.ping()
console.log(`AgentHydra at ${b.url}: ${up ? 'up' : 'DOWN'}`)

const accounts = await b.listAccounts()
const instances = accounts.filter((a) => a.id !== 'default')
console.log(
  `accounts: ${accounts.length} (default + ${instances.length} CLI instances); signed in ${instances.filter((a) => a.signedIn).length}, ` +
    `in use ${instances.filter((a) => a.inUse).length}, with usage ${instances.filter((a) => a.fiveHourPct !== null && a.weeklyPct !== null).length}, ` +
    `either window >= 85% ${instances.filter((a) => (a.fiveHourPct ?? 0) >= 85 || (a.weeklyPct ?? 0) >= 85).length}`,
)
const pick = await b.pickAccount()
console.log(`pickAccount: ${pick.id === 'default' ? 'the default login' : `CLI instance #${pick.number}`}`)

const sessions = await b.externalSessions()
console.log(`external sessions: ${sessions.length}; by source ${JSON.stringify(count(sessions, (s) => s.source))}; by status ${JSON.stringify(count(sessions, (s) => s.status))}`)

const workers = await b.workers()
const active = workers.filter((w) => w.active)
console.log(
  `CliMayte workers: ${workers.length} (${active.length} active, ${workers.length - active.length} recently finished); ` +
    `by status ${JSON.stringify(count(workers, (w) => w.status))}; with an origin chat ${workers.filter((w) => w.originSessionId).length}; ` +
    `distinct origin chats of active ones ${new Set(active.map((w) => w.originSessionId).filter(Boolean)).size}`,
)

const first = sessions.find((s) => s.source !== 'climayte') ?? sessions[0]
if (first) {
  try {
    const items = await b.externalItems(first.id)
    console.log(`transcript of one ${first.source} session: ${items.length} items; by kind ${JSON.stringify(count(items, (i) => i.kind))}`)
  } catch (err) {
    console.log(`transcript of one ${first.source} session: failed (${(err as Error).name})`)
  }
}
const worker = active.find((w) => w.sessionId)
if (worker?.sessionId) {
  try {
    const items = await b.externalItems(worker.sessionId)
    console.log(`transcript of one active worker: ${items.length} items; by kind ${JSON.stringify(count(items, (i) => i.kind))}`)
  } catch (err) {
    console.log(`transcript of one active worker: failed (${(err as Error).name})`)
  }
}
