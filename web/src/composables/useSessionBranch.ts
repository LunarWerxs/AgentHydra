// "Copy up to here into a new chat" (owner, 2026-10-04): a Claude chat up to one reply, as a new chat
// beside it (server/src/session-branch.ts). The original is not touched; the branch opens at once.
import type { Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { SessionSummary } from '@/lib/api'
import * as api from '@/lib/api'

export function useSessionBranch(deps: {
  open: Ref<SessionSummary | null>
  refresh: () => Promise<void>
  select: (s: SessionSummary) => void
}) {
  const { t } = useI18n()
  async function branchFrom(uuid: string) {
    const from = deps.open.value
    if (!from || from.source !== 'claude') return
    try {
      const made = await api.branchSession(from.session_id, uuid, from.title, from.locator)
      deps.select(await api.getSession(made.session_id, 'claude'))
      toast.success(t('sessions.branched'))
      void deps.refresh()
    } catch {
      toast.error(t('sessions.branchFailed'))
    }
  }
  return { branchFrom }
}
