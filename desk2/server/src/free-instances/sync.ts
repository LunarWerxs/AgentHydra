// Free logins ride AgentHydra's Login sync (owner, 2026-10-06: they "need to carry across" what he and
// CornuCopia share): the same store, key and token, read from the AgentHydra daemon on this PC (its
// pairing code, never logged), into the store's own `free` table (cloud/login-sync-worker), so an
// AgentHydra that knows nothing of Free never takes a Free login for a CLI one.
//
// A ROW is one Free instance, named by its id. Its blob is sealed under the sync key (AES-256-GCM over
// gzip JSON, `free:<id>` bound in as associated data) and holds the instance's number, provider and
// name and its login's cookies. Only cookies travel: they are the sign-in, and the site's cached storage
// beside them (megabytes for claude.ai) is the site's to rebuild. Each PC seals them again for its own
// Windows user (DPAPI), in the harness's own file format.
//
// THE NEWER LOGIN WINS, as for the CLI logins: of two copies, the one whose sign-in cookie expires later
// (a sign-in or a refresh pushes it out). A row this PC has no instance for becomes one, with the same
// id, number (unless taken here) and name. A LOG OUT REACHES EVERY PC: a login this PC shared and then
// logged out turns its row into a signed-out marker naming that login; a PC still on that same login
// logs out of it, and one signed in since sends its own up instead. Nothing is read or written while an
// operation runs on the instance. A DELETE REACHES EVERY PC: the row becomes a deleted marker, and every PC
// removes that account and never adopts it again. So only the real home's Desk is a peer (real-home.ts): one on a
// test's or a probe's folder never syncs.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { FREE_PROVIDERS, type FreeInstance, type FreeProvider } from '@shared/free-instances'
import { dpapiProtect, dpapiUnprotect } from './dpapi'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The harness's session files: claudfree/state.py and claudfree/chatgpt/state.py.
const MAGIC: Record<FreeProvider, Buffer> = {
  claude: Buffer.from('CLAUDFREE-DPAPI-1\0', 'latin1'),
  chatgpt: Buffer.from('CLAUDFREE-CHATGPT-DPAPI-1\0', 'latin1')
}
// The cookie that IS the sign-in; ChatGPT splits it into numbered parts.
const SIGN_IN: Record<FreeProvider, (name: string) => boolean> = {
  claude: name => name === 'sessionKey',
  chatgpt: name => /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(name)
}
const FIRST_PASS_MS = 15_000
const EVERY_MS = 120_000
const NUDGE_MS = 2_000
const CREDS_KEEP_MS = 10 * 60_000

interface Cookie { name: string; value: string; expires?: number }
/** One login as the sync compares it: its sign-in's identity (a hash) and when that sign-in expires. */
export interface FreeLogin { cookies: Cookie[]; auth: string; exp: number }
export interface StoreCreds { url: string; token: string; key: Buffer }
interface Shared { id: string; num: number; provider: FreeProvider; name: string; auth: string; cookies?: Cookie[]; signedOut?: true; deleted?: true }
interface Row { id: string; version: number; meta?: { signedOut?: boolean; deleted?: boolean } }
/** What this PC and the store last agreed on for a row: its version, and the sign-in it held and when that
 *  expires (null: none). */
interface Agreed { version: number; auth: string | null; exp?: number | null }

