// Hydra Desk 2's cloud list (the chrome bar's cloud button): AgentHydra's whole session list, both PCs'
// chats included, with the filters of AgentHydra's Sessions ⋯ menu. Pure: no Vue, no store.
//
// The scopes follow AgentHydra's own model (web/src/lib/session-scopes.ts there): each filter is the list
// of TICKED values, every value ticked is "no narrowing", none ticked is the server's `none`. Source,
// instance, queued work, usage limits, archived and the time period are applied by AgentHydra; shape
// and computer narrow the rows already fetched.
import type { ChatSummary, CloudSession, ExternalSession } from '@shared/protocol'
import { folderKey, folderLabel, NO_FOLDER, namesakeFolder, sortFolders, stableOrder, type SidebarOrder } from '../sidebar/logic'

/** claude-opus-5-5 -> Opus 5.5, the way AgentHydra's rows name it; any other model as it is. */
export function modelName(m: string | null | undefined): string | null {
  const hit = m?.match(/^claude-([a-z]+)-(\d+)-(\d+)/)
  return hit ? `${hit[1]!.charAt(0).toUpperCase()}${hit[1]!.slice(1)} ${hit[2]}.${hit[3]}` : (m ?? null)
}

export const SOURCE_VALUES = ['claude', 'codex', 'opencode', 'hermes', 'dsh', 'zswarm'] as const
export type CloudSource = (typeof SOURCE_VALUES)[number]
export const SOURCE_LABELS: Record<CloudSource, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  dsh: 'DSH',
  zswarm: 'HSwarm'
}
export const DISPATCHED_VALUES = ['queued', 'manual'] as const
export type DispatchedValue = (typeof DISPATCHED_VALUES)[number]
export const DISPATCHED_LABELS: Record<DispatchedValue, string> = { queued: 'Queued by me', manual: 'Driven by hand' }
export const RATE_LIMIT_VALUES = ['clear', 'resolved', 'pending'] as const
export type RateLimitValue = (typeof RATE_LIMIT_VALUES)[number]
export const RATE_LIMIT_LABELS: Record<RateLimitValue, string> = {
  clear: 'Never stopped by a limit',
  resolved: 'Stopped, then resumed',
  pending: 'Still stopped right now'
}
export const SHAPE_VALUES = ['quick', 'standard', 'deep', 'marathon', 'automation'] as const
export type CloudShape = (typeof SHAPE_VALUES)[number]
export const SHAPE_LABELS: Record<CloudShape, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
  marathon: 'Marathon',
  automation: 'Automation'
}
export const ARCHIVED_VALUES = ['active', 'archived'] as const
export type ArchivedValue = (typeof ARCHIVED_VALUES)[number]
export const ARCHIVED_LABELS: Record<ArchivedValue, string> = { active: 'Not archived', archived: 'Archived' }
export const PERIOD_VALUES = ['24h', '7d', '30d', 'all'] as const
export type CloudPeriod = (typeof PERIOD_VALUES)[number]
export const PERIOD_LABELS: Record<CloudPeriod, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time'
}

/** The instance filter: the default login, each named desktop instance, and every other one. */
export const INSTANCE_DEFAULT = 'default'
export const INSTANCE_OTHER = 'other'

export interface CloudScopes {
  /** The ticked apps (AgentHydra's `source` in the query). */
  apps: CloudSource[]
  /** null: every instance (no narrowing); else the ticked names, 'default' and 'other' included. */
  instance: string[] | null
  dispatched: DispatchedValue[]
  rateLimit: RateLimitValue[]
  shape: CloudShape[]
  archived: ArchivedValue[]
  period: CloudPeriod
  /** null: both PCs; else the ticked PC names. */
  pcs: string[] | null
  /** The search box keeps these filters instead of looking at everything. */
  onlyThisView: boolean
}

/** What the list shows until its owner picks otherwise: Claude alone (owner, 2026-10-05: "I don't
 *  necessarily want to see open code or ChatGPT in my sidebar by default, but I want to be able to"),
 *  live sessions only, the last 24 hours, both PCs. */
