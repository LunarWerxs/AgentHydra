import { computed, reactive, ref } from 'vue'
import type { FreeCommand, FreeInstance, FreeJob, FreeRequest, FreeResult, FreeThread } from '@desk/shared/free-instances'
import { FreeApiError, freeApi, rememberedJob } from '@/lib/free-instances'

// One copy survives tab changes. Only request UUIDs go into browser storage.
const instances = ref<FreeInstance[]>([])
const threads = ref<FreeThread[]>([])
const jobs = reactive<Record<string, FreeJob | undefined>>({})
const errors = reactive<Record<string, string>>({})
const loaded = ref(false)
const loading = ref(false)
const loadError = ref('')
const followers = new Map<string, Promise<FreeResult | null>>()
const checked = new Set<string>()
let refreshing: Promise<void> | null = null

const busy = (id: string) => jobs[id]?.state === 'running'

async function snapshot(): Promise<void> {
  const [status, list] = await Promise.all([freeApi.status(), freeApi.threads()])
  instances.value = status.instances
  threads.value = list
  for (const job of status.jobs) if (job.state === 'running') jobs[job.instanceId] = job
  loaded.value = true
}

function follow(first: FreeJob): Promise<FreeResult | null> {
  const existing = followers.get(first.id)
  if (existing) return existing
  const task = (async () => {
    let job = first
    jobs[job.instanceId] = job
    try {
      while (job.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 1000))
        job = await freeApi.job(job.id)
        jobs[job.instanceId] = job
      }
      rememberedJob(job.instanceId, null)
      if (!job.result?.ok) errors[job.instanceId] = job.result?.error?.message || 'The operation did not complete. Read the chat before sending again.'
      await snapshot()
      return job.result ?? null
    } catch (error) {
      errors[job.instanceId] = error instanceof Error ? error.message : 'Connection interrupted. Check the operation before sending again.'
      // A lost acknowledgement must not unlock Send or replay the POST.
      if (error instanceof FreeApiError && error.status === 404) { delete jobs[job.instanceId]; rememberedJob(job.instanceId, null) }
      return null
    } finally { followers.delete(first.id) }
  })()
  followers.set(first.id, task)
  return task
}

async function recover(id: string): Promise<FreeResult | null> {
  const jobId = rememberedJob(id) || jobs[id]?.id
  if (!jobId) return null
  errors[id] = ''
  try { return await follow(await freeApi.job(jobId)) }
  catch (error) {
    errors[id] = error instanceof Error ? error.message : 'The operation could not be checked.'
    if (error instanceof FreeApiError && error.status === 404) { delete jobs[id]; rememberedJob(id, null) }
    return null
  }
}

async function run(instance: FreeInstance, command: FreeCommand, options: Pick<FreeRequest, 'chatId' | 'prompt' | 'name' | 'webSearch'> = {}): Promise<FreeResult | null> {
  if (busy(instance.id)) return null
  errors[instance.id] = ''
  const operation: FreeRequest = { ...options, instanceId: instance.id, provider: instance.provider, command, requestId: crypto.randomUUID() }
  rememberedJob(instance.id, operation.requestId)
  jobs[instance.id] = { id: operation.requestId, instanceId: instance.id, provider: instance.provider, command, state: 'running', phase: 'setup', startedAt: Date.now(), chatId: operation.chatId }
  try { return await follow(await freeApi.start(operation)) }
  catch (error) {
    errors[instance.id] = error instanceof Error ? error.message : 'Connection interrupted. Check the operation before sending again.'
    if (error instanceof FreeApiError) { delete jobs[instance.id]; rememberedJob(instance.id, null) }
    return null
  }
}

/** Removes the stored sign-in. Returns whether it worked; the reason lands in errors[instance.id]. */
async function logout(instance: FreeInstance): Promise<boolean> {
  if (busy(instance.id)) return false
  errors[instance.id] = ''
  try {
    const updated = await freeApi.logout(instance.id)
    const index = instances.value.findIndex(i => i.id === updated.id)
    if (index >= 0) instances.value.splice(index, 1, updated)
    return true
  } catch (error) {
    errors[instance.id] = error instanceof Error ? error.message : 'Could not log out. Try again.'
    // The server may still have finished (a timed-out request): show what it holds now.
    await snapshot().catch(() => {})
    return false
  }
}

function refreshFree(): Promise<void> {
  if (refreshing) return refreshing
  loading.value = true
  loadError.value = ''
  refreshing = (async () => {
    try {
      await snapshot()
      for (const instance of instances.value) {
        const running = jobs[instance.id]
        if (running?.state === 'running') void follow(running)
        else if (rememberedJob(instance.id)) void recover(instance.id)
        else if (!instance.checkedAt && !checked.has(instance.id)) {
          checked.add(instance.id)
          // Imported logins need a read-only check once; this never opens a browser.
          void run(instance, 'auth')
        }
      }
    } catch (error) { loadError.value = error instanceof Error ? error.message : 'Free instances could not be loaded.' }
    finally { loading.value = false; refreshing = null }
  })()
  return refreshing
}

export function useFreeInstances() {
  return { instances, threads, jobs, errors, loaded, loading, loadError, busy, run, logout, recover, refreshFree,
    activeCount: computed(() => threads.value.filter(t => t.status === 'running').length) }
}
