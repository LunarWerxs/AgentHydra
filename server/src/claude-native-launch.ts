import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ClaudeNativeProfileConfig } from './claude-native-settings'
import { DATA_DIR } from './config'

const FUSE_MARKER = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
const MANIFEST = 'agenthydra-native-manifest.json'

export interface ClaudeManagedBuild {
  version: string
  sourceSha256: string
  managedSha256: string
  fuseOffset: number
}

export const CLAUDE_MANAGED_BUILD: Readonly<ClaudeManagedBuild> = Object.freeze({
  version: '2.2553.1',
  sourceSha256: 'd67ae3d5da7eb34413f55c295f4847955af6322e028bd0700d4141101b6e5f6b',
  managedSha256: '5e23a282fccf79b77d2cef79cd1c72e1ab5d44a2d2b2af6ef5f4d6fa0d624a3c',
  fuseOffset: 199419677,
})

interface FileDigest {
  path: string
  size: number
  sha256: string
}

interface CopyManifest {
  schema: 1
  version: string
  sourceBinary: string
  sourceSha256: string
  managedSha256: string
  fuseOffset: number
  files: FileDigest[]
}

export interface ClaudeNativeLaunchPlan {
  binary: string
  extraArgs: string[]
  nativeDebugger?: {
    port: number
    sourceBinary: string
    managedBinary: string
    version: string
    manifest: string
    signature: 'modified-copy'
  }
}

/** Dependency injection is for small filesystem fixtures; runtime callers use the pinned build. */
export interface ClaudeNativeLaunchDependencies {
  platform?: NodeJS.Platform
  managedRoot?: string
  build?: Readonly<ClaudeManagedBuild>
  assertPortAvailable?: (port: number) => Promise<void>
}

function childPath(root: string, path: string): string {
  const result = resolve(root, path)
  const rel = relative(root, result)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw Error('Managed Claude path is outside its root')
  }
  return result
}

async function regularDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Error(`Managed Claude refuses a linked or non-directory path: ${path}`)
  }
}

