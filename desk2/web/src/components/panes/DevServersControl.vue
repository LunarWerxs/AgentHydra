<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LoaderCircle } from '@lucide/vue'
import type { DevWebScanPreset } from '@shared/devwebui'
import { forgetFound, ignoredFolders, restartRunning, scanProjects, unignoreFolder } from '@/components/servers/api'
import { useDevServers } from '@/components/servers/store'
import PaneSwitch from './PaneSwitch.vue'
import { BUTTON, FIELD } from './settings-styles'
import type { DevServerSettingsContext } from './devservers'
import type { SettingsRowId } from './settings'
import AlertRules from '@/components/servers/info/AlertRules.vue'
import { serviceLine } from '@/components/servers/logic'

const props = defineProps<{ id: SettingsRowId; label: string; ctx: DevServerSettingsContext }>()

const s = computed(() => props.ctx.settings.value)
const dev = useDevServers()
const running = props.ctx.running
const starting = computed(() => dev.status.value?.state === 'starting')
const dot = { ok: 'var(--success)', busy: 'var(--warning, var(--text-muted))', bad: 'var(--danger)', idle: 'var(--text-muted)' }
const devLine = computed(() => {
  const line = serviceLine(dev.status.value)
  return { ...line, background: dot[line.tone] }
})
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

// The store polls the status only while something says it is on screen.
let releaseStore: (() => void) | null = null
onMounted(() => {
  releaseStore = dev.use({ quiet: true })
})
onBeforeUnmount(() => releaseStore?.())

const confirmStop = ref(false)
async function serviceAction(action: 'start' | 'restart' | 'stop') {
  confirmStop.value = false
  await dev.service(action)
}

const restarting = ref(false)
const restartNote = ref('')
async function restartAll() {
  restarting.value = true
  restartNote.value = ''
  try {
    const r = await restartRunning()
    restartNote.value = `${r.restarted.length} server${r.restarted.length === 1 ? '' : 's'} restarted.`
  } catch (e) {
    restartNote.value = message(e)
  } finally {
    restarting.value = false
  }
}

const scanning = ref<DevWebScanPreset | null>(null)
const scanNote = ref('')
async function scan(preset: DevWebScanPreset) {
  scanning.value = preset
  scanNote.value = ''
  try {
    const r = await scanProjects(preset)
    scanNote.value = `Found ${r.files.length} .devwebui file${r.files.length === 1 ? '' : 's'} and ${r.detected.length} project folder${r.detected.length === 1 ? '' : 's'} in ${(r.ms / 1000).toFixed(1)}s.`
    await dev.refresh()
  } catch (e) {
    scanNote.value = message(e)
  } finally {
    scanning.value = null
  }
}

const ignored = ref<string[]>([])
const ignoredError = ref('')
async function loadIgnored() {
  try {
    ignored.value = (await ignoredFolders()).paths
    ignoredError.value = ''
  } catch (e) {
    ignoredError.value = message(e)
  }
}
const unignoring = ref<string | null>(null)
async function unignore(path: string) {
  unignoring.value = path
  try {
    ignored.value = (await unignoreFolder(path)).paths
  } catch (e) {
    ignoredError.value = message(e)
  } finally {
    unignoring.value = null
  }
}
watch(
  [() => props.id, running],
  ([id, on]) => {
    if (id === 'dwIgnored' && on) void loadIgnored()
  },
  { immediate: true }
)

const confirmForget = ref(false)
const forgetNote = ref('')
async function forget() {
  confirmForget.value = false
  try {
    await forgetFound()
    forgetNote.value = 'Cleared.'
    await dev.refresh()
  } catch (e) {
    forgetNote.value = message(e)
  }
}

async function saveRuntime(runtime: 'auto' | 'node' | 'bun') {
  if (!s.value) return
  await props.ctx.save({ runtime })
}

function saveText(e: Event) {
  const box = e.target as HTMLInputElement
  const v = box.value.trim()
  if (s.value && props.id === 'dwLinkHost' && v !== s.value.linkHost) {
    void props.ctx.save({ linkHost: v })
  }
}

function saveExclude(e: Event) {
  const box = e.target as HTMLTextAreaElement
  const v = box.value.split('\n').map((l) => l.trim()).filter(Boolean)
  if (s.value && JSON.stringify(v) !== JSON.stringify(s.value.scanExclude)) {
    void props.ctx.save({ scanExclude: v })
  }
}
</script>

