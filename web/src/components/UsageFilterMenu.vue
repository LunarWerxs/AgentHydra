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
import { Funnel } from '@lucide/vue'
import { computed } from 'vue'
import UsageRefreshRows from '@/components/UsageRefreshRows.vue'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useUsageFilter } from '@/composables/useUsageFilter'
import { USAGE_THRESHOLD_PRESETS, type UsageFilterScope } from '@/lib/usage-filter'
import { cn } from '@/lib/utils'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { enabled, threshold, hideMatches, scope, setThreshold } = useUsageFilter()

/** Scope choices, default first: the weekly cap (the Usage column) is what decides whether an
 *  account is worth starting on; the 5-hour session and the either-of-the-two reading are the
 *  narrower questions you opt into. */
const SCOPES: Array<{ value: UsageFilterScope; labelKey: string }> = [
  { value: 'week', labelKey: 'instances.usageFilterScopeWeek' },
  { value: 'session', labelKey: 'instances.usageFilterScopeSession' },
  { value: 'either', labelKey: 'instances.usageFilterScopeEither' },
]

// The trigger carries the current threshold when the filter is on, so the toolbar says what the
// table is doing without needing the flyout opened. `secondary` matches the pressed usage-mode
// toggle beside it, which is the established "this mode is on" signal in this toolbar.
const triggerVariant = computed(() => (enabled.value ? 'secondary' : 'outline'))
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
            <span v-if="enabled" class="tabular-nums">
              {{ $t('instances.usageFilterThresholdValue', { pct: threshold }) }}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-80 p-0">
          <p
            class="px-3.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {{ $t('instances.usageFilterTitle') }}
          </p>
          <div class="divide-y divide-border/60">
            <SettingsRow :label="$t('instances.usageFilterEnable')">
              <template #info>
                <InfoHint :text="$t('instances.usageFilterHint')" />
              </template>
              <template #control>
                <Switch v-model="enabled" />
              </template>
            </SettingsRow>

            <!-- Everything below is dead weight while the filter is off — collapse it rather than
                 leaving a threshold you can set and three controls that do nothing. -->
            <ExpandTransition :open="enabled">
              <div class="divide-y divide-border/60">
                <div class="space-y-2 px-3.5 py-2.5">
                  <div class="flex items-center justify-between gap-3">
                    <span class="flex items-center gap-1.5 text-sm text-foreground">
                      {{ $t('instances.usageFilterThreshold') }}
                      <InfoHint :text="$t('instances.usageFilterThresholdHint')" />
                    </span>
                    <div class="flex items-center gap-1 text-[13px] text-muted-foreground">
                      <Input
                        class="h-7 w-16 text-right"
                        type="number"
                        min="0"
                        max="100"
                        :model-value="threshold"
                        @change="(e: Event) => setThreshold((e.target as HTMLInputElement).value)"
                      />
                      <span>%</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-1">
                    <Button
                      v-for="preset in USAGE_THRESHOLD_PRESETS"
                      :key="preset"
                      :variant="threshold === preset ? 'secondary' : 'ghost'"
                      size="xs"
                      class="flex-1"
                      :aria-pressed="threshold === preset"
                      @click="setThreshold(preset)"
                    >
                      {{ $t('instances.usageFilterThresholdValue', { pct: preset }) }}
                    </Button>
                  </div>
                </div>

                <SettingsRow :label="$t('instances.usageFilterHide')">
                  <template #info>
                    <InfoHint :text="$t('instances.usageFilterHideHint')" />
                  </template>
                  <template #control>
                    <Switch v-model="hideMatches" />
                  </template>
                </SettingsRow>

                <div class="space-y-2 px-3.5 py-2.5">
                  <span class="flex items-center gap-1.5 text-sm text-foreground">
                    {{ $t('instances.usageFilterScope') }}
                    <InfoHint :text="$t('instances.usageFilterScopeHint')" />
                  </span>
                  <div class="flex items-center gap-1">
                    <Button
                      v-for="option in SCOPES"
                      :key="option.value"
                      :variant="scope === option.value ? 'secondary' : 'ghost'"
                      size="xs"
                      class="flex-1"
                      :aria-pressed="scope === option.value"
                      @click="scope = option.value"
                    >
                      {{ $t(option.labelKey) }}
                    </Button>
                  </div>
                </div>
              </div>
            </ExpandTransition>
          </div>

          <p
            class="px-3.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {{ $t('instances.usageDataTitle') }}
          </p>
          <!-- The same rows Settings shows, from one source (components/UsageRefreshRows.vue). The
               numbers this filter compares are only as fresh as this setting keeps them, so it is
               the one other control that belongs in this flyout. -->
          <div class="divide-y divide-border/60">
            <UsageRefreshRows />
          </div>
        </PopoverContent>
      </Popover>
    </span>
  </IconTooltip>
</template>
