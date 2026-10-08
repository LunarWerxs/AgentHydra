#!/usr/bin/env bun
/**
 * Stage and archive one AgentHydra release bundle (the same script in CI and on a PC).
 *
 *   bun scripts/package-release.ts --target <windows-x64|linux-x64|linux-arm64|darwin-x64|darwin-arm64> --out <dir> [--bun-version x.y.z]
 *
 * Writes <out>/AgentHydra-<version>-<target>/ and its archive beside it (Windows also gets the lone
 * exe, which is the same launcher). No Bun and no Claude Code binary ship: the daemon is plain JS
 * (scripts/build.ts --bundle, whose app/bun-version is the pin, the running Bun.version unless
 * --bun-version says otherwise) beside a small launcher that downloads that Bun on first run. Desk 2
 * ships as source plus production node_modules and runs on the launcher's Bun. Needs
 * desk2/web/dist and desk2/hydra/dist already built; it never builds them and never writes into the
 * checkout.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { findRepoRoot } from '../tests/repo-root'
import { buildLauncher } from './build-launcher'
import { writePosixLauncher } from './launcher-posix'

const ROOT = findRepoRoot(import.meta.dir)
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const TARGETS = ['windows-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
const NODE_OS: Record<string, string> = { windows: 'win32', linux: 'linux', darwin: 'darwin' }
/** The Windows archive must stay a small download: Bun and Claude Code are fetched on first run. */
const WINDOWS_ARCHIVE_LIMIT = 30 * 1024 * 1024
const MISC_FILES = [
  'AgentHydra-Tray.exe',
  'AgentHydra-Tray.json',
  'AgentHydra.ico',
  'Create-Shortcut.ps1',
  'New-TrayShortcut.ps1',
  'Instance-Launch.vbs',
  'Tray-Host.ps1',
  'AgentHydra-Tray.ps1',
  'Tray-Launch.vbs',
]
const LAUNCHER_FILES = [
  'HydraDesk2.exe',
  'start.vbs',
  'start.ps1',
  'stop.ps1',
  'restart.ps1',
  'install-shortcuts.ps1',
]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(message: string): never {
  console.error(`package-release: ${message}`)
  process.exit(1)
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.error})`)
}

function dirSize(path: string): number {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((sum, name) => sum + dirSize(join(path, name)), 0)
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function removePycache(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    if (e.name === '__pycache__') rmSync(p, { recursive: true, force: true })
    else removePycache(p)
  }
}

function trackedFiles(dir: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--', dir], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) fail(`git ls-files ${dir} failed`)
  return r.stdout.split('\0').filter(Boolean)
}

// Source the bundle never needs: tests, e2e, scratch, the window host's Rust project, the Vue sources
// (their dist ships), and the launcher (staged by name on Windows only).
const DESK2_SKIP = [
  /^desk2\/(e2e|tmp)\//,
  /^desk2\/launcher\//,
  /^desk2\/(web|hydra)\/src\//,
  /^desk2\/server\/test\//,
  /^desk2\/web\/test\//,
  /\.test\.tsx?$/,
]

function stageTracked(dir: string, stage: string, skip: RegExp[] = []): void {
  for (const rel of trackedFiles(dir)) {
    if (skip.some((re) => re.test(rel))) continue
    const src = join(ROOT, rel)
    if (!existsSync(src)) continue
    const dest = join(stage, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
}

function installArgs(target: string, hostTarget: string, frozen: boolean): string[] {
  const args = ['install', '--production', '--linker', 'hoisted']
  if (frozen) args.push('--frozen-lockfile')
  if (target !== hostTarget) {
    const [os, cpu] = target.split('-')
    args.push('--os', NODE_OS[os], '--cpu', cpu)
  }
  return args
}

type Json = Record<string, unknown>

/** The exact version bun.lock resolved for a package name ("hono": ["hono@4.13.12", ...]). */
function lockedVersion(lock: string, dep: string): string | undefined {
  const esc = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return lock.match(new RegExp(`"${esc}": \\["${esc}@([^"]+)"`))?.[1]
}

function pinDeps(deps: unknown, lock: string): unknown {
  if (!deps) return deps
  return Object.fromEntries(
    Object.entries(deps as Record<string, string>).map(([k, v]) => [
      k,
      lockedVersion(lock, k) ?? v,
    ]),
  )
}

/**
 * Install only what runs: the staged tree keeps the `server` workspace and drops the others (web,
 * hydra: their dists ship prebuilt) and every devDependency. Tries the frozen lockfile first; bun
 * refuses it when the workspaces differ from the lock, so then it pins each server dependency to the
 * version bun.lock resolved, drops the lock and installs.
 */
