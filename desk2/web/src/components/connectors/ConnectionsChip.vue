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
import type { ChatSummary } from '@shared/protocol'
import { icons, settingsIcons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '@/components/sidebar/menuClasses'
import { connectorList, watchConnectors } from './connections-api'
import { SEARCH_BOX, SEARCH_INPUT } from './styles'
import { NO_SESSION, useConnectionsWorkspace } from './connections-workspace'
import { BYPASS_TIP, CONNECTIONS_LOGO_URL, CONNECTIONS_STUDIO_URL, bypassRow, chipText, enterPick, isCurrent, showConnectionsChip, starState } from './connections-logic'

const props = defineProps<{ chat: ChatSummary }>()

const { ws, companies, query, note, busy, loaded, chatOk, matches, showNone, load, loadCompanies, pick, toggleDefault, signIn } = useConnectionsWorkspace(() => props.chat)
const menuOpen = ref(false)
const search = ref<HTMLInputElement | null>(null)
const logoFailed = ref(false)
const list = ref<HTMLElement | null>(null)

const shown = computed(() => showConnectionsChip(connectorList.value))
const text = computed(() => chipText(ws.value))
const bypass = computed(() => bypassRow(ws.value))

async function onOpen(open: boolean) {
  if (!open) return
  note.value = ''
  query.value = ''
  loaded.value = false
  void load()
  await loadCompanies()
  await nextTick()
  list.value?.querySelector('[data-current=true]')?.scrollIntoView({ block: 'nearest' })
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
    const top = enterPick(companies.value, query.value)
    if (top) {
      void pick(top.companyId)
      menuOpen.value = false
    }
  }
}
// From a row: typing (or Backspace) goes back to the search box instead of the menu's jump-to-letter, and Up from the first row returns to it.
function contentKey(e: KeyboardEvent) {
  if (e.target === search.value || e.ctrlKey || e.metaKey || e.altKey) return
  const first = list.value?.querySelector('[role^="menuitem"]:not([data-disabled])')
  if (e.key === 'ArrowUp' && e.target === first) {
    e.preventDefault()
    e.stopPropagation()
    search.value?.focus()
  } else if (e.key === 'Backspace' || (e.key.length === 1 && e.key !== ' ')) {
    e.stopPropagation()
    search.value?.focus()
  }
}
// Read-only: Desk never writes Bypass permissions; the row only opens Studio, where a person changes it.
function openStudio() {
  window.open(CONNECTIONS_STUDIO_URL, '_blank', 'noopener')
}

let stopWatch: (() => void) | null = null
onMounted(() => {
  stopWatch = watchConnectors(() => 30_000)
  if (shown.value) void load()
})
onBeforeUnmount(() => stopWatch?.())
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
    <span class="inline-flex min-w-7 shrink-500">
  <DropdownMenu v-model:open="menuOpen" @update:open="onOpen">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="ms-1 flex h-5 min-w-6 max-w-45 shrink cursor-default items-center gap-1 overflow-hidden rounded-(--radius-6) bg-(--fill-secondary) px-1.25 text-[12px] leading-4 hover:bg-fill-hover data-[state=open]:bg-fill-hover"
        :class="text.muted ? 'text-text-muted' : 'text-text-2'"
        :aria-label="`Connections workspace: ${text.text}${text.pinned ? ', this chat only' : ''}`"
      >
        <img v-if="!logoFailed" :src="CONNECTIONS_LOGO_URL" alt="" class="size-3.5 shrink-0" @error="logoFailed = true" />
        <component :is="settingsIcons.connections" v-else class="size-3.5 shrink-0" />
        <span class="min-w-0 truncate">{{ text.text }}</span>
        <span v-if="text.pinned" class="min-w-0 truncate rounded-(--radius-6) bg-(--fill-secondary) px-1 text-[10px] leading-3.5 text-text-muted">this chat</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" :collision-padding="8" :class="[MENU_CONTENT, 'flex w-64 flex-col']" @open-auto-focus="focusSearch" @keydown.capture="contentKey">
      <template v-if="ws && !ws.signedIn">
        <DropdownMenuItem :class="MENU_ITEM" @select="signIn">Sign in to Connections</DropdownMenuItem>
      </template>
      <template v-else>
        <label :class="[SEARCH_BOX, 'mb-1']">
          <component :is="settingsIcons.search" class="size-4 shrink-0 text-text-muted" />
          <input
            ref="search"
            v-model="query"
            type="text"
            placeholder="Search workspaces"
            aria-label="Search workspaces"
            autocomplete="off"
            spellcheck="false"
            :class="SEARCH_INPUT"
            @keydown="searchKey"
          />
        </label>
        <div ref="list" class="min-h-0 max-h-[min(50vh,264px)] overflow-y-auto">
          <DropdownMenuItem v-for="c in matches" :key="c.companyId" :class="[MENU_ITEM, 'group data-[current=true]:font-medium']" :data-current="isCurrent(ws, c)" :disabled="busy" :title="chatOk ? undefined : NO_SESSION" @select="pick(c.companyId)">
            <span class="flex-1 truncate">{{ c.name }}</span>
            <Tip :label="starState(ws, c).title">
              <button
                type="button"
                tabindex="-1"
                data-star
                :data-on="starState(ws, c).on"
                :aria-label="starState(ws, c).title"
                :aria-pressed="starState(ws, c).on"
                class="flex size-4 shrink-0 cursor-default items-center justify-center rounded-(--radius-6) hover:bg-fill-hover"
                :class="starState(ws, c).on ? 'text-text-2' : 'text-text-muted opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100'"
                @click.stop.prevent="toggleDefault(c)"
                @pointerup.stop
                @pointerdown.stop
              >
                <component :is="icons.star" class="size-3.5" :class="starState(ws, c).on ? 'fill-current' : ''" />
              </button>
            </Tip>
            <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="isCurrent(ws, c)" /></span>
          </DropdownMenuItem>
          <p v-if="!matches.length" class="flex h-6 items-center px-2 text-[13px] leading-4.75 text-text-muted">{{ loaded ? 'No workspace matches' : 'Loading workspaces…' }}</p>
        </div>
        <DropdownMenuItem v-if="showNone" :class="MENU_ITEM" :disabled="busy" @select="pick(null)">
          <span class="flex-1">No workspace</span>
          <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="ws && !ws.company" /></span>
        </DropdownMenuItem>
      </template>
      <template v-if="bypass">
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuItem :class="[MENU_ITEM, 'ps-5 text-[12px] text-text-2']" :title="BYPASS_TIP" @select="openStudio">
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
