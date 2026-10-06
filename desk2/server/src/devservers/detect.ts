// Scaffold detection: a folder with no .devwebui gets a proposal from what it has: Claude Code Desktop's
// .claude/launch.json, else the dev scripts in package.json (+ a Vite config's port, + workspace packages). Ported
// from DevWebUI's detect.ts without its jsonc-parser, package-manager-detector, tinyglobby and yaml packages (desk2's
// server has none): a small comment stripper, a lockfile look, a bounded workspace walk and a `packages:` list reader.
// Best effort: the proposal is written as it stands and the file is the user's to edit.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ScaffoldProposal } from './contract'

export type DetectedProcess = ScaffoldProposal['processes'][number] & { color?: string; env?: Record<string, string>; runtime?: 'node' | 'bun' }

export interface Detection extends ScaffoldProposal {
  processes: DetectedProcess[]
  framework?: string
  /** How many more servers the folder had than the proposal keeps. */
  truncated?: number
}

// A script KEY that names a dev/serve entrypoint (dev, start, serve:web, ...).
const DEV_KEY_RE = /^(dev|start|serve|preview)(:[\w.-]+)?$/i

// A COMMAND that runs a dev/preview server (not a one-shot build or test).
const SERVER_CMD_RE =
  /\b(vite(?!\s+build)|next\s+(?:dev|start)|react-scripts\s+start|react-app-rewired\s+start|craco\s+start|rescripts\s+start|nuxt(?:\s+dev)?|nuxi\s+dev|astro\s+(?:dev|preview)|remix\s+(?:dev|vite:dev)|webpack(?:\s+serve|-dev-server)|vue-cli-service\s+serve|ng\s+serve|svelte-kit\s+dev|parcel(?!\s+build)|rsbuild\s+dev|rspack\s+serve|solid-start\s+dev|wrangler\s+(?:dev|pages\s+dev))\b/i

// Even a dev-looking key is not a server when the command is one of these.
const NOT_SERVER_RE = /\b(build|--check|--fail-on|eslint|prettier|tsc\b|typecheck|vitest|jest|mocha|playwright|cypress|test\b|lint\b|audit|codegen|generate)\b/i

// Framework -> display name + conventional dev port (the last resort when no port is written down).
const FRAMEWORK_DEFAULTS: Array<[RegExp, string, number]> = [
  [/\bastro\b/i, 'Astro', 4321],
  [/\bnext\b/i, 'Next.js', 3000],
  [/\b(nuxt|nuxi)\b/i, 'Nuxt', 3000],
  [/\bremix\b/i, 'Remix', 3000],
  [/\b(react-scripts|react-app-rewired|craco|rescripts)\s+start\b/i, 'React', 3000],
  [/\bwebpack(?:\s+serve|-dev-server)\b/i, 'Webpack', 8080],
  [/\bng\s+serve\b/i, 'Angular', 4200],
  [/\bvue-cli-service\b/i, 'Vue CLI', 8080],
  [/\bsvelte-kit\b/i, 'SvelteKit', 5173],
  [/\bparcel\b/i, 'Parcel', 1234],
  [/\brsbuild\b/i, 'Rsbuild', 3000],
  [/\bvite\b/i, 'Vite', 5173],
]

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#06b6d4', '#f97316', '#84cc16']

const MAX_PROCESSES = 12
const MAX_WORKSPACE_DIRS = 60
const MAX_WALK_DEPTH = 4

