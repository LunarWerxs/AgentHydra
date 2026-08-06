// web/src/composables/useUsageFilter.ts — the Instances tab's "set aside the accounts I've used up".
//
// With a handful of accounts on screen the quota columns answer "how much is left" per row, but the
// question actually being asked is "which of these can I still work on". That is a threshold, and a
// threshold is a setting — so this is the reactive, persisted half of lib/usage-filter.ts.
//
// Two deliberate design points:
//
// * It is GATED ON USAGE MODE (`active`). The filter exists to reshape the quota view; leaving it
//   dimming rows in process mode — where the toolbar button that controls it isn't shown — would
//   strand a user with greyed-out rows and no visible way to undo it. Flipping back to process
//   columns restores a plain table, which is the honest behaviour for a mode that is about
//   "is it running", not "how much is left".
// * DIM is the default and HIDE is opt-in, because dimming is lossless: the row is still there to
//   check. Hiding is the stronger tool for someone running many accounts, so both tables say how
//   many rows they dropped rather than silently coming up short.
//
// Module-scope singleton + useStorage, matching useUsageMode.ts: the desktop table, the CLI table
// and the toolbar flyout all read this, and a per-component ref would let them disagree.

import { useStorage } from '@vueuse/core'
import { computed } from 'vue'
import type { UsageSnapshot } from '@/lib/api'
import {
  clampThreshold,
  DEFAULT_USAGE_FILTER_SCOPE,
  DEFAULT_USAGE_THRESHOLD,
  isOverUsageThreshold,
  type UsageFilterScope,
} from '@/lib/usage-filter'
import { useUsageMode } from './useUsageMode'

/** Off until asked for: a fresh install should show every instance it found. */
const enabled = useStorage('agenthydra.instances.usageFilter.enabled', false)
const threshold = useStorage('agenthydra.instances.usageFilter.threshold', DEFAULT_USAGE_THRESHOLD)
/** false = dim the matching rows (default), true = drop them from the table. */
const hideMatches = useStorage('agenthydra.instances.usageFilter.hide', false)
// `.scope2`, not `.scope`: the first build of this filter defaulted to 'either' and useStorage
// WRITES its default on first read, so every tab that ever rendered the flyout already has
// 'either' on disk. Changing the default alone would therefore reach nobody who had opened it.
// A new key is the honest one-liner — the stale one is a dead 6-byte entry, and anyone who had
// deliberately chosen a window re-picks it once rather than being silently overridden by a
// migration that cannot tell a deliberate choice from the old default.
const scope = useStorage<UsageFilterScope>(
  'agenthydra.instances.usageFilter.scope2',
  DEFAULT_USAGE_FILTER_SCOPE,
)

export function useUsageFilter() {
  // No clock needed: nothing here counts down, it only compares percentages.
  const { usageMode } = useUsageMode()

  /** The filter is doing something right now (on, and the quota columns are showing). */
  const active = computed(() => enabled.value && usageMode.value)

  /** Does this row match the filter? False whenever the filter isn't active, so callers can use it
   *  as the single condition rather than repeating the `active &&` themselves. */
  function matches(snap: UsageSnapshot | null | undefined): boolean {
    if (!active.value) return false
    return isOverUsageThreshold(snap, threshold.value, scope.value)
  }

  /** Row should be greyed out but stay in the table. */
  function dimmed(snap: UsageSnapshot | null | undefined): boolean {
    return !hideMatches.value && matches(snap)
  }

  /** Row should be dropped from the table entirely. */
  function hidden(snap: UsageSnapshot | null | undefined): boolean {
    return hideMatches.value && matches(snap)
  }

  /** Drop the hidden rows from a list. Sort first, then filter — the filter removes rows, it
   *  never reorders them. Takes a readonly array because that is what useSortable hands back. */
  function visible<T>(
    rows: readonly T[],
    snapOf: (row: T) => UsageSnapshot | null | undefined,
  ): readonly T[] {
    if (!active.value || !hideMatches.value) return rows
    return rows.filter((row) => !matches(snapOf(row)))
  }

  return {
    enabled,
    threshold,
    hideMatches,
    scope,
    active,
    matches,
    dimmed,
    hidden,
    visible,
    /** Writes go through the clamp so a typed "800" or "" can't persist an unreachable threshold. */
    setThreshold: (value: unknown) => {
      threshold.value = clampThreshold(value, threshold.value)
    },
  }
}
