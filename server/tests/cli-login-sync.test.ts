// server/tests/cli-login-sync.test.ts — two PCs on one login stay signed in through the store.
//
// The contract (core/cli-login-sync.ts with cloud/login-sync-worker/worker.js): of two copies of a
// login the one whose access token expires later wins, whichever PC holds it; the store only ever
// holds what opens with the PCs' key; a login left out on this PC is neither uploaded nor replaced.
// A wrong direction here signs a PC out with a dead token (the #88 symptom), so the decision is what
// this pins. The store is the real Worker, run here on bun:sqlite behind D1's prepare/bind API; the
// other PC is played by writing to the store with the key from this PC's pairing code.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '../src/config'
import { createCliInstance, deleteCliInstance, getCliInstance } from '../src/core/cli-instances'
import type { PortableLogin } from '../src/core/cli-login-move'
import {
  configureLoginSync,
  disconnectLoginSync,
  joinLoginSync,
  loginSyncPairingCode,
  loginSyncStatus,
  noteLoggedOutHere,
  openLogin,
  runLoginSync,
  sealLogin,
  setLoginSyncExcluded,
} from '../src/core/cli-login-sync'
import { base, emptyLogins, store, storeDb, token } from './login-sync-store'

// Scratch dirs from this file, reaped whatever the outcome, even on a throw before or past a test's
// own try/finally.
const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in `claude` whose `auth status` refreshes a login landed at expiry 2000 to 2500, as the
 *  real one may when the access token has run out: landing a login must not hide that refresh. */
function refreshingClaude(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-fake-claude-'))
  scratchDirs.push(dir)
  writeFileSync(
    join(dir, 'fake.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const p = join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json')
const c = JSON.parse(readFileSync(p, 'utf8'))
if (c.claudeAiOauth.expiresAt === 2000)
  writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: 'at-2500', refreshToken: 'rt-2500', expiresAt: 2500 } }))
