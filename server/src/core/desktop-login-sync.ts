// server/src/core/desktop-login-sync.ts — the desktop half of login sync. core/cli-login-sync.ts runs
// it in the same pass, through the same store and key.
//
// WHY (owner, 2026-10-01: "yes, build the desktop login sync"): a Claude Desktop account signed in on
// one PC is signed in on the other too, without the browser sign-in there.
//
// WHAT A DESKTOP LOGIN IS (checked 2026-10-01 on seven profiles, by key and cookie names only):
// config.json's `lastKnownAccountUuid` and `oauth:tokenCacheV2` / `oauth:tokenCache` (Electron
// safeStorage: 'v10' + nonce + AES-256-GCM under the profile's own key, which `Local State` keeps
// DPAPI-sealed for this Windows user; core/instance-logout.ts removes exactly these), plus the
// claude.ai sign-in cookies in Network/Cookies (`sessionKey*`, `lastActiveOrg`, `routingHint`;
// Chromium cookie database version 24: the same cipher, the plaintext led by SHA-256 of the
// cookie's host). Neither copies as bytes: every profile on every PC has its own key. So a login
// travels decrypted inside the sync's own encryption and is encrypted again on arrival under the
// receiving profile's key.
//
// THE RULES
// - Keyed in the store by the account's uuid (meta.kind 'desktop'): the same account matches on both
//   PCs whatever its folder is called.
// - Never written under a running app: it holds config.json and Cookies open and saves over them
//   (core/instance-logout.ts). A pass leaves a running profile for later, and AgentHydra lands a newer
//   login just before it opens one (landBeforeLaunch).
// - Never replaces a login this PC signed in on its own. Two separate sign-ins of one account each
//   have their own tokens and both stay signed in; tying them together would let either PC's refresh
//   sign the other out. A PC joins the store's copy only where it has none: a signed-out profile of
//   the same folder name, or a new profile made with that name and number.
// - From then on the copy whose tokens expire later wins, as for the CLI (a refresh pushes them out).
// - Cookies are read only while the profile is closed (Chromium holds the database locked); a pass
//   while it runs sends the new tokens with the cookies the store already has.
// - Windows only: elsewhere the profile key lives in the Keychain or a keyring, which nothing here
//   writes.
//
// ⛔ SECRETS: tokens and cookie values pass through memory to be encrypted; nothing here logs them,
// and status answers carry none.

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteAccountsCacheEntry } from './accounts'
import {
  decryptSafeStorage,
  decryptV10Gcm,
  encryptSafeStorage,
  encryptV10Gcm,
  getWindowsMasterKey,
} from './crypto'
import { ensureWindowsMasterKey } from './crypto/keys.win'
import { claimInstanceNumber, instanceNumbers, instanceRef } from './instance-numbers'
import { createInstance } from './lifecycle'
import { instancesRoot, normalizePath } from './paths'
import { listClaudeProcesses } from './process'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAUDE_HOST = /^\.?claude\.ai$|\.claude\.ai$/
/** The cookies that carry a claude.ai sign-in: the session and the organisation it opens on. */
const isAuthCookie = (name: string): boolean =>
  name.startsWith('sessionKey') || name === 'lastActiveOrg' || name === 'routingHint'
/** From this cookie database version on, a cookie's plaintext starts with SHA-256 of its host. */
const HOSTED_COOKIES_VERSION = 24

/** One cookie row: every column but `encrypted_value`, its plaintext in `value`. Whole numbers too
 *  big for a double (Chromium's microsecond times) travel as strings of digits. */
export type DesktopCookie = Record<string, string | number | null> & {
  host_key: string
  name: string
  value: string
}

export interface PortableDesktopLogin {
  kind: 'desktop'
  /** The account's uuid: the store key. */
  id: string
  num: number | null
  /** The profile folder's name on the PC that sent it. */
  name: string
  tokenCacheV2: string | null
  tokenCache: string | null
  /** Null when the sending PC could not read them (its app was running) and the store had none. */
  cookies: DesktopCookie[] | null
  /** The latest expiry among its grants (epoch ms): the later copy wins. */
  expiresAt: number
}

