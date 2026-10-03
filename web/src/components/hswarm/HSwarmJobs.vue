<script setup lang="ts">
import { AlertCircle, RefreshCw, X } from '@lucide/vue'
import { computed, nextTick, onMounted, ref } from 'vue'
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

const { t } = useI18n()
const { apiCall } = useHswarmApi()

// jobId: set when the HSwarm tree picked one job; the page opens on its detail.
const props = defineProps<{ state: HswarmState; jobId?: string }>()
const emit = defineEmits<{ changed: [] }>()

interface Job {
  job_id: string
  label: string
  state: string
  tasks: number
  counts: Record<string, number>
  cost_usd: number
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
      answer?: string
      error?: string
      data?: any
    }>
    error?: string
  }
  error?: string
}

const jobs = ref<Job[]>([])
const selectedJobId = ref<string | null>(null)
const jobDetail = ref<JobDetail | null>(null)
const isLoading = ref(true)
const isLoadingDetail = ref(false)
const error = ref<string | null>(null)
const isCancelling = ref(false)
const detailError = ref<string | null>(null)

const runningJobs = computed(() => jobs.value.filter((j) => jobDot(j.state) === 'run'))

const allJobs = computed(() => jobs.value)

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

function formatCost(cost: number): string {
  if (cost == null) return '–'
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`
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
    error.value = err instanceof Error ? err.message : t('hswarm.v.jobs.failedToLoad')
    jobs.value = []
    toast.error(t('hswarm.v.jobs.failedToLoad'))
  } finally {
    isLoading.value = false
  }
}

async function loadJobDetail(jobId: string) {
  isLoadingDetail.value = true
  detailError.value = null
  try {
    const response = await apiCall(`job?id=${encodeURIComponent(jobId)}`, {
      method: 'GET',
    })
    jobDetail.value = response
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : t('hswarm.v.jobs.jobNotFound')
    jobDetail.value = null
  } finally {
    isLoadingDetail.value = false
  }
}

async function selectJob(jobId: string) {
  selectedJobId.value = jobId
  await loadJobDetail(jobId)
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
    await loadJobs()
    emit('changed')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : t('hswarm.v.jobs.failedToLoad')
    toast.error(errorMsg)
  } finally {
    isCancelling.value = false
  }
}

// The job detail renders below the tables: a job picked in the tree is scrolled into view once both have loaded.
const detailEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  const listed = loadJobs()
  if (!props.jobId) return
  await Promise.all([listed, selectJob(props.jobId)])
  await nextTick()
  detailEl.value?.scrollIntoView({ block: 'start' })
})
</script>

<template>
  <div class="flex h-full flex-col gap-2 p-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">
        {{ t('hswarm.v.jobs.title') }}
      </h2>
      <Button size="sm" variant="outline" :disabled="isLoading" @click="loadJobs">
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

    <!-- Loading State -->
    <div v-if="isLoading" class="space-y-2">
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

    <!-- Main Content -->
    <div v-else class="flex flex-col gap-3 overflow-auto flex-1">
      <!-- Running Jobs Section -->
      <div v-if="runningJobs.length > 0">
        <h3 class="text-base font-semibold mb-3">
          {{ t('hswarm.v.jobs.runningNow') }}
          <span class="text-sm font-normal text-muted-foreground">
            ({{ runningJobs.length }})
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
              <TableRow
                v-for="job in runningJobs"
                :key="job.job_id"
                class="cursor-pointer hover:bg-muted/50"
                @click="selectJob(job.job_id)"
              >
                <TableCell class="font-mono text-sm">
                  {{ job.job_id.substring(0, 8) }}...
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
                  {{ formatCost(job.cost_usd) }}
                </TableCell>
                <TableCell class="text-sm text-muted-foreground">
                  {{ formatDate(job.created) }}
                </TableCell>
                <TableCell class="w-12">
                  <Button
                    size="sm"
                    variant="ghost"
                    :disabled="isCancelling"
                    @click.stop="cancelJob(job.job_id)"
                  >
                    <X class="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      <!-- All Jobs Section -->
      <div>
        <h3 class="text-base font-semibold mb-3">
          {{ t('hswarm.v.jobs.allRecentJobs') }}
          <span class="text-sm font-normal text-muted-foreground">
            ({{ allJobs.length }})
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
              <TableRow
                v-for="job in allJobs"
                :key="job.job_id"
                class="cursor-pointer hover:bg-muted/50"
                @click="selectJob(job.job_id)"
              >
                <TableCell class="font-mono text-sm">
                  {{ job.job_id.substring(0, 8) }}...
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
                  {{ formatCost(job.cost_usd) }}
                </TableCell>
                <TableCell class="text-sm text-muted-foreground">
                  {{ formatDate(job.created) }}
                </TableCell>
                <TableCell class="w-12">
                  <Button
                    v-if="jobDot(job.state) === 'run'"
                    size="sm"
                    variant="ghost"
                    :disabled="isCancelling"
                    @click.stop="cancelJob(job.job_id)"
                  >
                    <X class="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      <!-- Job Detail Section -->
      <div v-if="selectedJobId" ref="detailEl" class="border rounded-lg p-4 bg-muted/30">
        <div class="flex items-center justify-between mb-2">
          <h4 class="font-semibold">{{ t('hswarm.v.jobs.summary') }}</h4>
          <Button
            size="sm"
            variant="ghost"
            @click="selectedJobId = null"
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
              <div class="font-mono text-xs mt-1">{{ jobDetail.status.job_id }}</div>
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
              <div class="font-mono mt-1">{{ formatCost(jobDetail.status.cost_usd) }}</div>
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
                      {{ formatCost(result.cost_usd) }}
                    </TableCell>
                    <TableCell class="text-xs max-w-xs truncate">
                      {{ result.answer || result.error || (result.data ? JSON.stringify(result.data).substring(0, 50) : '–') }}
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
</template>
