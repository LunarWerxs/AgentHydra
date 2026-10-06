<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConnectorAction, ConnectorView } from '@shared/connectors'
import PaneSwitch from '@/components/panes/PaneSwitch.vue'
import { Tip } from '@/components/ui/tooltip'
import { serviceLine } from '@/components/servers/logic'
import { useDevServers } from '@/components/servers/store'
import { BUTTON } from '@/components/panes/settings-styles'
import { listConnectors, runConnectorAction } from './api'
import { note, pollDelay, rowButtons, stateLabel, stateTone, versionLabel } from './settings-logic'

// Settings → Connectors: one row per outside app Desk hooks in (shared/connectors.ts). Polled every 3 s while
// one installs or starts, else every 15 s, and only while this section is on screen.
const views = ref<ConnectorView[]>([])
const loaded = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let gone = false

async function load() {
  try {
    views.value = await listConnectors()
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  loaded.value = true
  if (!gone) timer = setTimeout(load, pollDelay(views.value))
}

async function act(v: ConnectorView, action: ConnectorAction) {
  try {
    const next = await runConnectorAction(v.id, action)
    views.value = views.value.map((x) => (x.id === next.id ? next : x))
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  // An install or start is now under way: look again soon, not in 15 s.
  if (timer) clearTimeout(timer)
  if (!gone) timer = setTimeout(load, pollDelay(views.value))
}

// The dev-servers row also shows the service itself (GET /dw/status, through the shared client that polls only while
// this section is on screen): its state, and Restart / Stop. It asks for nothing: the service is not started from here.
const dev = useDevServers()
const devLine = computed(() => serviceLine(dev.status.value))
const devBusy = ref(false)
const devError = ref<string | null>(null)
let releaseDev: (() => void) | null = null
async function devService(action: 'restart' | 'stop') {
  devBusy.value = true
  devError.value = null
  try {
    await dev.service(action)
  } catch (e) {
    devError.value = e instanceof Error ? e.message : String(e)
  } finally {
    devBusy.value = false
  }
}

const open = (v: ConnectorView) => v.url && window.open(v.url, '_blank', 'noopener')
const dot = { ok: 'var(--success)', busy: 'var(--warning, var(--text-muted))', bad: 'var(--danger)', idle: 'var(--text-muted)' }

onMounted(() => {
  releaseDev = dev.use({ quiet: true })
  void load()
})
onBeforeUnmount(() => {
  gone = true
  releaseDev?.()
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div role="group" aria-label="Connectors">
    <h3 class="text-[13px] font-semibold leading-5 text-text">Connectors</h3>
    <p class="mt-0.5 text-[13px] leading-[19px] text-text-muted">
      Outside apps Desk hooks in without copying them. While one runs, every chat you start gets its tools and one paragraph of prompt.
    </p>
    <p v-if="error" class="mt-2 text-[13px] leading-[19px] text-danger-text">{{ error }}</p>
    <p v-if="!loaded" class="mt-4 text-[13px] leading-[19px] text-text-muted">Loading…</p>
    <div v-for="v in views" :key="v.id" class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3.5 last:border-b-0">
      <div class="min-w-[200px] flex-1">
        <div class="flex items-center gap-2 text-[13px] leading-5 text-text">
          {{ v.name }}
          <span v-if="versionLabel(v)" class="font-mono text-[12px] text-text-muted">{{ versionLabel(v) }}</span>
        </div>
        <div class="mt-0.5 text-[13px] leading-[19px] text-text-muted">{{ v.blurb }}</div>
        <div class="mt-0.5 flex items-center gap-2 break-words text-[13px] leading-[19px] text-text-2">
          <span class="inline-block size-2 shrink-0 rounded-full" :style="{ background: dot[stateTone(v)] }" />
          {{ stateLabel(v) }}
        </div>
        <div v-if="note(v)" class="mt-0.5 break-words text-[12px] leading-[18px] text-text-muted">{{ note(v) }}</div>
        <template v-if="v.id === 'devwebui'">
          <div class="mt-0.5 flex items-center gap-2 break-words text-[13px] leading-[19px] text-text-2" role="status" aria-label="Dev servers service">
            <span class="inline-block size-2 shrink-0 rounded-full" :style="{ background: dot[devLine.tone] }" />
            {{ devLine.text }}
          </div>
          <div v-if="devError" class="mt-0.5 break-words text-[12px] leading-[18px] text-danger-text">{{ devError }}</div>
        </template>
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-3">
        <button v-if="rowButtons(v).install" type="button" :class="BUTTON" @click="act(v, 'install')">Install</button>
        <button v-if="rowButtons(v).start" type="button" :class="BUTTON" @click="act(v, 'start')">Start</button>
        <button v-if="rowButtons(v).open" type="button" :class="BUTTON" @click="open(v)">Open</button>
        <template v-if="v.id === 'devwebui'">
          <button type="button" :class="BUTTON" :disabled="devBusy" @click="devService('restart')">Restart</button>
          <Tip label="Stops the dev servers AgentHydra started">
            <button type="button" :class="BUTTON" :disabled="devBusy || dev.status.value?.state === 'stopped'" @click="devService('stop')">Stop</button>
          </Tip>
        </template>
        <a :href="v.homepage" target="_blank" rel="noopener noreferrer" class="text-[13px] leading-[19px] text-text-2 underline hover:text-text">Homepage</a>
        <span class="text-[13px] leading-[19px] text-text-muted">Give chats its tools</span>
        <PaneSwitch :label="`Give chats ${v.name}'s tools`" :model-value="v.enabled" @update:model-value="(on: boolean) => act(v, on ? 'enable' : 'disable')" />
      </div>
    </div>
  </div>
</template>
