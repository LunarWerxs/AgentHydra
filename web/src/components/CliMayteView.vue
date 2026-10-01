<script setup lang="ts">
// CliMayte view: the tasks a chat handed to the owner's Claude CLI accounts (server/src/climayte.ts,
// docs/CLIMAYTE.md). A task list grouped by hand-off on the left, the selected task on the right
// (CliMayteWorkerDetail.vue). Polls every 3 s while a task can still change, every 15 s otherwise,
// and again when the page is shown or the window regains focus.
//
// Layout (2026-09-30 review, three lenses agreeing): the header comes first and says what CliMayte is;
// the list is one bordered panel with the hand-off as a subheader. On a wide screen the list and the
// task fill the rest of the window and the page does not scroll (owner, 2026-10-01): the list scrolls
// inside itself, so a row low in a long list still opens its task beside it, and in the task only its
// long parts (result, event log, journal) scroll, each in its own box, sharing the height that is
// left. A narrow screen stacks them at their natural height. "Hide finished" leaves only the tasks
// still queued, running, waiting or being checked (owner, 2026-10-01). It sits on the CLI tab under the CLI
// accounts table (CliView.vue), whose Quick add is where an account is added, so it has none of its
// own.
//
// "What works" (the scorecard: per kind of task, which model and thinking level passed and what it
// cost) is a collapsed one-line section under the counter, so it never pushes the list down.
import {
  Check,
  ChevronRight,
  CloudOff,
  Network,
  RefreshCw,
  Star,
  ThumbsDown,
  ThumbsUp,
  X,
} from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliMayteStatusBadge from '@/components/CliMayteStatusBadge.vue'
import CliMayteWorkerDetail from '@/components/CliMayteWorkerDetail.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { CliMayteWorkerView } from '@/lib/api'
import {
  type CliMayteScorecard,
  type CliMayteTotals,
  getCliMayteScorecard,
  getCliMayteTotals,
  getCliMayteWorker,
  listCliMayteWorkers,
} from '@/lib/api'
import {
  CLIMAYTE_OUTCOME,
  climayteQueuedNote,
  climayteRunLabel,
  firstLine,
  formatTokens,
  isCliMayteActive,
  modelName,
  tokenTotal,
} from '@/lib/climayte-status'
import { reconcileList, sameData } from '@/lib/reconcile'
import { formatAgo } from '@/lib/relativeTime'

const { t } = useI18n()

const workers = ref<CliMayteWorkerView[]>([])
const loading = ref(false)
const loaded = ref(false)
const selectedId = ref<string | null>(null)
const detail = ref<(CliMayteWorkerView & { events: string[] }) | null>(null)
const now = ref(Date.now())
/** The last load failed. Before anything loaded that is an error state (never "No tasks yet");
 *  after, a banner over the last known list, whose spinners would otherwise look alive. */
const unreachable = ref(false)

/** Show only tasks that can still change (isCliMayteActive), kept in this browser. */
const hideFinished = useStorage('agenthydra.climayte.hideFinished', false)
const listed = computed(() =>
  hideFinished.value ? workers.value.filter(isCliMayteActive) : workers.value,
)
const hiddenCount = computed(() => workers.value.length - listed.value.length)

