// server/src/hydra-family.ts - AgentHydra's side of the Hydra family contract (hydra-family/1).
//
// The family is the products on this PC that should know each other exist: AgentHydra (every
// Claude/Codex account and agent session), Project Hydra (every codebase, its state and
// marketability) and MonkeyWerx (the in-house marketing platform). Each member writes ONE manifest
// file, its own and nobody else's, into a shared folder; the others read it to learn what the
// member is for and how to reach it. No member needs another to run: an absent or silent peer is
// reported as that, never raised as an error.
//
// Kept free of the database and the daemon's boot state, so the stdio MCP server loads it too.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from './config'
import { spawnCaptured } from './core/process'

export const FAMILY_SCHEMA = 'hydra-family/1'
export const SELF = 'agenthydra'

/** The longest a liveness probe waits on a peer: a slow peer is a down peer, not a slow answer. */
export const PROBE_TIMEOUT_MS = 1500
/** The longest a peer's command line gets to answer one call. */
export const CLI_TIMEOUT_MS = 20_000

/** Where this server is reached over MCP: `mcp-register.ts`'s MCP_PATH, repeated because that file
 *  opens the database on import and the stdio MCP server must not. A test pins the two together. */
const MCP_PATH = '/api/mcp'

export type FamilyMcp =
  | { transport: 'http'; url: string }
  | { transport: 'stdio'; command: string[]; cwd?: string }

export interface FamilyManifest {
  schema: string
  name: string
  title: string
  what: string
  ask_it_for: string[]
  mcp: FamilyMcp | null
  http: string | null
  health: string | null
  cli: string[] | null
  version: string
  updated_at: string
}

const SELF_WHAT =
  'Every Claude and Codex account and agent session on this PC: quota, background workers and cheap batch work.'

/** The three members and what each is for, so an absent one can still be named to an agent that
 *  has never met it. A member that is installed speaks for itself through its manifest instead. */
const MEMBERS = [
  {
    name: 'projecthydra',
    title: 'Project Hydra',
    what: 'Every codebase on this PC: its state, launch rows and how marketable it is.',
  },
  {
    name: SELF,
    title: 'AgentHydra',
    what: SELF_WHAT,
  },
  {
    name: 'monkeywerx',
    title: 'MonkeyWerx',
    what: 'The in-house marketing platform: form outreach, social posting, email, Reddit and Google Business Profile.',
  },
] as const

/** The folder every member keeps its manifest in. */
export function familyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HYDRA_FAMILY_DIR?.trim() || join(homedir(), '.hydra-family')
}

/** The manifest this server publishes for the daemon at `base` (its HTTP root). */
export function selfManifest(base: string, now: Date = new Date()): FamilyManifest {
  const http = base.replace(/\/+$/, '')
  return {
    schema: FAMILY_SCHEMA,
    name: SELF,
    title: 'AgentHydra',
    what: SELF_WHAT,
    ask_it_for: [
      'which Claude and Codex accounts exist and how much quota each has left',
      'which agent sessions are running or ran lately, and in which folder',
      'running self-contained Claude-quality work in the background on idle accounts (CliMayte)',
      'cheap wide batch work on other models (HSwarm)',
    ],
    mcp: { transport: 'http', url: `${http}${MCP_PATH}` },
    http,
    health: `${http}/api/health`,
    cli: null,
    version: VERSION,
    updated_at: now.toISOString(),
  }
}

/** Write this member's manifest: a temp file beside it, then a rename, so a reader never sees half
 *  a file. Throws; the daemon logs it and carries on. Returns the file written. */
export function writeSelfManifest(
  base: string,
  dir: string = familyDir(),
  now: Date = new Date(),
): string {
  const target = join(dir, `${SELF}.json`)
  const tmp = `${target}.${process.pid}.tmp`
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify(selfManifest(base, now), null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return target
}

/**
 * Is this daemon barred from the machine-wide family folder? Its port dies with it, so a scratch
 * daemon (a side-run store, or a whole scratch AGENTHYDRA_HOME as the smoke and e2e runs use) that
 * wrote there would leave every peer reading AgentHydra as down. The same rule the runtime pointer
 * and the MCP registration follow. HYDRA_FAMILY_DIR names a folder of its own, so it stays allowed.
 */
export function familyWriteBarred(
  primary: boolean,
  homeRelocated: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.HYDRA_FAMILY_DIR?.trim()) return false
  return !primary || homeRelocated
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

function mcpOf(v: unknown): FamilyMcp | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (m.transport === 'http' && typeof m.url === 'string') return { transport: 'http', url: m.url }
  if (m.transport === 'stdio' && strings(m.command).length > 0)
    return {
      transport: 'stdio',
      command: strings(m.command),
      ...(typeof m.cwd === 'string' ? { cwd: m.cwd } : {}),
    }
  return null
}

