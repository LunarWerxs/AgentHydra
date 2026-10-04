// What the one instance table (components/InstanceTable.vue) and the one instance row
// (components/InstanceRow.vue) are fed: a list of column definitions per table, and one row model
// per instance. The Claude desktop, Claude CLI, Codex and DeepSeek tables differ only in the columns
// they list, the rows they hand over and the menu items they slot in (owner, 2026-10-03: "identical
// code, just different content").

import type { TokenParts } from '@agenthydra/server/types'
import type { Component } from 'vue'
import AccountTokensCell from '@/components/AccountTokensCell.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import type { Provider } from '@/components/ProviderLogo.vue'
import TokenWindowFlyout from '@/components/TokenWindowFlyout.vue'
import type { BadgeVariants } from '@/components/ui/badge'
import type { CMInstance, UsageSnapshot } from '@/lib/api'

export type InstanceTableKind = 'desktop' | 'cli'

export type InstanceColumnKey =
  | 'status'
  | 'name'
  | 'configDir'
  | 'pid'
  | 'uptime'
  | 'memory'
  | 'session'
  | 'weekly'
  | 'usage'
  | 'plan'
  | 'lastActive'
  | 'tokens'
  | 'actions'

/** One column as the table draws it. The sort key is the column key. */
export interface InstanceColumn {
  key: InstanceColumnKey
  /** i18n key of the header text; '' for the status dot's bare glyph. */
  label: string
  /** i18n key of the InfoHint beside the header. */
  hint?: string
  sortable?: boolean
  headClass?: string
  /** The header's own hover (shown when tooltips are on). */
  title?: string
  /** Classes of this column's first-load skeleton block. */
  skeleton: string
  /** Wraps the sort button: opens a hover flyout under the header text (the tokens window choice
   *  plugs in here). Receives `flyoutProps`; the sort button is its default slot. */
  flyout?: Component
  flyoutProps?: Record<string, unknown>
  /** Replaces the built-in cell; receives `{ row: InstanceRowModel }`. */
  cell?: Component
}

interface ColumnDef extends Omit<InstanceColumn, 'label'> {
  label: string
  /** Which tables carry the column; every table when omitted. */
  kinds?: InstanceTableKind[]
  /** Only in process (default) or quota (usage) mode; both when omitted. */
  mode?: 'process' | 'quota'
}

// One list, in the order every table draws it. Columns that mean the same thing are ONE column with
// ONE name; a column a single kind has lists only that kind.
const COLUMNS: ColumnDef[] = [
  {
    key: 'status',
    label: '',
    sortable: true,
    headClass: 'w-10',
    title: 'instances.sortByStatus',
    skeleton: 'size-2',
  },
  // Name is the one column that gives way: it takes whatever the others leave (w-full, and max-w-0
  // on its cells so a long name cannot force the table wider), never below min-w-36. Every other
  // column sits at its content's width, so a fixed width is never a floor under the name.
  {
    key: 'name',
    label: 'instances.colName',
    hint: 'instances.colNameHint',
    sortable: true,
    headClass: 'w-full min-w-36',
    skeleton: 'h-4 w-28',
  },
  {
    key: 'configDir',
    label: 'cliInstances.colConfigDir',
    sortable: true,
    kinds: ['cli'],
    mode: 'process',
    skeleton: 'h-3 w-32',
  },
  {
    key: 'pid',
    label: 'instances.colPid',
    sortable: true,
    kinds: ['desktop'],
    mode: 'process',
    skeleton: 'h-3 w-10',
  },
  {
    key: 'uptime',
    label: 'instances.colUptime',
    sortable: true,
    kinds: ['desktop'],
    mode: 'process',
    skeleton: 'h-3 w-12',
  },
  {
    key: 'memory',
    label: 'instances.colMemory',
    sortable: true,
    kinds: ['desktop'],
    mode: 'process',
    skeleton: 'h-3 w-14',
  },
  // Each quota window is ONE cell: the % chip (the colour and the popover) and the reset bar.
  {
    key: 'session',
    label: 'instances.col5h',
    sortable: true,
    mode: 'quota',
    skeleton: 'h-5 w-32',
  },
  {
    key: 'weekly',
    label: 'instances.colWeek',
    sortable: true,
    mode: 'quota',
    skeleton: 'h-5 w-32',
  },
  // Process mode keeps the one weekly % chip.
  {
    key: 'usage',
    label: 'instances.colUsage',
    sortable: true,
    mode: 'process',
    skeleton: 'h-5 w-14',
  },
  { key: 'plan', label: 'instances.colPlan', sortable: true, skeleton: 'h-5 w-14' },
  {
    key: 'lastActive',
    label: 'instances.colLastActive',
    hint: 'instances.colLastActiveHint',
    sortable: true,
    skeleton: 'h-3 w-14',
  },
  // What the account has run, from its own transcripts on this PC. The window flyout and the
  // per-account totals plug in here and nowhere else: `flyout` and `cell` below.
  ...(['cli', 'desktop'] as const).map(
    (kind): ColumnDef => ({
      key: 'tokens',
      label: 'cliInstances.colTokens',
      sortable: true,
      kinds: [kind],
      flyout: TokenWindowFlyout,
      flyoutProps: { kind },
      cell: AccountTokensCell,
      skeleton: 'h-4 w-12',
    }),
  ),
  { key: 'actions', label: 'instances.colActions', headClass: 'text-end', skeleton: 'h-6 w-20' },
]

