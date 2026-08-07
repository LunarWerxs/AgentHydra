<script setup lang="ts">
// The Instances toolbar's usage flyout: "set aside the accounts I've used up", plus the
// auto-refresh knob that keeps the numbers it filters on current.
//
// Why it lives here rather than in Settings: a threshold is only meaningful while you are looking
// at the percentages it applies to. Buried in a settings panel it is a control you have to already
// know exists; sitting next to the usage-mode toggle it is discovered by anyone who turns the quota
// columns on. The auto-refresh rows are the same rows Settings renders (UsageRefreshRows), not a
// copy — flipping either surface moves the other.
//
// Shown only in usage mode, which is also exactly when the filter is allowed to do anything (see
// composables/useUsageFilter.ts): the button and its effect appear and disappear together, so a
// dimmed table always has a visible control that explains it.
//
// Laid out as LABELLED SECTIONS over card-shaped groups rather than one run of hairline-divided
// rows. With two windows, each carrying a switch and a threshold, an undifferentiated list left the
// eye no way to tell which threshold belonged to which switch; a card that visibly contains its own
// controls answers that before it has to be read. The accent-coloured section captions are the same
// idea one level up — they say what each run of controls is FOR, so "Hide instead of dim" reads as
// a display choice rather than as a third quota window.
import { Funnel } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UsageFilterWindow from '@/components/UsageFilterWindow.vue'
import UsageRefreshRows from '@/components/UsageRefreshRows.vue'
import { buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useUsageFilter } from '@/composables/useUsageFilter'
import { cn } from '@/lib/utils'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const {
  enabled,
  hideMatches,
  weekEnabled,
  weekThreshold,
  sessionEnabled,
  sessionThreshold,
  rule,
  noWindows,
  setWeekThreshold,
  setSessionThreshold,
} = useUsageFilter()

// The trigger carries the rule when the filter is on, so the toolbar says what the table is doing
// without needing the flyout opened. `secondary` matches the pressed usage-mode toggle beside it,
// which is the established "this mode is on" signal in this toolbar.
const triggerVariant = computed(() => (enabled.value ? 'secondary' : 'outline'))

/** The rule, compact enough for a toolbar button. A bare percentage is the weekly cap — the window
 *  that has always been the default — and the 5-hour line is the one that carries a "5h" tag, so
 *  the common single-window case stays as short as it was before there were two. */
const triggerLabel = computed(() => {
  const { week, session } = rule.value
  if (week != null && session != null) {
    return t('instances.usageFilterChipBoth', { week, session })
  }
  if (session != null) return t('instances.usageFilterChipSession', { pct: session })
  if (week != null) return t('instances.usageFilterChipWeek', { pct: week })
  return t('instances.usageFilterChipNone')
})

/** Section caption: uppercase, tracked, accent-coloured. Shared so the three of them cannot drift. */
const CAPTION = 'text-[11px] font-semibold uppercase tracking-wider text-primary'
</script>