/** Lockfiles in the order package-manager-detector tries them; the run prefix each one means. */
const LOCKS: Array<[string, string]> = [
  ['bun.lock', 'bun run'],
  ['bun.lockb', 'bun run'],
  ['deno.lock', 'npm run'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm run'],
  ['npm-shrinkwrap.json', 'npm run'],
]

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function detectRunner(dir: string): string {
  for (const [lock, runner] of LOCKS) if (isFile(path.join(dir, lock))) return runner
  return 'npm run'
}

/** JSON with comments and trailing commas (launch.json is JSONC); null when it does not parse. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  try {
    return JSON.parse(out.replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return null
  }
}

function explicitPort(cmd: string): number | undefined {
  const m = cmd.match(/(?:--port[ =]|-p[ =]|\bPORT[ =])(\d{2,5})/i)
  return m ? Number(m[1]) : undefined
}

function frameworkOf(cmd: string): { name: string; port: number } | undefined {
  for (const [re, name, port] of FRAMEWORK_DEFAULTS) if (re.test(cmd)) return { name, port }
  return undefined
}

function viteConfigPort(dir: string): number | undefined {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs', 'vite.config.cts']) {
    const txt = readText(path.join(dir, f))
    if (txt === null) continue
    const m = txt.match(/server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/) ?? txt.match(/\bport\s*:\s*(\d{2,5})/)
    if (m) return Number(m[1])
  }
  return undefined
}

const sanitizeId = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'dev'

const titleCase = (s: string): string =>
  s
    .replace(/[-_:]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())

function prettyName(key: string): string {
  const stripped = key.replace(/^(dev|start|serve|preview):?/i, '').trim()
  return titleCase(stripped || key)
}

const prettyProjectName = (raw: string): string => titleCase(raw.replace(/^@[^/]+\//, '')) || 'Project'

type Pkg = { name?: string; scripts?: Record<string, string>; workspaces?: unknown }

function readPkg(dir: string): Pkg | null {
  const text = readText(path.join(dir, 'package.json'))
  if (text === null) return null
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''))
    return v && typeof v === 'object' ? (v as Pkg) : null
  } catch {
    return null
  }
}

type ScriptCtx = { runner: string; cfgPort: number | undefined; seen: Set<string>; runtimePin: 'node' | 'bun' | undefined; cwdRel?: string; label?: string }

/** Claims a process id: a workspace label prefixes it, a duplicate bumps a suffix. */
function uniqueProcessId(key: string, label: string | undefined, seen: Set<string>): string {
  const idBase = label ? (key === 'dev' ? label : `${label}-${key}`) : key
  let id = sanitizeId(idBase)
  for (let n = 2; seen.has(id); n++) id = sanitizeId(`${idBase}-${n}`)
  seen.add(id)
  return id
}

function scriptProcessName(key: string, label: string | undefined): string {
  if (!label) return prettyName(key)
  return titleCase(label) + (key === 'dev' ? '' : ` ${prettyName(key)}`)
}

/** An explicit flag wins, then Vite's config file, then the framework's default. */
function scriptPort(key: string, cmd: string, cfgPort: number | undefined, fw: { name: string; port: number } | undefined): number | undefined {
  const viteish = fw?.name === 'Vite' || /\bvite\b/i.test(cmd) || key === 'dev' || key === 'start'
  return explicitPort(cmd) ?? (viteish ? cfgPort : undefined) ?? fw?.port
}

function processFromScript(key: string, rawCmd: unknown, ctx: ScriptCtx): { process: DetectedProcess; framework?: string } | null {
  const cmd = String(rawCmd)
  if (!DEV_KEY_RE.test(key) && !SERVER_CMD_RE.test(cmd)) return null
  if (NOT_SERVER_RE.test(cmd)) return null
  const fw = frameworkOf(cmd)
  const port = scriptPort(key, cmd, ctx.cfgPort, fw)
  return {
    process: {
      id: uniqueProcessId(key, ctx.label, ctx.seen),
      name: scriptProcessName(key, ctx.label),
      command: `${ctx.runner} ${key}`,
      ...(ctx.cwdRel ? { cwd: ctx.cwdRel } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(ctx.runtimePin ? { runtime: ctx.runtimePin } : {}),
    },
    framework: fw?.name,
  }
}

function processesFromPackage(pkg: Pkg, pkgDir: string, runner: string, seen: Set<string>, runtimePin: 'node' | 'bun' | undefined, cwdRel?: string, label?: string): { processes: DetectedProcess[]; framework?: string } {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  const ctx: ScriptCtx = { runner, cfgPort: viteConfigPort(pkgDir), seen, runtimePin, cwdRel, label }
  const out: DetectedProcess[] = []
  let framework: string | undefined
  for (const [key, rawCmd] of Object.entries(scripts)) {
    const found = processFromScript(key, rawCmd, ctx)
    if (!found) continue
    if (found.framework && !framework) framework = found.framework
    out.push(found.process)
  }
  return { processes: out, framework }
}

// ---- Claude Code Desktop's .claude/launch.json -----------------------------
// Each configuration is runtimeExecutable + runtimeArgs, or a `program` run with node + `args`; `port` defaults to
// 3000; `cwd` is relative to the folder and may start with ${workspaceFolder}. One with only a `url` attaches to a
// server started elsewhere, so there is nothing to run.

type LaunchConfig = { name?: unknown; runtimeExecutable?: unknown; runtimeArgs?: unknown; program?: unknown; args?: unknown; port?: unknown; cwd?: unknown; env?: unknown; url?: unknown }

const LAUNCH_DEFAULT_PORT = 3000

const quoteArg = (a: string): string => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)

const words = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

function launchCommand(c: LaunchConfig): string | null {
  if (typeof c.runtimeExecutable === 'string' && c.runtimeExecutable.trim()) return [c.runtimeExecutable.trim(), ...words(c.runtimeArgs)].map(quoteArg).join(' ')
  if (typeof c.program === 'string' && c.program.trim()) return ['node', c.program.trim(), ...words(c.args)].map(quoteArg).join(' ')
  return null
}

function launchCwd(dir: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.replace(/\$\{workspaceFolder\}/g, '.').trim()
  if (!t) return undefined
  const rel = path.relative(dir, path.resolve(dir, t)).replace(/\\/g, '/')
  return rel === '' ? undefined : rel
}

function launchJsonProcesses(dir: string): DetectedProcess[] {
  const text = readText(path.join(dir, '.claude', 'launch.json'))
  if (text === null) return []
  const doc = parseJsonc(text) as { configurations?: unknown } | null
  const configs = Array.isArray(doc?.configurations) ? (doc.configurations as LaunchConfig[]) : []
  const seen = new Set<string>()
  const out: DetectedProcess[] = []
  for (const c of configs) {
    if (!c || typeof c !== 'object') continue
    const command = launchCommand(c)
    if (!command) continue
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : `Server ${out.length + 1}`
    const cwd = launchCwd(dir, c.cwd)
    const port = typeof c.port === 'number' && Number.isInteger(c.port) && c.port > 0 ? c.port : LAUNCH_DEFAULT_PORT
    const env = c.env && typeof c.env === 'object' && !Array.isArray(c.env) ? (Object.fromEntries(Object.entries(c.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>) : {}
    out.push({
      id: uniqueProcessId(name, undefined, seen),
      name,
      command,
      ...(cwd ? { cwd } : {}),
      port,
      ...(Object.keys(env).length ? { env } : {}),
      ...(typeof c.url === 'string' && /^https?:\/\//i.test(c.url) ? { url: c.url } : {}),
    })
    if (out.length >= MAX_PROCESSES) break
  }
  return out
}

// ---- workspaces ------------------------------------------------------------

function packageWorkspaceGlobs(pkg: Pkg): string[] {
  const w = pkg.workspaces
  if (Array.isArray(w)) return w.map(String)
  if (w && typeof w === 'object' && Array.isArray((w as { packages?: unknown }).packages)) return (w as { packages: unknown[] }).packages.map(String)
  return []
}

/** The `packages:` list of pnpm-workspace.yaml (a plain list of globs; nothing else of the YAML is read). */
function pnpmWorkspaceGlobs(root: string): string[] {
  const text = readText(path.join(root, 'pnpm-workspace.yaml'))
  if (text === null) return []
  const out: string[] = []
  let inList = false
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inList = true
      continue
    }
    if (!inList) continue
    const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line)
    if (m) out.push(m[1]!)
    else if (line.trim() !== '' && !/^\s*#/.test(line)) break
  }
  return out
}

const segmentRegex = (seg: string): RegExp => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Directories under `root` matching one glob (`*`, `**`, partial wildcards, literals) that hold a package.json. */
function matchGlob(root: string, pattern: string): string[] {
  const segs = pattern
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  const found: string[] = []
  const walk = (dir: string, i: number, depth: number): void => {
    if (found.length >= MAX_WORKSPACE_DIRS || depth > MAX_WALK_DEPTH + segs.length) return
    if (i === segs.length) {
      if (isFile(path.join(dir, 'package.json'))) found.push(dir)
      return
    }
    const seg = segs[i]!
    if (seg === '**') {
      walk(dir, i + 1, depth)
      for (const d of subdirs(dir)) walk(path.join(dir, d), i, depth + 1)
    } else if (/[*?]/.test(seg)) {
      const re = segmentRegex(seg)
      for (const d of subdirs(dir)) if (re.test(d)) walk(path.join(dir, d), i + 1, depth + 1)
    } else {
      const next = path.join(dir, seg)
      if (isDir(next)) walk(next, i + 1, depth + 1)
    }
  }
  walk(root, 0, 0)
  return found
}

function expandWorkspaceGlobs(root: string, patterns: string[]): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  for (const p of patterns) {
    if (p.startsWith('!')) continue
    for (const d of matchGlob(root, p)) {
      if (seen.has(d)) continue
      seen.add(d)
      dirs.push(d)
      if (dirs.length >= MAX_WORKSPACE_DIRS) return dirs
    }
  }
  return dirs
}

/** Looks in `dir` (.claude/launch.json, else package.json, a Vite config, workspaces) and proposes a project, or null. */
export function detectProject(dir: string): Detection | null {
  const rootPkg = readPkg(dir)

  const launched = launchJsonProcesses(dir)
  if (launched.length) {
    launched.forEach((p, i) => {
      p.color = PALETTE[i % PALETTE.length]
    })
    return {
      name: prettyProjectName(String(rootPkg?.name || path.basename(dir))),
      framework: launched.map((p) => frameworkOf(p.command)?.name).find(Boolean),
      processes: launched,
    }
  }

  if (!rootPkg) return null

  const runner = detectRunner(dir)
  const runtimePin = runner === 'bun run' ? 'bun' : undefined
  const seen = new Set<string>()
  let framework: string | undefined
  const procs: DetectedProcess[] = []

  const rootRes = processesFromPackage(rootPkg, dir, runner, seen, runtimePin)
  framework ??= rootRes.framework
  procs.push(...rootRes.processes)

  const globs = [...packageWorkspaceGlobs(rootPkg), ...pnpmWorkspaceGlobs(dir)]
  for (const wsDir of expandWorkspaceGlobs(dir, globs).filter((d) => d !== dir)) {
    const wp = readPkg(wsDir)
    if (!wp) continue
    const rel = path.relative(dir, wsDir).replace(/\\/g, '/')
    const label = wp.name ? wp.name.replace(/^@[^/]+\//, '') : path.basename(wsDir)
    const res = processesFromPackage(wp, wsDir, runner, seen, runtimePin, rel, label)
    framework ??= res.framework
    procs.push(...res.processes)
  }

  if (!procs.length) return null

  // dev, start, serve, then the rest; the root package before workspace packages.
  const rank = (p: DetectedProcess) => (p.cwd ? 10 : 0) + (p.id === 'dev' ? 0 : p.id === 'start' ? 1 : p.id === 'serve' ? 2 : 3)
  procs.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))

  const truncated = procs.length > MAX_PROCESSES ? procs.length - MAX_PROCESSES : 0
  const kept = procs.slice(0, MAX_PROCESSES)
  kept.forEach((p, i) => {
    p.color = PALETTE[i % PALETTE.length]
  })

  return {
    name: prettyProjectName(String(rootPkg.name || path.basename(dir))),
    framework,
    processes: kept,
    ...(truncated ? { truncated } : {}),
  }
}
