// session-labels.ts — the i18n KEYS for every session badge/filter value, plus the small
// non-translated lookup tables (tool display names, badge classes) that sit beside them.
//
// Pure data: no `t()` call lives here, so nothing in this file needs the i18n instance and
// nothing here reflows when the active locale changes. Split out of SessionsView.vue because
// these maps are looked up from both the filter-menu labels and the per-row badges, and neither
// of those is the map's owner.
import type {
  ArchivedScope,
  DispatchedScope,
  RateLimitScope,
  SessionEnding,
  SessionPeriod,
  SessionSource,
  SessionSourceScope,
  TitleSource,
} from '@/lib/api'
import type { SessionActivity } from '@/lib/format'
import type { ShapeScope } from '@/lib/session-shape'

export const SOURCE_LABEL: Record<SessionSourceScope, string> = {
  all: 'sessions.sourceAll',
  claude: 'sessions.sourceClaude',
  codex: 'sessions.sourceCodex',
  opencode: 'sessions.sourceOpenCode',
  hermes: 'sessions.sourceHermes',
  foreign: 'sessions.sourceOther',
}

export const RATE_LIMIT_LABEL: Record<RateLimitScope, string> = {
  all: 'sessions.rateLimitedAll',
  only: 'sessions.rateLimitedOnly',
  pending: 'sessions.rateLimitedPending',
}

/**
 * Why this row is called what it is called.
 *
 * A title has four possible origins and only one of them is a name a person chose, so a title
 * nobody recognises is otherwise a dead end — which is exactly what happened when threads started
 * showing up named "Watcher" and no account, instance or project was called that. The awkward case
 * is 'envelope': the first message arrived wrapped in a pseudo-tag carrying a name attribute, and
 * that name became the title, so the string was chosen by whatever wrote the wrapper (a scheduler,
 * a hook, a harness) and may match nothing the user has ever named.
 */
export const TITLE_SOURCE_LABEL: Record<TitleSource, string> = {
  custom: 'sessions.titleFromCustom',
  ai: 'sessions.titleFromAi',
  store: 'sessions.titleFromStore',
  envelope: 'sessions.titleFromEnvelope',
  message: 'sessions.titleFromMessage',
  id: 'sessions.titleFromId',
}

/**
 * The badge text for one row.
 *
 * `source` names the READER, and the fourth one covers five different products, so a row from Grok
 * and a row from Zed would both read "Other". The tool name is what the user recognises, so it wins
 * wherever the session carries one.
 */
export const TOOL_NAME: Record<string, string> = {
  'claude-code': 'Claude',
  openclaude: 'OpenClaude',
  cowork: 'Cowork',
  codex: 'Codex',
  traex: 'TraeX',
  opencode: 'OpenCode',
  kilo: 'Kilo',
  mimocode: 'MiMo',
  icodemate: 'IcodeMate',
  hermes: 'Hermes',
  grok: 'Grok',
  kimi: 'Kimi',
  zed: 'Zed',
  copilot: 'Copilot CLI',
  'vscode-copilot': 'VS Code Copilot',
}

export const SOURCE_BADGE_CLASS: Record<SessionSource, string> = {
  claude: 'border-[#D97757]/40 bg-[#D97757]/10 text-[#B85D3D] dark:text-[#E9A287]',
  codex: 'border-[#10A37F]/40 bg-[#10A37F]/10 text-[#087D62] dark:text-[#65D4B3]',
  opencode: 'border-[#5B6EF5]/40 bg-[#5B6EF5]/10 text-[#4053D6] dark:text-[#9AA6FF]',
  hermes: 'border-[#F5A623]/40 bg-[#F5A623]/10 text-[#B4750E] dark:text-[#F5C067]',
  // Neutral on purpose: five products share this reader, so a single hue would imply one identity.
  foreign: 'border-border bg-muted text-muted-foreground',
}

export const ARCHIVED_LABEL: Record<ArchivedScope, string> = {
  hide: 'sessions.archivedHide',
  include: 'sessions.archivedInclude',
  only: 'sessions.archivedOnly',
}

export const PERIOD_LABEL: Record<SessionPeriod, string> = {
  '24h': 'sessions.period24h',
  '7d': 'sessions.period7d',
  '30d': 'sessions.period30d',
  all: 'sessions.periodAll',
}

export const DISPATCHED_LABEL: Record<DispatchedScope, string> = {
  all: 'sessions.dispatchedAll',
  queued: 'sessions.dispatchedQueued',
  manual: 'sessions.dispatchedManual',
}

export const SHAPE_LABEL: Record<ShapeScope, string> = {
  all: 'sessions.shapeAll',
  quick: 'sessions.shapeQuick',
  standard: 'sessions.shapeStandard',
  deep: 'sessions.shapeDeep',
  marathon: 'sessions.shapeMarathon',
  automation: 'sessions.shapeAutomation',
}

/**
 * The "part 1 of 2" chip, carrying WHY there is more than one.
 *
 * The reason is on the row rather than only in the tooltip because the question this answers —
 * "why is this conversation here twice?" — is asked by looking, not by hovering. A part that was
 * superseded names what ended it; the newest part has nothing to explain, so it stays short.
 */
export const ENDING_LABEL: Record<SessionEnding, string> = {
  interrupted: 'sessions.endedInterrupted',
  'usage-limit': 'sessions.endedUsageLimit',
  overload: 'sessions.endedOverload',
  refused: 'sessions.endedRefused',
  error: 'sessions.endedError',
  complete: 'sessions.endedComplete',
}

export const ACTIVITY_CLASS: Record<SessionActivity, string> = {
  working: 'bg-success',
  idle: 'bg-warning',
  stale: 'bg-muted-foreground/40',
}

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  working: 'sessions.activityWorking',
  idle: 'sessions.activityIdle',
  stale: 'sessions.activityStale',
}
