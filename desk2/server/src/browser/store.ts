// A read-only reader of the Connections MCP's saved-browser store (its browser_* tools write it, Desk 2 never does).
//
//   <root>/registry.json     { profiles: { '<slug>/<name>' | '<bare name>': { sessionHosts, note, noteAt, ... } } }
//   <root>/workspaces.json   { '<slug>': { workspace: 'c:/Users/me/Folder' } }
//   <root>/ws/<slug>/<name>/ a workspace's own profile (a Chrome user-data-dir)
//   <root>/<name>/           a profile nobody owns (made before the store was split by workspace)
//   <root>/../browser-profile-logins.json   the ledger: { '<registry key>': { '<host>': { state, at } } }
//   <root>/../mcp-browser-profile/          the profile-less browser of the first MCP builds
//
// root is ~/.connections/browser-profiles, or HYDRA_DESK_BROWSER_STORE.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowserProfile, BrowserProfiles, BrowserSite, BrowserSiteState } from '@shared/browser'
import { liveBrowser } from './cdp'
import { normalizePath, workspaceCandidates } from './workspace'

export function storeRoot(): string {
  return process.env.HYDRA_DESK_BROWSER_STORE || join(homedir(), '.connections', 'browser-profiles')
}

/** The store's own bookkeeping, never a profile name. */
const RESERVED = new Set(['ws', 'registry.json', 'workspaces.json'])

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A file's JSON object: null when the file is missing, throws when it exists and cannot be read as one. */
function readObject(file: string): Json | null {
  if (!existsSync(file)) return null
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isObject(parsed)) throw new Error('not a JSON object')
  return parsed
}

function realDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      if (n.startsWith('.') || RESERVED.has(n)) return false
      // lstat: a junction left at an old path by a re-homing is not a profile.
      try {
        const st = lstatSync(join(dir, n))
        return st.isDirectory() && !st.isSymbolicLink()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

const STATES: BrowserSiteState[] = ['reached', 'signin-wall', 'challenged']

function sitesOf(ledger: Json, key: string): BrowserSite[] {
  const rows = ledger[key]
  if (!isObject(rows)) return []
  const out: BrowserSite[] = []
  for (const [host, row] of Object.entries(rows)) {
    if (!isObject(row) || typeof row.at !== 'string' || !STATES.includes(row.state as BrowserSiteState)) continue
    out.push({ host, state: row.state as BrowserSiteState, at: row.at })
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [])

/** The newest of the profile's recorded times (registry stamps, ledger sightings) and its folder's own mtime. */
function lastUsed(dir: string, entry: Json, sites: BrowserSite[]): string | null {
  const times: number[] = sites.map((s) => Date.parse(s.at))
  for (const k of ['loginOpenedAt', 'loginVerifiedAt', 'claimedAt', 'hostsAt']) {
    const t = typeof entry[k] === 'string' ? Date.parse(entry[k]) : Number.NaN
    times.push(t)
  }
  try {
    times.push(statSync(dir).mtimeMs)
  } catch {
    // floor-ok: a folder that cannot be stat-ed contributes no time
  }
  const known = times.filter((t) => Number.isFinite(t))
  return known.length ? new Date(Math.max(...known)).toISOString() : null
}

export interface ProfileRef {
  profile: BrowserProfile
  dir: string
  /** Port of the Chrome answering on this profile, or null. */
  port: number | null
}

export interface Listing {
  result: BrowserProfiles
  refs: ProfileRef[]
}

/** The saved browsers a chat in `cwd` may see: its workspace's own, and unowned ones while they are open. */
export async function listProfiles(cwd: string): Promise<Listing> {
  const root = storeRoot()
  const errors: string[] = []
  let registry: Json = {}
  let workspaces: Json = {}
  let ledger: Json = {}
  try {
    const reg = readObject(join(root, 'registry.json'))
    if (isObject(reg?.profiles)) registry = reg.profiles
  } catch (err) {
    errors.push(`registry.json: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    workspaces = readObject(join(root, 'workspaces.json')) ?? {}
  } catch (err) {
    errors.push(`workspaces.json: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    ledger = readObject(join(dirname(root), 'browser-profile-logins.json')) ?? {}
  } catch {
    // floor-ok: the ledger only adds sites; a broken one is shown as none
  }

  const slug = await matchWorkspace(cwd, workspaces)
  const make = (name: string, key: string, dir: string, own: boolean): Promise<ProfileRef> =>
    liveBrowser(dir).then((live) => {
      const entry = isObject(registry[key]) ? (registry[key] as Json) : {}
      const sites = sitesOf(ledger, key)
      return {
        dir,
        port: live?.port ?? null,
        profile: {
          name,
          ...(typeof entry.title === 'string' && entry.title.trim() !== '' ? { title: entry.title.trim() } : {}),
          note: typeof entry.note === 'string' && entry.note.trim() !== '' ? entry.note : null,
          sites,
          sessionHosts: stringList(entry.sessionHosts),
          open: live !== null,
          own,
          lastUsedAt: lastUsed(dir, entry, sites),
        },
      }
    })

  const ownNames = slug ? realDirs(join(root, 'ws', slug)) : []
  const bare = realDirs(root).filter((n) => !ownNames.includes(n))
  const legacy = join(dirname(root), 'mcp-browser-profile')
  const bareRefs: Promise<ProfileRef>[] = bare.map((n) => make(n, n, join(root, n), false))
  if (!bare.includes('default') && !ownNames.includes('default') && existsSync(legacy)) bareRefs.push(make('default', 'default', legacy, false))

  const own = await Promise.all(ownNames.map((n) => make(n, `${slug}/${n}`, join(root, 'ws', slug as string, n), true)))
  const unowned = (await Promise.all(bareRefs)).filter((r) => r.profile.open)
  const refs = [...own, ...unowned].sort((a, b) => a.profile.name.localeCompare(b.profile.name))
  const result: BrowserProfiles = { workspace: slug, profiles: refs.map((r) => r.profile) }
  if (errors.length) result.error = errors.join('; ')
  return { result, refs }
}

/** True when `name` is a saved browser of some workspace other than the one `cwd` belongs to (and of none this chat's own). */
export function ofAnotherWorkspace(listing: Listing, name: string): boolean {
  if (listing.refs.some((r) => r.profile.name === name)) return false
  const ws = join(storeRoot(), 'ws')
  return realDirs(ws).some((slug) => slug !== listing.result.workspace && realDirs(join(ws, slug)).includes(name))
}

async function matchWorkspace(cwd: string, workspaces: Json): Promise<string | null> {
  const entries = Object.entries(workspaces).flatMap(([slug, v]) =>
    isObject(v) && typeof v.workspace === 'string' ? [{ slug, path: normalizePath(v.workspace) }] : [],
  )
  if (entries.length === 0) return null
  // cwd first, then the repo's top folder, then the main worktree: the most specific one wins.
  for (const candidate of await workspaceCandidates(cwd)) {
    const hit = entries.find((e) => e.path === candidate)
    if (hit) return hit.slug
  }
  return null
}