/** A store blob's content as a desktop login for `id`, or null. */
export function asDesktopLogin(v: unknown, id: string): PortableDesktopLogin | null {
  const l = v as PortableDesktopLogin | null
  return l?.kind === 'desktop' &&
    l.id === id &&
    (typeof l.tokenCacheV2 === 'string' || typeof l.tokenCache === 'string')
    ? l
    : null
}

export interface DesktopProfile {
  dir: string
  name: string
  num: number | null
  /** The account it is signed in to; null when signed out or never signed in. */
  uuid: string | null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
/** What decides "changed here": the token caches, not the cookies or the file's other settings. */
export const tokensHash = (v2: string | null, v1: string | null): string =>
  sha256(`${v2 ?? ''}\n${v1 ?? ''}`)

/** Every AgentHydra desktop profile here (the instances root only: the machine's own Claude login
 *  is never touched), with its number and the account it is signed in to. */
export function listDesktopProfiles(): DesktopProfile[] {
  const root = instancesRoot()
  if (!existsSync(root)) return []
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, dir: normalizePath(join(root, e.name)) }))
  const nums = instanceNumbers(dirs.map((d) => instanceRef('desktop', d.dir)))
  return dirs.map((d) => {
    const cfg = readJson(join(d.dir, 'config.json'))
    const uuid = cfg?.lastKnownAccountUuid
    const signedIn =
      typeof cfg?.['oauth:tokenCacheV2'] === 'string' ||
      typeof cfg?.['oauth:tokenCache'] === 'string'
    return {
      ...d,
      num: nums.get(instanceRef('desktop', d.dir)) ?? null,
      uuid: signedIn && typeof uuid === 'string' && UUID_RE.test(uuid) ? uuid : null,
    }
  })
}

/** The profile's token caches, decrypted with its own key; null when it holds none that open. */
export async function readDesktopTokens(
  dir: string,
): Promise<{ uuid: string; v2: string | null; v1: string | null } | null> {
  const cfg = readJson(join(dir, 'config.json'))
  const uuid = cfg?.lastKnownAccountUuid
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null
  const open = (k: string): Promise<string | null> =>
    typeof cfg?.[k] === 'string' ? decryptSafeStorage(cfg[k] as string, dir) : Promise.resolve(null)
  const [v2, v1] = await Promise.all([open('oauth:tokenCacheV2'), open('oauth:tokenCache')])
  return v2 || v1 ? { uuid, v2, v1 } : null
}

/** The latest `expiresAt` among the grants of the token caches (epoch ms; 0 when none says). */
export function tokenExpiry(...caches: Array<string | null>): number {
  let latest = 0
  for (const c of caches) {
    if (!c) continue
    try {
      for (const g of Object.values(JSON.parse(c) as Record<string, unknown>)) {
        const e = Number((g as { expiresAt?: unknown } | null)?.expiresAt) || 0
        if (e > latest) latest = e
      }
    } catch {
      // not JSON: no expiry to read
    }
  }
  return latest
}

const cookieDb = (dir: string): string => join(dir, 'Network', 'Cookies')
const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function cookieVersion(d: Database): number {
  try {
    return Number((d.query("select value from meta where key='version'").get() as any)?.value) || 0
  } catch {
    return 0
  }
}

/** Read a cookie database through a copy: Chromium holds the live one locked while it runs, and a
 *  copy never disturbs it. Null when it cannot be copied (the app is running) or opened. */
function withCookieCopy<T>(dir: string, read: (d: Database) => T): T | null {
  const db = cookieDb(dir)
  if (!existsSync(db)) return null
  const tmp = join(tmpdir(), `ah-cookies-${process.pid}-${Date.now()}.db`)
  try {
    copyFileSync(db, tmp)
    const d = new Database(tmp, { readonly: true, safeIntegers: true })
    try {
      return read(d)
    } finally {
      d.close()
    }
  } catch {
    return null
  } finally {
    rmSync(tmp, { force: true })
  }
}

const plainRow = (row: Record<string, unknown>): Record<string, string | number | null> => {
  const out: Record<string, string | number | null> = {}
  for (const [k, v] of Object.entries(row))
    out[k] =
      typeof v === 'bigint'
        ? v.toString()
        : typeof v === 'number' || typeof v === 'string'
          ? v
          : null
  return out
}

/** The profile's claude.ai sign-in cookies, decrypted with its own key; null while its app holds the
 *  database, or when it has none. */
