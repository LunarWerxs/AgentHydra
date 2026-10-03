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
// THE STORE holds versioned blobs keyed by row id, written compare-and-swap on the version. It only
// ever holds ciphertext: each login is AES-256-GCM encrypted under a 32-byte key that lives on the PCs
// (DPAPI-sealed in <CONFIG_DIR>/login-sync.json) with its row id as associated data, so a blob cannot
// be passed off as another login. The Worker checks a bearer token against the SHA-256 it was
// deployed with. Key, token and address travel between PCs only inside the pairing code the owner
// copies from the Login sync dialog.
//
// ONE ROW PER ACCOUNT (owner, 2026-10-02: "if I have the same [email] logged in on this PC, don't
// sync them twice. Combine them into one"). A CLI row is named by the instance id of the PC that
// sent it first, and carries its account as `meta.acct` (an HMAC of the email under the sync key, so
// the store never holds the address). An instance here whose account already has a row uses that
// row (its `slot`) instead of adding its own; where two rows of one account exist, every PC picks the
// same one (the later expiry, then the lower id) and the PC that sent the other removes it.
//
// ONE PASS (every SYNC_EVERY_MS while on, and on "Sync now"): list the store; for each login the copy
// whose access token expires later is the newer one (a refresh pushes the expiry out), so it wins.
// A change here since the last sync is uploaded (even while a session runs: the file is what that CLI
// last wrote); a newer copy in the store is landed here with the import's guards (landLogin: never
// under a running session, never over another account, never over a newer copy). A login in the
// store with no instance here gets one, with the same id and number. A login left out here
// (`excluded`: "Stop syncing", a move away) is neither uploaded nor landed.
//
// A LOG OUT REACHES EVERY PC (owner, 2026-10-02: "if I log something out, it logs out on both"). A
// login this PC held and shared that is gone here (AgentHydra's Log out, or `claude /logout`) turns
// its row into a signed-out marker (`meta.signedOut`); the other PCs sign out of it, unless theirs was
// signed in after the logout, which then goes up in its place. Signing in again anywhere brings it
// back everywhere. Deleting an instance stays on its PC: its row is neither marked nor brought back.
//
// DESKTOP LOGINS ride the same pass, store and key (core/desktop-login-sync.ts): keyed by account uuid
// with meta.kind 'desktop', landed only into closed profiles, never over a login a PC signed in on
// its own. The CLI half leaves those rows alone.
//
// THE CLIMAYTE QUEUE rides the same pass when its toggle is on (`shareQueue`, off by default): each PC
// uploads a snapshot of its queue under its own `pcId` and reads the others' (core/climayte-queue-sync.ts,
// the store's own `queues` table). It fails apart from the logins: its error is `queueError`, and a
// queue that cannot sync never stops a login pass.
//
// THE DESKTOP CHATS ride the pass too when their toggle is on (`shareChats`, off by default, per PC):
// the visible Claude Desktop chats go up and come down compressed and encrypted, each remembering the
// PC it came from (core/desktop-chat-sync.ts, the store's `chats` and `chat_chunks`). A chat pass can
// read tens of MB, so it runs after the logins' part of the pass, not inside it, and at most one at a
// time. Its error is `chatsError`, apart from `lastError` and `queueError`; it never fails a login pass.
//
// ⛔ SECRETS: the token and key are read only to make requests and encrypt; status answers never
// carry them. The pairing code is the one answer that does, for the owner's copy button.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { clearRemote } from '../climayte-remote'
import { CONFIG_DIR } from '../config'
import { seal, unseal } from '../dpapi-seal.mjs'
import type { CliInstance, CliLoginSyncStatus } from '../types'
import { dropCachedUsage } from '../usage-cache'
import { cliKey, desktopKey } from '../usage-service'
import { listCliInstances } from './cli-instances'
import {
  cliLoginEmail,
  credentialExpiry,
  credPath,
  landLogin,
  type PortableLogin,
  readPortableLogin,
  readText,
} from './cli-login-move'
import { logoutCliInstance } from './cli-logout'
import { syncQueue } from './climayte-queue-sync'
import { createChatLocal } from './desktop-chat-local'
import { chatSyncRows, syncChats } from './desktop-chat-sync'
import type { ChatLocal } from './desktop-chat-types'
import { hasOwnCliLogin } from './desktop-cli-feed'
import {
  asDesktopLogin,
  desktopNotes,
  listDesktopProfiles,
  type PortableDesktopLogin,
  syncDesktopLogins,
} from './desktop-login-sync'
import { setBeforeLaunchHook } from './instances'
import { StoreMirror } from './login-sync-mirror'

export const SYNC_EVERY_MS = 30_000
const CONFIG_PATH = join(CONFIG_DIR, 'login-sync.json')
const CHATS_STATE_PATH = join(CONFIG_DIR, 'desktop-chat-sync.json')
const PAIRING_PREFIX = 'ahsync1:'
const MAX_EVENTS = 30