export const DEFAULT_SCOPES: CloudScopes = {
  apps: ['claude'],
  instance: null,
  dispatched: [...DISPATCHED_VALUES],
  rateLimit: [...RATE_LIMIT_VALUES],
  shape: [...SHAPE_VALUES],
  archived: ['active'],
  period: '24h',
  pcs: null,
  onlyThisView: false
}

/** No narrowing at all: what a search looks through unless "Only this view" is ticked. */
const WIDE: Omit<CloudScopes, 'onlyThisView' | 'pcs'> = {
  apps: [...SOURCE_VALUES],
  instance: null,
  dispatched: [...DISPATCHED_VALUES],
  rateLimit: [...RATE_LIMIT_VALUES],
  shape: [...SHAPE_VALUES],
  archived: [...ARCHIVED_VALUES],
  period: 'all'
}

const pick = <T extends string>(raw: unknown, universe: readonly T[], fallback: readonly T[]): T[] =>
  Array.isArray(raw) && raw.every((v) => typeof v === 'string' && universe.includes(v as T))
    ? universe.filter((v) => raw.includes(v))
    : [...fallback]
const names = (raw: unknown): string[] | null =>
  Array.isArray(raw) && raw.every((v) => typeof v === 'string') ? [...raw] : null

/** Stored scopes, each one that is not a known value falling back to its default. */
export function parseScopes(stored: string | null | undefined): CloudScopes {
  let o: Record<string, unknown> = {}
  try {
    const v = JSON.parse(stored ?? 'null')
    if (v && typeof v === 'object') o = v as Record<string, unknown>
  } catch {
    // a broken value is the defaults
  }
  const d = DEFAULT_SCOPES
  return {
    apps: pick(o.apps, SOURCE_VALUES, d.apps),
    instance: names(o.instance),
    dispatched: pick(o.dispatched, DISPATCHED_VALUES, d.dispatched),
    rateLimit: pick(o.rateLimit, RATE_LIMIT_VALUES, d.rateLimit),
    shape: pick(o.shape, SHAPE_VALUES, d.shape),
    archived: pick(o.archived, ARCHIVED_VALUES, d.archived),
    period: PERIOD_VALUES.includes(o.period as CloudPeriod) ? (o.period as CloudPeriod) : d.period,
    pcs: names(o.pcs),
    onlyThisView: o.onlyThisView === true
  }
}

/** Tick or untick one value, kept in the universe's order. */
export function toggle<T extends string>(selected: readonly T[], universe: readonly T[], value: T): T[] {
  const next = new Set(selected)
  if (!next.delete(value)) next.add(value)
  return universe.filter((v) => next.has(v))
}

/** A click on one app in the Apps filter: with every app ticked (All), that app alone (owner, 2026-10-08: "if all are
 * selected and I click on claude, just click claude, unselect the others"); otherwise it is ticked or unticked. */
export function pickApp<T extends string>(selected: readonly T[], universe: readonly T[], value: T): T[] {
  return universe.every((v) => selected.includes(v)) ? [value] : toggle(selected, universe, value)
}

const allOf = (selected: readonly string[], universe: readonly string[]) => universe.every((v) => selected.includes(v))
const scope = (selected: readonly string[], universe: readonly string[]): string | undefined =>
  allOf(selected, universe) ? undefined : selected.length ? selected.join(',') : 'none'

/** The scopes in force: a search looks at everything unless "Only this view" keeps the filters. */
export function effectiveScopes(s: CloudScopes, search: string): CloudScopes {
  return search.trim() && !s.onlyThisView ? { ...s, ...WIDE } : s
}

/**
 * The query for GET /api/cloud/sessions, in AgentHydra's spelling. Instance, queued work and usage limits
 * are facts about Claude sessions: sent only with Claude ticked, and with othersPass so they narrow the
 * Claude rows and leave the other sources' alone. "Every source but HSwarm" is `-zswarm`, which keeps
 * the tools the menu has no entry for.
 */
