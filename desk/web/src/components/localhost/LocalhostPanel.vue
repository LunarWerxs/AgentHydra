<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ExternalLink, Play, RefreshCw, RotateCw, ScrollText, Square } from '@lucide/vue'
import type { LocalhostState, LocalServer, StartableServer } from '@shared/protocol'
import { Tip } from '@/components/ui/tooltip'
import { useLocalhostApi } from './api'
import { folderName, memoryLabel, openUrl, serverTitle, uptimeLabel } from './logic'

// The globe button's panel (SPEC "Localhost"): the dev servers listening on this machine, what this chat's
// folder can start, Stop/Restart on the ones Desk or DevWebUI manage, a log tail, and DevWebUI's status.
const props = withDefaults(defineProps<{ folder: string | null; pollMs?: number }>(), { pollMs: 4000 })

const api = useLocalhostApi()
const state = ref<LocalhostState | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const showAll = ref(false)
const busy = ref<string | null>(null)
const actionError = ref<string | null>(null)
const logFor = ref<{ folder: string; id: string; name: string } | null>(null)
const logLines = ref<string[]>([])
const logError = ref<string | null>(null)
const now = ref(Date.now())

async function refresh() {
  loading.value = true
  try {
    state.value = await api.state(props.folder, showAll.value)
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    now.value = Date.now()
  }
  if (logFor.value) void loadLog()
}

async function loadLog() {
  const target = logFor.value
  if (!target) return
  try {
    const r = await api.log(target.folder, target.id)
    if (logFor.value?.id === target.id) {
      logLines.value = r.lines
      logError.value = null
    }
  } catch (e) {
    logError.value = e instanceof Error ? e.message : String(e)
  }
}

async function act(key: string, run: () => Promise<unknown>) {
  busy.value = key
  actionError.value = null
  try {
    await run()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = null
    await refresh()
  }
}

const startS = (s: StartableServer) => act(`start:${s.id}`, async () => {
  await api.start(props.folder!, s.id)
  showLog(props.folder!, s.id, s.name)
})
const stopS = (s: StartableServer) => act(`stop:${s.id}`, () => api.stop({ folder: props.folder!, id: s.id }))
const restartS = (s: StartableServer) => act(`restart:${s.id}`, () => api.restart(props.folder!, s.id))
const stopRow = (r: LocalServer) =>
  act(`stop:${r.port}`, () => (r.managed === 'devwebui' ? api.stop({ id: r.managedId! }) : api.stop({ pid: r.pid })))
const restartRow = (r: LocalServer) => act(`restart:${r.port}`, () => api.restart(r.cwd ?? '', r.managedId!))

function showLog(folder: string, id: string, name: string) {
  if (logFor.value?.id === id && logFor.value.folder === folder) {
    logFor.value = null
    return
  }
  logFor.value = { folder, id, name }
  logLines.value = []
  logError.value = null
  void loadLog()
}

const servers = computed(() => state.value?.servers ?? [])
const startable = computed(() => state.value?.startable ?? [])
const dw = computed(() => state.value?.devwebui ?? null)
const logPre = ref<HTMLElement | null>(null)
watch(logLines, () => requestAnimationFrame(() => logPre.value && (logPre.value.scrollTop = logPre.value.scrollHeight)))
watch(showAll, () => void refresh())
watch(() => props.folder, () => {
  logFor.value = null
  void refresh()
})

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refresh()
  if (props.pollMs > 0) timer = setInterval(() => void refresh(), props.pollMs)
})
onBeforeUnmount(() => timer && clearInterval(timer))

const ROW = 'group flex min-h-[30px] w-full items-center gap-2 rounded-[var(--radius-6)] px-2 py-1 text-left hover:bg-fill-hover'
const ICON_BTN =
  'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-5)] text-text-2 hover:bg-fill-selected hover:text-text disabled:opacity-40 aria-pressed:bg-fill-selected aria-pressed:text-text'
const HEAD = 'flex h-[23px] items-center px-2 text-[12px] font-medium text-text-muted'
const BADGE = 'flex h-4 shrink-0 items-center rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted'
</script>

