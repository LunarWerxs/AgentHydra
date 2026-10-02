// server/tests/cli-login-sync.test.ts — two PCs on one login stay signed in through the store.
//
// The contract (core/cli-login-sync.ts with cloud/login-sync-worker/worker.js): of two copies of a
// login the one whose access token expires later wins, whichever PC holds it; the store only ever
// holds what opens with the PCs' key; a login left out on this PC is neither uploaded nor replaced.
// A wrong direction here signs a PC out with a dead token (the #88 symptom), so the decision is what
// this pins. The store is the real Worker, run here on bun:sqlite behind D1's prepare/bind API; the
// other PC is played by writing to the store with the key from this PC's pairing code.

import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance, getCliInstance } from '../src/core/cli-instances'
import type { PortableLogin } from '../src/core/cli-login-move'
import {
  configureLoginSync,
  disconnectLoginSync,
  loginSyncPairingCode,
  openLogin,
  runLoginSync,
  sealLogin,
  setLoginSyncExcluded,
} from '../src/core/cli-login-sync'
import { base, store, token } from './login-sync-store'

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
      const otherPc = async (expiresAt: number) => {
        const { version, login } = await inStore()
        const theirs: PortableLogin = { ...login, credentials: creds(expiresAt) }
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
      // Left out on this PC: a newer copy in the store does not land.
      setLoginSyncExcluded(id, true)
      await otherPc(9000)
      await runLoginSync()
      expect(here()).toBe(creds(3000))
    } finally {
      disconnectLoginSync()
      deleteCliInstance(id, getCliInstance(id)?.name)
      process.env.AGENTHYDRA_CLAUDE_PATH = claudeWas
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })
})
