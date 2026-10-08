// Project Hydra as a connector for the New screen's project grid (owner, 2026-10-08: "the Project Selector put in
// Agent Hydra"). Project Hydra is a separate, optional tool (`python ph.py <verb>`): most people running AgentHydra
// do not have it, and then nothing here runs. Found through PROJECTHYDRA_HOME or the `projecthydra` MCP entry in
// ~/.claude.json, it says which of its projects are placed on this PC (`ph next --all --json`: key, path, group,
// mark), and its registry (registry/projects/*.yaml) gives each one's display name and logo (icons/).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export interface HydraLocation {
  python: string
  ph: string
  root: string
}

export interface HydraProject {
  key: string
  path: string
  name: string
  group: string | null
  /** The logo's file inside Hydra's icons folder, or null. */
  iconFile: string | null
}

export interface HydraRead {
  projects: HydraProject[]
  problem: string | null
}

/** Marks for projects their owner stopped working on: not offered for a new chat. */
const SET_ASIDE = new Set(['retired', 'archive'])
const PH_TIMEOUT_MS = 10_000

/** `<python> <folder>/ph.py mcp --connect`, either path quoted or not (an unquoted one may hold spaces). */
const HELPER = /^\s*(?:"([^"]+)"|(.+?\.exe|\S+))\s+(?:"([^"]*ph\.py)"|(.+?ph\.py))(?=\s|$)/i

export function parseHelper(helper: string): { python: string; ph: string } | null {
  const m = HELPER.exec(helper)
  if (!m) return null
  return { python: (m[1] ?? m[2])!, ph: (m[3] ?? m[4])! }
}

/** Where Project Hydra is installed, or null when it is not. `mainFile` is the Claude config file (~/.claude.json). */
export function findHydra(env: Record<string, string | undefined>, mainFile: string | null): HydraLocation | null {
  const own = env.PROJECTHYDRA_HOME
  if (own && existsSync(join(own, 'ph.py'))) return { python: env.PROJECTHYDRA_PYTHON || 'python', ph: join(own, 'ph.py'), root: resolve(own) }
  if (!mainFile) return null
  let config: { mcpServers?: Record<string, { headersHelper?: unknown; command?: unknown; args?: unknown }> } | null
  try {
    config = JSON.parse(readFileSync(mainFile, 'utf8'))
  } catch {
    return null
  }
  const entry = config?.mcpServers?.projecthydra
  if (!entry) return null
  let found: { python: string; ph: string } | null = null
  if (typeof entry.headersHelper === 'string') found = parseHelper(entry.headersHelper)
  if (!found && typeof entry.command === 'string' && Array.isArray(entry.args)) {
    const ph = entry.args.find((a): a is string => typeof a === 'string' && /ph\.py$/i.test(a))
    if (ph) found = { python: entry.command, ph }
  }
  if (!found || !existsSync(found.ph)) return null
  return { ...found, root: resolve(dirname(found.ph)) }
}

interface NextRow {
  key?: unknown
  path?: unknown
  group_name?: unknown
  mark?: unknown
}

/** The rows of `ph next --all --json` placed on this PC: a path here and no retired or archive mark. */
export function placedRows(rows: unknown): { key: string; path: string; group: string | null }[] {
  if (!Array.isArray(rows)) throw new Error('ph next answered something other than a list')
  const out: { key: string; path: string; group: string | null }[] = []
  for (const r of rows as NextRow[]) {
    if (typeof r?.key !== 'string' || typeof r.path !== 'string' || !r.path) continue
    if (typeof r.mark === 'string' && SET_ASIDE.has(r.mark)) continue
    out.push({ key: r.key, path: resolve(r.path), group: typeof r.group_name === 'string' && r.group_name ? r.group_name : null })
  }
  return out
}

interface RegistryEntry {
  name: string
  icon: string | null
}

/** Each registry entry's display name and logo file name, by key. A file that does not parse is skipped. */
export function readRegistry(root: string): Map<string, RegistryEntry> {
  const dir = join(root, 'registry', 'projects')
  const out = new Map<string, RegistryEntry>()
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml'))
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const y = Bun.YAML.parse(readFileSync(join(dir, f), 'utf8')) as {
        key?: unknown
        name?: unknown
        display_name?: unknown
        launch?: { name?: unknown; icon?: unknown }[]
      } | null
      const key = typeof y?.key === 'string' ? y.key : f.slice(0, -'.yaml'.length)
      const launch = Array.isArray(y?.launch) ? y.launch[0] : undefined
      const name = [y?.display_name, launch?.name, y?.name].find((n): n is string => typeof n === 'string' && n.trim() !== '')
      out.set(key, { name: name ?? key, icon: typeof launch?.icon === 'string' ? launch.icon : null })
    } catch {
      // floor-ok: one bad entry costs its own name and logo, not the list
    }
  }
  return out
}

/** A logo file inside Hydra's icons folder, or null (missing, or a name that climbs out of the folder). */
export function iconFileIn(root: string, icon: string | null): string | null {
  if (!icon) return null
  const icons = resolve(root, 'icons')
  const file = resolve(icons, icon)
  if (!file.startsWith(icons + sep)) return null
  try {
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

/** Runs `ph <args>` in Hydra's folder: no shell, no window, killed after PH_TIMEOUT_MS. */
async function runPh(at: HydraLocation, args: string[], env: Record<string, string | undefined>): Promise<string> {
  const proc = Bun.spawn([at.python, at.ph, ...args], {
    cwd: at.root,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, PH_TIMEOUT_MS)
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (timedOut) throw new Error(`ph ${args[0]} took longer than ${PH_TIMEOUT_MS / 1000}s`)
    if (code !== 0) throw new Error(`ph ${args[0]} exited ${code}: ${err.trim().split('\n').at(-1) ?? ''}`.trim())
    return out
  } finally {
    clearTimeout(timer)
  }
}

/** The projects Project Hydra has placed on this PC, named and with their logos. */
export async function readHydra(at: HydraLocation, env: Record<string, string | undefined>): Promise<HydraRead> {
  let rows: { key: string; path: string; group: string | null }[]
  try {
    rows = placedRows(JSON.parse(await runPh(at, ['next', '--all', '--json'], env)))
  } catch (err) {
    return { projects: [], problem: (err as Error).message }
  }
  const registry = readRegistry(at.root)
  const projects = rows.map((r) => {
    const entry = registry.get(r.key)
    return { ...r, name: entry?.name ?? r.key, iconFile: iconFileIn(at.root, entry?.icon ?? null) }
  })
  return { projects, problem: projects.length ? null : 'Project Hydra places no project on this PC (no host file for it in its registry?)' }
}
