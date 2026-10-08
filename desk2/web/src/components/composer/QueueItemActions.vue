<script setup lang="ts">
// A queued message's hover toolbar, on the queue popover's rows and the tray's: edit, move up, move down,
// send now (try again once it failed), remove. The row places it and shows it on hover or focus.
import type { QueueItem } from '@shared/protocol'
import { icons } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { useShellSource } from '@/components/shell/source'
import { TOOL_ICON } from './menu'
import type { QueueAct } from './queue-actions'

defineProps<{ item: QueueItem; first: boolean; last: boolean; act: QueueAct }>()
const emit = defineEmits<{ edit: [] }>()

const source = useShellSource()
</script>

<template>
  <div class="flex items-center gap-0.5 rounded-(--radius-6) bg-(--bg-popover) p-0.5 shadow-(--shadow-menu-ringed)">
    <Tip label="Edit" side="top">
      <button type="button" :class="TOOL_ICON" aria-label="Edit" @click="emit('edit')">
        <icons.queueEdit class="size-3.5" />
      </button>
    </Tip>
    <Tip label="Move up" side="top">
      <button type="button" :class="TOOL_ICON" aria-label="Move up" :disabled="first" @click="act(() => source.queueMove?.(item.id, -1))">
        <icons.queueMoveUp class="size-3.5" />
      </button>
    </Tip>
    <Tip label="Move down" side="top">
      <button type="button" :class="TOOL_ICON" aria-label="Move down" :disabled="last" @click="act(() => source.queueMove?.(item.id, 1))">
        <icons.queueMoveDown class="size-3.5" />
      </button>
    </Tip>
    <Tip v-if="item.state === 'failed'" label="Try again" side="top">
      <button type="button" :class="TOOL_ICON" aria-label="Retry" @click="act(() => source.queueRetry?.(item.id))">
        <icons.queueRetry class="size-3.5" />
      </button>
    </Tip>
    <Tip v-else label="Send now" side="top">
      <button type="button" :class="TOOL_ICON" aria-label="Send now" @click="act(() => source.queueSendNow?.(item.id))">
        <icons.send class="size-3.5" />
      </button>
    </Tip>
    <Tip label="Remove" side="top">
      <button type="button" :class="TOOL_ICON" aria-label="Remove" @click="act(() => source.queueRemove?.(item.id))">
        <icons.dismiss class="size-3.5" />
      </button>
    </Tip>
  </div>
</template>
