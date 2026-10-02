// CliMayte's scheduling pass (climayte.ts tick): for each due task, pick an account and start it
// there, or say what it waits for (room, a reset, an account). Split out of climayte.ts so each
// file can be read whole; the state it works on (workers, walls, journal) is climayte-core.ts's.
import {
  accountsProvider,
  acctLabel,
  basisText,
  changed,
  journal,
  overageAllowed,
  perAccount,
  placementState,
  walls,
  workers,
} from './climayte-core'
import { firstLine } from './climayte-journal'
import { launch } from './climayte-launch'
import {
  accountInUse,
  type CliMayteAccount,
  type CliMayteWorker,
  isLoginWall,
  pickAccount,
  WIND_DOWN_SESSION_PCT,
  WIND_DOWN_WEEK_PCT,
} from './climayte-lib'
import {
  type CostEstimate,
  FIT_PCT,
  projectedPct,
  type RunningLoad,
  sizeTask,
  waitsForCooldown,
  waitsForRoom,
  weekPacePct,
} from './climayte-placement'

/** One tick's view of the fleet: built once, and kept current as the tick starts work. */
interface TickState {
  now: number
  accounts: CliMayteAccount[]
  allowFull: boolean
  /** Running workers per account, every group. */
  active: Map<string, number>
  /** Each group's running workers per account: `perAccount` caps a group, not the fleet. */
  byGroup: Map<string, Map<string, number>>
  costOf: ReturnType<typeof placementState>['costOf']
  running: Map<string, RunningLoad[]>
  finishedSince: Map<string, number>
}

export function tickAccounts(): CliMayteAccount[] {
  try {
    return accountsProvider()
  } catch (err) {
    console.error('[climayte] could not list accounts:', err)
    return []
  }
}

const bumpCount = (m: Map<string, number>, id: string): void => {
  m.set(id, (m.get(id) ?? 0) + 1)
}

function groupCounts(byGroup: Map<string, Map<string, number>>, g: string): Map<string, number> {
  let m = byGroup.get(g)
  if (!m) {
    m = new Map()
    byGroup.set(g, m)
  }
  return m
}

export function tickState(accounts: CliMayteAccount[], now: number): TickState {
  const allowFull = overageAllowed()
  const active = new Map<string, number>()
  const byGroup = new Map<string, Map<string, number>>()
  for (const w of workers.values())
    if (w.status === 'running' && w.accountId) {
      bumpCount(active, w.accountId)
      bumpCount(groupCounts(byGroup, w.group), w.accountId)
    }
  const { costOf, running, finishedSince } = placementState()
  return { now, accounts, allowFull, active, byGroup, costOf, running, finishedSince }
}

/** When an account can next take work: the end of its usage wall, else its 5-hour reset. A login
 *  wall's `until` is only its next recheck, not a time the account frees up. */
function accountFreesAt(a: CliMayteAccount, now: number): number | null {
  const wall = walls[a.id]
  if (wall && wall.until > now) return isLoginWall(wall.reason) ? null : wall.until
  return a.sessionResetsAt ?? null
}

function firstFreeAt(pool: CliMayteAccount[], now: number): string | null {
  const at = pool
    .map((a) => accountFreesAt(a, now))
    .filter((t): t is number => t !== null && t > now)
    .sort((a, b) => a - b)[0]
  return at === undefined ? null : new Date(at).toISOString()
}

/** The picked account is the session's own, and its last attempt did not end in a way that sends
 *  the session elsewhere anyway. */
const staysHome = (w: CliMayteWorker, acct: CliMayteAccount): boolean =>
  acct.id === w.accountId &&
  !['handoff', 'quota', 'auth'].includes(w.attempts.at(-1)?.outcome ?? 'handoff')

