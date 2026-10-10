// The machine doctor's Project Hydra checks (box-doctor.ts runs them where Project Hydra is
// installed): is the registry of every codebase on this PC true to the disk, and are the sweeps that
// feed it still running?
//
// Project Hydra stays the only reader of its own registry, record and index (the Hydra family
// contract: a member is reached through the command line its manifest names, never by reading its
// files), so it answers `ph facts --json` (schema projecthydra.facts/1) with raw facts and no
// verdicts, and every judgement lives here. A fact Project Hydra could not take comes back null or
// as a section `{ error }`: that section is then not checked, so its open incidents hold. Messages
// carry no counts or ages (an incident's signature includes its text); those go in `detail`.
import type { BoxFinding } from './box-doctor'
import type { RootTarget } from './box-doctor-roots'
import { readManifest, runCli } from './hydra-family'

const STALE_SWEEP_DAYS = 14
const STALE_INSTRUMENT_DAYS = 14
const LOKI_STALE_DAYS = 3
const SCRATCH_STALE_DAYS = 3
const FACTS_TIMEOUT_MS = 150_000
/** The facts walk every search root; once an hour is plenty for a registry that changes by hand. */
export const HYDRA_FACTS_EVERY_MS = 60 * 60_000

// An outside JSON document; every read below is guarded.
type Json = any

export interface HydraCheck {
  findings: BoxFinding[]
  /** Exact keys and `prefix:` families this pass could look at; see BoxDoctorReport.checked. */
  checked: string[]
}

const days = (stamp: unknown, now: number): number | null => {
  const t = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
  return Number.isFinite(t) ? (now - t) / 86_400_000 : null
}
const list = (v: unknown): Json[] => (Array.isArray(v) ? v : [])
const named = (items: Json[], pick: (x: Json) => unknown, max = 8) =>
  items.slice(0, max).map(pick).join(', ') +
  (items.length > max ? `, +${items.length - max} more` : '')

/** What each Project Hydra collector needs, and what reads `-` without it. */
const COLLECTORS: ReadonlyArray<{ tool: string; level: 'problem' | 'note'; loses: string }> = [
  {
    tool: 'git',
    level: 'problem',
    loses:
      'every git-derived column (dirty, ahead/behind, last commit, tags, language coverage); ph discover cannot resolve remotes',
  },
  { tool: 'arkitect.mjs', level: 'note', loses: 'the portable Architect scans (ph architect)' },
  { tool: 'bun', level: 'note', loses: 'the portable Architect scans (ph architect)' },
  {
    tool: 'gh or GITHUB_TOKEN',
    level: 'note',
    loses: 'scan --deep (visibility, users, releases) and the public to-do guard',
  },
  { tool: '7z', level: 'note', loses: 'solid compression in ph archive (it falls back to .zip)' },
  { tool: 'schtasks', level: 'note', loses: 'the sweep cadence check' },
]

const LOCATE: Record<string, string> = {
  MOVED: 'is registered at one path but its checkout is somewhere else (fix: ph locate --apply)',
  AMBIGUOUS: 'matches more than one checkout on this machine',
  MISSING: 'is registered at a path that is not on this machine',
  NOT_GIT: 'is registered at a path that is not a git checkout',
  WRONG:
    "is registered with a remote that is not among its checkout's remotes, so every statement about it is about a different repository",
}

