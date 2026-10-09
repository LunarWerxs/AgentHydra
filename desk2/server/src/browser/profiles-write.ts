// The write side of the saved-browser registry (registry.json), shared with the Connections MCP while both run.
// Every write re-reads the file, changes only the entry it touched, keeps every other field, and replaces the
// file atomically (temp file + rename in the same folder). A registry that exists but does not parse is never
// overwritten: that would destroy whatever the other writer put there.

import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isObject, type Json, storeRoot } from './store'

export function registryFile(): string {
  return join(storeRoot(), 'registry.json')
}

function parseRegistry(): Json | null {
  const file = registryFile()
  if (!existsSync(file)) return {}
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return isObject(parsed) ? parsed : null
}

/** The registry as it is on disk right now; a missing or unreadable file reads as empty. */
export function readRegistry(): Json {
  try {
    return parseRegistry() ?? {}
  } catch {
    return {}
  }
}

function writeRegistry(reg: Json): void {
  const file = registryFile()
  mkdirSync(storeRoot(), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(reg, null, 2))
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Re-reads the registry, lets `change` alter it in place, and writes it back. Throws when the file on disk is unreadable. */
export function mutateRegistry<T>(change: (reg: Json) => T): T {
  const reg = parseRegistry()
  if (reg === null)
    throw new Error('registry.json is not a JSON object - left as it is so nothing is lost')
  const out = change(reg)
  writeRegistry(reg)
  return out
}

export function registryEntry(reg: Json, key: string): Json {
  const profiles = isObject(reg.profiles) ? reg.profiles : {}
  reg.profiles = profiles
  const entry = isObject(profiles[key]) ? profiles[key] : {}
  profiles[key] = entry
  return entry
}

const NOTE_MAX = 500
export function cleanNote(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .slice(0, NOTE_MAX)
}

/** Sets the note, or clears it when empty. Returns the note as stored. */
export function applyNote(entry: Json, raw: unknown): string {
  const note = cleanNote(raw)
  if (note) {
    entry.note = note
    entry.noteAt = new Date().toISOString()
  } else {
    delete entry.note
    delete entry.noteAt
  }
  return note
}

const TITLE_MAX = 40
/** Sets the title, or clears it when empty. Longer than TITLE_MAX is cut, never refused. */
export function applyTitle(entry: Json, raw: unknown): string {
  const title = String(raw ?? '')
    .trim()
    .slice(0, TITLE_MAX)
    .trim()
  if (title) entry.title = title
  else delete entry.title
  return title
}

export const noteFields = (entry: Json): Json => ({
  ...(entry.note ? { note: entry.note, noteAt: entry.noteAt } : {}),
  ...(entry.title ? { title: entry.title } : {}),
})

export function safeMtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return null
  }
}

// Cookies moved under Network/ in Chrome 96; a managed profile is a user-data-dir, so its real store may sit in Default/.
export function cookieStorePath(dir: string): string {
  const candidates = [
    join(dir, 'Network', 'Cookies'),
    join(dir, 'Cookies'),
    join(dir, 'Default', 'Network', 'Cookies'),
    join(dir, 'Default', 'Cookies'),
  ]
  return candidates.find((p) => existsSync(p)) || candidates[0]
}

// Cookie names that every site sets whether or not anyone signed in (analytics, bot shields, consent).
const NOISE_COOKIE =
  /^(__cf_bm|_cfuvid|cf_clearance|__cflb|_ga($|_)|_gid|_gat|_gcl_|_fbp|_fbc|ajs_|_hj|amplitude_|mp_|OptanonConsent|OptanonAlertBoxClosed|CONSENT|SOCS|NID|AEC|DV|test_cookie|IDE|receive-cookie-deprecation|__Secure-ENID|_pk_|intercom-device-id)/i

export interface CookieScan {
  hosts: string[]
  sessionHosts: string[]
}

/** Host names only: cookie values are never selected, returned or logged. The store is copied first because Chrome holds it locked. */
export function profileCookieScan(dir: string, limit = 400): CookieScan | null {
  const src = cookieStorePath(dir)
  if (!existsSync(src)) return null
  const root = mkdtempSync(join(tmpdir(), 'hydra-ck-'))
  try {
    const copy = join(root, 'Cookies')
    for (const suffix of ['', '-wal', '-journal']) {
      if (existsSync(src + suffix)) copyFileSync(src + suffix, copy + suffix)
    }
    const db = new Database(copy, { readonly: true })
    let rows: { host_key: unknown; name: unknown }[]
    try {
      rows = db.query('SELECT host_key, name FROM cookies').all() as {
        host_key: unknown
        name: unknown
      }[]
    } finally {
      db.close()
    }
    const hosts = new Set<string>()
    const session = new Set<string>()
    for (const row of rows) {
      const host = String(row.host_key || '').replace(/^\./, '')
      if (!host) continue
      hosts.add(host)
      const name = row.name == null ? null : String(row.name)
      if (name === null || !NOISE_COOKIE.test(name)) session.add(host)
    }
    return {
      hosts: [...hosts].sort().slice(0, limit),
      sessionHosts: [...session].sort().slice(0, limit),
    }
  } catch {
    return null
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Rescans a profile's hosts only when its cookie store changed; keeps the recorded reading when there is no store or Chrome holds it. */
export function refreshProfileHosts(reg: Json, key: string, dir: string): string[] {
  const entry = registryEntry(reg, key)
  const kept = Array.isArray(entry.sessionHosts) ? (entry.sessionHosts as string[]) : []
  const stamp = safeMtime(cookieStorePath(dir))
  if (!stamp || entry.hostsAt === stamp) return kept
  const scan = profileCookieScan(dir)
  if (!scan) {
    entry.hostsReadable = false
    return kept
  }
  entry.hosts = scan.hosts
  entry.sessionHosts = scan.sessionHosts
  entry.hostsAt = stamp
  entry.hostsReadable = true
  return scan.sessionHosts
}
