<script setup lang="ts">
// The Jobs page: the jobs running now, then every recent job. A click on a job opens its summary
// and task results right under its row, inside the table (owner, 2026-10-04: "The HSwarm jobs
// should expand in place on the table to show the data instead of making it appear on the
// bottom."). One job is open at a time; a second click, its close button or Escape closes it.
import { AlertCircle, ChevronRight, RefreshCw, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'
import { formatTokens, formatUsd } from '@/lib/kit'

const { t } = useI18n()
const { apiCall } = useHswarmApi()

// jobId: set when the HSwarm tree picked one job; the page opens with that job open under its row.
const props = defineProps<{ state: HswarmState; jobId?: string }>()
const emit = defineEmits<{ changed: [] }>()

interface Job {
  job_id: string
  label: string
  state: string
  tasks: number
  counts: Record<string, number>
  cost_usd: number
  tokens?: number
  created: string
  finished?: string
}

interface JobDetail {
  status?: Job
  results?: {
    results: Array<{
      id: string
      status: string
      model: string
      cost_usd: number
      usage?: { in_hit?: number; in_miss?: number; out?: number }
      answer?: string
      error?: string
      data?: any
    }>
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

const runningJobs = computed(() => jobs.value.filter((j) => jobDot(j.state) === 'run'))

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
  if (openIn.value === 'running' && runningJobs.value.some((j) => j.job_id === id)) return 'running'
  return allJobs.value.some((j) => j.job_id === id) ? 'all' : null
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

function getStateColor(state: string) {
  const dot = jobDot(state)
  switch (dot) {
    case 'run':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100'
    case 'ok':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
    case 'bad':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-100'
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

const costText = (cost: number) => formatUsd(cost, { style: 'fine' })

function usageTokens(u?: { in_hit?: number; in_miss?: number; out?: number }): number | undefined {
  if (!u) return undefined
  return (u.in_hit ?? 0) + (u.in_miss ?? 0) + (u.out ?? 0)
}

// The first 50 characters of a result's data, worked out once per payload, not on every render.
const previews = new WeakMap<object, string>()
function dataPreview(data: unknown): string {
  if (typeof data !== 'object' || data === null) return JSON.stringify(data).substring(0, 50)
  let text = previews.get(data)
  if (text === undefined) {
    text = JSON.stringify(data).substring(0, 50)
    previews.set(data, text)
  }
  return text
}

function getTaskCounts(job: Job): string {
  if (!job.counts || Object.keys(job.counts).length === 0) return '–'
  return Object.entries(job.counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ')
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
      <AlertCircle class="h-4 w-4" />
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
          <Table class="[&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
            <TableHeader>
              <TableRow>
                <TableHead>{{ t('hswarm.v.jobs.table.jobId') }}</TableHead>
                <TableHead>{{ t('hswarm.v.jobs.table.label') }}</TableHead>
                <TableHead>{{ t('hswarm.v.jobs.table.state') }}</TableHead>
                <TableHead class="text-right">
                  {{ t('hswarm.v.jobs.table.tasks') }}
                </TableHead>
                <TableHead class="text-right">
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
                  class="cursor-pointer hover:bg-muted/50"
                  @click="toggleJob(job.job_id, section.key)"
                >
                  <TableCell class="font-mono text-sm">
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
                    <Badge :class="getStateColor(job.state)">
                      {{ job.state }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-right text-sm">
                    {{ getTaskCounts(job) }}
                  </TableCell>
                  <TableCell class="text-right font-mono text-sm">
                    {{ formatTokens(job.tokens) }}
                    <div v-if="job.tokens != null" class="text-xs text-muted-foreground">{{ costText(job.cost_usd) }} {{ t('hswarm.v.money.atListPrice') }}</div>
                  </TableCell>
                  <TableCell class="text-sm text-muted-foreground">
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

                <!-- The open job's summary and task results, right under its row -->
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
                        <div class="p-4">
                          <div class="flex items-center justify-between mb-2">
                            <h4 class="font-semibold">{{ t('hswarm.v.jobs.summary') }}</h4>
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

                          <!-- Detail Error -->
                          <Alert v-if="detailError" variant="destructive" class="mb-2">
                            <AlertCircle class="h-4 w-4" />
                            <AlertTitle>{{ t('hswarm.v.jobs.failedToLoad') }}</AlertTitle>
                            <AlertDescription>{{ detailError }}</AlertDescription>
                          </Alert>

                          <!-- Detail Loading -->
                          <div v-else-if="isLoadingDetail" class="space-y-2">
                            <Skeleton class="h-6 w-full" />
                            <Skeleton class="h-6 w-full" />
                            <Skeleton class="h-6 w-full" />
                          </div>

                          <!-- Detail Content -->
                          <div v-else-if="jobDetail?.status" class="space-y-2 text-sm">
                            <div class="grid grid-cols-2 gap-2">
                              <div>
                                <span class="text-muted-foreground">{{ t('hswarm.v.jobs.table.jobId') }}:</span>
                                <div class="font-mono text-xs mt-1 break-all">{{ jobDetail.status.job_id }}</div>
                              </div>
                              <div>
                                <span class="text-muted-foreground">{{ t('hswarm.v.jobs.table.label') }}:</span>
                                <div class="mt-1">{{ jobDetail.status.label || '–' }}</div>
                              </div>
                              <div>
                                <span class="text-muted-foreground">{{ t('hswarm.v.jobs.table.state') }}:</span>
                                <div class="mt-1">
                                  <Badge :class="getStateColor(jobDetail.status.state)">
                                    {{ jobDetail.status.state }}
                                  </Badge>
                                </div>
                              </div>
                              <div>
                                <span class="text-muted-foreground">{{ t('hswarm.v.jobs.table.cost') }}:</span>
                                <div class="font-mono mt-1">{{ formatTokens(jobDetail.status.tokens) }}</div>
                                <div v-if="jobDetail.status.tokens != null" class="text-xs text-muted-foreground">{{ costText(jobDetail.status.cost_usd) }} {{ t('hswarm.v.money.atListPrice') }}</div>
                              </div>
                              <div>
                                <span class="text-muted-foreground">{{ t('hswarm.v.jobs.table.tasks') }}:</span>
                                <div class="mt-1">{{ getTaskCounts(jobDetail.status) }}</div>
                              </div>
                              <div>
                                <span class="text-muted-foreground">{{ t('hswarm.v.jobs.table.created') }}:</span>
                                <div class="mt-1 text-xs">
                                  {{ formatDate(jobDetail.status.created) }}
                                </div>
                              </div>
                            </div>

                            <!-- Task Results -->
                            <div v-if="jobDetail.results" class="mt-3 border-t pt-4">
                              <h5 class="font-semibold mb-3">
                                {{ t('hswarm.v.jobs.taskResults') }}
                                <span v-if="jobDetail.results.results" class="text-sm font-normal text-muted-foreground">
                                  ({{ jobDetail.results.results.length }})
                                </span>
                              </h5>

                              <div v-if="jobDetail.results.error" class="text-red-600 text-sm mb-2">
                                {{ jobDetail.results.error }}
                              </div>

                              <div
                                v-else-if="!jobDetail.results.results?.length"
                                class="text-muted-foreground text-sm"
                              >
                                {{ t('hswarm.v.jobs.noResults') }}
                              </div>

                              <div v-else class="border rounded-lg overflow-x-auto">
                                <Table class="[&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead class="w-20">
                                        {{ t('hswarm.v.jobs.table.jobId') }}
                                      </TableHead>
                                      <TableHead>
                                        {{ t('hswarm.v.jobs.taskStatus') }}
                                      </TableHead>
                                      <TableHead>
                                        {{ t('hswarm.v.jobs.taskModel') }}
                                      </TableHead>
                                      <TableHead class="text-right">
                                        {{ t('hswarm.v.jobs.taskCost') }}
                                      </TableHead>
                                      <TableHead>
                                        {{ t('hswarm.v.jobs.taskAnswer') }}
                                      </TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    <TableRow v-for="result in jobDetail.results.results" :key="result.id">
                                      <TableCell class="font-mono text-xs">
                                        {{ result.id.substring(0, 8) }}
                                      </TableCell>
                                      <TableCell>
                                        <Badge
                                          :class="
                                            result.status === 'ok'
                                              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
                                              : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100'
                                          "
                                        >
                                          {{ result.status }}
                                        </Badge>
                                      </TableCell>
                                      <TableCell class="font-mono text-xs">
                                        {{ result.model || '–' }}
                                      </TableCell>
                                      <TableCell class="text-right font-mono text-xs">
                                        {{ formatTokens(usageTokens(result.usage)) }}
                                        <div v-if="usageTokens(result.usage) != null" class="text-muted-foreground">{{ costText(result.cost_usd) }} {{ t('hswarm.v.money.atListPrice') }}</div>
                                      </TableCell>
                                      <TableCell class="text-xs max-w-xs truncate">
                                        {{ result.answer || result.error || (result.data ? dataPreview(result.data) : '–') }}
                                      </TableCell>
                                    </TableRow>
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
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
