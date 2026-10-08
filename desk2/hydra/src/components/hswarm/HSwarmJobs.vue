<script setup lang="ts">
// The Jobs page: the jobs running now, then every recent job. A click on a job opens it right under
// its row, inside the table (owner, 2026-10-04: "The HSwarm jobs should expand in place on the table
// to show the data instead of making it appear on the bottom."). One job is open at a time; a second
// click, its close button or Escape closes it.
//
// An open job is short (owner, 2026-10-05: the page "is, like, way too verbose ... it doesn't, like,
// collapse or scroll"): one line of summary (label, state, counts, cost, time, the chat that called
// it), then its task results, one line per task, folded past FOLD_AT tasks and scrolling in a box of
// their own. A task's line opens its whole answer in a box that scrolls too; what the list is for is
// behind the info icon on its heading.
import {
  AlertCircle,
  Ban,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  X,
} from '@lucide/vue'
import type { Component } from 'vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { pii } from '@/composables/usePrivacy'
import type { ChatListResult } from '@/lib/api'
import { j as getJson } from '@/lib/api'
import { EMBEDDED, openInDesk } from '@/lib/desk-embed'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'
import { missingQueued } from '@/lib/job-tasks'
import { formatTokens, formatUsd } from '@/lib/kit'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const { apiCall } = useHswarmApi()

// jobId: set when the HSwarm tree picked one job; the page opens with that job open under its row.
const props = defineProps<{ state: HswarmState; jobId?: string }>()
const emit = defineEmits<{ changed: [] }>()

interface CallerStamp {
  session_id?: string | null
  chat_id?: string | null
  instance?: string | null
}

interface Job {
  job_id: string
  label: string
  state: string
  tasks: number
  counts: Record<string, number>
  cost_usd: number
  tokens?: number
  created: string
  /** When it ended; '' (or nothing) while it runs. */
  finished?: string | boolean | null
  /** hswarm/caller.py key(): '<instance> / <8 chars of the session> / <folder>'. */
  caller?: string | CallerStamp | null
  /** The caller's full ids: a Claude Desktop chat has an empty session_id and a chat_id ('local_...'). */
  caller_ids?: CallerStamp | null
}

interface TaskResult {
  id: string
  status: string
  model?: string
  /** Missing when its cost is not known; 0 is free. */
  cost_usd?: number | null
  answer?: string
  error?: string
  data?: unknown
}

interface JobDetail {
  /** The job's status (no created, finished or caller: those are its row's), or { error } for a job HSwarm lost. */
  status?: Partial<Job> & { error?: string }
  results?: {
    /** The finished tasks, in task order (a record read from disk lists its unfinished ones here too). */
    results?: TaskResult[]
    /** A live job's running tasks, with how long each has run. */
    running?: Array<{ id: string; elapsed_s?: number }>
    error?: string
  }
  error?: string
}

// The two tables a job is listed in: a running job is in both.
type Where = 'running' | 'all'

const jobs = ref<Job[]>([])
const selectedJobId = ref<string | null>(null)
// The table the open job was opened from: its detail shows under the row clicked, not twice.
const openIn = ref<Where>('all')
const jobDetail = ref<JobDetail | null>(null)
const isLoading = ref(true)
const isLoadingDetail = ref(false)
const error = ref<string | null>(null)
const isCancelling = ref(false)
const detailError = ref<string | null>(null)
const rootEl = ref<HTMLElement | null>(null)

const runningJobs = computed(() => jobs.value.filter((job) => jobDot(job.state) === 'run'))

const allJobs = computed(() => jobs.value)

// Both tables come from one loop, so the open job's detail is written once.
const sections = computed(() => {
  const all = { key: 'all' as Where, title: t('hswarm.v.jobs.allRecentJobs'), jobs: allJobs.value }
  if (!runningJobs.value.length) return [all]
  const running = {
    key: 'running' as Where,
    title: t('hswarm.v.jobs.runningNow'),
    jobs: runningJobs.value,
  }
  return [running, all]
})

// The table the open job's detail is drawn in. A reload never closes it: a job that finished after
// it was opened in the running table leaves that table, and its detail follows it into the other.
const detailIn = computed<Where | null>(() => {
  const id = selectedJobId.value
  if (!id) return null
  if (openIn.value === 'running' && runningJobs.value.some((job) => job.job_id === id)) return 'running'
  return allJobs.value.some((job) => job.job_id === id) ? 'all' : null
})

