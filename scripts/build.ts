#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
/**
 * Build the AgentHydra daemon as a bun bundle: `<outdir>/app/` holds server.js (`bun build --target=bun`
 * of the daemon's entry), the assets it reads at run time (the built web UI, the misc files it hands out
 * and the tray toolkit, all beside server.js), release.json (what marks a release) and bun-version (the
 * bun the launcher downloads to run it). The launcher (AgentHydra.exe / agenthydra) starts it.
 *
 * Options:
 *   --bundle                  required: the only mode there is
 *   --outdir <dir>            where app/ goes (default dist/; a default dist/ is emptied first)
 *   --bun-version x.y.z       the bun this build pins (default: the running Bun.version)
 *   --skip-web
 *   --target windows-x64 | ... only decides whether the Windows tray toolkit is included
 */
import { $ } from 'bun'
import pkg from '../package.json'
// ONE list, shared with the runtime that writes these files out again (server/src/tray-toolkit.ts).
// Two copies of a filename list is how an app ends up embedding a file nothing reads.
import { RUNTIME_MISC_FILES } from '../server/src/misc-assets.ts'
import { TRAY_TOOLKIT_FILES } from '../server/src/tray-toolkit.ts'

const ROOT = join(import.meta.dir, '..')
const TMP = join(ROOT, 'tmp', 'release-build')

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

/**
 * The tray host, its config and its icon, embedded so a SINGLE-FILE build still has a tray icon.
 *
 * ⛔ It did not, until 2026-09-11, and the owner was right to call that a bug rather than a
 * limitation: the exe embedded every Vite asset and nothing from misc\, so the daemon's own
 * `startTrayHostIfMissing` skipped with 'no-tray-toolkit' on every run and the app told the person
 * to download a different artifact instead. 340 KB of Win32 binary is not a reason to ship an app
 * with no icon, no Quit and no supervisor. A missing file here FAILS the build for the same reason.
 */
function trayToolkitPaths(embedTray: boolean): string[] {
  if (!embedTray) return []
  return TRAY_TOOLKIT_FILES.map((name) => {
    const path = join(ROOT, 'misc', name)
    if (!existsSync(path))
      throw new Error(
        `cannot build: ${path} is missing. A build without the tray toolkit ships an app that can ` +
          'never show its icon - fix the file (the kit syncs misc\\, see lunarwerx-ui) or say so here.',
      )
    return path
  })
}

/**
 * The misc\ files the RUNNING daemon opens by path, embedded for the same reason as the tray.
 *
 * ⛔ A missing file FAILS the build, deliberately. Shipping without the delivery actuator is
 * not a degraded build, it is one where no chat can be delivered to by ANY route (the composer
 * route IS that script, and the peer route is refused by the same endpoint first) - which is
 * exactly how it shipped, and how a migrated chat was left dormant on 2026-09-12.
 */
function runtimeMiscPaths(): string[] {
  return RUNTIME_MISC_FILES.map((name) => {
    const path = join(ROOT, 'misc', name)
    if (!existsSync(path))
      throw new Error(
        `cannot build: ${path} is missing. A build without it ships a daemon that can never ` +
          'run it (server/src/misc-assets.ts says what each one is for) - fix the file (the kit ' +
          'syncs misc\\, see lunarwerx-ui; the CliMayte runner is built by ' +
          'misc/climayte-runner-native/build.ps1) or take it out of RUNTIME_MISC_FILES.',
      )
    return path
  })
}

/**
 * The generated entry: it tells the daemon where the assets beside server.js are, then loads
 * server/src/main.ts. The lookups the daemon already has (web, tray, misc) are filled with real paths
 * under `import.meta.dir`, which in a bundle is the folder server.js sits in.
 */
