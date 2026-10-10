// What the one instance table (components/InstanceTable.vue) and the one instance row
// (components/InstanceRow.vue) are fed: a list of column definitions, and one row model per instance.
// Desktop, CLI and Free are ONE table with kind toggles (owner, 2026-10-07), so the table draws the
// union of the shown kinds' columns. The rows differ only in the columns they fill, the row model
// they hand over and the menu items they slot in (owner, 2026-10-03: "identical code, just different
// content").

import type { TokenParts } from '@agenthydra/server/types'
import type { Component } from 'vue'
import type { SkeletonVariants } from '@/components/ui/skeleton/skeleton-variants'
import type { TableHeadVariants } from '@/components/ui/table/table-variants'
import AccountTokensCell from '@/components/AccountTokensCell.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import type { LogoProvider } from '@/components/ProviderLogo.vue'
import TokenWindowFlyout from '@/components/TokenWindowFlyout.vue'
import type { CMInstance, UsageSnapshot } from '@/lib/api'

export type InstanceTableKind = 'desktop' | 'cli' | 'free'

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
  // HSwarm provider columns
  | 'providerState'
  | 'providerName'
  | 'readyCount'
  | 'restingCount'
  | 'disabledCount'
  | 'keyCount'
  | 'enabled'
  // HSwarm key columns
  | 'keyMasked'
  | 'keyFingerprint'
  | 'keyPriority'
  | 'keyState'
  // HSwarm model columns
  | 'modelEnabled'
  | 'modelPriority'
  | 'modelName'
  | 'modelProvider'
  | 'modelKind'
  | 'modelPrice'
  | 'modelContext'

/** One column as the table draws it. The sort key is the column key. */
export interface InstanceColumn {
  key: InstanceColumnKey
  /** i18n key of the header text; '' for the status dot's bare glyph. */
  label: string
  /** i18n key of the InfoHint beside the header. */
  hint?: string
  sortable?: boolean
  /** The header's width and alignment (TableHead's variants); the width the table measured when no width is set. */
  head?: Pick<TableHeadVariants, 'width' | 'align'>
  /** The header's own hover (shown when tooltips are on). */
  title?: string
  /** This column's first-load skeleton block: its line and width (Skeleton's variants). */
  skeleton: Pick<SkeletonVariants, 'line' | 'width'>
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
    head: { width: '10' },
    title: 'instances.sortByStatus',
    skeleton: { line: 'dot' },
  },
  // Name is the one column that gives way: it takes whatever the others leave (w-full, and max-w-0
  // on its cells so a long name cannot force the table wider), never below min-w-36. Every other
  // column sits at its content's width, so a fixed width is never a floor under the name.
  {
    key: 'name',
    label: 'instances.colName',
    hint: 'instances.colNameHint',
    sortable: true,
    head: { width: 'grow' },
    skeleton: { line: 'title', width: '28' },
  },
  {
    key: 'configDir',
    label: 'cliInstances.colConfigDir',
    sortable: true,
    kinds: ['cli'],
    mode: 'process',
    skeleton: { line: 'text', width: '32' },
  },
  {
    key: 'pid',
    label: 'instances.colPid',
    sortable: true,
    kinds: ['desktop'],
    mode: 'process',
    skeleton: { line: 'text', width: '10' },
  },
  {
    key: 'uptime',
    label: 'instances.colUptime',
    sortable: true,
    kinds: ['desktop'],
    mode: 'process',
    skeleton: { line: 'text', width: '12' },
  },
  {
    key: 'memory',
    label: 'instances.colMemory',
    sortable: true,
    kinds: ['desktop'],
    mode: 'process',
    skeleton: { line: 'text', width: '14' },
  },
  // Each quota window is ONE cell: the % chip (the colour and the popover) and the reset bar.
  {
    key: 'session',
    label: 'instances.col5h',
    sortable: true,
    mode: 'quota',
    skeleton: { line: 'chip', width: '32' },
  },
  {
    key: 'weekly',
    label: 'instances.colWeek',
    sortable: true,
    mode: 'quota',
    skeleton: { line: 'chip', width: '32' },
  },
  // Process mode keeps the one weekly % chip.
  {
    key: 'usage',
    label: 'instances.colUsage',
    sortable: true,
    mode: 'process',
    skeleton: { line: 'chip', width: '14' },
  },
  // A Free web login has no plan to show: its provider is the logo before its number.
  {
    key: 'plan',
    label: 'instances.colPlan',
    sortable: true,
    kinds: ['desktop', 'cli'],
    skeleton: { line: 'chip', width: '14' },
  },
  {
    key: 'lastActive',
    label: 'instances.colLastActive',
    hint: 'instances.colLastActiveHint',
    sortable: true,
    skeleton: { line: 'text', width: '14' },
  },
  // What the account has run, from its own transcripts on this PC (a Free login's: estimated from the
  // text Desk sent and got back). ONE column for every kind (owner, 2026-10-07): the window flyout and
  // the per-account totals plug in here and nowhere else: `flyout` and `cell` below.
  {
    key: 'tokens',
    label: 'cliInstances.colTokens',
    sortable: true,
    flyout: TokenWindowFlyout,
    cell: AccountTokensCell,
    skeleton: { line: 'title', width: '12' },
  },
  { key: 'actions', label: 'instances.colActions', head: { align: 'end' }, skeleton: { line: 'button', width: '20' } },
]

