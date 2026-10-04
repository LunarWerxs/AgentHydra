<script setup lang="ts">
// The send queue's popover (Hydra Desk's own: the real app's queued-message UI has no reference here):
// pause, what a plain Enter does, the held chats, and the queued messages and new chats with their
// actions. Content only; the send button's split (anchored, no trigger) and the dock chip each own the
// Popover root. Everything goes to the server, which owns the queue; a refusal shows its words here.
import { computed, nextTick, ref } from 'vue'
import type { QueueItem, QueueSendMode } from '@shared/protocol'
import { icons } from '@/lib/icons'
import { PopoverContent } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useShellSource } from '@/components/shell/source'
import { DESCRIPTION, HEADER, ITEM, MENU, SEPARATOR, TOOL_BUTTON, TOOL_ICON } from './menu'
import { heldRows, queueRows } from './queue'

const props = defineProps<{
  chatId: string | null
  /** The anchor group: a press inside it (the chevron, the send button) must not count as outside. */
  anchor?: HTMLElement | null
  /** The id the opener's aria-controls names. */
  panelId?: string
}>()
const emit = defineEmits<{ 'close-focus': [] }>()

const Check = icons.check

const source = useShellSource()
const queue = computed(() => source.queue?.value ?? null)
const titles = computed(() => new Map(source.chats.value.map((c) => [c.id, c.title])))
const rows = computed(() => queueRows(queue.value, props.chatId, titles.value))
const holds = computed(() => heldRows(queue.value, titles.value))

const MODES: { value: QueueSendMode; label: string; hint: string }[] = [
  { value: 'immediate', label: 'Send immediately', hint: 'Goes to the running turn right away' },
  {
    value: 'queue',
    label: 'Send as a queue',
    hint: 'Waits until the chat finishes its turn, and a new chat until an account has room. Ctrl+Enter does this while a turn runs'
  }
]

const error = ref<string | null>(null)
async function act(fn: () => Promise<unknown> | undefined): Promise<boolean> {
  error.value = null
  try {
    await fn()
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return false
  }
}

// Inline edit: Enter saves, Shift+Enter is a new line, Esc cancels the edit (not the popover).
const editing = ref<string | null>(null)
const draft = ref('')
// The rev the draft was taken from: another window's edit meanwhile makes the save a refusal, not an overwrite.
let editRev = 0
let editor: HTMLTextAreaElement | null = null
function setEditor(el: unknown) {
  editor = el instanceof HTMLTextAreaElement ? el : null
}
function startEdit(item: QueueItem) {
  editing.value = item.id
  editRev = item.rev
  draft.value = item.text
  nextTick(() => {
    editor?.focus()
    editor?.setSelectionRange(draft.value.length, draft.value.length)
  })
}
async function saveEdit(item: QueueItem) {
  const text = draft.value.trim()
  if (!text && !item.images?.length) return
  editing.value = null
  if (text === item.text.trim()) return
  // A refused save reopens the edit with the text kept, unless the item went out meanwhile.
  if (!(await act(() => source.queueEdit?.(item.id, { text, ifRev: editRev }))) && listed(item.id)) {
    startEdit(item)
    draft.value = text
  }
}
function listed(id: string) {
  return rows.value.some((r) => r.item.id === id)
}
function onEditKey(e: KeyboardEvent, item: QueueItem) {
  if (e.isComposing) return
  if (e.key === 'Escape') {
    // Kept from the popover's own Esc either way round: stopped here, and onEscape refuses while editing.
    e.preventDefault()
    e.stopPropagation()
    editing.value = null
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    saveEdit(item)
  }
}
function onEscape(e: KeyboardEvent) {
  if (editing.value && listed(editing.value)) e.preventDefault()
}

function onOutside(e: CustomEvent<{ originalEvent: Event }>) {
  const target = e.detail.originalEvent.target
  if (props.anchor && target instanceof Node && props.anchor.contains(target)) e.preventDefault()
}
function onCloseFocus(e: Event) {
  e.preventDefault()
  editing.value = null
  emit('close-focus')
}
</script>

