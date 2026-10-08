<script setup lang="ts">
// This chat's queue (Hydra Desk's own), stacked on top of the repo strip and the box, outside them: at
// most three rows, then "+N more". Rendered only while there are some, so the default captures do
// not change. A row's actions are on the row itself: its toolbar shows while it is hovered (edit, move,
// send now, remove) and its right-click menu has the same; a click opens the queue popover above the tray.
import { computed } from 'vue'
import type { QueueItem, QueueState } from '@shared/protocol'
import { icons } from '@/lib/icons'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { focusFirstItem, MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '@/components/sidebar/menuClasses'
import { queueBadge, queueRows, trayText } from './queue'
import { useQueueActions } from './queue-actions'
import QueueItemActions from './QueueItemActions.vue'

const props = defineProps<{ items: QueueItem[]; queue: QueueState; chatId: string | null }>()
const emit = defineEmits<{ open: [] }>()

const TRAY_ROWS = 3
// Up and down move within the item's own line in the server's queue, so the ends are the line's (queue.ts queueRows).
const ends = computed(() => new Map(queueRows(props.queue, props.chatId, new Map()).map((r) => [r.item.id, r])))
const rows = computed(() =>
  props.items.slice(0, TRAY_ROWS).map((item) => ({
    item,
    text: trayText(item),
    badge: queueBadge(item, props.queue.held),
    first: ends.value.get(item.id)?.first ?? true,
    last: ends.value.get(item.id)?.last ?? true
  }))
)
const more = computed(() => props.items.length - rows.value.length)

const { source, error, act, editing, draft, setEditor, startEdit, onEditKey } = useQueueActions((id) => props.items.some((i) => i.id === id))
</script>

<template>
  <ul
    role="list"
    aria-label="Queued for this chat"
    class="flex flex-col rounded-(--radius-12) border border-(--border) bg-(--bg-popover) p-1"
    data-queue-tray
  >
    <li v-for="(r, i) in rows" :key="r.item.id" class="group/t relative">
      <div v-if="editing === r.item.id" class="flex gap-1.5 px-1 py-0.5">
        <span class="tnum w-3 shrink-0 pt-1 text-[13px] text-(--text-muted)">{{ i + 1 }}</span>
        <div class="min-w-0 flex-1">
          <textarea
            :ref="setEditor"
            v-model="draft"
            rows="3"
            aria-label="Edit queued message"
            class="block w-full resize-none rounded-(--radius-6) bg-(--bg-page) px-1.5 py-1 text-[13px] leading-4.75 text-(--text) outline-none"
            @keydown="onEditKey($event, r.item)"
          />
          <p class="text-[12px] leading-4 text-(--text-muted)">Enter saves, Shift+Enter adds a line, Esc cancels</p>
        </div>
      </div>
      <ContextMenu v-else>
        <ContextMenuTrigger as-child>
          <button
            type="button"
            class="flex h-6 w-full items-center gap-1.5 rounded-(--radius-6) px-1 text-start text-[13px] text-(--text-2) transition-colors duration-60 hover:bg-(--fill-hover) hover:text-(--text) data-[state=open]:bg-(--fill-hover)"
            :aria-label="`Queued ${i + 1}: ${r.text}`"
            @click="emit('open')"
          >
            <span class="tnum w-3 shrink-0 text-(--text-muted)">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1 truncate">{{ r.text }}</span>
            <span
              v-if="r.badge"
              class="shrink-0 text-[12px]"
              :class="r.badge.tone === 'warn' ? 'text-(--warning-text)' : 'text-(--text-muted)'"
            >{{ r.badge.label }}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
          <ContextMenuItem v-if="r.item.state === 'failed'" :class="MENU_ITEM" @select="act(() => source.queueRetry?.(r.item.id))">
            <icons.queueRetry />Try again
          </ContextMenuItem>
          <ContextMenuItem v-else :class="MENU_ITEM" :disabled="r.item.state === 'sending'" @select="act(() => source.queueSendNow?.(r.item.id))">
            <icons.send />Send now
          </ContextMenuItem>
          <ContextMenuItem :class="MENU_ITEM" :disabled="r.item.state === 'sending'" @select="startEdit(r.item)">
            <icons.queueEdit />Edit
          </ContextMenuItem>
          <ContextMenuItem :class="MENU_ITEM" :disabled="r.first || r.item.state === 'sending'" @select="act(() => source.queueMove?.(r.item.id, -1))">
            <icons.queueMoveUp />Move up
          </ContextMenuItem>
          <ContextMenuItem :class="MENU_ITEM" :disabled="r.last || r.item.state === 'sending'" @select="act(() => source.queueMove?.(r.item.id, 1))">
            <icons.queueMoveDown />Move down
          </ContextMenuItem>
          <ContextMenuSeparator :class="MENU_SEPARATOR" />
          <ContextMenuItem :class="MENU_ITEM" :disabled="r.item.state === 'sending'" @select="act(() => source.queueRemove?.(r.item.id))">
            <icons.dismiss />Remove
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <QueueItemActions
        v-if="editing !== r.item.id && r.item.state !== 'sending'"
        class="absolute right-0 top-0 opacity-0 transition-opacity duration-150 group-focus-within/t:opacity-100 group-hover/t:opacity-100"
        :item="r.item"
        :first="r.first"
        :last="r.last"
        :act="act"
        @edit="startEdit(r.item)"
      />
    </li>
    <li v-if="more > 0">
      <button
        type="button"
        class="flex h-6 items-center rounded-(--radius-6) px-1 text-[12px] text-(--text-muted) transition-colors duration-60 hover:bg-(--fill-hover) hover:text-(--text)"
        @click="emit('open')"
      >
        +{{ more }} more queued
      </button>
    </li>
    <li v-if="error" role="alert" class="px-1 pt-0.5 text-[12px] text-(--warning-text)">{{ error }}</li>
  </ul>
</template>