/** Every Project Hydra judgement over one facts document. Pure. */
export function hydraFindings(facts: Json, now = Date.now()): HydraCheck {
  const findings: BoxFinding[] = []
  const checked: string[] = []
  const section = (name: string): Json | null => {
    const s = facts?.[name]
    return s && typeof s === 'object' && !('error' in s && s.error && !Array.isArray(s)) ? s : null
  }
  const problem = (key: string, message: string, detail?: string) =>
    findings.push({ key: `hydra:${key}`, level: 'problem', message, ...(detail ? { detail } : {}) })
  const note = (key: string, message: string, detail?: string) =>
    findings.push({ key: `hydra:${key}`, level: 'note', message, ...(detail ? { detail } : {}) })
  const empty = (why: string) =>
    `${why} - every registry check below measured an empty fleet, not a clean one.`

  const paths = section('paths')
  if (paths) {
    checked.push('hydra:registry')
    if (!paths.registry_dir_exists)
      problem('registry', empty(`Project Hydra's registry is missing at ${paths.registry_dir}`))
    else if (paths.project_files === null)
      problem(
        'registry',
        empty(
          `Project Hydra's registry projects folder could not be listed under ${paths.registry_dir}`,
        ),
      )
    else if (paths.project_files === 0)
      problem(
        'registry',
        empty(`Project Hydra's registry holds no project files under ${paths.registry_dir}`),
      )
  }

  const roots = section('search_roots')
  if (roots) {
    checked.push('hydra:search-roots')
    const all = list(roots.roots)
    const nothing =
      'so every discovery sweep finds nothing because there is nothing to search, not because the fleet is clean'
    if (!roots.host_file_exists)
      problem('search-roots', `This PC has no Project Hydra host file, ${nothing}.`)
    else if (all.length === 0)
      problem(
        'search-roots',
        `This PC's Project Hydra host file names no search roots, ${nothing}.`,
      )
    else if (!all.some((r) => r.exists))
      problem('search-roots', `None of this PC's Project Hydra search roots exist, ${nothing}.`)
  }

  const walk = section('walk')
  const walkWhole = Boolean(walk?.complete) && list(walk?.unreadable).length === 0

  const elsewhere = section('known_elsewhere')
  if (elsewhere) {
    checked.push('hydra:elsewhere:')
    for (const key of list(elsewhere.found_here))
      problem(
        `elsewhere:${key}`,
        `${key}, registered as living only on another machine, now exists on this one: promote it to a real registry entry.`,
      )
  }

  const locate = section('locate')
  if (locate) {
    // A walk that ran out of time or hit an unreadable folder may have missed the checkout a
    // MOVED or AMBIGUOUS answer needs: report what it found, resolve nothing on it.
    if (walkWhole) checked.push('hydra:locate:', 'hydra:site:')
    for (const f of list(locate.findings)) {
      const why = LOCATE[f?.status]
      if (why)
        problem(
          `locate:${f.key}`,
          `Project Hydra's ${f.key} ${why}: ${f.registered}.`,
          [f.detail, ...list(f.found)].filter(Boolean).join('; '),
        )
    }
    for (const s of list(locate.site_missing))
      problem(`site:${s.key}`, `${s.key}'s site_path ${s.site_path} is not on this machine.`)
    const unbound = list(locate.findings).filter((f) => f?.status === 'UNBOUND')
    if (unbound.length)
      note(
        'unbound',
        "Some registered projects name a root this PC's host file lacks (they are another machine's).",
        named(unbound, (f) => f.key),
      )
  }
  if (walk && !walkWhole)
    note(
      'walk',
      'The search walk did not cover everything (it ran out of time or met unreadable folders), so registry answers resting on it are partial.',
      [walk.complete ? '' : 'ran out of time', ...list(walk.unreadable).slice(0, 5)]
        .filter(Boolean)
        .join('; '),
    )

  if (Array.isArray(facts?.archived_to)) {
    checked.push('hydra:archive:')
    for (const a of facts.archived_to as Json[])
      if (a?.state === 'missing')
        problem(
          `archive:${a.key}`,
          `The registry says ${a.key}'s archive is at ${a.archive} and nothing is there.`,
        )
    const away = (facts.archived_to as Json[]).filter((a) => a?.state === 'unreachable')
    if (away.length)
      note(
        'archive-away',
        'Some archives sit on a drive that is not on this PC, so they were not checked.',
        named(away, (a) => `${a.key} (${a.root})`),
      )
  }

  const unregistered = section('unregistered')
  if (unregistered) {
    if (walkWhole) checked.push('hydra:unregistered')
    const fresh = list(unregistered.paths)
    if (fresh.length)
      problem(
        'unregistered',
        'Repos on disk are not in the registry (run: ph discover).',
        named(fresh, (p) => p),
      )
  }

  const nested = section('nested')
  if (nested) {
    if (list(nested.unreadable).length === 0) checked.push('hydra:nested', 'hydra:scratch')
    const inside = list(nested.nested)
    if (inside.length)
      problem(
        'nested',
        'Checkouts nested inside registered repos are not registered.',
        named(inside, (n) => `${n.path} (inside ${n.owner})`),
      )
    // A test run that finished an hour ago is not litter: only a scratch root untouched for three
    // days is (Odin's first doctor called one live test run's 294 fixtures garbage).
    const stale = list(nested.scratch_roots).filter(
      (r) => (days(r?.newest_mtime, now) ?? 0) > SCRATCH_STALE_DAYS,
    )
    if (stale.length)
      problem(
        'scratch',
        'Abandoned test-scratch folders full of throwaway git repos sit inside registered repos.',
        named(stale, (r) => `${r.path} (${r.count})`),
      )
  }

  const scans = section('scans')
  if (scans) {
    checked.push('hydra:scan-prev', 'hydra:scan-orphans')
    if (list(scans.prev).length)
      problem(
        'scan-prev',
        'Leftover scans/*.prev folders mark interrupted rescans; the next scan of each project restores or clears it.',
        named(list(scans.prev), (n) => n),
      )
    if (list(scans.orphans).length)
      problem(
        'scan-orphans',
        'Scan folders under scans/ match no registry key, so every fleet number leaves them out: re-file each under its key, or delete it.',
        named(list(scans.orphans), (n) => n),
      )
  }

  const sweep = section('sweep_evidence')
  if (sweep) {
    if (list(sweep.sarif_unreadable).length === 0) checked.push('hydra:sweep-sarif')
    if (Array.isArray(sweep.runs_dropped) && sweep.runs_dropped.length === 0)
      checked.push('hydra:sweep-runs')
    const sarif = list(sweep.sarif).filter((s) => days(s?.at, now) !== null)
    const newest = sarif.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
    const sarifAge = newest ? days(newest.at, now) : null
    if (sarifAge !== null && sarifAge > STALE_SWEEP_DAYS)
      problem(
        'sweep-sarif',
        `The external sweep is stale: the newest scans/*/findings.sarif is over ${STALE_SWEEP_DAYS} days old, and every fleet number reads it.`,
        `${newest.key} at ${newest.at}`,
      )
    const runs = list(sweep.runs).filter((r) => days(r?.at, now) !== null)
    const run = runs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
    const runAge = run ? days(run.at, now) : null
    if (runAge !== null && runAge > STALE_SWEEP_DAYS)
      problem(
        'sweep-runs',
        `Nothing has swept Project Hydra for over ${STALE_SWEEP_DAYS} days: the newest runs/ record is that old.`,
        `${run.command} at ${run.at}`,
      )
  }

  const record = section('record')
  if (record) {
    checked.push('hydra:record-unreadable:', 'hydra:record-bad-lines')
    const files = list(record.files)
    for (const f of files.filter((f) => f?.error))
      problem(
        `record-unreadable:${f.rel}`,
        `Project Hydra's record file ${f.rel} cannot be read: its readings are lost to every question.`,
        String(f.error),
      )
    const bad = files.filter((f) => (f?.bad_lines ?? 0) > 0)
    const ownBad = bad.reduce((n, f) => n + f.bad_lines, 0)
    if (bad.length)
      problem(
        'record-bad-lines',
        "Project Hydra's record holds unreadable lines, which the index skips.",
        named(bad, (f) => `${f.rel} (${f.bad_lines})`),
      )
    const index = record.index
    if (index?.exists && !index.error && index.absorbed && typeof index.absorbed === 'object') {
      checked.push('hydra:record-rewritten:', 'hydra:index-bad-lines')
      const behind: string[] = []
      for (const f of files) {
        const offset = Number(index.absorbed[f.rel] ?? 0)
        if (typeof f.size !== 'number') continue
        if (f.size < offset)
          problem(
            `record-rewritten:${f.rel}`,
            `Project Hydra's append-only record file ${f.rel} is shorter than the index has read: something rewrote it, and the index must be rebuilt (ph record rebuild).`,
            `${f.size} bytes, ${offset} absorbed`,
          )
        else if (f.size > offset) behind.push(f.rel)
      }
      if (behind.length)
        note(
          'index-behind',
          "Project Hydra's index is behind its record; the next reader absorbs the difference.",
          named(behind, (r) => r),
        )
      if ((index.bad_lines_total ?? 0) > ownBad)
        problem(
          'index-bad-lines',
          "Project Hydra's index skipped unreadable lines from another machine's summary file.",
          `${index.bad_lines_total - ownBad} line(s)`,
        )
    }
  }

  const instruments = section('instruments')
  if (
    instruments &&
    !instruments.error &&
    instruments.index_exists &&
    Array.isArray(instruments.items)
  ) {
    checked.push('hydra:instrument:')
    const never: string[] = []
    for (const item of instruments.items as Json[]) {
      const age = days(item?.newest, now)
      if (item?.newest == null) never.push(item?.name)
      else if (age !== null && age > STALE_INSTRUMENT_DAYS) {
        const message = `Project Hydra's instrument ${item.name} has not been read for over ${STALE_INSTRUMENT_DAYS} days`
        if (item.deep)
          note(
            `instrument-deep:${item.name}`,
            `${message} (deep: it runs only when asked).`,
            item.newest,
          )
        else
          problem(
            `instrument:${item.name}`,
            `${message}, and the board answers from it.`,
            item.newest,
          )
      }
    }
    if (never.length)
      note(
        'instruments-unread',
        'Some Project Hydra instruments have never been read on any machine.',
        named(never, (n) => n),
      )
  }

  const loki = section('loki')
  if (loki) {
    const stamps = [loki.run_at, loki.folder_newest].filter(
      (s) => days(s, now) !== null,
    ) as string[]
    if (stamps.length) {
      checked.push('hydra:loki')
      const newest = stamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0] as string
      if ((days(newest, now) ?? 0) > LOKI_STALE_DAYS)
        problem(
          'loki',
          `Loki has not swept for over ${LOKI_STALE_DAYS} days, so chats are not being checked for unfinished work.`,
          newest,
        )
    }
  }

  const cadence = section('cadence')
  if (cadence) {
    const task = cadence.task ?? 'the maintain task'
    if (['running', 'failing', 'paused', 'absent'].includes(cadence.state))
      checked.push('hydra:cadence')
    if (cadence.state === 'absent')
      problem(
        'cadence',
        `The scheduled task ${task} is not registered, so Project Hydra's maintain pass (scan, codex, export) never runs.`,
      )
    else if (cadence.state === 'failing')
      problem(
        'cadence',
        `The scheduled task ${task} fires on schedule and fails, so Project Hydra's maintain pass never completes.`,
        cadence.detail,
      )
    else if (cadence.state === 'paused')
      note(
        'cadence-paused',
        `The scheduled task ${task} is paused: the board, codex and exports go stale until it is resumed.`,
        cadence.detail,
      )
    if (
      typeof cadence.command === 'string' &&
      !cadence.command.includes('projecthydra.tools.maintain')
    )
      note(
        'cadence-command',
        `The scheduled task ${task} does not run projecthydra.tools.maintain.`,
        cadence.command.slice(0, 160),
      )
  }

  const pre = section('prerequisites')
  if (pre) {
    checked.push('hydra:prereq')
    const missing = [
      pre.pyyaml === false && 'PyYAML (every registry read needs it)',
      pre.pytest === false && 'pytest (the gate)',
      pre.git === false && 'git (every project fact is read with it)',
    ].filter(Boolean)
    if (missing.length)
      problem(
        'prereq',
        "Project Hydra's prerequisites are missing on this PC: python -m pip install pyyaml pytest.",
        missing.join('; '),
      )
    if (pre.hook_state === 'installed' || pre.hook_state === 'missing') checked.push('hydra:hook')
    if (pre.hook_state === 'missing')
      problem(
        'hook',
        "Project Hydra's pre-push gate is not enforced in its clone, so a plain git push skips it: python -m projecthydra.doctor.check --install-hook.",
      )
  }

  const tools = facts?.tools
  if (tools && typeof tools === 'object' && !tools.error) {
    checked.push('hydra:collector:')
    for (const c of COLLECTORS) {
      if (tools[c.tool] || !(c.tool in tools)) continue
      const message = `${c.tool} is not on this PC, so Project Hydra loses ${c.loses}.`
      if (c.level === 'problem') problem(`collector:${c.tool}`, message)
      else note(`collector-optional:${c.tool}`, message)
    }
  }

  return { findings, checked }
}

