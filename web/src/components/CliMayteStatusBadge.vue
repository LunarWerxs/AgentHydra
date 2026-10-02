<script setup lang="ts">
// One CliMayte task status: icon + sentence-case label as a chip, with what it means on hover. Shared
// by the task list and the detail pane so the two always read the same (lib/climayte-status.ts).
// `iconOnly` is the list's compact form (owner, 2026-09-30: one line per task): the icon in the
// status colour, its label kept for screen readers and the hover.
//
// A failed task's icon says more on hover (owner, 2026-10-02): what failed, how it got there, what
// happened next and the end result (climayteFailedStory), when the list hands it the task and the
// loaded tasks. The detail pane prints the same lines.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CliMayteStatus, CliMayteWorkerView } from '@/lib/api'
import { CLIMAYTE_STATUS, climayteFailedStory, climayteStoryLines } from '@/lib/climayte-status'

const props = defineProps<{
  status: CliMayteStatus
  iconOnly?: boolean
  /** The task and every loaded task, for a failed task's story on hover (the list's icon). */
  task?: CliMayteWorkerView
  tasks?: CliMayteWorkerView[]
}>()
const { t } = useI18n()
const meta = computed(() => CLIMAYTE_STATUS[props.status])
const story = computed(() => {
  const s = props.task && props.tasks ? climayteFailedStory(props.task, props.tasks) : null
  return s ? climayteStoryLines(s, (key, values) => t(key, values)) : null
})

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
  <!-- `relative` holds the sr-only label (absolutely positioned) inside this icon. Without it the
       label's containing block was the page, so in a scrolled task list every row's label hung
       below the list and the whole CLI tab scrolled (4,777 px at 1920x1080, 2026-10-01). -->
  <Tooltip v-if="iconOnly && story">
    <TooltipTrigger as-child>
      <!-- The empty title keeps the row's own native hover from showing over the story. -->
      <span class="relative inline-flex shrink-0 items-center" :class="tone" title="">
        <component :is="meta.icon" class="size-3.5" aria-hidden="true" />
        <span class="sr-only">{{ $t(meta.label) }}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent side="right" align="start">
      <div class="flex flex-col items-start gap-1 text-start wrap-break-word">
        <div class="font-medium">{{ $t(meta.label) }}</div>
        <div
          v-for="(line, i) in story"
          :key="i"
          :class="i === story.length - 1 ? 'font-medium' : 'text-background/70'"
        >
          {{ line }}
        </div>
      </div>
    </TooltipContent>
  </Tooltip>
  <span
    v-else-if="iconOnly"
    class="relative inline-flex shrink-0 items-center"
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
  <Badge v-else :variant="meta.variant" :title="$t(meta.hint)">
    <component :is="meta.icon" :class="meta.spin ? 'animate-spin' : ''" aria-hidden="true" />
    <span class="text-2xs">{{ $t(meta.label) }}</span>
  </Badge>
</template>
