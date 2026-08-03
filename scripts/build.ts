#!/usr/bin/env bun
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
await import(${JSON.stringify(importPath(entry, join(ROOT, 'server', 'src', 'main.ts')))});
`,
  )
  return entry
}

const target = option('--target')
const targetFlag = target ? `bun-${target}` : undefined
const windowsTarget = target ? target.startsWith('windows-') : process.platform === 'win32'
const defaultName = windowsTarget ? 'AgentHydra.exe' : 'agenthydra'
const requestedOutfile = option('--outfile')
const outBin = resolve(requestedOutfile ?? join(ROOT, 'dist', defaultName))
if (!requestedOutfile) rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
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
