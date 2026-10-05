// What the session header says, worked out from AgentHydra's answers (ah.ts): the same wording and
// rules as AgentHydra's Sessions tab (hydra/src/components/SessionsView.vue and its composables), which
// Desk 2's header replaces. Pure, so the window and the tests share it.
import type { TranscriptItem } from '@shared/protocol'

/** AgentHydra's SessionSummary, the fields the header reads (server/src/types.ts). */
export interface AhSessionRow {
  session_id: string
  source: string
  tool?: string
  locator?: string
  title: string
  cwd: string
  git_branch?: string | null
  message_count: number
  last_activity_at: number
  instance: string | null
  /** 'cli:<id>', 'codex:<id>' or 'desktop:<dir>' where the row's own store names its instance; null for a Claude Desktop row. */
  instance_ref?: string | null
  instance_num?: number | null
  model?: string | null
  effort?: string | null
}

/** AgentHydra's SessionUsage (GET /api/sessions/:id/usage). */
export interface AhUsage {
  status: string
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; total: number; turns: number }
  costUsd: number | null
  unpricedModels: string[]
  pricesAsOf: string
}

/** AgentHydra's SessionSecretScan: redacted always; the daemon has no way to reveal one. */
export interface AhSecrets {
  count: number
  findings: { kind: string; redacted: string; turn: number }[]
  truncated: boolean
}

/** A Claude Desktop instance, as GET /api/instances lists it (core/shared.ts CMInstance). */
export interface AhInstance {
  num: number
  name: string
  dir: string
  label?: string | null
  isRunning: boolean
  isDefault?: boolean
  account: { email: string | null; name: string | null } | null
}

const TOOL_NAME: Record<string, string> = {
  'claude-code': 'Claude',
  openclaude: 'OpenClaude',
  cowork: 'Cowork',
  codex: 'Codex',
  opencode: 'OpenCode',
  kilo: 'Kilo',
  mimocode: 'MiMo',
  hermes: 'Hermes',
  'deepseek-harness': 'DeepSeek',
  zswarm: 'HSwarm',
  grok: 'Grok',
  kimi: 'Kimi',
  copilot: 'Copilot CLI'
}
const SOURCE_NAME: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  dsh: 'DeepSeek',
  zswarm: 'HSwarm',
  foreign: 'Other'
}
/** Each product's own colour, as AgentHydra's source badge wears it. */
export const SOURCE_TONE: Record<string, string> = {
  claude: 'border-[#D97757]/40 bg-[#D97757]/10 text-[#E9A287]',
  codex: 'border-[#10A37F]/40 bg-[#10A37F]/10 text-[#65D4B3]',
  opencode: 'border-[#5B6EF5]/40 bg-[#5B6EF5]/10 text-[#9AA6FF]',
  hermes: 'border-[#F5A623]/40 bg-[#F5A623]/10 text-[#F5C067]',
  dsh: 'border-[#4D6BFE]/40 bg-[#4D6BFE]/10 text-[#9DB0FF]',
  zswarm: 'border-[#4D6BFE]/40 bg-[#4D6BFE]/10 text-[#9DB0FF]'
}

/** Where the account chip takes you in AgentHydra: the row's instance by its number, on the CLI table for
 *  a CLI instance's session and the desktop table (Claude Desktop, Codex) otherwise; null without one. */
export function instanceTarget(row: Pick<AhSessionRow, 'instance_num' | 'instance_ref'> | null): { num: number; kind: 'desktop' | 'cli' } | null {
  const num = row?.instance_num
  if (!num || num < 1) return null
  return { num, kind: row.instance_ref?.startsWith('cli:') ? 'cli' : 'desktop' }
}

export function sourceName(row: Pick<AhSessionRow, 'source' | 'tool'>): string {
  return (row.tool && TOOL_NAME[row.tool]) || SOURCE_NAME[row.source] || row.source
}

/** A session with a file of its own (OpenCode and Hermes keep theirs in a shared database). */
export function hasFile(source: string): boolean {
  return source !== 'opencode' && source !== 'hermes'
}
/** ... and one an editor can show (DeepSeek's log is zstd). */
export function fileIsText(source: string): boolean {
  return hasFile(source) && source !== 'dsh'
}

