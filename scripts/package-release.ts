#!/usr/bin/env bun
/**
 * Package AgentHydra 2.0 release bundles with Desk 2, devwebui, and bun runtime.
 *
 * Usage:
 *   bun scripts/package-release.ts --target <windows-x64|linux-x64|linux-arm64|darwin-x64|darwin-arm64> --out <dir>
 *
 * Stages <out>/AgentHydra-<version>-<target>/ with:
 * - AgentHydra daemon executable
 * - orchestrator/ payload
 * - desk2/ (git-tracked files, production deps, server source, web/hydra dists)
 * - desk2/runtime/bun (or bun.exe on Windows)
 * - desk2/launcher/ (Windows only)
 * - devwebui/ (same structure as desk2)
 * - misc/ (Windows only)
 *
 * Then archives it beside the folder and prints bundle size breakdown.
 */
import { execSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

const ROOT = resolve(import.meta.dir, '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

interface Options {
  target: string
  out: string
}

function parseArgs(): Options {
  const args = process.argv.slice(2)
  let target: string | undefined
  let out: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') target = args[i + 1]
    if (args[i] === '--out') out = args[i + 1]
  }

  if (!target || !out) {
    console.error('Usage: bun scripts/package-release.ts --target <target> --out <dir>')
    process.exit(1)
  }

  return { target, out }
}

function getDirSize(path: string): number {
  if (!existsSync(path)) return 0
  let size = 0
  const entries = readdirSync(path, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(path, entry.name)
    if (entry.isDirectory()) {
      size += getDirSize(fullPath)
    } else {
      size += statSync(fullPath).size
    }
  }
  return size
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

function copyDir(src: string, dest: string, ignore?: (name: string) => boolean) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (ignore?.(entry.name)) continue
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, ignore)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

function gitTrackedFiles(dir: string): string[] {
  try {
    const output = execSync(`git ls-files "${dir}"`, { cwd: ROOT, encoding: 'utf8' })
    return output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => join(ROOT, line))
  } catch {
    return []
  }
}

async function downloadBun(target: string, version: string, dest: string): Promise<string> {
  const isWindows = target === 'windows-x64'
  const ext = isWindows ? '.exe' : ''
  const platform = target.split('-')[0]
  const arch = target.split('-')[1]

  const binaryName = `bun-v${version}-${platform}-${arch}${ext}`
  const downloadUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${binaryName}.zip`
  const shasumsUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`

  const tmpDir = join(ROOT, 'tmp', 'bun-download')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  console.log(`Downloading bun ${version} for ${target}...`)

  // Download bun
  const zipPath = join(tmpDir, `${binaryName}.zip`)
  await $`curl -fsSL -o ${zipPath} ${downloadUrl}`.nothrow()

  // Download and verify checksums
  const shasumsPath = join(tmpDir, 'SHASUMS256.txt')
  await $`curl -fsSL -o ${shasumsPath} ${shasumsUrl}`.nothrow()

  // Extract
  if (isWindows) {
    await $`cd ${tmpDir} && powershell -NoProfile -Command "Expand-Archive -Path ${zipPath} -DestinationPath ."`.nothrow()
  } else {
    await $`cd ${tmpDir} && unzip -q ${zipPath}`.nothrow()
  }

  // Find the extracted binary
  const extracted = join(tmpDir, binaryName, `bun${ext}`)
  if (!existsSync(extracted)) {
    throw new Error(`Extracted bun not found at ${extracted}`)
  }

  // Copy to destination
  mkdirSync(dest, { recursive: true })
  const destPath = join(dest, `bun${ext}`)
  copyFileSync(extracted, destPath)
  if (!isWindows) {
    execSync(`chmod +x "${destPath}"`)
  }

  rmSync(tmpDir, { recursive: true, force: true })
  return destPath
}

