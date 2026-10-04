<script setup lang="ts">
// The orchestration log of the selected CliMayte task, or of everything handed off with it
// (server/src/climayte-journal.ts, GET /api/corch/journal). One line per change: where each attempt ran
// and why that account was picked, limits, moves, handoffs, messages, retries, the finish and its
// cost. The owner asked for it on the first real climayte run ("we probably also need logging in
// CliMayte", 2026-09-30). The server keeps the facts; the words are rendered here, through vue-i18n.
//
// Reloads when the task changes (its `updatedAt`), and every 10 s for a hand-off's log, whose other
// tasks change without this one noticing.
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import type { CliMayteJournalEntry } from '@/lib/api'
import { getCliMayteJournal } from '@/lib/api'
import { modelName } from '@/lib/climayte-status'
import { formatUsd } from '@/lib/kit'

/** `fill`: the box takes the height its parent gives it on a wide screen (CliMayteWorkerDetail). */
const props = defineProps<{ workerId: string; group: string; updatedAt: number; fill?: boolean }>()

const { t } = useI18n()
const scope = ref<'task' | 'group'>('task')
const entries = ref<CliMayteJournalEntry[]>([])
const failed = ref(false)
const loadedOnce = ref(false)
let timer: number | null = null
let seq = 0

async function load() {
  const mine = ++seq
  try {
    const list = await getCliMayteJournal(
      scope.value === 'task'
        ? { id: props.workerId, limit: 300 }
        : { group: props.group, limit: 300 },
    )
    if (mine !== seq) return
    entries.value = list
    failed.value = false
  } catch {
    if (mine === seq) failed.value = true
  } finally {
    if (mine === seq) loadedOnce.value = true
  }
}

watch(
  () => [props.workerId, props.updatedAt, scope.value] as const,
  ([id], old) => {
    if (old && id !== old[0]) {
      scope.value = 'task'
      entries.value = []
      loadedOnce.value = false
    }
    void load()
  },
  { immediate: true },
)
watch(
  scope,
  (s) => {
    if (timer !== null) window.clearInterval(timer)
    timer = s === 'group' ? window.setInterval(() => void load(), 10_000) : null
  },
  { immediate: true },
)
onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer)
})

const pct = (v: number | null | undefined) => (typeof v === 'number' ? `${Math.round(v)}%` : '?')
const usd = (v: number | undefined) => formatUsd(v ?? 0)
const clock = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : '?')

/** The sentence for one entry. */
function line(e: CliMayteJournalEntry): string {
  const account = e.account ?? '?'
  const pick = { account, session: pct(e.sessionPct), week: pct(e.weekPct), active: e.active ?? 0 }
  switch (e.event) {
    case 'dispatched':
      return e.accounts
        ? t('climayte.log.dispatchedLimited', { cwd: e.cwd ?? '?', n: e.accounts })
        : t('climayte.log.dispatched', { cwd: e.cwd ?? '?' })
    case 'launched':
      return e.attempt && e.attempt > 1
        ? t('climayte.log.launchedAgain', { ...pick, attempt: e.attempt })
        : t('climayte.log.launched', pick)
    case 'moved':
      return t(e.copied === false ? 'climayte.log.movedEmpty' : 'climayte.log.moved', {
        from: e.from ?? '?',
        account,
      })
    case 'limit':
      return t('climayte.log.limit', { account, until: clock(e.until) })
    case 'signed-out':
      return t('climayte.log.signedOut', { account, until: clock(e.until) })
    case 'handoff-requested':
      return typeof e.pct === 'number'
        ? t('climayte.log.handoffRequested', { account, pct: pct(e.pct) })
        : t('climayte.log.handoffAsked')
    case 'handoff-written':
      return t('climayte.log.handoffWritten', { account })
    case 'handoff-resumed':
      return t('climayte.log.handoffResumed', pick)
    case 'follow-up-queued':
      return e.urgent
        ? t('climayte.log.followUpUrgent')
        : t('climayte.log.followUpQueued', { n: e.pending ?? 1 })
    case 'follow-up-delivered':
      return t('climayte.log.followUpDelivered', { account })
    case 'retry':
      return t('climayte.log.retry', { account, s: e.waitS ?? 0, n: e.retry ?? '?' })
    case 'interrupted':
      return t('climayte.log.interrupted', { account, n: e.retry ?? '?' })
    case 'waiting':
      return t('climayte.log.waiting')
    case 'turn-done':
      return t('climayte.log.turnDone', { account, cost: usd(e.costUsd), turns: e.turns ?? 0 })
    case 'turn-end':
      return t('climayte.log.turnEnd', { account })
    case 'done':
      return t('climayte.log.done', { account, cost: usd(e.costUsd), total: usd(e.totalCostUsd) })
    case 'failed':
      return e.account ? t('climayte.log.failed', { account }) : t('climayte.log.failedNoAccount')
    case 'cancelled':
      return e.pending
        ? t('climayte.log.cancelledKept', { n: e.pending })
        : t('climayte.log.cancelled')
    case 'nudged':
      return e.ok
        ? t('climayte.log.nudged', { account, until: clock(e.until) })
        : t('climayte.log.nudgeFailed', { account })
    default:
      return String((e as { event: string }).event)
  }
}

