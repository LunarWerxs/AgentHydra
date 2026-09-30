<script setup lang="ts">
// The one header every instance table on the Instances tab uses (Claude desktop, Claude CLI, Codex,
// DeepSeek): the provider's logo, title and count as the collapse toggle, then the table's own
// tools, Refresh and the create pill. Four hand-built copies of this had drifted apart (owner,
// 2026-09-30: DeepSeek's create button was a full-width label, and its collapse was not kept).
//
// `meta` sits inside the toggle after the count (a "linked elsewhere" or "hidden by filter" note);
// `tools` sits before Refresh (the desktop table's usage-mode switch and filter menus).
import { ChevronDown, Plus, RefreshCw } from '@lucide/vue'
import ProviderLogo, { type Provider } from '@/components/ProviderLogo.vue'
import { Button } from '@/components/ui/button'
import IconTooltip from '@/shell/IconTooltip.vue'

const open = defineModel<boolean>('open', { required: true })

withDefaults(
  defineProps<{
    provider: Provider
    title: string
    /** In brackets after the title ("4", "4 of 6"); null or omitted shows none. */
    count?: string | number | null
    refreshLabel: string
    /** A second tooltip line for Refresh, when what it re-reads is not obvious. */
    refreshHint?: string
    refreshing?: boolean
    refreshDisabled?: boolean
    /** The create pill's label, shown on hover; omitted means no create button. */
    createLabel?: string
    /** False hides the chevron (a table switched off in Settings has nothing to fold). */
    collapsible?: boolean
  }>(),
  { count: null, refreshHint: undefined, createLabel: undefined, collapsible: true },
)

defineEmits<{ refresh: []; create: [] }>()
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-2 p-3">
    <button
      type="button"
      class="flex items-center gap-2 rounded-md text-sm font-semibold transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      :aria-expanded="collapsible ? open : undefined"
      @click="collapsible && (open = !open)"
    >
      <ProviderLogo :provider="provider" class="size-4" />
      {{ title }}
      <span v-if="count !== null && count !== ''" class="text-muted-foreground">({{ count }})</span>
      <slot name="meta" />
      <ChevronDown
        v-if="collapsible"
        class="size-4 text-muted-foreground transition-transform duration-200"
        :class="open ? '' : '-rotate-90'"
      />
    </button>
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
      <!-- Plus at rest, label on hover/focus: every other control here is an icon, and a
           permanently labelled button set the row's width for a phrase read once. -->
      <Button
        v-if="createLabel"
        size="sm"
        class="group/create overflow-hidden"
        :aria-label="createLabel"
        @click="$emit('create')"
      >
        <span class="inline-flex items-center">
          <Plus class="shrink-0" />
          <span
            class="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/create:ms-1.5 group-hover/create:max-w-36 group-hover/create:opacity-100 group-focus-visible/create:ms-1.5 group-focus-visible/create:max-w-36 group-focus-visible/create:opacity-100"
          >{{ createLabel }}</span>
        </span>
      </Button>
    </div>
  </div>
</template>
