// server/src/login-sync-arrivals.ts — tell the owner when a login sync brings in an account this PC
// did not have before. A pass collects one arrival per new instance it made here (core/cli-login-sync.ts,
// core/desktop-login-sync.ts); this sends them as ONE notification over the reset/incident channel.
//
// Never names an account's email: an instance is named by its number, which is what the owner reads.

import { sendOsNotification } from './notify-os'
import { getNotificationSettings } from './notify-settings'

/** One instance a sync made on this PC. `plan` is the CLI login's plan label when it carries one. */
export interface LoginArrival {
  kind: 'cli' | 'desktop'
  num: number | null
  plan: string | null
}

const KIND_LABEL: Record<LoginArrival['kind'], string> = {
  cli: 'Claude CLI account',
  desktop: 'Claude desktop instance',
}

/** One line per arrival: "Claude CLI account #7 (Max 20×)". Pure, so the wording is testable. */
export function arrivalLine(a: LoginArrival): string {
  const who = a.num === null ? '' : ` #${a.num}`
  const plan = a.plan ? ` (${a.plan})` : ''
  return `${KIND_LABEL[a.kind]}${who}${plan}`
}

/** The notification for one sync pass's arrivals, or null when nothing arrived. Several arrivals
 *  become one message listing them all. */
export function arrivalMessage(arrivals: LoginArrival[]): { title: string; body: string } | null {
  if (arrivals.length === 0) return null
  const n = arrivals.length
  return {
    title: n === 1 ? 'Login sync: 1 new account' : `Login sync: ${n} new accounts`,
    body: `Added by the sync: ${arrivals.map(arrivalLine).join('; ')}.`,
  }
}

/** Send one pass's arrivals over the desktop notification channel, when the owner has it on.
 *  Never throws: a failed toast must not take the sync pass down with it. */
export async function notifyLoginArrivals(arrivals: LoginArrival[]): Promise<void> {
  const msg = arrivalMessage(arrivals)
  if (!msg) return
  const settings = getNotificationSettings()
  if (!settings.notifyEnabled || !settings.notifyDesktop) return
  try {
    await sendOsNotification({ ...msg, sticky: settings.notifyPersistent })
  } catch {
    // best-effort, like every notification channel
  }
}