const isOpen = (where: Where, jobId: string) =>
  selectedJobId.value === jobId && detailIn.value === where
const detailId = (where: Where, jobId: string) => `hs-job-${where}-${encodeURIComponent(jobId)}`
const toggleEl = (where: Where, jobId: string) =>
  rootEl.value?.querySelector<HTMLElement>(`[data-job-toggle="${CSS.escape(`${where}:${jobId}`)}"]`)

function jobDot(state: string): 'run' | 'ok' | 'bad' | 'off' {
  if (state === 'running' || state === 'queued') return 'run'
  if (state === 'done' || state === 'finished') return 'ok'
  if (/fail|error/i.test(state)) return 'bad'
  return 'off'
}

function stateVariant(state: string): 'info' | 'success' | 'destructive' | 'muted' {
  switch (jobDot(state)) {
    case 'run':
      return 'info'
    case 'ok':
      return 'success'
    case 'bad':
      return 'destructive'
    default:
      return 'muted'
  }
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '–'
  try {
    const date = new Date(dateStr)
    return date.toLocaleString()
  } catch {
    return dateStr
  }
}

const costText = (cost: number | null | undefined) => formatUsd(cost, { style: 'fine' })

/** "4m", "2h 5m": how long something ran. */
function spanText(totalS: number): string {
  const m = Math.floor(totalS / 60)
  if (m < 1) return t('hswarm.v.jobs.spanSeconds', { s: Math.max(0, Math.floor(totalS)) })
  if (m < 60) return t('hswarm.v.jobs.spanMinutes', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('hswarm.v.jobs.spanHours', { h, m: m % 60 })
  return t('hswarm.v.jobs.spanDays', { d: Math.floor(h / 24), h: h % 24 })
}

// --- task counts ----------------------------------------------------------------------------------
// HSwarm counts tasks by their own status (ok, error, timeout, loop, cancelled, pending, running); the
// page says done, failed, running, queued and cancelled.
interface Tally {
  done: number
  failed: number
  running: number
  queued: number
  cancelled: number
}
const NOT_FAILED = new Set(['ok', 'running', 'pending', 'cancelled'])
const isFailed = (status: string) => !NOT_FAILED.has(status)

function tally(counts?: Record<string, number>): Tally {
  const out: Tally = { done: 0, failed: 0, running: 0, queued: 0, cancelled: 0 }
  for (const [status, n] of Object.entries(counts ?? {})) {
    if (status === 'ok') out.done += n
    else if (status === 'running') out.running += n
    else if (status === 'pending') out.queued += n
    else if (status === 'cancelled') out.cancelled += n
    else out.failed += n
  }
  return out
}

const TALLY_KEY: Record<keyof Tally, string> = {
  done: 'hswarm.v.jobs.countDone',
  failed: 'hswarm.v.jobs.countFailed',
  running: 'hswarm.v.jobs.countRunning',
  queued: 'hswarm.v.jobs.countQueued',
  cancelled: 'hswarm.v.jobs.countCancelled',
}
const TALLY_TONE: Record<keyof Tally, string> = {
  done: 'text-success',
  failed: 'text-destructive',
  running: 'text-info',
  queued: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
}
// Always said, a zero included: the three the summary is read for.
const ALWAYS = new Set<keyof Tally>(['done', 'failed', 'running'])

/** "12 done · 1 failed": the counts that are not zero, '–' when there are none. */
function tallyText(counts?: Record<string, number>): string {
  const c = tally(counts)
  const parts = (Object.keys(c) as Array<keyof Tally>)
    .filter((k) => c[k] > 0)
    .map((k) => t(TALLY_KEY[k], { n: c[k] }))
  return parts.length ? parts.join(' · ') : '–'
}

/** The summary's counts, each in its own colour: done, failed and running always, the rest when there are some. */
function countParts(counts?: Record<string, number>) {
  const c = tally(counts)
  return (Object.keys(c) as Array<keyof Tally>)
    .filter((k) => c[k] > 0 || ALWAYS.has(k))
    .map((k) => ({ key: k, text: t(TALLY_KEY[k], { n: c[k] }), tone: c[k] > 0 ? TALLY_TONE[k] : 'text-muted-foreground' }))
}

async function loadJobs() {
  isLoading.value = true
  error.value = null
  try {
    const response = await apiCall('jobs', { method: 'GET' })
    jobs.value = response.jobs || []
  } catch (err) {
    // The last list stays on screen under the error: a failed reload does not close the open job.
    error.value = err instanceof Error ? err.message : t('hswarm.v.jobs.failedToLoad')
    toast.error(t('hswarm.v.jobs.failedToLoad'))
  } finally {
    isLoading.value = false
  }
}

// --- the open job ---------------------------------------------------------------------------------

// The open job's own row in the list: its created, finished and caller (the list is HSwarm's verbose read).
const openRow = computed(() => jobs.value.find((job) => job.job_id === selectedJobId.value))

/** "took 4m" for a finished job, "running for 4m" for a running one; its dates on hover. */
function jobTime(job: Job | undefined): { time: string; timeHint: string } {
  const created = job?.created ?? ''
  const start = created ? Date.parse(created) : Number.NaN
  if (!job || !Number.isFinite(start)) return { time: '–', timeHint: '' }
  const finished = typeof job.finished === 'string' ? job.finished : ''
  const end = finished ? Date.parse(finished) : Number.NaN
  if (Number.isFinite(end)) {
    return {
      time: t('hswarm.v.jobs.tookTime', { span: spanText((end - start) / 1000) }),
      timeHint: t('hswarm.v.jobs.timeHintFinished', { created: formatDate(created), finished: formatDate(finished) }),
    }
  }
  const timeHint = t('hswarm.v.jobs.timeHint', { created: formatDate(created) })
  if (jobDot(job.state) === 'run') {
    return { time: t('hswarm.v.jobs.runningTime', { span: spanText((Date.now() - start) / 1000) }), timeHint }
  }
  return { time: formatDate(created), timeHint }
}

// The open job's one-line summary: the detail's fresh status where it has one, else the job's row.
const summary = computed(() => {
  const row = openRow.value
  const s = jobDetail.value?.status
  // A job HSwarm could not read answers only { error }; a job-wide error rides beside a real status.
  const live = s?.job_id ? s : undefined
  const tokens = live?.tokens ?? row?.tokens
  return {
    label: live?.label || row?.label || '',
    state: live?.state ?? row?.state ?? '',
    counts: countParts(live?.counts ?? row?.counts),
    total: row?.tasks,
    cost: costText(live?.cost_usd ?? row?.cost_usd),
    costHint:
      tokens == null
        ? t('hswarm.v.money.atListPrice')
        : t('hswarm.v.jobs.costHint', { tokens: formatTokens(tokens) }),
    ...jobTime(row),
    // The one job-wide reason its tasks failed (no credit left), or why HSwarm could not read the job.
    error: s?.error ?? '',
  }
})

// --- the chat that called it ----------------------------------------------------------------------

/** The caller's ids from the job's stamp; an older answer has only the key's 8-character session prefix. */
function callerIdsOf(job: Job | undefined): { sessionId: string; chatId: string } | null {
  if (!job) return null
  const ids = job.caller_ids ?? (job.caller && typeof job.caller === 'object' ? job.caller : null)
  if (ids) {
    const sessionId = ids.session_id || ''
    const chatId = ids.chat_id || ''
    return sessionId || chatId ? { sessionId, chatId } : null
  }
  const part = typeof job.caller === 'string' ? (job.caller.split(' / ')[1]?.trim() ?? '') : ''
  return part && part !== '-' ? { sessionId: part, chatId: '' } : null
}

// Chat titles by the id they were asked for, from AgentHydra's chat list (archived chats too: a finished
// job's chat often is by now). Each chat is asked once while the page is up; one it does not know (a chat
// run outside Claude Desktop) stays unnamed.
const chatNames = reactive(new Map<string, { sessionId: string; title: string | null }>())
const chatAsked = new Set<string>()

// A whole id only, which no other chat holds: a prefix could match two chats, and a caller is never a guess.
const callerQuery = computed(() => {
  const ids = callerIdsOf(openRow.value)
  if (ids?.chatId) return ids.chatId
  return ids && ids.sessionId.length > 8 ? ids.sessionId : ''
})

watch(
  callerQuery,
  (q) => {
    if (!q || chatAsked.has(q)) return
    chatAsked.add(q)
    void getJson<ChatListResult>(`/api/chats?q=${encodeURIComponent(q)}&archived=include&limit=1`).then(
      (res) => {
        const row = res.rows?.[0]
        if (row) chatNames.set(q, { sessionId: row.sessionId ?? '', title: row.title ?? null })
      },
      // Asked again the next time the job opens.
      () => chatAsked.delete(q),
    )
  },
  { immediate: true },
)

const caller = computed(() => {
  const ids = callerIdsOf(openRow.value)
  if (!ids) return null
  const named = chatNames.get(callerQuery.value)
  const sessionId = named?.sessionId || ids.sessionId
  const short = (ids.chatId || ids.sessionId).replace(/^local_/, '').slice(0, 8)
  return {
    name: named?.title ? pii(named.title) : t('hswarm.v.jobs.callerUnnamed', { id: short }),
    // Desk opens a chat by its whole CLI session id; the old key's prefix is not one.
    open: EMBEDDED && sessionId.length > 8 ? sessionId : '',
  }
})

function openCaller() {
  const id = caller.value?.open
  if (id) openInDesk({ session_id: id, source: 'claude' })
}

// --- the task results -----------------------------------------------------------------------------

// Past this many tasks the list opens folded to its heading; it is decided once per opened job, so a
// running job that grows past it does not fold under the person reading it.
const FOLD_AT = 5
// Lines drawn at a time: a job can hold thousands of tasks.
const TASK_PAGE = 150

interface TaskMark {
  icon: Component
  tone: string
  spin?: boolean
  label: string
}

interface TaskRow {
  id: string
  status: string
  model: string
  cost: number | null | undefined
  mark: TaskMark
  /** The first line of what it said (a failed task's error first), for its one line. */
  first: string
  firstTone: string
  /** Everything it said, for the box its line opens. */
  full: string
}

function taskMark(status: string): TaskMark {
  if (status === 'ok') return { icon: CircleCheck, tone: 'text-success', label: t('hswarm.v.jobs.markDone') }
  if (status === 'running')
    return { icon: LoaderCircle, tone: 'text-info', spin: true, label: t('hswarm.v.jobs.markRunning') }
  if (status === 'pending') return { icon: Clock, tone: 'text-muted-foreground', label: t('hswarm.v.jobs.markQueued') }
  if (status === 'cancelled')
    return { icon: Ban, tone: 'text-muted-foreground', label: t('hswarm.v.jobs.markCancelled') }
  return { icon: CircleX, tone: 'text-destructive', label: t('hswarm.v.jobs.markFailed', { status }) }
}

const firstLine = (text: string) => (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 300)

function resultRow(r: TaskResult): TaskRow {
  const failed = isFailed(r.status)
  // With a schema the answer is `data` (HSwarm drops an `answer` that only repeats it).
  const hasData = r.data !== undefined && r.data !== null
  const dataLine = !hasData ? '' : typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
  const dataFull = !hasData ? '' : typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)
  const head = failed && r.error ? r.error : r.answer || dataLine || r.error || ''
  const full = [failed ? r.error : '', r.answer, dataFull, failed ? '' : r.error].filter(Boolean).join('\n\n')
  return {
    id: r.id,
    status: r.status,
    model: r.model ?? '',
    cost: r.cost_usd,
    mark: taskMark(r.status),
    first: firstLine(head),
    firstTone: failed ? 'text-destructive' : '',
    full: full || t('hswarm.v.jobs.noAnswer'),
  }
}

