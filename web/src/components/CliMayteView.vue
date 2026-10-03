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
  Cloud,
  CloudOff,
  Network,
  PictureInPicture2,
  RefreshCw,
  RotateCcw,
  Star,
  ThumbsDown,
  ThumbsUp,
  UserRound,
  X,
} from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import {
  computed,
  createApp,
  getCurrentInstance,
  inject,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliMayteFloat from '@/components/CliMayteFloat.vue'
import CliMayteStatusBadge from '@/components/CliMayteStatusBadge.vue'
import CliMayteWaves from '@/components/CliMayteWaves.vue'
import CliMayteWorkerDetail from '@/components/CliMayteWorkerDetail.vue'
import SideList from '@/components/side-list/SideList.vue'
import SideListRow from '@/components/side-list/SideListRow.vue'
import SwarmStatsCard from '@/components/swarm-stats/SwarmStatsCard.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useCliMayteFloat } from '@/composables/useCliMayteFloat'
import type {
  CliMayteRemotePc,
  CliMayteRemoteWorker,
  CliMayteWave,
  CliMayteWorkerView,
} from '@/lib/api'
import {
  type CliMayteScorecard,
  type CliMayteTotals,
  getCliMayteRemote,
  getCliMayteScorecard,
  getCliMayteTotals,
  getCliMayteWorker,
  listCliMayteWaves,
  listCliMayteWorkers,
} from '@/lib/api'
import { OPEN_VIEW } from '@/lib/app-view'
import {
  CLIMAYTE_OUTCOME,
  climayteQueuedNote,
  climayteRunLabel,
  climayteVerdictMark,
  firstLine,
  formatTokens,
  isCliMayteActive,
  modelName,
  tokenTotal,
} from '@/lib/climayte-status'
import { reconcileList, sameData } from '@/lib/reconcile'
import type { SideListGroup } from '@/lib/side-list'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const openView = inject(OPEN_VIEW, () => {})
const { pipWindow, isOpen: floatIsOpen, open: openFloat, close: closeFloat } = useCliMayteFloat()

let floatApp: ReturnType<typeof createApp> | null = null

/** A row of the list: a local worker, or (with `remote`) one another PC sharing the queue shows,
 *  read-only. `remote` is the one flag that tells them apart; it is never set on a local worker. */
type ListRow = CliMayteWorkerView & {
  remote?: { pc: string; name: string; at: number; stale: boolean }
}
const workers = ref<CliMayteWorkerView[]>([])
/** The other PCs' workers (GET /api/corch/remote), shaped as rows; empty when sharing is off. */
const remoteRows = ref<ListRow[]>([])
/** Every row the list shows: this PC's workers, then the other PCs'. */
const rows = computed<ListRow[]>(() => [...workers.value, ...remoteRows.value])
/** One warning line per other PC whose build differs from this one's (its `behindNote`). */
const remoteNotes = ref<Array<{ pc: string; note: string }>>([])
/** Local and remote ids may match, so a row is selected by this key, never its bare id. */
const rowKey = (w: ListRow) => (w.remote ? `${w.remote.pc}/${w.id}` : w.id)
/** Manager waves (GET /api/corch/waves; none when the route is missing). */
const waves = ref<CliMayteWave[]>([])
const loading = ref(false)
const loaded = ref(false)
const selectedId = ref<string | null>(null)
const detail = ref<(CliMayteWorkerView & { events: string[] }) | null>(null)
const now = ref(Date.now())
// When the list was last read: a running task's `ranS` keeps growing from there until the next poll.
const listedAt = ref(Date.now())
/** The last load failed. Before anything loaded that is an error state (never "No tasks yet");
 *  after, a banner over the last known list, whose spinners would otherwise look alive. */
const unreachable = ref(false)

/** Show only tasks that can still change (isCliMayteActive), kept in this browser. */
const hideFinished = useStorage('agenthydra.climayte.hideFinished', false)
const listed = computed(() =>
  hideFinished.value ? rows.value.filter(isCliMayteActive) : rows.value,
)
const hiddenCount = computed(() => rows.value.length - listed.value.length)

/** Hand-offs ordered by their newest task, tasks inside newest first. */
const groups = computed(() => {
  const sorted = [...listed.value].sort((a, b) => b.createdAt - a.createdAt)
  const map = new Map<string, ListRow[]>()
  for (const w of sorted) {
    const list = map.get(w.group)
    if (list) list.push(w)
    else map.set(w.group, [w])
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

/** The same groups for SideList: the hand-off as the header line, rows keyed per PC. */
const sideGroups = computed<SideListGroup<ListRow>[]>(() =>
  groups.value.map((g) => ({ key: g.group, label: g.group, items: g.items, keyOf: rowKey })),
)

const selectedRow = computed(() => rows.value.find((w) => rowKey(w) === selectedId.value) ?? null)
/** The remote row that is open, shown read-only from what the row has. */
const selectedRemote = computed(() => (selectedRow.value?.remote ? selectedRow.value : null))
const selected = computed(() =>
  selectedRemote.value ? null : (detail.value ?? selectedRow.value ?? null),
)

const hasPictureInPictureAPI = computed(
  () => typeof document !== 'undefined' && 'documentPictureInPicture' in window,
)

/** A remote worker as a row: only the fields the other PC sends, the rest empty. */
function remoteRow(pc: CliMayteRemotePc, r: CliMayteRemoteWorker): ListRow {
  return {
    id: r.id,
    group: r.group,
    title: r.title,
    cwd: '',
    prompt: '',
    pending: [],
    model: r.model,
    effort: r.effort,
    accounts: null,
    status: r.status,
    sessionId: null,
    accountId: r.account?.id ?? null,
    account: r.account ? `#${r.account.num ?? '?'} ${r.account.name}` : null,
    attempts: [],
    result: null,
    error: r.error,
    lastActivity: r.lastActivity,
    costUsd: r.costUsd,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    ranS: r.activeS,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    kind: r.kind,
    verdicts: r.verdict
      ? [{ at: r.updatedAt, verdict: r.verdict, note: null, model: null, effort: null, pct: null }]
      : [],
    remote: { pc: pc.pc, name: pc.name, at: pc.at, stale: pc.stale },
  }
}
/** "On <name>", or with how long ago it was last seen when that PC has gone quiet. */
function remoteLabel(w: ListRow): string {
  const r = w.remote
  if (!r) return ''
  if (!r.stale) return t('climayte.remoteOn', { name: r.name })
  return t('climayte.remoteOnStale', {
    name: r.name,
    n: Math.max(1, Math.round((now.value - r.at) / 60_000)),
  })
}

let timer: number | null = null
let clock: number | null = null
let alive = true

async function loadDetail() {
  const id = selectedId.value
  if (!id || selectedRemote.value) return
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
/** The row's verdict mark (lib/climayte-status.ts) with its hover: who judged it, and what they said. */
function verdictMark(w: CliMayteWorkerView) {
  const m = climayteVerdictMark(w)
  if (!m) return null
  const said = t(m.key, m.values)
  return { kind: m.kind, label: said, hint: m.note ? `${said}: ${m.note}` : said }
}

async function load(opts: { silent?: boolean } = {}) {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (!opts.silent) loading.value = true
  try {
    // The scorecard is extra: a failed read keeps the last one and never marks CliMayte unreachable.
    // The other PCs' queue is extra too: a failed read keeps the last one.
    const [list, sums, score, remote, waveList] = await Promise.all([
      listCliMayteWorkers(),
      getCliMayteTotals(),
      getCliMayteScorecard().catch(() => null),
      getCliMayteRemote().catch(() => null),
      listCliMayteWaves(),
    ])
    if (!sameData(waves.value, waveList)) waves.value = waveList
    workers.value = reconcileList(workers.value, list, (w) => w.id)
    if (remote) {
      const next = remote.enabled
        ? remote.pcs.flatMap((pc) => pc.workers.map((r) => remoteRow(pc, r)))
        : []
      remoteRows.value = reconcileList(remoteRows.value, next, rowKey)
      const notes = remote.enabled
        ? remote.pcs.flatMap((pc) => (pc.behindNote ? [{ pc: pc.pc, note: pc.behindNote }] : []))
        : []
      if (!sameData(remoteNotes.value, notes)) remoteNotes.value = notes
    }
    if (!sameData(totals.value, sums)) totals.value = sums
    if (score && !sameData(scorecard.value, score)) scorecard.value = score
    unreachable.value = false
    now.value = Date.now()
    listedAt.value = now.value
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
      rows.value.some(isCliMayteActive) ? 3000 : 15_000,
    )
}

function onVisible() {
  if (document.visibilityState === 'visible') void load({ silent: true })
}

/** A wave's manager link: open that worker's row. */
function selectManager(id: string) {
  const m = workers.value.find((x) => x.id === id)
  if (m) select(m)
}

function select(w: ListRow) {
  const key = rowKey(w)
  if (selectedId.value === key) return
  selectedId.value = key
  detail.value = null
  // A remote row has no local worker to ask about: it shows what the row has.
  if (!w.remote) void loadDetail()
}

function updateFloatContent() {
  // Update the float with current workers and time (called by watcher)
  // The component is reactive, so when data changes, it will update
}

async function toggleFloat() {
  if (floatIsOpen.value) {
    if (floatApp) {
      floatApp.unmount()
      floatApp = null
    }
    closeFloat()
  } else {
    const instance = getCurrentInstance()
    const i18n = instance?.appContext.config.globalProperties.$i18n

    const success = await openFloat({
      running: workers.value.filter((w) => w.status === 'running' || w.status === 'checking'),
      queued: workers.value.filter(
        (w) => isCliMayteActive(w) && w.status !== 'running' && w.status !== 'checking',
      ),
      now: now.value,
      onRowClick: (id: string) => {
        const w = workers.value.find((x) => x.id === id)
        if (w) select(w)
      },
    })

    if (success && pipWindow.value) {
      const rootElement = pipWindow.value.document.getElementById('pip-root')
      if (rootElement) {
        const appData = {
          workers: workers.value,
          now: now.value,
          onRowClick: (id: string) => {
            const w = workers.value.find((x) => x.id === id)
            if (w) select(w)
          },
        }

        floatApp = createApp({
          template: `<CliMayteFloat :workers="workers" :now="now" :onRowClick="onRowClick" />`,
          components: { CliMayteFloat },
          data() {
            return appData
          },
        })

        if (i18n) {
          floatApp.use(i18n as any)
        }

        floatApp.mount(rootElement)

        // Update the app data reactively when workers or now changes
        watch([workers, now], () => {
          if (floatApp) {
            Object.assign(appData, {
              workers: workers.value,
              now: now.value,
            })
          }
        })
      }
    }
  }
}

/** How long the task has been active: its sessions' running time over every attempt, not the time
 *  since it was queued (owner, 2026-10-02: "if it sat for two hours, but it only worked for one,
 *  then it should show one hour, not three"). Waiting for an account or a reset does not count. */
const activeS = (w: CliMayteWorkerView): number =>
  w.ranS + (w.status === 'running' ? Math.max(0, (now.value - listedAt.value) / 1000) : 0)

function activeLabel(totalS: number): string {
  const m = Math.floor(totalS / 60)
  if (m < 1) return t('climayte.activeSeconds', { s: Math.floor(totalS) })
  if (m < 60) return t('climayte.activeMinutes', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('climayte.activeHours', { h, m: m % 60 })
  return t('climayte.activeDays', { d: Math.floor(h / 24), h: h % 24 })
}

/** "waiting 3h 12m" for another PC's waiting task: since its last change, which is when it began to wait. */
function remoteWaited(w: ListRow): string | null {
  if (!w.remote || w.status !== 'waiting') return null
  return t('climayte.remoteWaited', {
    d: activeLabel(Math.max(60, (now.value - w.updatedAt) / 1000)),
  })
}

/** The row's hover: the title in full, its account, and the one line that needs attention (a
 *  failure's reason, what a waiting or re-queued task waits for, what a running one is doing). */
function rowHint(w: ListRow): string {
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
    w.remote ? remoteLabel(w) : null,
    t('climayte.rowIdHint', { id: w.id }),
    w.account ?? t('climayte.noAccount'),
    ...runs,
    line,
    remoteWaited(w),
    t('climayte.rowActiveHint', { d: activeLabel(activeS(w)) }),
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
  // Keeps a running task's active time honest between the slow idle polls.
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
  closeFloat()
})
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- The same sidebar as the Sessions tab (SideList / SideListRow): a header that never scrolls
         (title, counter, what works, hide finished, waves) over the task list. -->
    <aside class="min-h-0 w-88 shrink-0 overflow-hidden border-e border-border bg-sidebar">
      <SideList :groups="sideGroups" :empty="!groups.length">
        <template #header>
    <header class="flex items-start justify-between gap-2 px-3 pt-2.5 pb-2">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <h2 class="flex items-center gap-2 text-base font-semibold">
          <Network class="size-4.5" />
          {{ $t('climayte.title') }}
          <span v-if="rows.length" class="font-normal text-muted-foreground">({{ rows.length }})</span>
          <!-- What CliMayte is, behind an info bubble (owner, 2026-10-01: a description is never a
               paragraph over the UI). -->
          <InfoHint :text="$t('climayte.subtitle')" />
        </h2>
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
      <div class="flex gap-1">
        <Button
          v-if="hasPictureInPictureAPI"
          variant="outline"
          size="icon"
          :aria-label="$t('climayte.floatButton')"
          :title="$t('climayte.floatButton')"
          :class="floatIsOpen ? 'bg-accent' : ''"
          @click="toggleFloat()"
        >
          <PictureInPicture2 class="size-4" />
        </Button>
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
      </div>
    </header>

          <p
            v-if="loaded && unreachable"
            role="status"
            class="mx-3 mb-2 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            <CloudOff class="size-3.5 shrink-0" />
            {{ $t('climayte.staleBanner') }}
          </p>

          <p
            v-for="n in remoteNotes"
            :key="n.pc"
            role="status"
            class="mx-3 mb-2 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            <Cloud class="size-3.5 shrink-0" aria-hidden="true" />
            {{ n.note }}
          </p>

          <div v-if="rows.length" class="flex flex-col gap-1.5 px-3 pb-2">
            <label class="flex cursor-pointer items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {{ $t('climayte.hideFinished') }}
                <span v-if="hiddenCount > 0" class="tabular-nums">· {{ $t('climayte.hiddenCount', { n: hiddenCount }) }}</span>
              </span>
              <Switch v-model="hideFinished" />
            </label>
            <CliMayteWaves
              :waves="waves"
              :workers="workers"
              :now="now"
              @select-worker="selectManager"
            />
          </div>
        </template>

        <template #empty>
          <div v-if="!loaded && loading" class="flex flex-col gap-2 p-3" aria-busy="true">
            <Skeleton v-for="i in 3" :key="i" class="h-8" />
          </div>
          <p
            v-else-if="loaded && rows.length"
            class="px-3 py-6 text-center text-xs text-muted-foreground"
          >
            {{ $t('climayte.allHidden', { n: hiddenCount }) }}
          </p>
        </template>

        <template #row="{ item: w }">
          <!-- One line per task (owner, 2026-09-30): the status as an icon, the title, when it
               started. The account and what it is doing or why it stopped ride on the hover;
               the detail pane has all of it. -->
          <SideListRow
            :label="w.title"
            :selected="rowKey(w) === selectedId"
            :dim="!!w.remote?.stale"
            :hint="rowHint(w)"
            :tag="runTag(w)?.text"
            :tag-tone="runTag(w)?.differs ? 'warning' : 'muted'"
            :time-text="activeLabel(activeS(w))"
            @click="select(w)"
          >
            <template #status>
              <CliMayteStatusBadge :status="w.status" :hold="w.hold" icon-only :task="w" :tasks="workers" />
            </template>
            <!-- Another PC's task: a small cloud, the PC on hover (the row's hover says it too). -->
            <template v-if="w.remote" #badge>
              <Cloud
                class="size-3.5 shrink-0 text-muted-foreground"
                :aria-label="remoteLabel(w)"
                :title="remoteLabel(w)"
              />
            </template>
            <!-- Its own hover (the span's title wins over the row's): who judged it and what
                 they said. A failed check on a task still working is amber and a retry
                 arrow, never the red cross: ten running rows with a red cross read as "lots
                 of chats failed" (owner, 2026-10-02). -->
            <template #mark>
              <span v-if="verdictMark(w)" class="inline-flex shrink-0" :title="verdictMark(w)?.hint">
                <Check
                  v-if="verdictMark(w)?.kind === 'pass'"
                  class="size-3.5 text-success"
                  :aria-label="verdictMark(w)?.label"
                />
                <RotateCcw
                  v-else-if="verdictMark(w)?.kind === 'retry'"
                  class="size-3.5 text-warning"
                  :aria-label="verdictMark(w)?.label"
                />
                <X v-else class="size-3.5 text-destructive" :aria-label="verdictMark(w)?.label" />
              </span>
            </template>
            <!-- Only a priority other than the default 0 is shown (field note 20). -->
            <template #trailing>
              <span
                v-if="w.priority"
                class="shrink-0 rounded bg-muted px-1 text-2xs font-medium tabular-nums text-muted-foreground"
                :title="$t('climayte.rowPriorityHint', { n: w.priority })"
              >{{ $t('climayte.rowPriority', { n: w.priority }) }}</span>
            </template>
          </SideListRow>
        </template>
      </SideList>
    </aside>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <SwarmStatsCard compact class="mb-2 shrink-0 !py-1" @open="openView('hswarm')" />
      <div
        v-if="!loaded && unreachable"
        role="alert"
        class="m-auto flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"
      >
        <CloudOff class="size-7 text-muted-foreground" />
        <p class="text-sm font-medium">{{ $t('climayte.loadFailedTitle') }}</p>
        <p class="max-w-md text-xs text-muted-foreground">{{ $t('climayte.loadFailedBody') }}</p>
        <Button variant="outline" class="mt-2" @click="load()">
          <RefreshCw /> {{ $t('climayte.retry') }}
        </Button>
      </div>

      <div
        v-else-if="loaded && rows.length === 0"
        class="m-auto flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"
      >
        <Network class="size-7 text-muted-foreground" />
        <p class="text-sm font-medium">{{ $t('climayte.emptyTitle') }}</p>
        <p class="max-w-md text-xs text-muted-foreground">{{ $t('climayte.empty') }}</p>
      </div>

      <template v-else-if="loaded">
      <!-- Another PC's task is read-only: what its row has, no controls, no call for it here. -->
      <section
        v-if="selectedRemote"
        class="scroll-slim flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-lg border bg-card px-4 py-3"
        :aria-label="selectedRemote.title"
      >
        <div class="flex min-w-0 flex-col items-start gap-1.5">
          <h3 class="line-clamp-2 wrap-break-word text-sm font-semibold" :title="selectedRemote.title">
            {{ selectedRemote.title }}
          </h3>
          <span class="mono rounded px-1 text-2xs text-muted-foreground">{{ selectedRemote.id }}</span>
        </div>
        <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Cloud class="size-3.5 shrink-0" aria-hidden="true" />
          {{ remoteLabel(selectedRemote) }}
        </p>
        <div class="flex flex-wrap items-center gap-1.5">
          <CliMayteStatusBadge :status="selectedRemote.status" />
          <Badge variant="outline" class="max-w-56" :title="$t('climayte.detailAccount')">
            <UserRound aria-hidden="true" />
            <span class="truncate text-2xs">{{ selectedRemote.account ?? $t('climayte.noAccount') }}</span>
          </Badge>
          <Badge variant="muted" :title="$t('climayte.detailRan')">
            <span class="text-2xs tabular-nums">{{ activeLabel(selectedRemote.ranS) }}</span>
          </Badge>
          <Badge variant="muted" :title="$t('climayte.detailCost')">
            <span class="text-2xs tabular-nums">${{ selectedRemote.costUsd.toFixed(2) }}</span>
          </Badge>
          <Badge v-if="selectedRemote.kind" variant="muted" :title="$t('climayte.detailKind')">
            <span class="text-2xs">{{ selectedRemote.kind }}</span>
          </Badge>
        </div>
        <p v-if="selectedRemote.lastActivity" class="wrap-break-word text-xs text-muted-foreground">
          {{ selectedRemote.lastActivity }}
        </p>
        <p v-if="remoteWaited(selectedRemote)" class="text-xs text-warning">
          {{ remoteWaited(selectedRemote) }}
        </p>
        <pre
          v-if="selectedRemote.error"
          class="mono scroll-slim max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-2.5 text-xs text-muted-foreground"
        >{{ selectedRemote.error }}</pre>
        <p class="text-2xs text-muted-foreground">{{ $t('climayte.remoteNote') }}</p>
      </section>
      <CliMayteWorkerDetail
        v-else
        class="min-h-0 flex-1"
        :worker="selected"
        :tasks="workers"
        :events-loading="!!selectedId && !detail"
        :now="now"
        @changed="load({ silent: true })"
      />
      </template>
    </section>
  </div>
</template>
