<script setup lang="ts">
// CliMayte view: the tasks a chat handed to the owner's Claude CLI accounts (server/src/climayte.ts,
// docs/CLIMAYTE.md). A task list grouped by hand-off on the left, the selected task on the right
// (CliMayteWorkerDetail.vue). Polls the list every 3 s while a task can still change, every 15 s
// otherwise (the totals, scorecard, other PCs and waves only every 30 s), not at all while the page is
// hidden, and again when the page is shown or the window regains focus. The list asks for the newest
// 150 finished tasks; "Show older" asks for all of them.
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
// The totals and "What works" (the scorecard) live in the one stats card above the task
// (OffloadStatsCard.vue), shared with HSwarm, so the sidebar header is only the title, the filter
// and the waves.
//
// In Hydra Desk 2 the task list is drawn in Desk's own sidebar (lib/desk-embed.ts, Michael, 2026-10-04:
// one sidebar for everything): this view describes it, row for row as the SideBar below says it, and
// hides its own; the waves move to the top of the task column, and Desk can ask for a task by id.
import {
  Ban,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Cloud,
  CloudOff,
  Hourglass,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
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
  inject,
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
import SideBar from '@/components/side-list/SideBar.vue'
import SideListRow from '@/components/side-list/SideListRow.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useCliMayteFloat } from '@/composables/useCliMayteFloat'
import { i18n } from '@/i18n'
import { pii } from '@/composables/usePrivacy'
import { privacyMode } from '@/composables/useUiPrefs'
import type { EmbedIcon, EmbedTone, SidebarRow } from '@desk/shared/hydra-embed'
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
  climayteFailedStory,
  climayteQueuedNote,
  climayteRunLabel,
  climayteStatusMeta,
  climayteStoryLines,
  climayteVerdictMark,
  firstLine,
  isCliMayteActive,
} from '@/lib/climayte-status'
import { deskWorkerAsk, EMBEDDED, useDeskSidebar } from '@/lib/desk-embed'
import { formatUsd } from '@/lib/kit'
import { reconcileList, sameData } from '@/lib/reconcile'
import type { SideListGroup } from '@/lib/side-list'
import { visibleInterval } from '@/lib/visible-poll'
import InfoHint from '@/shell/InfoHint.vue'

const { t, locale } = useI18n()
const openView = inject(OPEN_VIEW, () => {})
const { pipWindow, isOpen: floatIsOpen, open: openFloat, close: closeFloat } = useCliMayteFloat()

let floatApp: ReturnType<typeof createApp> | null = null

/** A row of the list: a local worker, or (with `remote`) one another PC sharing the queue shows,
 *  read-only. `remote` is the one flag that tells them apart; it is never set on a local worker. */
type ListRow = CliMayteWorkerView & {
  remote?: { pc: string; name: string; at: number; stale: boolean }
}
// The lists are replaced whole by a poll that brought a change (reconcileList), never edited in place,
// so Vue does not wrap every row in a proxy.
const workers = shallowRef<CliMayteWorkerView[]>([])
/** The other PCs' workers (GET /api/corch/remote), shaped as rows; empty when sharing is off. */
const remoteRows = shallowRef<ListRow[]>([])
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
let clock: (() => void) | null = null
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
/** What passed per kind of task (GET /api/corch/scorecard); shown in the stats card. */
const scorecard = ref<CliMayteScorecard | null>(null)

/** The row's verdict mark (lib/climayte-status.ts) with its hover: who judged it, and what they said. */
function verdictMark(w: CliMayteWorkerView) {
  const m = climayteVerdictMark(w)
  if (!m) return null
  const said = t(m.key, m.values)
  return { kind: m.kind, label: said, hint: m.note ? `${said}: ${m.note}` : said }
}

/** The finished tasks the list asks for (the daemon keeps every active one regardless): a busy queue
 *  is thousands of tasks, and each poll used to carry all of them. "Show older" asks for every one. */
const FINISHED_PAGE = 150
const finishedLimit = ref<number | undefined>(FINISHED_PAGE)
/** The list may hold more finished tasks than were read. */
const hasOlder = computed(
  () =>
    finishedLimit.value !== undefined &&
    workers.value.reduce((n, w) => n + (isCliMayteActive(w) ? 0 : 1), 0) >= finishedLimit.value,
)
function showOlder() {
  finishedLimit.value = undefined
  void load()
}