export function cloudQuery(s: CloudScopes, search: string): string {
  const q = new URLSearchParams()
  const claude = s.apps.includes('claude')
  q.set('period', s.period)
  q.set('archived', s.archived.length ? s.archived.join(',') : 'none')
  const nonHswarm = SOURCE_VALUES.filter((v) => v !== 'zswarm')
  const source = allOf(s.apps, nonHswarm) && s.apps.length === nonHswarm.length ? '-zswarm' : scope(s.apps, SOURCE_VALUES)
  if (source) q.set('source', source)
  if (claude && s.instance) q.set('instance', s.instance.length ? s.instance.join(',') : 'none')
  const dispatched = claude ? scope(s.dispatched, DISPATCHED_VALUES) : undefined
  if (dispatched) q.set('dispatched', dispatched)
  const ratelimited = claude ? scope(s.rateLimit, RATE_LIMIT_VALUES) : undefined
  if (ratelimited) q.set('ratelimited', ratelimited)
  q.set('othersPass', '1')
  if (search.trim()) q.set('title', search.trim())
  return q.toString()
}

/**
 * What kind of session it was (AgentHydra web/src/lib/session-shape.ts, same thresholds): the larger of
 * the verdicts by message count and by how long it ran; queued work is Automation outright.
 */
const BY_MESSAGES = [25, 450, 1000]
const BY_MINUTES = [15, 150, 480]
const SCALE: CloudShape[] = ['quick', 'standard', 'deep', 'marathon']
const rank = (v: number, bounds: number[]) => {
  const i = bounds.findIndex((b) => v < b)
  return i < 0 ? bounds.length : i
}
export function sessionShape(s: Pick<CloudSession, 'messageCount' | 'createdAt' | 'lastActivityAt' | 'dispatched'>): CloudShape {
  if (s.dispatched) return 'automation'
  const minutes = s.createdAt === null ? null : Math.max(0, (s.lastActivityAt - s.createdAt) / 60_000)
  return SCALE[Math.max(rank(s.messageCount, BY_MESSAGES), minutes === null ? 0 : rank(minutes, BY_MINUTES))] ?? 'quick'
}

/** The PC a row came from: the chat sync's name for another PC's chat, else this one. */
export const pcOf = (s: Pick<CloudSession, 'fromPc'>, thisPc: string): string => s.fromPc ?? thisPc

/** The words of the cloud icon on another PC's chat, in both lists (AgentHydra's Sessions tab says the same); the app too when it is not Claude. */
export const fromPcLabel = (pc: string, source = 'claude'): string =>
  source === 'claude' ? `From ${pc}, through the chat sync` : `${sourceName(source)} chat from ${pc}, through the chat sync`

/** A source in words: AgentHydra's by their menu names, any other as it is. */
export const sourceName = (s: string): string => SOURCE_LABELS[s as CloudSource] ?? s

/** Where a row comes from: its source, account number (or instance) and PC ("Claude · #37 · on Studio"). */
export function originLabel(r: Pick<CloudSession, 'source' | 'instance' | 'instanceNum' | 'fromPc'>, thisPc: string): string {
  return [sourceName(r.source), r.instanceNum !== null ? `#${r.instanceNum}` : r.instance, `on ${pcOf(r, thisPc)}`].filter(Boolean).join(' · ')
}

/** What a row shows besides its dot: a cloud (another PC's chat, in the dot's place) with its words, a muted mark for its app (beside the dot, never replacing it) with its words, or nothing. */
export type RowLead = { kind: 'cloud'; label: string } | { kind: 'app'; app: string; label: string } | null

/**
 * The cloud means another PC, nothing else (owner, 2026-10-05: "why chats on my computer are considered
 * cloud ... it's not cloud"). A chat of another app on this PC carries
 * its app's mark beside its dot. A row added for running work (`added`) has a cloud only for another PC.
 */
export function rowLead(r: Pick<CloudSession, 'source' | 'fromPc'>, thisPc: string, o: { added: boolean }): RowLead {
  const pc = r.fromPc && r.fromPc !== thisPc ? r.fromPc : null
  if (pc) return { kind: 'cloud', label: o.added ? `On ${pc}` : fromPcLabel(pc, r.source) }
  return o.added ? null : appLead(r.source)
}

/** The muted mark of a chat on this PC from an app that is not Claude, in both lists (the desk list's ExternalRow too); null for Claude's. */
export function appLead(source: string): RowLead {
  return source === 'claude' ? null : { kind: 'app', app: source, label: `${sourceName(source)} chat on this PC` }
}

