// CliMayte's scheduling pass (climayte.ts tick): for each due task, pick an account and start it
// there, or say what it waits for (room, a reset, an account). Split out of climayte.ts so each
// file can be read whole; the state it works on (workers, walls, journal) is climayte-core.ts's.
import {
  accountsProvider,
  acctLabel,
  basisText,
  changed,
  journal,
  memoryReader,
  overageAllowed,
  perAccount,
  perAccountStrict,
  placementState,
  walls,
  wantReading,
  workers,
} from './climayte-core'
import { firstLine } from './climayte-journal'
import { launch } from './climayte-launch'
import {
  accountInUse,
  type CliMayteAccount,
  type CliMayteWorker,
  dueOrder,
  groupCap,
  isLoginWall,
  launchRank,
  maxPerAccount,
  pickAccount,
  rankAccounts,
  readingPending,
  WIND_DOWN_SESSION_PCT,
  weekStopPct,
} from './climayte-lib'
import { type MachineMemory, memoryShort, RAMP_MS } from './climayte-memory'
import { takeLaunchSlot } from './climayte-pacing'
import {
  type CliMaytePlacement,
  type CostEstimate,
  DEFAULT_TASK_PCT,
  FIT_PCT,
  fallsShort,
  MIN_START_ROOM_PCT,
  projectedPct,
  RESUME_WAIT_MS,
  type RunningLoad,
  sizeTask,
  waitsForCooldown,
  waitsForHome,
  waitsForRoom,
  weekPacePct,
} from './climayte-placement'
import { remoteActiveCounts } from './climayte-remote'

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
  /** The machine's free memory at the start of the tick (null: not read, nothing waits for it). */
  memory: MachineMemory | null
  /** Workers started within RAMP_MS, this tick's starts included: not yet in `memory`. */
  growing: number
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
  let growing = 0
  for (const w of workers.values())
    if (w.status === 'running' && w.accountId) {
      bumpCount(active, w.accountId)
      bumpCount(groupCounts(byGroup, w.group), w.accountId)
      if ((w.attempts.at(-1)?.startedAt ?? 0) > now - RAMP_MS) growing++
    }
  // What the other PC has running on an account counts here too (climayte-remote): not its groups.
  for (const [id, n] of remoteActiveCounts(now)) active.set(id, (active.get(id) ?? 0) + n)
  const { costOf, running, finishedSince } = placementState()
  const memory = memoryReader?.() ?? null
  return {
    now,
    accounts,
    allowFull,
    active,
    byGroup,
    costOf,
    running,
    finishedSince,
    memory,
    growing,
  }
}

/** When an account can next take work: the end of its usage wall, else its 5-hour reset. A login
 *  wall's `until` is only its next recheck, not a time the account frees up. */
function accountFreesAt(a: CliMayteAccount, now: number): number | null {
  const wall = walls[a.id]
  if (isLoginWall(wall?.reason)) return null
  if (wall && wall.until > now) return wall.until
  return a.sessionResetsAt ?? null
}

function firstFreeMs(pool: CliMayteAccount[], now: number): number | null {
  const at = pool
    .map((a) => accountFreesAt(a, now))
    .filter((t): t is number => t !== null && t > now)
    .sort((a, b) => a - b)[0]
  return at ?? null
}

const isoOrNull = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString()

function firstFreeAt(pool: CliMayteAccount[], now: number): string | null {
  return isoOrNull(firstFreeMs(pool, now))
}

/** When an account whose fresh 5-hour window holds the task (`expected`, % of a Pro window) next
 *  takes work: the end of its wall, else its reset. What a task held for room waits for
 *  (waitsForRoom), or null when no such time is known. */
function fitFreesAt(allowed: CliMayteAccount[], expected: number, now: number): number | null {
  return firstFreeMs(
    allowed.filter((a) => expected / (a.planFactor ?? 1) <= FIT_PCT),
    now,
  )
}

/** The room left on an account under FIT_PCT once the work running there is done, in Pro points
 *  (times its plan). */
