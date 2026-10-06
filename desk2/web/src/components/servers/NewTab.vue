<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Play, RotateCw, Search, Square } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import type { DevWebProcess, DevWebProject, LocalServers } from '@shared/devwebui'
import { enterTarget, filterLocal, filterProfiles, filterServers, isUp, type PaneView, type ProfileRow, statusDot, statusWord } from './logic'
import { chipHosts, splitChips } from './names'
import { DOT, ICON_BTN, INPUT, TEXT_BTN } from './styles'

// The New tab page: the servers DevWebUI found for this chat's folder, then the workspace's saved browsers, both
// narrowed by the address bar's text. A click opens one in this tab; the row's buttons act without navigating.
const props = defineProps<{
  active: boolean
  cwd: string
  view: PaneView
  project: DevWebProject | null
  elsewhere: { proc: DevWebProcess; project: DevWebProject }[]
  busy: Set<string>
  pending: string[]
  logOf: (p: DevWebProcess) => string[]
  profiles: ProfileRow[] | null
  profilesError: string | null
  actionError: string | null
  /** Servers listening on this machine that DevWebUI did not start; null until the first answer. */
  local: LocalServers | null
  localError: string | null
  allPorts: boolean
}>()
const emit = defineEmits<{
  allPorts: [on: boolean]
  server: [proc: DevWebProcess]
  toggle: [proc: DevWebProcess]
  restart: [proc: DevWebProcess]
  all: [action: 'start' | 'stop']
  saved: [name: string]
  address: [url: string]
  lookAgain: []
  tryAgain: []
}>()

const query = ref('')
const input = ref<HTMLInputElement | null>(null)
const focus = () => void nextTick(() => input.value?.focus())
onMounted(() => props.active && focus())
watch(() => props.active, (on) => on && focus())

const own = computed(() => filterServers(props.project?.processes ?? [], query.value))
const other = computed(() => {
  const byProc = new Map(props.elsewhere.map((r) => [r.proc.id, r.project]))
  return filterServers(
    props.elsewhere.map((r) => r.proc),
    query.value
  ).map((proc) => ({ proc, project: byProc.get(proc.id) as DevWebProject }))
})
const saved = computed(() => filterProfiles(props.profiles ?? [], query.value))
const localRows = computed(() => filterLocal(props.local?.servers ?? [], query.value))
// Shown once it has an answer worth a row, a hidden count to widen, or an error; never on the "restart AgentHydra" page.
const showLocal = computed(() => props.view.kind !== 'restart-desk' && (!!props.localError || !!props.local?.servers.length || !!props.local?.hidden || props.allPorts) && (!query.value.trim() || localRows.value.length > 0))
// The saved browsers are a different kind of thing from the servers above them: a rule and a wider gap set them apart.
const apart = computed(() => props.view.kind !== 'loading' && props.view.kind !== 'starting')
const moreTitle = (hosts: string[]) => splitChips(hosts).more.join(String.fromCharCode(10))
// A login chip that only repeats the row's shown name is left out.
const chipsOf = (r: ProfileRow) => chipHosts(r.label ?? r.name, r.hosts)
const nothingMatches = computed(() => query.value.trim() !== '' && !own.value.length && !other.value.length && !saved.value.length && !localRows.value.length)

