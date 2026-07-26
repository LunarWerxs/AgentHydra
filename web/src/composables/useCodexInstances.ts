import { ref } from 'vue'
import type { CodexInstance } from '@/lib/api'
import * as api from '@/lib/api'

const instances = ref<CodexInstance[]>([])
const loading = ref(false)
const busyIds = ref(new Set<string>())
const lastError = ref<string | null>(null)

function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value)
  if (busy) next.add(id)
  else next.delete(id)
  busyIds.value = next
}

async function guard<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise
  } catch (error) {
    lastError.value = error instanceof Error ? error.message : String(error)
    return undefined
  }
}

async function refresh(opts: { silent?: boolean } = {}) {
  if (!opts.silent) loading.value = true
  const result = await guard(api.listCodexInstances())
  if (result) instances.value = result
  if (!opts.silent) loading.value = false
}

let pollTimer: number | null = null
function startPolling() {
  if (pollTimer !== null) return
  void refresh()
  pollTimer = window.setInterval(() => void refresh({ silent: true }), 5000)
}

function stopPolling() {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  pollTimer = null
}

async function create(name: string) {
  const result = await guard(api.createCodexInstance(name))
  if (result?.ok) await refresh({ silent: true })
  return result
}

async function withBusy(
  id: string,
  operation: () => Promise<api.CMActionResult>,
  refreshAfter = false,
) {
  setBusy(id, true)
  try {
    const result = await guard(operation())
    if (result?.ok && refreshAfter) await refresh({ silent: true })
    return result
  } finally {
    setBusy(id, false)
  }
}

const launchCli = (id: string) => withBusy(id, () => api.launchCodexInstance(id))
const login = (id: string) => withBusy(id, () => api.codexInstanceLogin(id), true)
const openDesktop = (id: string) => withBusy(id, () => api.openCodexDesktopInstance(id), true)
const focusDesktop = (id: string) => withBusy(id, () => api.focusCodexDesktopInstance(id))
const quitDesktop = (id: string) => withBusy(id, () => api.quitCodexDesktopInstance(id), true)
const rename = (id: string, name: string) =>
  withBusy(id, () => api.renameCodexInstance(id, name), true)
const remove = (id: string, confirmName: string) =>
  withBusy(id, () => api.deleteCodexInstance(id, confirmName), true)

export function useCodexInstances() {
  return {
    instances,
    loading,
    busyIds,
    lastError,
    refresh,
    startPolling,
    stopPolling,
    create,
    launchCli,
    login,
    openDesktop,
    focusDesktop,
    quitDesktop,
    rename,
    remove,
  }
}