function installServerOnly(dir: string, target: string, hostTarget: string): void {
  for (const w of ['web', 'hydra']) rmSync(join(dir, w, 'package.json'), { force: true })
  const pkgPath = join(dir, 'package.json')
  const serverPath = join(dir, 'server/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Json
  pkg.workspaces = ['server']
  delete pkg.devDependencies
  delete pkg.scripts
  writeFileSync(
    pkgPath,
    `${JSON.stringify(pkg, null, 2)}
`,
  )
  const server = JSON.parse(readFileSync(serverPath, 'utf8')) as Json
  delete server.devDependencies
  writeFileSync(
    serverPath,
    `${JSON.stringify(server, null, 2)}
`,
  )

  const frozen = spawnSync(process.execPath, installArgs(target, hostTarget, true), {
    cwd: dir,
    stdio: 'inherit',
  })
  if (frozen.status === 0) return
  console.log(`frozen install of ${dir} refused; pinning server dependencies from bun.lock`)
  const lockPath = join(dir, 'bun.lock')
  const lock = readFileSync(lockPath, 'utf8')
  for (const [file, json] of [
    [pkgPath, pkg],
    [serverPath, server],
  ] as const) {
    for (const key of ['dependencies', 'optionalDependencies'])
      if (json[key]) json[key] = pinDeps(json[key], lock)
    writeFileSync(
      file,
      `${JSON.stringify(json, null, 2)}
`,
    )
  }
  rmSync(lockPath, { force: true })
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
  run(process.execPath, installArgs(target, hostTarget, false), dir)
}

// What a runtime never loads from node_modules: type declarations, source maps, human docs and the
// folders packages keep their own tests and samples in, at the package's root only (a dist/examples
// or lib/test deeper down can be code a package imports), and test files by name at any depth.
// License files stay.
const PRUNE_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples'])
const PRUNE_FILE =
  /(\.map|\.d\.[cm]?ts|\.(test|spec)\.[cm]?[jt]sx?)$|^(readme|changelog)(\.[^.]*)?\.md$/i

/** True when `name` inside `parent` is a package's root: node_modules/<pkg> or node_modules/@scope/<pkg>. */
function isPackageRoot(parent: string, name: string): boolean {
  const base = basename(parent)
  if (base === 'node_modules') return !name.startsWith('@') && !name.startsWith('.')
  return base.startsWith('@') && basename(dirname(parent)) === 'node_modules'
}

/**
 * Trims a production node_modules in place. Every Claude Code platform package of the Agent SDK goes:
 * each carries a 200 MB binary, and Desk 2 resolves or downloads Claude Code itself.
 */
function pruneNodeModules(dir: string, packageRoot = false): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if ((packageRoot && PRUNE_DIRS.has(e.name)) || /^claude-agent-sdk-/.test(e.name)) {
        rmSync(p, { recursive: true, force: true })
      } else {
        pruneNodeModules(p, isPackageRoot(dir, e.name))
      }
    } else if (PRUNE_FILE.test(e.name)) {
      rmSync(p, { force: true })
    }
  }
}

const target = arg('--target')
const outArg = arg('--out')
const bunVersion = (arg('--bun-version') ?? Bun.version).trim()
if (!target || !TARGETS.includes(target)) fail(`--target must be one of ${TARGETS.join(', ')}`)
if (!outArg) fail('--out <dir> is required')
if (!/^\d+\.\d+\.\d+$/.test(bunVersion)) fail(`--bun-version must be x.y.z, got ${bunVersion}`)
const out = resolve(outArg)
const isWindows = target === 'windows-x64'
const platform = process.platform === 'win32' ? 'windows' : process.platform
const hostTarget = `${platform}-${process.arch}`
// Windows has no execute bit to put in a tar, so a POSIX bundle packaged there ships an `agenthydra`
// that will not start ("Permission denied"). release.yml packages those targets on Linux.
if (!isWindows && process.platform === 'win32')
  fail(`${target} must be packaged on Linux or macOS: Windows cannot mark the launcher executable`)

for (const dist of ['desk2/web/dist', 'desk2/hydra/dist']) {
  if (!existsSync(join(ROOT, dist, 'index.html'))) {
    fail(
      `${dist} is missing: run \`bun run build\` in desk2/ first (this script does not build it)`,
    )
  }
}

const name = `AgentHydra-${VERSION}-${target}`
const stage = join(out, name)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
console.log(`Packaging AgentHydra ${VERSION} for ${target} into ${stage} (Bun ${bunVersion})`)

