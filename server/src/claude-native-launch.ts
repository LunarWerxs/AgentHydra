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
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ClaudeNativeProfileConfig } from './claude-native-settings'
import { DATA_DIR } from './config'

const FUSE_MARKER = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
/** Electron's fuse wire: the marker, a schema byte, a fuse count, then one byte per fuse. */
const FUSE_WIRE = FUSE_MARKER.length + 2 + 9
/** The inspector fuse is the fourth of them; 48 is '0' (off) and 49 is '1' (on). */
const INSPECTOR_FUSE = FUSE_MARKER.length + 2 + 3
const MANIFEST = 'agenthydra-native-manifest.json'

export interface ClaudeManagedBuild {
  version: string
  sourceSha256: string
  managedSha256: string
  fuseOffset: number
}

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

/** Dependency injection is for small filesystem fixtures; runtime callers derive the build. */
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

/** Read size per chunk while hashing. The stream default (64 KiB) spent more time on chunk
 *  round trips than on SHA-256: 1 MiB chunks, several files at once (see HASH_CONCURRENCY),
 *  verified the 3,749-file / 614 MB managed copy in 1.5-2.2s where the old loop took 5.5-8.8s on
 *  the same loaded box (measured 2026-09-25, identical hashes). */
const HASH_CHUNK_BYTES = 1 << 20
/** How many files one verification hashes at the same time. */
const HASH_CONCURRENCY = 8

/** Runs `fn` over every item, at most `limit` at once; the first failure stops new work starting
 *  and is what rejects. Every item is still checked unless an earlier one already failed. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        await fn(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function digest(path: string): Promise<{ size: number; sha256: string }> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`Not a regular Claude file: ${path}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path, { highWaterMark: HASH_CHUNK_BYTES })) {
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

/**
 * One streaming pass over the installed executable yields everything the managed copy needs:
 * where the inspector fuse is, the installed hash, and the hash the patched copy must have.
 * Deriving these is what lets a Claude update work on the day it lands: the previous code
 * compared them against constants checked into this repo, so every release stopped every
 * native-control instance until a person re-measured the new binary by hand.
 */
async function scanInspectorFuse(
  binary: string,
): Promise<Pick<ClaudeManagedBuild, 'sourceSha256' | 'managedSha256' | 'fuseOffset'>> {
  const source = createHash('sha256')
  const managed = createHash('sha256')
  let markerOffset = -1
  let markers = 0
  let carry = Buffer.alloc(0)
  let position = 0
  for await (const chunk of createReadStream(binary)) {
    const bytes = chunk as Buffer
    source.update(bytes)
    // The marker can straddle a chunk boundary, so search it together with the previous tail.
    const window = carry.length ? Buffer.concat([carry, bytes]) : bytes
    const windowStart = position - carry.length
    for (let at = window.indexOf(FUSE_MARKER); at >= 0; at = window.indexOf(FUSE_MARKER, at + 1)) {
      markers++
      if (markerOffset < 0) markerOffset = windowStart + at
    }
    carry = Buffer.from(window.subarray(Math.max(0, window.length - (FUSE_MARKER.length - 1))))
    // The fuse always sits after the marker that announces it, so one pass can hash both forms.
    const fuse = markerOffset < 0 ? -1 : markerOffset + INSPECTOR_FUSE
    if (fuse >= position && fuse < position + bytes.length) {
      const patched = Buffer.from(bytes)
      patched[fuse - position] = 49
      managed.update(patched)
    } else {
      managed.update(bytes)
    }
    position += bytes.length
  }
  if (markers !== 1) {
    throw Error(`Claude executable has ${markers} Electron fuse wires; expected exactly one`)
  }
  const fuseOffset = markerOffset + INSPECTOR_FUSE
  if (fuseOffset + 1 > position) throw Error('Claude fuse wire is truncated')
  return {
    sourceSha256: source.digest('hex'),
    managedSha256: managed.digest('hex'),
    fuseOffset,
  }
}

/** Reads the fuse wire itself, so an unexpected layout is refused before anything is copied. */
async function assertFuseWire(binary: string, fuseOffset: number): Promise<void> {
  const file = await open(binary, 'r')
  try {
    const wire = Buffer.alloc(FUSE_WIRE)
    const { bytesRead } = await file.read(wire, 0, wire.length, fuseOffset - INSPECTOR_FUSE)
    if (
      bytesRead !== wire.length ||
      !wire.subarray(0, FUSE_MARKER.length).equals(FUSE_MARKER) ||
      wire[FUSE_MARKER.length] !== 1 ||
      wire[FUSE_MARKER.length + 1] !== 9 ||
      wire[INSPECTOR_FUSE] !== 48
    ) {
      throw Error('Unsupported Claude Electron inspector fuse state')
    }
  } finally {
    await file.close()
  }
}

/**
 * Describes the installed build instead of recognizing a reviewed one. The guarantees that
 * matter are unchanged and are all structural: exactly one fuse wire, a known fuse layout,
 * the inspector fuse currently off, and a copy that differs from the original by that one byte.
 */
export async function discoverClaudeBuild(sourceBinary: string): Promise<ClaudeManagedBuild> {
  const scanned = await scanInspectorFuse(sourceBinary)
  await assertFuseWire(sourceBinary, scanned.fuseOffset)
  const folder = basename(dirname(sourceBinary))
  const version = /^app-(\d+(?:\.\d+)*)$/.exec(folder)?.[1] ?? 'unknown'
  return Object.freeze({ version, ...scanned })
}