function roomOn(s: TickState, a: CliMayteAccount): number {
  const left =
    FIT_PCT - projectedPct(a, s.running.get(a.id) ?? [], 0, s.finishedSince.get(a.id) ?? 0)
  return Math.max(0, left * (a.planFactor ?? 1))
}

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The accounts with room (at least MIN_START_ROOM_PCT) that a cap keeps the task off: every group's
 *  workers at maxPerAccount, or, for a per_account_strict group, its own at the group's cap. Said
 *  in a hold so it names what keeps the task waiting (2026-10-03 11:05: seven tasks waited behind a
 *  flat 4-worker cap while #35 sat at 26%). Empty, or a sentence with a leading space. */
function capNote(
  s: TickState,
  allowed: CliMayteAccount[],
  groupActive: Map<string, number>,
  cap: number | null,
  strict: boolean,
): string {
  const roomy = allowed.filter(
    (a) =>
      !((walls[a.id]?.until ?? 0) > s.now) &&
      (a.weekPct ?? 0) < weekStopPct(a.weekResetsAt, s.now) &&
      roomOn(s, a) >= MIN_START_ROOM_PCT,
  )
  const say = (list: CliMayteAccount[], counts: (a: CliMayteAccount) => number, what: string) => {
    const many = list.length > 1
    return `${list.map(acctLabel).join(', ')} ${many ? 'have' : 'has'} room but run${many ? '' : 's'} ${list.map(counts).join('/')} ${what}`
  }
  const full = roomy.filter((a) => (s.active.get(a.id) ?? 0) >= maxPerAccount(a))
  const parts: string[] = []
  if (full.length)
    parts.push(
      say(
        full,
        (a) => s.active.get(a.id) ?? 0,
        `workers (${full.length > 1 ? 'their' : 'its'} cap)`,
      ),
    )
  const capped = strict
    ? roomy.filter((a) => !full.includes(a) && (groupActive.get(a.id) ?? 0) >= groupCap(a, cap))
    : []
  if (capped.length)
    parts.push(
      say(capped, (a) => groupActive.get(a.id) ?? 0, "of this group's (per_account_strict)"),
    )
  return parts.length ? ` ${parts.join('; ')}.` : ''
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

/** The best eligible account has too little room for what this task is expected to use: it waits
 *  for room. `timed`: an account it fits refills within RESUME_WAIT_MS (waitsForRoom), so it starts
 *  by then either way; otherwise no account has the room to start it short (MIN_START_ROOM_PCT).
 *  `note`: the accounts with room a cap keeps it off (capNote). */
function holdForRoom(
  s: TickState,
  w: CliMayteWorker,
  acct: CliMayteAccount,
  cost: CostEstimate,
  allowed: CliMayteAccount[],
  hold: { fitAt: number | null; timed: boolean; note: string },
): void {
  const expected = cost.pct
  const room = roomOn(s, acct)
  const head = `Waiting for room: this task is expected to use about ${Math.round(expected)}% of a Pro 5-hour window`
  const when =
    hold.timed && hold.fitAt !== null
      ? `It starts by ${clock(hold.fitAt)} either way (an account it fits refills then).`
      : 'It starts the moment one has room (a reset, or the work there finishing); smaller tasks go meanwhile.'
  const why = `${head}, and the best eligible account now (${acctLabel(acct)}) has about ${Math.round(room)}% left. ${when}${hold.note}`
  // A timed hold counts toward the five minutes a task waits in all (heldForResetSince).
  if (hold.timed) w.heldForResetSince ??= new Date(s.now).toISOString()
  // Room for certain at the first reset of an account whose fresh window holds it (the work
  // running there may finish sooner).
  const until = isoOrNull(hold.fitAt)
  if (w.waitUntil !== until && w.status === 'waiting') {
    w.waitUntil = until
    changed(w)
  }
  // Said again only when the estimate or what it waits for changes: the room left moves every
  // tick, and each new figure would be a journal line.
  const tail = `${when}${hold.note}`
  if (w.status !== 'waiting' || !w.error?.startsWith(head) || !w.error.endsWith(tail)) {
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
  w: Pick<CliMayteWorker, 'accounts' | 'priority' | 'heldForResetSince' | 'chat'>,
  acct: CliMayteAccount,
  allowed: CliMayteAccount[],
  groupActive: Map<string, number>,
  cap: number | null,
  expected: number,
  atHome: boolean,
  moving: boolean,
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
          (groupActive.get(a.id) ?? 0) < groupCap(a, cap),
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
    {
      home: atHome,
      // A chat is never held for another account's reset: a person is waiting on it.
      priority: w.chat ? 1 : (w.priority ?? 0),
      heldSince: w.heldForResetSince ? Date.parse(w.heldForResetSince) : null,
      moving,
    },
  )
}

/** Why a task does not start on `acct` now: it falls short there (`cooldown` null, fallsShort;
 *  whether it waits for room is scheduleWorker's call, waitsForRoom), or a reset worth waiting for
 *  (`cooldown`, when; waitsForCooldown). */
interface Refusal {
  acct: CliMayteAccount
  cooldown: number | null
}

function refusalOn(
  s: TickState,
  w: Pick<CliMayteWorker, 'accounts' | 'priority' | 'heldForResetSince' | 'chat'>,
  acct: CliMayteAccount,
  allowed: CliMayteAccount[],
  groupActive: Map<string, number>,
  cap: number | null,
  placement: CliMaytePlacement,
  atHome: boolean,
  moving = false,
): Refusal | null {
  const factors = allowed.map((a) => a.planFactor ?? 1)
  if (fallsShort(acct, placement, factors, atHome)) return { acct, cooldown: null }
  const { expected } = placement
  const cooldown = cooldownFor(s, w, acct, allowed, groupActive, cap, expected, atHome, moving)
  return cooldown ? { acct, cooldown } : null
}

/** The accounts a new task of ordinary size (DEFAULT_TASK_PCT, a new group, any account) would
 *  start on right now, by the path scheduleWorker takes: what climayteCapacity tells a chat is
 *  room. 2026-10-02 04:58: the hint counted every account with no worker under the stop lines and
 *  said 9 sat idle while placement held 24 tasks. */
export function roomNow(s: TickState): CliMayteAccount[] {
  if (memoryShort(s.memory, s.growing)) return []
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
  w.heldForResetSince ??= new Date(now).toISOString()
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

/** The picked account's usage is due to be read again (readingPending): the task waits for that
 *  reading, a few seconds, rather than start on the old number or go elsewhere. */
function holdForReading(s: TickState, w: CliMayteWorker, acct: CliMayteAccount): void {
  wantReading(acct.id)
  const age =
    acct.readAt == null
      ? 'it has no reading in this window'
      : `its last reading is ${Math.round((s.now - acct.readAt) / 60_000)} minutes old`
  const why = `Reading the usage of ${acctLabel(acct)} before it starts there: ${age}.`
  if (w.status !== 'queued' || w.error !== why) {
    w.status = 'queued'
    w.error = why
    w.waitUntil = null
    changed(w)
  }
}

const MEMORY_HEAD = 'Waiting for memory'

/** The machine has no room for another worker (climayte-memory.ts): the task stays queued and starts
 *  on the first tick with room. Said once: the free figure moves every tick, and each new one would
 *  be a journal line and a change event. */
function holdForMemory(w: CliMayteWorker, short: string): void {
  if (w.status === 'queued' && w.error?.startsWith(MEMORY_HEAD)) return
  const why = `${MEMORY_HEAD}: ${short}. It starts the moment there is room (work finishing, or memory freed); nothing running is stopped.`
  journal(w, 'waiting', { error: firstLine(why) })
  w.status = 'queued'
  w.error = why
  w.waitUntil = null
  changed(w)
}

/** startOn will start the task on `acct` this tick rather than hold it (no reading due there, and
 *  the machine has the memory): a journal line about the start is written only then, not on every
 *  tick it is held. */
const goesNow = (s: TickState, acct: CliMayteAccount): boolean =>
  !readingPending(acct, s.now) && !memoryShort(s.memory, s.growing)

let launcher = launch

/** Test seam: start tasks with `fn` instead of a real CLI (null: the real one). */
export function setLauncher(fn: typeof launch | null): void {
  launcher = fn ?? launch
}

/** One tick's due tasks, in the order they take launch slots: a person's turn first, background
 *  resumes after a restart last, each rank in dueOrder. */
export function scheduleDue(s: TickState, due: CliMayteWorker[]): void {
  const ordered = [...due].sort((a, b) => launchRank(a) - launchRank(b) || dueOrder(a, b))
  for (const w of ordered) {
    try {
      scheduleWorker(s, w)
    } catch (err) {
      console.error(`[climayte] could not schedule ${w.id}:`, err)
    }
  }
}

/** Start the task on the picked account, and count it there for the rest of this tick; first its
 *  usage is read again if that is due (holdForReading), and the machine must have the memory for it
 *  (holdForMemory). */
function startOn(
  s: TickState,
  w: CliMayteWorker,
  acct: CliMayteAccount,
  cost: CostEstimate,
  groupActive: Map<string, number>,
): void {
  if (readingPending(acct, s.now)) {
    holdForReading(s, w, acct)
    return
  }
  const short = memoryShort(s.memory, s.growing)
  if (short) {
    holdForMemory(w, short)
    return
  }
  // No slot: the task stays as it is, due again next tick (never failed or dropped).
  if (!takeLaunchSlot(s.now)) return
  const expected = cost.pct
  // The row's size says what this start was placed on, not the estimate at dispatch.
  if (w.size)
    w.size = {
      ...w.size,
      expected: Math.round(expected * 10) / 10,
      basis: basisText(cost, w),
    }
  try {
    launcher(w, acct, s.accounts, s.active.get(acct.id) ?? 0)
  } catch (err) {
    console.error(`[climayte] could not launch ${w.id}:`, err)
    retryLaunch(w, acct, err)
  }
  if (w.status === 'running') {
    s.growing++
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
  note: string,
): string {
  const { accounts } = s
  const soonest = until ? Date.parse(until) : undefined
  const allSignedOut = allowed.length > 0 && allowed.every((a) => isLoginWall(walls[a.id]?.reason))
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
    return `Waiting for an account nobody else is using: ${inUse.join(', ')}; the others are at their limit or signed out. It starts when one frees up.${note}`
  return `Every eligible account is at its usage limit, past the ${WIND_DOWN_SESSION_PCT}% stop line, or signed out${soonest ? `; the first frees up at ${new Date(soonest).toLocaleString()}` : ''}.${note}`
}

/** Busy (every eligible account at its worker cap) stays queued, naming the accounts with room
 *  that a cap holds (`note`, capNote); nothing eligible at all waits. */
function holdForAccount(
  s: TickState,
  w: CliMayteWorker,
  allowed: CliMayteAccount[],
  note: string,
): void {
  const { now, accounts } = s
  const idle = new Map<string, number>()
  if (pickAccount(w, accounts, walls, idle, Number.MAX_SAFE_INTEGER, now, idle, s.allowFull)) {
    const slot = note ? `Waiting for a slot:${note}` : null
    const stale = !slot && !!w.error?.startsWith('Waiting for a slot')
    if (w.status === 'waiting' || (slot && w.error !== slot) || stale) {
      w.status = 'queued'
      w.error = slot
      changed(w)
    }
    return
  }
  const until = firstFreeAt(allowed, now)
  const why = noAccountReason(s, w, allowed, until, note)
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
 *  account that refuses it (no room, or a reset worth waiting for) passes it to the next.
 *  2026-10-02 05:09: held on #90 (ahead of its pace) alone, 8 tasks waited while #95 and #94 had no
 *  worker; two then started on #95 at the same 43%. The five-minute rule (owner, 2026-10-03: "When
 *  a worker hits a five-hour or weekly limit, CliMayte moves it to another account and resumes it,
 *  unless the limit resets in under five minutes; distribute the load"), in order: a session
 *  stopped at its own account's limit waits for it only within RESUME_WAIT_MS (waitsForHome); the
 *  first ranked account with no refusal takes it; else, unless the group is per_account_strict, the
 *  first account past the group's per_account with no refusal (journal 'spill'); else it holds for
 *  room or a reset only when one comes within RESUME_WAIT_MS; else it starts short on the best
 *  account with at least MIN_START_ROOM_PCT left (journal 'start-short': it hands off at the stop
 *  line and its continuation is placed again); else it waits. At 11:05 that day priority-1 tasks
 *  sat waiting behind a flat 4-worker cap and an unbounded wait for room while #35 had room. */
export function scheduleWorker(s: TickState, w: CliMayteWorker): void {
  const { now, accounts } = s
  // No cap from the dispatcher: the default, which counts Pro windows (groupCap).
  const cap = perAccount[w.group] ?? null
  const strict = perAccountStrict[w.group] === true
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
  if (home && ranked[0]?.id !== home.id) {
    if (pickAccount(w, [home], walls, s.active, cap, now, groupActive)) ranked = [home]
    else {
      const back = waitsForHome(homeFreesAt(home, now), now, w.priority ?? 0)
      if (back) {
        holdForHome(w, home, back)
        return
      }
    }
  }
  // Off a limit or a handoff the session moves anyway: never held for another account's pace.
  const moving = ['quota', 'handoff'].includes(w.attempts.at(-1)?.outcome ?? '')
  const refused: Refusal[] = []
  const firstTaker = (list: CliMayteAccount[], c: number | null): CliMayteAccount | null => {
    for (const acct of list) {
      if (refused.some((r) => r.acct.id === acct.id)) continue
      const atHome = staysHome(w, acct) || acct.id === home?.id
      const no = refusalOn(s, w, acct, allowed, groupActive, c, placement, atHome, moving)
      if (!no) return acct
      refused.push(no)
    }
    return null
  }
  // (1) The best account within the group's cap.
  const pick = firstTaker(ranked, cap)
  if (pick) {
    startOn(s, w, pick, cost, groupActive)
    return
  }
  // (2) per_account is a preference: past it, on the best account that takes the task. Every
  // other bar (walls, the stop line, maxPerAccount, a desktop in use, a stale reading) holds.
  let spill: CliMayteAccount[] = []
  if (!strict && (refused.length || !ranked.length)) {
    const over = Number.POSITIVE_INFINITY
    spill = rankAccounts(
      w,
      accounts,
      walls,
      s.active,
      over,
      now,
      groupActive,
      s.allowFull,
      placement,
    )
    const past = firstTaker(spill, over)
    if (past) {
      const within = cap ?? 'the default'
      if (goesNow(s, past))
        journal(w, 'spill', {
          account: acctLabel(past),
          notice: `no account within its per_account (${within}) took it now`,
        })
      startOn(s, w, past, cost, groupActive)
      return
    }
  }
  // (3) Room or a reset within five minutes: wait for it.
  const fitAt = fitFreesAt(allowed, expected, now)
  const heldLong = !!w.heldForResetSince && now - Date.parse(w.heldForResetSince) >= RESUME_WAIT_MS
  const factors = allowed.map((a) => a.planFactor ?? 1)
  const short = refused.find((r) => r.cooldown === null)
  if (short && !heldLong && waitsForRoom(short.acct, placement, factors, false, fitAt, now)) {
    holdForRoom(s, w, short.acct, cost, allowed, { fitAt, timed: true, note: '' })
    return
  }
  const reset = refused.find((r) => r.cooldown !== null)
  if (reset) {
    const resets = refused.flatMap((r) => r.cooldown ?? [])
    holdForReset(w, reset.acct, Math.min(...resets), now)
    return
  }
  // (4) Nothing comes soon: start short where the most room is, if there is enough to work in.
  const roomy = (spill.length ? spill : ranked).find((a) => roomOn(s, a) >= MIN_START_ROOM_PCT)
  if (roomy) {
    if (goesNow(s, roomy))
      journal(w, 'start-short', {
        account: acctLabel(roomy),
        notice: `expected to use about ${Math.round(expected)}% of a Pro 5-hour window, about ${Math.round(roomOn(s, roomy))}% left there; it hands off at the ${WIND_DOWN_SESSION_PCT}% line and goes on where there is room`,
      })
    startOn(s, w, roomy, cost, groupActive)
    return
  }
  // (5) Nowhere to start it.
  const note = capNote(s, allowed, groupActive, cap, strict)
  if (short) holdForRoom(s, w, short.acct, cost, allowed, { fitAt, timed: false, note })
  else holdForAccount(s, w, allowed, note)
}