// The running tasks first (what is happening now), then the finished ones in task order.
const taskRows = computed<TaskRow[]>(() => {
  const r = jobDetail.value?.results
  if (!r) return []
  const running = (r.running ?? []).map(
    (x): TaskRow => ({
      id: x.id,
      status: 'running',
      model: '',
      cost: undefined,
      mark: taskMark('running'),
      first: t('hswarm.v.jobs.runningTime', { span: spanText(x.elapsed_s ?? 0) }),
      firstTone: 'text-muted-foreground',
      full: t('hswarm.v.jobs.noAnswerYet'),
    }),
  )
  const finished = (r.results ?? []).map(resultRow)
  // Queued tasks have no id or answer yet, so HSwarm lists none: a muted line each, last, so the lines
  // add up to the summary's counts (the same counts it reads).
  const s = jobDetail.value?.status
  const counts = (s?.job_id ? s.counts : undefined) ?? openRow.value?.counts
  const queued = Array.from(
    { length: missingQueued(counts, [...running, ...finished]) },
    (_, i): TaskRow => ({
      id: `queued-${i + 1}`,
      status: 'pending',
      model: '',
      cost: undefined,
      mark: taskMark('pending'),
      first: t('hswarm.v.jobs.markQueued'),
      firstTone: 'text-muted-foreground',
      full: t('hswarm.v.jobs.noAnswerQueued'),
    }),
  )
  return [...running, ...finished, ...queued]
})

const taskCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const row of taskRows.value) counts[row.status] = (counts[row.status] ?? 0) + 1
  return counts
})

const resultsError = computed(() => jobDetail.value?.results?.error ?? '')
const resultsOpen = ref(true)
const taskLimit = ref(TASK_PAGE)
const shownTasks = computed(() => taskRows.value.slice(0, taskLimit.value))
// One task's answer open at a time.
const openTask = ref<string | null>(null)
// The job the fold was decided for: a reload of the same job keeps the person's choice.
let foldedFor: string | null = null

function toggleTask(id: string) {
  openTask.value = openTask.value === id ? null : id
}

// Bumped by every detail fetch: an answer that lands after a newer fetch began (another job was
// opened meanwhile) is dropped instead of filling the newer job's row.
let detailSeq = 0

// quiet: a reload's refetch, which keeps the open detail on screen until the new one arrives.
async function loadJobDetail(jobId: string, quiet = false) {
  const seq = ++detailSeq
  if (!quiet) {
    isLoadingDetail.value = true
    detailError.value = null
  }
  try {
    const response = await apiCall(`job?id=${encodeURIComponent(jobId)}`, {
      method: 'GET',
    })
    if (seq !== detailSeq) return
    jobDetail.value = response
    detailError.value = null
    if (foldedFor !== jobId) {
      foldedFor = jobId
      resultsOpen.value = taskRows.value.length <= FOLD_AT
      taskLimit.value = TASK_PAGE
      openTask.value = null
    }
  } catch (err) {
    if (seq !== detailSeq) return
    detailError.value = err instanceof Error ? err.message : t('hswarm.v.jobs.jobNotFound')
    jobDetail.value = null
  } finally {
    if (seq === detailSeq) isLoadingDetail.value = false
  }
}