/** The CLI's own words or the error, shown under the sentence. */
const detail = (e: CliMayteJournalEntry) =>
  e.error ??
  e.notice ??
  e.said ??
  // The model and effort a launch or follow-up asked for (product names, not prose).
  ([e.model ? modelName(e.model) : null, e.effort].filter(Boolean).join(' · ') || null)

const rows = computed(() =>
  entries.value.map((e, i) => ({
    key: `${e.ts}-${i}`,
    time: new Date(e.ts),
    who: scope.value === 'group' ? e.title : null,
    text: line(e),
    detail: detail(e),
    bad: e.event === 'failed' || e.event === 'limit' || e.event === 'signed-out',
  })),
)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-center justify-between gap-2">
      <h4 class="text-xs font-medium">{{ $t('climayte.log.title') }}</h4>
      <div class="flex items-center gap-1" role="group" :aria-label="$t('climayte.log.scopeLabel')">
        <Button
          size="xs"
          :variant="scope === 'task' ? 'secondary' : 'ghost'"
          :aria-pressed="scope === 'task'"
          @click="scope = 'task'"
        >{{ $t('climayte.log.scopeTask') }}</Button>
        <Button
          size="xs"
          :variant="scope === 'group' ? 'secondary' : 'ghost'"
          :aria-pressed="scope === 'group'"
          @click="scope = 'group'"
        >{{ $t('climayte.log.scopeGroup') }}</Button>
      </div>
    </div>
    <ol
      v-if="rows.length"
      class="scroll-slim flex max-h-72 flex-col gap-1 overflow-auto rounded-md bg-muted p-2.5 text-xs"
      :class="fill ? 'lg:max-h-none lg:min-h-0 lg:flex-1' : ''"
    >
      <li v-for="r in rows" :key="r.key" class="flex min-w-0 gap-2">
        <time
          class="mono shrink-0 tabular-nums text-muted-foreground"
          :datetime="r.time.toISOString()"
          :title="r.time.toLocaleString()"
        >{{ r.time.toLocaleTimeString() }}</time>
        <span class="flex min-w-0 flex-col">
          <span class="wrap-break-word" :class="r.bad ? 'text-warning' : ''">
            <span v-if="r.who" class="font-medium">{{ r.who }}: </span>{{ r.text }}
          </span>
          <span v-if="r.detail" class="truncate text-muted-foreground" :title="r.detail">{{ r.detail }}</span>
        </span>
      </li>
    </ol>
    <p v-else class="text-xs text-muted-foreground">
      {{ failed ? $t('climayte.log.loadFailed') : loadedOnce ? $t('climayte.log.empty') : $t('climayte.loadingEvents') }}
    </p>
  </div>
</template>