interface SyncState {
  /** The store's version of this login the last time this PC and the store agreed. */
  version: number
  /** SHA-256 of this PC's credential file then (a desktop login: of its token caches): a different
   *  hash now means it changed here. */
  hash: string
  /** A desktop login: its cookie database's mtime when last read or written. */
  cookies?: number
}

interface SyncConfig {
  url: string
  /** Sealed (seal()) bearer token for the store. */
  token: string
  /** Sealed base64 of the 32-byte encryption key. */
  key: string
  enabled: boolean
  /** This PC's id in the store's queue table: a random UUID, made once. */
  pcId?: string
  /** Share this PC's CliMayte queue and read the other PCs'. Absent: off. */
  shareQueue?: boolean
  /** Share this PC's visible desktop chats and read the other PCs'. Absent: off. */
  shareChats?: boolean
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

/** Encrypt one login for the store: base64 of {iv, tag, data}, its id (a CLI instance's, a desktop
 *  account's uuid) bound in as AAD. */
export function sealLogin(key: Buffer, login: { id: string }): string {
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
  const login = openBlob(key, id, blob) as PortableLogin | null
  return login?.id === id && typeof login.credentials === 'string' ? login : null
}

/** A store blob's content for `id`, whatever kind of login it holds; null when it does not open. */
function openBlob(key: Buffer, id: string, blob: string): unknown {
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
    return JSON.parse(plain) as unknown
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
): Promise<{ status: number; json: any; rev?: number }> {
  // A write moves the row on: what the mirror kept of it is not the store's copy any more.
  if (method !== 'GET') mirror?.m.forget(path)
  const res = await fetch(new URL(path, l.url), {
    method,
    headers: { authorization: `Bearer ${l.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (method !== 'GET') mirror?.m.forget(path)
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    // not JSON (a proxy's error page): the status says enough
  }
  // The store's change counter, sent on the list routes: where a changes cursor can start.
  const header = res.headers.get('x-store-rev')
  const rev = header !== null && /^\d+$/.test(header) ? Number(header) : undefined
  return { status: res.status, json, rev }
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
    // Setting up again keeps this PC's id and its queue choice.
    pcId: readConfig()?.pcId ?? randomUUID(),
    shareQueue: readConfig()?.shareQueue ?? false,
    shareChats: readConfig()?.shareChats ?? false,
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
  return { ok: true, message: 'Joined. This PC now syncs its logins with the store.' }
}

export function setLoginSyncEnabled(enabled: boolean): { ok: boolean; message: string } {
  const c = readConfig()
  if (!c) return { ok: false, message: 'Login sync is not set up on this PC.' }
  c.enabled = enabled
  writeConfig(c)
  if (enabled) void runLoginSync()
  return { ok: true, message: enabled ? 'Login sync is on.' : 'Login sync is paused on this PC.' }
}

/** Turn the CliMayte queue sharing on or off on this PC (needs login sync set up). */
export function setQueueSharing(on: boolean): { ok: boolean; message: string } {
  const c = readConfig()
  if (!c) return { ok: false, message: 'Login sync is not set up on this PC.' }
  c.shareQueue = on
  c.pcId ??= randomUUID()
  writeConfig(c)
  if (on) void runLoginSync()
  else {
    clearRemote()
    queueError = null
  }
  return {
    ok: true,
    message: on
      ? 'This PC shares its CliMayte queue.'
      : 'This PC no longer shares its CliMayte queue.',
  }
}

/** Turn the desktop chat sharing on or off on this PC (needs login sync set up). Off keeps the chat
 *  state file, so turning it on again resumes. */
export function setChatSharing(on: boolean): { ok: boolean; message: string } {
  const c = readConfig()
  if (!c) return { ok: false, message: 'Login sync is not set up on this PC.' }
  c.shareChats = on
  c.pcId ??= randomUUID()
  writeConfig(c)
  if (on) void runLoginSync()
  else chatsError = null
  return {
    ok: true,
    message: on
      ? 'This PC shares its desktop chats.'
      : 'This PC no longer shares its desktop chats.',
  }
}

/** Login sync is set up, on, and this PC shares its desktop chats (so reads the others'). */
export function chatSharingOn(): boolean {
  const c = readConfig()
  return !!c?.enabled && c.shareChats === true
}

/** Login sync is set up, on, and this PC shares its CliMayte queue (so reads the others'). */
export function queueSharingOn(): boolean {
  const c = readConfig()
  return !!c?.enabled && c.shareQueue === true
}

/** Logins logged out here on purpose (AgentHydra's Log out: a CLI instance id or a desktop account
 *  uuid), so the next pass marks them signed out in the store at once instead of waiting a second
 *  pass to be sure the credential is really gone. */
const loggedOutHere = new Set<string>()

/** A login was logged out on this PC: every other PC signs out of it too (see the header). */
export function noteLoggedOutHere(id: string): void {
  loggedOutHere.add(id)
  if (readConfig()?.enabled) void runLoginSync().catch(() => {})
}

/** Leave one login out of sync on this PC (or put it back). A move away and a deleted instance leave
 *  it out, so the store neither signs it straight back in nor signs the other PCs out of it. */
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
  clearRemote()
  queueError = null
  chatsError = null
  return { ok: true, message: 'This PC no longer syncs logins. The store still holds them.' }
}

function note(
  c: SyncConfig,
  num: number | null,
  action: CliLoginSyncStatus['events'][number]['action'],
  text: string,
): void {
  const now = Date.now()
  // The same word again within NOTE_REPEAT_MS is not news: a login that waits for a busy instance
  // was noted on every 30-second pass and pushed the real events out of the list.
  if (
    c.events.some(
      (e) => e.num === num && e.action === action && e.note === text && now - e.at < NOTE_REPEAT_MS,
    )
  )
    return
  c.events = [{ at: now, num, action, note: text }, ...c.events].slice(0, MAX_EVENTS)
}
const NOTE_REPEAT_MS = 10 * 60_000

/** CLI instances a newer store login waits for (a Claude session runs on them here): their rows say
 *  Waiting, and the pass reports no problem. Rebuilt by every pass. */
let cliWaiting = new Set<string>()
let cliWaitingPass = new Set<string>()

export interface LoginSyncPassResult {
  ok: boolean
  pushed: number
  landed: number
  unchanged: number
  problems: string[]
}

let running: Promise<LoginSyncPassResult> | null = null
interface StoreRow {
  version: number
  num: number | null
  /** 'desktop' for a desktop login (keyed by account uuid), 'cli' otherwise. */
  kind: string
  /** A desktop login's profile folder name on the PC that sent it. */
  name: string | null
  /** A CLI login's account (acctKey of its email): the row's meta, else learned by opening it. */
  acct: string | null
  /** When its access token expires (ms) as the row says; 0 for a signed-out marker. */
  expiresAt: number
  /** When it was last written (ms, by the writing PC's clock). */
  at: number
  /** Signed out everywhere: a PC logged it out, and the others sign out of it too. */
  signedOut: boolean
}
/** What the store held at the last pass, for the status's per-login rows. */
let lastStore = new Map<string, StoreRow>()
/** Each CLI instance's row at the last pass: its own id, or its account's row from another PC. */
let lastSlots = new Map<string, string>()
/** CLI rows that are no separate login here (a second row of an account an instance here has, a
 *  signed-out marker, one whose instance was deleted here): the status leaves them out. */
let lastHidden = new Set<string>()
/** Logins this PC held that were missing at a pass, and since when (see confirmGone). */
const missingSince = new Map<string, number>()
/** How long a login must stay missing before it counts as logged out here. */
const MISSING_FOR_MS = 10_000
/** Accounts learned by opening rows written before rows carried `meta.acct`, by `<id>:<version>`. */
const learnedAcct = new Map<string, string | null>()

/** A CLI login's account as the store sees it: its email under the sync key (see the header). */
const acctKey = (key: Buffer, email: string): string =>
  createHmac('sha256', key).update(`cli-account:${email.toLowerCase()}`).digest('hex').slice(0, 32)

/** A login this PC held is missing now. True once it is still missing a pass later, or at once after
 *  AgentHydra's Log out here: a credential caught mid-rewrite must never sign an account out
 *  everywhere. */
function confirmGone(id: string): boolean {
  if (loggedOutHere.has(id)) return true
  const first = missingSince.get(id)
  if (first === undefined) missingSince.set(id, Date.now())
  return first !== undefined && Date.now() - first >= MISSING_FOR_MS
}
const clearGone = (id: string): void => {
  missingSince.delete(id)
  loggedOutHere.delete(id)
}

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** One sync pass (see the header). Never two at once: a second call shares the running one. */
export function runLoginSync(): Promise<LoginSyncPassResult> {
  if (!running)
    running = pass().finally(() => {
      running = null
    })
  return running
}

async function uploadLogin(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  out: LoginSyncPassResult,
  by: string,
  login: PortableLogin,
  expect: number,
): Promise<void> {
  const acct = login.email ? acctKey(l.key, login.email) : null
  const expiresAt = credentialExpiry(login.credentials)
  const at = Date.now()
  const r = await call(l, 'PUT', `/v1/logins/${login.id}`, {
    version: expect,
    blob: sealLogin(l.key, login),
    meta: { num: login.num, acct, expiresAt, by, at },
  })
  if (r.status === 200 && typeof r.json?.version === 'number') {
    c.state[login.id] = { version: r.json.version, hash: sha256(login.credentials) }
    store.set(login.id, {
      version: r.json.version,
      num: login.num,
      kind: 'cli',
      name: null,
      acct,
      expiresAt,
      at,
      signedOut: false,
    })
    out.pushed++
    note(c, login.num, 'pushed', 'Uploaded this PC’s newer login.')
  } else if (r.status === 409) {
    out.problems.push(`#${login.num}: changed in the store meanwhile; next pass decides.`)
  } else throw httpError(`Uploading #${login.num}`, r)
}

async function downloadLogin(
  l: Live,
  store: Map<string, StoreRow>,
  c: SyncConfig,
  out: LoginSyncPassResult,
  id: string,
): Promise<PortableLogin | null> {
  const r = await mirrorFor(l).getItem('logins', id)
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

/** Sign a store login in here. `login.id` names the instance it lands in (landLogin finds it by id,
 *  else by account, else makes it); `slot` the store row it came from, which the agreement is kept
 *  under. */
async function landPortableLogin(
  c: SyncConfig,
  out: LoginSyncPassResult,
  login: PortableLogin,
  version: number,
  slot: string,
): Promise<void> {
  const row = await landLogin(login)
  if (row.written) {
    // The hash of what was landed, not of the file now: `claude auth status` (landLogin's check)
    // can refresh the login, and that newer file must read as a change here and go up.
    c.state[slot] = { version, hash: sha256(login.credentials) }
    out.landed++
    note(
      c,
      row.num,
      row.matchedBy === 'created' ? 'created' : 'pulled',
      row.ok ? row.message : `Landed; ${row.message}`,
    )
  } else if (row.blocked === 'running') {
    // It lands once the session there finishes: a wait, not a sync failure.
    cliWaitingPass.add(login.id)
    note(c, row.num, 'skipped', row.message)
  } else if (row.blocked !== 'newer') {
    // 'newer': this PC's copy is as new, and goes up from its own instance's turn.
    out.problems.push(`#${row.num ?? '?'}: ${row.message}`)
    note(c, row.num, 'skipped', row.message)
  }
}

/** Fill in the account of CLI rows written before rows carried it, opening each once per version. */
async function learnAccounts(l: Live, store: Map<string, StoreRow>): Promise<void> {
  for (const [id, r] of store) {
    if (r.kind === 'desktop' || r.acct || r.signedOut) continue
    const k = `${id}:${r.version}`
    if (!learnedAcct.has(k)) {
      const got = await mirrorFor(l).getItem('logins', id)
      const login =
        got.status === 200 && typeof got.json?.blob === 'string'
          ? openLogin(l.key, id, got.json.blob)
          : null
      learnedAcct.set(k, login?.email ? acctKey(l.key, login.email) : null)
    }
    r.acct = learnedAcct.get(k) ?? null
  }
}

/** Of two rows of one account, the one every PC keeps: a live one over a signed-out marker, then the
 *  later expiry, then the lower id. */
function keeps(store: Map<string, StoreRow>, a: string, b: string): boolean {
  const x = store.get(a)!
  const y = store.get(b)!
  if (x.signedOut !== y.signedOut) return !x.signedOut
  if (x.expiresAt !== y.expiresAt) return x.expiresAt > y.expiresAt
  return a < b
}

/** Each CLI instance's row (see the header): its account's row when the store has one, else its own
 *  id. A login fed by its desktop instance has none of its own and keeps its id; of two instances
 *  here on one account, the first takes the account's row. */
function slotsFor(
  key: Buffer,
  store: Map<string, StoreRow>,
  insts: CliInstance[],
): Map<string, string> {
  const byAcct = new Map<string, string>()
  for (const [id, r] of store) {
    if (r.kind === 'desktop' || !r.acct) continue
    const kept = byAcct.get(r.acct)
    if (!kept || keeps(store, id, kept)) byAcct.set(r.acct, id)
  }
  const local = new Set(insts.map((i) => i.id))
  const taken = new Set<string>()
  const slots = new Map<string, string>()
  for (const i of insts) {
    const email = cliLoginEmail(i)
    const fed = !!i.associatedDesktopDir && !hasOwnCliLogin(i.configDir)
    const row = !fed && email ? byAcct.get(acctKey(key, email)) : undefined
    const slot = row && (row === i.id || !local.has(row)) && !taken.has(row) ? row : i.id
    taken.add(slot)
    slots.set(i.id, slot)
  }
  return slots
}

/** Upload this instance's login to its row; a login that cannot go says why. */
async function uploadHere(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  out: LoginSyncPassResult,
  by: string,
  inst: CliInstance,
  slot: string,
  expect: number,
): Promise<void> {
  const read = readPortableLogin(inst.id, { whileRunning: true })
  if ('login' in read) await uploadLogin(l, c, store, out, by, { ...read.login, id: slot }, expect)
  else out.problems.push(`#${inst.num}: ${read.error}`)
}

/** Turn a row into the signed-out marker (see the header): the other PCs sign out of it. */
async function markSignedOut(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  out: LoginSyncPassResult,
  by: string,
  row: {
    id: string
    kind: 'cli' | 'desktop'
    num: number | null
    name: string | null
    acct: string | null
  },
  expect: number,
): Promise<number | null> {
  const at = Date.now()
  const meta =
    row.kind === 'desktop'
      ? { kind: 'desktop', name: row.name, num: row.num }
      : { acct: row.acct, num: row.num }
  const marker = { id: row.id, signedOut: true }
  const r = await call(l, 'PUT', `/v1/logins/${row.id}`, {
    version: expect,
    blob: sealLogin(l.key, marker),
    meta: { ...meta, signedOut: true, expiresAt: 0, by, at },
  })
  if (r.status === 200 && typeof r.json?.version === 'number') {
    const v = r.json.version as number
    c.state[row.id] = { version: v, hash: '' }
    store.set(row.id, { ...row, version: v, expiresAt: 0, at, signedOut: true })
    out.pushed++
    note(c, row.num, 'signedOut', 'Logged out here, so your other PCs sign out of it too.')
    return v
  }
  if (r.status === 409) {
    out.problems.push(`#${row.num}: changed in the store meanwhile; next pass decides.`)
    return null
  }
  throw httpError(`Signing #${row.num} out`, r)
}

/** No credential file here. One this PC held and shared is gone: logged out here, so its row turns
 *  into the signed-out marker (confirmGone first). Otherwise the store's live copy signs it in. */
async function syncWithoutLogin(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  out: LoginSyncPassResult,
  by: string,
  inst: CliInstance,
  slot: string,
): Promise<void> {
  const remote = store.get(slot)
  if (!remote) return
  if (remote.signedOut) {
    c.state[slot] = { version: remote.version, hash: '' }
    clearGone(inst.id)
    return
  }
  if (c.state[slot]?.hash) {
    if (!confirmGone(inst.id)) return
    const row = {
      id: slot,
      kind: 'cli' as const,
      num: inst.num ?? null,
      name: null,
      acct: remote.acct,
    }
    if ((await markSignedOut(l, c, store, out, by, row, remote.version)) !== null)
      clearGone(inst.id)
    return
  }
  const login = await downloadLogin(l, store, c, out, slot)
  if (login) await landPortableLogin(c, out, { ...login, id: inst.id }, remote.version, slot)
}

/** The row says signed out (another PC logged it out) and this PC holds a live login for it. A login
 *  signed in here after the logout is the newer word and goes up in its place; the one this PC last
 *  shared, or any written before the logout, signs out here (once no session runs on it). */
async function meetSignOut(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  out: LoginSyncPassResult,
  by: string,
  inst: CliInstance,
  slot: string,
  hash: string,
): Promise<void> {
  const remote = store.get(slot)!
  const st = c.state[slot]
  // This PC already took that logout, so any login here now is a new sign-in.
  const signedInSince =
    st?.version === remote.version ||
    (st?.hash !== hash && mtimeOf(credPath(inst.configDir)) > remote.at)
  if (signedInSince) {
    await uploadHere(l, c, store, out, by, inst, slot, remote.version)
    return
  }
  // A session runs on it (it would write the login back): the next pass tries again.
  if (!logoutCliInstance(inst.id).ok) return
  dropCachedUsage(cliKey(inst.id), { keepLastKnown: true })
  c.state[slot] = { version: remote.version, hash: '' }
  note(c, inst.num ?? null, 'signedOut', 'Logged out on another PC, so signed out here too.')
}

async function syncCliInstance(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  out: LoginSyncPassResult,
  by: string,
  inst: CliInstance,
  slot: string,
): Promise<void> {
  const path = credPath(inst.configDir)
  const text = readText(path)
  if (!text) {
    // A file there that did not read (held mid-write) is left for the next pass.
    if (!existsSync(path)) await syncWithoutLogin(l, c, store, out, by, inst, slot)
    return
  }
  clearGone(inst.id)
  const remote = store.get(slot)
  const st = c.state[slot]
  const hash = sha256(text)
  // The CLI keeps the file but empties its tokens when Anthropic ends the login (revoked, or its
  // refresh refused): signed out here, and nothing to share. Its row says so (loginSyncStatus); it is
  // no sync failure, so it never takes the dialog's error line (owner, 2026-10-02: one dead login read
  // as "sync is broken"). Another PC's live copy still lands over it below; a new sign-in here
  // changes the file and goes up.
  const hollow = !hasOwnCliLogin(inst.configDir)
  if (remote?.signedOut) {
    if (!hollow) await meetSignOut(l, c, store, out, by, inst, slot, hash)
    return
  }
  if (remote && st && st.version === remote.version) {
    if (st.hash !== hash && !hollow)
      await uploadHere(l, c, store, out, by, inst, slot, remote.version)
    else out.unchanged++
    return
  }
  if (!remote) {
    if (!hollow) await uploadHere(l, c, store, out, by, inst, slot, 0)
    return
  }
  // The store moved on since this PC last agreed with it (or never has): the newer copy wins.
  const theirs = await downloadLogin(l, store, c, out, slot)
  if (!theirs) return
  if (theirs.credentials === text) {
    c.state[slot] = { version: remote.version, hash }
    out.unchanged++
    return
  }
  const mine = credentialExpiry(text)
  const their = credentialExpiry(theirs.credentials)
  if (mine > their) await uploadHere(l, c, store, out, by, inst, slot, remote.version)
  else if (mine === their) {
    // The same login written two ways (one expiry): neither is newer. Agree on it, or this pass and
    // the landing's newer-copy check would refuse each other every 30 seconds (#125, 2026-10-03).
    c.state[slot] = { version: remote.version, hash }
    out.unchanged++
  } else await landPortableLogin(c, out, { ...theirs, id: inst.id }, remote.version, slot)
}

/** This PC's own row of an account whose row is another (its instance took that one): removed once
 *  this PC agrees with the kept row, so the account is one row again. */
async function dropOwnDuplicate(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  inst: CliInstance,
  slot: string,
): Promise<void> {
  const own = store.get(inst.id)
  if (slot === inst.id || !own || own.kind === 'desktop') return
  if (c.state[slot]?.version !== store.get(slot)?.version) return
  const r = await call(l, 'DELETE', `/v1/logins/${inst.id}?version=${own.version}`)
  if (r.status !== 200) return
  store.delete(inst.id)
  delete c.state[inst.id]
  note(c, inst.num ?? null, 'merged', 'Two copies of one account in the store are one again.')
}

/** Logins only the store holds: an instance for each here, same id and number. Not a row that is no
 *  separate login here (lastHidden), nor one left out. */
async function syncStoreOnlyLogins(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  out: LoginSyncPassResult,
  insts: CliInstance[],
  slots: Map<string, string>,
  excluded: Set<string>,
): Promise<void> {
  const used = new Set(slots.values())
  const accts = new Set<string>()
  for (const i of insts) {
    const email = cliLoginEmail(i)
    if (email) accts.add(acctKey(l.key, email))
  }
  const hidden = new Set<string>()
  for (const [id, remote] of store) {
    if (remote.kind === 'desktop' || used.has(id)) continue
    // `c.state[id]` with no instance here holding it: this PC had it and deleted its instance.
    if (
      remote.signedOut ||
      excluded.has(id) ||
      (remote.acct && accts.has(remote.acct)) ||
      c.state[id]
    ) {
      hidden.add(id)
      continue
    }
    const login = await downloadLogin(l, store, c, out, id)
    if (login) await landPortableLogin(c, out, login, remote.version, id)
  }
  lastHidden = hidden
}

async function syncDesktopLoginsPass(
  l: Live,
  c: SyncConfig,
  store: Map<string, StoreRow>,
  excluded: Set<string>,
  out: LoginSyncPassResult,
  by: string,
): Promise<void> {
  try {
    await syncDesktopLogins({
      store,
      state: c.state,
      excluded,
      out,
      note: (num, action, text) => note(c, num, action, text),
      upload: async (login: PortableDesktopLogin, expect: number) => {
        const r = await call(l, 'PUT', `/v1/logins/${login.id}`, {
          version: expect,
          blob: sealLogin(l.key, login),
          meta: {
            kind: 'desktop',
            num: login.num,
            name: login.name,
            expiresAt: login.expiresAt,
            by,
            at: Date.now(),
          },
        })
        if (r.status === 200 && typeof r.json?.version === 'number') {
          store.set(login.id, {
            version: r.json.version,
            num: login.num,
            kind: 'desktop',
            name: login.name,
            acct: null,
            expiresAt: login.expiresAt,
            at: Date.now(),
            signedOut: false,
          })
          out.pushed++
          note(c, login.num, 'pushed', 'Uploaded this PC’s newer desktop login.')
          return r.json.version as number
        }
        if (r.status === 409) {
          out.problems.push(`#${login.num}: changed in the store meanwhile; next pass decides.`)
          return null
        }
        throw httpError(`Uploading #${login.num}`, r)
      },
      download: async (id: string) => {
        const r = await mirrorFor(l).getItem('logins', id)
        if (r.status !== 200 || typeof r.json?.blob !== 'string') throw httpError('Downloading', r)
        const login = asDesktopLogin(openBlob(l.key, id, r.json.blob), id)
        if (!login) out.problems.push(`${id}: the store's copy does not open with this PC's key.`)
        return login
      },
      markSignedOut: (uuid: string, num: number | null, name: string | null, expect: number) =>
        markSignedOut(
          l,
          c,
          store,
          out,
          by,
          { id: uuid, kind: 'desktop', num, name, acct: null },
          expect,
        ),
      confirmGone,
      clearGone,
      dropUsage: (dir: string) => dropCachedUsage(desktopKey(dir), { keepLastKnown: true }),
    })
  } catch (err) {
    const msg = `Desktop logins: ${err instanceof Error ? err.message : String(err)}`
    out.problems.push(msg)
    note(c, null, 'error', msg)
  }
}

// One mirror per store (address and token): the pass and the queue and chat parts all read it.
let mirror: { id: string; m: StoreMirror } | null = null
function mirrorFor(l: Live): StoreMirror {
  const id = `${l.url}
${l.token}`
  if (mirror?.id !== id)
    mirror = { id, m: new StoreMirror((method, path) => call(l, method, path)) }
  return mirror.m
}

/** One store row's fields from its meta, each defaulted when missing or of the wrong type. */
function storeRowOf(r: { version: number; meta?: any }): StoreRow {
  const meta = r.meta ?? {}
  const numOr = <T>(v: unknown, fallback: T): number | T => (typeof v === 'number' ? v : fallback)
  const strOr = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    version: r.version,
    num: numOr(meta.num, null),
    kind: meta.kind === 'desktop' ? 'desktop' : 'cli',
    name: strOr(meta.name),
    acct: strOr(meta.acct),
    expiresAt: numOr(meta.expiresAt, 0),
    at: numOr(meta.at, 0),
    signedOut: meta.signedOut === true,
  }
}

/** Refresh the store mirror (the logins, plus the queue and chats when shared) and read its logins. */
async function readStoreLogins(l: Live, c: SyncConfig): Promise<Map<string, StoreRow>> {
  const m = mirrorFor(l)
  await m.refresh({
    tables: [
      'logins',
      ...(c.shareQueue ? ['queues' as const] : []),
      ...(c.shareChats ? ['chats' as const] : []),
    ],
  })
  const list = m.view('logins')
  if (!list.ok) throw httpError('Reading the store', list.reply)
  const store = new Map<string, StoreRow>()
  for (const r of list.rows as Array<{ id: string; version: number; meta?: any }>)
    store.set(r.id, storeRowOf(r))
  return store
}

async function executeSyncPass(
  l: Live,
  c: SyncConfig,
  out: LoginSyncPassResult,
  excluded: Set<string>,
  by: string,
): Promise<void> {
  cliWaitingPass = new Set()
  try {
    const store = await readStoreLogins(l, c)
    lastStore = store
    await learnAccounts(l, store)

    const insts = listCliInstances()
    const slots = slotsFor(l.key, store, insts)
    lastSlots = slots
    for (const inst of insts) {
      if (excluded.has(inst.id)) continue
      const slot = slots.get(inst.id)!
      await syncCliInstance(l, c, store, out, by, inst, slot)
      await dropOwnDuplicate(l, c, store, inst, slot)
    }
    await syncStoreOnlyLogins(l, c, store, out, insts, slots, excluded)
    await syncDesktopLoginsPass(l, c, store, excluded, out, by)
    cliWaiting = cliWaitingPass
    c.lastError = out.problems.length ? out.problems[0]! : null
  } catch (err) {
    out.ok = false
    c.lastError = err instanceof Error ? err.message : String(err)
    out.problems.push(c.lastError)
    note(c, null, 'error', c.lastError)
  }
}

/** Why the queue could not sync at the last pass; null when it did or is off. Kept apart from the
 *  logins' lastError. */
let queueError: string | null = null

/** The queue half of a pass (climayte-queue-sync.ts). Its failures are its own: kept in queueError and
 *  noted once per message, never in lastError and never stopping what the pass already did. */
async function queuePass(l: Live, c: SyncConfig, by: string): Promise<void> {
  if (!c.shareQueue) {
    queueError = null
    return
  }
  c.pcId ??= randomUUID()
  try {
    await syncQueue({
      call: (method, path, body) => call(l, method, path, body),
      mirror: mirrorFor(l),
      key: l.key,
      pc: c.pcId,
      name: by,
    })
    queueError = null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg !== queueError) note(c, null, 'error', `CliMayte queue: ${msg}`)
    queueError = msg
  }
}

/** Why the chats could not sync at the last chat pass; null when they did or are off. */
let chatsError: string | null = null
let chatsRunning: Promise<void> | null = null
let chatLocal: () => ChatLocal = () => createChatLocal()

/** Tests: this PC's chats are a fake. Pass null for the real ones. */
export function setChatLocalForTests(local: ChatLocal | null): void {
  chatLocal = local ? () => local : () => createChatLocal()
}

/** Resolves when no chat pass is running (tests await it; a pass does not). */
export function chatsIdle(): Promise<void> {
  return chatsRunning ?? Promise.resolve()
}

/** Start the chat half of a pass (desktop-chat-sync.ts) unless one is still running, so two never
 *  overlap, and do not wait for it: the logins' pass is already written and the next one is not held
 *  behind a long read. Its failures are its own: chatsError and one note per message. */
function chatsPass(l: Live, c: SyncConfig, by: string): void {
  if (!c.shareChats) {
    chatsError = null
    return
  }
  if (chatsRunning) return
  c.pcId ??= randomUUID()
  const pc = c.pcId
  chatsRunning = (async () => {
    try {
      await syncChats({
        call: (method, path, body) => call(l, method, path, body),
        mirror: mirrorFor(l),
        key: l.key,
        pc,
        name: by,
        local: chatLocal(),
        statePath: CHATS_STATE_PATH,
      })
      chatsError = null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const now = readConfig()
      if (!now?.shareChats) return
      if (msg !== chatsError) {
        note(now, null, 'error', `Desktop chats: ${msg}`)
        writeConfig(now)
      }
      chatsError = msg
    }
  })().finally(() => {
    chatsRunning = null
  })
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
  await executeSyncPass(l, c, out, excluded, by)
  await queuePass(l, c, by)
  c.lastSyncAt = Date.now()
  // Re-read what another call changed meanwhile (an exclusion, a pause) and keep it.
  const now = readConfig()
  if (now) {
    c.enabled = now.enabled
    c.shareQueue = now.shareQueue
    c.shareChats = now.shareChats
    c.excluded = now.excluded
  }
  writeConfig(c)
  chatsPass(l, c, by)
  return out
}

/** What the Login sync dialog shows. Never a token, key or login. */
function makeCliLogin(
  i: ReturnType<typeof listCliInstances>[number],
  slot: string,
  remote: any,
  excluded: Set<string>,
  state: any,
): CliLoginSyncStatus['logins'][number] {
  const file = !!readText(credPath(i.configDir))
  const hollow = file && !hasOwnCliLogin(i.configDir)
  const fed = hollow && !!i.associatedDesktopDir
  const signedOut = (hollow && !fed) || (!file && !!remote?.signedOut)
  return {
    id: i.id,
    kind: 'cli',
    num: i.num ?? null,
    name: i.name,
    here: i.loggedIn || file,
    inStore: !!remote,
    excluded: excluded.has(i.id),
    inSync:
      file && !hollow && !!remote && !remote.signedOut && state[slot]?.version === remote.version,
    problem: null,
    note: fed ? 'fed' : signedOut ? 'signedOut' : cliWaiting.has(i.id) ? 'waiting' : null,
  }
}

function makeDesktopLogin(
  p: ReturnType<typeof listDesktopProfiles>[number],
  remote: any,
  excluded: Set<string>,
  state: any,
): CliLoginSyncStatus['logins'][number] {
  return {
    id: p.uuid!,
    kind: 'desktop',
    num: p.num,
    name: p.name,
    here: true,
    inStore: !!remote,
    excluded: excluded.has(p.uuid!),
    inSync: !!remote && state[p.uuid!]?.version === remote.version,
    problem: null,
    note: desktopNotes.own.has(p.uuid!)
      ? 'own'
      : desktopNotes.waiting.has(p.uuid!)
        ? 'waiting'
        : null,
  }
}

function makeRemoteLogin(
  id: string,
  remote: any,
  excluded: Set<string>,
): CliLoginSyncStatus['logins'][number] {
  return {
    id,
    kind: remote.kind === 'desktop' ? 'desktop' : 'cli',
    num: remote.num,
    name: remote.name ?? id,
    here: false,
    inStore: true,
    excluded: excluded.has(id),
    inSync: false,
    problem: null,
    note: desktopNotes.waiting.has(id) ? 'waiting' : null,
  }
}

export function loginSyncStatus(): CliLoginSyncStatus {
  const c = readConfig()
  if (!c)
    return {
      configured: false,
      enabled: false,
      url: null,
      lastSyncAt: null,
      lastError: null,
      shareQueue: false,
      queueError: null,
      shareChats: false,
      chatsError: null,
      chats: [],
      logins: [],
      events: [],
    }
  const excluded = new Set(c.excluded)
  const logins: CliLoginSyncStatus['logins'] = []
  const seen = new Set<string>()

  for (const i of listCliInstances()) {
    const slot = lastSlots.get(i.id) ?? i.id
    seen.add(i.id)
    seen.add(slot)
    const remote = lastStore.get(slot)
    logins.push(makeCliLogin(i, slot, remote, excluded, c.state))
  }

  for (const p of listDesktopProfiles()) {
    if (!p.uuid || seen.has(p.uuid)) continue
    seen.add(p.uuid)
    const remote = lastStore.get(p.uuid)
    logins.push(makeDesktopLogin(p, remote, excluded, c.state))
  }

  for (const [id, remote] of lastStore)
    if (!seen.has(id) && !lastHidden.has(id) && !remote.signedOut)
      logins.push(makeRemoteLogin(id, remote, excluded))

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
    shareQueue: c.shareQueue === true,
    queueError,
    shareChats: c.shareChats === true,
    chatsError,
    chats: c.shareChats === true ? chatSyncRows(CHATS_STATE_PATH) : [],
    logins,
    events: c.events,
  }
}

/** Before AgentHydra opens a desktop profile: one pass first, so a newer login lands while the
 *  profile is still closed. At most ten seconds: a launch never waits long on the store. */
export async function syncBeforeLaunch(_dir: string): Promise<void> {
  if (!readConfig()?.enabled) return
  await Promise.race([
    runLoginSync().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ])
}

let timer: ReturnType<typeof setInterval> | null = null
/** Start the sync loop (daemon boot). Each tick is a no-op until sync is set up and on. */
export function startLoginSync(): void {
  if (timer) return
  setBeforeLaunchHook(syncBeforeLaunch, 'login-sync')
  timer = setInterval(() => {
    if (readConfig()?.enabled) void runLoginSync().catch(() => {})
  }, SYNC_EVERY_MS)
  timer.unref?.()
  if (readConfig()?.enabled) setTimeout(() => void runLoginSync().catch(() => {}), 15_000).unref?.()
}

/** Stop the sync loop (daemon shutdown). */
export function stopLoginSync(): void {
  if (timer) clearInterval(timer)
  timer = null
}