export async function readAuthCookies(dir: string): Promise<DesktopCookie[] | null> {
  const key = await getWindowsMasterKey(dir)
  if (!key) return null
  const rows = withCookieCopy(dir, (d) => ({
    hashed: cookieVersion(d) >= HOSTED_COOKIES_VERSION,
    rows: (d.query('select * from cookies').all() as Array<Record<string, unknown>>).filter(
      (r) => CLAUDE_HOST.test(String(r.host_key)) && isAuthCookie(String(r.name)),
    ),
  }))
  if (!rows) return null
  const out: DesktopCookie[] = []
  for (const r of rows.rows) {
    const plain = await decryptV10Gcm(key, new Uint8Array(r.encrypted_value as Uint8Array))
    if (!plain) continue
    const { encrypted_value: _sealed, ...rest } = r
    out.push({
      ...plainRow(rest),
      host_key: String(r.host_key),
      name: String(r.name),
      value: new TextDecoder().decode(rows.hashed ? plain.subarray(32) : plain),
    })
  }
  return out
}

interface CookieSchema {
  sql: string[]
  meta: Array<[string, string]>
}

/** Chromium's cookie database at version 24, as Claude Desktop made it on 2026-10-01: what a PC
 *  with no desktop profile of its own to copy from gets (the first stand-in second PC had none, and
 *  every login landed without its cookies). An app on a later version migrates it on first open. */
const COOKIE_SCHEMA_V24: CookieSchema = {
  sql: [
    'CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)',
    'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL)',
    'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port)',
  ],
  meta: [
    ['mmap_status', '-1'],
    ['version', '24'],
    ['last_compatible_version', '24'],
  ],
}

/** A cookie database's schema (tables, indexes, meta rows) for a profile this PC makes, which has
 *  none until its app first runs: another profile's here (this PC's app version), else version 24. */
function cookieSchema(except: string): CookieSchema {
  for (const p of listDesktopProfiles()) {
    if (p.dir === except) continue
    const schema = withCookieCopy(p.dir, (d) => ({
      sql: (
        d
          .query(
            "select sql from sqlite_master where sql is not null order by case type when 'table' then 0 else 1 end",
          )
          .all() as Array<{ sql: string }>
      ).map((r) => r.sql),
      meta: (
        d.query('select key, value from meta').all() as Array<{ key: string; value: string }>
      ).map((r) => [String(r.key), String(r.value)] as [string, string]),
    }))
    if (schema?.sql.some((s) => /create table\s+cookies/i.test(s))) return schema
  }
  return COOKIE_SCHEMA_V24
}

/** A cookie database for a profile that has none yet, with the schema this PC's other profiles
 *  use (cookieSchema). */
function createCookieDb(dir: string, path: string): void {
  const schema = cookieSchema(dir)
  mkdirSync(join(dir, 'Network'), { recursive: true })
  const fresh = new Database(path, { create: true })
  try {
    for (const sql of schema.sql) fresh.run(sql)
    for (const [k, v] of schema.meta)
      fresh.run('insert or replace into meta (key, value) values (?, ?)', [k, v])
  } finally {
    fresh.close()
  }
}

interface CookieColumn {
  name: string
  type: string
}

/** A carried cookie field as its column takes it: an integer column's digits become a BigInt. */
const columnValue = (v: DesktopCookie[string] | undefined, type: string): unknown =>
  typeof v === 'string' && /int/i.test(type) && /^-?\d+$/.test(v) ? BigInt(v) : (v ?? null)

/** One cookie as a row of this database's own columns, its value encrypted under the profile's
 *  key (behind the host's hash where the database's version asks for it). */
async function cookieRow(
  c: DesktopCookie,
  cols: CookieColumn[],
  key: Uint8Array,
  hashed: boolean,
): Promise<Record<string, unknown>> {
  const value = new TextEncoder().encode(c.value)
  const plain = hashed
    ? new Uint8Array([...createHash('sha256').update(c.host_key).digest(), ...value])
    : value
  const row: Record<string, unknown> = {}
  for (const col of cols) {
    if (col.name === 'encrypted_value') row[col.name] = await encryptV10Gcm(key, plain)
    else if (col.name === 'value') row[col.name] = ''
    else row[col.name] = columnValue(c[col.name], col.type)
  }
  return row
}

