<script setup lang="ts">
// The send/stop button with the send queue's way in (Hydra Desk's own). Resting the pointer on it for a
// second, or reaching it from the keyboard, shows a small up-chevron to its left that opens the queue
// popover. A right-click (or Shift+F10, the Menu key) is a short menu: what Enter does by default, and
// Resume while this chat's queue is held. The chevron is absolutely placed outside the button's box, so the
// row keeps its layout and the default captures do not change.
// The popover has no trigger and is placed by reference: above the queue tray while it shows (opened from a
// tray row or the chevron, it rises over the tray, never across it), else above this group. Both buttons
// sit in a Tip, and a Tip between a popover root and its trigger leaves the popper unplaced (sidebar/ChatRow.vue).
// The send button is aria-disabled, never `disabled`: a disabled button swallows the right-click and the hover,
// and the queue is wanted most when the box is empty.
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { icons } from '@/lib/icons'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { focusFirstItem, MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '@/components/sidebar/menuClasses'
import { useShellSource } from '@/components/shell/source'
import { Tip } from '@/components/ui/tooltip'
import SendGlyph from './SendGlyph.vue'
import QueuePopover from './QueuePopover.vue'
import { HEADER } from './menu'
import { createHoverIntent, SEND_MODES } from './queue'

const props = defineProps<{
  showStop: boolean
  canSend: boolean
  suggested: boolean
  sendLabel: string
  sendTip: string
  /** The source has a send queue; without one this is the plain send/stop button. */
  queue: boolean
  chatId: string | null
  /** What the popover rises from instead of this group: the queue tray while it shows. */
  anchor?: HTMLElement | null
}>()
const open = defineModel<boolean>('open', { default: false })
/** `queue`: a Ctrl-click (Cmd-click), which always queues. */
const emit = defineEmits<{ send: [queue: boolean]; stop: []; 'close-focus': [] }>()

const ChevronUp = icons.queueOptions
const Check = icons.check
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

// The right-click menu: Enter's default, and Resume for this chat's held queue.
const source = useShellSource()
const sendMode = computed(() => source.queue?.value?.sendMode ?? null)
const held = computed(() => !!(props.chatId && source.queue?.value?.held[props.chatId]))
function onSend(e: MouseEvent) {
  if (!props.canSend) return
  emit('send', e.ctrlKey || e.metaKey)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverAnchor as="template" :reference="anchor ?? group ?? undefined" />
    <ContextMenu>
      <ContextMenuTrigger as-child :disabled="!queue">
        <div
          ref="group"
          role="group"
          aria-label="Send"
          class="relative flex shrink-0"
          @pointerenter="onEnter"
          @pointerleave="intent.leave()"
          @focusin="onFocusIn"
          @focusout="onFocusOut"
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
      </ContextMenuTrigger>
      <ContextMenuContent :class="MENU_CONTENT" aria-label="Send options" @open-auto-focus="focusFirstItem">
        <ContextMenuLabel :class="HEADER">Enter</ContextMenuLabel>
        <ContextMenuItem
          v-for="m in SEND_MODES"
          :key="m.value"
          :class="MENU_ITEM"
          @select="source.queueSettings?.({ sendMode: m.value })"
        >
          <span class="flex-1">{{ m.label }}</span>
          <Check v-if="sendMode === m.value" class="size-3.5 text-[var(--accent)]" :stroke-width="3" />
        </ContextMenuItem>
        <template v-if="held">
          <ContextMenuSeparator :class="MENU_SEPARATOR" />
          <ContextMenuItem :class="MENU_ITEM" @select="source.queueResume?.(chatId!)">Resume this chat's queue</ContextMenuItem>
        </template>
      </ContextMenuContent>
    </ContextMenu>
    <QueuePopover v-if="queue" :chat-id="chatId" :anchors="[group, anchor]" :panel-id="panelId" @close-focus="emit('close-focus')" />
  </Popover>
</template>
