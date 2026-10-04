<script setup lang="ts">
// The send/stop button with the send queue's way in (Hydra Desk's own). Resting the pointer on it for a
// second, or reaching it from the keyboard, shows a small up-chevron to its left; the chevron, a
// right-click, Shift+F10 or the Menu key open the queue popover. The chevron is absolutely placed outside
// the button's box, so the row keeps its layout and the default captures do not change.
// The popover is anchored to the group and has no trigger: both buttons sit in a Tip, and a Tip between a
// popover root and its trigger leaves the popper unplaced (sidebar/ChatRow.vue).
// The send button is aria-disabled, never `disabled`: a disabled button swallows the right-click and the hover,
// and the queue is wanted most when the box is empty.
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { icons } from '@/lib/icons'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import SendGlyph from './SendGlyph.vue'
import QueuePopover from './QueuePopover.vue'
import { createHoverIntent } from './queue'

const props = defineProps<{
  showStop: boolean
  canSend: boolean
  suggested: boolean
  sendLabel: string
  sendTip: string
  /** The source has a send queue; without one this is the plain send/stop button. */
  queue: boolean
  chatId: string | null
}>()
const open = defineModel<boolean>('open', { default: false })
/** `queue`: a Ctrl-click (Cmd-click), which always queues. */
const emit = defineEmits<{ send: [queue: boolean]; stop: []; 'close-focus': [] }>()

const ChevronUp = icons.queueOptions
const HOVER_MS = 1000

const group = ref<HTMLElement | null>(null)
const panelId = useId()
const hovered = ref(false)
const focused = ref(false)
const intent = createHoverIntent(HOVER_MS, (fn, ms) => setTimeout(fn, ms), (t) => clearTimeout(t), (v) => (hovered.value = v))
onBeforeUnmount(() => intent.dispose())

const chevron = computed(() => props.queue && (hovered.value || focused.value || open.value))
// The anchor can be hidden or swapped under an open popover on a chat switch, which leaves the popper
// at the window's corner: a switch closes it.
watch(() => props.chatId, () => (open.value = false))

function onEnter() {
  if (props.queue) intent.enter()
}
function onFocusIn(e: FocusEvent) {
  if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) focused.value = true
}
function onFocusOut(e: FocusEvent) {
  if (!(e.relatedTarget instanceof Node && group.value?.contains(e.relatedTarget))) focused.value = false
}
function onContextMenu(e: MouseEvent) {
  if (!props.queue) return
  e.preventDefault()
  open.value = true
}
function onSend(e: MouseEvent) {
  if (!props.canSend) return
  emit('send', e.ctrlKey || e.metaKey)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverAnchor as-child>
      <div
        ref="group"
        role="group"
        aria-label="Send"
        class="relative flex shrink-0"
        @pointerenter="onEnter"
        @pointerleave="intent.leave()"
        @focusin="onFocusIn"
        @focusout="onFocusOut"
        @contextmenu.capture="onContextMenu"
      >
        <button
          v-if="chevron"
          type="button"
          class="absolute bottom-0 right-full flex h-6 w-4 items-center justify-center rounded-[var(--radius-5)] bg-[var(--bg-popover)] transition-colors duration-[60ms] hover:text-[var(--text)] motion-safe:animate-in motion-safe:fade-in-0"
          :class="open ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'"
          aria-label="Queue options"
          aria-haspopup="dialog"
          :aria-expanded="open"
          :aria-controls="open ? panelId : undefined"
          @click="open = !open"
        >
          <ChevronUp class="size-3" />
        </button>
        <Tip v-if="showStop" label="Stop (Esc)" :disabled="chevron" side="top">
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)]"
            aria-label="Stop"
            @click="emit('stop')"
          >
            <span class="size-2.5 rounded-[2px] bg-current" />
          </button>
        </Tip>
        <Tip v-else :label="sendTip" :disabled="chevron" side="top">
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] transition-colors duration-[60ms]"
            :class="
              canSend
                ? 'text-[var(--text-2)] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]'
                : suggested
                  ? 'cursor-default text-[var(--send-suggested)]'
                  : 'cursor-default text-[var(--text-muted)]'
            "
            :aria-disabled="!canSend"
            :aria-label="sendLabel"
            @click="onSend"
          >
            <SendGlyph class="size-4" />
          </button>
        </Tip>
      </div>
    </PopoverAnchor>
    <QueuePopover v-if="queue" :chat-id="chatId" :anchor="group" :panel-id="panelId" @close-focus="emit('close-focus')" />
  </Popover>
</template>
