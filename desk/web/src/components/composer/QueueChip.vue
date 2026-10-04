<script setup lang="ts">
// While a permission, question or plan card stands in for the box, the box's queue tray and send button
// are hidden with it; this chip (Hydra Desk's own, shaped like the dock's other chips) opens the same
// queue popover from the dock instead.
import { ref, watch } from 'vue'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import QueuePopover from './QueuePopover.vue'

const props = defineProps<{ count: number; chatId: string | null }>()

const open = ref(false)
const button = ref<HTMLButtonElement | null>(null)
// Another chat's dock is another queue line: the popover does not carry over.
watch(() => props.chatId, () => (open.value = false))
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        ref="button"
        type="button"
        class="tnum flex h-6 items-center self-start rounded-[var(--radius-6)] bg-[var(--fill-5)] px-[7px] text-[13px] leading-[19px] text-[var(--text-2)] shadow-[inset_0_0_0_1px_var(--border)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
        aria-haspopup="dialog"
      >
        {{ count }} queued
      </button>
    </PopoverTrigger>
    <QueuePopover :chat-id="chatId" @close-focus="button?.focus()" />
  </Popover>
</template>