/** The folders Project Hydra's facts name for the roots check: search roots, registered paths. */
export function hydraRoots(facts: Json): RootTarget[] {
  return list(facts?.roots)
    .filter((r) => typeof r?.path === 'string' && typeof r?.role === 'string')
    .map((r) => ({ role: r.role, path: r.path }))
}

/** Stamps only Project Hydra can read, for the clock check: its newest reading and newest commits. */
export function hydraClockStamps(facts: Json): Array<{ what: string; at: string }> {
  const ev = facts?.clock_evidence
  const out: Array<{ what: string; at: string }> = []
  if (typeof ev?.newest_reading?.ts === 'string')
    out.push({
      what: `Project Hydra's newest reading (by ${ev.newest_reading.host ?? '?'})`,
      at: ev.newest_reading.ts,
    })
  for (const c of list(ev?.commits))
    if (typeof c?.commit_at === 'string')
      out.push({ what: `${c.key}'s newest commit`, at: c.commit_at })
  return out
}

export type HydraFacts =
  | { installed: false }
  | { installed: true; facts: Json; at: number }
  | { installed: true; facts: null; reason: string }

/** `cached`: only what an earlier pass read (a GET never waits on a walk of every search root);
 *  `hourly`: refresh when older than an hour (the timer); `fresh`: ask now (POST /sync). */
