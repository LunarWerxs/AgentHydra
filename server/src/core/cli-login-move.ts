// server/src/core/cli-login-move.ts — carry CLI logins from this PC to another one.
//
// WHY (owner, 2026-10-01): AgentHydra runs on two PCs, and a login made on one is wanted on the
// other. The first version MOVED a login (this PC signed out in the same step), because a login used
// on both is two processes refreshing one OAuth session, and a refresh can leave the other PC's copy
// holding a token that no longer refreshes ("OAuth session expired and could not be refreshed", the
// #88 symptom). The owner, the same day: "Make it not sign out when transferring. I sometimes need
// both to stay logged in." So an export COPIES by default and signs out only when asked; login sync
// (core/cli-login-sync.ts) is what keeps two signed-in copies from breaking each other.
//
// THE BUNDLE. One file, `agenthydra-logins-<host>-<stamp>.ahlogins`, written to the Downloads folder:
// a JSON envelope whose `logins` list (number, name, plan) is readable, and whose credentials are
// AES-256-GCM encrypted under a key scrypt derives from a passphrase. The web dialog makes the
// passphrase and shows it; the person types it again on the other PC. The server never returns it,
// and the file alone opens nothing, so how it travels (a USB stick, a cloud folder) is the owner's
// choice.
//
// ⛔ SECRETS. A credential file's bytes are read into memory, encrypted and written; nothing here
// logs them or returns them, and the routes answer paths and statuses only.
//
// ⛔ EXPORT REFUSES while a Claude session runs on a login (its live registry): a running CLI
// refreshes the tokens on its own schedule, so the copy could be stale before it lands. The reads,
// the bundle and any sign-outs run in one synchronous stretch, so nothing in this daemon (a CliMayte
// tick, the keepalive's nudge) can start on the login in between.
//
// IMPORT (landLogin, shared with login sync) finds the instance the way a person would: the same
// instance id first (a login carried there and back keeps its folder and transcripts), then the same
// account (the email in its `.claude.json`, or the "<email> (<plan>)" name Quick add gives), else it
// creates the instance under the SAME id, with the SAME number when this PC never used that number.
// Then `claude auth status` says whether the login works here.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '../config'
import { readLiveRegistry } from '../live-registry'
import type {
  CliInstance,
  CliLoginMoveResult as LoginMoveResult,
  CliLoginMoveRow as LoginMoveRow,
} from '../types'
import {
  createCliInstance,
  getCliInstance,
  isLoggedIn,
  listCliInstances,
  setCliInstanceMovedAway,
} from './cli-instances'
import { cliAuthStatus } from './cli-quick-add'
import { claimInstanceNumber, instanceRef } from './instance-numbers'

export const BUNDLE_FORMAT = 'agenthydra-cli-logins'
export const BUNDLE_EXT = '.ahlogins'
/** The shortest passphrase accepted. The dialog's own are 24 characters from a 32-letter alphabet. */
export const MIN_PASSPHRASE = 12
/** scrypt at the cost OWASP lists for it (N 2^15, r 8, p 1): about 0.1 s and 32 MB per derivation. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** One login as it travels between PCs (in a bundle, or in the login-sync store).
 *  `credentials` is the `.credentials.json` text, verbatim. */
export interface PortableLogin {
  id: string
  num: number | null
  name: string
  plan: string | null
  email: string | null
  credentials: string
  /** The non-secret account block of its `.claude.json` (email, organization, plan tier). */
  oauthAccount: unknown
}

export interface LoginBundle {
  format: typeof BUNDLE_FORMAT
  version: 1
  createdAt: string
  from: string
  /** In the clear, so the import dialog can say what is inside before the passphrase. */
  logins: Array<{ num: number | null; name: string; plan: string | null }>
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number }
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

export const credPath = (configDir: string): string => join(configDir, '.credentials.json')

/** The account block of a config dir's `.claude.json`, or null. Not a secret: the CLI keeps the
 *  email, organization and plan tier there for display. */
