// Pure helpers for the accounts popover (tested in web/test/panes).

const EMAIL = /[^\s<>()@]+@[^\s<>()@]+\.[^\s<>()@]+/g

/**
 * The label shown for an account, never its email: emails are cut out of AgentHydra's label, and a
 * trailing "(plan)" is dropped when the plan is shown beside it anyway.
 */
export function accountLabel(label: string, plan: string | null, id: string): string {
  let out = label.replace(EMAIL, '').replace(/<\s*>|\(\s*\)/g, '')
  if (plan) {
    const esc = plan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(\\s*\\(\\s*${esc}\\s*\\))+\\s*$`, 'i'), '')
  }
  out = out.replace(/\s{2,}/g, ' ').trim()
  return out || (id === 'default' ? 'Default login' : `#${id}`)
}

/**
 * The one way an account is named outside the accounts list: "#128 · Pro", "#68 eek · Max 20x". Never
 * an email, the plan once. A bare AccountRef (a chat's account) has no plan field, so its plan is read
 * from the trailing "(plan)" of AgentHydra's label.
 */
export function accountTitle(a: { id: string; label: string; plan?: string | null }): string {
  const plan = a.plan ?? /\(([^()]+)\)\s*$/.exec(a.label.replace(EMAIL, ''))?.[1]?.trim() ?? null
  const name = accountLabel(a.label, plan, a.id)
  return plan ? `${name} · ${plan}` : name
}

/** "resets in 2h 14m" (under a day) or "resets Mon 14:00" (later), from epoch ms. */
export function resetText(at: number | null, now: number = Date.now()): string {
  if (at == null) return ''
  const ms = at - now
  if (ms <= 0) return 'resets now'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `resets in ${mins}m`
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m ? `resets in ${h}h ${m}m` : `resets in ${h}h`
  }
  const d = new Date(at)
  const day = d.toLocaleDateString(undefined, { weekday: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `resets ${day} ${time}`
}

/** How full a usage window reads: green under 60, amber 60-85, red over 85, unknown without a reading. */
export type UsageTone = 'ok' | 'warn' | 'full' | 'unknown'
export function usageTone(pct: number | null): UsageTone {
  if (pct == null) return 'unknown'
  if (pct > 85) return 'full'
  if (pct >= 60) return 'warn'
  return 'ok'
}

/** Bar colour by how full a window is. */
export function barColor(pct: number | null): string {
  return { ok: 'var(--success)', warn: 'var(--warning)', full: 'var(--danger)', unknown: 'var(--text-muted)' }[usageTone(pct)]
}

/** '43%', or '–' without a reading. */
export function pctText(pct: number | null): string {
  return pct == null ? '–' : `${Math.round(pct)}%`
}
