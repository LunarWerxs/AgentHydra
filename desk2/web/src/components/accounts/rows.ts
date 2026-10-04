// Pure logic of the account popup (tested in web/test/shell): its rows, and what choosing one does.
import type { AccountInfo, ChatSummary, DeskSettings } from '@shared/protocol'
import { accountLabel, pctText, resetText } from './format'

export const AUTO_ID = 'auto'
export const AUTO_LABEL = 'Auto (best available)'
export const ACCOUNTS_HINT = 'Your chat runs here. CliMayte sends sub-agents to the others.'
export const DEFAULT_ID = 'default'

export interface AccountRow {
  id: string // 'auto' or the account id
  label: string // 'Auto (best available)' or '#35 sue'
  plan: string | null
  checked: boolean // the current choice for new chats
  disabled: boolean // signed out: shown, not choosable
  inUse: boolean
  liveChats: number // Hydra Desk chats on it that are not closed or archived
  account: AccountInfo | null // null for Auto
}

/**
 * Room left on an account, 0..100: the fuller of its two windows decides. Unknown windows count as
 * neither full nor free (-1, after every known one); a signed-out account has none (-Infinity).
 */
export function headroom(a: Pick<AccountInfo, 'signedIn' | 'fiveHourPct' | 'weeklyPct'>): number {
  if (!a.signedIn) return -Infinity
  const known = [a.fiveHourPct, a.weeklyPct].filter((p): p is number => p != null)
  return known.length ? 100 - Math.max(...known) : -1
}

/**
 * Auto first, then Default login, then the accounts by availability: signed in with the most headroom
 * first, signed out last (AgentHydra's order breaks ties). The check follows defaultAccountId.
 */
export function accountRows(accounts: AccountInfo[], chats: ChatSummary[], defaultAccountId: string): AccountRow[] {
  const live = new Map<string, number>()
  for (const c of chats) {
    if (c.status === 'closed' || c.archived) continue
    live.set(c.account.id, (live.get(c.account.id) ?? 0) + 1)
  }
  // A default that names an account no longer listed falls back to Auto, as the server does.
  const current = accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : AUTO_ID
  const sorted = [...accounts].sort((a, b) => Number(b.id === DEFAULT_ID) - Number(a.id === DEFAULT_ID) || headroom(b) - headroom(a))
  return [
    {
      id: AUTO_ID,
      label: AUTO_LABEL,
      plan: null,
      checked: current === AUTO_ID,
      disabled: false,
      inUse: false,
      liveChats: 0,
      account: null
    },
    ...sorted.map((a) => ({
      id: a.id,
      label: accountLabel(a.label, a.plan, a.id),
      plan: a.plan,
      checked: current === a.id,
      disabled: !a.signedIn,
      inUse: a.inUse,
      liveChats: live.get(a.id) ?? 0,
      account: a
    }))
  ]
}

/**
 * Choosing a row saves it as the default account for NEW chats (the settings route). A signed-out row
 * or the current choice saves nothing. Returns whether it saved.
 */
export async function chooseAccount(
  row: Pick<AccountRow, 'id' | 'disabled' | 'checked'>,
  save: (patch: Partial<DeskSettings>) => Promise<unknown>
): Promise<boolean> {
  if (row.disabled || row.checked) return false
  await save({ defaultAccountId: row.id })
  return true
}

/** A row's hover tooltip: each window with its reset time, then who else is on the account. */
export function rowTip(row: Pick<AccountRow, 'account' | 'inUse' | 'liveChats'>, now: number = Date.now()): string {
  const a = row.account
  if (!a) return ''
  if (!a.signedIn) return 'Signed out: sign it in with AgentHydra to use it'
  const line = (name: string, pct: number | null, reset: number | null) => {
    const r = resetText(reset, now)
    return `${name} ${pctText(pct)}${r ? `, ${r}` : ''}`
  }
  const lines = [line('5-hour', a.fiveHourPct, a.fiveHourResetsAt), line('Weekly', a.weeklyPct, a.weeklyResetsAt)]
  if (row.inUse) lines.push('In use by a person or another session')
  if (row.liveChats > 0) lines.push(`${row.liveChats} live Hydra Desk ${row.liveChats === 1 ? 'chat' : 'chats'}`)
  return lines.join('\n')
}
