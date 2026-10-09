// browser_profile_adopt: copies one of this machine's own Chrome, Edge or Brave profiles into the saved-browser store, so
// the caller's workspace drives that signed-in session. Follows the Connections MCP's browser.mjs adoptExternalProfile.
// Two departures: an unrecorded folder is refused (AgentHydra writes no workspaces.json), and a live Chrome is found
// through liveBrowser.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { liveBrowser } from './cdp'
import { externalProfiles, SavedBrowserError } from './profiles-scope'
import { cookieStorePath, mutateRegistry, profileCookieScan, registryEntry, safeMtime } from './profiles-write'
import { isObject, type Json, matchWorkspace, readObject, storeRoot } from './store'

const ADOPT_ENTRIES = [
  'Network/Cookies',
  'Network/Cookies-journal',
  'Network/Trust Tokens',
  'Preferences',
  'Secure Preferences',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Service Worker/Database',
]
const SESSION_ENTRIES = new Set(['Network/Cookies', 'Network/Cookies-journal', 'Network/Trust Tokens'])

function profileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default'
  )
}

function findExternal(ref: string) {
  const wanted = ref.replace(/^chrome:/i, '').trim()
  if (!wanted) return null
  const all = externalProfiles()
  const lower = wanted.toLowerCase()
  return (
    all.find((p) => p.displayName.toLowerCase() === lower) ||
    all.find((p) => p.dir.toLowerCase() === lower) ||
    all.find((p) => `${p.browser}:${p.dir}`.toLowerCase() === lower) ||
    all.find((p) => p.displayName.toLowerCase().includes(lower)) ||
    null
  )
}

function copyInto(srcBase: string, dstBase: string, rel: string): string | null {
  const src = join(srcBase, ...rel.split('/'))
  if (!existsSync(src)) return null
  const dst = join(dstBase, ...rel.split('/'))
  try {
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true, force: true, errorOnExist: false })
    return rel
  } catch {
    return null
  }
}

function carryOsCryptKey(externalRoot: string, managedDir: string): boolean {
  try {
    const state: unknown = JSON.parse(readFileSync(join(externalRoot, 'Local State'), 'utf8'))
    if (!isObject(state) || !state.os_crypt) return false
    mkdirSync(managedDir, { recursive: true })
    writeFileSync(join(managedDir, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }))
    return true
  } catch {
    return false
  }
}

function appBoundEncrypted(externalRoot: string): boolean {
  try {
    const state: unknown = JSON.parse(readFileSync(join(externalRoot, 'Local State'), 'utf8'))
    return isObject(state) && isObject(state.os_crypt) && Boolean(state.os_crypt.app_bound_encrypted_key)
  } catch {
    return false
  }
}

export async function adoptProfile(
  cwd: string,
  from: string,
  as: string | undefined,
  refresh: boolean,
  force: boolean,
): Promise<Json> {
  const ext = findExternal(from)
  if (!ext) {
    const known = externalProfiles()
      .map((p) => p.displayName)
      .join(', ')
    throw new SavedBrowserError(
      `no Chrome profile on this machine matches ${JSON.stringify(from)}. Known: ${known || '(none found)'}`,
    )
  }
  const name = profileSlug(as || ext.displayName)
  const externalRoot = dirname(ext.path)
  const appBound = appBoundEncrypted(externalRoot)
  if (appBound && !force)
    throw new SavedBrowserError(
      `${ext.browser} profile "${ext.displayName}" is protected by app-bound cookie encryption, so its session CANNOT be copied - ` +
        `a copy launches SIGNED OUT and Chrome silently deletes the cookies it cannot decrypt (measured: 96 rows -> 0). ` +
        `Do this instead, once, and the MCP owns the login forever: ` +
        `browser_profile_login { profile: '${name}', url: '<the site>' } - it opens a plain visible Chrome on the managed ` +
        `profile with no debugger attached (so no bot wall), the human signs in, and every later browser_* call with ` +
        `profile:'${name}' reuses it. Pass force:true only to copy the non-session files anyway.`,
    )

  const root = storeRoot()
  const workspaces = readObject(join(root, 'workspaces.json')) ?? {}
  const slug = await matchWorkspace(cwd, workspaces)
  if (!slug)
    throw new SavedBrowserError(
      'browser_profile_adopt needs a workspace: this folder is not a recorded workspace yet, so there is nothing to adopt into.',
    )
  const owned = join(root, 'ws', slug, name)
  const legacy = join(root, name)
  const legacyInPlace =
    !existsSync(owned) && existsSync(legacy) && lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink()
  const managed = legacyInPlace ? legacy : owned
  const key = legacyInPlace ? name : `${slug}/${name}`
  const scope = legacyInPlace ? 'unowned' : 'workspace'

  const already = existsSync(managed)
  if (already && !refresh)
    return {
      status: 'already-adopted',
      profile: name,
      scope,
      from: ext.displayName,
      hint: `already in the managed store — drive it with profile:'${name}', or pass refresh:true to re-copy the live session`,
    }
  if (already && (await liveBrowser(managed)))
    throw new SavedBrowserError(
      `managed profile '${name}' has a live Chrome — browser_close { profile: '${name}' } first, then refresh`,
    )

  mkdirSync(join(managed, 'Default'), { recursive: true })
  const keyCarried = carryOsCryptKey(externalRoot, managed)
  const wanted = ADOPT_ENTRIES.filter((rel) => !(appBound && SESSION_ENTRIES.has(rel)))
  const copied = wanted
    .map((rel) => copyInto(ext.path, join(managed, 'Default'), rel))
    .filter((rel): rel is string => rel !== null)
  const scan = profileCookieScan(managed)
  const stamp = safeMtime(cookieStorePath(managed))
  const adoptedFrom = { browser: ext.browser, dir: ext.dir, displayName: ext.displayName, path: ext.path }
  mutateRegistry((reg) => {
    const entry = registryEntry(reg, key)
    entry.adoptedFrom = adoptedFrom
    entry.adoptedAt = new Date().toISOString()
    entry.copied = copied
    entry.osCryptKeyCarried = keyCarried
    entry.hosts = scan?.hosts ?? []
    entry.sessionHosts = scan?.sessionHosts ?? []
    entry.hostsAt = stamp
    entry.hostsReadable = scan !== null
  })
  const sessionHosts = scan?.sessionHosts ?? []
  return {
    status: refresh && already ? 'refreshed' : 'adopted',
    profile: name,
    scope,
    from: `${ext.browser}:${ext.dir}${ext.displayName ? ` (${ext.displayName})` : ''}`,
    copied,
    osCryptKeyCarried: keyCarried,
    signedInHostSample: sessionHosts.slice(0, 25),
    hostCount: sessionHosts.length,
    note: keyCarried
      ? `drive it with profile:'${name}'. Sessions expire on their own clock — re-run with refresh:true when a site asks for a login again.`
      : `WARNING: could not carry the os_crypt key from ${externalRoot} — cookies may not decrypt, so this copy can read as signed out.`,
  }
}