<template>
  <PopoverContent
    side="top"
    align="end"
    :side-offset="6"
    role="dialog"
    aria-label="Message queue"
    :class="[MENU, 'w-[360px] max-w-none gap-0 overflow-y-auto']"
    @interact-outside="onOutside"
    @escape-key-down="onEscape"
    @close-auto-focus="onCloseFocus"
  >
    <div :id="panelId" class="flex flex-col">
      <div class="flex items-center gap-1.5 pr-1">
        <h2 :class="HEADER" class="flex-1">
          Queue
          <span class="tnum ml-1.5 font-normal">{{ queue?.items.length ?? 0 }}{{ queue?.paused ? ', paused' : '' }}</span>
        </h2>
        <button type="button" :class="TOOL_BUTTON" @click="act(() => source.queueSettings?.({ paused: !queue?.paused }))">
          {{ queue?.paused ? 'Resume' : 'Pause' }}
        </button>
      </div>

      <div role="radiogroup" aria-label="When you press Enter">
        <div :class="HEADER">When you press Enter</div>
        <button
          v-for="m in MODES"
          :key="m.value"
          type="button"
          role="radio"
          :aria-checked="queue?.sendMode === m.value"
          :class="ITEM"
          class="flex w-full cursor-default items-center py-1 text-left outline-none hover:bg-[var(--fill-hover)]"
          @click="act(() => source.queueSettings?.({ sendMode: m.value }))"
        >
          <span class="flex min-w-0 flex-1 flex-col">
            <span>{{ m.label }}</span>
            <span :class="DESCRIPTION">{{ m.hint }}</span>
          </span>
          <span class="flex w-4 shrink-0 items-center justify-center">
            <Check v-if="queue?.sendMode === m.value" class="size-3.5 text-[var(--accent)]" :stroke-width="3" />
          </span>
        </button>
      </div>

      <div role="separator" :class="SEPARATOR" />

      <div
        v-for="h in holds"
        :key="h.chatId"
        class="mb-1 flex items-center gap-2 rounded-[var(--radius-6)] bg-[var(--warning-bg)] py-1 pl-2 pr-1 text-[var(--warning-text)]"
      >
        <span class="min-w-0 flex-1 truncate">{{ h.text }}</span>
        <button type="button" :class="TOOL_BUTTON" @click="act(() => source.queueResume?.(h.chatId))">Resume</button>
      </div>

      <p v-if="!rows.length" class="px-2 py-1.5 text-[var(--text-muted)]">Nothing queued. Ctrl+Enter adds a message.</p>
      <ul v-else role="list" aria-label="Queued messages" class="flex flex-col">
        <li
          v-for="row in rows"
          :key="row.item.id"
          class="group/q relative flex gap-2 rounded-[var(--radius-6)] px-2 py-1 focus-within:bg-[var(--fill-hover)] hover:bg-[var(--fill-hover)]"
        >
          <span class="tnum w-3 shrink-0 text-right text-[var(--text-muted)]">{{ row.position }}</span>
          <div class="min-w-0 flex-1">
            <span
              v-if="row.chip"
              class="inline-block max-w-full truncate rounded-[var(--radius-4)] bg-[var(--fill-secondary)] px-1 align-top text-[11px] leading-4 text-[var(--text-2)]"
            >{{ row.chip }}</span>
            <template v-if="editing === row.item.id">
              <textarea
                :ref="setEditor"
                v-model="draft"
                rows="3"
                aria-label="Edit queued message"
                class="block w-full resize-none rounded-[var(--radius-6)] bg-[var(--bg-page)] px-1.5 py-1 text-[13px] leading-[19px] text-[var(--text)] outline-none"
                @keydown="onEditKey($event, row.item)"
              />
              <p class="text-[12px] leading-4 text-[var(--text-muted)]">Enter saves, Shift+Enter adds a line, Esc cancels</p>
            </template>
            <p v-else class="line-clamp-2 whitespace-pre-wrap break-words">{{ row.text }}</p>
            <p v-if="row.images || row.badge" class="flex gap-1.5 text-[12px] leading-4 text-[var(--text-muted)]">
              <span v-if="row.images" class="shrink-0">{{ row.images }}</span>
              <span v-if="row.badge" class="min-w-0" :class="row.badge.tone === 'warn' ? 'text-[var(--warning-text)]' : ''">
                {{ row.badge.label }}{{ row.badge.reason ? `: ${row.badge.reason}` : '' }}
              </span>
            </p>
          </div>
          <div
            v-if="editing !== row.item.id && row.item.state !== 'sending'"
            class="absolute right-1 top-1 flex items-center gap-0.5 rounded-[var(--radius-6)] bg-[var(--bg-popover)] p-0.5 opacity-0 shadow-(--shadow-menu-ringed) transition-opacity duration-150 group-focus-within/q:opacity-100 group-hover/q:opacity-100"
          >
            <Tip label="Edit" side="top">
              <button type="button" :class="TOOL_ICON" aria-label="Edit" @click="startEdit(row.item)">
                <icons.queueEdit class="size-3.5" />
              </button>
            </Tip>
            <Tip label="Move up" side="top">
              <button type="button" :class="TOOL_ICON" aria-label="Move up" :disabled="row.first" @click="act(() => source.queueMove?.(row.item.id, -1))">
                <icons.queueMoveUp class="size-3.5" />
              </button>
            </Tip>
            <Tip label="Move down" side="top">
              <button type="button" :class="TOOL_ICON" aria-label="Move down" :disabled="row.last" @click="act(() => source.queueMove?.(row.item.id, 1))">
                <icons.queueMoveDown class="size-3.5" />
              </button>
            </Tip>
            <Tip v-if="row.item.state === 'failed'" label="Try again" side="top">
              <button type="button" :class="TOOL_ICON" aria-label="Retry" @click="act(() => source.queueRetry?.(row.item.id))">
                <icons.queueRetry class="size-3.5" />
              </button>
            </Tip>
            <Tip v-else label="Send now: right away, into the running turn if the chat is working" side="top">
              <button type="button" :class="TOOL_ICON" aria-label="Send now" @click="act(() => source.queueSendNow?.(row.item.id))">
                <icons.send class="size-3.5" />
              </button>
            </Tip>
            <Tip label="Remove" side="top">
              <button type="button" :class="TOOL_ICON" aria-label="Remove" @click="act(() => source.queueRemove?.(row.item.id))">
                <icons.dismiss class="size-3.5" />
              </button>
            </Tip>
          </div>
        </li>
      </ul>

      <p v-if="error" class="px-2 pb-0.5 pt-1 text-[12px] text-[var(--warning-text)]" role="alert">{{ error }}</p>
    </div>
  </PopoverContent>
</template>
