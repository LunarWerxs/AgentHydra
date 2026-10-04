<script setup lang="ts">
// The plus menu's Connectors: the MCP servers a chat here loads (the account's user servers, the folder's
// .mcp.json, Hydra Desk's agenthydra). In a live chat each row shows the session's state and a click
// turns the server on or off in that session; otherwise the rows only inform.
import { computed, ref, watch } from 'vue'
import type { McpServerInfo, McpStatus } from '@shared/protocol'
import { composerIcons } from '@/lib/icons'
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import type { ComposerApi } from './api'
import { mcpRows, type McpDot, type McpRow } from './mcp'
import { ITEM, MENU, MENU_GLYPH, SHORTCUT, SUB_TRIGGER } from './menu'

const props = defineProps<{
  api: ComposerApi
  cwd: string | null
  chatId: string | null
  /** The config dir of the account the chat runs on (or would, for a new one). */
  configDir: () => Promise<string | null>
}>()
const emit = defineEmits<{ error: [message: string] }>()

const DOT: Record<McpDot, string> = {
  connected: 'bg-[var(--success)]',
  failed: 'bg-[var(--danger)]',
  pending: 'bg-[var(--text-muted)]',
  off: 'border border-[var(--text-muted)]'
}

const servers = ref<McpServerInfo[] | null>(null)
const status = ref<McpStatus | null>(null)
const failed = ref(false)
const rows = computed(() => mcpRows(servers.value ?? [], status.value))
const dots = computed(() => rows.value.some((r) => r.dot))
const empty = computed(() => {
  if (!servers.value) return failed.value ? 'Could not read the MCP servers' : 'Loading…'
  return props.cwd ? 'No MCP servers' : 'Pick a folder to see its MCP servers'
})

// The component outlives a chat switch, so a load that lands after the switch (or after a newer load) must
// not overwrite the rows, and a click always acts on the chat whose rows it was shown for.
let loadSeq = 0
watch(
  () => [props.chatId, props.cwd] as const,
  () => {
    loadSeq++
    servers.value = null
    status.value = null
    failed.value = false
  }
)

async function load(open: boolean) {
  if (!open) return
  const seq = ++loadSeq
  const { api, cwd, chatId } = props
  failed.value = false
  const [list, live] = await Promise.all([
    cwd ? props.configDir().then((dir) => api.mcpServers(cwd, dir)).catch(() => null) : [],
    chatId ? api.mcpStatus(chatId).catch(() => null) : null
  ])
  if (seq !== loadSeq) return
  failed.value = list === null
  servers.value = list
  status.value = live
}

async function toggle(row: McpRow, e: Event) {
  e.preventDefault() // the menu stays open so the dot can change
  const chatId = props.chatId
  if (row.toggleTo === null || !chatId) return
  try {
    await props.api.toggleMcp(chatId, row.name, row.toggleTo)
  } catch (err) {
    emit('error', `Could not turn ${row.name} ${row.toggleTo ? 'on' : 'off'}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  // The toggle took; a failed re-read only leaves the old dot until the next open.
  const live = await props.api.mcpStatus(chatId).catch(() => null)
  if (live && props.chatId === chatId) status.value = live
}
</script>

<template>
  <DropdownMenuSub @update:open="load">
    <DropdownMenuSubTrigger :class="[ITEM, SUB_TRIGGER]">
      <composerIcons.connectors :class="MENU_GLYPH" />
      Connectors
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent :class="MENU">
      <DropdownMenuItem v-if="!rows.length" :class="ITEM" disabled>{{ empty }}</DropdownMenuItem>
      <DropdownMenuItem v-for="r in rows" :key="r.name" :class="ITEM" :title="r.title" @select="(e: Event) => toggle(r, e)">
        <span v-if="dots" class="flex w-4 shrink-0 items-center justify-center">
          <span v-if="r.dot" class="size-1.5 rounded-full" :class="DOT[r.dot]" />
        </span>
        <span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
        <span :class="SHORTCUT">{{ r.transport }}</span>
      </DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>
</template>