export type HydraMode = 'cached' | 'hourly' | 'fresh'

let cache: { at: number; facts: Json } | null = null

/** Project Hydra's facts, asked of the command line its family manifest names. Not installed is
 *  its own answer: then there is nothing to watch. */
export async function readHydraFacts(mode: HydraMode, now = Date.now()): Promise<HydraFacts> {
  const m = readManifest('projecthydra')
  if (!m) return { installed: false }
  if (cache && (mode === 'cached' || (mode === 'hourly' && now - cache.at < HYDRA_FACTS_EVERY_MS)))
    return { installed: true, facts: cache.facts, at: cache.at }
  if (mode === 'cached')
    return {
      installed: true,
      facts: null,
      reason: 'not read yet: the doctor reads them on its next pass',
    }
  if (!m.cli)
    return { installed: true, facts: null, reason: 'Project Hydra offers no command line' }
  const run = await runCli(m.cli, ['facts', '--json', '--budget', '60'], FACTS_TIMEOUT_MS)
  if (!run.ok) return { installed: true, facts: null, reason: run.reason }
  if ((run.json as Json)?.schema !== 'projecthydra.facts/1')
    return {
      installed: true,
      facts: null,
      reason: 'ph facts answered a schema this doctor does not read',
    }
  cache = { at: now, facts: run.json }
  return { installed: true, facts: run.json, at: now }
}