/** A member's manifest, or null when it is missing, unreadable or another schema: not installed. */
export function readManifest(name: string, dir: string = familyDir()): FamilyManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.schema !== FAMILY_SCHEMA) return null
  const cli = strings(m.cli)
  return {
    schema: FAMILY_SCHEMA,
    name,
    title: text(m.title) || name,
    what: text(m.what),
    ask_it_for: strings(m.ask_it_for),
    mcp: mcpOf(m.mcp),
    http: text(m.http) || null,
    health: text(m.health) || null,
    cli: cli.length > 0 ? cli : null,
    version: text(m.version),
    updated_at: text(m.updated_at),
  }
}

/** Do a command line's executable and script exist? How a member with no health URL is tested. */
function cliPresent(cli: string[]): boolean {
  const [exe, ...rest] = cli
  if (!exe) return false
  if (/[\\/]/.test(exe) ? !existsSync(exe) : !Bun.which(exe)) return false
  const script = rest.find((a) => /[\\/]|\.(py|[cm]?[jt]s)$/i.test(a))
  return script === undefined || existsSync(script)
}

/** Is a member up: its health URL answers 2xx in time, or, with none, its command line exists. */
export async function isUp(
  m: FamilyManifest,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!m.health) return m.cli !== null && cliPresent(m.cli)
  try {
    const res = await fetch(m.health, { signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}

export interface FamilyMember {
  name: string
  title: string
  what: string
  ask_it_for: string[]
  /** Whether the member has published a manifest here; `up` says whether it answers. */
  installed: boolean
  up: boolean
  mcp: FamilyMcp | null
  http: string | null
  cli: string[] | null
  version: string | null
}

export interface FamilyAnswer {
  schema: typeof FAMILY_SCHEMA
  self: string
  members: FamilyMember[]
}

/** The three members and whether each is up. `selfBase` is the daemon this server speaks for. */
export async function familyAnswer(
  selfBase: string,
  dir: string = familyDir(),
): Promise<FamilyAnswer> {
  const members = await Promise.all(
    MEMBERS.map(async (known): Promise<FamilyMember> => {
      const m = known.name === SELF ? selfManifest(selfBase) : readManifest(known.name, dir)
      if (!m)
        return {
          name: known.name,
          title: known.title,
          what: known.what,
          ask_it_for: [],
          installed: false,
          up: false,
          mcp: null,
          http: null,
          cli: null,
          version: null,
        }
      return {
        name: known.name,
        title: m.title,
        what: m.what,
        ask_it_for: m.ask_it_for,
        installed: true,
        up: await isUp(m),
        mcp: m.mcp,
        http: m.http,
        cli: m.cli,
        version: m.version || null,
      }
    }),
  )
  return { schema: FAMILY_SCHEMA, self: SELF, members }
}

export type CliAnswer = { ok: true; json: unknown } | { ok: false; reason: string }

/** Run a peer's command line with `args` and parse JSON from its stdout. Never throws: a peer that
 *  cannot start, answers late, exits nonzero or prints no JSON is `unavailable: <why>`. */
export async function runCli(
  cli: string[],
  args: string[],
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<CliAnswer> {
  const unavailable = (why: string): CliAnswer => ({ ok: false, reason: `unavailable: ${why}` })
  const run = await spawnCaptured([...cli, ...args], { timeoutMs })
  if (run.timedOut) return unavailable(`no answer within ${Math.round(timeoutMs / 1000)} s`)
  if (run.code === null) return unavailable(`could not start ${cli[0]}`)
  if (run.code !== 0)
    return unavailable(run.stderr.trim().split(/\r?\n/)[0] || `exited with code ${run.code}`)
  try {
    return { ok: true, json: JSON.parse(run.stdout) }
  } catch {
    return unavailable('its answer was not JSON')
  }
}

/** Which project a folder belongs to, asked of Project Hydra's command line: its JSON as it
 *  answers, or `{ available: false, reason }` when it is not installed or fails. */
export async function projectContext(cwd: string, dir: string = familyDir()): Promise<unknown> {
  const m = readManifest('projecthydra', dir)
  if (!m) return { available: false, reason: 'unavailable: Project Hydra is not installed here' }
  if (!m.cli)
    return { available: false, reason: 'unavailable: Project Hydra offers no command line' }
  const run = await runCli(m.cli, ['which', cwd, '--json'])
  return run.ok ? run.json : { available: false, reason: run.reason }
}
