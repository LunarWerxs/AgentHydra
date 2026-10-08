<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { icons, settingsIcons } from '@/lib/icons'
import { TEXT_BTN } from '@/components/servers/styles'
import { PANE_ROW, SEARCH_BOX, SEARCH_INPUT } from './styles'
import { connectorList, refreshConnectorList, watchConnectors } from './connections-api'
import { BYPASS_TIP, CONNECTIONS_STUDIO_URL, bypassRow, chipText, connectionsServerInfo, enterPick, isCurrent, signInLine, starState } from './connections-logic'
import { NO_SESSION, useConnectionsWorkspace } from './connections-workspace'

// The right pane for Connections: the server this Desk is connected to, whether this machine is signed in, and this
// chat's workspace with the same switcher as the title-bar chip (same calls, same logic: connections-workspace.ts).
const props = defineProps<{ chat: ChatSummary }>()

const { ws, companies, query, note, busy, loaded, chatOk, matches, showNone, load, loadCompanies, pick, toggleDefault, signIn } = useConnectionsWorkspace(() => props.chat)
const server = computed(() => connectionsServerInfo(connectorList.value))
const bypass = computed(() => bypassRow(ws.value))
const current = computed(() => chipText(ws.value))
// Enter in the search box switches this chat to the top match (never while the box is blank).
const pickTop = () => {
  const top = enterPick(companies.value, query.value)
  if (top) void pick(top.companyId)
}
const openStudio = () => window.open(CONNECTIONS_STUDIO_URL, '_blank', 'noopener')

const reload = () => {
  ws.value = null
  loaded.value = false
  void refreshConnectorList()
  void load()
  void loadCompanies()
}
let stopWatch: (() => void) | null = null
onMounted(() => {
  reload()
  stopWatch = watchConnectors(() => 10_000)
})
onBeforeUnmount(() => stopWatch?.())
watch(() => props.chat.id, reload)
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--bg) text-[12px] text-(--text-2)" aria-label="Connections">
    <header class="flex h-9 shrink-0 items-center border-b border-border px-3">
      <span class="flex-1 truncate font-medium text-(--text)">Connections</span>
      <button type="button" :class="TEXT_BTN" @click="openStudio">Open Connections Studio</button>
    </header>

    <div class="flex shrink-0 flex-col gap-1 border-b border-border p-3">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-muted">Server</h3>
      <template v-if="server">
        <p class="flex items-center gap-1.5">
          <span class="size-1.5 rounded-full" :class="server.running ? 'bg-(--status-working)' : 'bg-(--status-error)'" />
          <span class="text-(--text)">{{ server.stateText }}</span>
          <span v-if="server.version" class="tnum text-text-muted">v{{ server.version }}</span>
        </p>
        <p>Connected by {{ server.transport }}<span v-if="server.url" class="tnum"> at {{ server.url }}</span></p>
      </template>
      <p v-else>Connections is not set up on this machine.</p>
    </div>

    <div class="flex shrink-0 flex-col gap-1 border-b border-border p-3">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-muted">Account</h3>
      <p class="text-(--text)">{{ signInLine(ws) }}</p>
      <div v-if="ws && !ws.signedIn" class="pt-1">
        <button type="button" :class="TEXT_BTN" @click="signIn">Sign in to Connections</button>
      </div>
    </div>

    <!-- The list scrolls inside; the search, "No workspace" and the Bypass row stay in view whatever the list's length. -->
    <div v-if="!ws || ws.signedIn" class="flex min-h-0 flex-1 flex-col gap-1 p-3">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-muted">This chat's workspace</h3>
      <p class="pb-1">
        <span :class="current.muted ? 'text-text-muted' : 'text-(--text)'">{{ current.text }}</span>
        <span v-if="current.pinned" class="ms-1 rounded-(--radius-6) bg-(--fill-secondary) px-1 text-[10px] text-text-muted">this chat</span>
      </p>
      <label :class="SEARCH_BOX">
        <component :is="settingsIcons.search" class="size-4 shrink-0 text-text-muted" />
        <input v-model="query" type="text" placeholder="Search workspaces" aria-label="Search workspaces" autocomplete="off" spellcheck="false" :class="SEARCH_INPUT" @keydown.enter.prevent="pickTop" />
      </label>
      <ul class="min-h-0 flex-1 overflow-y-auto" role="list">
        <li v-for="c in matches" :key="c.companyId" class="group">
          <div :class="[PANE_ROW, busy ? 'opacity-60' : '']" :data-current="isCurrent(ws, c)" :title="chatOk ? undefined : NO_SESSION">
            <button type="button" class="flex h-full min-w-0 flex-1 cursor-default items-center text-start" :disabled="busy" @click="pick(c.companyId)">
              <span class="flex-1 truncate">{{ c.name }}</span>
            </button>
            <button
              type="button"
              data-star
              :data-on="starState(ws, c).on"
              :title="starState(ws, c).title"
              :aria-label="starState(ws, c).title"
              :aria-pressed="starState(ws, c).on"
              class="flex size-4 shrink-0 cursor-default items-center justify-center rounded-(--radius-6) hover:bg-fill-hover"
              :class="starState(ws, c).on ? 'text-text-2' : 'text-text-muted opacity-0 group-hover:opacity-100'"
              @click="toggleDefault(c)"
            >
              <component :is="icons.star" class="size-3.5" :class="starState(ws, c).on ? 'fill-current' : ''" />
            </button>
            <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="isCurrent(ws, c)" /></span>
          </div>
        </li>
        <li v-if="!matches.length" class="flex h-6 items-center px-2 text-text-muted">{{ loaded ? 'No workspace matches' : 'Loading workspaces…' }}</li>
      </ul>
      <button v-if="showNone" type="button" :class="PANE_ROW" :data-current="!!ws && !ws.company" :disabled="busy" @click="pick(null)">
        <span class="flex-1">No workspace</span>
        <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="ws && !ws.company" /></span>
      </button>
      <button v-if="bypass" type="button" :class="[PANE_ROW, 'text-[12px] text-text-2']" :title="BYPASS_TIP" @click="openStudio">
        <span class="flex-1">{{ bypass.label }}</span>
        <span class="flex items-center gap-1" :class="bypass.on ? 'text-text-2' : 'text-text-muted'">
          <component :is="icons.check" v-if="bypass.on" class="size-3.5" />{{ bypass.value }}
        </span>
      </button>
    </div>
    <p v-if="note" role="status" class="shrink-0 px-3 pb-3 text-text-muted">{{ note }}</p>
  </section>
</template>