// Opens a job under its row in one table; the same job open in the other table just moves there.
async function openJob(jobId: string, where: Where) {
  openIn.value = where
  if (selectedJobId.value === jobId) return
  selectedJobId.value = jobId
  await loadJobDetail(jobId)
  // A row near the bottom opens below the fold: once the summary is in and has grown open (150 ms), bring
  // it into view, the least scroll that shows it (owner, 2026-10-04: "I don't wanna scroll ... to see that").
  await nextTick()
  setTimeout(() => {
    if (selectedJobId.value !== jobId) return
    document.getElementById(detailId(where, jobId))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, 170)
}

function closeJob() {
  const where = detailIn.value
  const id = selectedJobId.value
  // Focus inside the closing detail (its close button) would fall to the page: back to the row.
  const detail = where && id ? document.getElementById(detailId(where, id)) : null
  if (where && id && detail?.contains(document.activeElement)) toggleEl(where, id)?.focus()
  selectedJobId.value = null
  // Opened again, it starts as a fresh open: folded by its size, no answer open.
  foldedFor = null
}

function toggleJob(jobId: string, where: Where) {
  if (isOpen(where, jobId)) closeJob()
  else void openJob(jobId, where)
}

// A reload keeps the open job open: the tables stay on screen while the list refreshes, and the
// open job's detail is fetched again quietly, so its row neither collapses nor jumps.
async function reload() {
  const open = selectedJobId.value
  await Promise.all([loadJobs(), open ? loadJobDetail(open, true) : null])
}

async function cancelJob(jobId: string) {
  if (isCancelling.value || !confirm(t('hswarm.v.jobs.confirmCancel', { id: jobId }))) {
    return
  }

  isCancelling.value = true
  try {
    const response = await apiCall('job/cancel', {
      method: 'POST',
      body: JSON.stringify({ id: jobId }),
    })
    if (response?.error) {
      throw new Error(response.error)
    }
    toast.success(t('hswarm.v.jobs.jobCancelled'))
    await reload()
    emit('changed')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : t('hswarm.v.jobs.failedToLoad')
    toast.error(errorMsg)
  } finally {
    isCancelling.value = false
  }
}

// Escape closes the open job while the focus is on this page or on nothing at all (a click on a
// row's text leaves it on the body, not in the table); a key meant for the tree or for a field
// elsewhere is left alone.
function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !detailIn.value) return
  const el = e.target as HTMLElement | null
  const here =
    !el || el === document.body || el === document.documentElement || !!rootEl.value?.contains(el)
  if (!here || el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '')) return
  e.preventDefault()
  closeJob()
}