/** Swap the profile's own claude.ai sign-in cookies for `rows`, in one transaction. */
function replaceAuthCookies(
  d: Database,
  names: string[],
  rows: Array<Record<string, unknown>>,
): void {
  const insert = d.prepare(
    `insert or replace into cookies (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`,
  )
  try {
    d.transaction(() => {
      for (const old of d.query('select rowid, host_key, name from cookies').all() as Array<{
        rowid: bigint
        host_key: string
        name: string
      }>)
        if (CLAUDE_HOST.test(old.host_key) && isAuthCookie(old.name))
          d.run('delete from cookies where rowid = ?', [old.rowid])
      for (const row of rows) insert.run(...(names.map((n) => row[n]) as any[]))
    })()
  } finally {
    // A prepare()d statement is not finalized by close(): until the collector got to it, the closed
    // database kept the profile's Cookies file open (EBUSY on Windows, CI run 37043007234).
    insert.finalize()
  }
}

/** Write the sign-in cookies into a closed profile's database under its key, replacing its own
 *  claude.ai sign-in cookies. False when the write fails (the app opened meanwhile). */
async function writeAuthCookies(
  dir: string,
  key: Uint8Array,
  cookies: DesktopCookie[],
): Promise<boolean> {
  const path = cookieDb(dir)
  if (!existsSync(path)) createCookieDb(dir, path)
  const d = new Database(path, { safeIntegers: true })
  try {
    const cols = d.query('pragma table_info(cookies)').all() as CookieColumn[]
    const hashed = cookieVersion(d) >= HOSTED_COOKIES_VERSION
    const rows: Array<Record<string, unknown>> = []
    for (const c of cookies) rows.push(await cookieRow(c, cols, key, hashed))
    replaceAuthCookies(
      d,
      cols.map((c) => c.name),
      rows,
    )
    return true
  } catch {
    return false
  } finally {
    d.close()
  }
}

/** The normalized dirs of every running Claude Desktop app; null when the scan failed (then nothing
 *  is written: a profile that cannot be ruled out is treated as open). */
export async function runningDesktopDirs(): Promise<Set<string> | null> {
  try {
    const procs = await listClaudeProcesses({ fresh: true })
    return new Set(procs.filter((p) => p.dir).map((p) => normalizePath(p.dir as string)))
  } catch {
    return null
  }
}

/** A login to send: this profile's tokens, and its cookies when they can be read (else `cookies`). */
export async function portableDesktopLogin(
  p: DesktopProfile & { uuid: string },
  tokens: { v2: string | null; v1: string | null },
  cookies: DesktopCookie[] | null,
): Promise<PortableDesktopLogin> {
  return {
    kind: 'desktop',
    id: p.uuid,
    num: p.num,
    name: p.name,
    tokenCacheV2: tokens.v2,
    tokenCache: tokens.v1,
    cookies,
    expiresAt: tokenExpiry(tokens.v2, tokens.v1),
  }
}

/** A folder name here for a profile the store holds: its own name when free, else one with
 *  "-synced" after it. */
