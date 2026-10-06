#!/usr/bin/env bun
/**
 * Build AgentHydra.exe, the Windows launcher (launcher/windows/*.cs), with the .NET Framework 4 C#
 * compiler every Windows 10 and 11 ships: no .NET SDK, no NuGet.
 *
 *   bun scripts/build-launcher.ts --outfile <path> [--version x.y.z]
 *
 * The version defaults to package.json's. It is baked in through a generated source file in a temp
 * folder, so the checked-in source never changes between releases.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import pkg from '../package.json'

const ROOT = resolve(import.meta.dir, '..')
const SOURCE_DIR = join(ROOT, 'launcher', 'windows')
const ICON = join(ROOT, 'misc', 'AgentHydra.ico')

/** What the launcher's source uses, by assembly: the .NET Framework's own, found beside csc.exe. */
const REFERENCES = [
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
  'System.IO.Compression.dll',
  'System.IO.Compression.FileSystem.dll',
]

/** The .NET Framework 4 C# compiler, or null when this Windows lacks it (or this is not Windows). */
export function findCsc(): string | null {
  if (process.platform !== 'win32') return null
  const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  for (const framework of ['Framework64', 'Framework']) {
    const exe = join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

export interface BuildLauncherOptions {
  outfile: string
  /** Baked into the exe; package.json's version when omitted. */
  version?: string
}

/** The generated BuildInfo.cs: the version for the launcher's code and for Explorer's Details tab. */
function buildInfoSource(version: string): string {
  // Only the numeric core can be a file version (1.2.3-rc.1 is 1.2.3.0).
  const [major, minor, patch] = version.split(/[-+]/)[0]!.split('.')
  const fileVersion = `${major}.${minor}.${patch}.0`
  return [
    'using System.Reflection;',
    `[assembly: AssemblyTitle("AgentHydra")]`,
    `[assembly: AssemblyProduct("AgentHydra")]`,
    `[assembly: AssemblyFileVersion("${fileVersion}")]`,
    `[assembly: AssemblyInformationalVersion("${version}")]`,
    'namespace AgentHydra { static class BuildInfo { public const string Version = "' +
      version +
      '"; } }',
    '',
  ].join('\r\n')
}

/** Compile the launcher into `outfile`; resolves to its absolute path. Throws with csc's own words when the source does not build. */
export async function buildLauncher({
  outfile,
  version = pkg.version,
}: BuildLauncherOptions): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(
      'The Windows launcher can only be built on Windows: it is compiled with the .NET Framework csc.exe.',
    )
  }
  const csc = findCsc()
  if (!csc) {
    throw new Error(
      'The Windows launcher needs the .NET Framework 4 compiler (csc.exe), which this Windows lacks.',
    )
  }
  // The version lands inside a C# string literal and a file version: a plain semver and nothing else.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/.test(version)) {
    throw new Error(
      `"${version}" is not a version the launcher can carry (x.y.z, optionally -pre or +build).`,
    )
  }
  const sources = readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.cs'))
    .map((name) => join(SOURCE_DIR, name))
  if (sources.length === 0) throw new Error(`No launcher source in ${SOURCE_DIR}.`)

  const work = mkdtempSync(join(tmpdir(), 'agenthydra-launcher-'))
  try {
    const generated = join(work, 'BuildInfo.cs')
    writeFileSync(generated, buildInfoSource(version))
    const built = join(work, 'AgentHydra.exe')
    const args = [
      '/nologo',
      '/noconfig',
      '/target:winexe',
      '/platform:anycpu',
      '/optimize',
      '/codepage:65001',
      `/win32icon:${ICON}`,
      ...REFERENCES.map((name) => `/reference:${name}`),
      `/out:${built}`,
      ...sources,
      generated,
    ]
    // csc is a console program: hidden, so no console window flashes.
    const proc = Bun.spawn([csc, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    if (code !== 0)
      throw new Error(
        `Could not build the Windows launcher: ${(stdout + stderr).trim() || `csc exited ${code}`}`,
      )
    const target = resolve(outfile)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(built, target)
    return target
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1]
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1)
}

if (import.meta.main) {
  const outfile = option('--outfile')
  if (!outfile) {
    console.error('usage: bun scripts/build-launcher.ts --outfile <path> [--version x.y.z]')
    process.exit(2)
  }
  try {
    console.log(await buildLauncher({ outfile, version: option('--version') }))
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