/** Resolve the real application behind Squirrel's stable stub, never silently pin an older app. */
export async function resolveClaudeNativeSource(binary: string): Promise<string> {
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
  // Always the newest installed application, never the stub's own older neighbour.
  const source = apps.length ? join(parent, apps[0].name, 'claude.exe') : binary
  await regularDirectory(dirname(source))
  await digest(source)
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
  await assertFuseWire(binary, build.fuseOffset)
  const file = await open(binary, 'r+')
  try {
    await file.write(Buffer.from([49]), 0, 1, build.fuseOffset)
    await file.sync()
  } finally {
    await file.close()
  }
  if ((await digest(binary)).sha256 !== build.managedSha256) {
    throw Error('Managed Claude executable differs from the single-fuse patch')
  }
}

/** A verified copy that no longer matches the installed app it was made from. Not tampering: the
 *  copy is intact but was made from an install that was not finished (see assertMatchesSource). */
class StaleManagedCopy extends Error {}

/**
 * The installed folder must hold exactly the files the copy recorded, at the recorded sizes.
 *
 * Squirrel extracts an update straight into its final app-<version> folder while the old version
 * keeps running, and the newest folder is now the one used. So a launch during that extraction can
 * see a complete claude.exe and app.asar with other files still missing, and a copy made from that
 * snapshot would be named after the same claude.exe as the finished install and trusted forever,
 * because on its own it verifies perfectly. Checking the copy against its SOURCE, not just against
 * itself, is what turns that into a rebuild. Sizes, not hashes: this runs on every launch, and a
 * file whose content changed at the same size would have to have been rewritten by the installer
 * after it was copied, which the per-file hashing during the copy already refuses.
 */
async function assertMatchesSource(sourceDir: string, recorded: FileDigest[]): Promise<void> {
  const current = await filesIn(sourceDir)
  if (JSON.stringify(current) !== JSON.stringify(recorded.map((entry) => entry.path))) {
    throw new StaleManagedCopy('Installed Claude files differ from the managed copy')
  }
  for (const entry of recorded) {
    const info = await lstat(childPath(sourceDir, entry.path))
    if (info.size !== entry.size) {
      throw new StaleManagedCopy(`Installed Claude file changed since the copy: ${entry.path}`)
    }
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
  // Every file is still hashed and compared on every launch (the guard the runbook says never to
  // weaken); only the reading is batched, because this runs before Claude is even started.
  await forEachLimited(manifest.files, HASH_CONCURRENCY, async (expected) => {
    const actual = await digest(childPath(target, expected.path))
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw Error(`Managed Claude copy changed: ${expected.path}`)
    }
  })
  const exe = manifest.files.find((entry) => entry.path.toLowerCase() === 'claude.exe')
  if (exe?.sha256 !== build.managedSha256) throw Error('Managed Claude executable hash mismatch')
  if (!manifest.files.some((entry) => entry.path === 'resources/app.asar')) {
    throw Error('Managed Claude copy is missing app resources')
  }
  // Last, so any sign of tampering above is still reported as tampering and fails closed.
  await assertMatchesSource(dirname(sourceBinary), manifest.files)
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
  try {
    await verifyCopy(target, sourceBinary, build)
  } catch (error) {
    if (!(error instanceof StaleManagedCopy)) throw error
    // Made from an unfinished install of this same claude.exe: move it aside and build it again
    // from the finished one. Windows will not move a folder whose Claude is still running, which
    // fails closed with the reason rather than launching the incomplete copy a second time.
    const aside = childPath(managedRoot, `.stale-${randomUUID()}`)
    try {
      await rename(target, aside)
    } catch (moveError) {
      const reason = moveError instanceof Error ? moveError.message : String(moveError)
      throw Error(
        `The managed Claude copy was made from an unfinished update and is still in use; close every Claude opened from it, then open again (${reason})`,
      )
    }
    await rm(aside, { recursive: true, force: true }).catch(() => undefined)
    return createCopy(sourceBinary, managedRoot, target, build)
  }
  return join(target, 'claude.exe')
}

async function createCopy(
  sourceBinary: string,
  managedRoot: string,
  target: string,
  build: Readonly<ClaudeManagedBuild>,
): Promise<string> {
  // A crashed build stays in its uniquely named staging directory, never a runnable cache; a
  // refused one is removed, because each is a full copy of Claude and refusals can repeat.
  const staging = childPath(managedRoot, `.building-${randomUUID()}`)
  await mkdir(staging)
  try {
    return await buildCopy(sourceBinary, staging, target, build)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function buildCopy(
  sourceBinary: string,
  staging: string,
  target: string,
  build: Readonly<ClaudeManagedBuild>,
): Promise<string> {
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
  // Files the installer added or grew while this copy ran mean the snapshot is not the install.
  try {
    await assertMatchesSource(sourceDir, copied)
  } catch (error) {
    if (!(error instanceof StaleManagedCopy)) throw error
    throw Error(`Claude is still being updated; open it again in a moment (${error.message})`)
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
  const sourceBinary = await resolveClaudeNativeSource(binary)
  const build = dependencies.build ?? (await discoverClaudeBuild(sourceBinary))
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
