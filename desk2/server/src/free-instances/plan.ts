// What the window says when a Free account moves between free and paid (owner, 2026-10-09: "If they change to not
// free, I guess let me know ... and then I may go and promote them ... To cli/desktop").
import { type FreeInstance, isPaidPlan } from '@shared/free-instances'

const PROVIDER = { claude: 'Claude', chatgpt: 'ChatGPT' } as const
const label = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1)

/** The notification for the account's last plan change; null when it has none. */
export function planNotice(i: FreeInstance): { title: string; body: string } | null {
  const change = i.planChange
  if (!change) return null
  const who = `${i.name} (${PROVIDER[i.provider]} Free #${i.num})`
  if (isPaidPlan(change.to)) {
    const promote = i.provider === 'claude' ? 'a CLI or Desktop instance' : 'a Codex instance'
    return {
      title: `Free account is on ${label(change.to)}`,
      body: `${who} ${change.from ? 'moved to' : 'reports'} the ${label(change.to)} plan, so it is no longer free. It can run as ${promote}: Promote in its menu.`,
    }
  }
  return { title: 'Free account is back on Free', body: `${who} left the ${label(change.from ?? 'paid')} plan and is on Free again.` }
}