/** The best account has too little room for what this task is expected to use: it waits for room. */
function holdForRoom(
  s: TickState,
  w: CliMayteWorker,
  acct: CliMayteAccount,
  cost: CostEstimate,
  allowed: CliMayteAccount[],
): void {
  const expected = cost.pct
  const factor = acct.planFactor ?? 1
  const room = Math.max(
    0,
    (FIT_PCT -
      projectedPct(acct, s.running.get(acct.id) ?? [], 0, s.finishedSince.get(acct.id) ?? 0)) *
      factor,
  )
  const head = `Waiting for room: this task is expected to use about ${Math.round(expected)}% of a Pro 5-hour window`
  const why = `${head}, and the best account now (${acctLabel(acct)}) has about ${Math.round(room)}% left. It starts the moment one has room (a reset, or the work there finishing); smaller tasks go meanwhile.`
  // Room for certain at the first reset of an account whose fresh window holds it (the work
  // running there may finish sooner).
  const until = firstFreeAt(
    allowed.filter((a) => expected / (a.planFactor ?? 1) <= FIT_PCT),
    s.now,
  )
  if (w.waitUntil !== until && w.status === 'waiting') {
    w.waitUntil = until
    changed(w)
  }
  // Said again only when the estimate changes: the room left moves every tick, and each new
  // figure would be a journal line.
  if (w.status !== 'waiting' || !w.error?.startsWith(head)) {
    w.waitUntil = until
    w.status = 'waiting'
    w.error = why
    w.size = {
      expected: Math.round(expected * 10) / 10,
      basis: basisText(cost, w),
      window: sizeTask(
        expected,
        allowed.map((a) => a.planFactor ?? 1),
      ).window,
      room: Math.round(room),
      roomOn: acctLabel(acct),
    }
    journal(w, 'waiting', { error: firstLine(why), until: until ?? undefined })
    changed(w)
  }
}

/** Ahead of its weekly pace while another account refills soon: wait for that one
 *  (waitsForCooldown, owner 2026-10-01: not everything into the 5x because the Pros are low).
 *  When to start instead, or nothing when the task need not wait. */
function cooldownFor(
  s: TickState,
  w: CliMayteWorker,
  acct: CliMayteAccount,
  allowed: CliMayteAccount[],
  groupActive: Map<string, number>,
  cap: number,
  expected: number,
): ReturnType<typeof waitsForCooldown> {
  return waitsForCooldown(
    acct,
    // When each refills: the end of its limit wall, else its 5-hour reset (accountFreesAt).
    allowed
      .filter(
        (a) =>
          !isLoginWall(walls[a.id]?.reason) &&
          (a.weekPct ?? 0) < WIND_DOWN_WEEK_PCT &&
          (groupActive.get(a.id) ?? 0) < cap,
      )
      .map((a) => ({ ...a, sessionResetsAt: accountFreesAt(a, s.now) })),
    expected,
    s.now,
    { home: staysHome(w, acct), priority: w.priority ?? 0 },
  )
}

function holdForReset(
  w: CliMayteWorker,
  acct: CliMayteAccount,
  cooldown: number,
  now: number,
): void {
  const until = new Date(cooldown).toISOString()
  const head = `Waiting for a reset: ${acctLabel(acct)} has used ${Math.round(acct.weekPct ?? 0)}% of its week with ${Math.round(weekPacePct(acct, now) ?? 0)}% of the week gone`
  const why = `${head}, and an account this task fits refills its 5-hour window at ${new Date(cooldown).toLocaleTimeString()}. It starts then (or sooner, where room opens); other tasks keep going meanwhile, and priority work never waits.`
  if (w.status !== 'waiting' || !w.error?.startsWith(head) || w.waitUntil !== until) {
    if (w.status !== 'waiting' || !w.error?.startsWith(head))
      journal(w, 'waiting', { error: firstLine(why), until })
    w.status = 'waiting'
    w.error = why
    w.waitUntil = until
    changed(w)
  }
}

/** A throw after the spawn leaves a live attempt. One before it (a file lock on the
 *  transcript copy or the prompt file) is usually passing: retry it, three times per turn. */
function retryLaunch(w: CliMayteWorker, acct: CliMayteAccount, err: unknown): void {
  if (w.status === 'running' || w.status === 'failed') return
  const msg = err instanceof Error ? err.message : String(err)
  if (w.retries < 3) {
    w.status = 'queued'
    w.notBefore = Date.now() + 10_000
    w.retries++
    w.error = `Could not start the next attempt (will retry): ${msg}`
    journal(w, 'retry', {
      account: acctLabel(acct),
      retry: w.retries,
      waitS: 10,
      notice: firstLine(`Could not start the next attempt: ${msg}`),
    })
  } else {
    w.status = 'failed'
    w.error = `Could not start the next attempt: ${msg}`
    journal(w, 'failed', { account: acctLabel(acct), error: firstLine(w.error) })
  }
  changed(w)
}