/** The columns one table draws, in order, for the tab's column mode. */
export function instanceColumns(
  kind: InstanceTableKind,
  opts: { usageMode: boolean },
): InstanceColumn[] {
  return COLUMNS.filter(
    (c) =>
      (!c.kinds || c.kinds.includes(kind)) && (!c.mode || (c.mode === 'quota') === opts.usageMode),
  ).map(({ kinds: _k, mode: _m, ...c }) => c)
}

/** The Name cell's second line: the signed-in account, as the email handle (the address is the hover). */
export function accountLine(
  account: InstanceRowModel['account'],
  name: string,
): { text: string; title?: string } | null {
  const email = account.email?.trim() || null
  const text = email?.split('@')[0]?.trim() || account.fallback?.trim() || account.empty || null
  // A CLI row is named after its account: say it once.
  if (!text || text === name.trim() || (email && email === name.trim())) return null
  return { text, title: email ?? undefined }
}

/** A CLI login is named "<email> (<plan>)" by quick add; the plan has its own column. */
export function withoutPlanSuffix(name: string, plan: string | null | undefined): string {
  const t = name.trim()
  const suffix = plan ? ` (${plan})`.toLowerCase() : ''
  return suffix && t.toLowerCase().endsWith(suffix) ? t.slice(0, -suffix.length).trimEnd() : t
}

export interface InstanceNameTooltip {
  label: string
  description?: string
  detail?: string
}

/**
 * The name cell's hover. Three facts compete for two lines, so the cut decides the order: a name
 * that fits keeps the folder on top and the hint under it; a name that was cut leads with the full
 * name and pushes the other two down a line each.
 */
export function nameTooltipFor(
  name: { full: string; shown: string; folder: string; hint?: string },
  clipped: boolean,
): InstanceNameTooltip {
  return name.shown === name.full && !clipped
    ? { label: name.folder, description: name.hint }
    : { label: name.full, description: name.folder, detail: name.hint }
}

/** What one instance is, to the shared row. Each table builds one per instance it lists. */
export interface InstanceRowModel {
  id: string
  num: number
  /** Set aside by the filter: drawn faded, never disabled. */
  dimmed?: boolean
  /** The provider's mark before the number (the tables that mix providers). */
  provider?: Provider
  status: { on: boolean; pulse?: boolean; title: string }
  glyph?: { dir: string; icon?: CMInstance['icon']; color?: CMInstance['color']; running: boolean }
  name: {
    shown: string
    tooltip: (clipped: boolean) => InstanceNameTooltip
    /** A running instance's name focuses its window. */
    onClick?: () => void
    busy?: boolean
  }
  /** A small badge after the name (External, Default). */
  badge?: { label: string; title?: string }
  account: {
    email?: string | null
    profile?: string | null
    fallback?: string | null
    variant?: BadgeVariants['variant']
    /** Said when there is neither an address nor a fallback; a dash when omitted. */
    empty?: string
  }
  configDir?: string
  pid?: number | null
  uptime?: string | null
  memory?: string | null
  /** Quota. Without it the quota cells say `noQuota` (a pay-as-you-go row has no window). */
  usage?: {
    snapshot: UsageSnapshot | null | undefined
    checking: boolean
    key: string
    onCheck: () => void
  }
  noQuota?: string
  plan?: { label: string; plain?: boolean; title?: string } | null
  /** The Last active cell: "Now" while running, else how long ago. */
  lastRunning?: { label: string; running: boolean; title?: string } | null
  /** The account's tokens for the span the table's switch has chosen; null when not known. */
  tokens?: TokenParts | null
  /** The ⋯ menu: its header's icon actions and its width. Its items come in the `menu` slot. */
  menu?: { name: string; actions: MenuIconAction[]; class?: string }
}