/** AgentHydra's source for a session Desk knows: the cloud row's own when there is one, else Desk's. */
export function ahSource(deskSource: string | undefined, cloudSource: string | undefined): string | undefined {
  if (cloudSource) return cloudSource
  if (deskSource === 'codex') return 'codex'
  if (deskSource === 'desktop' || deskSource === 'cli' || deskSource === 'climayte') return 'claude'
  return undefined
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
export function formatCompact(n: number): string {
  return Number.isFinite(n) ? compact.format(n) : '—'
}
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

/** "1.2M tokens · $3.40", a "+" when a model has no published price (the total is then a floor). Null with nothing counted. */
export function usageSummary(u: AhUsage | null): string | null {
  if (!u || u.status !== 'ok' || u.tokens.turns <= 0) return null
  const tokens = `${formatCompact(u.tokens.total)} tokens`
  if (u.costUsd === null) return tokens
  return `${tokens} · ${formatUsd(u.costUsd)}${u.unpricedModels.length ? '+' : ''}`
}

export function usageDetail(u: AhUsage | null): string {
  if (!u || u.status !== 'ok') return ''
  const t = u.tokens
  const parts = [
    `In ${formatCompact(t.input)} · out ${formatCompact(t.output)} · cache read ${formatCompact(t.cacheRead)} · cache write ${formatCompact(t.cacheCreation)}, over ${t.turns} replies.`
  ]
  if (u.unpricedModels.length) {
    const models = u.unpricedModels.join(', ')
    parts.push(u.costUsd === null ? `No published price for ${models}, so no cost is shown.` : `No published price for ${models}, so the real total is higher.`)
  }
  parts.push(`Priced at published list rates as of ${u.pricesAsOf}. A subscription plan is not billed per token.`)
  return parts.join(' ')
}

/** Turns: the prompts a person sent, as the transcript shows them. */
export function turnCount(items: readonly TranscriptItem[]): number {
  return items.reduce((n, i) => n + (i.kind === 'user' && !i.parentToolUseId ? 1 : 0), 0)
}

/**
 * The Claude Desktop instance a session ran under, from the label it carries: a folder name, or
 * 'default' for the regular install. Exactly one match or none: two candidates means nobody can say
 * which, and the wrong account's address against a chat is worse than none.
 */
export function instanceFor(instances: readonly AhInstance[], row: Pick<AhSessionRow, 'source' | 'instance'> | null): AhInstance | null {
  const label = row?.source === 'claude' ? row.instance : null
  if (!label) return null
  const matches = instances.filter((i) => i.name === label || (label === 'default' && i.isDefault))
  return matches.length === 1 ? matches[0] : null
}

/** What to call the account on screen: the address's handle, else the instance's own name. */
export function accountName(inst: AhInstance | null, label: string): string {
  const handle = inst?.account?.email?.trim().split('@')[0]?.trim()
  if (handle) return handle
  if (inst) return inst.label?.trim() || inst.account?.name?.trim() || inst.name
  return label === 'default' ? 'Default' : label
}

/** The name a migrate target goes by: the label someone gave it, else its account, else its folder. */
export function instanceName(inst: AhInstance): string {
  return inst.label?.trim() || inst.account?.name?.trim() || inst.account?.email?.trim().split('@')[0] || inst.name
}

/** What Copy file location puts on the clipboard: AgentHydra's default, a prompt, the session's name and its path. */
export function fileLocationText(path: string, title: string, prompt = 'Resume where we left off'): string {
  const lines: string[] = []
  if (prompt.trim()) lines.push(prompt.trim(), '')
  if (title.trim()) lines.push(title.trim())
  lines.push(path)
  return lines.join('\n')
}

// ── What the transcript shows ─────────────────────────────────────────────────────────────────────

export interface DisplayPrefs {
  humanOnly: boolean
  showTools: boolean
  showThinking: boolean
  compact: boolean
}
export const DEFAULT_DISPLAY: DisplayPrefs = { humanOnly: false, showTools: true, showThinking: true, compact: false }

const TOOL_KINDS = new Set<TranscriptItem['kind']>(['tool_use', 'task', 'todos'])

/** The items the transcript shows under the display filters; any filter on hides part of it. */
export function displayItems(items: readonly TranscriptItem[], p: DisplayPrefs): TranscriptItem[] {
  if (p.humanOnly) return items.filter((i) => i.kind === 'user' && !i.parentToolUseId)
  return items.filter((i) => (p.showTools || !TOOL_KINDS.has(i.kind)) && (p.showThinking || i.kind !== 'thinking'))
}
export function displayFiltered(p: DisplayPrefs): boolean {
  return p.humanOnly || !p.showTools || !p.showThinking || p.compact
}

// ── Find ──────────────────────────────────────────────────────────────────────────────────────────

/** One match: the item it is in and which match in that item it is. */
export interface FindHit {
  itemId: string
  nth: number
}

function searchable(i: TranscriptItem): string | null {
  if (i.parentToolUseId) return null
  if (i.kind === 'user' || i.kind === 'assistant_text' || i.kind === 'thinking' || i.kind === 'system') return i.text
  return null
}

/** Every match of `query` in what the transcript says, in order; case-insensitive, nothing for a blank query. */
export function findHits(items: readonly TranscriptItem[], query: string): FindHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: FindHit[] = []
  for (const i of items) {
    const text = searchable(i)?.toLowerCase()
    if (!text) continue
    let at = text.indexOf(q)
    let nth = 0
    while (at !== -1) {
      hits.push({ itemId: i.id, nth: nth++ })
      at = text.indexOf(q, at + q.length)
    }
  }
  return hits
}

/** The match `n` steps along, wrapping both ways. */
export function wrapIndex(n: number, total: number): number {
  return total ? ((n % total) + total) % total : 0
}