/** What the sync needs of the Free instances (FreeInstances.syncHost()). */
export interface FreeSyncHost {
  list(): FreeInstance[]
  /** An operation or a log out runs on it: leave it for the next pass. */
  busy(id: string): boolean
  sessionFile(instance: FreeInstance): string
  adopt(shared: Pick<FreeInstance, 'id' | 'num' | 'provider' | 'name'>): FreeInstance
  /** A login was written into its session file. */
  landed(id: string): void
  /** Log out here, as the Log out action does. */
  forget(id: string): Promise<void>
  /** Accounts deleted here that the store has not been told of yet. */
  deleted(): Pick<FreeInstance, 'id' | 'num' | 'provider' | 'name'>[]
  /** The store knows of that deletion: drop its tombstone. */
  settled(id: string): void
  /** Delete the account here because another PC deleted it (no tombstone: the store already knows). */
  remove(id: string): Promise<void>
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function describe(provider: FreeProvider, cookies: Cookie[]): FreeLogin | null {
  const signIn = cookies.filter(c => SIGN_IN[provider](c.name))
  if (!signIn.length) return null
  return {
    cookies,
    auth: sha(signIn.map(c => `${c.name}=${c.value}`).sort().join('\n')),
    exp: Math.max(...signIn.map(c => Number(c.expires) || 0))
  }
}

const isCookie = (c: unknown): c is Cookie =>
  !!c && typeof c === 'object' && typeof (c as Cookie).name === 'string' && typeof (c as Cookie).value === 'string'

/** The login in a harness session file, or null (none, signed out, another user's, damaged). */
export function readLogin(file: string, provider: FreeProvider): FreeLogin | null {
  let data: Buffer
  try { data = readFileSync(file) } catch { return null }
  const magic = MAGIC[provider]
  if (data.length <= magic.length || !data.subarray(0, magic.length).equals(magic)) return null
  const plain = dpapiUnprotect(new Uint8Array(data.subarray(magic.length)))
  if (!plain) return null
  try {
    const cookies = (JSON.parse(Buffer.from(plain).toString('utf8')) as { cookies?: unknown[] }).cookies
    return Array.isArray(cookies) ? describe(provider, cookies.filter(isCookie)) : null
  } catch { return null }
}

/** Write cookies as the harness's session file, sealed for this Windows user. */
export function writeLogin(file: string, provider: FreeProvider, cookies: Cookie[]): boolean {
  const sealed = dpapiProtect(new Uint8Array(Buffer.from(JSON.stringify({ cookies, origins: [] }), 'utf8')))
  if (!sealed) return false
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.sync-${process.pid}`
  writeFileSync(temporary, Buffer.concat([MAGIC[provider], Buffer.from(sealed)]), { mode: 0o600 })
  renameSync(temporary, file)
  return true
}

const aad = (id: string) => Buffer.from(`free:${id}`, 'utf8')
function seal(key: Buffer, value: Shared): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(value.id))
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}
/** A row's blob, or null when it does not open with this key for this id, or is not a Free login. */
function open(key: Buffer, id: string, blob: unknown): Shared | null {
  try {
    const raw = Buffer.from(String(blob), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAAD(aad(id))
    decipher.setAuthTag(raw.subarray(12, 28))
    const s = JSON.parse(gunzipSync(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])).toString('utf8')) as Shared
    const valid = s.id === id && FREE_PROVIDERS.includes(s.provider) && Number.isInteger(s.num) && s.num > 0 &&
      typeof s.name === 'string' && s.name.trim().length > 0 && s.name.length <= 100 && !/[\x00-\x1f]/.test(s.name) &&
      typeof s.auth === 'string' && (s.signedOut === true || s.deleted === true || (Array.isArray(s.cookies) && s.cookies.every(isCookie)))
    return valid ? s : null
  } catch { return null }
}

/** The store AgentHydra's Login sync uses on this PC, from its pairing code; null while that is off. */
export async function daemonCreds(base: string): Promise<StoreCreds | null> {
  // floor-ok: AgentHydra down or its sync off both read as "no store": the pass says sync is off and tries again later
  const status = await fetch(`${base}/api/cli-instances/sync`, { signal: AbortSignal.timeout(10_000) }).then(r => (r.ok ? r.json() : null)).catch(() => null) as { configured?: boolean; enabled?: boolean } | null
  if (!status?.configured || !status.enabled) return null
  // floor-ok: as above
  const answer = await fetch(`${base}/api/cli-instances/sync/pairing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null) as { code?: string } | null
  const code = answer?.code
  if (typeof code !== 'string' || !code.startsWith('ahsync1:')) return null
  try {
    const p = JSON.parse(Buffer.from(code.slice('ahsync1:'.length), 'base64url').toString('utf8')) as { u?: string; t?: string; k?: string }
    const key = Buffer.from(p.k ?? '', 'base64')
    return p.u && p.t && key.length === 32 ? { url: p.u.replace(/\/+$/, ''), token: p.t, key } : null
  } catch { return null }
}

export interface FreeSyncStatus { on: boolean; lastSyncAt: number | null; lastError: string | null; shared: number }

export class FreeSync {
  private file: string
  private agreed: Record<string, Agreed> = {}
  private creds: { value: StoreCreds | null; at: number } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private stopped = false
  private last: FreeSyncStatus = { on: false, lastSyncAt: null, lastError: null, shared: 0 }

