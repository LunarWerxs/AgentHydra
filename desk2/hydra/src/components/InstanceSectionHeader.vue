<script setup lang="ts">
// The one header every instance table on the Instances tab uses (Claude desktop, Claude CLI, Codex,
// DeepSeek): the provider's logo, title and count as the collapse toggle, then the table's own
// tools, Refresh and the create button. Four hand-built copies of this had drifted apart (owner,
// 2026-09-30: DeepSeek's create button was a full-width label, and its collapse was not kept).
//
// `meta` sits inside the toggle after the count (a "hidden by filter" note); `summary` sits beside
// the toggle, outside its button, so it may hold a tooltip trigger (the CLI table's pooled gauges
// while it is folded); `tools` sits before Refresh (the desktop table's usage-mode switch and filter
// menus).
import { ChevronDown, Plus, RefreshCw } from '@lucide/vue'
import ProviderLogo, { type Provider } from '@/components/ProviderLogo.vue'
import { Button } from '@/components/ui/button'
import IconTooltip from '@/shell/IconTooltip.vue'

const open = defineModel<boolean>('open', { default: true })

withDefaults(
  defineProps<{
    /** The provider's logo beside the title; omitted for a table that mixes providers. */
    provider?: Provider
    title: string
    /** In brackets after the title ("4", "4 of 6"); null or omitted shows none. */
    count?: string | number | null
    /** Hover text on the count, for why it says "x of y" (rows that live in another table). */
    countHint?: string
    refreshLabel: string
    /** A second tooltip line for Refresh, when what it re-reads is not obvious. */
    refreshHint?: string
    refreshing?: boolean
    refreshDisabled?: boolean
    /** The create button's label, its tooltip; omitted means no create button. */
    createLabel?: string
    /** False hides the chevron (a table switched off in Settings has nothing to fold). */
    collapsible?: boolean
  }>(),
  {
    provider: undefined,
    count: null,
    countHint: undefined,
    refreshHint: undefined,
    createLabel: undefined,
    collapsible: true,
  },
)

defineEmits<{ refresh: []; create: [] }>()
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-2 p-3">
    <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="flex items-center gap-2 rounded-md text-sm font-semibold transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      :aria-expanded="collapsible ? open : undefined"
      @click="collapsible && (open = !open)"
    >
      <ProviderLogo v-if="provider" :provider="provider" class="size-4" />
      {{ title }}
      <span v-if="count !== null && count !== ''" class="text-muted-foreground" :title="countHint">
        ({{ count }})
      </span>
      <slot name="meta" />
      <ChevronDown
        v-if="collapsible"
        class="size-4 text-muted-foreground transition-transform duration-200"
        :class="open ? '' : '-rotate-90'"
      />
    </button>
    <slot name="summary" />
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <slot name="tools" />
      <IconTooltip :label="refreshLabel" :description="refreshHint">
        <Button
          variant="outline"
          size="icon"
          :disabled="refreshDisabled || refreshing"
          :aria-label="refreshLabel"
          @click="$emit('refresh')"
        >
          <RefreshCw :class="refreshing ? 'animate-spin' : ''" />
        </Button>
      </IconTooltip>
      <!-- An icon with a tooltip, like its neighbours. It used to widen on hover to show its label:
           in a full row that wrapped it onto the next line, out from under the pointer, so it
           shrank, came back and widened again, many times a second (owner, 2026-10-01). Nothing in
           this row changes size on hover. -->
      <IconTooltip v-if="createLabel" :label="createLabel">
        <Button size="icon" :aria-label="createLabel" @click="$emit('create')">
          <Plus />
        </Button>
      </IconTooltip>
    </div>
  </div>
</template>
