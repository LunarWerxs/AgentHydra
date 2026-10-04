// Folder browsing for the folder picker (SPEC.md REST row /api/folders/browse).

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface BrowseResult {
  /** The folder listed; '' for the list of drives (Windows). */
  path: string
  /** The folder above; '' (the drive list) above a Windows drive root; null at the very top. */
  parent: string | null
  /** Absolute paths of the sub-folders, sorted by name; the drive roots when path is ''. */
  dirs: string[]
}

/** A browse request the caller should answer 400 (the message is the real reason). */
export class BrowseError extends Error {}

const IS_WIN = process.platform === 'win32'
const FILE_ATTRIBUTE_HIDDEN = 0x2
const FILE_ATTRIBUTE_SYSTEM = 0x4
const INVALID_FILE_ATTRIBUTES = 0xffffffff

interface Kernel32 {
  GetFileAttributesW(path: Buffer): number
  GetLogicalDrives(): number
}

let kernel32: Kernel32 | null | undefined

/** kernel32 through bun:ffi on Windows (Node's fs does not expose the hidden/system attributes). */
async function win32(): Promise<Kernel32 | null> {
  if (kernel32 !== undefined) return kernel32
  kernel32 = null
  if (!IS_WIN) return null
  try {
    const { dlopen, FFIType } = await import('bun:ffi')
    const lib = dlopen('kernel32.dll', {
      GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetLogicalDrives: { args: [], returns: FFIType.u32 },
    })
    kernel32 = {
      GetFileAttributesW: (p) => lib.symbols.GetFileAttributesW(p) as number,
      GetLogicalDrives: () => lib.symbols.GetLogicalDrives() as number,
    }
  } catch (err) {
    console.error('[browse] kernel32 unavailable, hidden/system folders fall back to dot names:', err)
  }
  return kernel32
}

function wide(path: string): Buffer {
  return Buffer.from(`${path}\0`, 'utf16le')
}

function isHiddenOrSystem(k: Kernel32 | null, name: string, full: string): boolean {
  if (name.startsWith('.')) return true
  if (!k) return name === '$Recycle.Bin' || name === 'System Volume Information'
  const attrs = k.GetFileAttributesW(wide(full)) >>> 0
  if (attrs === INVALID_FILE_ATTRIBUTES) return true // vanished or unreadable: nothing to open
  return (attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) !== 0
}

async function drives(): Promise<string[]> {
  const k = await win32()
  const out: string[] = []
  const mask = k ? k.GetLogicalDrives() >>> 0 : 0
  for (let i = 0; i < 26; i++) {
    const root = `${String.fromCharCode(65 + i)}:\\`
    if (k ? mask & (1 << i) : existsSync(root)) out.push(root)
  }
  return out
}

/** A full path: on Windows a drive path (C:\...) or UNC (\\server\share\...); elsewhere starting with /. */
export function isAbsoluteFolder(path: string): boolean {
  if (IS_WIN) return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
  return path.startsWith('/')
}

function reason(err: unknown, path: string): string {
  const e = err as NodeJS.ErrnoException
  switch (e.code) {
    case 'ENOENT':
      return `no such folder: ${path}`
    case 'ENOTDIR':
      return `not a folder: ${path}`
    case 'EACCES':
    case 'EPERM':
      return `access denied: ${path}`
    default:
      return `cannot read ${path}: ${e.message ?? String(err)}`
  }
}

/** Lists the sub-folders of path; '' lists the Windows drives (or / elsewhere). */
export async function browse(input: string): Promise<BrowseResult> {
  const raw = input.trim()
  if (!raw) {
    if (IS_WIN) return { path: '', parent: null, dirs: await drives() }
    return browse('/')
  }
  if (!isAbsoluteFolder(raw)) throw new BrowseError(`the path must be absolute: ${raw}`)
  const path = resolve(raw)

  let entries: import('node:fs').Dirent[]
  try {
    if (!statSync(path).isDirectory()) throw new BrowseError(`not a folder: ${path}`)
    entries = readdirSync(path, { withFileTypes: true })
  } catch (err) {
    if (err instanceof BrowseError) throw err
    throw new BrowseError(reason(err, path))
  }

  const k = await win32()
  const dirs: string[] = []
  for (const e of entries) {
    const full = join(path, e.name)
    let isDir = e.isDirectory()
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        isDir = false // a dangling link
      }
    }
    if (!isDir || isHiddenOrSystem(k, e.name, full)) continue
    dirs.push(full)
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))

  const up = dirname(path)
  const parent = up !== path ? up : IS_WIN && /^[A-Za-z]:\\$/.test(path) ? '' : null
  return { path, parent, dirs }
}
