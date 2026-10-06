#!/usr/bin/env bun
/**
 * Stage and archive one AgentHydra release bundle (the same script in CI and on a PC).
 *
 *   bun scripts/package-release.ts --target <windows-x64|linux-x64|linux-arm64|darwin-x64|darwin-arm64> --out <dir>
 *
 * Writes <out>/AgentHydra-<version>-<target>/ and its archive beside it (Windows also gets the lone
 * exe). The daemon is compiled by scripts/build.ts; Desk 2 and devwebui ship as source plus production
 * node_modules on a bundled bun (desk2/runtime). Needs desk2/web/dist and desk2/hydra/dist already
 * built; it never builds them and never writes into the checkout.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const TARGETS = ['windows-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
const NODE_OS: Record<string, string> = { windows: 'win32', linux: 'linux', darwin: 'darwin' }
const BUN_ASSET: Record<string, string> = {
  'windows-x64': 'bun-windows-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-aarch64',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-aarch64',
}
const MISC_FILES = [
  'lunarwerx-tray.exe',
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

function installProduction(dir: string, target: string, hostTarget: string): void {
  const args = ['install', '--production', '--frozen-lockfile', '--linker', 'hoisted']
  if (target !== hostTarget) {
    const [os, cpu] = target.split('-')
    args.push('--os', NODE_OS[os], '--cpu', cpu)
  }
  run(process.execPath, args, dir)
}

async function fetchBun(target: string, dest: string, work: string): Promise<void> {
  const asset = `${BUN_ASSET[target]}.zip`
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${Bun.version}`
  const zip = join(work, asset)
  const res = await fetch(`${base}/${asset}`)
  if (!res.ok) fail(`download ${asset} failed: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const want = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p[1]?.replace(/^\*/, '') === asset)?.[0]
  const got = createHash('sha256').update(bytes).digest('hex')
  if (!want || want.toLowerCase() !== got) fail(`${asset} does not match SHASUMS256.txt`)
  await Bun.write(zip, bytes)
  const out = join(work, 'unzipped')
  mkdirSync(out)
  if (process.platform === 'win32') {
    run(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}'`],
      work,
    )
  } else {
    run('unzip', ['-q', zip, '-d', out], work)
  }
  const exe = target.startsWith('windows') ? 'bun.exe' : 'bun'
  const found = join(out, BUN_ASSET[target], exe)
  if (!existsSync(found)) fail(`${asset} has no ${exe}`)
  copyFileSync(found, dest)
}

const target = arg('--target')
const outArg = arg('--out')
if (!target || !TARGETS.includes(target)) fail(`--target must be one of ${TARGETS.join(', ')}`)
if (!outArg) fail('--out <dir> is required')
const out = resolve(outArg)
const isWindows = target === 'windows-x64'
const platform = process.platform === 'win32' ? 'windows' : process.platform
const hostTarget = `${platform}-${process.arch}`

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
console.log(`Packaging AgentHydra ${VERSION} for ${target} into ${stage}`)

// The daemon. Windows compiles unminified (--minify panics Bun on a Windows host; see scripts/build.ts).
const daemon = join(stage, isWindows ? 'AgentHydra.exe' : 'agenthydra')
run(
  process.execPath,
  ['scripts/build.ts', '--skip-web', '--target', target, '--outfile', daemon],
  ROOT,
)
if (target === hostTarget) run(daemon, ['--version'], ROOT)
if (isWindows) copyFileSync(daemon, join(out, `${name}.exe`))

// The orchestrator's python half: never tests, bytecode or state.
const orch = join(stage, 'orchestrator')
mkdirSync(orch)
for (const f of ['orch.py', 'orch_cli.py', 'README.md'])
  copyFileSync(join(ROOT, 'orchestrator', f), join(orch, f))
cpSync(join(ROOT, 'orchestrator/scripts'), join(orch, 'scripts'), { recursive: true })
cpSync(join(ROOT, 'orchestrator/docs'), join(orch, 'docs'), { recursive: true })
rmSync(join(orch, 'scripts/tests'), { recursive: true, force: true })
removePycache(orch)

// Desk 2: tracked source, the built dists, production node_modules, the bundled bun.
const desk2 = join(stage, 'desk2')
stageTracked('desk2', stage, DESK2_SKIP)
for (const dist of ['web/dist', 'hydra/dist']) {
  cpSync(join(ROOT, 'desk2', dist), join(desk2, dist), { recursive: true })
}
installProduction(desk2, target, hostTarget)

const runtime = join(desk2, 'runtime')
mkdirSync(runtime)
const bunDest = join(runtime, isWindows ? 'bun.exe' : 'bun')
if (target === hostTarget) {
  copyFileSync(process.execPath, bunDest)
} else {
  const work = mkdtempSync(join(out, '.bun-dl-'))
  try {
    await fetchBun(target, bunDest, work)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
if (!isWindows) chmodSync(bunDest, 0o755)

if (isWindows) {
  const launcher = join(desk2, 'launcher')
  mkdirSync(launcher)
  for (const f of LAUNCHER_FILES) copyFileSync(join(ROOT, 'desk2/launcher', f), join(launcher, f))
}

// devwebui sits beside desk2/ (Desk 2's servers pane starts it from ../devwebui).
const devwebui = join(stage, 'devwebui')
stageTracked('devwebui', stage, [/\.test\.tsx?$/, /^devwebui\/(tests?|e2e|tmp)\//])
installProduction(devwebui, target, hostTarget)

if (isWindows) {
  mkdirSync(join(stage, 'misc'))
  for (const f of MISC_FILES) copyFileSync(join(ROOT, 'misc', f), join(stage, 'misc', f))
}

const archive = join(out, isWindows ? `${name}.zip` : `${name}.tar.gz`)
rmSync(archive, { force: true })
if (isWindows) {
  const sevenZip = spawnSync('7z', ['i'], { stdio: 'ignore' })
  if (!sevenZip.error) {
    run('7z', ['a', '-tzip', archive, name], out)
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

const sizes = {
  daemon: dirSize(daemon),
  'desk2 runtime': dirSize(runtime),
  'desk2 node_modules': dirSize(join(desk2, 'node_modules')),
  dists: dirSize(join(desk2, 'web/dist')) + dirSize(join(desk2, 'hydra/dist')),
  devwebui: dirSize(devwebui),
}
console.log(`\nBundle size (${name}):`)
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(20)} ${mb(v)}`)
console.log(`  ${'folder total'.padEnd(20)} ${mb(dirSize(stage))}`)
console.log(`  ${'archive'.padEnd(20)} ${mb(statSync(archive).size)}  ${archive}`)
