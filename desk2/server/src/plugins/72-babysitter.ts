// The babysitter (shared/babysitter.ts says what it is for). GET /api/babysitter answers what its last look saw
// (?fresh=1 looks first); POST /api/babysitter { enabled?, check? } turns it on or off (Settings' `babysitter`, on by
// default) and/or looks now. While on, it looks every BABYSITTER_EVERY_MS and again as soon as a reset it knows of
// passes. A look reads Desk's chats, the outside sessions, the accounts and the send queue through Desk's own routes
// (as the orchestrator does), decides (babysitter/decide.ts) and continues each chat that fell due: a Desk chat
// through the send queue, a Claude Desktop chat through POST /api/external/sessions/:id/message, which AgentHydra
// delivers over the chat's own input channel, never by typing into its window. A list that did not load is neither
// judged nor acted on. Its memory (each chat's count, the last acts) is <home>/babysitter.json, so a restart neither
// forgets a count nor sends a continue twice. No model is asked: a look costs a few local reads.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type { AccountInfo, ChatSummary, ExternalSession, QueueState } from '@shared/protocol'
import {
  BABYSITTER_EVERY_MS,
  type BabysitterAccount,
  type BabysitterAct,
  type BabysitterChat,
  type BabysitterRequest,
  type BabysitterStatus,
} from '@shared/babysitter'
import type { ServerContext } from '../context'
import { carried, decide, type Memory, shown, type Tracked } from '../babysitter/decide'
import { writeFlushed } from '../write-flushed'

/** Acts kept for the page. */
const ACTS_KEPT = 50
/** The first look after a start waits for the bridge's first read of AgentHydra. */
const FIRST_LOOK_MS = 60_000
/** A look set for a reset runs this long after the moment decide named. */
const DUE_SLACK_MS = 5_000

interface Saved {
  memory: Memory
  acts: BabysitterAct[]
}

/** <home>/babysitter.json, or an empty memory when it is missing or damaged (nothing is sent on a guess either way:
 *  a forgotten continue only means a chat counts from zero). */
function load(file: string): Saved {
  try {
    if (!existsSync(file)) return { memory: {}, acts: [] }
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
    const memory = v.memory && typeof v.memory === 'object' && !Array.isArray(v.memory) ? v.memory : {}
    return { memory, acts: Array.isArray(v.acts) ? v.acts.slice(0, ACTS_KEPT) : [] }
  } catch (err) {
    console.error('[babysitter] babysitter.json did not load; starting with no memory:', err)
    return { memory: {}, acts: [] }
  }
}

