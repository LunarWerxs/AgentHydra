<script lang="ts">
import type { DevWebErrorEntry as Entry } from '@shared/devwebui'
import { memo } from './nav'
// Module level, so it outlives a remount: the last list read per server id.
const cache = memo<Entry[]>()
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CheckCircle2, ChevronRight, Clock, ExternalLink, FileCode } from '@lucide/vue'
import type { DevWebErrorEntry, DevWebErrorSource, DevWebSourceFrame } from '@shared/devwebui'
import { useClock } from '@/lib/clock'
import { clearErrors, dismissError, errorList, openInEditor } from '../api'
import { useDevServers } from '../store'
import { ago, clockTime } from './format'
import { BTN_DANGER_SM, BTN_GHOST, BTN_GHOST_SM, CARD, CHIP, chip } from './kit/kit'
import EmptyState from './kit/EmptyState.vue'

// A server's Errors tab (owner, 2026-10-07: "The errors look like shit"): its de-duplicated errors, newest first, each
// a card with where it came from, how often, the message as a title over the rest of the text, when it was first and
// last seen, and the files it names, which open in the editor. Dismiss one, or Clear all after a confirm since it
// cannot be undone. Reloaded on each poll answer; the last list read per server shows at once on a remount.
const props = defineProps<{ processId: string }>()
const servers = useDevServers()
const now = useClock(30_000)

const list = ref<DevWebErrorEntry[]>(cache.get(props.processId) ?? [])
const failure = ref<string | null>(null)
const confirming = ref(false)

async function load() {
  const id = props.processId
  const cached = cache.get(id)
  if (cached && list.value !== cached) list.value = cached
  try {
    const got = await errorList(id, { start: false })
    cache.set(id, got)
    if (id === props.processId) list.value = got
  } catch {
    // floor-ok: a failed read keeps the list as it was; the next poll asks again
  }
}
watch([() => props.processId, servers.answered], load, { immediate: true })
watch(() => props.processId, () => (confirming.value = false))

// The long text is clamped to six lines; "Show more" opens it.
const expanded = ref(new Set<string>())
const toggleText = (fp: string) => {
  const next = new Set(expanded.value)
  if (!next.delete(fp)) next.add(fp)
  expanded.value = next
}
// Source frames: the first error's start open, the rest closed; a click flips that default.
const flipped = ref(new Set<string>())
const framesOpen = (e: DevWebErrorEntry, i: number) => (i === 0) !== flipped.value.has(e.fingerprint)
const toggleFrames = (fp: string) => {
  const next = new Set(flipped.value)
  if (!next.delete(fp)) next.add(fp)
  flipped.value = next
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
  confirming.value = false
  await clearErrors(props.processId).catch((err) => (failure.value = String(err)))
  await load()
  await servers.refresh()
}

const SOURCE: Record<DevWebErrorSource, string> = { stderr: 'Printed', stdout: 'Output', crash: 'Crash' }
const title = (e: DevWebErrorEntry) => e.sample.split('\n')[0] || e.sample
const rest = (e: DevWebErrorEntry) => e.sample.split('\n').slice(1).join('\n').trim()
const isLong = (text: string) => text.split('\n').length > 6 || text.length > 480
const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file
const folder = (file: string) => {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return i > 0 ? file.slice(0, i) : ''
}
const at = (f: DevWebSourceFrame) => `:${f.line}${f.column ? `:${f.column}` : ''}`
const count = computed(() => list.value.length)
const CODE = 'whitespace-pre-wrap break-words rounded-[var(--radius-6)] bg-bg-deepest p-3 font-mono text-[12px] leading-5 text-text-2'
</script>

