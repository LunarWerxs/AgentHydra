<script setup lang="ts">
// The quick-instances window's usage filter — the compact sibling of UsageFilterMenu.vue.
//
// Same STATE and same RULE: both read composables/useUsageFilter.ts, which is a module singleton
// over lib/usage-filter.ts, so "set aside at 80% weekly" means one thing in this app and there is
// exactly one implementation of it. Both also render the same UsageFilterWindow control, so the
// thresholds cannot drift into two behaviours. What differs is only what a 3rem-tall compact window
// can afford to show: no auto-refresh rows (this window never starts a sweep — it reads the
// daemon's cache), and no tooltip-wrapped trigger.
//
// English inline and marked i18n-ignore, matching QuickInstancesApp.vue: quick mode deliberately
// does not install vue-i18n, so that it does not download or initialize the full catalog during a
// one-click launch. That is also why UsageFilterWindow takes its captions as props.
//
// The state this reads is mirrored through the daemon (composables/useSharedPrefs.ts), which is the
// point of the whole exercise: this window is often served from a DIFFERENT PORT than the full
// manager, so browser localStorage alone would forget the filter every time it ran standalone.
import { Funnel } from '@lucide/vue'
import { computed } from 'vue'
import UsageFilterWindow from '@/components/UsageFilterWindow.vue'
import { buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useUsageFilter } from '@/composables/useUsageFilter'
import { cn } from '@/lib/utils'
import ExpandTransition from '@/shell/ExpandTransition.vue'

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

/** How many rows the filter is currently keeping out of the tables, so a short list never looks
 *  like a discovery failure. Supplied by the parent, which owns the row lists. */
const props = withDefaults(defineProps<{ hiddenCount?: number }>(), { hiddenCount: 0 })

const triggerVariant = computed(() => (enabled.value ? 'secondary' : 'outline'))

/** The rule, compact enough for a toolbar button — a bare percentage is the weekly cap (the window
 *  that has always been the default) and the 5-hour line carries a "5h" tag, so the common
 *  single-window case stays as short as it was before there were two. Mirrors the wording of the
 *  full manager's chip. */
const triggerLabel = computed(() => {
  const { week, session } = rule.value
  if (week != null && session != null) return `${week}% · ${session}% 5h`
  if (session != null) return `${session}% 5h`
  if (week != null) return `${week}%`
  return 'off'
})

const CAPTION = 'text-[11px] font-semibold uppercase tracking-wider text-primary'
const presetLabel = (pct: number) => `${pct}%`
</script>

<template>
  <!-- i18n-ignore -->
  <Popover>
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn(buttonVariants({ variant: triggerVariant, size: enabled ? 'sm' : 'icon-sm' }))"
        aria-label="Usage filter"
        title="Set aside the accounts you've used up"
      >
        <Funnel />
        <span v-if="enabled" class="tabular-nums">{{ triggerLabel }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 p-0">
      <div class="space-y-3 px-3 py-3">
        <header class="space-y-1.5">
          <h2 class="text-sm font-semibold text-foreground">Usage filter</h2>
          <div class="flex items-center gap-3">
            <span class="min-w-0 flex-1 text-[13px] text-foreground">Filter by usage</span>
            <Switch v-model="enabled" />
          </div>
          <p class="text-[11px] leading-snug text-muted-foreground">
            Sets aside instances whose quota is spent. An instance that has never been checked is
            never set aside.
          </p>
        </header>

        <!-- Everything below is dead weight while the filter is off — collapse it rather than
             leaving thresholds you can set and controls that do nothing. -->
        <ExpandTransition :open="enabled">
          <div class="space-y-3">
            <section class="space-y-1.5">
              <h3 :class="CAPTION">Windows</h3>
              <UsageFilterWindow
                v-model="weekEnabled"
                label="Weekly usage"
                hint="The all-models weekly cap — the number that decides whether an account is worth starting on at all."
                threshold-label="Weekly threshold, percent"
                threshold-caption="Set aside at"
                :preset-label="presetLabel"
                :threshold="weekThreshold"
                @update:threshold="setWeekThreshold"
              />
              <UsageFilterWindow
                v-model="sessionEnabled"
                label="5-hour session"
                hint="The rolling session window — whether an account is usable right now, rather than at all this week."
                threshold-label="Session threshold, percent"
                threshold-caption="Set aside at"
                :preset-label="presetLabel"
                :threshold="sessionThreshold"
                @update:threshold="setSessionThreshold"
              />
              <!-- Both windows off is a switched-on filter told to look at nothing. It is a
                   reachable state rather than a disabled switch, so it has to say so — otherwise
                   the only symptom is a table that stopped reacting. -->
              <ExpandTransition :open="noWindows">
                <p
                  class="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground"
                >
                  The filter is on but measuring nothing. Turn on a window above.
                </p>
              </ExpandTransition>
            </section>

            <section class="space-y-1.5">
              <h3 :class="CAPTION">Display</h3>
              <div
                class="flex items-center gap-3 rounded-md border border-border bg-background/60 px-2.5 py-1.5"
              >
                <span class="min-w-0 flex-1 text-[13px] text-foreground">Hide instead of dim</span>
                <Switch v-model="hideMatches" />
              </div>
              <p v-if="hideMatches && props.hiddenCount" class="text-[11px] text-muted-foreground">
                {{ props.hiddenCount }} hidden by this filter.
              </p>
            </section>
          </div>
        </ExpandTransition>
      </div>
    </PopoverContent>
  </Popover>
</template>