/** The stopped chats by account, soonest reset first. */
export function byAccount(chats: readonly BabysitterChat[]): BabysitterAccount[] {
  const out = new Map<string, BabysitterAccount>()
  for (const c of chats) {
    const a = out.get(c.account) ?? { account: c.account, stopped: 0, resetsAt: null, firstStoppedAt: c.stoppedAt }
    a.stopped++
    if (c.resetsAt !== null) a.resetsAt = a.resetsAt === null ? c.resetsAt : Math.min(a.resetsAt, c.resetsAt)
    a.firstStoppedAt = Math.min(a.firstStoppedAt, c.stoppedAt)
    out.set(c.account, a)
  }
  return [...out.values()].sort((x, y) => (x.resetsAt ?? Number.POSITIVE_INFINITY) - (y.resetsAt ?? Number.POSITIVE_INFINITY) || x.firstStoppedAt - y.firstStoppedAt)
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const file = join(ctx.home, 'babysitter.json')
  let saved = load(file)
  let checkedAt: number | null = null
  let nextCheckAt: number | null = null
  let lastError: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let looking: Promise<void> | null = null
  let stopping = false

  const enabled = (): boolean => ctx.settings().babysitter && !stopping

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await app.request(path)
      return res.ok ? ((await res.json()) as T) : null
    } catch {
      return null
    }
  }

  /** The route's status and, when it refused, why. */
  async function post(path: string, body: unknown): Promise<{ status: number; error: string | null }> {
    try {
      const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (res.ok) return { status: res.status, error: null }
      const answer = (await res.json().catch(() => null)) as { error?: unknown } | null
      return { status: res.status, error: typeof answer?.error === 'string' ? answer.error : `${path} answered ${res.status}` }
    } catch (err) {
      return { status: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  function save(): void {
    try {
      writeFlushed(file, JSON.stringify(saved))
    } catch (err) {
      console.error('[babysitter] babysitter.json was not written:', err)
    }
  }

  /** The next look: in BABYSITTER_EVERY_MS, or sooner when a reset falls due first. It looks while off too, sending
   *  nothing, so the page stays current and a switch turned on anywhere (Settings saves it) is acted on. */
  function schedule(dueAt: number | null, now = Date.now()): void {
    clearTimeout(timer)
    timer = undefined
    nextCheckAt = null
    if (stopping) return
    const at = Math.min(now + BABYSITTER_EVERY_MS, dueAt === null ? Number.POSITIVE_INFINITY : Math.max(now, dueAt + DUE_SLACK_MS))
    nextCheckAt = at
    timer = setTimeout(() => void look(), at - now)
    // A look never keeps the process alive: Desk stopping stops it.
    ;(timer as { unref?: () => void }).unref?.()
  }

  function act(t: Tracked, id: string, did: BabysitterAct['did'], detail: string): void {
    saved.acts.unshift({ at: Date.now(), id, title: t.title, account: t.account, source: t.source, did, detail })
    saved.acts.splice(ACTS_KEPT)
  }

  /** One look; never two at once. While off it only reads and judges, so the page still shows what waits. */
  function look(): Promise<void> {
    looking ??= (async () => {
      let nextDueAt: number | null = null
      try {
        const now = Date.now()
        const [own, outside, accounts, queue] = await Promise.all([
          get<ChatSummary[]>('/api/chats'),
          get<ExternalSession[]>('/api/external/sessions'),
          get<AccountInfo[]>('/api/accounts'),
          get<QueueState>('/api/queue'),
        ])
        // Without the send queue a message already waiting for a Desk chat is unknown: Desk's chats are then not judged.
        const ownRead = queue ? own : null
        const queued = new Set((queue?.items ?? []).flatMap((i) => (i.kind === 'message' && i.state !== 'failed' ? [i.chatId] : [])))
        const missing = [ownRead === null ? "Desk's chats" : null, outside === null ? "AgentHydra's sessions" : null].filter((m): m is string => m !== null)
        lastError = missing.length ? `${missing.join(' and ')} did not load; the chats they hold were left as they were` : null
        const d = decide({ own: ownRead, outside, accounts, queued, now }, saved.memory)
        nextDueAt = d.nextDueAt
        const before = saved.memory
        saved.memory = d.memory
        for (const a of d.acts) {
          const t = saved.memory[a.id]
          if (!t) continue
          // Off (or switched off part-way through): it waits, as if the look had not reached it.
          if (!enabled()) {
            saved.memory[a.id] = { ...t, gaveUpOn: before[a.id]?.gaveUpOn ?? null, state: 'waiting', reason: 'its limit has reset; the babysitter is off, so it waits' }
            continue
          }
          if (a.kind === 'give-up') {
            act(t, a.id, 'gave-up', t.reason)
            continue
          }
          const r =
            t.source === 'desk'
              ? await post('/api/queue', { kind: 'message', chatId: a.id, text: a.text })
              : await post(`/api/external/sessions/${encodeURIComponent(a.id)}/message`, { text: a.text })
          // An outside chat AgentHydra cannot reach (no live engine, its app closed, not a Desktop chat, AgentHydra
          // itself not answering) is no try: it is continued once something runs it again.
          const outcome = r.error === null ? 'ok' : t.source !== 'desk' && [404, 409, 503].includes(r.status) ? 'no-engine' : 'failed'
          saved.memory[a.id] = carried(t, outcome, r.error ?? '', Date.now())
          // A chat still unreachable is noted once, not on every look.
          if (outcome === 'no-engine' && before[a.id]?.state === 'no-engine') continue
          act(t, a.id, outcome === 'ok' ? 'resumed' : outcome, r.error ?? (t.source === 'desk' ? 'queued in its send queue' : 'delivered into the chat'))
        }
        checkedAt = now
        save()
      } catch (err) {
        lastError = `the last look failed: ${err instanceof Error ? err.message : String(err)}`
        console.error('[babysitter] look failed:', err)
      } finally {
        schedule(nextDueAt)
      }
    })().finally(() => (looking = null))
    return looking
  }

  function status(): BabysitterStatus {
    const stopped = shown(saved.memory)
    return {
      enabled: enabled(),
      everyMs: BABYSITTER_EVERY_MS,
      checkedAt,
      nextCheckAt,
      stopped,
      accounts: byAccount(stopped),
      acts: [...saved.acts],
      error: lastError,
    }
  }

  ctx.onStop(() => {
    stopping = true
    clearTimeout(timer)
    timer = undefined
  })

  // The first look waits for the bridge's first read of AgentHydra.
  nextCheckAt = Date.now() + FIRST_LOOK_MS
  timer = setTimeout(() => void look(), FIRST_LOOK_MS)
  ;(timer as { unref?: () => void }).unref?.()

  app.get('/api/babysitter', async (c) => {
    if (checkedAt === null || c.req.query('fresh') === '1') await look()
    return c.json(status())
  })

  app.post('/api/babysitter', async (c) => {
    const body = (await c.req.json().catch(() => null)) as BabysitterRequest | null
    if (!body || (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.check !== undefined && typeof body.check !== 'boolean'))
      return c.json({ error: 'the body must be JSON: { "enabled"?: true | false, "check"?: true }' }, 400)
    if (body.enabled !== undefined && body.enabled !== ctx.settings().babysitter) ctx.updateSettings({ babysitter: body.enabled })
    if (body.check || body.enabled === true) await look()
    return c.json(status())
  })
}
