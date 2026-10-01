// server/src/core/cli-login-sync.ts — keep the CLI logins the same on the owner's PCs, through a
// small store in his own Cloudflare account (cloud/login-sync-worker).
//
// WHY (owner, 2026-10-01): "give me the ability to utilize something like a cloudflare worker ... so
// I can just point the login manager at my cloud thingy, and it manages and syncs my logins between
// the 2 PCs", and "I sometimes need both to stay logged in". One login signed in on two PCs breaks
// when either refreshes it: the refresh rotates the token and the other PC's copy no longer
// refreshes (the #88 symptom). Sync closes that gap: the PC that refreshed uploads the new login and
// the other lands it within a sync (SYNC_EVERY_MS).
//
// THE STORE holds versioned blobs keyed by CLI instance id, written compare-and-swap on the version.
// It only ever holds ciphertext: each login is AES-256-GCM encrypted under a 32-byte key that lives on
// the PCs (DPAPI-sealed in <CONFIG_DIR>/login-sync.json) with its instance id as associated data, so
// a blob cannot be passed off as another login. The Worker checks a bearer token against the SHA-256
// it was deployed with. Key, token and address travel between PCs only inside the pairing code the
// owner copies from the Login sync dialog.
//
// ONE PASS (every SYNC_EVERY_MS while on, and on "Sync now"): list the store; for each login the copy
// whose access token expires later is the newer one (a refresh pushes the expiry out), so it wins.
// A change here since the last sync is uploaded (even while a session runs: the file is what that CLI
// last wrote); a newer copy in the store is landed here with the import's guards (landLogin: never
// under a running session, never over another account, never over a newer copy). A login in the
// store with no instance here gets one, with the same id and number. A login left out here
// (`excluded`: "Stop syncing", a Log out, a move away) is neither uploaded nor landed.
//
// ⛔ SECRETS: the token and key are read only to make requests and encrypt; status answers never
// carry them. The pairing code is the one answer that does, for the owner's copy button.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '../config'
import { seal, unseal } from '../dpapi-seal.mjs'
import type { CliLoginSyncStatus } from '../types'
import { getCliInstance, listCliInstances } from './cli-instances'
import {
  credentialExpiry,
  credPath,
  landLogin,
  type PortableLogin,
  readPortableLogin,
  readText,
} from './cli-login-move'

export const SYNC_EVERY_MS = 30_000
const CONFIG_PATH = join(CONFIG_DIR, 'login-sync.json')
const PAIRING_PREFIX = 'ahsync1:'
const MAX_EVENTS = 30

interface SyncState {
  /** The store's version of this login the last time this PC and the store agreed. */
  version: number
  /** SHA-256 of this PC's credential file then: a different hash now means it changed here. */
  hash: string
}

interface SyncConfig {
  url: string
  /** Sealed (seal()) bearer token for the store. */
  token: string
  /** Sealed base64 of the 32-byte encryption key. */
  key: string
  enabled: boolean
  excluded: string[]
  state: Record<string, SyncState>
  lastSyncAt: number | null
  lastError: string | null
  events: CliLoginSyncStatus['events']
}

function readConfig(): SyncConfig | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as SyncConfig
    return c && typeof c.url === 'string' && typeof c.token === 'string' ? c : null
  } catch {
    return null
  }
}

function writeConfig(c: SyncConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(c, null, 2))
  renameSync(tmp, CONFIG_PATH)
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Encrypt one login for the store: base64 of {iv, tag, data}, its instance id bound in as AAD. */
export function sealLogin(key: Buffer, login: PortableLogin): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(login.id, 'utf8'))
  const data = Buffer.concat([cipher.update(JSON.stringify(login), 'utf8'), cipher.final()])
  return Buffer.from(
    JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }),
  ).toString('base64')
}

/** Decrypt a store blob for login `id`, or null (wrong key, another login's blob, damage). */
export function openLogin(key: Buffer, id: string, blob: string): PortableLogin | null {
  try {
    const b = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as {
      v: number
      iv: string
      tag: string
      data: string
    }
    if (b.v !== 1) return null
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'))
    decipher.setAAD(Buffer.from(id, 'utf8'))
    decipher.setAuthTag(Buffer.from(b.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(b.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const login = JSON.parse(plain) as PortableLogin
    return login?.id === id && typeof login.credentials === 'string' ? login : null
  } catch {
    return null
  }
}

/** The store's address, checked: https, or http on this machine (a test store). */
function storeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim())
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
    return u
  } catch {
    return null
  }
}