<template>
  <div v-if="id === 'dwService'" class="flex flex-wrap items-center justify-end gap-2">
    <span class="flex items-center gap-2 text-[13px] leading-4.75 text-text-2">
      <span class="inline-block size-2 rounded-full" :style="{ background: devLine.background }" />
      {{ devLine.text }}
    </span>
    <button v-if="!running" type="button" :class="BUTTON" :disabled="starting" @click="serviceAction('start')">Start</button>
    <template v-else>
      <button type="button" :class="BUTTON" @click="serviceAction('restart')">Restart</button>
      <template v-if="!confirmStop">
        <button type="button" :class="BUTTON" @click="confirmStop = true">Stop</button>
      </template>
      <template v-else>
        <span class="text-[12px] leading-4.5 text-text-muted">Also stops the servers the service started.</span>
        <button type="button" :class="BUTTON" @click="serviceAction('stop')">Stop and end them</button>
        <button type="button" :class="BUTTON" @click="confirmStop = false">Cancel</button>
      </template>
    </template>
  </div>

  <span v-else-if="!running" class="text-[13px] leading-4.75 text-text-muted">Start the dev-servers service to change this.</span>

  <span v-else-if="!s" class="text-[13px] leading-4.75 text-text-muted">Loading…</span>

  <div v-else-if="id === 'dwRuntime'" role="radiogroup" aria-label="Runtime" class="flex h-7 shrink-0 items-center gap-px rounded-(--radius-7) bg-fill-5 p-px">
    <button
      v-for="opt in ['auto', 'node', 'bun'] as const"
      :key="opt"
      type="button"
      role="radio"
      :aria-checked="s.runtime === opt"
      :tabindex="s.runtime === opt ? 0 : -1"
      class="flex h-6.5 cursor-default items-center rounded-(--radius-5) px-2.5 text-[13px] leading-4.75 text-text-2 transition-colors duration-60 hover:text-text focus-visible:shadow-(--focus-ring) focus-visible:outline-none aria-checked:bg-(--fill-secondary) aria-checked:text-text"
      @click="saveRuntime(opt)"
    >
      {{ opt === 'auto' ? 'Auto' : opt === 'node' ? 'Node' : 'Bun' }}
    </button>
  </div>

  <PaneSwitch v-else-if="id === 'dwAutoStart'" label="Start on launch" :model-value="s.autoStartOnLaunch" @update:model-value="(v) => props.ctx.save({ autoStartOnLaunch: v })" />

  <PaneSwitch v-else-if="id === 'dwFreePort'" label="Free a port on start" :model-value="s.freePortOnStart" @update:model-value="(v) => props.ctx.save({ freePortOnStart: v })" />

  <div v-else-if="id === 'dwRestartRunning'" class="flex items-center gap-2">
    <span v-if="restartNote" class="text-[12px] leading-4.5 text-text-muted">{{ restartNote }}</span>
    <button type="button" :class="BUTTON" :disabled="restarting" @click="restartAll">
      <LoaderCircle v-if="restarting" class="size-3.5 animate-spin" />
      Restart running
    </button>
  </div>

  <PaneSwitch v-else-if="id === 'dwMonitor'" label="Resource monitoring" :model-value="s.monitorResources" @update:model-value="(v) => props.ctx.save({ monitorResources: v })" />

  <input
    v-else-if="id === 'dwLinkHost'"
    type="text"
    :value="s.linkHost"
    :placeholder="'localhost'"
    aria-label="Link host"
    :class="[FIELD, 'w-56']"
    @change="saveText"
    @keydown.enter="($event.target as HTMLInputElement).blur()"
  />

  <PaneSwitch v-else-if="id === 'dwAutoScan'" label="Scan on launch" :model-value="s.autoScan" @update:model-value="(v) => props.ctx.save({ autoScan: v })" />

  <div v-else-if="id === 'dwSkip'" class="flex shrink-0 items-center gap-3">
    <PaneSwitch label="Windows" :model-value="s.skipWindows" @update:model-value="(v) => props.ctx.save({ skipWindows: v })" />
    <PaneSwitch label="macOS" :model-value="s.skipMac" @update:model-value="(v) => props.ctx.save({ skipMac: v })" />
    <PaneSwitch label="Linux" :model-value="s.skipLinux" @update:model-value="(v) => props.ctx.save({ skipLinux: v })" />
  </div>

  <textarea
    v-else-if="id === 'dwExclude'"
    :value="s.scanExclude.join('\n')"
    aria-label="Exclude folders"
    rows="4"
    :class="[FIELD, 'w-full max-w-100 resize-none font-mono text-[12px]']"
    @change="saveExclude"
    @keydown.enter.meta.prevent="($event.target as HTMLTextAreaElement).blur()"
  />

  <div v-else-if="id === 'dwScanNow'" class="flex flex-col items-end gap-1">
    <div class="flex items-center gap-2">
      <button v-for="p in ['quick', 'deep'] as const" :key="p" type="button" :class="BUTTON" :disabled="!!scanning" @click="scan(p)">
        <LoaderCircle v-if="scanning === p" class="size-3.5 animate-spin" />
        {{ p === 'quick' ? 'Quick scan' : 'Deep scan' }}
      </button>
    </div>
    <span v-if="scanNote" class="text-[12px] leading-4.5 text-text-muted">{{ scanNote }}</span>
  </div>

  <div v-else-if="id === 'dwIgnored'" class="w-full max-w-100 space-y-1">
    <div v-if="ignoredError" class="text-[12px] leading-4.5 text-danger-text">{{ ignoredError }}</div>
    <div v-if="!ignored.length" class="text-[13px] leading-4.75 text-text-muted">No ignored folders.</div>
    <div v-for="p in ignored" :key="p" class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-text-2" :title="p">{{ p }}</span>
      <button type="button" :class="BUTTON" :disabled="unignoring === p" :aria-busy="unignoring === p" @click="unignore(p)">Unignore</button>
    </div>
  </div>

  <div v-else-if="id === 'dwForgetFound'" class="flex items-center gap-2">
    <span v-if="forgetNote" class="text-[12px] leading-4.5 text-text-muted">{{ forgetNote }}</span>
    <button v-if="!confirmForget" type="button" :class="BUTTON" @click="((confirmForget = true), (forgetNote = ''))">Forget found</button>
    <template v-else>
      <button type="button" :class="BUTTON" @click="forget">Yes, clear the found list</button>
      <button type="button" :class="BUTTON" @click="confirmForget = false">Cancel</button>
    </template>
  </div>

  <AlertRules v-else-if="id === 'dwAlerts'" />
</template>
