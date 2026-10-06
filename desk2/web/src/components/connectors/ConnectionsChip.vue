<script setup lang="ts">
// The Connections chip in a chat's title bar (after the CliMayte chip): the Connections mark and the workspace this
// chat's Connections tools act as ("No workspace" muted when none, a small "this chat" marker when pinned to the chat
// alone). Its menu opens with a search box that has focus (typing filters the workspaces by name), then the account's
// workspaces with a check on the current one (clicking one switches THIS chat only) and a star on each that makes it the
// default for NEW chats in the folder (Desk's own setting, nothing existing changes), "No workspace", an indented
// read-only "Bypass permissions  ✓ On / Off" row that opens Studio (hidden when unknown), and "Sign in to Connections" while this machine is signed out. Shown only
// while the Connections connector is on and on this machine (GET /api/connectors); the server side is
// server/src/plugins/56-connections.ts, the decisions are in connections-logic.ts.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ConnectionsCompany, ConnectionsWorkspace } from '@shared/connectors'
import type { ChatSummary } from '@shared/protocol'
import { icons, settingsIcons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '@/components/sidebar/menuClasses'
import { connectorList, readCompanies, readWorkspace, refreshConnectorList, setDefaultWorkspace, startSignin, switchWorkspace } from './connections-api'
import { BYPASS_TIP, CONNECTIONS_LOGO_URL, CONNECTIONS_STUDIO_URL, bypassRow, chatScopeAllowed, chipText, filterCompanies, isCurrent, pageShouldOpen, showConnectionsChip, starState } from './connections-logic'

const props = defineProps<{ chat: ChatSummary }>()

const ws = ref<ConnectionsWorkspace | null>(null)
const companies = ref<ConnectionsCompany[]>([])
const query = ref('')
const menuOpen = ref(false)
const search = ref<HTMLInputElement | null>(null)
const note = ref('')
const busy = ref(false)
const logoFailed = ref(false)
const list = ref<HTMLElement | null>(null)

const shown = computed(() => showConnectionsChip(connectorList.value))
const text = computed(() => chipText(ws.value))
const bypass = computed(() => bypassRow(ws.value))
const chatOk = computed(() => chatScopeAllowed(props.chat.sessionId))
const matches = computed(() => filterCompanies(companies.value, query.value))
const showNone = computed(() => !query.value.trim() || 'no workspace'.includes(query.value.trim().toLowerCase()))
const NO_SESSION = 'Available once this chat has started (it has no Claude session yet)'

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
  query.value = ''
  void load()
  try {
    companies.value = await readCompanies(props.chat.id)
    await nextTick()
    list.value?.querySelector('[data-current=true]')?.scrollIntoView({ block: 'center' })
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e)
  }
}
// The search box takes focus the moment the menu opens, so typing filters at once.
function focusSearch(e: Event) {
  e.preventDefault()
  search.value?.focus()
}
function searchKey(e: KeyboardEvent) {
  // Escape closes the menu; everything else stays here so the menu's own type-to-find never takes the keystrokes.
  if (e.key === 'Escape') return
  e.stopPropagation()
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    list.value?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')?.focus()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const top = matches.value[0]
    if (top) {
      void pick(top.companyId)
      menuOpen.value = false
    }
  }
}
async function pick(company: string | null) {
  if (!chatOk.value) {
    note.value = NO_SESSION
    return
  }
  busy.value = true
  try {
    ws.value = await switchWorkspace({ chat: props.chat.id, company, scope: 'chat' })
    note.value = ''
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
// The star: this workspace becomes (or, on the current default, stops being) the default for NEW chats in the folder.
// It never switches this chat or any existing chat.
async function toggleDefault(c: ConnectionsCompany) {
  try {
    ws.value = await setDefaultWorkspace({ chat: props.chat.id, company: starState(ws.value, c).on ? null : c.companyId })
    note.value = ''
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e)
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

// Read-only: Desk never writes Bypass permissions; the row only opens Studio, where a person changes it.
function openStudio() {
  window.open(CONNECTIONS_STUDIO_URL, '_blank', 'noopener')
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
  <!-- Tip wraps the WHOLE menu: it swaps its subtree on the first hover, and a trigger remounted under a DropdownMenu leaves the menu anchored to a detached button (top-left of the window). -->
  <Tip v-if="shown" label="Connections workspace">
    <span class="inline-flex min-w-0 shrink">
  <DropdownMenu v-model:open="menuOpen" @update:open="onOpen">
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
    <DropdownMenuContent align="start" :collision-padding="8" :class="[MENU_CONTENT, 'flex max-h-[var(--reka-dropdown-menu-content-available-height)] flex-col']" @open-auto-focus="focusSearch">
      <template v-if="ws && !ws.signedIn">
        <DropdownMenuItem :class="MENU_ITEM" @select="signIn">Sign in to Connections</DropdownMenuItem>
      </template>
      <template v-else>
        <input
          ref="search"
          v-model="query"
          type="text"
          placeholder="Search workspaces"
          aria-label="Search workspaces"
          autocomplete="off"
          spellcheck="false"
          class="mb-1 h-6 w-full shrink-0 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 text-[13px] leading-[19px] text-text outline-none placeholder:text-text-muted"
          @keydown="searchKey"
        />
        <div ref="list" class="min-h-0 max-h-[50vh] overflow-y-auto">
          <DropdownMenuItem v-for="c in matches" :key="c.companyId" :class="[MENU_ITEM, 'group']" :data-current="isCurrent(ws, c)" :disabled="busy" :title="chatOk ? undefined : NO_SESSION" @select="pick(c.companyId)">
            <span class="flex-1 truncate">{{ c.name }}</span>
            <button
              type="button"
              tabindex="-1"
              data-star
              :data-on="starState(ws, c).on"
              :title="starState(ws, c).title"
              :aria-label="starState(ws, c).title"
              :aria-pressed="starState(ws, c).on"
              class="flex size-4 shrink-0 cursor-default items-center justify-center rounded-[var(--radius-6)] hover:bg-fill-hover"
              :class="starState(ws, c).on ? 'text-text-2' : 'text-text-muted opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100'"
              @click.stop.prevent="toggleDefault(c)"
              @pointerup.stop
              @pointerdown.stop
            >
              <component :is="icons.star" class="size-3.5" :class="starState(ws, c).on ? 'fill-current' : ''" />
            </button>
            <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="isCurrent(ws, c)" /></span>
          </DropdownMenuItem>
          <p v-if="!matches.length" class="px-2 py-1 text-[13px] leading-[19px] text-text-muted">No workspace matches</p>
        </div>
        <DropdownMenuItem v-if="showNone" :class="MENU_ITEM" :disabled="busy" @select="pick(null)">
          <span class="flex-1">No workspace</span>
          <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="ws && !ws.company" /></span>
        </DropdownMenuItem>
      </template>
      <template v-if="bypass">
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuItem :class="[MENU_ITEM, 'pl-5 text-[12px] text-text-2']" :title="BYPASS_TIP" @select="openStudio">
          <span class="flex-1">{{ bypass.label }}</span>
          <span class="flex items-center gap-1" :class="bypass.on ? 'text-text-2' : 'text-text-muted'">
            <component :is="icons.check" v-if="bypass.on" class="size-3.5" />{{ bypass.value }}
          </span>
        </DropdownMenuItem>
      </template>
      <p v-if="note" role="status" class="max-w-72 px-2 py-1 text-[12px] leading-4 text-text-muted">{{ note }}</p>
    </DropdownMenuContent>
  </DropdownMenu>
    </span>
  </Tip>
</template>