function freeName(name: string, profiles: DesktopProfile[]): string {
  const taken = new Set(profiles.map((p) => p.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let i = 1; i < 50; i++) {
    const n = i === 1 ? `${name}-synced` : `${name}-synced-${i}`
    if (!taken.has(n.toLowerCase())) return n
  }
  return `${name}-${Date.now()}`
}

export interface DesktopLandResult {
  written: boolean
  created: boolean
  num: number | null
  dir: string | null
  message: string
}

/**
 * Sign a closed profile in with `login`: `target` when given (a signed-out profile, or one the store's
 * copy replaces), else a new profile made with the login's folder name and number. The caller has
 * checked the profile is closed; the writes are each atomic, and a cookie write the app races
 * fails rather than mixes.
 */
export async function landDesktopLogin(
  login: PortableDesktopLogin,
  target: DesktopProfile | null,
  profiles: DesktopProfile[],
): Promise<DesktopLandResult> {
  if (process.platform !== 'win32')
    return {
      written: false,
      created: false,
      num: login.num,
      dir: null,
      message: 'Desktop logins sync on Windows only.',
    }
  let dir = target?.dir ?? null
  let num = target?.num ?? null
  let created = false
  if (!dir) {
    const made = await createInstance(freeName(login.name, profiles))
    if (!made.ok || !made.dir)
      return {
        written: false,
        created: false,
        num: login.num,
        dir: null,
        message: made.message ?? 'Could not make its desktop profile here.',
      }
    dir = normalizePath(made.dir)
    created = true
    const ref = instanceRef('desktop', dir)
    if (login.num !== null) claimInstanceNumber(ref, login.num)
    num = instanceNumbers([ref]).get(ref) ?? null
  }
  const key = await ensureWindowsMasterKey(dir)
  if (!key)
    return {
      written: false,
      created,
      num,
      dir,
      message: 'Its profile key cannot be read or made on this PC.',
    }
  const path = join(dir, 'config.json')
  const cfg = readJson(path) ?? {}
  const [v2, v1] = await Promise.all([
    login.tokenCacheV2 ? encryptSafeStorage(login.tokenCacheV2, dir) : Promise.resolve(null),
    login.tokenCache ? encryptSafeStorage(login.tokenCache, dir) : Promise.resolve(null),
  ])
  if ((login.tokenCacheV2 && !v2) || (login.tokenCache && !v1))
    return { written: false, created, num, dir, message: 'Its login could not be encrypted here.' }
  cfg.lastKnownAccountUuid = login.id
  if (v2) cfg['oauth:tokenCacheV2'] = v2
  else delete cfg['oauth:tokenCacheV2']
  if (v1) cfg['oauth:tokenCache'] = v1
  else delete cfg['oauth:tokenCache']
  writeAtomic(path, JSON.stringify(cfg, null, 2))
  deleteAccountsCacheEntry(dir)
  const cookies = login.cookies?.length ? await writeAuthCookies(dir, key, login.cookies) : null
  const what = created
    ? 'Made this desktop profile and signed it in.'
    : 'Signed in with the newer login.'
  return {
    written: true,
    created,
    num,
    dir,
    message:
      cookies === false
        ? `${what} Its claude.ai cookies could not be written: if it asks to sign in, sign in once.`
        : what,
  }
}

/** One pass's view of the store and this PC's agreement with it, from core/cli-login-sync.ts. */
export interface DesktopSyncContext {
  /** The store's rows (desktop and CLI alike; a desktop one has kind 'desktop'). */
  store: Map<string, { version: number; num: number | null; kind: string; name: string | null }>
  state: Record<string, { version: number; hash: string; cookies?: number }>
  excluded: Set<string>
  /** Upload; the new version, or null when the store moved meanwhile (409). */
  upload(login: PortableDesktopLogin, expect: number): Promise<number | null>
  download(id: string): Promise<PortableDesktopLogin | null>
  note(num: number | null, action: 'pushed' | 'pulled' | 'created' | 'skipped', text: string): void
  out: { pushed: number; landed: number; unchanged: number; problems: string[] }
}

/** Logins this PC signed in on its own while the store holds the other PC's (left alone), and
 *  newer ones waiting for a running profile to close, as of the last pass: the status says so. */
export const desktopNotes = { own: new Set<string>(), waiting: new Set<string>() }

/** A store version this PC decided to wait on (its profile's app was running), by account, as
 *  `<store version>:<local token hash>`: the same wait is not downloaded again each pass. */
const deferred = new Map<string, string>()

const cookieMarks = (cs: DesktopCookie[] | null): string =>
  (cs ?? [])
    .map((c) => `${c.host_key}|${c.name}|${c.path ?? ''}|${c.value}`)
    .sort()
    .join('\n')
/** The same sign-in cookies (host, name, path and value), whatever their timestamps. */
const sameCookies = (a: DesktopCookie[] | null, b: DesktopCookie[] | null): boolean =>
  cookieMarks(a) === cookieMarks(b)

type DesktopStoreRow = NonNullable<ReturnType<DesktopSyncContext['store']['get']>>
type DesktopSyncState = DesktopSyncContext['state'][string]

/** What one pass carries from profile to profile. */
interface DesktopPass {
  ctx: DesktopSyncContext
  profiles: DesktopProfile[]
  /** The folders whose app runs now; null when that could not be read (nothing counts as closed). */
  running: Set<string> | null
  own: Set<string>
  waiting: Set<string>
}

/** One signed-in profile as this pass found it. */
interface ProfileLook {
  uuid: string
  p: DesktopProfile & { uuid: string }
  remote: DesktopStoreRow | undefined
  tokens: NonNullable<Awaited<ReturnType<typeof readDesktopTokens>>>
  hash: string
  /** What this PC and the store last agreed on, as it stood when the pass reached the profile. */
  st: DesktopSyncState | undefined
  cookiesAt: number
  isClosed: boolean
  /** This profile's sign-in cookies, read at most once a pass; null while its app runs. */
  read: Promise<DesktopCookie[] | null> | null
}

const isClosedDir = (running: Set<string> | null, dir: string): boolean =>
  !!running && !running.has(dir)

/** Sign a store login in here and record the agreement, or say why it was skipped. */
async function landFromStore(
  pass: DesktopPass,
  login: PortableDesktopLogin,
  target: DesktopProfile | null,
  version: number,
): Promise<void> {
  const { ctx } = pass
  const r = await landDesktopLogin(login, target, pass.profiles)
  if (r.written && r.dir) {
    ctx.state[login.id] = {
      version,
      hash: tokensHash(login.tokenCacheV2, login.tokenCache),
      cookies: mtimeOf(cookieDb(r.dir)),
    }
    ctx.out.landed++
    ctx.note(r.num, r.created ? 'created' : 'pulled', r.message)
  } else {
    ctx.out.problems.push(`#${r.num ?? '?'}: ${r.message}`)
    ctx.note(r.num, 'skipped', r.message)
  }
}

function freshCookies(look: ProfileLook): Promise<DesktopCookie[] | null> {
  look.read ??= look.isClosed ? readAuthCookies(look.p.dir) : Promise.resolve(null)
  return look.read
}

/** An upload carries this profile's cookies when it has some, else the store's: tokens sent
 *  while the app runs must not wipe the cookies a closed profile sent before. `theirs` is the
 *  store's cookies when the caller already holds them; left out, they are downloaded. */
async function cookiesToSend(
  pass: DesktopPass,
  look: ProfileLook,
  theirs?: DesktopCookie[] | null,
): Promise<DesktopCookie[] | null> {
  const own = await freshCookies(look)
  if (own?.length) return own
  if (theirs !== undefined) return theirs
  if (!look.remote) return null
  return (await pass.ctx.download(look.uuid))?.cookies ?? null
}

async function sendProfile(
  pass: DesktopPass,
  look: ProfileLook,
  expect: number,
  theirs?: DesktopCookie[] | null,
): Promise<void> {
  const { ctx } = pass
  const cookies = await cookiesToSend(pass, look, theirs)
  const v = await ctx.upload(await portableDesktopLogin(look.p, look.tokens, cookies), expect)
  if (v !== null)
    ctx.state[look.uuid] = {
      version: v,
      hash: look.hash,
      cookies: look.isClosed ? look.cookiesAt : look.st?.cookies,
    }
}

/** This PC and the store agree on the version: upload what changed here since, if anything. */
async function syncAgreedProfile(
  pass: DesktopPass,
  look: ProfileLook,
  remote: DesktopStoreRow,
  st: DesktopSyncState,
): Promise<void> {
  const { ctx } = pass
  const cookiesMoved = look.isClosed && look.cookiesAt > (st.cookies ?? 0)
  if (st.hash !== look.hash) {
    await sendProfile(pass, look, remote.version)
    return
  }
  if (!cookiesMoved) {
    ctx.out.unchanged++
    return
  }
  // Only the cookie database changed since the last look (the app ran and closed): upload
  // when its sign-in cookies really differ from the store's, else just note the look.
  const local = await freshCookies(look)
  const theirs = (await ctx.download(look.uuid))?.cookies ?? null
  if (local?.length && !sameCookies(local, theirs)) {
    await sendProfile(pass, look, remote.version, theirs)
    return
  }
  ctx.state[look.uuid] = { ...st, cookies: look.cookiesAt }
  ctx.out.unchanged++
}

/** The store moved on since this PC last agreed with it. A decision that waits for the app to
 *  close is remembered, so a profile open for days is not downloaded again every pass. */
async function syncMovedProfile(
  pass: DesktopPass,
  look: ProfileLook,
  remote: DesktopStoreRow,
  st: DesktopSyncState,
): Promise<void> {
  const { ctx } = pass
  const { uuid, hash, isClosed, tokens } = look
  const pending = `${remote.version}:${hash}`
  if (!isClosed && deferred.get(uuid) === pending) {
    pass.waiting.add(uuid)
    return
  }
  const theirs = await ctx.download(uuid)
  if (!theirs) return
  const sameTokens = tokensHash(theirs.tokenCacheV2, theirs.tokenCache) === hash
  // The same tokens with other cookies: the store's are the ones that moved (a profile that was
  // open when its tokens went up sends its cookies once it closes).
  const cookiesToLand =
    sameTokens &&
    !!theirs.cookies?.length &&
    !(isClosed && sameCookies(await freshCookies(look), theirs.cookies))
  if (sameTokens && !cookiesToLand) {
    ctx.state[uuid] = { version: remote.version, hash, cookies: st.cookies }
    ctx.out.unchanged++
  } else if (!sameTokens && tokenExpiry(tokens.v2, tokens.v1) > theirs.expiresAt)
    await sendProfile(pass, look, remote.version, theirs.cookies)
  else if (!isClosed) {
    deferred.set(uuid, pending)
    pass.waiting.add(uuid)
  } else await landFromStore(pass, theirs, look.p, remote.version)
}

/** One profile signed in on this PC against the store's copy of its account. */
async function syncProfile(
  pass: DesktopPass,
  uuid: string,
  p: DesktopProfile & { uuid: string },
): Promise<void> {
  const { ctx } = pass
  if (ctx.excluded.has(uuid)) return
  const remote = ctx.store.get(uuid)
  if (remote && remote.kind !== 'desktop') return
  const tokens = await readDesktopTokens(p.dir)
  if (!tokens) {
    ctx.out.problems.push(`#${p.num}: its desktop login does not open on this PC.`)
    return
  }
  const look: ProfileLook = {
    uuid,
    p,
    remote,
    tokens,
    hash: tokensHash(tokens.v2, tokens.v1),
    st: ctx.state[uuid],
    cookiesAt: mtimeOf(cookieDb(p.dir)),
    isClosed: isClosedDir(pass.running, p.dir),
    read: null,
  }
  if (!remote) {
    await sendProfile(pass, look, 0, null)
    return
  }
  // Signed in here on its own while the store holds the other PC's: two separate sign-ins, each
  // staying signed in by itself. Left alone both ways.
  if (!look.st) {
    pass.own.add(uuid)
    return
  }
  if (look.st.version === remote.version) await syncAgreedProfile(pass, look, remote, look.st)
  else await syncMovedProfile(pass, look, remote, look.st)
}

/** Accounts only the store holds: a signed-out profile here of the same folder name, else a new one. */
async function syncStoreOnlyAccounts(
  pass: DesktopPass,
  mine: Map<string, DesktopProfile & { uuid: string }>,
): Promise<void> {
  const { ctx } = pass
  for (const [uuid, remote] of ctx.store) {
    if (remote.kind !== 'desktop' || mine.has(uuid) || ctx.excluded.has(uuid)) continue
    const target = pass.profiles.find((p) => !p.uuid && p.name === remote.name) ?? null
    if (target && !isClosedDir(pass.running, target.dir)) {
      pass.waiting.add(uuid)
      continue
    }
    if (!pass.running) continue
    const theirs = await ctx.download(uuid)
    if (theirs) await landFromStore(pass, theirs, target, remote.version)
  }
}

/** The desktop half of one sync pass (see the header). */
export async function syncDesktopLogins(ctx: DesktopSyncContext): Promise<void> {
  if (process.platform !== 'win32') return
  const profiles = listDesktopProfiles()
  const running = await runningDesktopDirs()
  const pass: DesktopPass = {
    ctx,
    profiles,
    running,
    own: new Set<string>(),
    waiting: new Set<string>(),
  }
  const mine = new Map<string, DesktopProfile & { uuid: string }>()
  for (const p of profiles)
    if (p.uuid && !mine.has(p.uuid)) mine.set(p.uuid, p as DesktopProfile & { uuid: string })

  for (const [uuid, p] of mine) await syncProfile(pass, uuid, p)
  await syncStoreOnlyAccounts(pass, mine)
  desktopNotes.own = pass.own
  desktopNotes.waiting = pass.waiting
}