// The totals, the scorecard, the other PCs' queue and the waves move slowly: they are read on this
// beat, not on every 3 s poll of the list (and at once on a refresh or when the page is shown again).
const SIDE_MS = 30_000
let sideAt = 0

async function load(opts: { silent?: boolean; side?: boolean } = {}) {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (!opts.silent) loading.value = true
  try {
    const side = !opts.silent || opts.side === true || Date.now() - sideAt >= SIDE_MS
    // The scorecard is extra: a failed read keeps the last one and never marks CliMayte unreachable.
    // The other PCs' queue is extra too: a failed read keeps the last one.
    const [list, sums, score, remote, waveList] = await Promise.all([
      listCliMayteWorkers({ limit: finishedLimit.value }),
      side ? getCliMayteTotals() : null,
      side ? getCliMayteScorecard().catch(() => null) : null,
      side ? getCliMayteRemote().catch(() => null) : null,
      side ? listCliMayteWaves() : null,
    ])
    if (side) sideAt = Date.now()
    if (waveList && !sameData(waves.value, waveList)) waves.value = waveList
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
    pruneRowViews()
    if (sums && !sameData(totals.value, sums)) totals.value = sums
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
      if (first) selectedId.value = rowKey(first)
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
  // reload overlapping a poll must not leave two timers running. A hidden page (a minimized window, or
  // in Desk the pane slid out of view) schedules nothing: onVisible reads again when it is seen.
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (alive && !document.hidden)
    timer = window.setTimeout(
      () => {
        timer = null
        if (!document.hidden) void load({ silent: true })
      },
      rows.value.some(isCliMayteActive) ? 3000 : 15_000,
    )
}

function onVisible() {
  if (document.visibilityState === 'visible') void load({ silent: true, side: true })
}

/** This PC's task by id. One older than the finished tasks read so far reads the whole list first. */
async function findWorker(id: string): Promise<ListRow | undefined> {
  const w = workers.value.find((x) => x.id === id)
  if (w || finishedLimit.value === undefined) return w
  finishedLimit.value = undefined
  await load({ silent: true })
  return workers.value.find((x) => x.id === id)
}

/** A wave's manager link: open that worker's row. */
async function selectManager(id: string) {
  const m = await findWorker(id)
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

/** The row's hover: the title in full, its account, and the one line that needs attention (a
 *  failure's reason, what a waiting or re-queued task waits for, what a running one is doing).
 *  Masked whole in privacy mode: a server's reason can name an account too. */
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

/** What a row says, worked out once and kept until the row, the clock it depends on, the task list its
 *  failure story reads, or the language or privacy mode changes: a render, a poll that changed other
 *  rows or a clock tick no longer rebuilds every row's texts. Only a task that can still change reads
 *  the clock (its running time, its wait, its other PC); a finished one's texts never change with it. */
interface RowView {
  mark: ReturnType<typeof verdictMark>
  tag: ReturnType<typeof runTag>
  hint: string
  time: string
  /** Desk's version of the row, built when Desk's sidebar first needs it. */
  desk?: SidebarRow
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

// Hydra Desk 2: the list as Desk's sidebar draws it (shared/hydra-embed.ts), saying per row what
// SideListRow and CliMayteStatusBadge say here.
const STATUS_ICON = new Map<LucideIcon, EmbedIcon>([
  [Clock, 'clock'],
  [LoaderCircle, 'loader'],
  [Hourglass, 'hourglass'],
  [ListChecks, 'list-checks'],
  [CircleCheck, 'circle-check'],
  [CircleX, 'circle-x'],
  [Ban, 'ban'],
  [Network, 'network'],
])
const VARIANT_TONE: Record<string, EmbedTone> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  destructive: 'danger',
}
function deskStatus(w: ListRow): SidebarRow['status'] {
  const meta = climayteStatusMeta(w.status, w.hold)
  const story = climayteFailedStory(w, workers.value)
  const said = story
    ? climayteStoryLines(story, (key, values) => t(key, values)).join('\n')
    : t(meta.hint)
  return {
    icon: STATUS_ICON.get(meta.icon) ?? 'clock',
    tone: VARIANT_TONE[meta.variant ?? ''] ?? 'muted',
    spin: meta.spin,
    label: `${t(meta.label)}: ${said}`,
  }
}
function buildDeskRow(w: ListRow, view: RowView): SidebarRow {
  const { tag, mark } = view
  return {
    key: rowKey(w),
    label: w.title,
    status: deskStatus(w),
    badge: w.remote ? { icon: 'cloud', label: remoteLabel(w) } : undefined,
    chip: w.priority
      ? {
          text: t('climayte.rowPriority', { n: w.priority }),
          hint: t('climayte.rowPriorityHint', { n: w.priority }),
        }
      : undefined,
    tag: tag ? { text: tag.text, tone: tag.differs ? 'warning' : 'muted' } : undefined,
    time: view.time,
    mark: mark
      ? {
          icon: mark.kind === 'pass' ? 'check' : mark.kind === 'retry' ? 'retry' : 'x',
          tone: mark.kind === 'pass' ? 'success' : mark.kind === 'retry' ? 'warning' : 'danger',
          label: mark.label,
          hint: mark.hint,
        }
      : undefined,
    dim: !!w.remote?.stale,
    hint: view.hint,
  }
}
/** The row as Desk's sidebar draws it, built once per change of the row (rowView). */
function deskRow(w: ListRow): SidebarRow {
  const view = rowView(w)
  return (view.desk ??= buildDeskRow(w, view))
}
// Desk's list: every task that can still change and the open one, then the newest finished ones up to
// a page; "Show more" adds a page. All 1,754 of a busy queue were 1.3 MB per update and 23k nodes in
// Desk's sidebar (2026-10-04), redrawn while any task ran.
const DESK_PAGE = 150
const deskLimit = ref(DESK_PAGE)
const deskGroups = computed(() => {
  let finished = 0
  let cut = 0
  const out: { group: string; items: ListRow[] }[] = []
  for (const g of groups.value) {
    const items = g.items.filter((w) => {
      if (isCliMayteActive(w) || rowKey(w) === selectedId.value) return true
      if (finished < deskLimit.value) {
        finished++
        return true
      }
      cut++
      return false
    })
    if (items.length) out.push({ group: g.group, items })
  }
  return { groups: out, cut }
})
const deskFooter = computed(() => [
  ...(deskGroups.value.cut
    ? [
        {
          id: 'more',
          icon: 'plus' as const,
          label: t('climayte.deskShowMore', {
            n: Math.min(DESK_PAGE, deskGroups.value.cut),
            total: deskGroups.value.cut,
          }),
        },
      ]
    : []),
  ...(hasOlder.value ? [{ id: 'older', icon: 'plus' as const, label: t('climayte.showOlder') }] : []),
])
useDeskSidebar(
  'climayte',
  () => ({
    view: 'climayte',
    title: t('climayte.title'),
    icon: 'network',
    count: rows.value.length || undefined,
    info: t('climayte.subtitle'),
    warn: remoteNotes.value.length
      ? remoteNotes.value.map((n) => pii(n.note)).join('\n')
      : undefined,
    buttons: [
      ...(hasPictureInPictureAPI.value
        ? [{ id: 'pip', icon: 'pip' as const, label: t('climayte.floatButton'), on: floatIsOpen.value }]
        : []),
      {
        id: 'refresh',
        icon: 'refresh' as const,
        label: t('climayte.refresh'),
        spin: loading.value,
        disabled: loading.value,
      },
    ],
    banner:
      loaded.value && unreachable.value
        ? { text: t('climayte.staleBanner'), tone: 'warning', icon: 'cloud-off' }
        : undefined,
    switches: rows.value.length
      ? [
          {
            id: 'hideFinished',
            label: t('climayte.hideFinished'),
            note: hiddenCount.value > 0 ? t('climayte.hiddenCount', { n: hiddenCount.value }) : undefined,
            on: hideFinished.value,
          },
        ]
      : undefined,
    sections: deskGroups.value.groups.map((g) => ({
      key: g.group,
      label: g.group,
      rows: g.items.map(deskRow),
    })),
    selected: selectedId.value,
    empty: !loaded.value
      ? undefined
      : rows.value.length
        ? t('climayte.allHidden', { n: hiddenCount.value })
        : t('climayte.emptyTitle'),
    loading: !loaded.value && loading.value,
    footer: deskFooter.value.length ? deskFooter.value : undefined,
  }),
  (e) => {
    if (e.action === 'select') {
      const w = rows.value.find((r) => rowKey(r) === e.key)
      if (w) select(w)
    } else if (e.action === 'button') {
      if (e.id === 'refresh') void load()
      else if (e.id === 'pip') void toggleFloat()
      else if (e.id === 'more') deskLimit.value += DESK_PAGE
      else if (e.id === 'older') showOlder()
    } else if (e.action === 'switch' && e.id === 'hideFinished') hideFinished.value = e.on
  },
)

// Desk asked for a task (its sidebar's task rows): opened once the list is in, shown even when
// "Hide finished" would hide it.
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
    if (hideFinished.value && !isCliMayteActive(w)) hideFinished.value = false
    select(w)
  },
  { immediate: true },
)