/**
 * Whether the Apps scope lets an app's chats through. A named app by its tick; an app the desk cannot name
 * ('other') only with every app but HSwarm ticked, the way the cloud list treats a session it cannot name.
 */
export function appShown(app: string, apps: readonly string[]): boolean {
  return (SOURCE_VALUES as readonly string[]).includes(app) ? apps.includes(app) : allOf(apps, SOURCE_VALUES.filter((v) => v !== 'zswarm'))
}

/** Every PC the rows name, this one first. */
export function pcsIn(rows: Pick<CloudSession, 'fromPc'>[], thisPc: string): string[] {
  const others = [...new Set(rows.map((r) => r.fromPc).filter((p): p is string => !!p && p !== thisPc))].sort()
  return [thisPc, ...others]
}

/** The Filter menu's Show only local: Computer narrowed to this PC alone, the other PC's sessions out. */
export const localOnly = (s: Pick<CloudScopes, 'pcs'>, thisPc: string): boolean => s.pcs?.length === 1 && s.pcs[0] === thisPc

/** The Computer filter keeps a row: its PC is ticked; null ticks every PC. */
export const pcKept = (r: Pick<CloudSession, 'fromPc'>, pcs: readonly string[] | null, thisPc: string): boolean =>
  pcs === null || pcs.includes(pcOf(r, thisPc))

/**
 * The desk list under the Computer filter, as the cloud list is (owner, 2026-10-05: "show only local, which
 * should mean this PC"): a Desk chat is this PC's, an outside session the chat sync brought is its PC's.
 */
export function deskOnPcs<C, E extends Pick<CloudSession, 'fromPc'>>(
  chats: C[],
  external: E[],
  pcs: readonly string[] | null,
  thisPc: string
): { chats: C[]; external: E[] } {
  if (pcs === null) return { chats, external }
  return { chats: pcs.includes(thisPc) ? chats : [], external: external.filter((s) => pcKept(s, pcs, thisPc)) }
}

export interface CloudGroup {
  key: string
  label: string
  cwd: string | null
  /** Its key for Hide (sidebar/logic.ts groupOrderKey, the desk list's spelling): the folder however spelled, '' for none, or `group:<name>`. */
  orderKey: string
  rows: CloudSession[]
  /** Hidden (its right-click's Hide), shown because Show hidden is on (sidebar/logic.ts dropHidden). */
  hidden?: boolean
}

export const RESULTS_LABEL = 'Best matches first'
/** The one group of a search's answer; never hidden. */
export const RESULTS_KEY = 'cloud:results'

/**
 * A session the desk list (the cloud button off) lists: where it puts it, under its folder ('' for none)
 * or in the group it was moved to; its row's key in the saved order (sidebar/order.ts), which is the desk
 * row's id (a Desk chat's own id, not its session's; an outside session's session id); and a row made of
 * what the desk knows of it, listed when AgentHydra's answer leaves the session out (groupCloud).
 */
export interface DeskPlace {
  cwd: string
  group: string | null
  key: string
  row: CloudSession
}

type DeskChat = Pick<ChatSummary, 'id' | 'sessionId' | 'title' | 'cwd' | 'group' | 'archived' | 'createdAt' | 'updatedAt' | 'model' | 'effort' | 'account'>
type DeskExternal = Pick<ExternalSession, 'id' | 'title' | 'cwd' | 'group' | 'source' | 'instance' | 'archived' | 'lastActivityAt' | 'model' | 'fromPc'>

/** A cloud row of what the desk knows of a session; what only AgentHydra counts (messages, queued work) is left at nothing. */
const deskRow = (r: Omit<CloudSession, 'lastCwd' | 'messageCount' | 'dispatched'>): CloudSession => ({ ...r, lastCwd: null, messageCount: 0, dispatched: false })

/** An outside session's source in AgentHydra's spelling (the app it is of); 'other' is a tool the desk does not name. */
export const ahSource = (s: ExternalSession['source']): string => (s === 'codex' ? 'codex' : s === 'other' ? 'other' : 'claude')

