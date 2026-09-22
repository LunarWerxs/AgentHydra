import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assertClaudeInspectorPortAvailable,
  type ClaudeManagedBuild,
  discoverClaudeBuild,
  prepareClaudeNativeLaunch,
  resolveClaudeNativeSource,
} from '../src/claude-native-launch'

const scratches: string[] = []
afterEach(async () => {
  for (const scratch of scratches.splice(0)) await rm(scratch, { recursive: true, force: true })
})

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'hydra-native-launch-'))
  scratches.push(scratch)
  const install = join(scratch, 'installed')
  const app = join(install, 'app-2.2553.1')
  const binary = join(app, 'claude.exe')
  await mkdir(join(app, 'resources', 'app.asar.unpacked', 'native'), { recursive: true })
  await mkdir(join(app, 'locales'), { recursive: true })
  await mkdir(join(app, 'empty-directory'))
  const original = Buffer.concat([
    Buffer.from('prefix-dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, 9]),
    Buffer.from('000010011'),
    Buffer.from('-suffix'),
  ])
  const fuseOffset = 'prefix-'.length + 32 + 2 + 3
  const modified = Buffer.from(original)
  modified[fuseOffset] = 49
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  const build: ClaudeManagedBuild = {
    version: '2.2553.1',
    sourceSha256: hash(original),
    managedSha256: hash(modified),
    fuseOffset,
  }
  await writeFile(binary, original)
  await writeFile(join(install, 'claude.exe'), 'stable Squirrel stub')
  await writeFile(join(install, 'Update.exe'), 'MUST NOT COPY')
  await writeFile(join(app, 'resources', 'app.asar'), 'complete app payload')
  await writeFile(
    join(app, 'resources', 'app.asar.unpacked', 'native', 'dependency.dll'),
    'native dll',
  )
  await writeFile(join(app, 'locales', 'en-US.pak'), 'locale')
  await writeFile(join(app, 'ffmpeg.dll'), 'runtime dependency')
  const config = { port: 19315, mode: 'native-only' as const, launchDebugger: true }
  const checks: number[] = []
  const deps = {
    platform: 'win32' as const,
    managedRoot: join(scratch, 'hydra-data', 'claude-native'),
    assertPortAvailable: async (port: number) => {
      checks.push(port)
    },
  }
  return { scratch, install, app, binary, build, original, modified, config, deps, checks }
}

test('unconfigured and archive-only profiles use the unchanged launch binary and no ports', async () => {
  expect(await prepareClaudeNativeLaunch('not-even-a-file', null)).toEqual({
    binary: 'not-even-a-file',
    extraArgs: [],
  })
  expect(await prepareClaudeNativeLaunch('stock', { port: 9229, mode: 'native-only' })).toEqual({
    binary: 'stock',
    extraArgs: [],
  })
})

test('automatic startup refuses non-Windows before accessing files', async () => {
  await expect(
    prepareClaudeNativeLaunch(
      'unknown',
      { port: 9229, mode: 'native-only', launchDebugger: true },
      {
        platform: 'linux',
      },
    ),
  ).rejects.toThrow('Windows only')
})

test('full managed copy changes exactly one byte, preserves source, dependencies and all other fuses', async () => {
  const f = await fixture()
  const result = await prepareClaudeNativeLaunch(join(f.install, 'claude.exe'), f.config, f.deps)
  expect(result.extraArgs).toEqual(['--inspect=127.0.0.1:19315'])
  expect(result.extraArgs.join(' ')).not.toContain('inspect-brk')
  expect(await readFile(result.binary)).toEqual(f.modified)
  expect(await readFile(f.binary)).toEqual(f.original)
  const copyDir = dirname(result.binary)
  expect(await readFile(join(copyDir, 'resources', 'app.asar'), 'utf8')).toBe(
    'complete app payload',
  )
  expect(
    await readFile(
      join(copyDir, 'resources', 'app.asar.unpacked', 'native', 'dependency.dll'),
      'utf8',
    ),
  ).toBe('native dll')
  expect(await readFile(join(copyDir, 'locales', 'en-US.pak'), 'utf8')).toBe('locale')
  expect(await readFile(join(copyDir, 'ffmpeg.dll'), 'utf8')).toBe('runtime dependency')
  expect((await stat(join(copyDir, 'empty-directory'))).isDirectory()).toBe(true)
  await expect(stat(join(copyDir, 'Update.exe'))).rejects.toThrow()
  await expect(stat(join(dirname(copyDir), 'Update.exe'))).rejects.toThrow()
  expect(f.checks).toEqual([19315, 19315])
  expect(result.nativeDebugger).toMatchObject({
    port: 19315,
    version: '2.2553.1',
    sourceBinary: f.binary,
    managedBinary: result.binary,
    signature: 'modified-copy',
  })
})