  constructor(home: string, private host: FreeSyncHost, private source: () => Promise<StoreCreds | null>) {
    this.file = join(home, 'free', 'sync.json')
    try { this.agreed = (JSON.parse(readFileSync(this.file, 'utf8')) as { rows?: Record<string, Agreed> }).rows ?? {} } catch { this.agreed = {} }
  }

  start(): void { this.schedule(FIRST_PASS_MS) }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer) }
  /** A sign-in or a log out here: sync soon rather than at the next tick. */
  nudge(): void { this.schedule(NUDGE_MS) }
  status(): FreeSyncStatus { return { ...this.last } }

  private schedule(ms: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.pass().finally(() => this.schedule(EVERY_MS)), ms)
    this.timer.unref?.()
  }

  /** One pass; a pass already running is joined, not doubled. */
  pass(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = null })
    return this.running
  }

  private async store(): Promise<StoreCreds | null> {
    if (!this.creds || Date.now() - this.creds.at > CREDS_KEEP_MS) this.creds = { value: await this.source(), at: Date.now() }
    return this.creds.value
  }

  private async call(c: StoreCreds, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(`${c.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    if (r.status === 401) this.creds = null
    return { status: r.status, json: await r.json().catch(() => null) }
  }

  private async run(): Promise<void> {
    const before = this.last.lastError
    try {
      const c = await this.store()
      if (!c) { this.last = { ...this.last, on: false, lastError: null }; return }
      const list = await this.call(c, 'GET', '/v1/free')
      if (list.status !== 200 || !Array.isArray(list.json?.free)) throw new Error(`the store answered ${list.status} to the Free list`)
      const rows = new Map<string, Row>((list.json.free as Row[]).filter(r => UUID.test(r.id)).map(r => [r.id, r]))
      const problems: string[] = []
      // Taken before the tombstones settle: this pass's list still shows their rows as live.
      const tombs = new Set(this.host.deleted().map(d => d.id))
      for (const t of this.host.deleted()) {
        try {
          const row = rows.get(t.id)
          if (!row || row.meta?.deleted) { this.host.settled(t.id); delete this.agreed[t.id]; continue }
          const { id, num, provider, name } = t
          // A 409 leaves the tombstone for the next pass; a write that landed settles it.
          if (await this.put(c, id, row.version, seal(c.key, { id, num, provider, name, auth: '', deleted: true }), { deleted: true }, { auth: null, exp: null })) { this.host.settled(id); delete this.agreed[id] }
        } catch (e) { problems.push(`${t.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`) }
      }
      for (const instance of [...this.host.list()]) {
        if (this.host.busy(instance.id)) continue
        if (rows.get(instance.id)?.meta?.deleted) {
          try { await this.host.remove(instance.id); delete this.agreed[instance.id] } catch (e) { problems.push(`#${instance.num}: ${e instanceof Error ? e.message : String(e)}`) }
          continue
        }
        try { await this.one(c, instance, rows.get(instance.id)) } catch (e) { problems.push(`#${instance.num}: ${e instanceof Error ? e.message : String(e)}`) }
      }
      const here = new Set(this.host.list().map(i => i.id))
      for (const row of rows.values()) {
        if (here.has(row.id) || row.meta?.signedOut || row.meta?.deleted || tombs.has(row.id)) continue
        try { await this.adopt(c, row) } catch (e) { problems.push(`${row.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`) }
      }
      this.save()
      this.last = { on: true, lastSyncAt: Date.now(), lastError: problems.length ? problems.join('; ') : null, shared: rows.size }
    } catch (e) {
      this.last = { ...this.last, on: true, lastError: e instanceof Error ? e.message : String(e) }
    }
    // Said once per new error, not every two minutes while it lasts.
    if (this.last.lastError && this.last.lastError !== before) console.error(`[free-sync] ${this.last.lastError}`)
  }

  /** One instance of this PC against its row (none when it was never shared). */
  private async one(c: StoreCreds, instance: FreeInstance, row: Row | undefined): Promise<void> {
    const file = this.host.sessionFile(instance)
    const local = readLogin(file, instance.provider)
    // A file that is there but does not open (mid-write, damaged, signed out by the site) says nothing:
    // it is neither sent up nor taken for a log out.
    if (!local && existsSync(file)) throw new Error('its saved login does not open here')
    const agreed = this.agreed[instance.id]
    if (!row) {
      if (local) await this.upload(c, instance, local, 0)
      return
    }
    if (agreed && agreed.version === row.version) {
      // The store has not moved since this PC and it agreed: a sign-in here goes up, a log out here
      // marks the row. An older login back here (written by an operation that started before a landing)
      // falls through, so the store's newer one lands again.
      if (!local) {
        if (agreed.auth && !row.meta?.signedOut) await this.signOut(c, instance, agreed.auth, row.version)
        return
      }
      if (local.auth === agreed.auth) return
      if (agreed.exp == null || local.exp >= agreed.exp) return this.upload(c, instance, local, row.version)
    }
    const shared = await this.read(c, instance.id)
    if (!shared) return
    if (shared.value.signedOut) {
      if (local && local.auth === shared.value.auth) await this.host.forget(instance.id)
      else if (local) return this.upload(c, instance, local, shared.version)
      this.agreed[instance.id] = { version: shared.version, auth: null }
      return
    }
    const theirs = describe(instance.provider, shared.value.cookies ?? [])
    if (!theirs) throw new Error('the store holds a login without its sign-in')
    if (!local || (theirs.auth !== local.auth && newer(theirs, local))) {
      if (!writeLogin(file, instance.provider, theirs.cookies)) throw new Error('the login could not be written for this Windows user')
      this.host.landed(instance.id)
      this.agreed[instance.id] = { version: shared.version, auth: theirs.auth, exp: theirs.exp }
    } else if (theirs.auth !== local.auth) await this.upload(c, instance, local, shared.version)
    else this.agreed[instance.id] = { version: shared.version, auth: local.auth, exp: local.exp }
  }

  /** A row with no instance here: a Free account another PC added becomes one here too. */
  private async adopt(c: StoreCreds, row: Row): Promise<void> {
    const shared = await this.read(c, row.id)
    if (!shared || shared.value.signedOut) return
    const theirs = describe(shared.value.provider, shared.value.cookies ?? [])
    if (!theirs) return
    const { id, num, provider, name } = shared.value
    const instance = this.host.adopt({ id, num, provider, name })
    if (!writeLogin(this.host.sessionFile(instance), provider, theirs.cookies)) throw new Error('the login could not be written for this Windows user')
    this.host.landed(instance.id)
    this.agreed[instance.id] = { version: shared.version, auth: theirs.auth, exp: theirs.exp }
  }

  private async read(c: StoreCreds, id: string): Promise<{ value: Shared; version: number } | null> {
    const r = await this.call(c, 'GET', `/v1/free/${id}`)
    if (r.status === 404) return null
    if (r.status !== 200) throw new Error(`the store answered ${r.status}`)
    const value = open(c.key, id, r.json?.blob)
    if (!value) throw new Error("the store's copy does not open with this PC's key")
    return { value, version: Number(r.json.version) }
  }

  private async upload(c: StoreCreds, instance: FreeInstance, login: FreeLogin, version: number): Promise<void> {
    const { id, num, provider, name } = instance
    const blob = seal(c.key, { id, num, provider, name, auth: login.auth, cookies: login.cookies })
    await this.put(c, id, version, blob, {}, { auth: login.auth, exp: login.exp })
  }

  private async signOut(c: StoreCreds, instance: FreeInstance, auth: string, version: number): Promise<void> {
    const { id, num, provider, name } = instance
    await this.put(c, id, version, seal(c.key, { id, num, provider, name, auth, signedOut: true }), { signedOut: true }, { auth: null, exp: null })
  }

  private async put(c: StoreCreds, id: string, version: number, blob: string, meta: Row['meta'], held: Omit<Agreed, 'version'>): Promise<boolean> {
    const r = await this.call(c, 'PUT', `/v1/free/${id}`, { version, blob, meta })
    // 409: another PC wrote it meanwhile; the next pass reads theirs and decides.
    if (r.status === 409) return false
    if (r.status !== 200 || !Number.isInteger(r.json?.version)) throw new Error(`the store answered ${r.status} to a write`)
    this.agreed[id] = { version: r.json.version, ...held }
    return true
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ rows: this.agreed }), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
}

/** Of two different sign-ins, the one that expires later; the same expiry is settled by the sign-in's
 *  hash, so every PC picks the same one and none sends its own back up. */
function newer(a: FreeLogin, b: FreeLogin): boolean {
  return a.exp !== b.exp ? a.exp > b.exp : a.auth > b.auth
}
