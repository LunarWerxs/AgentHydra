// server/src/climayte-dispatch.ts — a dispatch's tasks checked, set and made into workers: the
// model, effort and kind each runs at (runSetting), sealed and chat tasks, repeats, sizing
// (sizeTasks) and the reply. climayteRun in climayte.ts enlists what this makes. Split from
// climayte.ts on 2026-10-08; it imports only types from it.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { climayteRun } from './climayte'
import {
  accountsProvider,
  acctLabel,
  basisText,
  placementState,
  SEALED,
  walls,
  workers,
} from './climayte-core'
import { firstLine } from './climayte-journal'
import {
  type CliMayteAccount,
  type CliMayteSealed,
  type CliMayteSizing,
  type CliMayteWorker,
  type CliMayteWorkerView,
  climayteEffort,
  climayteModel,
  climaytePriority,
  isWalledNow,
  toView,
} from './climayte-lib'
import { fitPct, projectedPct, sizeTask } from './climayte-placement'
import {
  bestRung,
  type CliMayteKind,
  climayteKind,
  HAIKU,
  ladderIndex,
  OPUS,
  pickConfig,
  scoreRows,
  touchesLiveThings,
} from './climayte-scorecard'
import { getCliInstance } from './core/cli-instances'

export const hex = (n: number): string => crypto.randomUUID().replace(/-/g, '').slice(0, n)

const isAutoSetting = (v: unknown): boolean =>
  typeof v === 'string' && v.trim().toLowerCase() === 'auto'

export type RunTask = Parameters<typeof climayteRun>[0]['tasks'][number]

/** A run's defaults: what a task takes when it names none of its own. */
export interface RunDefaults {
  /** The run's model is `auto`: the scorecard picks for every task that names no model. */
  auto: boolean
  model: string | null
  effort: string | null
  /** Why the run names its model or effort (runSetting); null: it gave no reason. */
  why: string | null
  /** The owner's own words asking for the run's model or effort (runSetting); null: none. */
  ownerWords: string | null
  kind: CliMayteKind | null
  priority: number
}

const OWNER_WORDS_MAX = 2000

/** `ownerWords` trimmed, or null when blank. Throws past OWNER_WORDS_MAX characters. */
function ownerWordsOf(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new Error('ownerWords must be a string')
  const s = v.trim()
  if (s.length > OWNER_WORDS_MAX)
    throw new Error(`ownerWords is ${s.length} characters: at most ${OWNER_WORDS_MAX}`)
  return s || null
}

/** One task's setting, and for an `auto` task why the scorecard picked it. */
export interface RunSetting {
  model: string | null
  effort: string | null
  kind: CliMayteKind | null
  auto: boolean
  reason: string | undefined
  priority: number
}

/** How many `auto` tasks of each kind are on record: pickConfig's every-4th exploring pick counts
 *  from here. */
function autoPicksSoFar(): Map<CliMayteKind, number> {
  const autoSoFar = new Map<CliMayteKind, number>()
  for (const w of workers.values())
    if (w.auto && w.kind) {
      const k = w.kind as CliMayteKind
      autoSoFar.set(k, (autoSoFar.get(k) ?? 0) + 1)
    }
  return autoSoFar
}

/** A task's `sealed` option, validated: both files absolute and there, the MCP config one with an
 *  `mcpServers` object, at least one allowed tool. Throws on anything else, so a sealed task never
 *  starts with nothing to act with. */
