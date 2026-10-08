// Hydra Desk 2: how a sidebar row's sub-items (the CliMayte tasks it spawned, the HSwarm jobs it started) are
// shown, one choice per kind in the Filter menu's "Sub-items" part, remembered like the task toggle (owner,
// 2026-10-05: "show whether or not the CliMayte and ZSwarm tasks are shown as just an icon, like a number ...
// in a way that is not insanely cluttering up my sidebar"). List draws their lines under the row; Count draws a
// badge at the row's right edge (its icon, how many run and, for CliMayte, a dot per account) and the lines only
// after a click on it. Pure, so the window and the tests share it.
import { ref, watch } from 'vue'
import type { SwarmJob } from '@shared/protocol'
import type { TaskNode } from './tasks'

export type SubMode = 'list' | 'count'
export type SubKind = 'tasks' | 'jobs'

export const SUB_MODE_KEYS: Record<SubKind, string> = { tasks: 'hydra-desk.sidebar.tasks-mode', jobs: 'hydra-desk.sidebar.jobs-mode' }
/** What each kind shows until the owner chooses: a badge for both (owner, 2026-10-06, of CliMayte's: "the same option ... that I can click to see if I want"); List puts the lines back under the row. */
export const SUB_MODE_DEFAULTS: Record<SubKind, SubMode> = { tasks: 'count', jobs: 'count' }
export const SUB_KIND_LABELS: Record<SubKind, string> = { tasks: 'CliMayte tasks', jobs: 'HSwarm jobs' }

/** A stored value as a mode: anything but 'list' or 'count' (nothing stored, a stale value) is the kind's default. */
export function parseSubMode(raw: string | null | undefined, kind: SubKind): SubMode {
  return raw === 'list' || raw === 'count' ? raw : SUB_MODE_DEFAULTS[kind]
}

const storage = typeof localStorage === 'undefined' ? null : localStorage
function remembered(kind: SubKind) {
  const mode = ref<SubMode>(parseSubMode(storage?.getItem(SUB_MODE_KEYS[kind]), kind))
  watch(mode, (v) => storage?.setItem(SUB_MODE_KEYS[kind], v))
  return mode
}
export const taskMode = remembered('tasks')
export const jobMode = remembered('jobs')
export const subModes = { tasks: taskMode, jobs: jobMode }

/** The rows whose lines of a kind a click on its badge opened, for this session of the window (not stored). */
export const expanded = ref<ReadonlySet<string>>(new Set())
const openKey = (rowKey: string, kind: SubKind) => `${kind}|${rowKey}`
export function toggleExpanded(rowKey: string, kind: SubKind) {
  const next = new Set(expanded.value)
  if (!next.delete(openKey(rowKey, kind))) next.add(openKey(rowKey, kind))
  expanded.value = next
}

/** An account a kind's items run on (a CliMayte task's '#68'), once each: those with a running item first, then in the order the items list them. */
export interface SubAccount {
  label: string
  running: boolean
}

/** One kind's badge on a row: how many run, how many there are, the titles its tooltip lists, and the accounts its items run on. */
export interface SubBadge {
  kind: SubKind
  running: number
  total: number
  /** The titles its tooltip lists, a CliMayte task after its account (`#68 · title`). */
  titles: string[]
  /** The accounts its items run on (CliMayte's; HSwarm's jobs have none): its badge's tooltip and label name them. */
  accounts: SubAccount[]
  /** Its lines are open under the row. */
  open: boolean
}

/** The tooltip lists this many titles, then "+N more". */
export const TIP_TITLES = 8

export function badgeTip(b: SubBadge): string {
  const head = `${SUB_KIND_LABELS[b.kind]}: ${b.running ? `${b.running} running` : 'none running'}${b.total > b.running ? `, ${b.total} in all` : ''}`
  const more = b.titles.length > TIP_TITLES ? [`+${b.titles.length - TIP_TITLES} more`] : []
  return [head, ...b.titles.slice(0, TIP_TITLES), ...more, b.open ? 'Click to fold' : 'Click to list them'].join('\n')
}

const badgeOf = (kind: SubKind, items: readonly { title: string; active: boolean; account?: string | null }[], open: boolean): SubBadge => {
  const byAccount = new Map<string, boolean>()
  for (const i of items) if (i.account) byAccount.set(i.account, (byAccount.get(i.account) ?? false) || i.active)
  return {
    kind,
    running: items.filter((i) => i.active).length,
    total: items.length,
    titles: items.map((i) => (i.account ? `${i.account} · ${i.title}` : i.title)),
    accounts: [...byAccount].map(([label, running]) => ({ label, running })).sort((a, b) => Number(b.running) - Number(a.running)),
    open
  }
}

/**
 * What a row draws of its sub-items: the lines (`nodes`, `jobs`) of each kind that is in List mode or opened by
 * its badge, and a badge for each kind in Count mode that has any.
 */
export function rowSubItems(
  rowKey: string,
  tasks: readonly TaskNode[] | null | undefined,
  jobs: readonly SwarmJob[] | null | undefined,
  modes: Record<SubKind, SubMode>,
  open: ReadonlySet<string>
): { nodes: TaskNode[]; jobs: SwarmJob[]; badges: SubBadge[] } {
  const badges: SubBadge[] = []
  const shown = (kind: SubKind, items: readonly { title: string; active: boolean; account?: string | null }[]) => {
    if (modes[kind] === 'list') return true
    const isOpen = open.has(openKey(rowKey, kind))
    if (items.length) badges.push(badgeOf(kind, items, isOpen))
    return isOpen
  }
  const taskList = tasks ?? []
  const jobList = jobs ?? []
  const showTasks = shown('tasks', taskList.map((n) => ({ title: n.worker.title, active: n.worker.active, account: n.worker.account })))
  const showJobs = shown('jobs', jobList)
  return { nodes: showTasks ? [...taskList] : [], jobs: showJobs ? [...jobList] : [], badges }
}