<template>
  <div class="flex max-h-[70vh] w-[420px] flex-col p-1 text-[13px] leading-[19px] text-text" data-testid="localhost-panel">
    <div class="flex h-7 shrink-0 items-center gap-1 pl-2 pr-1">
      <span class="font-medium">Localhost</span>
      <span class="flex-1" />
      <label class="flex cursor-default items-center gap-1.5 text-[12px] text-text-muted">
        <input v-model="showAll" type="checkbox" class="size-3 accent-[var(--accent)]" aria-label="Show every listening port" />
        All ports<span v-if="!showAll && state?.hidden" class="tnum"> ({{ state.hidden }} hidden)</span>
      </label>
      <Tip label="Refresh">
        <button type="button" :class="ICON_BTN" aria-label="Refresh" :disabled="loading" @click="refresh">
          <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
        </button>
      </Tip>
    </div>

    <div v-if="error" class="shrink-0 px-2 py-1 text-[12px] text-danger-text">{{ error }}</div>
    <div v-if="state?.error" class="shrink-0 px-2 py-1 text-[12px] text-warning-text">{{ state.error }}</div>
    <div v-if="actionError" class="shrink-0 px-2 py-1 text-[12px] text-danger-text" role="alert">{{ actionError }}</div>

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]">
      <div :class="HEAD">Running</div>
      <div v-if="state && servers.length === 0" class="px-2 pb-1 text-[12px] text-text-muted">No dev servers listening on this machine.</div>
      <div v-else-if="!state && !error" class="px-2 pb-1 text-[12px] text-text-muted">Looking for servers…</div>
      <div v-for="r in servers" :key="r.port" :class="ROW" data-testid="localhost-server">
        <span class="size-1.5 shrink-0 rounded-full" :class="r.http ? 'bg-[var(--success-text)]' : 'bg-[var(--text-muted)]'" :title="r.http ? `answers HTTP ${r.http.status}` : 'does not answer HTTP'" />
        <a
          :href="openUrl(r)"
          target="_blank"
          rel="noopener noreferrer"
          class="flex min-w-0 flex-1 cursor-default items-center gap-2"
          :title="[r.command, r.project].filter(Boolean).join('\n')"
        >
          <span class="tnum w-[46px] shrink-0 font-[family-name:var(--font-mono)] text-[12px] text-accent-text">:{{ r.port }}</span>
          <span class="flex min-w-0 flex-col">
            <span class="truncate">{{ serverTitle(r) }}</span>
            <span class="truncate text-[11px] leading-4 text-text-muted">
              {{ [r.process, folderName(r.project), uptimeLabel(r.startedAt, now) && `up ${uptimeLabel(r.startedAt, now)}`, memoryLabel(r.memory)].filter(Boolean).join(' · ') }}
            </span>
          </span>
        </a>
        <span v-if="r.managed" :class="BADGE">{{ r.managed === 'desk' ? 'Desk' : 'DevWebUI' }}</span>
        <span v-if="showAll && r.kind !== 'dev'" :class="BADGE">{{ r.kind }}</span>
        <template v-if="r.managed">
          <Tip label="Restart">
            <button type="button" :class="ICON_BTN" aria-label="Restart" :disabled="!!busy" @click="restartRow(r)"><RotateCw class="size-3.5" /></button>
          </Tip>
          <Tip label="Stop">
            <button type="button" :class="ICON_BTN" aria-label="Stop" :disabled="!!busy" @click="stopRow(r)"><Square class="size-3" /></button>
          </Tip>
        </template>
        <Tip label="Open in browser">
          <a :href="openUrl(r)" target="_blank" rel="noopener noreferrer" :class="[ICON_BTN, 'opacity-0 group-hover:opacity-100']" aria-label="Open in browser">
            <ExternalLink class="size-3.5" />
          </a>
        </Tip>
      </div>

      <template v-if="folder">
        <div class="mx-2 my-1 h-px shrink-0 bg-border" />
        <div :class="HEAD">
          <span class="truncate">Start in {{ folderName(folder) }}</span>
        </div>
        <div v-if="state && startable.length === 0" class="px-2 pb-1 text-[12px] text-text-muted">
          No dev, start or preview script and no .devwebui file here.
        </div>
        <div v-for="s in startable" :key="s.id" :class="ROW" data-testid="localhost-startable">
          <span class="size-1.5 shrink-0 rounded-full" :class="s.running ? 'bg-[var(--success-text)]' : 'bg-[var(--fill-selected)]'" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="flex items-center gap-1.5">
              <span class="truncate">{{ s.name }}</span>
              <span :class="BADGE">{{ s.source === 'package.json' ? 'script' : s.source }}</span>
              <span v-if="s.running?.port" class="tnum text-[11px] text-accent-text">:{{ s.running.port }}</span>
              <span v-else-if="s.port" class="tnum text-[11px] text-text-muted">:{{ s.port }}</span>
            </span>
            <span class="truncate font-[family-name:var(--font-mono)] text-[11px] leading-4 text-text-muted">{{ s.command }}</span>
          </span>
          <template v-if="s.running">
            <span v-if="s.running.startedAt" class="tnum shrink-0 text-[11px] text-text-muted">up {{ uptimeLabel(s.running.startedAt, now) }}</span>
            <Tip label="Log">
              <button type="button" :class="ICON_BTN" aria-label="Log" :aria-pressed="logFor?.id === s.id" @click="showLog(folder, s.id, s.name)"><ScrollText class="size-3.5" /></button>
            </Tip>
            <Tip label="Restart">
              <button type="button" :class="ICON_BTN" aria-label="Restart" :disabled="!!busy" @click="restartS(s)"><RotateCw class="size-3.5" /></button>
            </Tip>
            <Tip label="Stop">
              <button type="button" :class="ICON_BTN" aria-label="Stop" :disabled="!!busy" @click="stopS(s)"><Square class="size-3" /></button>
            </Tip>
          </template>
          <template v-else>
            <Tip v-if="s.managed === 'desk' || logFor?.id === s.id" label="Log">
              <button type="button" :class="ICON_BTN" aria-label="Log" :aria-pressed="logFor?.id === s.id" @click="showLog(folder, s.id, s.name)"><ScrollText class="size-3.5" /></button>
            </Tip>
            <button
              type="button"
              class="flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-6)] bg-fill-5 px-2 text-[12px] text-text hover:bg-fill-selected disabled:opacity-40"
              :aria-label="`Start ${s.name}`"
              :disabled="!!busy"
              @click="startS(s)"
            >
              <Play class="size-3" />{{ busy === `start:${s.id}` ? 'Starting…' : 'Start' }}
            </button>
          </template>
        </div>
      </template>

      <template v-if="logFor">
        <div class="mx-2 my-1 h-px shrink-0 bg-border" />
        <div :class="HEAD"><span class="truncate">Log · {{ logFor.name }}</span></div>
        <pre
          ref="logPre"
          class="mx-2 mb-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-6)] bg-bg-deepest p-2 font-[family-name:var(--font-mono)] text-[11px] leading-4 text-text-2 [scrollbar-width:thin]"
          data-testid="localhost-log"
        >{{ logError ?? (logLines.length ? logLines.join('\n') : 'No output yet.') }}</pre>
      </template>
    </div>

    <div class="mx-2 my-1 h-px shrink-0 bg-border" />
    <div class="flex shrink-0 items-start gap-2 px-2 pb-1 text-[12px] leading-4" data-testid="devwebui-status">
      <span class="mt-[5px] size-1.5 shrink-0 rounded-full" :class="dw?.up ? 'bg-[var(--success-text)]' : 'bg-[var(--text-muted)]'" />
      <span v-if="!dw" class="text-text-muted">DevWebUI: checking…</span>
      <span v-else-if="dw.up" class="text-text-2">DevWebUI connected · {{ dw.processes }} {{ dw.processes === 1 ? 'process' : 'processes' }}; its servers start and stop through it.</span>
      <span v-else class="text-text-muted">
        DevWebUI {{ dw.error ?? 'not running' }} ({{ dw.url.replace(/^https?:\/\//, '') }}). Desk starts servers itself, hidden, logs under ~/.hydra-desk/localhost; run DevWebUI to manage .devwebui projects.
      </span>
    </div>
  </div>
</template>