interface Live {
  url: URL
  token: string
  key: Buffer
}

function live(c: SyncConfig): Live | null {
  const url = storeUrl(c.url)
  const token = unseal(c.token)
  const key = unseal(c.key)
  if (!url || !token || !key) return null
  const buf = Buffer.from(key, 'base64')
  return buf.length === 32 ? { url, token, key: buf } : null
}

async function call(
  l: Live,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(new URL(path, l.url), {
    method,
    headers: { authorization: `Bearer ${l.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    // not JSON (a proxy's error page): the status says enough
  }
  return { status: res.status, json }
}

const httpError = (what: string, r: { status: number; json: any }): Error =>
  new Error(
    r.status === 401
      ? `${what}: the store refused the access token (401). Set up sync again with the right token.`
      : `${what}: the store answered ${r.status}${r.json?.error ? ` (${r.json.error})` : ''}.`,
  )

/** Check that the store answers this token, before anything is saved. */
async function probe(l: Live): Promise<void> {
  const r = await call(l, 'GET', '/v1/logins')
  if (r.status !== 200 || !Array.isArray(r.json?.logins)) throw httpError('Checking the store', r)
}

function freshConfig(url: string, token: string, key: Buffer): SyncConfig {
  return {
    url,
    token: seal(token),
    key: seal(key.toString('base64')),
    enabled: true,
    excluded: [],
    state: {},
    lastSyncAt: null,
    lastError: null,
    events: [],
  }
}

/** Point this PC at a store (its address and access token) with a NEW encryption key: the first PC.
 *  The other PC joins with the pairing code this one then shows. */
export async function configureLoginSync(opts: {
  url: string
  token: string
}): Promise<{ ok: boolean; message: string }> {
  const url = storeUrl(opts.url ?? '')
  if (!url) return { ok: false, message: 'Enter the store address (https://...).' }
  const token = (opts.token ?? '').trim()
  if (token.length < 16) return { ok: false, message: 'Enter the store’s access token.' }
  const key = randomBytes(32)
  try {
    await probe({ url, token, key })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  writeConfig(freshConfig(url.toString(), token, key))
  void runLoginSync()
  return { ok: true, message: 'Login sync is on. Copy the pairing code to your other PC.' }
}

/** The pairing code: the store's address, token and key in one string, for the other PC's Join. */
export function loginSyncPairingCode(): string | null {
  const c = readConfig()
  if (!c) return null
  const l = live(c)
  if (!l) return null
  const payload = JSON.stringify({ u: l.url.toString(), t: l.token, k: l.key.toString('base64') })
  return PAIRING_PREFIX + Buffer.from(payload, 'utf8').toString('base64url')
}

/** Join the store another PC set up, from its pairing code. */
export async function joinLoginSync(code: string): Promise<{ ok: boolean; message: string }> {
  const text = (code ?? '').trim()
  if (!text.startsWith(PAIRING_PREFIX)) return { ok: false, message: 'That is not a pairing code.' }
  let p: { u?: string; t?: string; k?: string }
  try {
    p = JSON.parse(Buffer.from(text.slice(PAIRING_PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    return { ok: false, message: 'That pairing code is cut short or changed.' }
  }
  const url = storeUrl(p.u ?? '')
  const key = Buffer.from(p.k ?? '', 'base64')
  if (!url || !p.t || key.length !== 32)
    return { ok: false, message: 'That pairing code is cut short or changed.' }
  try {
    await probe({ url, token: p.t, key })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  writeConfig(freshConfig(url.toString(), p.t, key))
  void runLoginSync()
  return { ok: true, message: 'Joined. This PC now syncs its CLI logins with the store.' }
}

export function setLoginSyncEnabled(enabled: boolean): { ok: boolean; message: string } {
  const c = readConfig()
  if (!c) return { ok: false, message: 'Login sync is not set up on this PC.' }
  c.enabled = enabled
  writeConfig(c)
  if (enabled) void runLoginSync()
  return { ok: true, message: enabled ? 'Login sync is on.' : 'Login sync is paused on this PC.' }
}

/** Leave one login out of sync on this PC (or put it back). A Log out here and a move away leave it
 *  out, so the store does not sign it straight back in. */
export function setLoginSyncExcluded(id: string, excluded: boolean): void {
  const c = readConfig()
  if (!c) return
  const set = new Set(c.excluded)
  if (excluded) set.add(id)
  else set.delete(id)
  c.excluded = [...set]
  if (!excluded) delete c.state[id]
  writeConfig(c)
  if (!excluded && c.enabled) void runLoginSync()
}

/** Forget the store on this PC. The store and the other PC keep their copies. */
export function disconnectLoginSync(): { ok: boolean; message: string } {
  rmSync(CONFIG_PATH, { force: true })
  return { ok: true, message: 'This PC no longer syncs logins. The store still holds them.' }
}

function note(
  c: SyncConfig,
  num: number | null,
  action: CliLoginSyncStatus['events'][number]['action'],
  text: string,
): void {
  c.events = [{ at: Date.now(), num, action, note: text }, ...c.events].slice(0, MAX_EVENTS)
}

export interface LoginSyncPassResult {
  ok: boolean
  pushed: number
  landed: number
  unchanged: number
  problems: string[]
}

let running: Promise<LoginSyncPassResult> | null = null
/** What the store held at the last pass, for the status's per-login rows. */
let lastStore = new Map<string, { version: number; num: number | null }>()

/** One sync pass (see the header). Never two at once: a second call shares the running one. */
export function runLoginSync(): Promise<LoginSyncPassResult> {
  if (!running)
    running = pass().finally(() => {
      running = null
    })
  return running
}

async function pass(): Promise<LoginSyncPassResult> {
  const out: LoginSyncPassResult = { ok: true, pushed: 0, landed: 0, unchanged: 0, problems: [] }
  const c = readConfig()
  if (!c?.enabled) return out
  const l = live(c)
  if (!l) {
    c.lastError =
      'The sync settings on this PC cannot be read (moved from another Windows user?). Set it up again.'
    writeConfig(c)
    return { ...out, ok: false, problems: [c.lastError] }
  }
  const excluded = new Set(c.excluded)
  const by = hostname()
  try {
    const list = await call(l, 'GET', '/v1/logins')
    if (list.status !== 200 || !Array.isArray(list.json?.logins))
      throw httpError('Reading the store', list)
    const store = new Map<string, { version: number; num: number | null }>()
    for (const r of list.json.logins as Array<{ id: string; version: number; meta?: any }>)
      store.set(r.id, {
        version: r.version,
        num: typeof r.meta?.num === 'number' ? r.meta.num : null,
      })
    lastStore = store

    const upload = async (login: PortableLogin, expect: number): Promise<void> => {
      const r = await call(l, 'PUT', `/v1/logins/${login.id}`, {
        version: expect,
        blob: sealLogin(l.key, login),
        meta: {
          num: login.num,
          expiresAt: credentialExpiry(login.credentials),
          by,
          at: Date.now(),
        },
      })
      if (r.status === 200 && typeof r.json?.version === 'number') {
        c.state[login.id] = { version: r.json.version, hash: sha256(login.credentials) }
        store.set(login.id, { version: r.json.version, num: login.num })
        out.pushed++
        note(c, login.num, 'pushed', 'Uploaded this PC’s newer login.')
      } else if (r.status === 409) {
        out.problems.push(`#${login.num}: changed in the store meanwhile; next pass decides.`)
      } else throw httpError(`Uploading #${login.num}`, r)
    }
    const download = async (id: string): Promise<PortableLogin | null> => {
      const r = await call(l, 'GET', `/v1/logins/${id}`)
      if (r.status !== 200 || typeof r.json?.blob !== 'string') throw httpError('Downloading', r)
      const login = openLogin(l.key, id, r.json.blob)
      if (!login) {
        out.problems.push(`${id}: the store's copy does not open with this PC's key.`)
        note(
          c,
          store.get(id)?.num ?? null,
          'error',
          'The store’s copy does not open with this PC’s key.',
        )
      }
      return login
    }
    const land = async (login: PortableLogin, version: number): Promise<void> => {
      const row = await landLogin(login)
      if (row.written) {
        const rec = getCliInstance(row.id)
        const text = rec ? readText(credPath(rec.configDir)) : null
        c.state[login.id] = { version, hash: text ? sha256(text) : '' }
        out.landed++
        note(
          c,
          row.num,
          row.matchedBy === 'created' ? 'created' : 'pulled',
          row.ok ? row.message : `Landed; ${row.message}`,
        )
      } else {
        out.problems.push(`#${row.num ?? '?'}: ${row.message}`)
        note(c, row.num, 'skipped', row.message)
      }
    }

    const here = new Set<string>()
    for (const inst of listCliInstances()) {
      here.add(inst.id)
      if (excluded.has(inst.id)) continue
      const remote = store.get(inst.id)
      const text = readText(credPath(inst.configDir))
      if (!text) {
        // Signed out here and not left out: the store's copy signs it in.
        if (remote) {
          const login = await download(inst.id)
          if (login) await land(login, remote.version)
        }
        continue
      }
      const hash = sha256(text)
      const st = c.state[inst.id]
      if (remote && st && st.version === remote.version) {
        if (st.hash === hash) {
          out.unchanged++
          continue
        }
        const read = readPortableLogin(inst.id, { whileRunning: true })
        if ('login' in read) await upload(read.login, remote.version)
        else out.problems.push(`#${inst.num}: ${read.error}`)
        continue
      }
      if (!remote) {
        const read = readPortableLogin(inst.id, { whileRunning: true })
        if ('login' in read) await upload(read.login, 0)
        // A hollow login is not worth sharing; nothing to report until it is signed in properly.
        continue
      }
      // The store moved on since this PC last agreed with it (or never has): the newer copy wins.
      const theirs = await download(inst.id)
      if (!theirs) continue
      if (theirs.credentials === text) {
        c.state[inst.id] = { version: remote.version, hash }
        out.unchanged++
        continue
      }
      if (credentialExpiry(text) > credentialExpiry(theirs.credentials)) {
        const read = readPortableLogin(inst.id, { whileRunning: true })
        if ('login' in read) await upload(read.login, remote.version)
        else out.problems.push(`#${inst.num}: ${read.error}`)
      } else await land(theirs, remote.version)
    }
    // Logins only the store holds: an instance for each here, same id and number.
    for (const [id, remote] of store) {
      if (here.has(id) || excluded.has(id)) continue
      const login = await download(id)
      if (login) await land(login, remote.version)
    }
    c.lastError = out.problems.length ? out.problems[0]! : null
  } catch (err) {
    out.ok = false
    c.lastError = err instanceof Error ? err.message : String(err)
    out.problems.push(c.lastError)
    note(c, null, 'error', c.lastError)
  }
  c.lastSyncAt = Date.now()
  // Re-read what another call changed meanwhile (an exclusion, a pause) and keep it.
  const now = readConfig()
  if (now) {
    c.enabled = now.enabled
    c.excluded = now.excluded
  }
  writeConfig(c)
  return out
}