/** The columns the shown kinds need, once each, in COLUMNS order, for the table's column mode. */
export function instanceColumns(
  kinds: InstanceTableKind | readonly InstanceTableKind[],
  opts: { usageMode: boolean },
): InstanceColumn[] {
  const shown = typeof kinds === 'string' ? [kinds] : kinds
  return COLUMNS.filter(
    (c) =>
      (!c.kinds || c.kinds.some((k) => shown.includes(k))) &&
      (!c.mode || (c.mode === 'quota') === opts.usageMode),
  ).map(({ kinds: _k, mode: _m, ...c }) => c)
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
 * The name cell's hover (owner, 2026-10-06: the address and the folder, since the row no longer
 * prints the account's handle). It leads with the address, or the full name when the row has none,
 * then the account's name when known, else the folder. The third line is the full name when the name
 * was cut, else the folder under an account's name, else the copy hint (the click copies the address,
 * so a row without one has nothing to hint).
 */
export function nameTooltipFor(
  name: {
    full: string
    shown: string
    email?: string | null
    /** The account's own name on Claude (a CLI login's `.claude.json`), shown under the address
     *  (owner, 2026-10-09: "the account name when I hover over it"); the folder moves down a line. */
    account?: string | null
    folder?: string
    copyHint: string
  },
  clipped: boolean,
): InstanceNameTooltip {
  const email = name.email?.trim() || null
  const account = name.account?.trim() || null
  // A cut name that is the address itself adds nothing to the label.
  const cutFull = (name.shown !== name.full || clipped) && !!email && name.full !== email
  return {
    label: email ?? name.full,
    description: account ?? (name.folder || undefined),
    detail: cutFull
      ? name.full
      : account
        ? name.folder || undefined
        : email
          ? name.copyHint
          : undefined,
  }
}

/** What one instance is, to the shared row. Each table builds one per instance it lists. */
export interface InstanceRowModel {
  id: string
  num: number
  /** The kind of instance this row is, for the Instances tab's deep links (desk-embed findInstanceRow). */
  kind?: InstanceTableKind
  /** Set aside by the filter: drawn faded, never disabled. */
  dimmed?: boolean
  /** The provider's mark before the number (the tables that mix providers). */
  provider?: LogoProvider
  status: { on: boolean; pulse?: boolean; title: string }
  glyph?: { dir: string; icon?: CMInstance['icon']; color?: CMInstance['color']; running: boolean }
  name: {
    shown: string
    tooltip: (clipped: boolean) => InstanceNameTooltip
    /** The account's full address: a click on the name copies it. No address, no click. */
    copy?: string | null
  }
  /** A small badge after the name (External, Default). */
  badge?: { label: string; title?: string }
  /** The account beside the name. The address is not printed (the name copies it, its hover shows
   *  it): `note` is a state said instead when there is no address ("Logged out", "API key"), and
   *  `stale` marks a login the live check could not confirm. */
  account: { note?: string | null; stale?: boolean }
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
  /** Said in the quota cells instead of the dash, when there is no window by design ("Unlimited"). */
  noQuotaLabel?: string
  plan?: { label: string; plain?: boolean; title?: string } | null
  /** The Last active cell: "Now" while running, else how long ago. */
  lastRunning?: { label: string; running: boolean; title?: string } | null
  /** The account's tokens for the span the table's switch has chosen; null when not known. */
  tokens?: TokenParts | null
  /** The Tokens hover's second and third lines, for figures that are not a transcript's (a Free login's estimate). */
  tokensNote?: { breakdown: string; source: string }
  /** CliMayte workers on this account from the other PC right now: shown beside the tokens, not in them. */
  remoteWorkers?: number
  /** The ⋯ menu: its header's icon actions and its width. Its items come in the `menu` slot. */
  menu?: { name: string; actions: MenuIconAction[]; width?: 'sm' | 'md' | 'lg' }
}
