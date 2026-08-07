// web/src/composables/useUsageFilter.ts — the Instances tab's "set aside the accounts I've used up".
//
// With a handful of accounts on screen the quota columns answer "how much is left" per row, but the
// question actually being asked is "which of these can I still work on". That is a threshold, and a
// threshold is a setting — so this is the reactive, persisted half of lib/usage-filter.ts.
//
// Three deliberate design points:
//
// * It is GATED ON USAGE MODE (`active`). The filter exists to reshape the quota view; leaving it
//   dimming rows in process mode — where the toolbar button that controls it isn't shown — would
//   strand a user with greyed-out rows and no visible way to undo it. Flipping back to process
//   columns restores a plain table, which is the honest behaviour for a mode that is about
//   "is it running", not "how much is left".
// * DIM is the default and HIDE is opt-in, because dimming is lossless: the row is still there to
//   check. Hiding is the stronger tool for someone running many accounts, so both tables say how
//   many rows they dropped rather than silently coming up short.
// * EACH WINDOW IS ITS OWN SWITCH AND ITS OWN THRESHOLD (see lib/usage-filter.ts): "80% weekly, and
//   also 50% of the 5-hour" is two different lines for two different questions, and the row is set
//   aside when either is crossed.
//
// Module-scope singleton + useStorage, matching useUsageMode.ts: the desktop table, the CLI table
// and the toolbar flyout all read this, and a per-component ref would let them disagree.

import { useStorage } from '@vueuse/core'
import { computed } from 'vue'
import type { UsageSnapshot } from '@/lib/api'
import {
  clampThreshold,
  DEFAULT_USAGE_THRESHOLD,
  isEmptyRule,
  USAGE_FILTER_KEY as KEY,
  matchesUsageFilter,
  type UsageFilterRule,
} from '@/lib/usage-filter'
import { registerSharedPref } from './useSharedPrefs'
import { useUsageMode } from './useUsageMode'

// The carry-over from the old single-threshold `scope2` shape runs in main.ts, before any of this
// module is evaluated — see migrateLegacyUsageFilterScope in lib/usage-filter.ts for why it cannot
// live here (useStorage writes its default on first read, which would erase the "never set" signal).

/** Off until asked for: a fresh install should show every instance it found. */
const enabled = useStorage(`${KEY}.enabled`, false)
/** false = dim the matching rows (default), true = drop them from the table. */
const hideMatches = useStorage(`${KEY}.hide`, false)

/** The weekly cap — the Usage column, the one that decides whether an account is worth starting on
 *  at all, so it is the window that is on by default. Key kept as `.threshold` (not renamed to
 *  `.weekThreshold`): it has always meant the weekly line for everyone whose scope was the default,
 *  and a rename would reset their number for no gain. */
const weekEnabled = useStorage(`${KEY}.week`, true)
const weekThreshold = useStorage(`${KEY}.threshold`, DEFAULT_USAGE_THRESHOLD)

/** The 5-hour session window. Opt-in: it comes back the same day, so filtering on it by default had
 *  accounts dropping out of the table and back in over an afternoon. */
const sessionEnabled = useStorage(`${KEY}.session`, false)
const sessionThreshold = useStorage(`${KEY}.sessionThreshold`, DEFAULT_USAGE_THRESHOLD)

// Every switch and threshold above is ALSO mirrored through the daemon, because the quick-instances
// window can be served from a different PORT and browser storage is scoped per origin — so without
// this, "the filter I set in the full manager" would not follow you into the compact window when it
// runs standalone. See composables/useSharedPrefs.ts for the server-wins-on-hydrate rule.
registerSharedPref(`${KEY}.enabled`, enabled)
registerSharedPref(`${KEY}.hide`, hideMatches)
registerSharedPref(`${KEY}.week`, weekEnabled)
registerSharedPref(`${KEY}.threshold`, weekThreshold)
registerSharedPref(`${KEY}.session`, sessionEnabled)
registerSharedPref(`${KEY}.sessionThreshold`, sessionThreshold)

export function useUsageFilter() {
  // No clock needed: nothing here counts down, it only compares percentages.
  const { usageMode } = useUsageMode()

  /** The windows being measured right now, with their thresholds — the whole filter rule in one
   *  value, so the tables and the flyout can't drift on what "matching" means. */
  const rule = computed<UsageFilterRule>(() => ({
    week: weekEnabled.value ? weekThreshold.value : null,
    session: sessionEnabled.value ? sessionThreshold.value : null,
  }))

  /** The filter is doing something right now: on, the quota columns are showing, and at least one
   *  window is being measured. */
  const active = computed(() => enabled.value && usageMode.value && !isEmptyRule(rule.value))

  /** On, but told to check nothing — the flyout says so rather than leaving a switched-on filter
   *  that visibly does nothing to the table. */
  const noWindows = computed(() => enabled.value && isEmptyRule(rule.value))

  /** Does this row match the filter? False whenever the filter isn't active, so callers can use it
   *  as the single condition rather than repeating the `active &&` themselves. */
  function matches(snap: UsageSnapshot | null | undefined): boolean {
    if (!active.value) return false
    return matchesUsageFilter(snap, rule.value)
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
    hideMatches,
    weekEnabled,
    weekThreshold,
    sessionEnabled,
    sessionThreshold,
    rule,
    active,
    noWindows,
    matches,
    dimmed,
    hidden,
    visible,
    /** Writes go through the clamp so a typed "800" or "" can't persist an unreachable threshold. */
    setWeekThreshold: (value: unknown) => {
      weekThreshold.value = clampThreshold(value, weekThreshold.value)
    },
    setSessionThreshold: (value: unknown) => {
      sessionThreshold.value = clampThreshold(value, sessionThreshold.value)
    },
  }
}