/** Start the task on the picked account, and count it there for the rest of this tick. */
function startOn(
  s: TickState,
  w: CliMayteWorker,
  acct: CliMayteAccount,
  cost: CostEstimate,
  groupActive: Map<string, number>,
): void {
  const expected = cost.pct
  // The row's size says what this start was placed on, not the estimate at dispatch.
  if (w.size)
    w.size = {
      ...w.size,
      expected: Math.round(expected * 10) / 10,
      basis: basisText(cost, w),
    }
  try {
    launch(w, acct, s.accounts, s.active.get(acct.id) ?? 0)
  } catch (err) {
    console.error(`[climayte] could not launch ${w.id}:`, err)
    retryLaunch(w, acct, err)
  }
  if (w.status === 'running') {
    bumpCount(s.active, acct.id)
    bumpCount(groupActive, acct.id)
    s.running.set(acct.id, [
      ...(s.running.get(acct.id) ?? []),
      { expected, startPct: acct.sessionPct },
    ])
  }
}

/** Why no account can take the task now, in the words the task's row shows. */
function noAccountReason(
  s: TickState,
  w: CliMayteWorker,
  allowed: CliMayteAccount[],
  until: string | null,
): string {
  const { now, accounts } = s
  const soonest = until ? Date.parse(until) : undefined
  const allSignedOut =
    allowed.length > 0 &&
    allowed.every((a) => isLoginWall(walls[a.id]?.reason) && walls[a.id]!.until > now)
  if (!accounts.length) return 'No signed-in CLI account. Add one: CLI instances, Quick add.'
  if (w.accounts && !allowed.length)
    return 'None of the accounts this task may use is signed in. Sign one in: CLI instances, Quick add (type its email).'
  if (allSignedOut)
    return 'Every CLI account is signed out. Sign one in again: CLI instances, Quick add (type its email).'
  const inUse = allowed
    .filter(accountInUse)
    .map(
      (a) =>
        `${acctLabel(a)} (${a.handsOnAgoMs != null ? 'its desktop app is in use' : 'other sessions running'})`,
    )
  if (inUse.length)
    return `Waiting for an account nobody else is using: ${inUse.join(', ')}; the others are at their limit or signed out. It starts when one frees up.`
  return `Every eligible account is at its usage limit, past the ${WIND_DOWN_SESSION_PCT}% stop line, or signed out${soonest ? `; the first frees up at ${new Date(soonest).toLocaleString()}` : ''}.`
}

/** Busy (every eligible account at its worker cap) stays queued; nothing eligible at all
 *  waits. */
function holdForAccount(s: TickState, w: CliMayteWorker, allowed: CliMayteAccount[]): void {
  const { now, accounts } = s
  const idle = new Map<string, number>()
  if (pickAccount(w, accounts, walls, idle, Number.MAX_SAFE_INTEGER, now, idle, s.allowFull)) {
    if (w.status === 'waiting') {
      w.status = 'queued'
      w.error = null
      changed(w)
    }
    return
  }
  const until = firstFreeAt(allowed, now)
  const why = noAccountReason(s, w, allowed, until)
  if (w.status !== 'waiting' || w.error !== why || w.waitUntil !== until) {
    if (w.status !== 'waiting' || w.error !== why)
      journal(w, 'waiting', { error: firstLine(why), until: until ?? undefined })
    w.status = 'waiting'
    w.error = why
    w.waitUntil = until
    changed(w)
  }
}

/** One due task: start it on the best account, or say what it waits for. */
export function scheduleWorker(s: TickState, w: CliMayteWorker): void {
  const { now, accounts } = s
  const cap = perAccount[w.group] ?? 2
  const groupActive = groupCounts(s.byGroup, w.group)
  const cost = s.costOf(w)
  const expected = cost.pct
  const placement = { expected, running: s.running, finishedSince: s.finishedSince }
  const acct = pickAccount(
    w,
    accounts,
    walls,
    s.active,
    cap,
    now,
    groupActive,
    s.allowFull,
    placement,
  )
  const allowed = accounts.filter((a) => !w.accounts || w.accounts.includes(a.id))
  if (
    acct &&
    waitsForRoom(
      acct,
      placement,
      allowed.map((a) => a.planFactor ?? 1),
      staysHome(w, acct),
    )
  ) {
    holdForRoom(s, w, acct, cost, allowed)
    return
  }
  const cooldown = acct && cooldownFor(s, w, acct, allowed, groupActive, cap, expected)
  if (acct && cooldown) {
    holdForReset(w, acct, cooldown, now)
    return
  }
  if (acct) {
    startOn(s, w, acct, cost, groupActive)
    return
  }
  holdForAccount(s, w, allowed)
}