function enter() {
  const servers = [...own.value, ...other.value.map((r) => r.proc)]
  const t = enterTarget(query.value, servers, saved.value)
  if (!t) return
  if (t.kind === 'address') emit('address', t.url)
  else if (t.kind === 'saved') emit('saved', t.name)
  else {
    const p = servers.find((x) => x.id === t.id)
    if (p) emit('server', p)
  }
}
const pendingText = (p: DevWebProcess) => (props.pending.includes(p.id) && (p.status === 'starting' || p.status === 'waiting') ? 'starting, opens when it answers' : statusWord(p))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <form class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2" @submit.prevent="enter">
      <Search class="ml-1 size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      <input ref="input" v-model="query" type="text" spellcheck="false" autocomplete="off" aria-label="Search servers, or type an address or port" placeholder="Search servers, or type an address or port" :class="INPUT" />
    </form>

    <div class="min-h-0 flex-1 overflow-y-auto" data-testid="new-tab">
      <div class="mx-auto flex w-full max-w-[560px] flex-col gap-1 px-2 py-3">
        <div role="status" aria-live="polite" class="px-3 text-center">
          <template v-if="view.kind === 'loading'"><span class="text-[var(--text-muted)]">Loading…</span></template>
          <template v-else-if="view.kind === 'starting'"><span class="text-[var(--text-muted)]">Starting the server manager</span></template>
          <template v-else-if="view.kind === 'looking'"><span class="text-[var(--text-muted)]">Looking for servers in this folder</span></template>
        </div>

        <div v-if="view.kind === 'restart-desk'" class="mx-1 rounded-[var(--radius-10)] bg-[var(--warning-bg)] px-3 py-2 text-center text-[var(--warning-text)]">Restart AgentHydra to turn on servers.</div>

        <div v-else-if="view.kind === 'failed'" class="mx-1 flex flex-col gap-2 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-center text-[var(--danger-text)]" role="alert">
          <div>The server manager did not start.</div>
          <div class="break-words font-mono text-[12px]">{{ view.reason }}</div>
          <button type="button" :class="TEXT_BTN" class="self-center" @click="emit('tryAgain')">Try again</button>
        </div>

        <div v-else-if="view.kind === 'stopped'" class="mx-1 flex flex-col gap-2 rounded-[var(--radius-10)] bg-[var(--fill-secondary)] px-3 py-2 text-center">
          <div>The server manager stopped.</div>
          <button type="button" :class="TEXT_BTN" class="self-center" @click="emit('tryAgain')">Start it</button>
        </div>

        <div v-else-if="view.kind === 'unreachable'" class="mx-1 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-center text-[var(--danger-text)]" role="alert">The server manager is running but did not answer: {{ view.reason }}</div>

        <div v-else-if="view.kind === 'looking'" class="break-all px-3 text-center text-[var(--text-muted)]">{{ cwd }}</div>

        <div v-else-if="view.kind === 'nothing'" class="flex flex-col gap-2 px-3 text-center">
          <div class="font-medium">No servers in this folder</div>
          <div class="break-all text-[var(--text-muted)]">{{ cwd }}</div>
          <div class="rounded-[var(--radius-10)] bg-[var(--fill-secondary)] px-3 py-2" role="status">{{ view.reason }}</div>
          <div class="text-[12px] text-[var(--text-muted)]">Servers come from Claude Code's .claude/launch.json, or the dev scripts in package.json.</div>
          <button type="button" :class="TEXT_BTN" class="self-center" @click="emit('lookAgain')">Look again</button>
        </div>

        <section v-else-if="view.kind === 'project' && project" aria-label="Servers">
          <div class="flex min-h-[28px] items-center gap-1 px-1">
            <span class="text-[12px] font-medium text-[var(--text-muted)]">Servers</span>
            <span class="flex-1" />
            <template v-if="project.processes.length > 1">
              <button type="button" :class="TEXT_BTN" :disabled="busy.has('all')" @click="emit('all', 'start')"><Play class="size-3" />Start all</button>
              <button type="button" :class="TEXT_BTN" :disabled="busy.has('all')" @click="emit('all', 'stop')"><Square class="size-3" />Stop all</button>
            </template>
          </div>
          <div v-if="project.processes.length === 0" class="px-1 py-2 text-center text-[var(--text-muted)]">This project has no servers.</div>
          <ul v-else-if="own.length" class="flex flex-col gap-0.5" aria-label="This folder's servers">
            <li v-for="p in own" :key="p.id" class="flex flex-col rounded-[var(--radius-6)] px-1 py-0.5 hover:bg-[var(--fill-hover)]">
              <div class="flex min-h-[28px] items-center gap-1.5">
                <button type="button" class="flex min-h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-6)] text-left focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none" :aria-label="`Open ${p.name}`" @click="emit('server', p)">
                  <span class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(p.status)]" aria-hidden="true" />
                  <span class="truncate font-medium">{{ p.name }}</span>
                  <span v-if="p.port" class="tnum shrink-0 text-[12px] text-[var(--text-muted)]">:{{ p.port }}</span>
                  <span class="shrink-0 text-[12px] text-[var(--text-muted)]">{{ pendingText(p) }}</span>
                </button>
                <Tip :label="isUp(p.status) ? 'Stop' : 'Start'">
                  <button type="button" :class="ICON_BTN" :disabled="busy.has(p.id)" :aria-label="`${isUp(p.status) ? 'Stop' : 'Start'} ${p.name}`" @click="emit('toggle', p)">
                    <Square v-if="isUp(p.status)" class="size-3.5" />
                    <Play v-else class="size-3.5" />
                  </button>
                </Tip>
                <Tip label="Restart">
                  <button type="button" :class="ICON_BTN" :disabled="busy.has(p.id)" :aria-label="`Restart ${p.name}`" @click="emit('restart', p)"><RotateCw class="size-3.5" /></button>
                </Tip>
              </div>
              <pre v-if="logOf(p).length" class="mx-1 mb-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 py-1 font-mono text-[11px] leading-4 text-[var(--text-2)]" :aria-label="`Last output of ${p.name}`">{{ logOf(p).join('\n') }}</pre>
            </li>
          </ul>
        </section>

        <section v-if="other.length" class="pt-2" aria-label="Also running">
          <div class="px-1 pb-0.5 text-[12px] font-medium text-[var(--text-muted)]">Also running</div>
          <ul class="flex flex-col gap-0.5" aria-label="Servers running for other folders">
            <li v-for="r in other" :key="r.proc.id" class="flex min-h-[28px] items-center gap-1.5 rounded-[var(--radius-6)] px-1 hover:bg-[var(--fill-hover)]">
              <button type="button" class="flex min-h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-6)] text-left focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none" :aria-label="`Open ${r.proc.name}`" @click="emit('server', r.proc)">
                <span class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(r.proc.status)]" aria-hidden="true" />
                <span class="truncate font-medium">{{ r.proc.name }}</span>
                <span class="truncate text-[12px] text-[var(--text-muted)]">{{ r.project.name }}</span>
                <span v-if="r.proc.port" class="tnum shrink-0 text-[12px] text-[var(--text-muted)]">:{{ r.proc.port }}</span>
              </button>
              <Tip label="Stop">
                <button type="button" :class="ICON_BTN" :disabled="busy.has(r.proc.id)" :aria-label="`Stop ${r.proc.name}`" @click="emit('toggle', r.proc)"><Square class="size-3.5" /></button>
              </Tip>
            </li>
          </ul>
        </section>

        <section v-if="showLocal" class="pt-2" aria-label="Other localhost servers">
          <div class="flex min-h-[28px] items-center gap-1 px-1">
            <span class="text-[12px] font-medium text-[var(--text-muted)]">Other localhost servers</span>
            <span class="flex-1" />
            <button type="button" :class="TEXT_BTN" :aria-pressed="allPorts" @click="emit('allPorts', !allPorts)">{{ allPorts ? 'Dev servers only' : local?.hidden ? `All ports (${local?.hidden} hidden)` : 'All ports' }}</button>
          </div>
          <div v-if="localError" class="rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ localError }}</div>
          <div v-else-if="!local?.servers.length" class="px-1 py-2 text-center text-[var(--text-muted)]" role="status">No other localhost servers.</div>
          <ul v-else-if="localRows.length" class="flex flex-col gap-0.5" aria-label="Servers on this machine that DevWebUI did not start">
            <li v-for="s in localRows" :key="s.port" class="flex min-h-[28px] items-center gap-1.5 rounded-[var(--radius-6)] px-1 hover:bg-[var(--fill-hover)]">
              <button type="button" class="flex min-h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-6)] text-left focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none" :aria-label="`Open localhost:${s.port}`" @click="emit('address', s.url)">
                <span class="size-2 shrink-0 rounded-full" :class="DOT.run" aria-hidden="true" />
                <span class="tnum shrink-0 font-medium">:{{ s.port }}</span>
                <span v-if="s.title" class="truncate">{{ s.title }}</span>
                <span v-if="s.process" class="truncate text-[12px] text-[var(--text-muted)]">{{ s.process }}</span>
              </button>
            </li>
          </ul>
        </section>

        <section v-if="!query.trim() || saved.length" :class="apart ? 'mt-5 border-t border-border pt-4' : 'pt-2'" aria-label="Saved browsers">
          <div class="px-1 pb-0.5 text-[12px] font-medium text-[var(--text-muted)]">Saved browsers</div>
          <div v-if="profilesError" class="rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ profilesError }}</div>
          <div v-else-if="!profiles" class="px-1 text-[var(--text-muted)]" role="status">Loading…</div>
          <div v-else-if="!profiles.length" class="px-1 text-[var(--text-muted)]" role="status">The AI creates saved browsers as it works, and they appear here.</div>
          <ul v-else-if="saved.length" class="flex flex-col gap-0.5" aria-label="Saved browsers">
            <li v-for="r in saved" :key="r.name">
              <button type="button" class="flex w-full flex-col gap-0.5 rounded-[var(--radius-6)] px-2 py-1.5 text-left transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none" :aria-label="`Show ${r.name}`" @click="emit('saved', r.name)">
                <span class="flex items-center gap-1.5">
                  <span class="size-2 shrink-0 rounded-full" :class="r.open ? DOT.run : DOT.off" :title="r.open ? 'Open' : 'Not open'" aria-hidden="true" />
                  <span class="truncate font-medium" :title="r.label && r.label !== r.name ? r.name : undefined">{{ r.label ?? r.name }}</span>
                  <span class="flex-1" />
                  <span class="shrink-0 text-[12px] text-[var(--text-muted)]">{{ r.open ? 'open · ' : '' }}{{ r.lastUsed }}</span>
                </span>
                <span class="truncate text-[12px]" :class="r.note ? 'text-[var(--text-2)]' : 'text-[var(--text-muted)]'" :title="r.note ?? undefined">{{ r.note ?? 'no note' }}</span>
                <span v-if="chipsOf(r).length" class="flex flex-wrap gap-1">
                  <span v-for="h in splitChips(chipsOf(r)).shown" :key="h" class="rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1.5 text-[11px] text-[var(--text-2)]">{{ h }}</span>
                  <span v-if="splitChips(chipsOf(r)).more.length" class="rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1.5 text-[11px] text-[var(--text-2)]" :title="moreTitle(chipsOf(r))">+{{ splitChips(chipsOf(r)).more.length }}</span>
                </span>
              </button>
            </li>
          </ul>
        </section>

        <div v-if="nothingMatches" class="px-3 py-2 text-center text-[var(--text-muted)]" role="status">Nothing matches "{{ query.trim() }}". Press Enter to open it as an address.</div>
        <div v-if="actionError" class="mx-1 mt-1 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ actionError }}</div>
      </div>
    </div>
  </div>
</template>