onMounted(async () => {
  window.addEventListener('keydown', onWindowKey)
  const listed = loadJobs()
  if (!props.jobId) return
  // A job picked in the tree opens where it is listed first (the running table while it runs), and
  // its row is scrolled to the top once the list and its detail have loaded.
  const id = props.jobId
  await Promise.all([listed, openJob(id, 'running')])
  await nextTick()
  const where = detailIn.value
  if (where) toggleEl(where, id)?.closest('tr')?.scrollIntoView({ block: 'start' })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
})
</script>

<template>
  <div ref="rootEl" class="flex h-full flex-col gap-2 p-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">
        {{ t('hswarm.v.jobs.title') }}
      </h2>
      <Button size="sm" variant="outline" :disabled="isLoading" @click="reload">
        <RefreshCw :class="{ 'animate-spin': isLoading }" class="size-4" />
        <span class="hidden sm:inline ms-1">{{ t('hswarm.v.jobs.reload') }}</span>
      </Button>
    </div>

    <!-- Error Alert -->
    <Alert v-if="error" variant="destructive">
      <AlertCircle class="size-4" />
      <AlertTitle>{{ t('hswarm.v.jobs.failedToLoad') }}</AlertTitle>
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Loading State (first load only: a reload keeps the tables, and the open job, in place) -->
    <div v-if="isLoading && !jobs.length" class="space-y-2">
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
    </div>

    <!-- Empty State -->
    <div
      v-else-if="!jobs.length"
      class="flex flex-col items-center justify-center gap-3 py-4 text-center"
    >
      <div class="text-4xl text-muted-foreground">✨</div>
      <div>
        <h3 class="font-semibold">{{ t('hswarm.v.jobs.noJobs') }}</h3>
        <p class="text-sm text-muted-foreground">
          {{ t('hswarm.v.jobs.noJobsDescription') }}
        </p>
      </div>
    </div>

    <!-- Main Content: the running jobs (while any run), then every recent job -->
    <div v-else class="flex flex-col gap-3 overflow-auto flex-1">
      <div v-for="section in sections" :key="section.key">
        <h3 class="text-base font-semibold mb-3">
          {{ section.title }}
          <span class="text-sm font-normal text-muted-foreground">
            ({{ section.jobs.length }})
          </span>
        </h3>
        <div class="border rounded-lg overflow-x-auto">
          <Table rows="dense">
            <TableHeader>
              <TableRow>
                <TableHead>{{ t('hswarm.v.jobs.table.jobId') }}</TableHead>
                <TableHead>{{ t('hswarm.v.jobs.table.label') }}</TableHead>
                <TableHead>{{ t('hswarm.v.jobs.table.state') }}</TableHead>
                <TableHead class="text-end">
                  {{ t('hswarm.v.jobs.table.tasks') }}
                </TableHead>
                <TableHead class="text-end">
                  {{ t('hswarm.v.jobs.table.cost') }}
                </TableHead>
                <TableHead>{{ t('hswarm.v.jobs.table.created') }}</TableHead>
                <TableHead class="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <template v-for="job in section.jobs" :key="job.job_id">
                <!-- A click anywhere on the row toggles it; its button carries the open state (and tints the row) for the keyboard -->
                <TableRow
                  class="cursor-pointer"
                  @click="toggleJob(job.job_id, section.key)"
                >
                  <TableCell mono>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      :data-job-toggle="`${section.key}:${job.job_id}`"
                      :aria-expanded="isOpen(section.key, job.job_id)"
                      :aria-controls="isOpen(section.key, job.job_id) ? detailId(section.key, job.job_id) : undefined"
                    >
                      <ChevronRight
                        class="size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none"
                        :class="isOpen(section.key, job.job_id) ? 'rotate-90' : ''"
                        aria-hidden="true"
                      />
                      {{ job.job_id.substring(0, 8) }}...
                    </button>
                  </TableCell>
                  <TableCell>{{ job.label || '–' }}</TableCell>
                  <TableCell>
                    <Badge :variant="stateVariant(job.state)">
                      {{ job.state }}
                    </Badge>
                  </TableCell>
                  <TableCell align="end" size="sm">
                    {{ tallyText(job.counts) }}
                  </TableCell>
                  <TableCell align="end" mono size="sm">
                    {{ formatTokens(job.tokens) }}
                    <div v-if="job.tokens != null" class="text-xs text-muted-foreground">{{ costText(job.cost_usd) }} {{ t('hswarm.v.money.atListPrice') }}</div>
                  </TableCell>
                  <TableCell size="sm" muted>
                    {{ formatDate(job.created) }}
                  </TableCell>
                  <TableCell class="w-12">
                    <Button
                      v-if="jobDot(job.state) === 'run'"
                      size="sm"
                      variant="ghost"
                      :aria-label="t('hswarm.v.jobs.cancelJob')"
                      :title="t('hswarm.v.jobs.cancelJob')"
                      :disabled="isCancelling"
                      @click.stop="cancelJob(job.job_id)"
                    >
                      <X class="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>

                <!-- The open job, right under its row: a one-line summary, then its task results -->
                <tr
                  v-if="isOpen(section.key, job.job_id)"
                  :id="detailId(section.key, job.job_id)"
                  class="border-b bg-muted/30"
                >
                  <td colspan="7" class="p-0! text-base whitespace-normal">
                    <!-- w-0 min-w-full: the detail spans the table without widening its columns. It grows
                         open from zero height in CSS alone (starting: is @starting-style), with no measuring. -->
                    <div class="grid w-0 min-w-full grid-rows-[1fr] transition-[grid-template-rows] duration-150 ease-out starting:grid-rows-[0fr] motion-reduce:transition-none">
                      <div class="min-h-0 overflow-hidden">
                        <div class="flex flex-col gap-2 px-3 py-2">
                          <div class="flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <!-- Detail Error -->
                              <Alert v-if="detailError" variant="destructive">
                                <AlertCircle class="size-4" />
                                <AlertTitle>{{ t('hswarm.v.jobs.failedToLoad') }}</AlertTitle>
                                <AlertDescription>{{ detailError }}</AlertDescription>
                              </Alert>

                              <!-- Detail Loading -->
                              <Skeleton v-else-if="isLoadingDetail" class="h-7 w-full" />

                              <!-- The summary: one line of facts, wrapping only on a narrow pane -->
                              <template v-else>
                                <div class="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                  <span class="min-w-0 max-w-full truncate text-sm font-medium" :title="job.job_id">{{ summary.label || job.job_id }}</span>
                                  <Badge :variant="stateVariant(summary.state)">{{ summary.state || '–' }}</Badge>
                                  <span
                                    class="inline-flex flex-wrap gap-x-2 tabular-nums"
                                    :title="summary.total != null ? t('hswarm.v.jobs.countsHint', { n: summary.total }) : undefined"
                                  >
                                    <span v-for="c in summary.counts" :key="c.key" :class="c.tone">{{ c.text }}</span>
                                  </span>
                                  <span class="font-mono tabular-nums" :title="summary.costHint">{{ summary.cost }}</span>
                                  <span class="inline-flex items-center gap-1 text-muted-foreground" :title="summary.timeHint || undefined">
                                    <Clock class="size-3.5 shrink-0" aria-hidden="true" />{{ summary.time }}
                                  </span>
                                  <!-- The chat that called it; a click opens it in Desk -->
                                  <button
                                    v-if="caller?.open"
                                    type="button"
                                    class="inline-flex min-w-0 max-w-64 items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    :title="t('hswarm.v.jobs.callerOpen')"
                                    @click="openCaller"
                                  >
                                    <MessageSquare class="size-3.5 shrink-0" aria-hidden="true" />
                                    <span class="truncate">{{ caller.name }}</span>
                                  </button>
                                  <span
                                    v-else-if="caller"
                                    class="inline-flex min-w-0 max-w-64 items-center gap-1 text-muted-foreground"
                                    :title="t('hswarm.v.jobs.callerHint')"
                                  >
                                    <MessageSquare class="size-3.5 shrink-0" aria-hidden="true" />
                                    <span class="truncate">{{ caller.name }}</span>
                                  </span>
                                </div>
                                <p v-if="summary.error" class="mt-1 text-xs text-destructive">{{ summary.error }}</p>
                              </template>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              :aria-label="t('hswarm.v.jobs.closeSummary')"
                              :title="t('hswarm.v.jobs.closeSummary')"
                              aria-keyshortcuts="Escape"
                              @click="closeJob"
                            >
                              <X class="size-4" />
                            </Button>
                          </div>

                          <!-- Task results: one line per task under a heading that folds them (folded past
                               FOLD_AT tasks), in a box that scrolls instead of growing the page -->
                          <div
                            v-if="jobDetail?.results && !detailError && !isLoadingDetail"
                            class="flex flex-col gap-1.5 border-t pt-2"
                          >
                          <Collapsible v-model:open="resultsOpen">
                            <div class="flex min-w-0 items-center gap-1.5">
                              <CollapsibleTrigger as-child>
                                <button
                                  type="button"
                                  class="group flex min-w-0 items-center gap-1.5 rounded-md px-1 text-xs font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <ChevronRight
                                    class="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                                    aria-hidden="true"
                                  />
                                  <span class="shrink-0">{{ t('hswarm.v.jobs.taskResults') }}</span>
                                  <span class="truncate font-normal text-muted-foreground tabular-nums">({{ taskRows.length }}) {{ tallyText(taskCounts) }}</span>
                                </button>
                              </CollapsibleTrigger>
                              <InfoHint :text="t('hswarm.v.jobs.taskResultsHint', { n: FOLD_AT })" />
                            </div>
                            <CollapsibleContent>
                              <p v-if="resultsError" class="px-1 text-xs text-destructive">{{ resultsError }}</p>
                              <p v-else-if="!taskRows.length" class="px-1 text-xs text-muted-foreground">
                                {{ t('hswarm.v.jobs.noResults') }}
                              </p>
                              <template v-else>
                                <ul
                                  class="scroll-slim flex max-h-96 flex-col overflow-y-auto rounded-lg border bg-card py-0.5"
                                  :aria-label="t('hswarm.v.jobs.taskListLabel')"
                                >
                                  <li v-for="task in shownTasks" :key="task.id">
                                    <!-- One line: how it ended, its id, the model, the cost, the first line of its answer -->
                                    <button
                                      type="button"
                                      class="flex h-7 w-full min-w-0 items-center gap-2 px-2.5 text-start text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                      :aria-expanded="openTask === task.id"
                                      @click="toggleTask(task.id)"
                                    >
                                      <span class="relative inline-flex shrink-0" :class="task.mark.tone" :title="task.mark.label">
                                        <component
                                          :is="task.mark.icon"
                                          class="size-3.5"
                                          :class="task.mark.spin ? 'animate-spin' : ''"
                                          aria-hidden="true"
                                        />
                                        <span class="sr-only">{{ task.mark.label }}</span>
                                      </span>
                                      <span class="w-24 shrink-0 truncate font-mono" :title="task.id">{{ task.id }}</span>
                                      <span class="hidden w-36 shrink-0 truncate text-muted-foreground sm:block" :title="task.model || undefined">{{ task.model || '–' }}</span>
                                      <span class="w-16 shrink-0 text-end font-mono tabular-nums text-muted-foreground" :title="t('hswarm.v.money.atListPrice')">{{ costText(task.cost) }}</span>
                                      <span class="min-w-0 flex-1 truncate" :class="task.firstTone">{{ task.first || '–' }}</span>
                                    </button>
                                    <!-- Its whole answer, in a box of its own height that scrolls -->
                                    <pre
                                      v-if="openTask === task.id"
                                      tabindex="0"
                                      class="scroll-slim mx-2.5 mb-1.5 max-h-64 overflow-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap wrap-break-word"
                                    >{{ task.full }}</pre>
                                  </li>
                                </ul>
                                <Button
                                  v-if="taskRows.length > taskLimit"
                                  variant="outline"
                                  size="sm"
                                  class="mt-1.5 w-full"
                                  @click="taskLimit += TASK_PAGE"
                                >
                                  {{ t('hswarm.v.jobs.taskShowMore', { n: Math.min(TASK_PAGE, taskRows.length - taskLimit), total: taskRows.length - taskLimit }) }}
                                </Button>
                              </template>
                            </CollapsibleContent>
                          </Collapsible>
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  </div>
</template>
