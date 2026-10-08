// useSessionRowStatus — a session row's live marks, model tag and hover text.
//
// Split out of SessionsView.vue (2026-10-08) when the view grew past 2,000 lines. The marks are read
// from the daemon's agent statuses and the row's queue entry, and the hover says the same facts in
// words, so the two live together.
import { Check, Hand, LoaderCircle } from '@lucide/vue'
import { type Component, computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionRowDisplay } from '@/composables/useSessionRowDisplay'
import type * as api from '@/lib/api'
import { modelName } from '@/lib/climayte-status'
import { baseName, queueStatusMeta, timeAgo } from '@/lib/format'

/** The row's live marks are bare icons, as CliMayte's list shows its status (icon-only): a row is
 *  one line, and full-text chips left the title no room at the sidebar's width. The label is the
 *  icon's hover and its screen-reader text. */
type StatusIcon = { icon: Component; tone: string; spin?: boolean }
const AGENT_STATUS_ICON: Record<api.AgentStatus['state'], StatusIcon> = {
  working: { icon: LoaderCircle, tone: 'text-primary', spin: true },
  blocked: { icon: Hand, tone: 'text-warning' },
  done: { icon: Check, tone: 'text-success' },
}
/** A queue status's colour, for the bare icon (the chip's variant, as CliMayteStatusBadge does). */
const QUEUE_ICON_TONE: Record<string, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
}
const queueIconTone = (status: api.QueueStatus) =>
  QUEUE_ICON_TONE[queueStatusMeta(status).variant ?? ''] ?? 'text-muted-foreground'
const AGENT_STATUS_LABEL: Record<api.AgentStatus['state'], string> = {
  working: 'sessions.agentStatusWorking',
  blocked: 'sessions.agentStatusBlocked',
  done: 'sessions.agentStatusDone',
}
/** The model and effort of the session's newest assistant turn, as CliMayte's rows say them
 *  (`Sonnet 5.5`); a row drops the tag when its summary has neither. */
const modelOf = (s: api.SessionSummary) => (s.model ? modelName(s.model) : null)
const effortOf = (s: api.SessionSummary) => s.effort ?? null

export function useSessionRowStatus({
  agentStatuses,
  instanceLabelFor,
}: {
  agentStatuses: Ref<api.AgentStatus[]>
  instanceLabelFor: (folder: string) => string
}) {
  const { t } = useI18n()
  const { titleOriginOf, rowSourceLabel, shapeTitleOf, copyWhyOf } = useSessionRowDisplay()

  // A live status (server/src/agent-status.ts) is shown exactly as the daemon wrote it; nothing here re-decides it. A row read back after a daemon
  // restart is not live, so it gets no badge rather than a confident one that may be hours stale.
  const liveStatusBySession = computed(() => {
    const m = new Map<string, api.AgentStatus>()
    for (const st of agentStatuses.value) if (!st.restoredUnconfirmed) m.set(st.sessionId, st)
    return m
  })
  const agentStatusOf = (s: api.SessionSummary) =>
    liveStatusBySession.value.get(s.session_id) ?? null
  /** Working right now: the hook says the agent is working, or its queue entry is a spinning status.
   *  The row shows it as a spinner; blocked, done and the other queue states stay marks. */
  const isLive = (s: api.SessionSummary) =>
    agentStatusOf(s)?.state === 'working' ||
    (!!s.queue_status && !!queueStatusMeta(s.queue_status).spin)

  /** The row's hover. A row is one line, as dense as a CliMayte task row (owner, 2026-10-03), so what
   *  its second line used to carry rides here, one fact per line, the way CliMayte's rowHint does. */
  function rowHintOf(s: api.SessionSummary): string {
    // Always said for a Claude session, even when the answer is "we don't know": Claude Desktop
    // wrote no record of which account ran it, and only saying so tells that apart from a gap.
    let account: string | null = null
    if (s.source === 'claude')
      account = s.instance
        ? s.instance === 'default'
          ? t('sessions.instanceDefault')
          : instanceLabelFor(s.instance)
        : t('sessions.instanceUnknown')
    else if (s.instance)
      account = s.instance_num ? `${s.instance} (#${s.instance_num})` : s.instance
    const lines = [
      s.title,
      titleOriginOf(s),
      s.git_branch
        ? t('sessions.rowHintFolderBranch', { folder: baseName(s.cwd), branch: s.git_branch })
        : t('sessions.rowHintFolder', { folder: baseName(s.cwd) }),
      t('sessions.rowHintActivity', { n: s.message_count, ago: timeAgo(s.last_activity_at) }),
      shapeTitleOf(s),
      t('sessions.rowHintSource', { source: rowSourceLabel(s) }),
    ]
    // the row's icons, said in words
    if (s.limit_stop?.pending) lines.push(t('sessions.rateLimitedBadgePending'))
    const live = agentStatusOf(s)
    if (live) lines.push(t(AGENT_STATUS_LABEL[live.state]))
    if (s.queue_status) lines.push(queueStatusMeta(s.queue_status).label)
    if (s.dispatched) lines.push(t('sessions.dispatched'))
    if (account) lines.push(t('sessions.rowHintAccount', { account }))
    if (s.source === 'claude' && !s.instance) lines.push(t('sessions.instanceUnknownHint'))
    if (s.copy_count > 1) lines.push(copyWhyOf(s))
    if (s.subagent_count > 0) lines.push(t('sessions.subagentsHint', { count: s.subagent_count }))
    if (s.offloads?.hswarm) lines.push(t('sessions.offloadsHswarm', s.offloads.hswarm))
    if (s.from_pc) lines.push(t('sessions.fromPc', { pc: s.from_pc }))
    if (s.offloads?.climayte) lines.push(t('sessions.offloadsClimayte', s.offloads.climayte))
    if (s.archived) lines.push(t('sessions.archived'))
    return lines.join('\n')
  }

  return {
    AGENT_STATUS_ICON,
    AGENT_STATUS_LABEL,
    queueIconTone,
    agentStatusOf,
    isLive,
    modelOf,
    effortOf,
    rowHintOf,
  }
}
