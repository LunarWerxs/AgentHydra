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

const TOAST_DURATION_MS = 20_000

/**
 * Gap between two toasts in one batch. This is a WORKAROUND for a real defect in vue-sonner 2.0.9
 * (the latest release), and it is load-bearing rather than cosmetic.
 *
 * Sonner positions its stack from a `heights` array that it keeps in parallel with the rendered
 * toasts, and each toast measures itself in a `watchEffect` that `await`s a tick. Raise two toasts
 * in the SAME tick and those measurements come back in the reverse of the raise order, while
 * `updateHeight` prepends each one blindly — so `heights` ends up in a different order than the
 * toasts on screen. Every toast's `--offset` (and the toaster's `--front-toast-height`) is then
 * attributed to the WRONG card.
 *
 * What that looks like: measured here with three toasts raised together, the front toast got the
 * middle card's offset (101px instead of 0) and the middle one got 0, so hover-to-expand dealt the
 * cards into each other's slots. With a backlog of ten it threw the front toast ~817px up, past the
 * top of the window and out from under the pointer — which drops the stack back to collapsed, puts
 * the toast under the pointer again, and re-expands: the up/down/up/down jitter, at hover speed.
 *
 * One macrotask apart is enough for each measurement to land before the next toast mounts. Verified
 * live: staggered, the same three toasts report offsets 0 / 125 / 251 and a correct front height.
 */
const RAISE_STAGGER_MS = 140

/**
 * Above this many at once, the batch collapses into ONE summary toast.
 *
 * Sonner keeps three toasts visible and stacks the rest, but its expanded height is the sum of ALL
 * of them, so a backlog of ten still means a hover unfurls something taller than the window. Ten
 * 20-second cards is also simply not readable — the whole set times out before you get through it.
 * Nothing is lost: every event is still in `events`, which is what the header badge counts.
 */
const MAX_INDIVIDUAL_TOASTS = 3

function raise(ev: ResetEvent, t: Translate): void {
  const window =
    ev.kind === 'session' ? t('notifications.windowSession') : t('notifications.windowWeekly')
  toast.success(t('notifications.toastTitle', { label: ev.label, window }), {
    description:
      ev.previousPct === null
        ? t('notifications.toastBody', { window })
        : t('notifications.toastBodyWas', { window, pct: ev.previousPct }),
    duration: TOAST_DURATION_MS,
    action: {
      label: t('notifications.acknowledge'),
      onClick: () => {
        void acknowledge(ev.id)
      },
    },
  })
}

/** One card for a whole backlog. Its action acknowledges every event in the batch, which is what
 *  stops persistent mode re-raising them — the same contract the per-event action has. */
function raiseSummary(batch: ResetEvent[], t: Translate): void {
  toast.success(t('notifications.toastSummaryTitle', { count: batch.length }), {
    description: t('notifications.toastSummaryBody'),
    duration: TOAST_DURATION_MS,
    action: {
      label: t('notifications.acknowledgeAll'),
      onClick: () => {
        void acknowledge()
      },
    },
  })
}

/** Toast everything new in one poll's worth of events, staggered (see RAISE_STAGGER_MS). Marks the
 *  whole batch as toasted UP FRONT, so the 30s poll that lands mid-stagger can't re-raise a card
 *  this one has not got to yet. */
async function raiseBatch(batch: ResetEvent[], t: Translate): Promise<void> {
  const fresh = batch.filter((ev) => !ev.acknowledged && !toasted.has(ev.id))
  if (fresh.length === 0) return
  for (const ev of fresh) toasted.add(ev.id)
  if (fresh.length > MAX_INDIVIDUAL_TOASTS) {
    raiseSummary(fresh, t)
    return
  }
  for (let i = 0; i < fresh.length; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, RAISE_STAGGER_MS))
    raise(fresh[i], t)
  }
}

async function refresh(t?: Translate): Promise<void> {
  const list = await guard(() => api.getResetEvents())
  if (!list) return
  events.value = list
  if (!t) return
  await raiseBatch(list, t)
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
