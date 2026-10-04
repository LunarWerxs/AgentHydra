// Auto-resume monitor settings + live status, a small singleton (mirrors useData.ts's
// shape). No polling loop; Settings loads it on mount and refreshes after each mutation.
// The monitor itself runs server-side on its own schedule (see server/src/monitor.ts).
import { ref } from 'vue'
import type { MonitorSettings, MonitorStatusRow, MonitorView } from '@/lib/api'
import * as api from '@/lib/api'

const settings = ref<MonitorSettings | null>(null)
const status = ref<MonitorStatusRow[]>([])
const accounts = ref<Record<string, boolean>>({})
const loading = ref(false)
const lastError = ref<string | null>(null)

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    lastError.value = e instanceof Error ? e.message : String(e)
    return undefined
  })
}

function absorb(view: MonitorView) {
  settings.value = view.settings
  status.value = view.status
  accounts.value = view.accounts
}

async function refreshMonitor(): Promise<void> {
  loading.value = true
  const r = await guard(api.getMonitor())
  if (r) absorb(r)
  loading.value = false
}

async function updateMonitor(patch: Partial<MonitorSettings>): Promise<boolean> {
  const r = await guard(api.updateMonitor(patch))
  if (r) absorb(r)
  return !!r
}

async function setMonitorAccount(accountId: string, enabled: boolean): Promise<boolean> {
  const r = await guard(api.setMonitorAccount(accountId, enabled))
  if (r) absorb(r)
  return !!r
}

/** Force one monitor pass now (manual "check for resumable stops"). */
async function runMonitorCheck(): Promise<boolean> {
  const r = await guard(api.runMonitorCheck())
  if (r) absorb(r)
  return r?.ok ?? false
}

export function useMonitor() {
  return {
    settings,
    status,
    accounts,
    loading,
    lastError,
    refreshMonitor,
    updateMonitor,
    setMonitorAccount,
    runMonitorCheck,
  }
}
