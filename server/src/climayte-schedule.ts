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
  groupCap,
  isLoginWall,
  pickAccount,
  rankAccounts,
  WIND_DOWN_SESSION_PCT,
  weekStopPct,
} from './climayte-lib'
import {
  type CliMaytePlacement,
  type CostEstimate,
  DEFAULT_TASK_PCT,
  FIT_PCT,
  projectedPct,
  type RunningLoad,
  sizeTask,
  waitsForCooldown,
  waitsForHome,
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

/** The account the session was stopped on at its limit or ceiling (its last attempt ended 'quota'
 *  there, not a handoff), when the task may use it: the session lives there and resumes there warm. */
function quotaHome(w: CliMayteWorker, allowed: CliMayteAccount[]): CliMayteAccount | null {
  const last = w.attempts.at(-1)
  if (!w.sessionId || last?.outcome !== 'quota' || last.account.id !== w.accountId) return null
  return allowed.find((a) => a.id === w.accountId) ?? null
}

/** When the session's own account takes work again: the end of its limit wall, or the 5-hour reset
 *  of one past the stop line. Null when neither is what keeps it out (a login wall, a desktop in
 *  use), or when the reset would still leave it past the weekly stop line. */
function homeFreesAt(home: CliMayteAccount, now: number): number | null {
  const wall = walls[home.id]
  const walled = !!wall && wall.until > now && !isLoginWall(wall.reason)
  if (!walled && (home.sessionPct ?? 0) < WIND_DOWN_SESSION_PCT) return null
  const at = accountFreesAt(home, now)
  if (at === null) return null
  const weekStops =
    (home.weekPct ?? 0) >= weekStopPct(home.weekResetsAt, at) &&
    !(home.weekResetsAt && home.weekResetsAt <= at)
  return weekStops ? null : at
}

/** Its own account frees up soon: wait for it rather than move (waitsForHome). */
function holdForHome(w: CliMayteWorker, home: CliMayteAccount, at: number): void {
  const until = new Date(at).toISOString()
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const why = `Waiting for its own account ${acctLabel(home)} to reset at ${time}: cheaper than moving.`
  if (w.status !== 'waiting' || w.error !== why || w.waitUntil !== until) {
    if (w.status !== 'waiting' || w.error !== why)
      journal(w, 'waiting', { error: firstLine(why), until })
    w.status = 'waiting'
    w.error = why
    w.waitUntil = until
    changed(w)
  }
}

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
  w: Pick<CliMayteWorker, 'accounts' | 'priority'>,
  acct: CliMayteAccount,
  allowed: CliMayteAccount[],
  groupActive: Map<string, number>,
  cap: number | null,
  expected: number,
  atHome: boolean,
): ReturnType<typeof waitsForCooldown> {
  return waitsForCooldown(
    acct,
    // Only an account that takes the task once it refills: nobody else's, with weekly room and a
    // free slot. When each refills: the end of its limit wall, else its 5-hour reset
    // (accountFreesAt).
    allowed
      .filter(
        (a) =>
          !isLoginWall(walls[a.id]?.reason) &&
          (!accountInUse(a) || !!w.accounts?.includes(a.id)) &&
          (a.weekPct ?? 0) < weekStopPct(a.weekResetsAt, s.now) &&
          (groupActive.get(a.id) ?? 0) < groupCap(a, cap, s.now),
      )
      .map((a) => ({
        ...a,
        sessionResetsAt: accountFreesAt(a, s.now),
        running: s.running.get(a.id) ?? [],
        finishedSince: s.finishedSince.get(a.id) ?? 0,
        walled: (walls[a.id]?.until ?? 0) > s.now,
      })),
    expected,
    s.now,
    { home: atHome, priority: w.priority ?? 0 },
  )
}

/** Why a task does not start on `acct` now: no room for it there (`cooldown` null, waitsForRoom),
 *  or a reset worth waiting for (`cooldown`, when; waitsForCooldown). */