async function digest(path: string): Promise<{ size: number; sha256: string }> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`Not a regular Claude file: ${path}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    size += chunk.length
  }
  if (size !== info.size) throw Error(`Claude file changed while reading: ${path}`)
  return { size, sha256: hash.digest('hex') }
}

async function filesIn(
  root: string,
  prefix = '',
  onDirectory?: (relativePath: string) => Promise<void>,
): Promise<string[]> {
  await regularDirectory(join(root, prefix))
  if (onDirectory) await onDirectory(prefix)
  const files: string[] = []
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name
    const path = childPath(root, name)
    const info = await lstat(path)
    if (info.isSymbolicLink())
      throw Error(`Claude copy refuses symbolic links or junctions: ${path}`)
    if (info.isDirectory()) files.push(...(await filesIn(root, name, onDirectory)))
    else if (info.isFile()) files.push(name)
    else throw Error(`Claude copy contains an unsupported entry: ${path}`)
  }
  return files.sort()
}

/** Resolve the real application behind Squirrel's stable stub, never silently pin an older app. */
export async function resolveClaudeNativeSource(
  binary: string,
  build: Readonly<ClaudeManagedBuild> = CLAUDE_MANAGED_BUILD,
): Promise<string> {
  if (basename(binary).toLowerCase() !== 'claude.exe') {
    throw Error('Automatic Claude debugger startup requires the Windows Claude executable')
  }
  const parent = dirname(binary)
  await regularDirectory(parent)
  const apps = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => /^app-\d+(?:\.\d+)*$/.test(entry.name))
    .sort((a, b) => {
      const av = a.name.slice(4).split('.').map(Number)
      const bv = b.name.slice(4).split('.').map(Number)
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        const diff = (bv[i] ?? 0) - (av[i] ?? 0)
        if (diff) return diff
      }
      return 0
    })
  let source = binary
  if (apps.length) {
    if (apps[0].name !== `app-${build.version}`) {
      throw Error(`Claude ${apps[0].name.slice(4)} is not supported by automatic debugger startup`)
    }
    source = join(parent, apps[0].name, 'claude.exe')
  }
  await regularDirectory(dirname(source))
  const actual = await digest(source)
  if (actual.sha256 !== build.sourceSha256) {
    throw Error(`Claude executable does not match the supported ${build.version} build`)
  }
  return source
}

/** Binding catches any existing IPv4 loopback or wildcard listener without contacting it. */
export async function assertClaudeInspectorPortAvailable(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Invalid Claude debugger port')
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer()
    const timer = setTimeout(() => {
      server.close()
      reject(Error('Timed out checking the Claude debugger port'))
    }, 2000)
    server.once('error', () => {
      clearTimeout(timer)
      reject(Error(`Claude debugger port ${port} is unavailable; refusing to launch`))
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      clearTimeout(timer)
      server.close((error) => (error ? reject(error) : resolvePort()))
    })
  })
}

async function patchInspectorFuse(
  binary: string,
  build: Readonly<ClaudeManagedBuild>,
): Promise<void> {
  const file = await open(binary, 'r+')
  try {
    const wire = Buffer.alloc(FUSE_MARKER.length + 2 + 9)
    const markerOffset = build.fuseOffset - FUSE_MARKER.length - 2 - 3
    const { bytesRead } = await file.read(wire, 0, wire.length, markerOffset)
    if (
      bytesRead !== wire.length ||
      !wire.subarray(0, FUSE_MARKER.length).equals(FUSE_MARKER) ||
      wire[FUSE_MARKER.length] !== 1 ||
      wire[FUSE_MARKER.length + 1] !== 9 ||
      wire[FUSE_MARKER.length + 2 + 3] !== 48
    ) {
      throw Error('Unsupported Claude Electron inspector fuse state')
    }
    await file.write(Buffer.from([49]), 0, 1, build.fuseOffset)
    await file.sync()
  } finally {
    await file.close()
  }
  if ((await digest(binary)).sha256 !== build.managedSha256) {
    throw Error('Managed Claude executable differs from the single-fuse patch')
  }
}

async function verifyCopy(
  target: string,
  sourceBinary: string,
  build: Readonly<ClaudeManagedBuild>,
): Promise<void> {
  await regularDirectory(target)
  const manifestPath = childPath(target, MANIFEST)
  await digest(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CopyManifest
  if (
    manifest.schema !== 1 ||
    manifest.version !== build.version ||
    manifest.sourceBinary !== sourceBinary ||
    manifest.sourceSha256 !== build.sourceSha256 ||
    manifest.managedSha256 !== build.managedSha256 ||
    manifest.fuseOffset !== build.fuseOffset ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  ) {
    throw Error('Invalid managed Claude copy manifest')
  }
  const files = (await filesIn(target)).filter((path) => path !== MANIFEST)
  if (JSON.stringify(files) !== JSON.stringify(manifest.files.map((entry) => entry.path))) {
    throw Error('Managed Claude copy file inventory changed')
  }
  for (const expected of manifest.files) {
    const actual = await digest(childPath(target, expected.path))
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw Error(`Managed Claude copy changed: ${expected.path}`)
    }
  }
  const exe = manifest.files.find((entry) => entry.path.toLowerCase() === 'claude.exe')
  if (exe?.sha256 !== build.managedSha256) throw Error('Managed Claude executable hash mismatch')
  if (!manifest.files.some((entry) => entry.path === 'resources/app.asar')) {
    throw Error('Managed Claude copy is missing app resources')
  }
}

const preparing = new Map<string, Promise<string>>()

async function prepareCopy(
  sourceBinary: string,
  managedRoot: string,
  build: Readonly<ClaudeManagedBuild>,
): Promise<string> {
  await mkdir(managedRoot, { recursive: true })
  await regularDirectory(managedRoot)
  try {
    await lstat(join(managedRoot, 'Update.exe'))
    throw Error('Managed Claude root must not contain a Squirrel updater')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const target = childPath(managedRoot, `${build.version}-${build.sourceSha256.slice(0, 12)}`)
  const sourceDir = dirname(sourceBinary)
  const sourceRelative = relative(sourceDir, managedRoot)
  if (!sourceRelative || (!sourceRelative.startsWith('..') && !isAbsolute(sourceRelative))) {
    throw Error('Managed Claude copy must be outside the installed application')
  }
  try {
    await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return createCopy(sourceBinary, managedRoot, target, build)
  }
  await verifyCopy(target, sourceBinary, build)
  return join(target, 'claude.exe')
}

async function createCopy(
  sourceBinary: string,
  managedRoot: string,
  target: string,
  build: Readonly<ClaudeManagedBuild>,
): Promise<string> {
  // An interrupted build stays in its uniquely named staging directory, never a runnable cache.
  const staging = childPath(managedRoot, `.building-${randomUUID()}`)
  await mkdir(staging)
  const sourceDir = dirname(sourceBinary)
  const files = await filesIn(sourceDir, '', async (path) => {
    if (path) await mkdir(childPath(staging, path), { recursive: true })
  })
  if (!files.includes('resources/app.asar') || files.includes(MANIFEST)) {
    throw Error('Unsupported Claude resource layout')
  }
  const copied: FileDigest[] = []
  for (const path of files) {
    const source = childPath(sourceDir, path)
    const destination = childPath(staging, path)
    await mkdir(dirname(destination), { recursive: true })
    const before = await digest(source)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    const after = await digest(destination)
    if (before.sha256 !== after.sha256 || before.size !== after.size) {
      throw Error(`Claude source changed while copying: ${path}`)
    }
    copied.push({ path, ...after })
  }
  const executable = copied.find((entry) => entry.path.toLowerCase() === 'claude.exe')
  if (!executable || executable.sha256 !== build.sourceSha256) {
    throw Error('Claude source executable changed during copy')
  }
  await patchInspectorFuse(join(staging, executable.path), build)
  executable.sha256 = build.managedSha256
  if ((await digest(sourceBinary)).sha256 !== build.sourceSha256) {
    throw Error('Installed Claude executable changed during copy')
  }
  const manifest: CopyManifest = {
    schema: 1,
    version: build.version,
    sourceBinary,
    sourceSha256: build.sourceSha256,
    managedSha256: build.managedSha256,
    fuseOffset: build.fuseOffset,
    files: copied,
  }
  await writeFile(join(staging, MANIFEST), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  await rename(staging, target)
  return join(target, executable.path)
}

/** Builds a launch plan only. It never starts, stops, focuses, or edits an account profile. */
export async function prepareClaudeNativeLaunch(
  binary: string,
  config: ClaudeNativeProfileConfig | null,
  dependencies: ClaudeNativeLaunchDependencies = {},
): Promise<ClaudeNativeLaunchPlan> {
  if (config?.launchDebugger !== true) return { binary, extraArgs: [] }
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw Error('Automatic Claude debugger startup currently supports Windows only')
  }
  const checkPort = dependencies.assertPortAvailable ?? assertClaudeInspectorPortAvailable
  await checkPort(config.port)
  const build = dependencies.build ?? CLAUDE_MANAGED_BUILD
  const sourceBinary = await resolveClaudeNativeSource(binary, build)
  const managedRoot = resolve(dependencies.managedRoot ?? join(DATA_DIR, 'claude-native'))
  const key = `${managedRoot}\0${sourceBinary}`
  let operation = preparing.get(key)
  if (!operation) {
    operation = prepareCopy(sourceBinary, managedRoot, build)
    preparing.set(key, operation)
  }
  let managedBinary: string
  try {
    managedBinary = await operation
  } finally {
    if (preparing.get(key) === operation) preparing.delete(key)
  }
  // Copying may take seconds on the first launch. Recheck immediately before handing off.
  await checkPort(config.port)
  return {
    binary: managedBinary,
    extraArgs: [`--inspect=127.0.0.1:${config.port}`],
    nativeDebugger: {
      port: config.port,
      sourceBinary,
      managedBinary,
      version: build.version,
      manifest: join(dirname(managedBinary), MANIFEST),
      signature: 'modified-copy',
    },
  }
}
