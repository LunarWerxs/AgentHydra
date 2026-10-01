<script setup lang="ts">
// One CliMayte task status: icon + sentence-case label as a chip, with what it means on hover. Shared
// by the task list and the detail pane so the two always read the same (lib/climayte-status.ts).
// `iconOnly` is the list's compact form (owner, 2026-09-30: one line per task): the icon in the
// status colour, its label kept for screen readers and the hover.
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import type { CliMayteStatus } from '@/lib/api'
import { CLIMAYTE_STATUS } from '@/lib/climayte-status'

const props = defineProps<{ status: CliMayteStatus; iconOnly?: boolean }>()
const meta = computed(() => CLIMAYTE_STATUS[props.status])

/** The chip's colour, for the bare icon. */
const ICON_TONE: Record<string, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
}
const tone = computed(() => ICON_TONE[meta.value.variant ?? ''] ?? 'text-muted-foreground')
</script>

<template>
  <span
    v-if="iconOnly"
    class="inline-flex shrink-0 items-center"
    :class="tone"
    :title="`${$t(meta.label)}: ${$t(meta.hint)}`"
  >
    <component
      :is="meta.icon"
      class="size-3.5"
      :class="meta.spin ? 'animate-spin' : ''"
      aria-hidden="true"
    />
    <span class="sr-only">{{ $t(meta.label) }}</span>
  </span>
  <Badge v-else :variant="meta.variant" class="h-5 text-2xs" :title="$t(meta.hint)">
    <component :is="meta.icon" :class="meta.spin ? 'animate-spin' : ''" aria-hidden="true" />
    {{ $t(meta.label) }}
  </Badge>
</template>