/** Hand-offs ordered by their newest task, tasks inside newest first. */
const groups = computed(() => {
  const sorted = [...listed.value].sort((a, b) => b.createdAt - a.createdAt)
  const map = new Map<string, CliMayteWorkerView[]>()
  for (const w of sorted) {
    const list = map.get(w.group)
    if (list) list.push(w)
    else map.set(w.group, [w])
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

const selected = computed(
  () => detail.value ?? workers.value.find((w) => w.id === selectedId.value) ?? null,
)

let timer: number | null = null
let clock: number | null = null
let alive = true

async function loadDetail() {
  const id = selectedId.value
  if (!id) return
  try {
    const d = await getCliMayteWorker(id)
    // An unchanged detail keeps the old reference, so a poll with nothing new redraws nothing.
    if (selectedId.value === id && !sameData(detail.value, d)) detail.value = d
  } catch {
    // Keep the last detail; `unreachable` and its banner speak for a daemon that is down.
  }
}

/** What CliMayte has offloaded so far (owner, 2026-09-30: a running count of sessions and tokens). */
const totals = ref<CliMayteTotals | null>(null)
/** "39 done, 23 handed off, ...": a run is any start of the CLI, so the count alone read as that
 *  many sessions (owner, 2026-09-30, about "99 CLI sessions"). */
const runsLine = computed(() => {
  const by = totals.value?.runsByOutcome
  if (!by) return ''
  const list = (Object.keys(CLIMAYTE_OUTCOME) as (keyof typeof CLIMAYTE_OUTCOME)[])
    .filter((k) => (by[k] ?? 0) > 0)
    .sort((a, b) => (by[b] ?? 0) - (by[a] ?? 0))
    .map((k) => `${by[k]} ${t(CLIMAYTE_OUTCOME[k].label).toLowerCase()}`)
    .join(', ')
  return t('climayte.offloadedRuns', { list })
})
const totalsHint = computed(() =>
  totals.value
    ? t('climayte.offloadedHint', {
        runs: runsLine.value,
        sessions: totals.value.cliSessions ?? totals.value.sessions,
        input: formatTokens(totals.value.tokens.input),
        output: formatTokens(totals.value.tokens.output),
        cacheRead: formatTokens(totals.value.tokens.cacheRead),
        cacheWrite: formatTokens(totals.value.tokens.cacheWrite),
        cost: `$${totals.value.costUsd.toFixed(2)}`,
      }) +
      (totals.value.rereadShare
        ? ` ${t('climayte.offloadedReread', { share: totals.value.rereadShare, pct: totals.value.rereadPct })}`
        : '')
    : '',
)

/** What passed per kind of task (GET /api/corch/scorecard); collapsed under the counter. */
const scorecard = ref<CliMayteScorecard | null>(null)
const scoreOpen = ref(false)
/** The rows by kind, in the server's order (kind, then cheapest first). */
const scoreKinds = computed(() => {
  const map = new Map<string, CliMayteScorecard['rows']>()
  for (const r of scorecard.value?.rows ?? []) {
    const list = map.get(r.kind)
    if (list) list.push(r)
    else map.set(r.kind, [r])
  }
  return [...map.entries()].map(([kind, rows]) => ({ kind, rows }))
})
const scoreSummary = computed(() => {
  const rows = scorecard.value?.rows ?? []
  if (!rows.length) return t('climayte.scoreNone')
  const pass = rows.reduce((n, r) => n + r.pass, 0)
  const fail = rows.reduce((n, r) => n + r.fail, 0)
  const n = scoreKinds.value.length
  return t('climayte.scoreSummary', { pass, fail, n }, n)
})
const scoreModel = (m: string | null) => (m ? modelName(m) : t('climayte.runDefault'))
/** The task's newest verdict, for the row's check or cross. */
const lastVerdict = (w: CliMayteWorkerView) => w.verdicts?.[w.verdicts.length - 1]?.verdict ?? null

async function load(opts: { silent?: boolean } = {}) {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (!opts.silent) loading.value = true
  try {
    // The scorecard is extra: a failed read keeps the last one and never marks CliMayte unreachable.
    const [list, sums, score] = await Promise.all([
      listCliMayteWorkers(),
      getCliMayteTotals(),
      getCliMayteScorecard().catch(() => null),
    ])
    workers.value = reconcileList(workers.value, list, (w) => w.id)
    if (!sameData(totals.value, sums)) totals.value = sums
    if (score && !sameData(scorecard.value, score)) scorecard.value = score
    unreachable.value = false
    now.value = Date.now()
    if (!loaded.value) {
      loaded.value = true
      // First paint: open the newest live task, else the newest one.
      const first =
        [...workers.value].sort((a, b) => b.createdAt - a.createdAt).find(isCliMayteActive) ??
        groups.value[0]?.items[0]
      if (first) selectedId.value = first.id
    }
    await loadDetail()
  } catch {
    unreachable.value = true
    if (!opts.silent && loaded.value) toast.error(t('climayte.loadFailed'))
  } finally {
    if (!opts.silent) loading.value = false
  }
  // 3 s while a task can still change; otherwise 15 s (the server tick's idle rate), because a
  // chat can start new tasks or revive a finished one at any time. Clear again first: a focus
  // reload overlapping a poll must not leave two timers running.
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (alive)
    timer = window.setTimeout(
      () => load({ silent: true }),
      workers.value.some(isCliMayteActive) ? 3000 : 15_000,
    )
}

function onVisible() {
  if (document.visibilityState === 'visible') void load({ silent: true })
}

function select(w: CliMayteWorkerView) {
  if (selectedId.value === w.id) return
  selectedId.value = w.id
  detail.value = null
  void loadDetail()
}

const startedAgo = (w: CliMayteWorkerView) => formatAgo(now.value, w.createdAt)

/** The row's hover: the title in full, its account, and the one line that needs attention (a
 *  failure's reason, what a waiting or re-queued task waits for, what a running one is doing). */
function rowHint(w: CliMayteWorkerView): string {
  const note = climayteQueuedNote(w, now.value)
  const line =
    (w.status === 'failed' || w.status === 'waiting') && w.error
      ? firstLine(w.error)
      : note
        ? t(note.key, note.values ?? {})
        : w.status === 'running'
          ? w.lastActivity
          : null
  const run = climayteRunLabel(w)
  const runs = run
    ? [
        t('climayte.rowRunHint', {
          model: run.model ?? t('climayte.runDefault'),
          effort: run.effort ?? t('climayte.runDefault'),
        }),
        run.ran ? t('climayte.rowRanHint', { ran: run.ran }) : null,
      ]
    : []
  return [
    w.title,
    w.account ?? t('climayte.noAccount'),
    ...runs,
    line,
    new Date(w.createdAt).toLocaleString(),
  ]
    .filter(Boolean)
    .join('\n')
}

/** The row's small tag: the model that ran (else the one asked for) and the effort, e.g.
 *  `Opus 5.5 · max`; amber when the CLI ran a different model than the one asked for. */
function runTag(w: CliMayteWorkerView): { text: string; differs: boolean } | null {
  const run = climayteRunLabel(w)
  if (!run) return null
  const model = run.ran ?? run.model
  return {
    text: [model, run.effort].filter(Boolean).join(' · '),
    differs: run.differs,
  }
}

onMounted(() => {
  void load()
  // Keeps "Started 3m ago" honest between the slow idle polls.
  clock = window.setInterval(() => {
    now.value = Date.now()
  }, 30_000)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
})
onUnmounted(() => {
  alive = false
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', onVisible)
  if (timer !== null) window.clearTimeout(timer)
  if (clock !== null) window.clearInterval(clock)
  timer = null
  clock = null
})
</script>

<template>
  <div class="flex flex-col gap-5 p-4">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="flex items-center gap-2 text-base font-semibold">
          <Network class="size-4.5" />
          {{ $t('climayte.title') }}
          <span v-if="workers.length" class="font-normal text-muted-foreground">({{ workers.length }})</span>
        </h2>
        <p class="max-w-2xl text-xs text-muted-foreground">{{ $t('climayte.subtitle') }}</p>
        <!-- The running count of what CliMayte has taken off the chats that handed it work. -->
        <p
          v-if="totals && totals.tasks > 0"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          :title="totalsHint"
        >
          <span>
            <span class="font-semibold tabular-nums">{{ totals.tasks }}</span>
            {{ $t('climayte.offloadedTasks', totals.tasks) }}
          </span>
          <span aria-hidden="true" class="text-muted-foreground">·</span>
          <span>
            <span class="font-semibold tabular-nums">{{ totals.sessions }}</span>
            {{ $t('climayte.offloadedSessions', totals.sessions) }}
          </span>
          <span aria-hidden="true" class="text-muted-foreground">·</span>
          <span>
            <span class="font-semibold tabular-nums">{{ formatTokens(tokenTotal(totals.tokens)) }}</span>
            {{ $t('climayte.offloadedTokens') }}
            <span class="tabular-nums text-muted-foreground">(${{ totals.costUsd.toFixed(2) }})</span>
          </span>
        </p>
        <!-- What works: one line until opened, so it never pushes the task list down. -->
        <Collapsible v-if="scorecard" v-model:open="scoreOpen" class="max-w-2xl">
          <!-- as-child: the trigger is this plain button, which carries the look. -->
          <CollapsibleTrigger as-child>
            <button
              type="button"
              class="group flex items-center gap-1.5 rounded-md py-0.5 text-start text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :title="$t('climayte.scoreHint')"
            >
              <ChevronRight
                class="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                aria-hidden="true"
              />
              <span class="font-medium">{{ $t('climayte.scoreTitle') }}</span>
              <span class="text-muted-foreground">{{ scoreSummary }}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p
              v-if="!scorecard.rows.length"
              class="mt-1.5 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
            >
              {{ $t('climayte.scoreEmpty') }}
            </p>
            <div v-else class="scroll-slim mt-1.5 max-h-64 overflow-y-auto rounded-lg border bg-card text-xs">
              <section v-for="k in scoreKinds" :key="k.kind" :aria-label="k.kind">
                <h3 class="border-b bg-muted/40 px-3 py-1 text-2xs font-medium text-muted-foreground">
                  {{ k.kind }}
                </h3>
                <ul class="divide-y">
                  <li
                    v-for="(r, i) in k.rows"
                    :key="i"
                    class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1"
                  >
                    <span class="min-w-24 font-medium">
                      {{ scoreModel(r.model) }}
                      <span class="font-normal text-muted-foreground">· {{ r.effort ?? $t('climayte.runDefault') }}</span>
                    </span>
                    <span
                      class="flex items-center gap-1 tabular-nums text-success"
                      :title="$t('climayte.scorePasses', { n: r.pass })"
                    >
                      <ThumbsUp class="size-3" aria-hidden="true" />{{ r.pass }}
                    </span>
                    <span
                      class="flex items-center gap-1 tabular-nums text-destructive"
                      :title="$t('climayte.scoreFails', { n: r.fail })"
                    >
                      <ThumbsDown class="size-3" aria-hidden="true" />{{ r.fail }}
                    </span>
                    <span class="tabular-nums text-muted-foreground">
                      {{ r.pctPerTask === null ? '—' : $t('climayte.scorePerTask', { pct: r.pctPerTask.toFixed(1) }) }}
                    </span>
                    <Badge v-if="r.pick" variant="success" class="ms-auto" :title="$t('climayte.scoreNextPickHint')">
                      <Star aria-hidden="true" />
                      <span class="text-2xs">{{ $t('climayte.scoreNextPick') }}</span>
                    </Badge>
                  </li>
                </ul>
              </section>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <Button
        variant="outline"
        size="icon"
        :disabled="loading"
        :aria-label="$t('climayte.refresh')"
        :title="$t('climayte.refresh')"
        @click="load()"
      >
        <RefreshCw :class="loading ? 'animate-spin' : ''" />
      </Button>
    </header>

    <p
      v-if="loaded && unreachable"
      role="status"
      class="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <CloudOff class="size-3.5 shrink-0" />
      {{ $t('climayte.staleBanner') }}
    </p>

    <div v-if="!loaded && loading" class="flex flex-col gap-2 lg:max-w-80" aria-busy="true">
      <Skeleton v-for="i in 3" :key="i" class="h-16" />
    </div>

    <div
      v-else-if="!loaded && unreachable"
      role="alert"
      class="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <CloudOff class="size-7 text-muted-foreground" />
      <p class="text-sm font-medium">{{ $t('climayte.loadFailedTitle') }}</p>
      <p class="max-w-md text-xs text-muted-foreground">{{ $t('climayte.loadFailedBody') }}</p>
      <Button variant="outline" class="mt-2" @click="load()">
        <RefreshCw /> {{ $t('climayte.retry') }}
      </Button>
    </div>

    <div
      v-else-if="workers.length === 0"
      class="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <Network class="size-7 text-muted-foreground" />
      <p class="text-sm font-medium">{{ $t('climayte.emptyTitle') }}</p>
      <p class="max-w-md text-xs text-muted-foreground">{{ $t('climayte.empty') }}</p>
    </div>

    <div
      v-else
      class="grid items-start gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch"
    >
      <div class="flex min-h-0 flex-col gap-1.5">
        <label class="flex cursor-pointer items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <span>
            {{ $t('climayte.hideFinished') }}
            <span v-if="hiddenCount > 0" class="tabular-nums">· {{ $t('climayte.hiddenCount', { n: hiddenCount }) }}</span>
          </span>
          <Switch v-model="hideFinished" />
        </label>
        <!-- Narrow: 24 task rows (a row is 2rem, py-1.5 around a text-sm line, plus its 1px divider).
             Wide: the height the window leaves. -->
        <div
          class="scroll-slim max-h-198 divide-y overflow-y-auto rounded-lg border bg-card lg:max-h-none lg:min-h-0 lg:flex-1"
        >
        <p v-if="!groups.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
          {{ $t('climayte.allHidden', { n: hiddenCount }) }}
        </p>
        <section v-for="g in groups" :key="g.group" :aria-label="g.group">
          <h3
            class="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5 text-2xs font-medium text-muted-foreground"
          >
            <span class="mono truncate" :title="g.group">{{ g.group }}</span>
            <span class="shrink-0 tabular-nums">{{ g.items.length }}</span>
          </h3>
          <ul class="divide-y">
            <li v-for="w in g.items" :key="w.id">
              <!-- One line per task (owner, 2026-09-30): the status as an icon, the title, when it
                   started. The account and what it is doing or why it stopped ride on the hover;
                   the detail pane has all of it. -->
              <button
                type="button"
                class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-start text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                :class="w.id === selectedId ? 'bg-accent shadow-row-selected' : ''"
                :aria-current="w.id === selectedId ? 'true' : undefined"
                :title="rowHint(w)"
                @click="select(w)"
              >
                <CliMayteStatusBadge :status="w.status" icon-only />
                <span class="flex min-w-0 flex-1 items-center gap-1">
                  <span class="min-w-0 truncate font-medium">{{ w.title }}</span>
                  <Check
                    v-if="lastVerdict(w) === 'pass'"
                    class="size-3.5 shrink-0 text-success"
                    :aria-label="$t('climayte.verdictPassed')"
                  />
                  <X
                    v-else-if="lastVerdict(w) === 'fail'"
                    class="size-3.5 shrink-0 text-destructive"
                    :aria-label="$t('climayte.verdictFailed')"
                  />
                </span>
                <!-- Only a priority other than the default 0 is shown (field note 20). -->
                <span
                  v-if="w.priority"
                  class="shrink-0 rounded bg-muted px-1 text-2xs font-medium tabular-nums text-muted-foreground"
                  :title="$t('climayte.rowPriorityHint', { n: w.priority })"
                >{{ $t('climayte.rowPriority', { n: w.priority }) }}</span>
                <span
                  v-if="runTag(w)"
                  class="shrink-0 text-2xs"
                  :class="runTag(w)?.differs ? 'text-warning' : 'text-muted-foreground'"
                >{{ runTag(w)?.text }}</span>
                <time
                  class="shrink-0 text-xs text-muted-foreground tabular-nums"
                  :datetime="new Date(w.createdAt).toISOString()"
                >{{ startedAgo(w) }}</time>
              </button>
            </li>
          </ul>
        </section>
        </div>
      </div>

      <CliMayteWorkerDetail
        class="lg:min-h-0"
        :worker="selected"
        :events-loading="!!selectedId && !detail"
        :now="now"
        @changed="load({ silent: true })"
      />
    </div>
  </div>
</template>