<template>
  <div class="flex flex-col gap-4">
    <div v-if="count" class="flex min-h-8 flex-wrap items-center gap-2">
      <span class="text-[13px] font-medium text-text tnum">{{ count }} {{ count === 1 ? 'error' : 'errors' }}</span>
      <span class="text-[12px] text-text-muted">grouped by message</span>
      <span class="flex-1" />
      <template v-if="confirming">
        <span class="text-[12px] text-text-2 tnum">Clear all {{ count }}?</span>
        <button type="button" :class="BTN_DANGER_SM" @click="clearAll">Clear</button>
        <button type="button" :class="BTN_GHOST_SM" @click="confirming = false">Keep</button>
      </template>
      <button v-else type="button" :class="BTN_GHOST" @click="confirming = true">Clear all</button>
    </div>
    <p v-if="failure" role="alert" class="text-[12px] text-danger-text">{{ failure }}</p>

    <EmptyState
      v-if="!count"
      :icon="CheckCircle2"
      tone="success"
      title="No errors recorded"
      text="Errors this server prints show here, grouped by message, with the file and line they came from."
    />
    <ul v-else class="flex flex-col gap-3">
      <li v-for="(e, i) in list" :key="e.fingerprint" :class="CARD" class="flex flex-col gap-3 p-4">
        <div class="flex items-center gap-2">
          <span :class="CHIP">{{ SOURCE[e.source] ?? e.source }}</span>
          <span :class="chip('danger')" class="font-medium tnum" :title="`Seen ${e.count} ${e.count === 1 ? 'time' : 'times'}`">×{{ e.count }}</span>
          <span class="flex-1" />
          <button type="button" :class="BTN_GHOST_SM" @click="dismiss(e)">Dismiss</button>
        </div>

        <div class="flex flex-col gap-2">
          <p class="break-words text-[13px] font-medium leading-5 text-danger-text">{{ title(e) }}</p>
          <template v-if="rest(e)">
            <pre :class="[CODE, expanded.has(e.fingerprint) ? '' : 'line-clamp-6']">{{ rest(e) }}</pre>
            <button v-if="isLong(rest(e))" type="button" :class="BTN_GHOST_SM" class="self-start" @click="toggleText(e.fingerprint)">
              {{ expanded.has(e.fingerprint) ? 'Show less' : 'Show more' }}
            </button>
          </template>
        </div>

        <p class="flex items-center gap-1.5 text-[12px] text-text-muted">
          <Clock class="size-3.5 shrink-0" aria-hidden="true" />
          <span>First seen {{ clockTime(e.firstSeen, now) }} · <span :title="clockTime(e.lastSeen, now)">last seen {{ ago(e.lastSeen, now) }}</span></span>
        </p>

        <div v-if="e.frames.length" class="flex flex-col gap-1">
          <button type="button" :class="BTN_GHOST_SM" class="-ml-2 self-start" :aria-expanded="framesOpen(e, i)" @click="toggleFrames(e.fingerprint)">
            <ChevronRight
              class="size-3.5 transition-transform duration-[var(--dur-fast)] motion-reduce:transition-none"
              :class="framesOpen(e, i) ? 'rotate-90' : ''"
              aria-hidden="true"
            />
            Source · {{ e.frames.length }} {{ e.frames.length === 1 ? 'frame' : 'frames' }}
          </button>
          <div v-if="framesOpen(e, i)" class="flex flex-col divide-y divide-border overflow-hidden rounded-[var(--radius-6)] shadow-[inset_0_0_0_1px_var(--border)]">
            <button
              v-for="(f, j) in e.frames"
              :key="`${f.file}${at(f)}#${j}`"
              type="button"
              class="group flex min-h-8 min-w-0 cursor-default items-center gap-2 px-3 text-left text-[12px] hover:bg-fill-hover focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
              :aria-label="`Open ${f.file}:${f.line} in the editor`"
              :title="`${f.file}${at(f)}`"
              @click="jump(f)"
            >
              <FileCode class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              <span class="shrink-0 font-mono text-text">{{ baseName(f.file) }}<span class="text-text-2 tnum">{{ at(f) }}</span></span>
              <span class="min-w-0 flex-1 truncate font-mono text-text-muted"><bdi>{{ folder(f.file) }}</bdi></span>
              <ExternalLink class="size-3.5 shrink-0 text-text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
            </button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