onMounted(() => {
  void load()
  // Keeps a running task's active time honest between the slow idle polls. It rests while the page is
  // hidden and while no task can change (a poll sets the time too), and reads at once when shown again.
  clock = visibleInterval(() => {
    if (rows.value.some(isCliMayteActive)) now.value = Date.now()
  }, 30_000)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
})
onUnmounted(() => {
  alive = false
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', onVisible)
  if (timer !== null) window.clearTimeout(timer)
  clock?.()
  timer = null
  clock = null
  unmountFloat()
  closeFloat()
})
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- The same sidebar as the Sessions tab (SideBar.vue: rail, resize, grouped rows): a header
         that never scrolls (title, counter, hide finished, waves) over the task list. -->
    <SideBar v-if="!EMBEDDED" storage-key="agenthydra.climayte" :groups="sideGroups" :empty="!groups.length">
        <template #header>
    <header class="flex items-start justify-between gap-2 px-3 pt-2.5 pb-2 pe-11">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <h2 class="flex items-center gap-2 text-base font-semibold">
          <Network class="size-4.5" />
          {{ $t('climayte.title') }}
          <span v-if="rows.length" class="font-normal text-muted-foreground">({{ rows.length }})</span>
          <!-- What CliMayte is, behind an info bubble (owner, 2026-10-01: a description is never a
               paragraph over the UI). -->
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
              :more="hasOlder"
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
            :hint="rowView(w).hint"
            :chip="w.priority ? $t('climayte.rowPriority', { n: w.priority }) : undefined"
            :chip-hint="w.priority ? $t('climayte.rowPriorityHint', { n: w.priority }) : undefined"
            :tag="rowView(w).tag?.text"
            :tag-tone="rowView(w).tag?.differs ? 'warning' : 'muted'"
            :time="rowView(w).time"
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
            </template>
          </SideListRow>
        </template>

        <!-- The list reads the newest finished tasks; this reads every older one too. -->
        <div v-if="hasOlder" class="px-3 py-2">
          <Button variant="outline" size="sm" class="w-full" @click="showOlder()">
            {{ $t('climayte.showOlder') }}
          </Button>
        </div>
    </SideBar>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <!-- In Desk the list is in Desk's sidebar, so the waves head the task column instead. -->
      <CliMayteWaves
        v-if="EMBEDDED"
        class="mb-2 shrink-0"
        :waves="waves"
        :workers="workers"
        :more="hasOlder"
        :now="now"
        @select-worker="selectManager"
      />
      <OffloadStatsCard
        class="mb-2 shrink-0"
        :totals="totals"
        :scorecard="scorecard"
        @open="openView('hswarm')"
      />
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
        v-else
        class="min-h-0 flex-1"
        :worker="selected"
        :tasks="workers"
        :events-loading="!!selectedId && !detail"
        :now="now"
        @changed="load({ silent: true, side: true })"
      />
      </template>
    </section>
  </div>
</template>