function writeReleaseEntrypoint(
  outApp: string,
  embedTray: boolean,
  stamp: { version: string; commit?: string; builtAt?: string },
): string {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const entry = join(TMP, 'entry.ts')
  const webRoot = join(ROOT, 'web', 'dist')
  const webRoutes = filesUnder(webRoot).map((file) => {
    const rel = relative(webRoot, file).replaceAll('\\', '/')
    mkdirSync(dirname(join(outApp, 'web', rel)), { recursive: true })
    copyFileSync(file, join(outApp, 'web', rel))
    return rel
  })
  const miscNames = [...trayToolkitPaths(embedTray), ...runtimeMiscPaths()].map((file) => {
    mkdirSync(join(outApp, 'misc'), { recursive: true })
    copyFileSync(file, join(outApp, 'misc', basename(file)))
    return basename(file)
  })
  const trayNames = new Set(trayToolkitPaths(embedTray).map((file) => basename(file)))
  const names = (keep: (name: string) => boolean) => miscNames.filter(keep)
  const table = (dir: string, list: string[]) =>
    `Object.freeze({
${list.map((name) => `  ${JSON.stringify(name)}: join(here, ${JSON.stringify(dir)}, ${JSON.stringify(name)}),`).join('\n')}
})`
  writeFileSync(
    entry,
    `import { join } from "node:path";
const here = import.meta.dir;
const g = globalThis as Record<string, unknown>;
g.__AGENTHYDRA_EMBEDDED_WEB__ = Object.freeze({
${webRoutes.map((rel) => `  ${JSON.stringify(`/${rel}`)}: join(here, "web", ${JSON.stringify(rel)}),`).join('\n')}
});
${
  trayNames.size === 0
    ? ''
    : `g.__AGENTHYDRA_EMBEDDED_TRAY__ = ${table(
        'misc',
        names((n) => trayNames.has(n)),
      )};
`
}g.__AGENTHYDRA_EMBEDDED_MISC__ = ${table(
      'misc',
      names((n) => !trayNames.has(n)),
    )};
g.__AGENTHYDRA_RELEASE_BUILD__ = true;
// Stamped here because the bundle can be copied anywhere: asking git at runtime would describe
// whatever checkout it was dropped into, not the build. Read by server/src/build-info.ts.
g.__AGENTHYDRA_BUILD__ = ${JSON.stringify({ commit: stamp.commit, builtAt: stamp.builtAt })};
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
      `  bun run dist -- --outdir=<path>`,
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

if (!process.argv.includes('--bundle')) {
  throw new Error(
    'usage: bun scripts/build.ts --bundle [--outdir <dir>] [--bun-version x.y.z] [--skip-web]',
  )
}
const target = option('--target')
const windowsTarget = target ? target.startsWith('windows-') : process.platform === 'win32'
const requestedOutdir = option('--outdir')
const outDir = resolve(requestedOutdir ?? join(ROOT, 'dist'))
const outApp = join(outDir, 'app')
if (!requestedOutdir) clearDistDir(outDir)
// A bundle from an earlier build must not leave files behind that this one no longer ships.
rmSync(outApp, { recursive: true, force: true })
mkdirSync(outApp, { recursive: true })

if (!process.argv.includes('--skip-web')) {
  console.log('→ build web')
  await $`bun run --cwd ${join(ROOT, 'web')} build`
}

console.log('→ bundle daemon')
const stamp = buildStamp()
const entry = writeReleaseEntrypoint(outApp, windowsTarget, { version: pkg.version, ...stamp })
try {
  await $`bun build --target=bun --sourcemap=none ${entry} --outfile=${join(outApp, 'server.js')}`
} finally {
  rmSync(TMP, { recursive: true, force: true })
}
writeFileSync(
  join(outApp, 'release.json'),
  `${JSON.stringify({ version: pkg.version, commit: stamp.commit ?? null, builtAt: stamp.builtAt })}
`,
)
const bunVersion = (option('--bun-version') ?? Bun.version).trim()
if (!/^\d+\.\d+\.\d+$/.test(bunVersion))
  throw new Error(`--bun-version must be x.y.z, got ${bunVersion}`)
writeFileSync(
  join(outApp, 'bun-version'),
  `${bunVersion}
`,
)

console.log(`✓ Built ${outApp} (runs on bun ${bunVersion})`)
