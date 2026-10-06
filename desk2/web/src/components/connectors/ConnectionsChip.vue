<script setup lang="ts">
// The Connections chip in a chat's title bar (after the CliMayte chip): the Connections mark and the workspace this
// chat's Connections tools act as ("No workspace" muted when none, a small "this chat" marker when pinned to the chat
// alone). Its menu lists the account's workspaces with a check on the current one, "No workspace", the choice between
// this chat and every chat in the folder, and "Sign in to Connections" while this machine is signed out. Shown only
// while the Connections connector is on and on this machine (GET /api/connectors); the server side is
// server/src/plugins/56-connections.ts, the decisions are in connections-logic.ts.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ConnectionsCompany, ConnectionsWorkspace } from '@shared/connectors'
import type { ChatSummary } from '@shared/protocol'
import { icons, settingsIcons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, focusFirstItem } from '@/components/sidebar/menuClasses'
import { connectorList, readCompanies, readWorkspace, refreshConnectorList, startSignin, switchWorkspace } from './connections-api'
import { CONNECTIONS_LOGO_URL, canClear, chatScopeAllowed, chipText, effectiveScope, isCurrent, pageShouldOpen, showConnectionsChip, type SwitchScope } from './connections-logic'

const props = defineProps<{ chat: ChatSummary }>()

const ws = ref<ConnectionsWorkspace | null>(null)
const companies = ref<ConnectionsCompany[]>([])
const picked = ref<SwitchScope>('chat')
const note = ref('')
const busy = ref(false)
const logoFailed = ref(false)
const list = ref<HTMLElement | null>(null)

const shown = computed(() => showConnectionsChip(connectorList.value))
const text = computed(() => chipText(ws.value))
const scope = computed(() => effectiveScope(picked.value, props.chat.sessionId))
const chatOk = computed(() => chatScopeAllowed(props.chat.sessionId))

async function load() {
  try {
    ws.value = await readWorkspace(props.chat.id)
    note.value = ''
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e)
  }
}
async function onOpen(open: boolean) {
  if (!open) return
  note.value = ''
  void load()
  try {
    companies.value = await readCompanies(props.chat.id)
    await nextTick()
    list.value?.querySelector('[data-current=true]')?.scrollIntoView({ block: 'center' })
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e)
  }
}
async function pick(company: string | null) {
  busy.value = true
  try {
    ws.value = await switchWorkspace({ chat: props.chat.id, company, scope: scope.value })
    note.value = ''
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
async function signIn() {
  try {
    const r = await startSignin(props.chat.id)
    const url = pageShouldOpen(r)
    if (url) window.open(url, '_blank', 'noopener')
    note.value = r.url ? 'Approve the sign-in in your browser, then open this again' : ''
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e)
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refreshConnectorList()
  timer = setInterval(() => !document.hidden && void refreshConnectorList(), 30_000)
  if (shown.value) void load()
})
onBeforeUnmount(() => timer && clearInterval(timer))
// A chat's chip follows the chat; its session id arriving also lets "This chat" through.
watch(
  () => [props.chat.id, shown.value] as const,
  ([, on]) => {
    ws.value = null
    if (on) void load()
  }
)
</script>

<template>
  <DropdownMenu v-if="shown" @update:open="onOpen">
    <Tip label="Connections workspace">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="ml-2 flex h-5 min-w-0 max-w-[200px] shrink cursor-default items-center gap-1 rounded-[var(--radius-6)] px-[5px] text-[12px] leading-4 hover:bg-fill-hover data-[state=open]:bg-fill-hover"
          :class="text.muted ? 'text-text-muted' : 'text-text-2'"
          :aria-label="`Connections workspace: ${text.text}${text.pinned ? ', this chat only' : ''}`"
        >
          <img v-if="!logoFailed" :src="CONNECTIONS_LOGO_URL" alt="" class="size-3.5 shrink-0" @error="logoFailed = true" />
          <component :is="settingsIcons.connections" v-else class="size-3.5 shrink-0" />
          <span class="truncate">{{ text.text }}</span>
          <span v-if="text.pinned" class="shrink-0 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1 text-[10px] leading-[14px] text-text-muted">this chat</span>
        </button>
      </DropdownMenuTrigger>
    </Tip>
    <DropdownMenuContent align="start" :collision-padding="8" :class="[MENU_CONTENT, 'flex max-h-[var(--reka-dropdown-menu-content-available-height)] flex-col']" @open-auto-focus="focusFirstItem">
      <template v-if="ws && !ws.signedIn">
        <DropdownMenuItem :class="MENU_ITEM" @select="signIn">Sign in to Connections</DropdownMenuItem>
      </template>
      <template v-else>
        <DropdownMenuLabel class="px-2 py-0.5 text-[12px] font-normal leading-4 text-text-muted">Workspace</DropdownMenuLabel>
        <div ref="list" class="min-h-0 max-h-[50vh] overflow-y-auto">
        <DropdownMenuItem v-for="c in companies" :key="c.companyId" :class="MENU_ITEM" :data-current="isCurrent(ws, c)" :disabled="busy" @select="pick(c.companyId)">
          <span class="flex-1 truncate">{{ c.name }}</span>
          <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="isCurrent(ws, c)" /></span>
        </DropdownMenuItem>
        </div>
        <DropdownMenuItem
          :class="MENU_ITEM"
          :disabled="busy || !canClear(scope)"
          :title="canClear(scope) ? undefined : `A folder's workspace is changed by picking another one`"
          @select="pick(null)"
        >
          <span class="flex-1">No workspace</span>
          <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="ws && !ws.company" /></span>
        </DropdownMenuItem>
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuLabel class="px-2 py-0.5 text-[12px] font-normal leading-4 text-text-muted">Switch for</DropdownMenuLabel>
        <DropdownMenuItem
          role="menuitemradio"
          :aria-checked="scope === 'chat'"
          :class="MENU_ITEM"
          :disabled="!chatOk"
          :title="chatOk ? undefined : 'Available once this chat has started (it has no Claude session yet)'"
          @select.prevent="picked = 'chat'"
        >
          <span class="flex-1">This chat</span>
          <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="scope === 'chat'" /></span>
        </DropdownMenuItem>
        <DropdownMenuItem role="menuitemradio" :aria-checked="scope === 'folder'" :class="MENU_ITEM" @select.prevent="picked = 'folder'">
          <span class="flex-1">Every chat in this folder</span>
          <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="scope === 'folder'" /></span>
        </DropdownMenuItem>
      </template>
      <p v-if="note" role="status" class="max-w-72 px-2 py-1 text-[12px] leading-4 text-text-muted">{{ note }}</p>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