/**
 * Every session the desk list lists, by session id: a Desk chat by its session, and the outside sessions
 * groupChats (sidebar/logic.ts) lists, which leaves out CliMayte's own workers and a session that already
 * is one of our chats. A Desk chat without a session yet has no cloud row to be.
 */
export function deskPlaces(chats: DeskChat[], external: DeskExternal[]): Map<string, DeskPlace> {
  const out = new Map<string, DeskPlace>()
  for (const c of chats) {
    if (!c.sessionId) continue
    const row = deskRow({
      id: c.sessionId,
      title: c.title,
      cwd: c.cwd || null,
      source: 'claude',
      instance: null,
      lastActivityAt: c.updatedAt,
      createdAt: c.createdAt,
      archived: c.archived,
      fromPc: null,
      model: c.model,
      effort: c.effort,
      instanceNum: c.account.number ?? null
    })
    out.set(c.sessionId, { cwd: c.cwd, group: c.group, key: c.id, row })
  }
  for (const s of external) {
    if (s.source === 'climayte' || out.has(s.id)) continue
    const num = s.instance?.match(/^#(\d+)$/)
    const row = deskRow({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      source: ahSource(s.source),
      instance: num ? null : s.instance,
      lastActivityAt: s.lastActivityAt ?? 0,
      createdAt: null,
      archived: s.archived,
      fromPc: s.fromPc,
      model: s.model,
      effort: null,
      instanceNum: num ? Number(num[1]) : null
    })
    out.set(s.id, { cwd: s.cwd ?? '', group: s.group, key: s.id, row })
  }
  return out
}

/**
 * Whether the filters let through a session the desk list lists that AgentHydra's answer left out. The
 * period never keeps it out (owner, 2026-10-04: a desk chat older than the cloud's 24 hours was missing
 * from the cloud list); every other filter still does. Source, archived (the desk's own mark) and PC are
 * read off the desk's facts; shape, instance, queued work and usage limits are AgentHydra's, so once one
 * of those narrows, the row stays out.
 */
function keepsDeskRow(r: CloudSession, s: CloudScopes, thisPc: string): boolean {
  if (!appShown(r.source, s.apps) || !s.archived.includes(r.archived ? 'archived' : 'active')) return false
  if (!pcKept(r, s.pcs, thisPc)) return false
  if (!allOf(s.shape, SHAPE_VALUES)) return false
  const claudeNarrowed = s.instance !== null || !allOf(s.dispatched, DISPATCHED_VALUES) || !allOf(s.rateLimit, RATE_LIMIT_VALUES)
  return !(r.source === 'claude' && claudeNarrowed)
}

/** A row's key in the saved order: its desk row's id when the desk list lists the session, else its own session id. */
export const rowOrderKey = (r: Pick<CloudSession, 'id'>, desk: ReadonlyMap<string, DeskPlace>): string => desk.get(r.id)?.key ?? r.id

const newestFirst = (a: CloudSession, b: CloudSession) => b.lastActivityAt - a.lastActivityAt

export interface GroupCloudOptions {
  /** A search's answer: AgentHydra's order, best match first. */
  ranked?: boolean
  /** The sessions the desk list lists (deskPlaces). */
  desk?: ReadonlyMap<string, DeskPlace>
  /** The order both lists keep (sidebar/order.ts); without one, groups by their newest row and rows newest first. */
  order?: SidebarOrder
}

/**
 * The rows the list shows, grouped and ordered like the desk list, so turning the cloud on or off moves
 * nothing (owner, 2026-10-04: "For some reason they change order"). The shape and computer filters
 * apply. Every session the desk list lists is here (`desk`, deskPlaces), made of the desk's facts when
 * AgentHydra's answer left it out (keepsDeskRow: the period never drops it), and sits where it sits there:
 * under its desk row's folder, or in the group it was moved to, which joins a folder group of the same
 * name as in groupChats (owner, 2026-10-04: a chat jumped to another folder's group). Every other row goes
 * under the folder AgentHydra gives, the one it started in (server bridge/cloud.ts). Groups are listed A-Z
 * (sortFolders), as the desk list lists them. With the saved `order`, rows keep the desk list's places (a row by
 * its desk row's id, rowOrderKey); the rows only the cloud list has come after the desk's in their group
 * (cloudOnlyKeys records them). A search's answer
 * (`ranked`) keeps AgentHydra's order instead, best match first (a title hit before a folder hit before
 * letters in order), as one group.
 */
export function groupCloud(rows: CloudSession[], s: CloudScopes, thisPc: string, opts: GroupCloudOptions = {}): CloudGroup[] {
  const desk = opts.desk ?? new Map<string, DeskPlace>()
  const shown = rows.filter((r) => s.shape.includes(sessionShape(r)) && pcKept(r, s.pcs, thisPc))
  if (opts.ranked) return shown.length ? [{ key: RESULTS_KEY, label: RESULTS_LABEL, cwd: null, orderKey: RESULTS_KEY, rows: shown }] : []
  const answered = new Set(rows.map((r) => r.id))
  for (const [id, place] of desk) if (!answered.has(id) && keepsDeskRow(place.row, s, thisPc)) shown.push(place.row)
  const byFolder = new Map<string, CloudGroup>()
  const byGroup = new Map<string, CloudGroup>()
  // Rows come newest first, so a group's label is its newest row's spelling.
  const add = (map: Map<string, CloudGroup>, id: string, label: string, cwd: string | null, r: CloudSession) => {
    const g: CloudGroup = map.get(id) ?? { key: `cloud:${id}`, label, cwd, orderKey: id, rows: [] }
    map.set(id, g)
    g.rows.push(r)
  }
  for (const r of [...shown].sort(newestFirst)) {
    const place = desk.get(r.id)
    // Moved-to groups ignore case, like folders.
    if (place?.group) add(byGroup, `group:${place.group.toLowerCase()}`, place.group, null, r)
    else {
      const cwd = place ? place.cwd || null : r.cwd
      add(byFolder, cwd ? folderKey(cwd) : '', cwd ? folderLabel(cwd) : NO_FOLDER, cwd, r)
    }
  }
  const groups = [...byFolder.values()]
  // The desk list picks among its own folders: a folder only the cloud list has is never the one.
  const deskFolders = groups.filter((f) => f.rows.some((r) => desk.has(r.id)))
  for (const g of byGroup.values()) {
    const folder = namesakeFolder(deskFolders, g.label)
    if (folder) folder.rows.push(...g.rows)
    else groups.push(g)
  }
  for (const g of groups) g.rows.sort(newestFirst)
  const sorted = sortFolders(groups)
  const order = opts.order
  if (!order) return sorted
  const cloudOnly = (r: CloudSession) => !desk.has(r.id)
  for (const g of sorted) g.rows = stableOrder(g.rows, (r) => rowOrderKey(r, desk), order.rows, cloudOnly)
  return sorted
}

/**
 * What the cloud list adds to the saved order, at its end (sidebar/logic.ts recordCloudOrder): its rows the desk
 * list does not list, as shown. Recorded once, they keep their places when new rows come.
 */
export function cloudOnlyKeys(groups: CloudGroup[], desk: ReadonlyMap<string, DeskPlace>): string[] {
  return groups.flatMap((g) => g.rows.filter((r) => !desk.has(r.id)).map((r) => r.id))
}

/** A filter's right-hand text in the menu: All, None, the one name, or the first and a count. */
export function summarize(selected: readonly string[], universe: readonly string[], label: (v: string) => string): string {
  if (allOf(selected, universe)) return 'All'
  const shown = universe.filter((v) => selected.includes(v)).map(label)
  if (!shown.length) return 'None'
  return shown.length === 1 ? (shown[0] ?? '') : `${shown[0]} +${shown.length - 1}`
}

/** Any filter narrowing the list, so the filter button shows it is on. */
export function scopesNarrowed(s: CloudScopes): boolean {
  const d = DEFAULT_SCOPES
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v))
  return (
    !same(s.apps, d.apps) ||
    s.instance !== null ||
    !same(s.dispatched, d.dispatched) ||
    !same(s.rateLimit, d.rateLimit) ||
    !same(s.shape, d.shape) ||
    !same(s.archived, d.archived) ||
    s.period !== d.period ||
    s.pcs !== null
  )
}
