import { computed, reactive, ref, shallowRef } from 'vue'
import type { FreeCommand, FreeInstance, FreeJob, FreeRequest, FreeResult, FreeThread, FreeTokens } from '@desk/shared/free-instances'
import { FreeApiError, freeApi, freeErrorText, isTimeout, rememberedJob } from '@/lib/free-instances'

// One copy survives tab changes. Only request UUIDs go into browser storage.
const instances = ref<FreeInstance[]>([])
const threads = ref<FreeThread[]>([])
/** Each account's token estimate by its id (server/src/free-instances/tokens.ts). */
const tokens = shallowRef<Record<string, FreeTokens>>({})
const jobs = reactive<Record<string, FreeJob | undefined>>({})
const errors = reactive<Record<string, string>>({})
const loaded = ref(false)
const loading = ref(false)
const loadError = ref('')
const followers = new Map<string, Promise<FreeResult | null>>()
let refreshing: Promise<void> | null = null

const busy = (id: string) => jobs[id]?.state === 'running'

/** The new list, keeping each unchanged item's own object: a row redraws only when its account changed. */
function keepUnchanged<T extends { id: string }>(old: T[], next: T[]): T[] {
  const before = new Map(old.map(x => [x.id, x]))
  let same = old.length === next.length
  const merged = next.map((x, n) => {
    const o = before.get(x.id)
    const keep = !!o && JSON.stringify(o) === JSON.stringify(x)
    if (!keep || old[n] !== o) same = false
    return keep ? o! : x
  })
  return same ? old : merged
}

async function snapshot(): Promise<void> {
  const [status, list] = await Promise.all([freeApi.status(), freeApi.threads()])
  instances.value = keepUnchanged(instances.value, status.instances)
  threads.value = keepUnchanged(threads.value, list)
  const estimate = status.tokens ?? {}
  if (JSON.stringify(estimate) !== JSON.stringify(tokens.value)) tokens.value = estimate
  // Desk's own reads (the rolling refresh, a keepalive nudge) show no spinner: only what someone started does.
  for (const job of status.jobs) if (job.state === 'running' && !job.auto) jobs[job.instanceId] = job
  loaded.value = true
}

/** One read of a job, asked again while Desk is too busy to answer in time: a read changes nothing, and the job runs on
 *  either way (2026-10-08: one slow read ended a check as "signal timed out" while the login was fine). */
async function readJob(id: string): Promise<FreeJob> {
  for (let tries = 1; ; tries++) {
    try { return await freeApi.job(id) }
    catch (error) { if (!isTimeout(error) || tries >= 4) throw error }
  }
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
        job = await readJob(job.id)
        jobs[job.instanceId] = job
      }
      rememberedJob(job.instanceId, null)
      if (!job.result?.ok) errors[job.instanceId] = job.result?.error?.message || 'The operation did not complete. Read the chat before sending again.'
      // The job's own result stands: a list refresh that fails after it is no reason to call a finished check
      // interrupted (owner, 2026-10-07: an account showed a warning, then was fine on the next check).
      await snapshot().catch(() => {})
      return job.result ?? null
    } catch (error) {
      errors[job.instanceId] = freeErrorText(error, 'Connection interrupted. Check the operation before sending again.')
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
  try { return await follow(await readJob(jobId)) }
  catch (error) {
    errors[id] = freeErrorText(error, 'The operation could not be checked.')
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
    // A start that timed out may have begun all the same: its request UUID finds it with a read, never a second POST.
    const started = isTimeout(error) ? await readJob(operation.requestId).catch(() => null) : null
    if (started) return follow(started)
    errors[instance.id] = freeErrorText(error, 'Connection interrupted. Check the operation before sending again.')
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
    errors[instance.id] = freeErrorText(error, 'Could not log out. Try again.')
    // The server may still have finished (a timed-out request): show what it holds now.
    await snapshot().catch(() => {})
    return false
  }
}

/** Deletes the account here and, through the login sync, on the owner's other PCs. Returns whether it
 *  worked; the reason lands in errors[instance.id]. */
async function remove(instance: FreeInstance): Promise<boolean> {
  if (busy(instance.id)) return false
  errors[instance.id] = ''
  try {
    await freeApi.remove(instance.id)
    instances.value = instances.value.filter(i => i.id !== instance.id)
    threads.value = threads.value.filter(t => t.instanceId !== instance.id)
    return true
  } catch (error) {
    errors[instance.id] = freeErrorText(error, 'Could not delete. Try again.')
    // The server may still have finished (a timed-out request): show what it holds now.
    await snapshot().catch(() => {})
    return false
  }
}

/** Takes one thread off Desk's list (the site keeps nothing of a private chat). Returns whether it worked; the reason
 *  lands in errors[thread.instanceId]. A thread the server no longer has leaves the list too. */
async function forgetThread(thread: FreeThread): Promise<boolean> {
  errors[thread.instanceId] = ''
  try {
    await freeApi.forgetThread(thread.id)
  } catch (error) {
    if (!(error instanceof FreeApiError && error.status === 404)) {
      errors[thread.instanceId] = freeErrorText(error, 'Could not forget this chat. Try again.')
      return false
    }
  }
  threads.value = threads.value.filter(t => t.id !== thread.id)
  return true
}

/**
 * Reads the list again; `silent` (the warm loop, opening the tab) shows no spinner. Desk keeps every reading current
 * itself, one account a minute (server/src/free-instances/refresh.ts), so opening the tab starts nothing and the rows
 * show only what changed (owner, 2026-10-06: "the five-hour and week things keep spinning every time I view the
 * page. They're supposed to refresh on a rolling refresh and only display changes like on the others").
 */
function refreshFree(opts: { silent?: boolean } = {}): Promise<void> {
  if (refreshing) return refreshing
  if (!opts.silent) loading.value = true
  loadError.value = ''
  refreshing = (async () => {
    try {
      await snapshot()
      for (const instance of instances.value) {
        const running = jobs[instance.id]
        if (running?.state === 'running') void follow(running)
        else if (rememberedJob(instance.id)) void recover(instance.id)
      }
    } catch (error) { loadError.value = freeErrorText(error, 'Free instances could not be loaded.') }
    finally { loading.value = false; refreshing = null }
  })()
  return refreshing
}

export function useFreeInstances() {
  return { instances, threads, tokens, jobs, errors, loaded, loading, loadError, busy, run, logout, remove, forgetThread, recover, refreshFree,
    activeCount: computed(() => threads.value.filter(t => t.status === 'running').length) }
}