console.log(JSON.stringify({ loggedIn: true, email: 'synced@example.com' }))
`,
  )
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\nbun "%~dp0fake.mjs" %*\r\n')
    return { path: join(dir, 'claude.cmd'), dir }
  }
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexec bun "$(dirname "$0")/fake.mjs" "$@"\n')
  chmodSync(join(dir, 'claude'), 0o755)
  return { path: join(dir, 'claude'), dir }
}

const creds = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: `at-${expiresAt}`, refreshToken: `rt-${expiresAt}`, expiresAt },
  })

describe('login sync between two PCs', () => {
  // Every test is two PCs and only their logins: another file's rows (sealed with its key) would be a
  // sync error here.
  beforeEach(emptyLogins)

  // It took 4.6-8.5 s (measured 2026-10-02 and 2026-10-04), past bun's 5 s default under load. Nearly
  // all of it was the process scan every pass started for desktop logins this test does not have; a
  // pass with no desktop login to decide no longer scans, and it takes 0.14 s (2026-10-04).
  test('the later expiry wins either way, a stale copy never does, and a left-out login stays put', async () => {
    const fake = refreshingClaude()
    const claudeWas = process.env.AGENTHYDRA_CLAUDE_PATH
    process.env.AGENTHYDRA_CLAUDE_PATH = fake.path
    const made = createCliInstance('synced@example.com (Pro)')
    const id = (made.data as { id: string }).id
    const dir = getCliInstance(id)!.configDir
    try {
      writeFileSync(join(dir, '.credentials.json'), creds(1000))
      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'synced@example.com' } }),
      )
      expect((await store('GET', '/v1/logins', undefined)).status).toBe(200)
      expect((await fetch(`${base}/v1/logins`)).status).toBe(401)

      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync()
      const key = Buffer.from(
        JSON.parse(
          Buffer.from(loginSyncPairingCode()!.slice('ahsync1:'.length), 'base64url').toString(),
        ).k,
        'base64',
      )
      const inStore = async () => {
        const r = await store('GET', `/v1/logins/${id}`)
        return { version: r.json.version as number, login: openLogin(key, id, r.json.blob)! }
      }
      const otherPc = async (expiresAt: number, credentials = creds(expiresAt)) => {
        const { version, login } = await inStore()
        const theirs: PortableLogin = { ...login, credentials }
        const r = await store('PUT', `/v1/logins/${id}`, {
          version,
          blob: sealLogin(key, theirs),
          meta: { num: login.num, expiresAt },
        })
        expect(r.status).toBe(200)
      }
      const here = () => readFileSync(join(dir, '.credentials.json'), 'utf8')

      // This PC's login went up.
      expect((await inStore()).login.credentials).toBe(creds(1000))
      // The other PC refreshed: its newer login lands here.
      await otherPc(2000)
      await runLoginSync()
      // Landed, and its sign-in check refreshed it here (the stand-in claude): that newer login
      // must go up on the next pass, or the other PC is left holding a rotated-out token.
      expect(here()).toBe(creds(2500))
      await runLoginSync()
      expect((await inStore()).login.credentials).toBe(creds(2500))
      // This PC refreshed: its newer login goes up.
      writeFileSync(join(dir, '.credentials.json'), creds(3000))
      await runLoginSync()
      expect((await inStore()).login.credentials).toBe(creds(3000))
      // An older copy in the store never replaces the newer one here; this PC's goes back up.
      await otherPc(500)
      await runLoginSync()
      expect(here()).toBe(creds(3000))
      expect((await inStore()).login.credentials).toBe(creds(3000))
      // The same expiry written another way: neither copy is newer, so the PCs agree. Before, this
      // pass and the landing's newer-copy check refused each other every 30 s (#125, 2026-10-03).
      const reordered = JSON.stringify({
        claudeAiOauth: { expiresAt: 3000, refreshToken: 'rt-3000', accessToken: 'at-3000' },
      })
      await otherPc(3000, reordered)
      await runLoginSync()
      expect(loginSyncStatus().lastError).toBeNull()
      expect(here()).toBe(creds(3000))
      // Anthropic ended the login: the CLI empties its tokens and keeps the file. Nothing to share
      // and no sync error (one dead login read as "sync is broken"); its own row says signed out.
      writeFileSync(
        join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }),
      )
      await runLoginSync()
      expect(loginSyncStatus().lastError).toBeNull()
      expect(loginSyncStatus().logins.find((l) => l.id === id)?.note).toBe('signedOut')
      expect((await inStore()).login.credentials).toBe(reordered)
      // Signed in again here: that login goes up.
      writeFileSync(join(dir, '.credentials.json'), creds(4000))
      await runLoginSync()
      expect((await inStore()).login.credentials).toBe(creds(4000))
      // Left out on this PC: a newer copy in the store does not land.
      setLoginSyncExcluded(id, true)
      await otherPc(9000)
      await runLoginSync()
      expect(here()).toBe(creds(4000))
    } finally {
      disconnectLoginSync()
      deleteCliInstance(id, getCliInstance(id)?.name)
      process.env.AGENTHYDRA_CLAUDE_PATH = claudeWas
      rmSync(fake.dir, { recursive: true, force: true })
    }
  }, 20_000)

  // Owner, 2026-10-02: the same email on both PCs must be one login, not two, and a log out on one
  // PC must sign the other out too. The other PC is played by writing to the store.
  test('one email signed in on both PCs is one row, and a log out on either reaches the other', async () => {
    const fake = refreshingClaude()
    const claudeWas = process.env.AGENTHYDRA_CLAUDE_PATH
    process.env.AGENTHYDRA_CLAUDE_PATH = fake.path
    const made = createCliInstance('both@example.com (Pro)')
    const id = (made.data as { id: string }).id
    const dir = getCliInstance(id)!.configDir
    const theirId = '00000000-0000-4000-8000-000000000001'
    try {
      writeFileSync(join(dir, '.credentials.json'), creds(1000))
      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'both@example.com' } }),
      )
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync()
      const key = Buffer.from(
        JSON.parse(
          Buffer.from(loginSyncPairingCode()!.slice('ahsync1:'.length), 'base64url').toString(),
        ).k,
        'base64',
      )
      const mine = await store('GET', `/v1/logins/${id}`)
      const rows = async () =>
        ((await store('GET', '/v1/logins')).json.logins as any[]).map((r) => r.id)
      // The other PC signed the same email in on its own instance, with a later expiry, and sent it
      // before it knew of this PC's row (the way a PC syncing before this change did).
      const theirs: PortableLogin = {
        ...openLogin(key, id, mine.json.blob)!,
        id: theirId,
        num: null,
        credentials: creds(5000),
      }
      const put = await store('PUT', `/v1/logins/${theirId}`, {
        version: 0,
        blob: sealLogin(key, theirs),
        meta: { num: null, expiresAt: 5000, acct: mine.json.meta.acct },
      })
      expect(put.status).toBe(200)
      await runLoginSync()
      // One instance here, on the newer login, and one row left in the store.
      expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(creds(5000))
      expect((await rows()).filter((r) => r === id || r === theirId)).toEqual([theirId])
      // And one row in the dialog: the store's copy is this instance's, not a second login (the
      // first test's row is still in the shared store, so only these two ids are counted).
      expect(
        loginSyncStatus()
          .logins.filter((l) => l.id === id || l.id === theirId)
          .map((l) => [l.id, l.inStore]),
      ).toEqual([[id, true]])

      // Logged out on the other PC: this PC signs out too.
      const kept = await store('GET', `/v1/logins/${theirId}`)
      expect(
        (
          await store('PUT', `/v1/logins/${theirId}`, {
            version: kept.json.version,
            blob: sealLogin(key, { id: theirId }),
            meta: { ...kept.json.meta, signedOut: true, expiresAt: 0, at: Date.now() },
          })
        ).status,
      ).toBe(200)
      await runLoginSync()
      expect(existsSync(join(dir, '.credentials.json'))).toBe(false)

      // Signed in again here: the other PC gets it back.
      writeFileSync(join(dir, '.credentials.json'), creds(6000))
      await runLoginSync()
      const back = await store('GET', `/v1/logins/${theirId}`)
      expect(back.json.meta.signedOut).not.toBe(true)
      expect(openLogin(key, theirId, back.json.blob)!.credentials).toBe(creds(6000))

      // Logged out here: the store says so, for the other PC.
      rmSync(join(dir, '.credentials.json'))
      noteLoggedOutHere(id)
      await runLoginSync()
      expect((await store('GET', `/v1/logins/${theirId}`)).json.meta.signedOut).toBe(true)
      // And it stays signed out here: the store does not sign it back in.
      await runLoginSync()
      expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    } finally {
      disconnectLoginSync()
      deleteCliInstance(id, getCliInstance(id)?.name)
      process.env.AGENTHYDRA_CLAUDE_PATH = claudeWas
      rmSync(fake.dir, { recursive: true, force: true })
    }
  }, 20_000)

  // Measured live, 2026-10-04: a PC with two instances on one account re-created one row every 30 s
  // and the other PC (one instance, landed from that row) deleted it again, about 110 inserts and 110
  // deletes an hour. Both PCs are real here: each one's registry, sync config and instance dirs are
  // parked on disk while the other runs, and both pass over the one real store.
  test('two instances of one account on a PC are one store row, and no PC re-creates what the other removes', async () => {
    const fake = refreshingClaude()
    const claudeWas = process.env.AGENTHYDRA_CLAUDE_PATH
    process.env.AGENTHYDRA_CLAUDE_PATH = fake.path
    const FIRST = 'c8310000-0000-4000-8000-000000000069'
    const SECOND = 'f6620000-0000-4000-8000-000000000103'
    const parked = mkdtempSync(join(tmpdir(), 'ah-two-pcs-'))
    scratchDirs.push(parked)
    const parts = ['cli-instances.json', 'login-sync.json', 'cli-instances']
    let at = 'A'
    const switchTo = (pc: string) => {
      if (pc === at) return
      for (const [from, to] of [
        [at, null],
        [pc, 'live'],
      ] as const)
        for (const part of parts) {
          const live = join(CONFIG_DIR, part)
          const kept = join(parked, from, part)
          if (to === null) {
            rmSync(kept, { recursive: true, force: true })
            mkdirSync(join(parked, from), { recursive: true })
            if (existsSync(live)) cpSync(live, kept, { recursive: true })
            rmSync(live, { recursive: true, force: true })
          } else if (existsSync(kept)) cpSync(kept, live, { recursive: true })
        }
      at = pc
    }
    const email = JSON.stringify({ oauthAccount: { emailAddress: 'synced@example.com' } })
    const signIn = (id: string, expiresAt: number) => {
      const dir = getCliInstance(id)!.configDir
      writeFileSync(join(dir, '.credentials.json'), creds(expiresAt))
      writeFileSync(join(dir, '.claude.json'), email)
    }
    const rowWrites = () =>
      storeDb
        .statements()
        .filter((s) => /^(INSERT( OR \w+)? INTO|DELETE FROM) logins\b/i.test(s.sql))
        .reduce((n, s) => n + s.calls, 0)
    const rows = async () =>
      ((await store('GET', '/v1/logins')).json.logins as any[]).map((r) => r.id as string)
    const pass = async (pc: string) => {
      switchTo(pc)
      const r = await runLoginSync()
      expect(r.problems).toEqual([])
    }
    const works = (id: string) => {
      const c = JSON.parse(
        readFileSync(join(getCliInstance(id)!.configDir, '.credentials.json'), 'utf8'),
      )
      return !!c.claudeAiOauth.accessToken && c.claudeAiOauth.expiresAt > 0
    }
    try {
      // PC A: the second instance signs in first and uploads its row; B joins and has it landed.
      createCliInstance('second (Pro)', { id: SECOND })
      signIn(SECOND, 1000)
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await pass('A')
      const code = loginSyncPairingCode()!
      const key = Buffer.from(
        JSON.parse(Buffer.from(code.slice('ahsync1:'.length), 'base64url').toString()).k,
        'base64',
      )
      switchTo('B')
      expect((await joinLoginSync(code)).ok).toBe(true)
      await pass('B')
      expect(getCliInstance(SECOND)).not.toBeNull()
      expect(await rows()).toEqual([SECOND])

      // Back on A, the first instance signs in on the same account with a later expiry, and its row is
      // in the store as a build that gave each instance its own row wrote it.
      switchTo('A')
      createCliInstance('first (Pro)', { id: FIRST })
      signIn(FIRST, 3000)
      const mine = await store('GET', `/v1/logins/${SECOND}`)
      const theirs: PortableLogin = {
        ...openLogin(key, SECOND, mine.json.blob)!,
        id: FIRST,
        credentials: creds(3000),
      }
      const planted = await store('PUT', `/v1/logins/${FIRST}`, {
        version: 0,
        blob: sealLogin(key, theirs),
        meta: { ...mine.json.meta, expiresAt: 3000, at: Date.now() },
      })
      expect(planted.status).toBe(200)
      expect((await rows()).sort()).toEqual([FIRST, SECOND].sort())

      // Passes settle after one round (B's second instance takes the account's row), then write no row.
      await pass('A')
      await pass('B')
      await pass('A')
      await pass('B')
      expect(await rows()).toEqual([FIRST])
      storeDb.resetRowsRead()
      for (let i = 0; i < 3; i++) {
        await pass('A')
        await pass('B')
      }
      expect(rowWrites()).toBe(0)

      // The second instance's token refreshes past the first's (the live flip): it is its own to
      // manage, nothing goes up for it and no row comes back.
      switchTo('A')
      signIn(SECOND, 9000)
      for (let i = 0; i < 3; i++) {
        await pass('A')
        await pass('B')
      }
      expect(rowWrites()).toBe(0)
      expect(await rows()).toEqual([FIRST])
      // The first one's refresh goes up on its row and lands on B.
      switchTo('A')
      signIn(FIRST, 11_000)
      for (let i = 0; i < 2; i++) {
        await pass('A')
        await pass('B')
      }
      expect(rowWrites()).toBe(0)
      expect(await rows()).toEqual([FIRST])
      expect(
        openLogin(key, FIRST, (await store('GET', `/v1/logins/${FIRST}`)).json.blob)!.credentials,
      ).toBe(creds(11_000))
      expect(works(SECOND)).toBe(true)
      expect(
        readFileSync(join(getCliInstance(SECOND)!.configDir, '.credentials.json'), 'utf8'),
      ).toBe(creds(11_000))
      switchTo('A')
      expect(works(FIRST)).toBe(true)
      expect(works(SECOND)).toBe(true)
      // The follower keeps the token it manages itself.
      expect(
        readFileSync(join(getCliInstance(SECOND)!.configDir, '.credentials.json'), 'utf8'),
      ).toBe(creds(9000))

      // The instance that held the row is deleted here: the other one takes the account's row over.
      const first = getCliInstance(FIRST)!
      deleteCliInstance(FIRST, first.name)
      await pass('A')
      expect(await rows()).toEqual([FIRST])
      await pass('B')
      await pass('A')
      expect(works(SECOND)).toBe(true)
    } finally {
      switchTo('A')
      for (const id of [FIRST, SECOND]) deleteCliInstance(id, getCliInstance(id)?.name)
      disconnectLoginSync()
      process.env.AGENTHYDRA_CLAUDE_PATH = claudeWas
      rmSync(fake.dir, { recursive: true, force: true })
    }
  }, 60_000)
})