function oauthAccountOf(configDir: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const a = j.oauthAccount
    return a && typeof a === 'object' ? (a as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const emailIn = (account: unknown): string | null => {
  const e = (account as { emailAddress?: unknown } | null)?.emailAddress
  return typeof e === 'string' && e.includes('@') ? e.toLowerCase() : null
}
/** The email of a "<email> (<plan>)" name, the shape Quick add gives an instance. */
const emailOfName = (name: string): string | null => {
  const m = /^\s*([^\s@()]+@[^\s@()]+\.[^\s@()]+)/.exec(name)
  return m ? m[1]!.toLowerCase() : null
}

/** The account a CLI instance is signed in to (or was, by its "<email> (<plan>)" name), lowercased;
 *  null when neither says. Login sync keys its rows by it, as the import matches instances by it. */
export const cliLoginEmail = (rec: Pick<CliInstance, 'configDir' | 'name'>): string | null =>
  emailIn(oauthAccountOf(rec.configDir)) ?? emailOfName(rec.name)

export const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** When a credential file's access token expires (ms), or 0. Only that field is read. A refresh
 *  pushes it out, so of two copies of one login the later expiry is the newer one. */
export function credentialExpiry(text: string | null): number {
  try {
    const at = (JSON.parse(text ?? '') as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth
      ?.expiresAt
    return typeof at === 'number' && Number.isFinite(at) ? at : 0
  } catch {
    return 0
  }
}

function seal(
  plain: string,
  passphrase: string,
): Omit<LoginBundle, 'format' | 'version' | 'createdAt' | 'from' | 'logins'> {
  const salt = randomBytes(16)
  const key = scryptSync(passphrase, salt, 32, SCRYPT)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    kdf: { name: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/** The logins inside a bundle, or an Error whose message says what is wrong in words. A wrong
 *  passphrase and a damaged file both fail the GCM tag, and say so together. */
export function openBundle(raw: unknown, passphrase: string): PortableLogin[] | Error {
  let b: LoginBundle
  try {
    b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as LoginBundle
  } catch {
    return new Error('That file is not a login bundle (it is not JSON).')
  }
  if (b?.format !== BUNDLE_FORMAT || b.version !== 1)
    return new Error('That file is not an AgentHydra login bundle, or it is from a newer version.')
  // Only the parameters this version writes. scrypt's cost comes from the file, so a crafted one
  // (p 400000 fits under maxmem) would hold the daemon's event loop for an hour before any
  // passphrase is checked (review, 2026-10-01).
  const bytes = (v: unknown): number =>
    typeof v === 'string' ? Buffer.from(v, 'base64').length : -1
  if (
    b.kdf?.name !== 'scrypt' ||
    b.cipher !== 'aes-256-gcm' ||
    b.kdf.N !== SCRYPT.N ||
    b.kdf.r !== SCRYPT.r ||
    b.kdf.p !== SCRYPT.p ||
    bytes(b.kdf.salt) !== 16 ||
    bytes(b.iv) !== 12 ||
    bytes(b.tag) !== 16 ||
    typeof b.data !== 'string'
  )
    return new Error('That bundle uses an encryption this version cannot read.')
  let logins: PortableLogin[]
  try {
    const key = scryptSync(passphrase, Buffer.from(b.kdf.salt, 'base64'), 32, SCRYPT)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(b.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(b.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    logins = JSON.parse(plain) as PortableLogin[]
  } catch {
    return new Error('The passphrase is wrong, or the file was changed or cut short.')
  }
  if (!Array.isArray(logins)) return new Error('The bundle opened, but holds no logins.')
  // The readable list is what the import dialog showed before the passphrase; it is outside the
  // seal, so it must say what is inside it, or the person signed in to logins they never saw.
  const said = JSON.stringify((b.logins ?? []).map((l) => [l?.num ?? null, l?.name ?? null]))
  const holds = JSON.stringify(logins.map((l) => [l.num ?? null, l.name ?? null]))
  if (said !== holds)
    return new Error('The list of logins shown for this file does not match what is inside it.')
  return logins
}

/** Where a bundle goes: the Downloads folder, else AgentHydra's own folder. */
function bundleDir(): string {
  const home =
    (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || homedir()
  const downloads = join(home, 'Downloads')
  try {
    if (statSync(downloads).isDirectory()) return downloads
  } catch {
    // no Downloads folder
  }
  return join(CONFIG_DIR, 'login-moves')
}

/**
 * One CLI login on this PC as it travels, or why it cannot go: not signed in, a session running on
 * it (a running CLI refreshes the login on its own schedule), or a credential file with no refresh
 * token (a hollow login, useless anywhere else).
 */
export function readPortableLogin(
  id: string,
  opts: { whileRunning?: boolean } = {},
): { login: PortableLogin } | { error: string; num: number | null; name: string } {
  const rec = getCliInstance(id)
  if (!rec) return { error: 'No such CLI instance.', num: null, name: id }
  const at = { num: rec.num ?? null, name: rec.name }
  if (!existsSync(credPath(rec.configDir)))
    return { error: 'Not signed in on this PC, so there is nothing to carry.', ...at }
  // Login sync uploads the file as the running CLI last wrote it (`whileRunning`): a refresh made
  // under a long CliMayte run must reach the other PC before that run ends, not after.
  const running = opts.whileRunning ? 0 : readLiveRegistry(rec.configDir).length
  if (running)
    return {
      error: `${running} Claude session${running === 1 ? ' is' : 's are'} running on it; a running session refreshes the login. Let it finish (or stop it), then try again.`,
      ...at,
    }
  let credentials: string
  try {
    credentials = readFileSync(credPath(rec.configDir), 'utf8')
    const oauth = (JSON.parse(credentials) as { claudeAiOauth?: { refreshToken?: unknown } })
      .claudeAiOauth
    if (typeof oauth?.refreshToken !== 'string' || !oauth.refreshToken) throw new Error('hollow')
  } catch {
    return {
      error:
        'Its credential file holds no login that can be refreshed elsewhere. Sign it in again instead.',
      ...at,
    }
  }
  const oauthAccount = oauthAccountOf(rec.configDir)
  return {
    login: {
      id,
      num: rec.num ?? null,
      name: rec.name,
      plan: rec.planLabel ?? null,
      email: emailIn(oauthAccount) ?? emailOfName(rec.name),
      credentials,
      oauthAccount,
    },
  }
}

/**
 * Export these CLI logins into one encrypted bundle. This PC stays signed in to them unless
 * `signOut` (a move). All or nothing: one login that cannot go stops the whole export before
 * anything is written or removed.
 */
export function exportCliLogins(opts: {
  ids: string[]
  passphrase: string
  /** Sign this PC out of each login once the bundle holds it (a move instead of a copy). */
  signOut?: boolean
  /** Where to write the bundle (tests); default the Downloads folder. */
  dir?: string
}): LoginMoveResult {
  const fail = (message: string, rows: LoginMoveRow[] = []): LoginMoveResult => ({
    ok: false,
    message,
    file: null,
    rows,
  })
  if (typeof opts.passphrase !== 'string' || opts.passphrase.length < MIN_PASSPHRASE)
    return fail(`The passphrase must be at least ${MIN_PASSPHRASE} characters.`)
  const ids = [...new Set(opts.ids)]
  if (!ids.length) return fail('Choose at least one login to copy.')

  const rows: LoginMoveRow[] = []
  const sealed: PortableLogin[] = []
  for (const id of ids) {
    const read = readPortableLogin(id)
    if ('error' in read) {
      rows.push({ id, num: read.num, name: read.name, ok: false, message: read.error })
      continue
    }
    sealed.push(read.login)
    rows.push({
      id,
      num: read.login.num,
      name: read.login.name,
      ok: true,
      message: 'Ready.',
    })
  }
  if (rows.some((r) => !r.ok))
    return fail('Nothing was copied: one or more logins cannot go.', rows)

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const host = hostname().replace(/[^\w.-]+/g, '_')
  const dir = opts.dir ?? bundleDir()
  const file = join(dir, `agenthydra-logins-${host}-${stamp}${BUNDLE_EXT}`)
  const plain = JSON.stringify(sealed)
  const bundle: LoginBundle = {
    format: BUNDLE_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    from: hostname(),
    logins: sealed.map((s) => ({ num: s.num, name: s.name, plan: s.plan })),
    ...seal(plain, opts.passphrase),
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeAtomic(file, JSON.stringify(bundle, null, 2))
  } catch (err) {
    return fail(
      `Could not write the bundle: ${err instanceof Error ? err.message : String(err)}`,
      rows,
    )
  }
  // Read it back and open it before anything is signed out: a bundle that does not open again would
  // otherwise be the only copy of these logins.
  const back = openBundle(readFileSync(file, 'utf8'), opts.passphrase)
  if (back instanceof Error || JSON.stringify(back) !== plain) {
    rmSync(file, { force: true })
    return fail('The bundle did not read back the same, so nothing changed here.', rows)
  }

  if (!opts.signOut) {
    for (const row of rows) row.message = 'Copied: this PC stays signed in to it.'
    return {
      ok: true,
      message: `${sealed.length} login${sealed.length === 1 ? '' : 's'} in ${file}. Open it on the other PC with the passphrase.`,
      file,
      rows,
    }
  }

  const at = Date.now()
  for (const s of sealed) {
    const rec = getCliInstance(s.id)!
    const row = rows.find((r) => r.id === s.id)!
    // A CLI started outside this daemon since the read (a terminal) may have refreshed the login, and
    // the bundle's copy is then the stale one: signing out here would lose the only live login.
    if (
      readLiveRegistry(rec.configDir).length ||
      readText(credPath(rec.configDir)) !== s.credentials
    ) {
      row.ok = false
      row.message =
        'Its login changed while it was being copied (a session refreshed it), so this PC kept it and the copy in the bundle is stale. Copy it again.'
      continue
    }
    try {
      rmSync(credPath(rec.configDir), { force: true })
      setCliInstanceMovedAway(s.id, { at, file })
      row.message = 'Moved: this PC is signed out of it.'
    } catch (err) {
      row.ok = false
      row.message = `In the bundle, but this PC could not sign out of it (${err instanceof Error ? err.message : String(err)}). Log it out here before importing it there.`
    }
  }
  const ok = rows.every((r) => r.ok)
  return {
    ok,
    message: ok
      ? `${sealed.length} login${sealed.length === 1 ? '' : 's'} in ${file}. Open it on the other PC with the passphrase.`
      : 'The bundle is written, but this PC could not sign out of every login in it.',
    file,
    rows,
  }
}

/** Write `text` to `path` through a temp file in the same folder, so a reader never sees half. A
 *  failed write or rename takes its temp file with it: for a login that file is the token itself. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Put the account block into a config dir's `.claude.json`, keeping everything else in it. */
function mergeOauthAccount(configDir: string, account: unknown): void {
  if (!account || typeof account !== 'object') return
  const path = join(configDir, '.claude.json')
  let j: Record<string, unknown> = {}
  try {
    j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    // none yet (a fresh instance seeded nothing), or unreadable: start from the account alone
  }
  j.oauthAccount = account
  writeAtomic(path, JSON.stringify(j, null, 2))
}

/** The instance this login belongs to (its id first, then its account), or null to make a new one.
 *  `matchedBy` says how it was found; the land still says 'created' when it makes the instance. */
function findLandingInstance(
  login: PortableLogin,
  email: string | null,
): { rec: CliInstance | null; matchedBy: 'id' | 'account' } {
  let rec = getCliInstance(login.id)
  if (rec || !email) return { rec, matchedBy: 'id' }
  rec =
    listCliInstances().find(
      (i) => emailIn(oauthAccountOf(i.configDir)) === email || emailOfName(i.name) === email,
    ) ?? null
  return { rec, matchedBy: 'account' }
}

/** A landing's row. `blocked` says why one was refused when the reason is no conflict: a session
 *  runs there now (it lands once that finishes), or this PC holds a copy as new or newer. */
export type LandedRow = LoginMoveRow & { written: boolean; blocked?: 'running' | 'newer' }

/** A found instance's row fields plus the running-session and fail-closed account checks. A refusal
 *  message means nothing may be written; `null` means the login may land on this instance. */
function landingBlockReason(
  row: LandedRow,
  rec: CliInstance,
  login: PortableLogin,
  email: string | null,
): string | null {
  row.num = rec.num ?? null
  const running = readLiveRegistry(rec.configDir).length
  if (running) {
    row.blocked = 'running'
    return `${running} Claude session${running === 1 ? ' is' : 's are'} running on #${rec.num} here; let it finish, then try again.`
  }
  if (!isLoggedIn(rec.configDir)) return null
  // Fail closed: a login here whose account cannot be matched to this one is never replaced.
  const here = emailIn(oauthAccountOf(rec.configDir))
  if (!here || !email || here !== email)
    return `#${rec.num} on this PC is signed in${here ? ` to ${here}` : ''}, and that cannot be matched to ${email ?? 'this login'}. Log it out here first.`
  // The same account: an older copy (or the same one again) must not undo a refresh made here.
  const current = readText(credPath(rec.configDir))
  if (current === login.credentials) {
    row.ok = true
    row.written = true
    return 'Already here: this PC is signed in with this login.'
  }
  if (credentialExpiry(current) >= credentialExpiry(login.credentials)) {
    row.blocked = 'newer'
    return `#${rec.num} is signed in here with a newer copy of this login, so nothing was changed.`
  }
  return null
}

/**
 * Sign one carried login in on this PC (see the header for how it finds its instance), then ask
 * `claude auth status` whether it works here. Refused, with the reason, when a session runs on its
 * instance here, when that instance is signed in to an account that cannot be matched to this
 * login's, or when it holds a newer copy of the same login. `written`: the credential file now
 * holds this login (true for one already here, too); `ok` is that and the auth check passing.
 */
export async function landLogin(login: PortableLogin): Promise<LandedRow> {
  const row: LandedRow = {
    id: login.id,
    num: login.num,
    name: login.name,
    ok: false,
    message: '',
    written: false,
  }
  const email = login.email ?? emailIn(login.oauthAccount) ?? emailOfName(login.name)
  const found = findLandingInstance(login, email)
  row.matchedBy = found.matchedBy
  let rec = found.rec
  if (rec) {
    const reason = landingBlockReason(row, rec, login, email)
    if (reason !== null) {
      row.message = reason
      return row
    }
  } else {
    // A new instance, under the id it had there, and its number when this PC never used it.
    if (login.num) claimInstanceNumber(instanceRef('cli', login.id), login.num)
    const created = createCliInstance(login.name, { id: login.id })
    rec = created.ok ? getCliInstance(login.id) : null
    if (!rec) {
      row.message = created.message || 'Could not create the CLI instance here.'
      return row
    }
    row.matchedBy = 'created'
  }
  row.id = rec.id
  row.num = rec.num ?? null
  row.name = rec.name
  try {
    mkdirSync(rec.configDir, { recursive: true })
    writeAtomic(credPath(rec.configDir), login.credentials)
    mergeOauthAccount(rec.configDir, login.oauthAccount)
    setCliInstanceMovedAway(rec.id, null)
    row.written = true
  } catch (err) {
    row.message = `Could not write the login: ${err instanceof Error ? err.message : String(err)}`
    return row
  }
  const status = await cliAuthStatus(rec.configDir)
  row.ok = status.loggedIn
  row.signedInAs = status.email
  row.message = status.loggedIn
    ? `Signed in as ${status.email ?? email ?? 'the account'}${status.plan ? ` (${status.plan})` : ''}.`
    : 'The login is in place, but `claude auth status` does not pass with it here. Sign it in again with Quick add.'
  return row
}

/**
 * Import the logins in a bundle into this PC's CLI instances (landLogin each). A login that cannot
 * land is skipped with the reason; the others still land.
 */
export async function importCliLogins(opts: {
  bundle: unknown
  passphrase: string
}): Promise<LoginMoveResult> {
  const logins = openBundle(opts.bundle, opts.passphrase)
  if (logins instanceof Error) return { ok: false, message: logins.message, rows: [] }
  const rows: LoginMoveRow[] = []
  for (const login of logins) {
    const { written: _written, blocked: _blocked, ...row } = await landLogin(login)
    rows.push(row)
  }
  const landed = rows.filter((r) => r.ok).length
  return {
    ok: landed === rows.length,
    message: `${landed} of ${rows.length} login${rows.length === 1 ? '' : 's'} signed in on this PC.`,
    rows,
  }
}