<template>
  <!-- The Popover ROOT must sit INSIDE IconTooltip's slot, wrapped in a plain element: reka anchors
       a popper to the nearest PopperRoot in the component tree, so a tooltip wrapped AROUND the
       root steals the anchor and the content never positions. See
       scripts/checks/reka-popper-root-inside-tooltip.mjs for the full write-up. -->
  <IconTooltip
    :label="$t('instances.usageFilterTitle')"
    :description="$t('instances.usageFilterHint')"
  >
    <span class="inline-flex">
      <Popover>
        <PopoverTrigger as-child>
          <button
            type="button"
            :class="cn(buttonVariants({ variant: triggerVariant, size: enabled ? 'default' : 'icon' }))"
            :aria-label="$t('instances.usageFilterTitle')"
          >
            <Funnel />
            <span v-if="enabled" class="tabular-nums">{{ triggerLabel }}</span>
          </button>
        </PopoverTrigger>
        <!-- Wider than the default popover: two threshold cards, each with a four-up preset row,
             and the shared auto-refresh rows below them, whose label wraps under a narrow control
             column. 24rem is the width at which none of the three has to fold. -->
        <PopoverContent align="end" class="w-96 p-0">
          <!-- No max height and no scroller: the flyout GROWS as sections open. A scrollbar here
               was worse than the height it saved — expanding a window moved the controls under the
               cursor, and the section you had just opened could land below the fold. -->
          <div class="space-y-3 px-3 py-3">
            <header class="space-y-1.5">
              <h2 class="text-sm font-semibold text-foreground">
                {{ $t('instances.usageFilterTitle') }}
              </h2>
              <!-- The master switch sits at top level rather than inside a card: the cards below are
                   the things it turns on, and nesting it among them would make it look like one more
                   of them. -->
              <div class="flex items-center gap-3">
                <span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
                  {{ $t('instances.usageFilterEnable') }}
                  <InfoHint :text="$t('instances.usageFilterHint')" />
                </span>
                <Switch v-model="enabled" />
              </div>
            </header>

            <!-- Everything below is dead weight while the filter is off — collapse it rather than
                 leaving thresholds you can set and controls that do nothing. -->
            <ExpandTransition :open="enabled">
              <div class="space-y-3">
                <section class="space-y-1.5">
                  <h3 :class="CAPTION">{{ $t('instances.usageFilterWindows') }}</h3>
                  <!-- One card per quota window. Two windows and two thresholds, because "80% of
                       the week" and "50% of this 5-hour session" are different questions — see
                       lib/usage-filter.ts. -->
                  <UsageFilterWindow
                    v-model="weekEnabled"
                    :label="$t('instances.usageFilterWeek')"
                    :hint="$t('instances.usageFilterWeekHint')"
                    :threshold-label="$t('instances.usageFilterWeekThresholdLabel')"
                    :threshold="weekThreshold"
                    @update:threshold="setWeekThreshold"
                  />
                  <UsageFilterWindow
                    v-model="sessionEnabled"
                    :label="$t('instances.usageFilterSession')"
                    :hint="$t('instances.usageFilterSessionHint')"
                    :threshold-label="$t('instances.usageFilterSessionThresholdLabel')"
                    :threshold="sessionThreshold"
                    @update:threshold="setSessionThreshold"
                  />
                  <!-- Both windows off is a switched-on filter told to look at nothing. It is a
                       reachable state rather than a disabled switch, so it has to say so —
                       otherwise the only symptom is a table that stopped reacting. -->
                  <ExpandTransition :open="noWindows">
                    <p
                      class="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground"
                    >
                      {{ $t('instances.usageFilterNoWindows') }}
                    </p>
                  </ExpandTransition>
                </section>

                <section class="space-y-1.5">
                  <h3 :class="CAPTION">{{ $t('instances.usageFilterDisplay') }}</h3>
                  <div class="flex items-center gap-3 rounded-md border border-border bg-background/60 px-2.5 py-1.5">
                    <span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
                      {{ $t('instances.usageFilterHide') }}
                      <InfoHint :text="$t('instances.usageFilterHideHint')" />
                    </span>
                    <Switch v-model="hideMatches" />
                  </div>
                </section>
              </div>
            </ExpandTransition>

            <section class="space-y-1.5">
              <h3 :class="CAPTION">{{ $t('instances.usageDataTitle') }}</h3>
              <!-- The same rows Settings shows, from one source (components/UsageRefreshRows.vue).
                   The numbers this filter compares are only as fresh as this setting keeps them, so
                   it is the one other control that belongs in this flyout. Its rows carry their own
                   padding, so the card supplies only the frame. -->
              <div class="divide-y divide-border/60 rounded-md border border-border bg-background/60">
                <UsageRefreshRows />
              </div>
            </section>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  </IconTooltip>
</template>