interface Refusal {
  acct: CliMayteAccount
  cooldown: number | null
}

function refusalOn(
  s: TickState,
  w: Pick<CliMayteWorker, 'accounts' | 'priority'>,
  acct: CliMayteAccount,
  allowed: CliMayteAccount[],
  groupActive: Map<string, number>,
  cap: number | null,
  placement: CliMaytePlacement,
  atHome: boolean,
): Refusal | null {
  const factors = allowed.map((a) => a.planFactor ?? 1)
  if (waitsForRoom(acct, placement, factors, atHome)) return { acct, cooldown: null }
  const { expected } = placement
  const cooldown = cooldownFor(s, w, acct, allowed, groupActive, cap, expected, atHome)
  return cooldown ? { acct, cooldown } : null
}

/** The accounts a new task of ordinary size (DEFAULT_TASK_PCT, a new group, any account) would
 *  start on right now, by the path scheduleWorker takes: what climayteCapacity tells a chat is
 *  room. 2026-10-02 04:58: the hint counted every account with no worker under the stop lines and
 *  said 9 sat idle while placement held 24 tasks. */
export function roomNow(s: TickState): CliMayteAccount[] {
  const { accounts, active, now, running, finishedSince } = s
  const probe = { accounts: null, accountId: null, attempts: [], priority: 0 }
  const placement = { expected: DEFAULT_TASK_PCT, running, finishedSince }
  const none = new Map<string, number>()
  const ranked = rankAccounts(probe, accounts, walls, active, null, now, none, false, placement)
  return ranked.filter((a) => !refusalOn(s, probe, a, accounts, none, null, placement, false))
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

/** One due task: start it on the best account that takes it now, or say what it waits for. An
 *  account that refuses it (no room, or a reset worth waiting for) passes it to the next: it waits
 *  only when every account refuses, for what the best one named and until the earliest reset.
 *  2026-10-02 05:09: held on #90 (ahead of its pace) alone, 8 tasks waited while #95 and #94 had no
 *  worker; two then started on #95 at the same 43%. */
export function scheduleWorker(s: TickState, w: CliMayteWorker): void {
  const { now, accounts } = s
  // No cap from the dispatcher: the default, which counts Pro windows (groupCap).
  const cap = perAccount[w.group] ?? null
  const groupActive = groupCounts(s.byGroup, w.group)
  const cost = s.costOf(w)
  const expected = cost.pct
  const placement = { expected, running: s.running, finishedSince: s.finishedSince }
  let ranked = rankAccounts(
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
  // A session stopped at its own account's limit or ceiling resumes there rather than move:
  // rankAccounts puts that account last, so it goes back the moment it takes work again, and waits
  // for it when it frees up soon (waitsForHome).
  const home = quotaHome(w, allowed)
  if (ranked.length && home && ranked[0]?.id !== home.id) {
    if (pickAccount(w, [home], walls, s.active, cap, now, groupActive)) ranked = [home]
    else {
      const back = waitsForHome(homeFreesAt(home, now), now, w.priority ?? 0)
      if (back) {
        holdForHome(w, home, back)
        return
      }
    }
  }
  const refused: Refusal[] = []
  for (const acct of ranked) {
    const atHome = staysHome(w, acct) || acct.id === home?.id
    const no = refusalOn(s, w, acct, allowed, groupActive, cap, placement, atHome)
    if (!no) {
      startOn(s, w, acct, cost, groupActive)
      return
    }
    refused.push(no)
  }
  const first = refused[0]
  if (!first) {
    holdForAccount(s, w, allowed)
    return
  }
  if (first.cooldown === null) {
    holdForRoom(s, w, first.acct, cost, allowed)
    return
  }
  const resets = refused.flatMap((r) => r.cooldown ?? [])
  holdForReset(w, first.acct, Math.min(...resets), now)
}
