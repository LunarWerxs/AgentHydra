// Accounts: AgentHydra's CLI instances (GET /api/cli-instances) plus the machine's default ~/.claude
// login, as the rows Hydra Desk shows (SPEC.md "The bridge"). Which account a chat runs on is not
// decided in Hydra Desk at all: a new chat is a CliMayte worker and CliMayte places it.

import type { AccountInfo, AccountRef } from '@shared/protocol'
import type { AhCliInstance, AhUsageLimit, AhWorker } from './client'

export const DEFAULT_ACCOUNT: AccountRef = { id: 'default', label: 'Default login', configDir: null }

/** The default login as a row. AgentHydra does not read its usage, so its numbers are unknown. */
export const DEFAULT_ACCOUNT_INFO: AccountInfo = {
  ...DEFAULT_ACCOUNT,
  email: null,
  plan: null,
  signedIn: true,
  fiveHourPct: null,
  weeklyPct: null,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  inUse: false,
}

/** The fleet's line (owner, 2026-08-31): every account stays at or under 85% on both windows. Nothing Desk places
 *  itself (a move, a title, a judgment) goes onto an account at or past it. */
export const ROOM_PCT = 85

/** Signed in, and read under its line on both windows: ROOM_PCT, or the owner's lower cap for the account (owner,
 *  2026-10-09: "up to 50% of five-hour, 50% of week"). An unread window is not room: the default login is never
 *  read, and before this a full account moved chats onto one at 99% (the line was 100, unread counted as 0). */
export function hasRoom(a: AccountInfo): boolean {
  const line = (cap: number | null | undefined): number => Math.min(ROOM_PCT, cap ?? ROOM_PCT)
  return (
    a.signedIn &&
    a.fiveHourPct !== null &&
    a.weeklyPct !== null &&
    a.fiveHourPct < line(a.maxFiveHourPct) &&
    a.weeklyPct < line(a.maxWeeklyPct)
  )
}

const RUNNING_WORKER = new Set(['running', 'checking'])

/** AgentHydra writes plans as 'Max 20×'; the protocol spells them 'Max 20x'. */
const plan = (p: string | null | undefined): string | null => (p ? p.replace(/×/g, 'x') : null)

const resetMs = (l: AhUsageLimit | null | undefined): number | null => {
  const t = l?.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
  return Number.isFinite(t) ? t : null
}

/** '#128 name (Pro)'. Quick add names an instance "<email> (<plan>)", so the plan is added only when the name lacks it. */
function accountLabel(i: AhCliInstance, p: string | null): string {
  const named = p !== null && (plan(i.name) ?? '').toLowerCase().endsWith(`(${p.toLowerCase()})`)
  return `#${i.num} ${i.name}${p && !named ? ` (${p})` : ''}`
}

export function toAccountInfo(i: AhCliInstance, busyAccountIds: ReadonlySet<string>): AccountInfo {
  // A reading kept after its account signed out is history (AgentHydra dims it and never ranks on it).
  const usage = i.lastUsageCheck && !i.lastUsageCheck.signedOutAt ? i.lastUsageCheck : null
  const p = plan(i.planLabel)
  return {
    id: i.id,
    label: accountLabel(i, p),
    configDir: i.configDir,
    number: i.num,
    email: i.lastUsageCheck?.account ?? null,
    plan: p,
    signedIn: i.loggedIn && !i.movedAway,
    fiveHourPct: usage?.session?.pct ?? null,
    weeklyPct: usage?.weekAll?.pct ?? null,
    fiveHourResetsAt: resetMs(usage?.session),
    weeklyResetsAt: resetMs(usage?.weekAll),
    // liveSessions counts the account's live registry (any Claude session on it, CliMayte workers
    // included); a running worker is counted too in case the registry has not caught up with it.
    inUse: (i.liveSessions ?? 0) > 0 || busyAccountIds.has(i.id),
    priority: i.placement?.priority ?? 0,
    maxFiveHourPct: i.placement?.maxSessionPct ?? null,
    maxWeeklyPct: i.placement?.maxWeekPct ?? null,
  }
}

/** The default login first, then the CLI instances in AgentHydra's order. */
export function mapAccounts(instances: AhCliInstance[], workers: AhWorker[]): AccountInfo[] {
  const busy = new Set(
    workers.filter((w) => RUNNING_WORKER.has(w.status) && w.accountId).map((w) => w.accountId as string),
  )
  return [DEFAULT_ACCOUNT_INFO, ...instances.map((i) => toAccountInfo(i, busy))]
}
