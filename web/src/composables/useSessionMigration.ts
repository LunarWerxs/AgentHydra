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
import { profileLabel, stillShownLine } from '@/lib/move-chats'

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
  /** A server profile path, named the way the migrate menu names its target. */
  const profileName = (profile: string) =>
    profileLabel(profile, migrateTargets.value, (x) => x.name)

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
          // Claude rows only: `instance` also carries a CODEX instance's name now, and a Codex
          // account that happens to share a name with a desktop folder must not mark that folder
          // as the chat's current home.
          isCurrent: s?.source === 'claude' && s.instance != null && s.instance === i.name,
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
      if (!r.ok) toast.error(r.error ?? t('sessions.migrateFailed'))
      else if (r.sourceStillShown?.length)
        // Landed, but an old account's app still lists it: say which and why, rather than a
        // success that leaves the chat visibly on two accounts.
        toast.warning(
          `${t('sessions.migrateStarted', { name: target.name })} ${t('sessions.migrateStillShown')} ${stillShownLine(r.sourceSettle, profileName) ?? ''}`,
        )
      else toast.success(t('sessions.migrateStarted', { name: target.name }))
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
    const landed: Array<{ sessionId: string; title: string }> = []
    const failed: string[] = []
    // Moved, but an old account's app still lists it (the server says which account and why).
    const stillShown: string[] = []
    try {
      // PASS ONE, every landing, one at a time on purpose: each migrate may stop a live process and
      // wait for it, and the desktop app takes imports serially anyway. Parallel calls would only
      // race its import lock. The old copies wait for pass two (deferSettle).
      for (const [i, s] of job.sessions.entries()) {
        toast.loading(t('sessions.migrateBulkProgress', { done: i + 1, n: job.sessions.length }), {
          id,
        })
        try {
          const r = await api.migrateSession(s.session_id, job.target.ref, {
            confirmTitle: s.title,
            deferSettle: true,
          })
          if (r.ok) landed.push({ sessionId: s.session_id, title: s.title })
          else failed.push(`${s.title}: ${r.error ?? 'failed'}`)
        } catch (e) {
          failed.push(`${s.title}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // PASS TWO, the old copies, with `leaving` naming exactly the chats that landed, so the
      // archive of one never stops a preview server that belongs to a chat that stayed
      // (server/src/move-source-settle.ts; the Instances batch runs the same two passes).
      const leaving = landed.map((c) => c.sessionId)
      for (const [i, c] of landed.entries()) {
        toast.loading(t('sessions.migrateBulkSettling', { done: i + 1, n: landed.length }), { id })
        try {
          const r = await api.settleMovedChat(c.sessionId, job.target.ref, leaving)
          const line = r.ok ? stillShownLine(r.sourceSettle, profileName) : (r.error ?? 'failed')
          if (line) stillShown.push(`${c.title} (${line})`)
        } catch (e) {
          stillShown.push(`${c.title} (${e instanceof Error ? e.message : String(e)})`)
        }
      }
    } finally {
      migrating.value = false
    }
    if (failed.length)
      console.warn('[agenthydra] bulk migrate: some chats could not be moved', failed)
    const ok = landed.length
    const summary = t('sessions.migrateBulkDone', {
      ok,
      n: job.sessions.length,
      name: job.target.name,
    })
    // Moved but still listed on an old account: a warning, never a plain tick.
    if (stillShown.length)
      console.warn(
        '[agenthydra] bulk migrate: moved, but still listed on the old account',
        stillShown,
      )
    const shownNote = stillShown.length
      ? ` ${t('sessions.migrateBulkStillShown', { n: stillShown.length })} ${stillShown[0] ?? ''}`
      : ''
    // Say WHY, not "see the console": the first refusal's own words, and an error rather than a
    // warning when nothing moved at all (sixteen 400s once read as a warning with a zero in it).
    if (failed.length)
      (ok === 0 ? toast.error : toast.warning)(
        `${summary} ${t('sessions.migrateBulkSomeFailed', { failed: failed.length })} ${failed[0] ?? ''}${shownNote}`,
        {
          id,
        },
      )
    else if (stillShown.length) toast.warning(`${summary}${shownNote}`, { id })
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
