// useSessionMigration — moving a chat (or several, checked in bulk) to another Claude Desktop
// account. Split out of SessionsView.vue because this is one self-contained feature end to end:
// the target list, the single-session move, and the confirm-then-move-several flow all share the
// same MigrateTarget shape and the same server call.
//
// The flyout lists EVERY desktop instance, in two groups. A running one is a legal landing spot as
// it stands. A closed one is shown too - hiding them made "why isn't mine here" a daily question -
// but the server refuses to import into a closed instance, because the import spawn would BOOT it
// and the rule is that nothing opens an account on its own. So a closed target reads "start it and
// move there": a deliberate click opens the instance the ordinary way, we wait for it to come up,
// and only then migrate. Loaded lazily when a menu opens; the session's own instance is disabled
// rather than hidden.

import type { ComputedRef } from 'vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { SessionSummary } from '@/lib/api'
import * as api from '@/lib/api'
import { displayName } from '@/lib/instance-appearance'

export interface MigrateTarget {
  ref: string
  dir: string
  name: string
  account: string | null
  isCurrent: boolean
  isRunning: boolean
}

export function useSessionMigration(deps: {
  checkedSessions: ComputedRef<SessionSummary[]>
  clearChecked: () => void
}) {
  const { t } = useI18n()
  const migrateTargets = ref<MigrateTarget[]>([])
  const runningTargets = computed(() => migrateTargets.value.filter((x) => x.isRunning))
  const closedTargets = computed(() => migrateTargets.value.filter((x) => !x.isRunning))
  const migrating = ref(false)

  /** `s` is the session the menu is FOR, so its own instance can be marked; null for a bulk menu,
   *  where the checked sessions may span several instances and none is "current". */
  async function loadMigrateTargets(s: SessionSummary | null) {
    try {
      const [instances, cache] = await Promise.all([api.listInstances(), api.getUsageCache()])
      migrateTargets.value = instances.map((i) => {
        const ref = `desktop:${i.dir}`
        const snap = cache.cache[ref.toLowerCase()] ?? cache.cache[ref]
        return {
          ref,
          dir: i.dir,
          // The name the Instances table shows (label, else account name, else folder), not the
          // folder name a row's label happened to fall through to.
          name: displayName(i),
          account: snap?.account ?? null,
          isCurrent: s?.instance != null && s.instance === i.name,
          isRunning: i.isRunning,
        }
      })
    } catch {
      migrateTargets.value = []
    }
  }

  // A closed target is NOT started. The server lands the chat straight in that instance's store,
  // settings intact, and the app finds it there when it next starts - the one landing where "what
  // it was set to" survives without a restart. Starting the app first was the old workaround for
  // the server refusing closed targets, and it is gone with the refusal.
  async function migrateTo(s: SessionSummary, target: MigrateTarget) {
    migrating.value = true
    try {
      // The row's title IS the current title (same listing the server reads), restated as required.
      const r = await api.migrateSession(s.session_id, target.ref, { confirmTitle: s.title })
      if (r.ok) toast.success(t('sessions.migrateStarted', { name: target.name }))
      else toast.error(r.error ?? t('sessions.migrateFailed'))
    } catch {
      toast.error(t('sessions.migrateFailed'))
    } finally {
      migrating.value = false
    }
  }

  // Confirm before a bulk move: it stops live runs and archives rows across several accounts, and
  // "I right-clicked the wrong one" is not a mistake this should let through in one click.
  const bulkConfirm = ref<{ target: MigrateTarget; sessions: SessionSummary[] } | null>(null)
  function askBulkMigrate(target: MigrateTarget) {
    // Done-marked rows are already handed off or migrated; the server refuses them as superseded,
    // so leaving them in would only turn one confirmation into a column of error toasts.
    const sessions = deps.checkedSessions.value.filter((s) => s.source === 'claude' && !s.done)
    bulkConfirm.value = { target, sessions }
  }
  async function runBulkMigrate() {
    const job = bulkConfirm.value
    if (!job) return
    bulkConfirm.value = null
    migrating.value = true
    const id = `bulk-migrate-${job.target.ref}`
    let ok = 0
    const failed: string[] = []
    try {
      // One at a time on purpose: each migrate may stop a live process and wait for it, and the
      // desktop app takes imports serially anyway. Parallel calls would only race its import lock.
      for (const [i, s] of job.sessions.entries()) {
        toast.loading(t('sessions.migrateBulkProgress', { done: i + 1, n: job.sessions.length }), {
          id,
        })
        try {
          const r = await api.migrateSession(s.session_id, job.target.ref, {
            confirmTitle: s.title,
          })
          if (r.ok) ok++
          else failed.push(`${s.title}: ${r.error ?? 'failed'}`)
        } catch (e) {
          failed.push(`${s.title}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } finally {
      migrating.value = false
    }
    if (failed.length)
      console.warn('[agenthydra] bulk migrate: some chats could not be moved', failed)
    const summary = t('sessions.migrateBulkDone', {
      ok,
      n: job.sessions.length,
      name: job.target.name,
    })
    // Say WHY, not "see the console": the first refusal's own words, and an error rather than a
    // warning when nothing moved at all (sixteen 400s once read as a warning with a zero in it).
    if (failed.length)
      (ok === 0 ? toast.error : toast.warning)(
        `${summary} ${t('sessions.migrateBulkSomeFailed', { failed: failed.length })} ${failed[0] ?? ''}`,
        {
          id,
        },
      )
    else toast.success(summary, { id })
    deps.clearChecked()
  }

  return {
    migrateTargets,
    runningTargets,
    closedTargets,
    migrating,
    loadMigrateTargets,
    migrateTo,
    bulkConfirm,
    askBulkMigrate,
    runBulkMigrate,
  }
}
