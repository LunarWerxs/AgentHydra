// CLI instance data + actions, mirroring useInstances.ts's module-singleton shape (module
// scope refs + a `guard` helper that swallows failures into `lastError` instead of throwing
// across a component boundary). A "CLI instance" is a `CLAUDE_CONFIG_DIR` the daemon can
// launch a real `claude` process against, optionally associated with a dispatch account for
// usage checks and (later) auto-resume. See server/src/core/cli-instances.ts.
import { ref } from 'vue'
import type { CliInstance } from '@/lib/api'
import * as api from '@/lib/api'
import { reconcileList } from '@/lib/reconcile'
import { useUsage } from './useUsage'

const cliInstances = ref<CliInstance[]>([])
const loading = ref(false)
const busyIds = ref<Set<string>>(new Set())
const lastError = ref<string | null>(null)

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    lastError.value = e instanceof Error ? e.message : String(e)
    return undefined
  })
}

function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value)
  if (busy) next.add(id)
  else next.delete(id)
  busyIds.value = next
}

/** Reload the CLI instance list. `silent` (used by the background refresh) skips the
 *  `loading` toggle so the toolbar spinner only shows on a first load or a user refresh. */
async function refreshCliInstances(opts: { silent?: boolean } = {}) {
  if (!opts.silent) loading.value = true
  const r = await guard(api.listCliInstances())
  if (r) {
    // Unchanged rows keep their old objects, so a poll with nothing new redraws nothing.
    cliInstances.value = reconcileList(cliInstances.value, r, (i) => i.id)
    // Seed the shared usage cache from each instance's own last-known reading so the Usage
    // column has something to show before any on-demand check runs this session (an equal
    // snapshot is a no-op there).
    const { setSnapshot } = useUsage()
    for (const inst of r)
      if (inst.lastUsageCheck) setSnapshot(`cli:${inst.id}`, inst.lastUsageCheck)
  }
  if (!opts.silent) loading.value = false
}

/** The first load when a table opens; later refreshes are lib/warm-data.ts's. */
function startPolling() {
  void refreshCliInstances()
}

/** Create a new CLI instance (a fresh isolated `CLAUDE_CONFIG_DIR`). */
async function create(name: string): Promise<api.CMActionResult | undefined> {
  const result = await guard(api.createCliInstance(name))
  if (result?.ok) await refreshCliInstances()
  return result
}

/** Launch (spawn) a CLI instance's `claude` process in a terminal. */
async function launch(
  id: string,
  opts: { model?: string; effort?: string } = {},
): Promise<api.CMActionResult | undefined> {
  setBusy(id, true)
  try {
    const result = await guard(api.launchCliInstance(id, opts))
    if (result?.ok) await refreshCliInstances({ silent: true })
    return result
  } finally {
    setBusy(id, false)
  }
}

/** Open a terminal for the user to run `/login` themselves (the daemon never logs in on
 *  its own behalf). */
async function login(id: string): Promise<api.CMActionResult | undefined> {
  setBusy(id, true)
  try {
    return await guard(api.cliInstanceLogin(id))
  } finally {
    setBusy(id, false)
  }
}

/** Sign a CLI instance out (server/src/core/cli-logout.ts). */
async function logout(id: string): Promise<api.CMActionResult | undefined> {
  setBusy(id, true)
  try {
    const result = await guard(api.logoutCliInstance(id))
    if (result?.ok) await refreshCliInstances({ silent: true })
    return result
  } finally {
    setBusy(id, false)
  }
}

/** Rename a CLI instance's display name. */
async function rename(id: string, name: string): Promise<api.CMActionResult | undefined> {
  setBusy(id, true)
  try {
    const result = await guard(api.renameCliInstance(id, name))
    if (result?.ok) await refreshCliInstances({ silent: true })
    return result
  } finally {
    setBusy(id, false)
  }
}

/** Link (or unlink, passing `null`) the DESKTOP instance this CLI login belongs to. Same Anthropic
 *  account, two independent logins, so linking lets each serve as the other's usage-check fallback. */
async function linkDesktop(
  id: string,
  desktopDir: string | null,
): Promise<api.CMActionResult | undefined> {
  setBusy(id, true)
  try {
    const result = await guard(api.linkCliInstanceToDesktop(id, desktopDir))
    if (result?.ok) await refreshCliInstances({ silent: true })
    return result
  } finally {
    setBusy(id, false)
  }
}

/** Associate (or clear, passing `null`) the dispatch account this CLI instance checks
 *  usage against and (later) auto-resumes under. */
async function associate(
  id: string,
  accountId: string | null,
  accountLabel?: string | null,
): Promise<api.CMActionResult | undefined> {
  setBusy(id, true)
  try {
    const result = await guard(api.associateCliInstance(id, accountId, accountLabel))
    if (result?.ok) await refreshCliInstances({ silent: true })
    return result
  } finally {
    setBusy(id, false)
  }
}

/** Delete a CLI instance (guarded server-side; confirmName must match exactly). */
async function remove(id: string, confirmName: string): Promise<api.CMActionResult | undefined> {
  setBusy(id, true)
  try {
    const result = await guard(api.deleteCliInstance(id, confirmName))
    if (result?.ok) await refreshCliInstances({ silent: true })
    return result
  } finally {
    setBusy(id, false)
  }
}

/** Check this CLI instance's usage. Delegates the actual probe to useUsage.checkCli (so the
 *  Usage badge/popover, which reads useUsage's cache, updates from the very same call
 *  instead of firing a second `claude` process), then refreshes the list so `lastUsageCheck`
 *  and this row's other fields stay in sync. `setBusy` here also greys out this row's other
 *  actions (rename/associate/delete) while a check is in flight. */
async function checkUsage(id: string): Promise<boolean> {
  setBusy(id, true)
  try {
    const ok = await useUsage().checkCli(id)
    if (ok) await refreshCliInstances({ silent: true })
    return ok
  } finally {
    setBusy(id, false)
  }
}

export function useCliInstances() {
  return {
    cliInstances,
    loading,
    busyIds,
    lastError,
    refreshCliInstances,
    startPolling,
    create,
    launch,
    login,
    logout,
    rename,
    associate,
    linkDesktop,
    remove,
    checkUsage,
  }
}
