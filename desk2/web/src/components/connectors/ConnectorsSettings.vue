<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConnectorAction, ConnectorView } from '@shared/connectors'
import PaneSwitch from '@/components/panes/PaneSwitch.vue'
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

const open = (v: ConnectorView) => v.url && window.open(v.url, '_blank', 'noopener')
const dot = { ok: 'var(--success)', busy: 'var(--warning, var(--text-muted))', bad: 'var(--danger)', idle: 'var(--text-muted)' }

onMounted(load)
onBeforeUnmount(() => {
  gone = true
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
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-3">
        <button v-if="rowButtons(v).install" type="button" :class="BUTTON" @click="act(v, 'install')">Install</button>
        <button v-if="rowButtons(v).start" type="button" :class="BUTTON" @click="act(v, 'start')">Start</button>
        <button v-if="rowButtons(v).open" type="button" :class="BUTTON" @click="open(v)">Open</button>
        <a :href="v.homepage" target="_blank" rel="noopener noreferrer" class="text-[13px] leading-[19px] text-text-2 underline hover:text-text">Homepage</a>
        <span class="text-[13px] leading-[19px] text-text-muted">Give chats its tools</span>
        <PaneSwitch :label="`Give chats ${v.name}'s tools`" :model-value="v.enabled" @update:model-value="(on: boolean) => act(v, on ? 'enable' : 'disable')" />
      </div>
    </div>
  </div>
</template>
