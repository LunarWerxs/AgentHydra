// web/src/composables/useNotifications.ts — mirror the daemon's reset events into the app.
//
// The NATIVE notification is the daemon's job (server/src/reset-watch.ts) and fires whether or not
// a browser is open — that is the point of it. This composable is the in-app half: it polls for
// open events so that if you DO have the window up, the news also lands where you're looking, with
// an Acknowledge action that stops persistent mode from re-raising it.
//
// Module-scope singleton with the same shape as the other composables here (shared refs + action
// wrappers), so mounting it from more than one component cannot start two polls.

import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { ResetEvent } from '@/lib/api'
import * as api from '@/lib/api'

const events = ref<ResetEvent[]>([])
const lastError = ref<string | null>(null)
/** Ids already toasted, so a poll that re-lists the same open event doesn't re-toast it. Persistent
 *  mode's REPEATS are an OS-level concern by design: an in-app toast the user is looking at does
 *  not need to be shown to them again every ten minutes. */
const toasted = new Set<string>()

/** 30s — an event that already reached the OS a moment ago; this is the catch-up path, not the
 *  primary one, so a tight poll would buy nothing. */
const POLL_MS = 30_000
let pollTimer: number | null = null

async function guard<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn()
    lastError.value = null
    return r
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : String(err)
    return null
  }
}

/** Translate an event into the toast copy. Kept beside the poll so the two can't drift. */
type Translate = (key: string, named?: Record<string, unknown>) => string

function raise(ev: ResetEvent, t: Translate): void {
  if (toasted.has(ev.id)) return
  toasted.add(ev.id)
  const window =
    ev.kind === 'session' ? t('notifications.windowSession') : t('notifications.windowWeekly')
  toast.success(t('notifications.toastTitle', { label: ev.label, window }), {
    description:
      ev.previousPct === null
        ? t('notifications.toastBody', { window })
        : t('notifications.toastBodyWas', { window, pct: ev.previousPct }),
    duration: 20_000,
    action: {
      label: t('notifications.acknowledge'),
      onClick: () => {
        void acknowledge(ev.id)
      },
    },
  })
}

async function refresh(t?: Translate): Promise<void> {
  const list = await guard(() => api.getResetEvents())
  if (!list) return
  events.value = list
  if (!t) return
  for (const ev of list) {
    if (!ev.acknowledged) raise(ev, t)
  }
}

/** Acknowledge one event (or all, with no id). This is what stops persistent mode re-raising it. */
async function acknowledge(id?: string): Promise<void> {
  const list = await guard(() => api.acknowledgeResetEvents(id))
  if (list) events.value = list
}

/** Fire a test notification through whatever channels are configured. */
async function test(): Promise<api.NotifyDeliveryResult | null> {
  return guard(() => api.sendTestNotification())
}

function startPolling(t: Translate): void {
  if (pollTimer !== null) return
  void refresh(t)
  pollTimer = window.setInterval(() => void refresh(t), POLL_MS)
}

function stopPolling(): void {
  if (pollTimer === null) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

export function useNotifications() {
  return {
    events,
    lastError,
    refresh,
    acknowledge,
    test,
    startPolling,
    stopPolling,
    /** Count of open (unacknowledged) events — drives the header badge. */
    unacknowledged: () => events.value.filter((e) => !e.acknowledged).length,
  }
}