export function sealedOf(v: unknown): CliMayteSealed {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const file = (key: 'systemPromptFile' | 'mcpConfig'): string => {
    const path = s[key]
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new Error(`sealed.${key} must be an absolute file path`)
    if (!existsSync(path) || !statSync(path).isFile())
      throw new Error(`sealed.${key} '${path}' is not an existing file`)
    return path
  }
  const systemPromptFile = file('systemPromptFile')
  const mcpConfig = file('mcpConfig')
  let servers: unknown
  try {
    servers = (JSON.parse(readFileSync(mcpConfig, 'utf8')) as { mcpServers?: unknown }).mcpServers
  } catch {
    servers = null
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    throw new Error(`sealed.mcpConfig '${mcpConfig}' is not JSON with an mcpServers object`)
  const tools: unknown = s.allowedTools
  if (
    !Array.isArray(tools) ||
    !tools.length ||
    tools.some((t) => typeof t !== 'string' || !t.trim())
  )
    throw new Error('sealed.allowedTools must be a non-empty array of tool names or patterns')
  return { systemPromptFile, mcpConfig, allowedTools: tools.map((t: string) => t.trim()) }
}

/** A sealed task as the rest of a dispatch reads it: `sealed` validated, and its prompt the task's
 *  own or `sealed.prompt`. Any other task as it came. */
export function sealedTask(t: RunTask, i: number): RunTask {
  if (t?.sealed === undefined || t.sealed === null) return t
  if (t.chat === true) throw new Error(`task ${i + 1}: a sealed task cannot be a chat`)
  try {
    return { ...t, sealed: sealedOf(t.sealed), prompt: t.prompt || (t.sealed.prompt ?? '') }
  } catch (err) {
    throw new Error(`task ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Refuse a task that could not run: no prompt, no such folder, a check that is not one command. */
function assertRunnable(t: RunTask, i: number): void {
  if (typeof t?.prompt !== 'string' || !t.prompt.trim())
    throw new Error(`task ${i + 1}: prompt is empty`)
  // A sealed task names no folder: it runs in an empty one of its own (newWorker).
  if (
    !t.sealed &&
    (typeof t.cwd !== 'string' || !existsSync(t.cwd) || !statSync(t.cwd).isDirectory())
  )
    throw new Error(`task ${i + 1}: cwd '${t.cwd}' is not an existing folder`)
  if (
    t.check !== undefined &&
    t.check !== null &&
    (typeof t.check !== 'string' || t.check.length > 2000)
  )
    throw new Error(`task ${i + 1}: check must be one shell command (at most 2000 characters)`)
  if (t.chat !== undefined && typeof t.chat !== 'boolean')
    throw new Error(`task ${i + 1}: chat must be true or false`)
  if (t.desk !== undefined && t.desk !== null) {
    const why = deskProblem(t.desk, t.chat === true)
    if (why) throw new Error(`task ${i + 1}: ${why}`)
  }
}

/** The longest `desk.append` a chat may carry; a longer one is refused, never cut. */
const DESK_APPEND_MAX = 20_000

/** Why `d` cannot be a chat's add-ons (CliMayteWorker.desk), or null when it can: a chat task's and
 *  every message to a chat's (climayteSend), so a chat started before them gets them too. */
export function deskProblem(d: unknown, chat: boolean): string | null {
  const desk = d as Partial<NonNullable<CliMayteWorker['desk']>>
  if (!chat) return 'desk is only for a chat task (chat: true)'
  if (typeof desk?.append !== 'string' || desk.append.length > DESK_APPEND_MAX)
    return `desk.append must be a string of at most ${DESK_APPEND_MAX} characters`
  if (!desk.mcpServers || typeof desk.mcpServers !== 'object' || Array.isArray(desk.mcpServers))
    return 'desk.mcpServers must be an object of server configs'
  return null
}

/** The model and effort a task names, or its run does (runSetting): both null when it asks for
 *  `auto`. `effort` is the one it runs at, `namedEffort` the one named. Throws on a value that is
 *  not one. */
function namedModelEffort(
  t: RunTask,
  defaults: RunDefaults,
): { model: string | null; namedEffort: string | null; effort: string | null } {
  const autoAsked = isAutoSetting(t.model) || (isBlank(t.model) && defaults.auto)
  const model = autoAsked ? null : (climayteModel(t.model) ?? defaults.model)
  const namedEffort = autoAsked
    ? null
    : ((isAutoSetting(t.effort) ? null : climayteEffort(t.effort)) ?? defaults.effort)
  // A Haiku named with no effort runs at medium: its first rung, and the API's default.
  const effort = namedEffort ?? (model === HAIKU ? 'medium' : null)
  return { model, namedEffort, effort }
}

/** The owner's words that may hold a task's named setting (runSetting): its own, else its run's. */
function ownerWordsFor(t: RunTask, defaults: RunDefaults, ownWords: string | null): string | null {
  // The run's ownerWords asked for the run's setting: a task naming its own needs its own words.
  const namesOwn =
    (!isBlank(t.model) && !isAutoSetting(t.model)) ||
    (!isBlank(t.effort) && !isAutoSetting(t.effort))
  return ownWords ?? (namesOwn ? null : defaults.ownerWords)
}

/** The setting a task names when it holds (runSetting): with the owner's `words`, on a sealed task,
 *  or with a `why` for a rung cheaper than kind `k`'s best. Null when it names none or it does not
 *  hold. */
function heldSetting(
  t: RunTask,
  s: { model: string | null; effort: string | null; kind: CliMayteKind | null; priority: number },
  words: string | null,
  why: string | null,
  k: CliMayteKind,
  rows: ReturnType<typeof scoreRows>,
): RunSetting | null {
  const { model, effort, kind, priority } = s
  if ((model || effort) && words)
    return {
      model,
      effort,
      kind,
      auto: false,
      reason: `named by the owner: "${words.slice(0, 120)}"`,
      priority,
    }
  // A sealed task is a measurement (a simulated visitor: one prompt, one MCP server, no repo), never a
  // trial: the setting it names holds at any rung, so its brain does not change under it mid-series,
  // and with no kind of its own it is no kind's sample (scoreRows skips it). 2026-10-07: 624 sealed
  // visits named Sonnet 5.5 and ran on code's pick instead, 469 at Sonnet low and 155 on Haiku.
  if ((model || effort) && t.sealed)
    return {
      model,
      effort,
      kind,
      auto: false,
      reason: `named by a sealed task${why ? `: ${why}` : ''}`,
      priority,
    }
  if ((model || effort) && why) {
    // The CLI's defaults: a model alone runs at high, an effort alone on Opus.
    const named = ladderIndex({ model: model ?? OPUS, effort: effort ?? 'high' })
    if (named !== -1 && named < bestRung(k, rows))
      return { model, effort, kind, auto: false, reason: `named by the sender: ${why}`, priority }
  }
  return null
}

/** One task's model, effort, kind and priority. A named model or effort is held only when the task
 *  (or its run) gives `ownerWords`, or the task is sealed, or it gives a `modelWhy` AND the named
 *  setting sits on a cheaper rung than the kind's best; otherwise the task is auto: the scorecard's
 *  pick for its kind, and `autoSoFar` counts it.
 *  Owner, 2026-10-02: tasks are to go to "the cheapest/fastest model capable of reliably completing"
 *  them, yet in a day 194 of about 440 arrived pinned to Opus high or above by the chats that sent
 *  them, and a task naming nothing ran on the CLI's default, Opus high.
 *  Owner, 2026-10-05: the point was to offload work to moderate models, yet 'not a single one is
 *  using any other model besides Opus 5.5': senders pinned Opus by naming it with any `modelWhy`
 *  (286 tasks in 72 h here), so a reason no longer holds a setting at or above the pick; only the
 *  owner's own words do. A named setting not held is validated, then left to the scorecard. Throws
 *  on a value that is not one. */
export function runSetting(
  t: RunTask,
  defaults: RunDefaults,
  rows: ReturnType<typeof scoreRows>,
  autoSoFar: Map<CliMayteKind, number>,
): RunSetting {
  const kind = climayteKind(t.kind) ?? defaults.kind
  const priority = climaytePriority(t.priority) ?? defaults.priority
  // Validated for every task, a chat's included, though a chat's setting never needs it.
  const ownWords = ownerWordsOf(t.ownerWords)
  if (t.chat === true) return chatSetting(t, defaults, kind, priority)
  const { model, namedEffort, effort } = namedModelEffort(t, defaults)
  const why = (typeof t.modelWhy === 'string' && t.modelWhy.trim()) || defaults.why
  const words = ownerWordsFor(t, defaults, ownWords)
  const k = kind ?? 'code'
  const held = heldSetting(t, { model, effort, kind, priority }, words, why, k, rows)
  if (held) return held
  // A task that deploys or deletes live things is no sample for the scorecard's experiments: it
  // neither takes the Haiku trial nor counts toward the kind's exploring pick.
  const live = touchesLiveThings(`${t.title ?? ''}\n${t.prompt}`)
  const n = autoSoFar.get(k) ?? 0
  if (!live) autoSoFar.set(k, n + 1)
  const pick = pickConfig(k, rows, n, live)
  const unexplained =
    model || effort
      ? ` (${[model, namedEffort].filter(Boolean).join(' ')} was named but not held: that takes the owner's words, or a modelWhy for a setting cheaper than the pick)`
      : ''
  return { ...pick.config, kind: k, auto: true, reason: pick.reason + unexplained, priority }
}

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === ''

/** A chat task's setting: the model and effort it (or its run) names, else Opus at xhigh. Never the
 *  scorecard's: a person talks to it, and a chat the scorecard moved to a cheaper setting could not
 *  hold the conversation it was in (owner, 2026-10-04). A named value needs no `modelWhy` here. */
function chatSetting(
  t: RunTask,
  defaults: RunDefaults,
  kind: CliMayteKind | null,
  priority: number,
): RunSetting {
  const named = (v: unknown): boolean => !isBlank(v) && !isAutoSetting(v)
  const model = (named(t.model) ? climayteModel(t.model) : defaults.model) ?? climayteModel('opus')
  const effort =
    (named(t.effort) ? climayteEffort(t.effort) : defaults.effort) ??
    (model === HAIKU ? 'medium' : 'xhigh')
  return { model, effort, kind, auto: false, reason: 'a chat: Opus xhigh unless named', priority }
}

/** A queued worker for one task of a run. */
export function newWorker(
  t: RunTask,
  setting: RunSetting | undefined,
  size: CliMayteSizing | undefined,
  group: string,
  accounts: string[] | undefined,
  now: number,
): CliMayteWorker {
  const id = `w-${hex(8)}`
  // A sealed task runs in an empty folder named for its worker, so the storage pass clears it with
  // the worker's other files. A temp folder per visit was never removed: 854 by 2026-10-08.
  const cwd = t.sealed ? join(SEALED, id) : t.cwd
  if (t.sealed) mkdirSync(cwd, { recursive: true })
  return {
    id,
    group,
    title: t.title?.trim() || t.prompt.replace(/\s+/g, ' ').trim().slice(0, 60),
    cwd,
    prompt: t.prompt,
    pending: [],
    model: setting?.model ?? null,
    effort: setting?.effort ?? null,
    kind: setting?.kind ?? null,
    ...(setting?.auto ? { auto: true } : {}),
    ...(t.chat === true ? { chat: true } : {}),
    ...(t.chat === true && t.desk ? { desk: t.desk } : {}),
    ...(t.sealed ? { sealed: sealedOf(t.sealed) } : {}),
    ...(t.check?.trim() ? { check: t.check.trim() } : {}),
    ...(size ? { size } : {}),
    priority: setting?.priority ?? 0,
    accounts: accounts?.length ? accounts : null,
    status: 'queued',
    sessionId: crypto.randomUUID(),
    accountId: null,
    attempts: [],
    result: null,
    results: [],
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** How long a dispatch counts as a repeat of the same group's earlier one (repeatOf). */
export const REPEAT_WINDOW_MS = 10 * 60_000

/**
 * The worker an earlier dispatch already made for this task, or null: same group, same title, same
 * prompt and folder, made within REPEAT_WINDOW_MS, and not cancelled or failed (sending one of those
 * again is a retry). Field note 62 (2026-10-02): told by its MCP view that 16 workers it had just
 * POSTed did not exist, an orchestrator sent them twice more; 48 ran and 32 were cancelled.
 */
export function repeatOf(t: RunTask, group: string, now: number): CliMayteWorker | null {
  const title = t.title?.trim() || t.prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
  for (const w of workers.values())
    if (
      w.group === group &&
      w.title === title &&
      w.prompt === t.prompt &&
      w.cwd === t.cwd &&
      now - w.createdAt <= REPEAT_WINDOW_MS &&
      w.status !== 'cancelled' &&
      w.status !== 'failed'
    )
      return w
  return null
}

/** An account the task may use must exist: an unknown one used to make a task that waited forever
 *  for an account that will never sign in (fuzz, 2026-10-02). A signed-out instance is known, and
 *  its task waits for the sign-in as before. */
export function assertKnownAccounts(accounts: string[] | undefined): void {
  if (!accounts?.length) return
  let pool: CliMayteAccount[] = []
  try {
    pool = accountsProvider()
  } catch {
    // the instance store below still knows every account
  }
  const unknown = accounts.filter((id) => !pool.some((a) => a.id === id) && !getCliInstance(id))
  if (unknown.length)
    throw new Error(
      `accounts: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a CLI instance' : 'are not CLI instances'} (give CLI instance ids; climayte_run also takes numbers)`,
    )
}

/** A dispatch's top-level `model`, `effort`, `kind`, `priority`, `modelWhy` and `ownerWords` as its
 *  tasks' defaults (climayteRun). Throws on a value that is not one. */
export function runDefaultsOf(input: Parameters<typeof climayteRun>[0]): RunDefaults {
  const groupAuto = isAutoSetting(input.model)
  return {
    auto: groupAuto,
    why: (typeof input.modelWhy === 'string' && input.modelWhy.trim()) || null,
    ownerWords: ownerWordsOf(input.ownerWords),
    model: groupAuto ? null : climayteModel(input.model),
    effort: groupAuto || isAutoSetting(input.effort) ? null : climayteEffort(input.effort),
    kind: climayteKind(input.kind),
    priority: climaytePriority(input.priority) ?? 0,
  }
}

/** Each task's setting (runSetting), in order, once it is checked runnable (assertRunnable); a
 *  setting that throws is refused naming its task (climayteRun). */
export function taskSettings(tasks: RunTask[], defaults: RunDefaults): RunSetting[] {
  const rows = scoreRows(workers.values())
  const autoSoFar = autoPicksSoFar()
  return tasks.map((t, i) => {
    assertRunnable(t, i)
    try {
      return runSetting(t, defaults, rows, autoSoFar)
    } catch (err) {
      throw new Error(`task ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/** What climayteRun answers. */
export interface RunReply {
  group: string
  workers: Array<CliMayteWorkerView & { repeat?: true }>
  repeated?: number
  note?: string
}

/** climayteRun's answer, one row per task in the caller's order: the earlier worker, marked
 *  `repeat`, for a task an earlier dispatch made (`repeats`), else the one made now (`made`, for
 *  the tasks at `fresh`), and a note when any task was a repeat. */
export function runReply(
  group: string,
  repeats: Array<CliMayteWorker | null>,
  fresh: number[],
  made: CliMayteWorker[],
  now: number,
): RunReply {
  const madeFor = new Map(fresh.map((i, k) => [i, made[k] as CliMayteWorker]))
  const views = repeats.map((earlier, i) => {
    if (earlier) return { ...toView(earlier, now), repeat: true as const }
    return toView(madeFor.get(i) as CliMayteWorker, now)
  })
  const repeated = repeats.filter(Boolean).length
  if (!repeated) return { group, workers: views }
  return {
    group,
    workers: views,
    repeated,
    note: `${repeated} of ${repeats.length} task(s) repeat what this group was sent in the last ${REPEAT_WINDOW_MS / 60_000} minutes (same title, prompt and folder): those rows are the workers already made (repeat: true), and nothing new was started for them. Send copies: true to run them again.`,
  }
}

/** A dispatch with a task too big for one window (sizeTask): nothing was started. */
export class CliMayteSplitNeeded extends Error {
  constructor(
    message: string,
    readonly tasks: Array<{
      task: number
      title: string
      expected: number
      window: number
      pieces: number
    }>,
  ) {
    super(message)
  }
}

/** Sizes every task of a dispatch against the accounts it may use (climayte-placement sizeTask), and
 *  refuses the whole dispatch, starting nothing, when a task is over SPLIT_SHARE of the biggest
 *  window unless it (or the dispatch) says `size: 'whole'`. `numbers`: each task's number in the
 *  caller's own list, when repeats were taken out of it (climayteRun). */
export function sizeTasks(
  input: Parameters<typeof climayteRun>[0],
  settings: Array<{ model: string | null; effort: string | null; kind: string | null }>,
  numbers: number[] = input.tasks.map((_, i) => i + 1),
): CliMayteSizing[] {
  const sizeOf = (v: unknown, where: string): 'auto' | 'whole' => {
    if (v === undefined || v === null || v === '') return 'auto'
    const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (s === 'auto' || s === 'whole') return s
    throw new Error(`${where}size must be auto or whole`)
  }
  const groupSize = sizeOf(input.size, '')
  let pool: CliMayteAccount[] = []
  try {
    pool = accountsProvider()
  } catch {
    // Sized against one Pro window.
  }
  const now = Date.now()
  const allowed = pool.filter((a) => !input.accounts?.length || input.accounts.includes(a.id))
  const open = allowed.filter((a) => !isWalledNow(walls[a.id], now))
  const { costOf, running, finishedSince } = placementState()
  const best = open
    .map((a) => ({
      a,
      room: Math.max(
        0,
        (fitPct(a) - projectedPct(a, running.get(a.id) ?? [], 0, finishedSince.get(a.id) ?? 0)) *
          (a.planFactor ?? 1),
      ),
    }))
    .sort((x, y) => y.room - x.room)[0]
  const tooBig: CliMayteSplitNeeded['tasks'] = []
  const sized = input.tasks.map((t, i): CliMayteSizing => {
    const s = settings[i] ?? { model: null, effort: null, kind: null }
    const cost = costOf(s)
    const fit = sizeTask(
      cost.pct,
      allowed.map((a) => a.planFactor ?? 1),
    )
    const n = numbers[i] ?? i + 1
    // A manager's cost is per wake (expectedCost) and it never splits: its wave does the work.
    // Nor does a chat: a person's message is not a task to cut into pieces.
    const whole =
      s.kind === 'manage' ||
      t.chat === true ||
      sizeOf(t.size, `task ${n}: `) === 'whole' ||
      groupSize === 'whole'
    const title = t.title?.trim() || firstLine(t.prompt, 60)
    if (fit.split && !whole)
      tooBig.push({
        task: n,
        title,
        expected: Math.round(cost.pct),
        window: fit.window,
        pieces: fit.pieces,
      })
    return {
      expected: Math.round(cost.pct * 10) / 10,
      basis: basisText(cost, s),
      window: fit.window,
      room: best ? Math.round(best.room) : null,
      roomOn: best ? acctLabel(best.a) : null,
    }
  })
  if (tooBig.length) {
    const each = tooBig
      .map(
        (t) =>
          `task ${t.task} "${t.title}" is expected to use about ${t.expected}% of a Pro 5-hour window, and the biggest window it may use holds ${t.window}%: split it into about ${t.pieces} pieces`,
      )
      .join('; ')
    throw new CliMayteSplitNeeded(
      `Nothing started: split needed. ${each}. A task over half a window often runs out partway and moves accounts, re-writing its whole conversation into a cold cache. Send each piece as its own self-contained task with its own proof of done (keep pieces that touch the same files in order, one after another), or send it again with size: 'whole' to run it as it is.`,
      tooBig,
    )
  }
  return sized
}
