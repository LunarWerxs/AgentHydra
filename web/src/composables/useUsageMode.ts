// web/src/composables/useUsageMode.ts — the Instances tab's "usage mode" switch.
//
// The instances table answers two different questions with one set of columns. PID / uptime /
// memory answer "is this process healthy?"; percentages and reset times answer "how much quota do I
// have left, and when does it come back?". Showing both at once means every row carries three
// columns you aren't reading, and the ones you ARE reading are squeezed.
//
// So it is a MODE, not a column picker: one toolbar toggle swaps the process columns for the quota
// columns across the whole tab (desktop table, CLI table, and anything added later), because the
// question you're asking applies to all of them at once.
//
// Module-scope singleton + useStorage, the same shape as the other shared UI state here: several
// components read it, and a per-component ref would let the tables disagree until a reload.

import { useStorage } from '@vueuse/core'
import { computed, onUnmounted, ref } from 'vue'

/** Persisted so the mode survives a reload — it is a way of working, not a momentary filter. */
const usageMode = useStorage('agenthydra.instances.usageMode', false)

// --- the shared clock ---------------------------------------------------------
// Every countdown cell in both tables derives from ONE ticking ref. Per-cell timers would drift
// against each other (rows a second apart in the same table) and cost a timer per row; one ref
// re-renders them together and costs one. Refcounted so the interval only exists while a component
// that shows countdowns is mounted.

const now = ref(new Date())
let tickTimer: ReturnType<typeof setInterval> | null = null
let tickUsers = 0

/** 15s, not 1s: the countdown is coarse above a minute (see lib/usage-reset.formatCountdown), so a
 *  per-second tick would re-render the table sixty times to change nothing. */
const TICK_MS = 15_000

function retainTick(): void {
  tickUsers += 1
  if (tickTimer) return
  tickTimer = setInterval(() => {
    now.value = new Date()
  }, TICK_MS)
}

function releaseTick(): void {
  tickUsers = Math.max(0, tickUsers - 1)
  if (tickUsers > 0 || !tickTimer) return
  clearInterval(tickTimer)
  tickTimer = null
}

/**
 * @param withClock pass true from a component that renders countdowns, so the shared tick runs
 *   while it is mounted. Components that only need the flag (e.g. a toolbar button) leave it off.
 */
export function useUsageMode(withClock = false) {
  if (withClock) {
    retainTick()
    // Keep the clock alive exactly as long as this component. now.value is refreshed immediately on
    // retain so a freshly-mounted table never shows a countdown from the previous mount's tick.
    now.value = new Date()
    onUnmounted(releaseTick)
  }
  return {
    usageMode,
    /** Convenience for templates that read the flag a lot. */
    isUsageMode: computed(() => usageMode.value),
    toggle: () => {
      usageMode.value = !usageMode.value
    },
    /** The shared clock every countdown cell should format against. */
    now,
  }
}
