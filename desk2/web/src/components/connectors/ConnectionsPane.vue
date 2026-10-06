<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { icons } from '@/lib/icons'
import { INPUT, TEXT_BTN } from '@/components/servers/styles'
import { connectorList, refreshConnectorList } from './connections-api'
import { BYPASS_TIP, CONNECTIONS_STUDIO_URL, bypassRow, chipText, connectionsServerInfo, isCurrent, signInLine, starState } from './connections-logic'
import { NO_SESSION, useConnectionsWorkspace } from './connections-workspace'

// The right pane for Connections: the server this Desk is connected to, whether this machine is signed in, and this
// chat's workspace with the same switcher as the title-bar chip (same calls, same logic: connections-workspace.ts).
const props = defineProps<{ chat: ChatSummary }>()

const { ws, query, note, busy, chatOk, matches, showNone, load, loadCompanies, pick, toggleDefault, signIn } = useConnectionsWorkspace(() => props.chat)
const server = computed(() => connectionsServerInfo(connectorList.value))
const bypass = computed(() => bypassRow(ws.value))
const current = computed(() => chipText(ws.value))
const openStudio = () => window.open(CONNECTIONS_STUDIO_URL, '_blank', 'noopener')

const reload = () => {
  ws.value = null
  void refreshConnectorList()
  void load()
  void loadCompanies()
}
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  reload()
  timer = setInterval(() => !document.hidden && void refreshConnectorList(), 10_000)
})
onBeforeUnmount(() => timer && clearInterval(timer))
watch(() => props.chat.id, reload)
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)] text-[12px] text-[var(--text-2)]" aria-label="Connections">
    <header class="flex h-9 shrink-0 items-center border-b border-border px-3">
      <span class="flex-1 truncate font-medium text-[var(--text)]">Connections</span>
    </header>

    <div class="flex flex-col gap-1 border-b border-border px-3 py-3">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-muted">Server</h3>
      <template v-if="server">
        <p class="flex items-center gap-1.5">
          <span class="size-1.5 rounded-full" :class="server.running ? 'bg-[var(--status-working)]' : 'bg-[var(--status-error)]'" />
          <span class="text-[var(--text)]">{{ server.stateText }}</span>
          <span v-if="server.version" class="tnum text-text-muted">v{{ server.version }}</span>
        </p>
        <p>Connected by {{ server.transport }}<span v-if="server.url" class="tnum"> at {{ server.url }}</span></p>
      </template>
      <p v-else>Connections is not set up on this machine.</p>
    </div>

    <div class="flex flex-col gap-1 border-b border-border px-3 py-3">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-muted">Account</h3>
      <p class="text-[var(--text)]">{{ signInLine(ws) }}</p>
      <div v-if="ws && !ws.signedIn" class="pt-1">
        <button type="button" :class="TEXT_BTN" @click="signIn">Sign in to Connections</button>
      </div>
    </div>

    <div v-if="!ws || ws.signedIn" class="flex min-h-0 flex-col gap-1 px-3 py-3">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-muted">This chat's workspace</h3>
      <p class="pb-1">
        <span :class="current.muted ? 'text-text-muted' : 'text-[var(--text)]'">{{ current.text }}</span>
        <span v-if="current.pinned" class="ml-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1 text-[10px] text-text-muted">this chat</span>
      </p>
      <input v-model="query" type="text" placeholder="Search workspaces" aria-label="Search workspaces" autocomplete="off" spellcheck="false" :class="INPUT" />
      <ul class="min-h-0 overflow-y-auto" role="list">
        <li v-for="c in matches" :key="c.companyId" class="group">
          <div
            class="flex h-7 items-center gap-1 rounded-[var(--radius-6)] px-2 hover:bg-[var(--fill-hover)]"
            :class="busy ? 'opacity-60' : ''"
            :data-current="isCurrent(ws, c)"
            :title="chatOk ? undefined : NO_SESSION"
          >
            <button type="button" class="flex min-w-0 flex-1 cursor-default items-center text-left text-[var(--text)]" :disabled="busy" @click="pick(c.companyId)">
              <span class="flex-1 truncate">{{ c.name }}</span>
            </button>
            <button
              type="button"
              data-star
              :data-on="starState(ws, c).on"
              :title="starState(ws, c).title"
              :aria-label="starState(ws, c).title"
              :aria-pressed="starState(ws, c).on"
              class="flex size-4 shrink-0 cursor-default items-center justify-center rounded-[var(--radius-6)] hover:bg-fill-hover"
              :class="starState(ws, c).on ? 'text-text-2' : 'text-text-muted opacity-0 group-hover:opacity-100'"
              @click="toggleDefault(c)"
            >
              <component :is="icons.star" class="size-3.5" :class="starState(ws, c).on ? 'fill-current' : ''" />
            </button>
            <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="isCurrent(ws, c)" /></span>
          </div>
        </li>
        <li v-if="!matches.length" class="px-2 py-1 text-text-muted">No workspace matches</li>
        <li v-if="showNone">
          <button type="button" class="flex h-7 w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-2 text-left text-[var(--text)] hover:bg-[var(--fill-hover)]" :disabled="busy" @click="pick(null)">
            <span class="flex-1">No workspace</span>
            <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="ws && !ws.company" /></span>
          </button>
        </li>
      </ul>
      <button v-if="bypass" type="button" class="mt-2 flex h-7 w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-2 text-left hover:bg-[var(--fill-hover)]" :title="BYPASS_TIP" @click="openStudio">
        <span class="flex-1">{{ bypass.label }}</span>
        <span class="flex items-center gap-1" :class="bypass.on ? 'text-text-2' : 'text-text-muted'">
          <component :is="icons.check" v-if="bypass.on" class="size-3.5" />{{ bypass.value }}
        </span>
      </button>
    </div>
    <p v-if="note" role="status" class="px-3 pb-3 text-text-muted">{{ note }}</p>
    <div class="px-3 pb-3">
      <button type="button" :class="TEXT_BTN" @click="openStudio">Open Connections Studio</button>
    </div>
  </section>
</template>