// The daemon as app/ (server.js, its misc assets, release.json and bun-version, the pin the launcher
// downloads), then the launcher that runs it.
run(
  process.execPath,
  [
    'scripts/build.ts',
    '--bundle',
    '--target',
    target,
    '--outdir',
    stage,
    '--bun-version',
    bunVersion,
  ],
  ROOT,
)
if (readFileSync(join(stage, 'app/bun-version'), 'utf8').trim() !== bunVersion)
  fail('app/bun-version does not hold the pin')
const launcher = join(stage, isWindows ? 'AgentHydra.exe' : 'agenthydra')
if (isWindows) {
  await buildLauncher({ outfile: launcher, version: VERSION })
  copyFileSync(launcher, join(out, `${name}.exe`))
} else {
  writePosixLauncher({ outfile: launcher, version: VERSION })
}
if (target === hostTarget) {
  const v = spawnSync(launcher, ['--version'], { cwd: ROOT, encoding: 'utf8' })
  const printed = (v.stdout ?? '').trim()
  if (v.error) fail(`${launcher} --version did not run: ${v.error.message}`)
  if (v.status !== 0 || printed !== VERSION)
    fail(`${launcher} --version exited ${v.status} printing "${printed}", expected ${VERSION}`)
}

// The orchestrator's python half: never tests, bytecode or state.
const orch = join(stage, 'orchestrator')
mkdirSync(orch)
for (const f of ['orch.py', 'orch_cli.py', 'README.md'])
  copyFileSync(join(ROOT, 'orchestrator', f), join(orch, f))
cpSync(join(ROOT, 'orchestrator/scripts'), join(orch, 'scripts'), { recursive: true })
cpSync(join(ROOT, 'orchestrator/docs'), join(orch, 'docs'), { recursive: true })
rmSync(join(orch, 'scripts/tests'), { recursive: true, force: true })
removePycache(orch)

// Desk 2: tracked source, the built dists and production node_modules; it runs on the launcher's Bun.
const desk2 = join(stage, 'desk2')
stageTracked('desk2', stage, DESK2_SKIP)
for (const dist of ['web/dist', 'hydra/dist']) {
  cpSync(join(ROOT, 'desk2', dist), join(desk2, dist), { recursive: true })
}
installServerOnly(desk2, target, hostTarget)

pruneNodeModules(join(desk2, 'node_modules'))

if (isWindows) {
  const deskLauncher = join(desk2, 'launcher')
  mkdirSync(deskLauncher)
  for (const f of LAUNCHER_FILES)
    copyFileSync(join(ROOT, 'desk2/launcher', f), join(deskLauncher, f))
}

if (isWindows) {
  mkdirSync(join(stage, 'misc'))
  for (const f of MISC_FILES) copyFileSync(join(ROOT, 'misc', f), join(stage, 'misc', f))
}

const archive = join(out, isWindows ? `${name}.zip` : `${name}.tar.gz`)
rmSync(archive, { force: true })
if (isWindows) {
  // 7-Zip is often installed without being on PATH; Compress-Archive takes over six minutes on this bundle.
  const sevenZipCandidates = [
    '7z',
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((dir): dir is string => !!dir)
      .map((dir) => join(dir, '7-Zip', '7z.exe')),
  ]
  const sevenZip = sevenZipCandidates.find(
    (exe) => !spawnSync(exe, ['i'], { stdio: 'ignore' }).error,
  )
  if (sevenZip) {
    run(sevenZip, ['a', '-tzip', archive, name], out)
  } else {
    run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath '${stage}' -DestinationPath '${archive}'`,
      ],
      out,
    )
  }
} else {
  run('tar', ['-czf', archive, name], out)
}

const deskModules = dirSize(join(desk2, 'node_modules'))
const sizes = {
  launcher: dirSize(launcher),
  'app (daemon)': dirSize(join(stage, 'app')),
  'desk2 node_modules': deskModules,
  'desk2 dists': dirSize(join(desk2, 'web/dist')) + dirSize(join(desk2, 'hydra/dist')),
  'desk2 other':
    dirSize(desk2) -
    deskModules -
    dirSize(join(desk2, 'web/dist')) -
    dirSize(join(desk2, 'hydra/dist')),
  orchestrator: dirSize(orch),
  misc: dirSize(join(stage, 'misc')),
}
console.log(`
Bundle size (${name}):`)
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(20)} ${mb(v)}`)
console.log(`  ${'folder total'.padEnd(20)} ${mb(dirSize(stage))}`)
console.log(`  ${'archive'.padEnd(20)} ${mb(statSync(archive).size)}  ${archive}`)
if (isWindows && statSync(archive).size > WINDOWS_ARCHIVE_LIMIT)
  fail(
    `the Windows archive is ${mb(statSync(archive).size)}, over the ${mb(WINDOWS_ARCHIVE_LIMIT)} limit`,
  )
