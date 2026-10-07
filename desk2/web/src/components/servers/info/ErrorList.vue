<script setup lang="ts">
import { ref, watch } from 'vue'
import type { DevWebErrorEntry, DevWebSourceFrame } from '@shared/devwebui'
import { clearErrors, dismissError, errorList, openInEditor } from '../api'
import { useDevServers } from '../store'
import { ago } from './format'

// A server's de-duplicated errors, newest first: the text it printed (three lines, expandable), how often, when it was
// last seen, the files it names as links that open the editor, and Dismiss / Clear all. Reloaded on each poll answer.
const props = defineProps<{ processId: string }>()
const servers = useDevServers()
const list = ref<DevWebErrorEntry[]>([])
const open = ref(new Set<string>())
const failure = ref<string | null>(null)
async function load() {
  try {
    list.value = await errorList(props.processId, { start: false })
  } catch {
    // floor-ok: a failed read keeps the list as it was; the next poll asks again
  }
}
watch([() => props.processId, servers.answered], load, { immediate: true })

const toggle = (fp: string) => {
  const next = new Set(open.value)
  if (!next.delete(fp)) next.add(fp)
  open.value = next
}
async function jump(f: DevWebSourceFrame) {
  failure.value = null
  try {
    const r = await openInEditor({ file: f.file, line: f.line, column: f.column, processId: props.processId })
    if (!r.ok) failure.value = r.detail ?? `Could not open it (${r.reason}).`
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err)
  }
}
async function dismiss(e: DevWebErrorEntry) {
  await dismissError(e.fingerprint).catch((err) => (failure.value = String(err)))
  await load()
  await servers.refresh()
}
async function clearAll() {
  await clearErrors(props.processId).catch((err) => (failure.value = String(err)))
  await load()
  await servers.refresh()
}
const frameText = (f: DevWebSourceFrame) => `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}`
const LINK = 'break-all rounded-[4px] text-left font-mono text-[11px] text-accent-text hover:underline'
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center">
      <h3 class="flex-1 text-[12px] font-medium text-text-2">Errors<span v-if="list.length" class="ml-1 text-text-muted tnum">{{ list.length }}</span></h3>
      <button v-if="list.length" type="button" class="rounded-[4px] px-1 text-[12px] text-text-2 hover:bg-fill-hover" @click="clearAll">Clear all</button>
    </div>
    <p v-if="failure" role="alert" class="text-[12px] text-danger-text">{{ failure }}</p>
    <p v-if="!list.length" class="text-text-muted">No errors recorded.</p>
    <ul v-else class="flex flex-col gap-2">
      <li v-for="e in list" :key="e.fingerprint" class="rounded-[var(--radius-6)] bg-[var(--fill-secondary)] p-2">
        <pre class="whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-danger-text" :class="open.has(e.fingerprint) ? '' : 'line-clamp-3'">{{ e.sample }}</pre>
        <button v-if="e.sample.split('\n').length > 3 || e.sample.length > 240" type="button" class="text-[11px] text-text-muted hover:text-text" @click="toggle(e.fingerprint)">{{ open.has(e.fingerprint) ? 'Show less' : 'Show more' }}</button>
        <div v-if="e.frames.length" class="mt-1 flex flex-col items-start gap-0.5">
          <button v-for="f in e.frames" :key="frameText(f)" type="button" :class="LINK" :aria-label="`Open ${frameText(f)} in the editor`" @click="jump(f)">{{ frameText(f) }}</button>
        </div>
        <div class="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
          <span class="tnum">×{{ e.count }}</span>
          <span>last seen {{ ago(e.lastSeen) }}</span>
          <span class="flex-1" />
          <button type="button" class="rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="dismiss(e)">Dismiss</button>
        </div>
      </li>
    </ul>
  </div>
</template>
