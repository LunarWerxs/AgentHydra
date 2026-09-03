// useSessionRowDisplay — the label/badge/tooltip text for one session row.
//
// Every function here answers the same shape of question — "what does this row's chip/tooltip
// say" — from a SessionSummary alone. Split out of SessionsView.vue because the list row and the
// open-transcript header both need the same answers, and neither one is the natural owner of the
// lookup tables behind them (session-labels.ts).
import { useI18n } from 'vue-i18n'
import type { SessionSource, SessionSummary } from '@/lib/api'
import { type SessionActivity, sessionActivity } from '@/lib/format'
import {
  ACTIVITY_CLASS,
  ACTIVITY_LABEL,
  ENDING_LABEL,
  SHAPE_LABEL,
  SOURCE_BADGE_CLASS,
  SOURCE_LABEL,
  TITLE_SOURCE_LABEL,
  TOOL_NAME,
} from '@/lib/session-labels'
import { type SessionShape, sessionShape } from '@/lib/session-shape'

export function useSessionRowDisplay() {
  const { t } = useI18n()

  const titleOriginOf = (s: SessionSummary) =>
    `${t('sessions.titleFrom')}: ${t(TITLE_SOURCE_LABEL[s.title_source], { tag: s.title_tag ?? '?' })}`
  /** Only the surprising origin earns a marker on the row. Everything else is explicable on sight
   *  and a badge on every row would be noise that hides the one case worth noticing. */
  const titleIsUnattributed = (s: SessionSummary) => s.title_source === 'envelope'
  /** Only ever rendered on a still-stopped session, so there is one wording rather than two. */
  const limitTooltipOf = (s: SessionSummary) =>
    s.limit_stop ? t('sessions.rateLimitedHint', { notice: s.limit_stop.notice }) : ''
  const sourceLabel = (source: SessionSource) => t(SOURCE_LABEL[source])

  const rowSourceLabel = (s: { source: SessionSource; tool?: string }) =>
    (s.tool && TOOL_NAME[s.tool]) || sourceLabel(s.source)
  const sourceBadgeClass = (source: SessionSource) => SOURCE_BADGE_CLASS[source]

  const shapeLabel = (shape: SessionShape) => t(SHAPE_LABEL[shape])
  /** "Marathon" is a size, and nothing on the row said so. Spell it out on hover. */
  const shapeTitleOf = (s: SessionSummary) =>
    `${t('sessions.shape')}: ${shapeLabel(sessionShape(s))} — ${t('sessions.shapeHint')}`

  const isLatestCopy = (s: SessionSummary) => s.copy_index >= s.copy_count
  const copyChipOf = (s: SessionSummary) => {
    const label = t('sessions.copyOf', { i: s.copy_index, n: s.copy_count })
    if (isLatestCopy(s) || !s.ended_because) return label
    return `${label} · ${t(ENDING_LABEL[s.ended_because])}`
  }
  const copyWhyOf = (s: SessionSummary) =>
    isLatestCopy(s) || !s.ended_because
      ? t('sessions.copyLatest', { i: s.copy_index, n: s.copy_count })
      : t('sessions.copyWhy', {
          i: s.copy_index,
          n: s.copy_count,
          why: t(ENDING_LABEL[s.ended_because]),
        })

  /** Working / idle / stale, from the same timestamp the list is already sorted by. A session we
   *  are actively running is 'working' regardless of the clock: the queue knows, so it does not
   *  have to be inferred from a file write that may be seconds away. */
  // Reads the clock at render time, exactly as timeAgo() beside it does: the list refetches every
  // 12 seconds, so the dot and the "3m ago" it sits next to always move together.
  const activityOf = (s: SessionSummary): SessionActivity =>
    s.queue_status === 'running' ? 'working' : sessionActivity(s.last_activity_at)

  return {
    titleOriginOf,
    titleIsUnattributed,
    limitTooltipOf,
    sourceLabel,
    rowSourceLabel,
    sourceBadgeClass,
    shapeLabel,
    shapeTitleOf,
    isLatestCopy,
    copyChipOf,
    copyWhyOf,
    activityOf,
    ACTIVITY_CLASS,
    ACTIVITY_LABEL,
  }
}