/** What the Login sync dialog shows. Never a token, key or login. */
export function loginSyncStatus(): CliLoginSyncStatus {
  const c = readConfig()
  if (!c)
    return {
      configured: false,
      enabled: false,
      url: null,
      lastSyncAt: null,
      lastError: null,
      logins: [],
      events: [],
    }
  const excluded = new Set(c.excluded)
  const logins: CliLoginSyncStatus['logins'] = []
  const seen = new Set<string>()
  for (const i of listCliInstances()) {
    seen.add(i.id)
    const remote = lastStore.get(i.id)
    logins.push({
      id: i.id,
      num: i.num ?? null,
      name: i.name,
      here: i.loggedIn || !!readText(credPath(i.configDir)),
      inStore: !!remote,
      excluded: excluded.has(i.id),
      inSync: !!remote && c.state[i.id]?.version === remote.version,
    })
  }
  for (const [id, remote] of lastStore)
    if (!seen.has(id))
      logins.push({
        id,
        num: remote.num,
        name: id,
        here: false,
        inStore: true,
        excluded: excluded.has(id),
        inSync: false,
      })
  let host: string | null = null
  try {
    host = new URL(c.url).host
  } catch {
    host = null
  }
  return {
    configured: true,
    enabled: c.enabled,
    url: host,
    lastSyncAt: c.lastSyncAt,
    lastError: c.lastError,
    logins,
    events: c.events,
  }
}

let timer: ReturnType<typeof setInterval> | null = null
/** Start the sync loop (daemon boot). Each tick is a no-op until sync is set up and on. */
export function startLoginSync(): void {
  if (timer) return
  timer = setInterval(() => {
    if (readConfig()?.enabled) void runLoginSync().catch(() => {})
  }, SYNC_EVERY_MS)
  timer.unref?.()
  if (readConfig()?.enabled) setTimeout(() => void runLoginSync().catch(() => {}), 15_000).unref?.()
}