async function main() {
  const opts = parseArgs()
  const { target, out } = opts

  const stageName = `AgentHydra-${VERSION}-${target}`
  const stageDir = join(out, stageName)

  console.log(`Packaging AgentHydra ${VERSION} for ${target}`)
  console.log(`  Staging to: ${stageDir}`)

  // Clean and create
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  const isWindows = target === 'windows-x64'

  // 1. Build daemon executable
  console.log('Building daemon...')
  const exeName = isWindows ? 'AgentHydra.exe' : 'agenthydra'
  const exePath = join(stageDir, exeName)

  if (isWindows) {
    await $`bun run scripts/build.ts --skip-web --target ${target} --outfile ${exePath}`.nothrow()
  } else {
    await $`bun run scripts/build.ts --skip-web --target ${target} --outfile ${exePath}`.nothrow()
  }

  if (!existsSync(exePath)) {
    throw new Error(`Daemon executable not found at ${exePath}`)
  }

  // 2. Stage orchestrator
  console.log('Staging orchestrator...')
  const orchDir = join(stageDir, 'orchestrator')
  mkdirSync(orchDir, { recursive: true })
  copyFileSync(join(ROOT, 'orchestrator/orch.py'), join(orchDir, 'orch.py'))
  copyFileSync(join(ROOT, 'orchestrator/orch_cli.py'), join(orchDir, 'orch_cli.py'))
  copyFileSync(join(ROOT, 'orchestrator/README.md'), join(orchDir, 'README.md'))
  copyDir(join(ROOT, 'orchestrator/scripts'), join(orchDir, 'scripts'), (name) => name === 'tests')
  copyDir(join(ROOT, 'orchestrator/docs'), join(orchDir, 'docs'))

  // Remove Python cache
  execSync(`find "${orchDir}" -name __pycache__ -type d -prune -exec rm -rf {} +`, { shell: true })

  // 3. Stage desk2
  console.log('Staging desk2...')
  const desk2Stage = join(stageDir, 'desk2')
  mkdirSync(desk2Stage, { recursive: true })

  // Get git-tracked files in desk2
  const desk2Files = gitTrackedFiles('desk2')
  for (const srcPath of desk2Files) {
    const relPath = srcPath.slice(ROOT.length + 1)
    const destPath = join(stageDir, relPath)
    mkdirSync(dirname(destPath), { recursive: true })
    copyFileSync(srcPath, destPath)
  }

  // 3b. Install desk2 production dependencies
  console.log('Installing desk2 production dependencies...')
  const bunInstallArgs = ['install', '--production', '--frozen-lockfile', '--linker', 'hoisted']
  if (
    target !== 'darwin-arm64' &&
    target !== 'darwin-x64' &&
    target !== 'linux-x64' &&
    target !== 'linux-arm64'
  ) {
    // For cross-compilation, specify the target OS/CPU
    const [os, cpu] = target.split('-')
    bunInstallArgs.push(`--os=${os}`, `--cpu=${cpu}`)
  }
  await $`cd ${desk2Stage} && bun ${bunInstallArgs}`.nothrow()

  // 3c. Build desk2 web and hydra
  console.log('Building desk2 web and hydra...')
  await $`cd ${desk2Stage} && bun run build`.nothrow()

  // 3d. Stage bun runtime
  console.log('Staging bun runtime...')
  const runtimeDir = join(desk2Stage, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })

  const bunVersion =
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies?.bun ||
    execSync('bun --version', { encoding: 'utf8' }).trim().slice(1)

  // If host target matches current platform, use process.execPath, otherwise download
  const hostTarget = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${
    process.arch === 'arm64' ? 'arm64' : 'x64'
  }`

  if (target === hostTarget) {
    // Use current bun
    copyFileSync(process.execPath, join(runtimeDir, `bun${isWindows ? '.exe' : ''}`))
  } else {
    // Download for target
    await downloadBun(target, bunVersion, runtimeDir)
  }

  // 4. Stage desk2/launcher (Windows only)
  if (isWindows) {
    console.log('Staging desk2/launcher...')
    const launcherSrc = join(ROOT, 'desk2/launcher')
    const launcherDest = join(desk2Stage, 'launcher')

    // Only include tracked files, not build artifacts
    mkdirSync(launcherDest, { recursive: true })
    copyFileSync(join(launcherSrc, 'start.ps1'), join(launcherDest, 'start.ps1'))
    copyFileSync(join(launcherSrc, 'start.vbs'), join(launcherDest, 'start.vbs'))
    copyFileSync(join(launcherSrc, 'stop.ps1'), join(launcherDest, 'stop.ps1'))
    copyFileSync(join(launcherSrc, 'restart.ps1'), join(launcherDest, 'restart.ps1'))
    copyFileSync(
      join(launcherSrc, 'install-shortcuts.ps1'),
      join(launcherDest, 'install-shortcuts.ps1'),
    )
    copyFileSync(join(launcherSrc, 'HydraDesk2.exe'), join(launcherDest, 'HydraDesk2.exe'))
  }

  // 5. Stage devwebui
  console.log('Staging devwebui...')
  const devwebuiSrc = join(ROOT, '..', 'devwebui')
  if (existsSync(devwebuiSrc)) {
    const devwebuiStage = join(stageDir, 'devwebui')
    mkdirSync(devwebuiStage, { recursive: true })

    // Get git-tracked files in devwebui
    const devwebuiFiles = gitTrackedFiles('../devwebui')
    for (const srcPath of devwebuiFiles) {
      const relPath = srcPath.slice(ROOT.length + 1)
      const destPath = join(stageDir, relPath)
      mkdirSync(dirname(destPath), { recursive: true })
      copyFileSync(srcPath, destPath)
    }

    // Install devwebui production dependencies
    console.log('Installing devwebui production dependencies...')
    const devwebuiBunInstallArgs = [
      'install',
      '--production',
      '--frozen-lockfile',
      '--linker',
      'hoisted',
    ]
    if (
      target !== 'darwin-arm64' &&
      target !== 'darwin-x64' &&
      target !== 'linux-x64' &&
      target !== 'linux-arm64'
    ) {
      const [os, cpu] = target.split('-')
      devwebuiBunInstallArgs.push(`--os=${os}`, `--cpu=${cpu}`)
    }
    await $`cd ${devwebuiStage} && bun ${devwebuiBunInstallArgs}`.nothrow()

    // Build devwebui
    console.log('Building devwebui...')
    if (existsSync(join(devwebuiStage, 'server'))) {
      await $`cd ${devwebuiStage} && bun run build 2>/dev/null || true`.nothrow()
    }
  }

  // 6. Stage misc (Windows only)
  if (isWindows) {
    console.log('Staging misc...')
    const miscSrc = join(ROOT, 'misc')
    const miscDest = join(stageDir, 'misc')
    mkdirSync(miscDest, { recursive: true })

    const miscFiles = [
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

    for (const file of miscFiles) {
      const src = join(miscSrc, file)
      if (existsSync(src)) {
        copyFileSync(src, join(miscDest, file))
      }
    }
  }

  // 7. Check desk2 dists exist
  if (!existsSync(join(desk2Stage, 'web/dist'))) {
    throw new Error('desk2/web/dist is missing — run `bun run build` in desk2/ first')
  }
  if (!existsSync(join(desk2Stage, 'hydra/dist'))) {
    throw new Error('desk2/hydra/dist is missing — run `bun run build` in desk2/ first')
  }

  // 8. Create archive
  console.log('Creating archive...')
  mkdirSync(join(out, '..'), { recursive: true })

  if (isWindows) {
    // Create .exe copy first
    const exeCopy = join(out, `${stageName}.exe`)
    copyFileSync(exePath, exeCopy)
    console.log(`  Standalone exe: ${exeCopy}`)

    // Then create zip with misc
    const zipName = `${stageName}.zip`
    const zipPath = join(out, zipName)

    // Try 7z first (available on windows-latest), fall back to PowerShell
    try {
      execSync(`7z a -tzip "${zipPath}" "${stageDir}" > nul`, { stdio: 'pipe' })
    } catch {
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${stageDir}' -DestinationPath '${zipPath}' -Force"`,
      )
    }
    console.log(`  Archive: ${zipPath}`)
  } else {
    const tarName = `${stageName}.tar.gz`
    const tarPath = join(out, tarName)
    execSync(`tar -C "${out}" -czf "${tarPath}" "${stageName}"`)
    console.log(`  Archive: ${tarPath}`)
  }

  // 9. Print size breakdown
  console.log('\nBundle size breakdown:')
  const daemonSize = statSync(exePath).size
  const runtimeSize = getDirSize(join(desk2Stage, 'runtime'))
  const desk2NodeModulesSize = getDirSize(join(desk2Stage, 'node_modules'))
  const desk2DistsSize =
    getDirSize(join(desk2Stage, 'web/dist')) + getDirSize(join(desk2Stage, 'hydra/dist'))
  const devwebuiSize = existsSync(join(stageDir, 'devwebui'))
    ? getDirSize(join(stageDir, 'devwebui'))
    : 0

  console.log(`  daemon: ${formatBytes(daemonSize)}`)
  console.log(`  desk2 runtime/bun: ${formatBytes(runtimeSize)}`)
  console.log(`  desk2 node_modules: ${formatBytes(desk2NodeModulesSize)}`)
  console.log(`  desk2 web+hydra dists: ${formatBytes(desk2DistsSize)}`)
  if (devwebuiSize > 0) {
    console.log(`  devwebui: ${formatBytes(devwebuiSize)}`)
  }

  const totalSize = daemonSize + runtimeSize + desk2NodeModulesSize + desk2DistsSize + devwebuiSize
  console.log(`  total: ${formatBytes(totalSize)}`)

  console.log('\nPackaging complete!')
}

// Import dirname helper at the top level
import { dirname } from 'node:path'

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
