<script setup lang="ts">
// CliMayte, a node of the HSwarm tab's tree (HSwarmView.vue): the tasks a chat handed to the owner's
// Claude CLI accounts (server/src/climayte.ts, docs/CLIMAYTE.md), shown as a manager sees them (owner,
// 2026-10-05: "while viewing them in the HSwarm, I would see less details because ... it's kind of just
// a manager ... it would act more like the Jobs tab"). One line per task, newest first: its status, its
// title, the account and model it runs on, and how long it has been active; the rest rides on the hover.
// Running shows only the tasks that can still change (queued, running, waiting or being checked), All
// every one, and another PC's tasks come with a cloud while the queue is shared. A click opens the task
// (CliMayteWorkerDetail.vue, whose log is CliMayte's journal) in place of the list; its back button, or
// a click on the CliMayte row, goes back to the list where it was. The waves and the scorecard (the
// totals and "What works", OffloadStatsCard.vue) sit above the list, each folded until it is opened.
// None of it goes into Desk's sidebar: on the HSwarm tab that is HSwarm's tree.
//
// The data is one shared copy (composables/useCliMayteData.ts), kept warm by lib/warm-data.ts: the page
// reads it again when it is shown, when the window or the Desk pane comes back, and after a change. The
// list asks for the newest 150 finished tasks; "Show older" asks for all of them.
import {
  ArrowLeft,
  BarChart3,
  Check,
  ChevronRight,
  Cloud,
  CloudOff,
  Network,
  PictureInPicture2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  UserRound,
  X,
} from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import {
  computed,
  createApp,
  h,
  nextTick,
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliMayteFloat from '@/components/CliMayteFloat.vue'
import CliMayteStatusBadge from '@/components/CliMayteStatusBadge.vue'
import CliMayteWaves from '@/components/CliMayteWaves.vue'
import CliMayteWorkerDetail from '@/components/CliMayteWorkerDetail.vue'
import OffloadStatsCard from '@/components/OffloadStatsCard.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { useCliMayteData } from '@/composables/useCliMayteData'
import { useCliMayteFloat } from '@/composables/useCliMayteFloat'
import { i18n } from '@/i18n'
import { pii } from '@/composables/usePrivacy'
import { privacyMode } from '@/composables/useUiPrefs'
import type {
  CliMayteRemotePc,
  CliMayteRemoteWorker,
  CliMayteWorkerView,
} from '@/lib/api'
import {
  getCliMayteWorker,
} from '@/lib/api'
import {
  climayteQueuedNote,
  climayteRunLabel,
  climayteVerdictMark,
  firstLine,
  isCliMayteActive,
} from '@/lib/climayte-status'
import { deskWorkerAsk, PANE_OPEN_EVENT } from '@/lib/desk-embed'
import { formatUsd } from '@/lib/kit'
import { reconcileList, sameData } from '@/lib/reconcile'
import { visibleInterval } from '@/lib/visible-poll'
import InfoHint from '@/shell/InfoHint.vue'

/** `home`: HSwarmView bumps it when the CliMayte row is clicked, which goes back to the list. */
const props = defineProps<{ home?: number }>()
/** `open`: a tree path for HSwarmView to show (the scorecard's HSwarm link opens HSwarm's savings). */
const emit = defineEmits<{ open: [path: string[]] }>()

const { t, locale } = useI18n()
const { pipWindow, isOpen: floatIsOpen, open: openFloat, close: closeFloat } = useCliMayteFloat()

let floatApp: ReturnType<typeof createApp> | null = null

/** A row of the list: a local worker, or (with `remote`) one another PC sharing the queue shows,
 *  read-only. `remote` is the one flag that tells them apart; it is never set on a local worker. */
type ListRow = CliMayteWorkerView & {
  remote?: { pc: string; name: string; at: number; stale: boolean }
}
// The data is one shared copy (composables/useCliMayteData.ts), kept warm by lib/warm-data.ts.
const {
  workers,
  remote,
  runningCount,
  totals,
  scorecard,
  waves,
  loading,
  loaded,
  unreachable,
  listedAt,
  hasOlder,
  finishedLimit,
  showOlder: widenFinished,
  refreshCliMayte,
} = useCliMayteData()
/** Every row the list shows: this PC's workers, then the other PCs'. */
const rows = computed<ListRow[]>(() => [...workers.value, ...remoteRows.value])
/** One warning line per other PC whose build differs from this one's (its `behindNote`). */
const remoteNotes = computed<Array<{ pc: string; note: string }>>(() =>
  remote.value?.enabled
    ? remote.value.pcs.flatMap((pc) => (pc.behindNote ? [{ pc: pc.pc, note: pc.behindNote }] : []))
    : [],
)
/** Local and remote ids may match, so a row is selected by this key, never its bare id. */
const rowKey = (w: ListRow) => (w.remote ? `${w.remote.pc}/${w.id}` : w.id)
/** The other PCs' workers (GET /api/corch/remote), shaped as rows; empty when sharing is off. Built once
 *  per change of the shared copy, and unchanged rows keep their objects. */
const remoteRows = shallowRef<ListRow[]>([])
watch(
  remote,
  (r) => {
    const next = r?.enabled ? r.pcs.flatMap((pc) => pc.workers.map((w) => remoteRow(pc, w))) : []
    remoteRows.value = reconcileList(remoteRows.value, next, rowKey)
  },
  { immediate: true },
)
/** The open task's row key; null while the list is on screen. */
const selectedId = ref<string | null>(null)
const detail = ref<(CliMayteWorkerView & { events: string[] }) | null>(null)
/** The last few details read ahead of an opening (hover, focus, press), by task id, with when they were read.
 *  One older than DETAIL_FRESH_MS is read again rather than painted: a task moves on. */
const DETAIL_KEEP = 6
const DETAIL_FRESH_MS = 30_000
const detailCache = new Map<string, { d: CliMayteWorkerView & { events: string[] }; at: number }>()
function freshDetail(id: string): (CliMayteWorkerView & { events: string[] }) | null {
  const hit = detailCache.get(id)
  return hit && Date.now() - hit.at < DETAIL_FRESH_MS ? hit.d : null
}
const detailReading = new Set<string>()
/** A just-opened task whose detail is not here yet: its Result, notice and reports are held a short beat
 *  rather than drawn absent and popped in. */
const HOLD_MS = 250
const holding = ref(false)
let holdTimer: ReturnType<typeof setTimeout> | undefined
function endHold() {
  clearTimeout(holdTimer)
  holding.value = false
}
const now = ref(Date.now())

/** Running: only the tasks that can still change (isCliMayteActive); All: every one. Kept in this
 *  browser, under the key of the "Hide finished" switch it replaces, so the choice carries over. */
const runningOnly = useStorage('agenthydra.climayte.hideFinished', false)
const activeCount = runningCount
/** The list under the filter, newest first. */
const listed = computed(() =>
  (runningOnly.value ? rows.value.filter(isCliMayteActive) : [...rows.value]).sort(
    (a, b) => b.createdAt - a.createdAt,
  ),
)
const hiddenCount = computed(() => rows.value.length - listed.value.length)
// A page of lines at a time, "Show more" adds a page: a busy queue is thousands of tasks, and every
// line is redrawn while any task runs.
const PAGE = 150
const limit = ref(PAGE)
const shown = computed(() => listed.value.slice(0, limit.value))
const notShown = computed(() => listed.value.length - shown.value.length)

/** Folded until opened, and kept that way in this browser: the list comes first. */
const scoreOpen = useStorage('agenthydra.climayte.scoreOpen', false)

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

let clock: (() => void) | null = null

async function loadDetail() {
  const id = selectedId.value
  if (!id || selectedRemote.value) return
  try {
    const d = await getCliMayteWorker(id)
    // An unchanged detail keeps the old reference, so a poll with nothing new redraws nothing.
    if (selectedId.value === id && !sameData(detail.value, d)) detail.value = d
    if (d) remember(id, d)
  } catch {
    // Keep the last detail; `unreachable` and its banner speak for a daemon that is down.
  } finally {
    if (selectedId.value === id) endHold()
  }
}

function remember(id: string, d: CliMayteWorkerView & { events: string[] }) {
  const old = detailCache.get(id)?.d
  detailCache.delete(id)
  detailCache.set(id, { d: old && sameData(old, d) ? old : d, at: Date.now() })
  for (const k of detailCache.keys()) {
    if (detailCache.size <= DETAIL_KEEP) break
    detailCache.delete(k)
  }
}

/** The first sign of interest in a local row (hover, focus, press): read its detail so opening it paints whole. */
function prefetch(w: ListRow) {
  if (w.remote) return
  const id = rowKey(w)
  if (detailReading.has(id) || freshDetail(id)) return
  detailReading.add(id)
  getCliMayteWorker(id)
    .then((d) => d && remember(id, d))
    .catch(() => {}) // floor-ok: a read-ahead only; opening the task reads again through loadDetail, and `unreachable` speaks for a daemon that is down
    .finally(() => detailReading.delete(id))
}

/** The row's verdict mark (lib/climayte-status.ts) with its hover: who judged it, and what they said. */
function verdictMark(w: CliMayteWorkerView) {
  const m = climayteVerdictMark(w)
  if (!m) return null
  const said = t(m.key, m.values)
  return { kind: m.kind, label: said, hint: m.note ? `${said}: ${m.note}` : said }
}

function showOlder() {
  widenFinished()
  void load()
}

/** Opening the page, its refresh button and the pane being shown again: read the shared list now, and
 *  the open task's detail. Between those, lib/warm-data.ts keeps the list fresh (about every 2 minutes). */
async function load(opts: { silent?: boolean; side?: boolean } = {}) {
  const wasLoaded = loaded.value
  await refreshCliMayte(opts)
  if (unreachable.value) {
    if (!opts.silent && wasLoaded) toast.error(t('climayte.loadFailed'))
    return
  }
  pruneRowViews()
  now.value = Date.now()
  await loadDetail()
}

// The page stays built while another tab is shown (App.vue's KeepAlive): it reads again only while it is
// the one on screen, when it comes back, and when the window or the Desk pane is shown again.
let active = false
function onVisible() {
  if (active && document.visibilityState === 'visible') void load({ silent: true, side: true })
}

/** This PC's task by id. One older than the finished tasks read so far reads the whole list first. */
async function findWorker(id: string): Promise<ListRow | undefined> {
  const w = workers.value.find((x) => x.id === id)
  if (w || finishedLimit.value === undefined) return w
  widenFinished()
  await load({ silent: true })
  return workers.value.find((x) => x.id === id)
}

/** A wave's manager link: open that worker. */
async function selectManager(id: string) {
  const m = await findWorker(id)
  if (m) select(m)
}

// The list's scroll when a task was opened, so going back lands where the click was.
const listEl = ref<HTMLElement | null>(null)
let listScroll = 0

/** Opens a task in place of the list. */
function select(w: ListRow) {
  const key = rowKey(w)
  if (selectedId.value === key) return
  if (selectedId.value === null) listScroll = listEl.value?.scrollTop ?? 0
  selectedId.value = key
  endHold()
  // A remote row has no local worker to ask about: it shows what the row has.
  if (w.remote) {
    detail.value = null
    return
  }
  detail.value = freshDetail(key)
  if (!detail.value) {
    holding.value = true
    holdTimer = setTimeout(endHold, HOLD_MS)
  }
  void loadDetail()
}

/** Back to the list, scrolled where it was, with the row that was open focused. */
async function back() {
  const key = selectedId.value
  if (key === null) return
  selectedId.value = null
  detail.value = null
  endHold()
  await nextTick()
  const el = listEl.value
  if (!el) return
  el.scrollTop = listScroll
  el.querySelector<HTMLElement>(`[data-task="${CSS.escape(key)}"]`)?.focus({ preventScroll: true })
}
watch(
  () => props.home,
  () => void back(),
)

/** The float's own app (its window is a separate document): unmounted with the window, however it closed. */
function unmountFloat() {
  floatApp?.unmount()
  floatApp = null
}
watch(floatIsOpen, (open) => {
  if (!open) unmountFloat()
})

async function toggleFloat() {
  if (floatIsOpen.value) {
    unmountFloat()
    closeFloat()
    return
  }
  const onRowClick = (id: string) => {
    const w = workers.value.find((x) => x.id === id)
    if (w) select(w)
  }
  const success = await openFloat({
    running: workers.value.filter((w) => w.status === 'running' || w.status === 'checking'),
    queued: workers.value.filter(
      (w) => isCliMayteActive(w) && w.status !== 'running' && w.status !== 'checking',
    ),
    now: now.value,
    onRowClick,
  })
  const root = success ? pipWindow.value?.document.getElementById('pip-root') : null
  if (!root) return
  // A render function over this view's own refs, so the float redraws whenever they change. (It was a
  // template string, which needs Vue's runtime compiler that this build leaves out, fed from a plain
  // object Vue never saw change; and it asked for the i18n plugin outside setup, where there is none.)
  floatApp = createApp({
    render: () => h(CliMayteFloat, { workers: workers.value, now: now.value, onRowClick }),
  })
  floatApp.use(i18n)
  floatApp.mount(root)
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

/** The row's hover: the title in full, its hand-off, its account, and the one line that needs
 *  attention (a failure's reason, what a waiting or re-queued task waits for, what a running one is
 *  doing). Masked whole in privacy mode: a server's reason can name an account too. */
function rowHint(w: ListRow): string {
  return pii(rowHintText(w))
}

function rowHintText(w: ListRow): string {
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
    `${t('climayte.detailGroup')}: ${w.group}`,
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

/** The row's model: the one that ran (else the one asked for) and the effort, e.g. `Opus 5.5 · max`;
 *  amber when the CLI ran a different model than the one asked for. */
function runTag(w: CliMayteWorkerView): { text: string; differs: boolean } | null {
  const run = climayteRunLabel(w)
  if (!run) return null
  const model = run.ran ?? run.model
  return {
    text: [model, run.effort].filter(Boolean).join(' · '),
    differs: run.differs,
  }
}

/** What a row says, worked out once and kept until the row, the clock it depends on, the task list its
 *  failure story reads, or the language or privacy mode changes: a render, a poll that changed other
 *  rows or a clock tick no longer rebuilds every row's texts. Only a task that can still change reads
 *  the clock (its running time, its wait, its other PC); a finished one's texts never change with it. */
interface RowView {
  mark: ReturnType<typeof verdictMark>
  tag: ReturnType<typeof runTag>
  hint: string
  time: string
  /** The account, masked in privacy mode. */
  account: string
}
const rowViews = new Map<
  string,
  { w: ListRow; clock: string; tasks: unknown; words: string; view: RowView }
>()
function rowView(w: ListRow): RowView {
  const clock = isCliMayteActive(w) || w.remote ? `${now.value}/${listedAt.value}` : ''
  const tasks = w.status === 'failed' ? workers.value : null
  const words = `${locale.value}/${privacyMode.value}`
  const key = rowKey(w)
  const hit = rowViews.get(key)
  if (hit && hit.w === w && hit.clock === clock && hit.tasks === tasks && hit.words === words)
    return hit.view
  const view: RowView = {
    mark: verdictMark(w),
    tag: runTag(w),
    hint: rowHint(w),
    time: activeLabel(activeS(w)),
    account: w.account ? pii(w.account) : t('climayte.noAccount'),
  }
  rowViews.set(key, { w, clock, tasks, words, view })
  return view
}
/** Drops the kept rows of tasks no longer listed. */
function pruneRowViews() {
  if (rowViews.size <= rows.value.length) return
  const keep = new Set(rows.value.map(rowKey))
  for (const key of rowViews.keys()) if (!keep.has(key)) rowViews.delete(key)
}

// Desk asked for a task (its sidebar's task rows; App.vue showed this node): opened once the list is in,
// shown even when Running would leave it out.
watch(
  [deskWorkerAsk, loaded],
  async () => {
    const ask = deskWorkerAsk.value
    if (!ask || !loaded.value) return
    deskWorkerAsk.value = null
    // Another PC's ids may repeat this PC's: its task is looked for among that PC's rows only.
    const w = ask.pc
      ? remoteRows.value.find((x) => x.id === ask.id && x.remote?.name === ask.pc)
      : await findWorker(ask.id)
    if (!w) return
    if (runningOnly.value && !isCliMayteActive(w)) runningOnly.value = false
    select(w)
  },
  { immediate: true },
)

// HSwarmView keeps this page in a KeepAlive, so this runs when its node is first opened too.
onActivated(() => {
  active = true
  // On screen: what the shared list has is there already; read it now.
  void load({ silent: loaded.value })
})
onDeactivated(() => {
  active = false
})
onMounted(() => {
  // Keeps a running task's active time honest between the slow refreshes. It rests while the page is
  // hidden and while no task can change (a read sets the time too), and reads at once when shown again.
  clock = visibleInterval(() => {
    if (rows.value.some(isCliMayteActive)) now.value = Date.now()
  }, 30_000)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
  window.addEventListener(PANE_OPEN_EVENT, onVisible)
})
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener(PANE_OPEN_EVENT, onVisible)
  window.removeEventListener('focus', onVisible)
  clock?.()
  clock = null
  unmountFloat()
  closeFloat()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- One line: the title with what CliMayte is behind its info mark (owner, 2026-10-01: a
         description is never a paragraph over the UI), the filter, the float and refresh. -->
    <header class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2">
      <h2 class="flex min-w-0 items-center gap-2 text-base font-semibold">
        <Network class="size-4.5 shrink-0" aria-hidden="true" />
        {{ $t('climayte.title') }}
        <span v-if="rows.length" class="font-normal text-muted-foreground">({{ rows.length }})</span>
        <InfoHint :text="$t('climayte.subtitle')" />
        <!-- Another PC on an older (or newer) AgentHydra: one yellow mark to hover, never a banner
             that stays up (owner, 2026-10-04). -->
        <span
          v-if="remoteNotes.length"
          role="img"
          tabindex="0"
          class="inline-flex text-warning"
          :aria-label="`${$t('climayte.remoteVersions')}: ${remoteNotes.map((n) => $pii(n.note)).join(' ')}`"
          :title="remoteNotes.map((n) => $pii(n.note)).join('\n')"
        >
          <TriangleAlert class="size-3.5" aria-hidden="true" />
        </span>
      </h2>
      <div class="ms-auto flex items-center gap-1">
        <div
          v-if="!selectedId && rows.length"
          class="me-1 flex items-center gap-1"
          role="group"
          :aria-label="$t('climayte.filterLabel')"
        >
          <Button
            size="xs"
            :variant="runningOnly ? 'secondary' : 'ghost'"
            :aria-pressed="runningOnly"
            :title="$t('climayte.filterRunningHint')"
            @click="runningOnly = true"
          >{{ $t('climayte.filterRunning', { n: activeCount }) }}</Button>
          <Button
            size="xs"
            :variant="runningOnly ? 'ghost' : 'secondary'"
            :aria-pressed="!runningOnly"
            @click="runningOnly = false"
          >{{ $t('climayte.filterAll', { n: rows.length }) }}</Button>
        </div>
        <Button
          v-if="hasPictureInPictureAPI"
          variant="ghost"
          size="icon-sm"
          :aria-label="$t('climayte.floatButton')"
          :title="$t('climayte.floatButton')"
          :aria-pressed="floatIsOpen"
          :class="floatIsOpen ? 'text-primary' : ''"
          @click="toggleFloat()"
        >
          <PictureInPicture2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
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
      class="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <CloudOff class="size-3.5 shrink-0" />
      {{ $t('climayte.staleBanner') }}
    </p>

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

    <div v-else-if="!loaded" class="flex flex-col gap-1.5 px-4" aria-busy="true">
      <Skeleton v-for="i in 5" :key="i" class="h-7" />
    </div>

    <div
      v-else-if="rows.length === 0"
      class="m-auto flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <Network class="size-7 text-muted-foreground" />
      <p class="text-sm font-medium">{{ $t('climayte.emptyTitle') }}</p>
      <p class="max-w-md text-xs text-muted-foreground">{{ $t('climayte.empty') }}</p>
    </div>

    <!-- One task, in place of the list. On a wide screen it fills the height and only its long parts
         scroll; a narrow one stacks it at its natural height and the pane scrolls. -->
    <div v-else-if="selectedId" class="flex flex-col gap-2 px-4 pb-4 lg:min-h-0 lg:flex-1">
      <div class="flex shrink-0 items-center">
        <Button size="sm" variant="ghost" class="-ms-2" @click="back()">
          <ArrowLeft />
          {{ $t('climayte.backToTasks') }}
        </Button>
      </div>
      <!-- Another PC's task is read-only: what its row has, no controls, no call for it here. -->
      <section
        v-if="selectedRemote"
        class="scroll-slim flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-lg border bg-card px-4 py-3"
        :aria-label="selectedRemote.title"
      >
        <div class="flex min-w-0 flex-col items-start gap-1.5">
          <h3 class="wrap-break-word text-sm font-semibold">
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
            <span class="truncate text-2xs">{{ selectedRemote.account ? $pii(selectedRemote.account) : $t('climayte.noAccount') }}</span>
          </Badge>
          <Badge variant="muted" :title="$t('climayte.detailRan')">
            <span class="text-2xs tabular-nums">{{ activeLabel(selectedRemote.ranS) }}</span>
          </Badge>
          <Badge variant="muted" :title="$t('climayte.detailCost')">
            <span class="text-2xs tabular-nums">{{ formatUsd(selectedRemote.costUsd) }}</span>
          </Badge>
          <Badge v-if="selectedRemote.kind" variant="muted" :title="$t('climayte.detailKind')">
            <span class="text-2xs">{{ selectedRemote.kind }}</span>
          </Badge>
        </div>
        <p v-if="selectedRemote.lastActivity" class="wrap-break-word text-xs text-muted-foreground">
          {{ $pii(selectedRemote.lastActivity) }}
        </p>
        <p v-if="remoteWaited(selectedRemote)" class="text-xs text-warning">
          {{ remoteWaited(selectedRemote) }}
        </p>
        <pre
          v-if="selectedRemote.error"
          class="mono scroll-slim max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-2.5 text-xs text-muted-foreground"
        >{{ $pii(selectedRemote.error) }}</pre>
        <p class="text-2xs text-muted-foreground">{{ $t('climayte.remoteNote') }}</p>
      </section>
      <CliMayteWorkerDetail
        v-else-if="!holding"
        class="lg:min-h-0 lg:flex-1"
        :worker="selected"
        :tasks="workers"
        :events-loading="!detail"
        :now="now"
        @changed="load({ silent: true, side: true })"
      />
    </div>

    <!-- The list, under the waves and the scorecard (each folded until opened). -->
    <div v-else ref="listEl" class="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <CliMayteWaves
        class="mb-2"
        :waves="waves"
        :workers="workers"
        :more="hasOlder"
        :now="now"
        @select-worker="selectManager"
      />
      <Collapsible v-model:open="scoreOpen" class="mb-2 flex flex-col gap-1.5">
        <CollapsibleTrigger as-child>
          <button
            type="button"
            class="group flex items-center gap-1.5 self-start rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              class="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
            <BarChart3 class="size-3.5" aria-hidden="true" />
            {{ $t('climayte.scorecard') }}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <OffloadStatsCard :totals="totals" :scorecard="scorecard" @open="emit('open', ['savings'])" />
        </CollapsibleContent>
      </Collapsible>

      <!-- One line per task, as the Jobs page lists jobs: the status as an icon (a failed one tells its
           story on hover), the title, the account and model it runs on, how long it has been active. -->
      <ul v-if="shown.length" class="flex flex-col rounded-lg border bg-card py-0.5" :aria-label="$t('climayte.listLabel')">
        <li v-for="w in shown" :key="rowKey(w)">
          <button
            type="button"
            :data-task="rowKey(w)"
            class="flex h-7 w-full min-w-0 items-center gap-2 px-2.5 text-start text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            :class="w.remote?.stale ? 'opacity-60' : ''"
            :title="rowView(w).hint"
            @click="select(w)"
            @pointerenter="prefetch(w)"
            @focus="prefetch(w)"
            @pointerdown="prefetch(w)"
          >
            <CliMayteStatusBadge :status="w.status" :hold="w.hold" icon-only :task="w" :tasks="workers" />
            <span class="min-w-0 flex-1 truncate text-sm">{{ w.title }}</span>
            <!-- Another PC's task: a small cloud, the PC on hover (the row's hover says it too). -->
            <Cloud
              v-if="w.remote"
              class="size-3.5 shrink-0 text-muted-foreground"
              :aria-label="remoteLabel(w)"
            />
            <span
              v-if="w.priority"
              class="shrink-0 rounded bg-muted px-1 text-2xs text-warning"
              :title="$t('climayte.rowPriorityHint', { n: w.priority })"
            >{{ $t('climayte.rowPriority', { n: w.priority }) }}</span>
            <!-- Its own hover: who judged it and what they said. A failed check on a task still
                 working is amber and a retry arrow, never the red cross (owner, 2026-10-02). -->
            <span v-if="rowView(w).mark" class="inline-flex shrink-0" :title="rowView(w).mark?.hint">
              <Check
                v-if="rowView(w).mark?.kind === 'pass'"
                class="size-3.5 text-success"
                :aria-label="rowView(w).mark?.label"
              />
              <RotateCcw
                v-else-if="rowView(w).mark?.kind === 'retry'"
                class="size-3.5 text-warning"
                :aria-label="rowView(w).mark?.label"
              />
              <X v-else class="size-3.5 text-destructive" :aria-label="rowView(w).mark?.label" />
            </span>
            <span class="hidden w-44 shrink-0 truncate text-muted-foreground sm:block">{{ rowView(w).account }}</span>
            <span
              class="hidden w-36 shrink-0 truncate md:block"
              :class="rowView(w).tag?.differs ? 'text-warning' : 'text-muted-foreground'"
            >{{ rowView(w).tag?.text }}</span>
            <span class="w-14 shrink-0 text-end tabular-nums text-muted-foreground">{{ rowView(w).time }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="px-1 py-6 text-center text-xs text-muted-foreground">
        {{ $t('climayte.allHidden', { n: hiddenCount }) }}
      </p>

      <!-- More of the list, then the finished tasks older than the ones read. -->
      <div v-if="notShown || hasOlder" class="mt-2 flex gap-2">
        <Button v-if="notShown" variant="outline" size="sm" class="flex-1" @click="limit += PAGE">
          {{ $t('climayte.listShowMore', { n: Math.min(PAGE, notShown), total: notShown }) }}
        </Button>
        <Button v-if="hasOlder" variant="outline" size="sm" class="flex-1" @click="showOlder()">
          {{ $t('climayte.showOlder') }}
        </Button>
      </div>
    </div>
  </div>
</template>
