<script setup lang="ts">
// The one header every instance table on the Instances tab uses (Claude desktop, Claude CLI, Codex,
// DeepSeek): the provider's logo, title and count as the collapse toggle, then the table's own
// tools, Refresh and the create button. Four hand-built copies of this had drifted apart (owner,
// 2026-09-30: DeepSeek's create button was a full-width label, and its collapse was not kept).
//
// `meta` sits inside the toggle after the count (a "hidden by filter" note); with no `title` there is
// no toggle, and `meta` sits after `summary` instead. `summary` sits beside the toggle, outside its
// button, so it may hold a tooltip trigger (the CLI table's pooled gauges while it is folded), or the
// Instances table's kind choice, which takes the title's place (owner, 2026-10-07); `tools` sits before
// Refresh (the desktop table's usage-mode switch and filter menus).
//
// A table that mixes providers (desktop, Free) passes `createOptions`: the plus then opens one item
// per provider, its logo and label, and `create` carries the chosen option's id. An option's
// `section` starts a heading (after a separator) wherever it changes.
import { ChevronDown, Plus, RefreshCw } from '@lucide/vue'
import ProviderLogo, { type LogoProvider } from '@/components/ProviderLogo.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import IconTooltip from '@/shell/IconTooltip.vue'

const open = defineModel<boolean>('open', { default: true })

withDefaults(
  defineProps<{
    /** The provider's logo beside the title; omitted for a table that mixes providers. */
    provider?: LogoProvider
    /** Empty draws no toggle, for a table whose summary slot holds its own choice in the title's place. */
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
    /** One menu item per provider under the create button, instead of a plain button. */
    createOptions?: { id: string; provider: LogoProvider; label: string; section?: string }[]
    /** False hides the chevron (a table switched off in Settings has nothing to fold). */
    collapsible?: boolean
  }>(),
  {
    provider: undefined,
    count: null,
    countHint: undefined,
    refreshHint: undefined,
    createLabel: undefined,
    createOptions: undefined,
    collapsible: true,
  },
)

defineEmits<{ refresh: []; create: [id?: string] }>()
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-2 p-3">
    <div class="flex flex-wrap items-center gap-3">
    <button
      v-if="title"
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
    <slot v-if="!title" name="meta" />
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
      <!-- The DropdownMenu root sits INSIDE the tooltip's slot, wrapped in a span: see
           scripts/checks/reka-popper-root-inside-tooltip.mjs. -->
      <IconTooltip v-if="createLabel && createOptions?.length" :label="createLabel">
        <span class="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button size="icon" :aria-label="createLabel">
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <template v-for="(option, i) in createOptions" :key="option.id">
                <template v-if="option.section && option.section !== createOptions[i - 1]?.section">
                  <DropdownMenuSeparator v-if="i > 0" />
                  <DropdownMenuLabel>{{ option.section }}</DropdownMenuLabel>
                </template>
                <DropdownMenuItem @click="$emit('create', option.id)">
                  <ProviderLogo :provider="option.provider" class="size-3.5" />
                  {{ option.label }}
                </DropdownMenuItem>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </IconTooltip>
      <IconTooltip v-else-if="createLabel && !createOptions" :label="createLabel">
        <Button size="icon" :aria-label="createLabel" @click="$emit('create')">
          <Plus />
        </Button>
      </IconTooltip>
    </div>
  </div>
</template>