test('an unchanged managed copy is verified and reused without rewriting it', async () => {
  const f = await fixture()
  const first = await prepareClaudeNativeLaunch(f.binary, f.config, f.deps)
  const before = await stat(first.binary)
  const second = await prepareClaudeNativeLaunch(f.binary, f.config, f.deps)
  expect(second).toEqual(first)
  expect((await stat(second.binary)).mtimeMs).toBe(before.mtimeMs)
})

test.each(['claude.exe', 'resources/app.asar', 'ffmpeg.dll'])(
  'refuses a changed managed %s without replacing or launching it',
  async (file) => {
    const f = await fixture()
    const result = await prepareClaudeNativeLaunch(f.binary, f.config, f.deps)
    const changed = join(dirname(result.binary), file)
    await writeFile(changed, 'unexpected content')
    await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
      'copy changed',
    )
    expect(await readFile(changed, 'utf8')).toBe('unexpected content')
  },
)

test('refuses an extra executable in the existing copy', async () => {
  const f = await fixture()
  const result = await prepareClaudeNativeLaunch(f.binary, f.config, f.deps)
  await writeFile(join(dirname(result.binary), 'surprise.exe'), 'untracked')
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
    'inventory changed',
  )
})

test('refuses an installed executable with no recognizable fuse wire', async () => {
  const f = await fixture()
  await prepareClaudeNativeLaunch(f.binary, f.config, f.deps)
  await writeFile(f.binary, 'new version')
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
    '0 Electron fuse wires',
  )
})

test('refuses an executable carrying more than one fuse wire rather than guessing', async () => {
  const f = await fixture()
  await writeFile(f.binary, Buffer.concat([f.original, f.original]))
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
    '2 Electron fuse wires',
  )
})

test('a newer app adjacent to the Squirrel stub is the one used, not an older neighbour', async () => {
  const f = await fixture()
  const newer = join(f.install, 'app-3.0.0')
  await mkdir(newer)
  await writeFile(join(newer, 'claude.exe'), f.original)
  expect(await resolveClaudeNativeSource(join(f.install, 'claude.exe'))).toBe(
    join(newer, 'claude.exe'),
  )
})

test('an unreadable newest app fails closed instead of falling back to an older one', async () => {
  const f = await fixture()
  await mkdir(join(f.install, 'app-3.0.0'))
  await expect(resolveClaudeNativeSource(join(f.install, 'claude.exe'))).rejects.toThrow()
})

test('the derived build describes the installed app without any value pinned in this repo', async () => {
  const f = await fixture()
  expect(await discoverClaudeBuild(f.binary)).toEqual(f.build)
})

test('refuses a preexisting parent updater instead of allowing the managed copy to update itself', async () => {
  const f = await fixture()
  await mkdir(f.deps.managedRoot, { recursive: true })
  await writeFile(join(f.deps.managedRoot, 'Update.exe'), 'unexpected updater')
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
    'Squirrel updater',
  )
})

test('refuses linked resources rather than sharing the installed app with the copy', async () => {
  const f = await fixture()
  await symlink(join(f.app, 'resources'), join(f.app, 'linked-resources'), 'junction')
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
    'symbolic links or junctions',
  )
})

test('rejects unsupported fuse shape even if fixture executable hash agrees', async () => {
  const f = await fixture()
  const invalid = Buffer.from(f.original)
  invalid[f.build.fuseOffset - 4] = 2
  await writeFile(f.binary, invalid)
  f.build.sourceSha256 = createHash('sha256').update(invalid).digest('hex')
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow('fuse state')
})

test('occupied debugger port refuses before creating a managed copy', async () => {
  const f = await fixture()
  f.deps.assertPortAvailable = async () => {
    throw Error('occupied fixture port')
  }
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
    'occupied fixture port',
  )
  await expect(stat(f.deps.managedRoot)).rejects.toThrow()
})

test('port is rechecked after copy, so a new conflicting listener prevents the handoff', async () => {
  const f = await fixture()
  let calls = 0
  f.deps.assertPortAvailable = async () => {
    if (++calls === 2) throw Error('port became occupied')
  }
  await expect(prepareClaudeNativeLaunch(f.binary, f.config, f.deps)).rejects.toThrow(
    'port became occupied',
  )
  expect(calls).toBe(2)
})

test('real port check rejects an occupied loopback socket and accepts it after close', async () => {
  const listener = createServer()
  await new Promise<void>((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen))
  const address = listener.address()
  if (!address || typeof address === 'string') throw Error('Missing listener address')
  try {
    await expect(assertClaudeInspectorPortAvailable(address.port)).rejects.toThrow('unavailable')
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      listener.close((error) => (error ? reject(error) : resolveClose())),
    )
  }
  await expect(assertClaudeInspectorPortAvailable(address.port)).resolves.toBeUndefined()
})
