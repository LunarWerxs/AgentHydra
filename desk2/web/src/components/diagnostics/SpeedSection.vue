<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { GroupStats, StageStats, TimingsResponse } from '@shared/timings'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'
import { barPct, ms, partLabel, rowLabel, stageParts } from './speed'

// Speed: what is slow right now (today, by time lost), per-stage p50/p90 bars, the slowest turns, what a cold
// start is made of, the worker chats' waits, and turns by account, model and folder.
const api = usePaneApi()
const src = useShellSource()
const data = ref<TimingsResponse | null>(null)
const error = ref<string | null>(null)
const range = ref<'today' | 'week'>('today')

async function load(): Promise<void> {
  try {
    data.value = await api.diagnostics<TimingsResponse>('timings')
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(load)

// Every list guarded: an older server, or a gallery fake, may answer without it.
const list = <T,>(k: keyof TimingsResponse): T[] => ((data.value?.[k] as T[] | undefined) ?? [])
const stages = computed(() => list<StageStats>(range.value))
const stageMax = computed(() => Math.max(0, ...stages.value.map((s) => s.max)))
const slowNow = computed(() => list<StageStats>('slowNow').slice(0, 10))
const turns = computed(() => list<TimingsResponse['slowestTurns'][number]>('slowestTurns'))
const coldStart = computed(() => list<StageStats>('coldStart'))
const ready = computed(() => list<GroupStats>('ready'))
const workers = computed(() => list<StageStats>('workers'))
const groups = computed(() => [
  { h: 'By account', d: list<GroupStats>('byAccount') },
  { h: 'By model', d: list<GroupStats>('byModel') },
  { h: 'By folder', d: list<GroupStats>('byFolder') }
])
const when = (ts: number): string => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
// Each slow turn's stage parts and its chat's title (null when the chat is gone), worked out once per change.
const turnRows = computed(() => {
  const titles = new Map(src.chats.value.map((c) => [c.id, c.title || 'Open chat']))
  return turns.value.map((t) => ({ t, parts: stageParts(t.stages), title: t.chatId ? (titles.get(t.chatId) ?? null) : null }))
})
const COLD: Record<string, string> = { new: 'New process', resume: 'Resumed session', warm: 'Warm start', running: 'Already running' }
</script>

<template>
  <div class="text-[13px] leading-4.75" data-testid="speed">
    <p v-if="error" class="text-danger-text">Could not load timings: {{ error }}</p>
    <p v-else-if="!data" class="text-text-muted">Loading…</p>
    <template v-else>
      <h3 class="text-[13px] font-semibold leading-5 text-text">What is slow right now <span class="font-normal text-text-muted">(today, by time lost)</span></h3>
      <p v-if="!slowNow.length" class="mt-1 text-text-muted">Nothing measured today.</p>
      <ol v-else class="mt-1">
        <li v-for="r in slowNow" :key="r.stage + (r.name ?? '')" class="flex justify-between gap-3 border-b border-border py-1 last:border-b-0">
          <span class="truncate text-text-2" :title="rowLabel(r)">{{ rowLabel(r) }}</span>
          <span class="tnum shrink-0 text-text-muted">{{ r.count }}× · p50 {{ ms(r.p50) }}</span>
          <span class="tnum w-20 shrink-0 text-end text-text">{{ ms(r.totalMs) }}</span>
        </li>
      </ol>

      <div class="mt-8 flex items-baseline gap-3">
        <h3 class="text-[13px] font-semibold leading-5 text-text">Per stage</h3>
        <button
          v-for="k in ['today', 'week'] as const"
          :key="k"
          type="button"
          class="cursor-default rounded px-1.5 text-[12px]"
          :class="range === k ? 'bg-fill-selected text-text' : 'text-text-muted hover:text-text'"
          @click="range = k"
        >
          {{ k === 'today' ? 'Today' : '7 days' }}
        </button>
        <span class="ms-auto text-[12px] text-text-muted">bar = p50, lighter = p90</span>
      </div>
      <p v-if="!stages.length" class="mt-1 text-text-muted">No spans yet.</p>
      <ul v-else class="mt-1">
        <li v-for="s in stages" :key="s.stage" class="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 py-1">
          <span class="truncate text-text-2">{{ rowLabel(s) }} <span class="tnum text-text-muted">({{ s.count }})</span></span>
          <span class="relative h-2 rounded bg-fill-5">
            <span class="absolute inset-y-0 left-0 rounded bg-fill-selected" :style="{ width: barPct(s.p90, stageMax) + '%' }" />
            <span class="absolute inset-y-0 left-0 rounded bg-text-muted" :style="{ width: barPct(s.p50, stageMax) + '%' }" />
          </span>
          <span class="tnum text-end text-text">{{ ms(s.p50) }} / {{ ms(s.p90) }} <span class="text-text-muted">max {{ ms(s.max) }}</span></span>
        </li>
      </ul>

      <h3 class="mt-8 text-[13px] font-semibold leading-5 text-text">Slowest turns <span class="font-normal text-text-muted">(7 days)</span></h3>
      <p v-if="!turns.length" class="mt-1 text-text-muted">No turns measured yet.</p>
      <ul v-else>
        <li v-for="{ t, parts, title } in turnRows" :key="t.turnId || t.ts" class="border-b border-border py-2 last:border-b-0">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <span class="tnum text-text">{{ ms(t.ms) }}</span>
            <span class="tnum text-text-muted">{{ when(t.ts) }}</span>
            <span class="text-text-muted">{{ t.kind }}<template v-if="t.cold"> · {{ COLD[t.cold] ?? t.cold }}</template><template v-if="t.model"> · {{ t.model }}</template><template v-if="t.accountNumber !== null"> · #{{ t.accountNumber }}</template></span>
            <span v-if="!t.ok" class="text-danger-text">failed</span>
            <button
              v-if="t.chatId && title !== null"
              type="button"
              class="ms-auto cursor-default text-text-2 underline-offset-2 hover:text-text hover:underline"
              @click="src.select({ kind: 'chat', id: t.chatId })"
            >
              {{ title }}
            </button>
          </div>
          <div v-if="parts.length" class="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-text-muted">
            <span v-for="[k, v] in parts" :key="k" class="tnum">{{ partLabel(k) }} {{ ms(v) }}</span>
          </div>
        </li>
      </ul>

      <div class="mt-8 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 class="text-[13px] font-semibold leading-5 text-text">Cold start <span class="font-normal text-text-muted">(7 days, by time lost)</span></h3>
          <p v-if="!coldStart.length" class="mt-1 text-text-muted">No cold starts measured yet.</p>
          <ul v-else class="mt-1">
            <li v-for="r in coldStart" :key="r.stage + (r.name ?? '')" class="flex justify-between gap-3 border-b border-border py-1 last:border-b-0">
              <span class="truncate text-text-2" :title="rowLabel(r)">{{ rowLabel(r) }}</span>
              <span class="tnum shrink-0 text-text">{{ r.count }}× · p50 {{ ms(r.p50) }} · max {{ ms(r.max) }}</span>
            </li>
          </ul>
          <h4 class="mt-4 text-[12px] font-semibold text-text-2">Send to ready, by how the process stood</h4>
          <p v-if="!ready.length" class="mt-1 text-text-muted">None yet.</p>
          <ul v-else class="mt-1">
            <li v-for="g in ready" :key="g.key" class="flex justify-between gap-3 border-b border-border py-1 last:border-b-0">
              <span class="text-text-2">{{ COLD[g.key] ?? g.key }} <span class="tnum text-text-muted">({{ g.turns }})</span></span>
              <span class="tnum text-text">p50 {{ ms(g.p50) }} · p90 {{ ms(g.p90) }}</span>
            </li>
          </ul>
        </div>
        <div>
          <h3 class="text-[13px] font-semibold leading-5 text-text">Worker chats <span class="font-normal text-text-muted">(7 days)</span></h3>
          <p v-if="!workers.length" class="mt-1 text-text-muted">No worker waits measured yet.</p>
          <ul v-else class="mt-1">
            <li v-for="r in workers" :key="r.stage + (r.name ?? '')" class="flex justify-between gap-3 border-b border-border py-1 last:border-b-0">
              <span class="truncate text-text-2" :title="rowLabel(r)">{{ rowLabel(r) }}</span>
              <span class="tnum shrink-0 text-text">{{ r.count }}× · p50 {{ ms(r.p50) }} · p90 {{ ms(r.p90) }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div class="mt-8 grid gap-6 sm:grid-cols-3">
        <div v-for="g in groups" :key="g.h">
          <h3 class="text-[13px] font-semibold leading-5 text-text">{{ g.h }} <span class="font-normal text-text-muted">(turns, 7 days)</span></h3>
          <p v-if="!g.d.length" class="mt-1 text-text-muted">None</p>
          <ul v-else class="mt-1">
            <li v-for="r in g.d" :key="r.key" class="flex justify-between gap-3 border-b border-border py-1 last:border-b-0">
              <span class="truncate text-text-2" :title="r.key">{{ r.key }} <span class="tnum text-text-muted">({{ r.turns }})</span></span>
              <span class="tnum shrink-0 text-text">p50 {{ ms(r.p50) }}</span>
            </li>
          </ul>
        </div>
      </div>
      <p class="mt-6 text-[12px] text-text-muted">{{ data.spans ?? 0 }} spans in the last 7 days, from timings.jsonl.</p>
    </template>
  </div>
</template>
