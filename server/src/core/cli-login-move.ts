// server/src/core/cli-login-move.ts — move CLI logins from this PC to another one.
//
// WHY (owner, 2026-10-01): AgentHydra runs on two PCs. A login used on both is two processes
// refreshing one OAuth session, and a refresh can leave the other PC's copy holding a token that no
// longer refreshes: "OAuth session expired and could not be refreshed", the #88 symptom. So a login
// lives on ONE PC, and moving it is three steps done as one: export here, this PC signed out of it in
// the same breath, import there.
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
// refreshes the tokens on its own schedule, which is exactly the race this exists to end. The reads,
// the bundle and the sign-outs run in one synchronous stretch, so nothing in this daemon (a CliMayte
// tick, the keepalive's nudge) can start on the login in between.
//
// IMPORT finds the instance the way a person would: the same instance id first (a login moved there
// and back keeps its folder and transcripts), then the same account (the email in its `.claude.json`,
// or the "<email> (<plan>)" name Quick add gives), else it creates the instance under the SAME id,
// with the SAME number when this PC never used that number. Then `claude auth status` says whether
// the login works here.

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

/** One login inside the encrypted part. `credentials` is the `.credentials.json` text, verbatim. */
interface SealedLogin {
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

/** One login's line in an export or import answer. Never carries a secret. */
export interface LoginMoveRow {
  id: string
  num: number | null
  name: string
  ok: boolean
  message: string
  /** Import: how the instance here was found ('id', 'account') or that it was 'created'. */
  matchedBy?: 'id' | 'account' | 'created'
  /** Import: what `claude auth status` said about the login here. */
  signedInAs?: string | null
}

export interface LoginMoveResult {
  ok: boolean
  message: string
  /** Export: the bundle written. */
  file?: string | null
  rows: LoginMoveRow[]
}

const credPath = (configDir: string): string => join(configDir, '.credentials.json')

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
export function openBundle(raw: unknown, passphrase: string): SealedLogin[] | Error {
  let b: LoginBundle
  try {
    b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as LoginBundle
  } catch {
    return new Error('That file is not a login bundle (it is not JSON).')
  }
  if (b?.format !== BUNDLE_FORMAT || b.version !== 1)
    return new Error('That file is not an AgentHydra login bundle, or it is from a newer version.')
  if (b.kdf?.name !== 'scrypt' || b.cipher !== 'aes-256-gcm')
    return new Error('That bundle uses an encryption this version cannot read.')
  try {
    const key = scryptSync(passphrase, Buffer.from(b.kdf.salt, 'base64'), 32, {
      N: b.kdf.N,
      r: b.kdf.r,
      p: b.kdf.p,
      maxmem: SCRYPT.maxmem,
    })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(b.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(b.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const logins = JSON.parse(plain) as SealedLogin[]
    if (!Array.isArray(logins)) return new Error('The bundle opened, but holds no logins.')
    return logins
  } catch {
    return new Error('The passphrase is wrong, or the file was changed or cut short.')
  }
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
 * Export these CLI logins into one encrypted bundle and sign this PC out of each of them.
 * All or nothing: one login that cannot go (not signed in, a session running on it, a hollow
 * credential file) stops the whole export before anything is written or removed.
 */
export function exportCliLogins(opts: {
  ids: string[]
  passphrase: string
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
  if (!ids.length) return fail('Choose at least one login to move.')

  const rows: LoginMoveRow[] = []
  const sealed: SealedLogin[] = []
  for (const id of ids) {
    const rec = getCliInstance(id)
    if (!rec) {
      rows.push({ id, num: null, name: id, ok: false, message: 'No such CLI instance.' })
      continue
    }
    const row = { id, num: rec.num ?? null, name: rec.name }
    if (!existsSync(credPath(rec.configDir))) {
      rows.push({
        ...row,
        ok: false,
        message: 'Not signed in on this PC, so there is nothing to move.',
      })
      continue
    }
    const running = readLiveRegistry(rec.configDir).length
    if (running) {
      rows.push({
        ...row,
        ok: false,
        message: `${running} Claude session${running === 1 ? ' is' : 's are'} running on it; a running session refreshes the login. Let it finish (or stop it), then move it.`,
      })
      continue
    }
    let credentials: string
    try {
      credentials = readFileSync(credPath(rec.configDir), 'utf8')
      const oauth = (JSON.parse(credentials) as { claudeAiOauth?: { refreshToken?: unknown } })
        .claudeAiOauth
      if (typeof oauth?.refreshToken !== 'string' || !oauth.refreshToken) throw new Error('hollow')
    } catch {
      rows.push({
        ...row,
        ok: false,
        message:
          'Its credential file holds no login that can be refreshed elsewhere. Sign it in again instead.',
      })
      continue
    }
    const oauthAccount = oauthAccountOf(rec.configDir)
    sealed.push({
      id,
      num: rec.num ?? null,
      name: rec.name,
      plan: rec.planLabel ?? null,
      email: emailIn(oauthAccount) ?? emailOfName(rec.name),
      credentials,
      oauthAccount,
    })
    rows.push({ ...row, ok: true, message: 'Ready.' })
  }
  if (rows.some((r) => !r.ok)) return fail('Nothing was moved: one or more logins cannot go.', rows)

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
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(bundle, null, 2))
    renameSync(tmp, file)
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
    return fail('The bundle did not read back the same, so nothing was signed out.', rows)
  }

  const at = Date.now()
  for (const s of sealed) {
    const rec = getCliInstance(s.id)!
    const row = rows.find((r) => r.id === s.id)!
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

/** Write `text` to `path` through a temp file in the same folder, so a reader never sees half. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
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

/**
 * Import the logins in a bundle into this PC's CLI instances (see the header for how each finds its
 * instance), then ask `claude auth status` whether each works here. A login that cannot land (a
 * session running on its instance here, or that instance signed in to another account) is skipped
 * with the reason; the others still land.
 */
export async function importCliLogins(opts: {
  bundle: unknown
  passphrase: string
}): Promise<LoginMoveResult> {
  const logins = openBundle(opts.bundle, opts.passphrase)
  if (logins instanceof Error) return { ok: false, message: logins.message, rows: [] }

  const rows: LoginMoveRow[] = []
  for (const login of logins) {
    const row: LoginMoveRow = {
      id: login.id,
      num: login.num,
      name: login.name,
      ok: false,
      message: '',
    }
    rows.push(row)
    const email = login.email ?? emailIn(login.oauthAccount) ?? emailOfName(login.name)
    let rec = getCliInstance(login.id)
    row.matchedBy = 'id'
    if (!rec && email) {
      rec =
        listCliInstances().find(
          (i) => emailIn(oauthAccountOf(i.configDir)) === email || emailOfName(i.name) === email,
        ) ?? null
      row.matchedBy = 'account'
    }
    if (rec) {
      const running = readLiveRegistry(rec.configDir).length
      if (running) {
        row.num = rec.num ?? null
        row.message = `${running} Claude session${running === 1 ? ' is' : 's are'} running on #${rec.num} here; let it finish, then import again.`
        continue
      }
      const here = isLoggedIn(rec.configDir) ? emailIn(oauthAccountOf(rec.configDir)) : null
      if (here && email && here !== email) {
        row.num = rec.num ?? null
        row.message = `#${rec.num} on this PC is signed in to ${here}, not ${email}. Log it out here first.`
        continue
      }
    } else {
      // A new instance, under the id it had there, and its number when this PC never used it.
      if (login.num) claimInstanceNumber(instanceRef('cli', login.id), login.num)
      const created = createCliInstance(login.name, { id: login.id })
      rec = created.ok ? getCliInstance(login.id) : null
      if (!rec) {
        row.message = created.message || 'Could not create the CLI instance here.'
        continue
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
    } catch (err) {
      row.message = `Could not write the login: ${err instanceof Error ? err.message : String(err)}`
      continue
    }
    const status = await cliAuthStatus(rec.configDir)
    row.ok = status.loggedIn
    row.signedInAs = status.email
    row.message = status.loggedIn
      ? `Signed in as ${status.email ?? email ?? 'the account'}${status.plan ? ` (${status.plan})` : ''}.`
      : 'The login is in place, but `claude auth status` does not pass with it here. Sign it in again with Quick add.'
  }
  const landed = rows.filter((r) => r.ok).length
  return {
    ok: landed === rows.length,
    message: `${landed} of ${rows.length} login${rows.length === 1 ? '' : 's'} signed in on this PC.`,
    rows,
  }
}
