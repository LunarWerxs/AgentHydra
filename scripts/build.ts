#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
/**
 * Build one self-contained AgentHydra executable. The generated compile-only entrypoint embeds
 * every Vite output, then loads server/src/main.ts. No web/ or misc/ sidecars are required.
 *
 * Options used by release.yml:
 *   --skip-web
 *   --target windows-x64 | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
 *   --outfile <path>
 */
import { $ } from 'bun'
import pkg from '../package.json'

const ROOT = join(import.meta.dir, '..')
const TMP = join(ROOT, 'tmp', 'release-build')

function setWindowsGuiSubsystem(path: string): void {
  const image = readFileSync(path)
  if (image.length < 256 || image[0] !== 0x4d || image[1] !== 0x5a) {
    throw new Error('compiled Windows executable has no valid MZ header')
  }
  const pe = image.readInt32LE(0x3c)
  if (pe < 0 || pe + 94 >= image.length || image.readUInt32LE(pe) !== 0x0000_4550) {
    throw new Error('compiled Windows executable has no valid PE header')
  }
  // --windows-hide-console still leaves Bun 1.3.14 output marked as a console application.
  // The loader-level GUI subsystem prevents a terminal from appearing on double-click.
  image.writeUInt16LE(2, pe + 92)
  image.writeUInt32LE(0, pe + 88)
  writeFileSync(path, image)
  if (readFileSync(path).readUInt16LE(pe + 92) !== 2) {
    throw new Error('failed to stamp Windows GUI subsystem')
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1]
  const prefix = `${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}

function importPath(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target).replaceAll('\\', '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/**
 * What this build is, stamped into the binary.
 *
 * The commit comes from CI's own environment first (`GITHUB_SHA`), because a release workflow may
 * build from a detached checkout where the local git call is the less direct answer. Falling back
 * to `git rev-parse` covers a local `bun run dist`. Either can fail — a source tarball with no git
 * history is a legitimate way to build — and the field is simply omitted then, which build-info.ts
 * reports as `null` rather than inventing a value.
 */
function buildStamp(): { commit?: string; builtAt?: string } {
  const builtAt = new Date().toISOString()
  const fromEnv = process.env.GITHUB_SHA?.trim()
  if (fromEnv && /^[0-9a-f]{40}$/.test(fromEnv)) return { commit: fromEnv, builtAt }
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const sha = proc.exitCode === 0 ? proc.stdout.toString().trim() : ''
    if (/^[0-9a-f]{40}$/.test(sha)) return { commit: sha, builtAt }
  } catch {
    // no git, or no repository — the commit is simply not known for this build
  }
  return { builtAt }
}

function writeReleaseEntrypoint(): string {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const entry = join(TMP, 'entry.ts')
  const webRoot = join(ROOT, 'web', 'dist')
  const files = filesUnder(webRoot)
  const imports = files.map(
    (file, index) =>
      `import asset${index} from ${JSON.stringify(importPath(entry, file))} with { type: "file" };`,
  )
  const routes = files.map((file, index) => [
    `/${relative(webRoot, file).replaceAll('\\', '/')}`,
    `asset${index}`,
  ])
  writeFileSync(
    entry,
    `${imports.join('\n')}

(globalThis as { __AGENTHYDRA_EMBEDDED_WEB__?: Readonly<Record<string, string>> })
  .__AGENTHYDRA_EMBEDDED_WEB__ = Object.freeze({
${routes.map(([route, asset]) => `  ${JSON.stringify(route)}: ${asset},`).join('\n')}
});
(globalThis as { __AGENTHYDRA_RELEASE_BUILD__?: boolean }).__AGENTHYDRA_RELEASE_BUILD__ = true;
// Stamped here because a compiled binary can be copied anywhere: asking git at runtime would
// describe whatever checkout the exe was dropped into, not the build. Read by
// server/src/build-info.ts for \`--version --json\`.
(globalThis as { __AGENTHYDRA_BUILD__?: { commit?: string; builtAt?: string } })
  .__AGENTHYDRA_BUILD__ = ${JSON.stringify(buildStamp())};
await import(${JSON.stringify(importPath(entry, join(ROOT, 'server', 'src', 'main.ts')))});
`,
  )
  return entry
}

/**
 * Empty `dist/` before a build, and when Windows refuses, say WHY instead of throwing EACCES.
 *
 * The refusal is not a permissions problem and the error text is actively misleading: Windows
 * cannot unlink a running executable, so `dist/AgentHydra.exe` is locked exactly when a previously
 * built AgentHydra is still running, which is the normal state on a machine where the app is
 * installed from this checkout. `EACCES: permission denied, rm 'dist'` sends you looking at ACLs
 * and elevation. Naming the process (with its pid, so it can be ended) turns a five-minute
 * detour into one obvious action.
 *
 * The directory is emptied item by item rather than removed and recreated, so one locked file
 * cannot take the whole wipe down with it, and the surviving lock is reported precisely.
 */
function clearDistDir(dir: string): void {
  if (!existsSync(dir)) return
  const locked: string[] = []
  for (const name of readdirSync(dir)) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true })
    } catch {
      locked.push(name)
    }
  }
  if (locked.length === 0) return

  const holders = describeLockHolders(dir)
  throw new Error(
    `cannot clear ${dir}: ${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked.\n` +
      (holders.length
        ? `A previously built AgentHydra is still running from this folder:\n${holders
            .map((h) => `  pid ${h.pid}  ${h.path}`)
            .join('\n')}\n` +
          `Quit it (or: taskkill /PID ${holders[0]?.pid} /F), then build again.\n`
        : 'Something still has a file in it open. Quit any AgentHydra started from this folder, then build again.\n') +
      `Or build somewhere else and leave the running app alone:\n` +
      `  bun run dist -- --outfile=<path>`,
  )
}

/** Processes running an executable from `dir`, so the message can name the thing to close. Windows
 *  only (it is the only OS that locks a running image); best-effort, and an empty list just means
 *  the message falls back to a generic phrasing. */
function describeLockHolders(dir: string): Array<{ pid: number; path: string }> {
  if (process.platform !== 'win32') return []
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    )
    const rows: unknown = JSON.parse(out)
    const wanted = resolve(dir).toLowerCase()
    return (Array.isArray(rows) ? rows : [rows])
      .filter((r): r is { ProcessId: number; ExecutablePath: string } => {
        const p = (r as { ExecutablePath?: unknown })?.ExecutablePath
        return typeof p === 'string' && resolve(p).toLowerCase().startsWith(`${wanted}\\`)
      })
      .map((r) => ({ pid: r.ProcessId, path: r.ExecutablePath }))
  } catch {
    return []
  }
}

const target = option('--target')
const targetFlag = target ? `bun-${target}` : undefined
const windowsTarget = target ? target.startsWith('windows-') : process.platform === 'win32'
const defaultName = windowsTarget ? 'AgentHydra.exe' : 'agenthydra'
const requestedOutfile = option('--outfile')
const outBin = resolve(requestedOutfile ?? join(ROOT, 'dist', defaultName))
if (!requestedOutfile) clearDistDir(join(ROOT, 'dist'))
mkdirSync(dirname(outBin), { recursive: true })

if (!process.argv.includes('--skip-web')) {
  console.log('→ build web')
  await $`bun run --cwd ${join(ROOT, 'web')} build`
}

console.log('→ compile daemon + embedded web app')
const entry = writeReleaseEntrypoint()
try {
  if (windowsTarget) {
    if (targetFlag) {
      await $`bun build --compile --sourcemap=none --target=${targetFlag} --windows-hide-console --windows-icon=${join(ROOT, 'misc', 'AgentHydra.ico')} --windows-title=${'AgentHydra'} --windows-publisher=LunarWerx --windows-version=${`${pkg.version}.0`} --windows-description=${'Local AI coding-session manager'} ${entry} --outfile=${outBin}`
    } else {
      await $`bun build --compile --sourcemap=none --windows-hide-console --windows-icon=${join(ROOT, 'misc', 'AgentHydra.ico')} --windows-title=${'AgentHydra'} --windows-publisher=LunarWerx --windows-version=${`${pkg.version}.0`} --windows-description=${'Local AI coding-session manager'} ${entry} --outfile=${outBin}`
    }
  } else if (targetFlag) {
    await $`bun build --compile --minify --sourcemap=none --target=${targetFlag} ${entry} --outfile=${outBin}`
  } else {
    await $`bun build --compile --minify --sourcemap=none ${entry} --outfile=${outBin}`
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}
if (windowsTarget) setWindowsGuiSubsystem(outBin)
// Bun 1.3.14 can leave this compile-time map beside an unminified Windows executable even when
// --sourcemap=none is set. It is not used at runtime and must never become release debris.
rmSync(join(dirname(outBin), 'entry.js.map'), { force: true })

console.log(`✓ Built ${outBin}`)
