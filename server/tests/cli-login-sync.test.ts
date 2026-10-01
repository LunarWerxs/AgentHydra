// server/tests/cli-login-sync.test.ts — two PCs on one login stay signed in through the store.
//
// The contract (core/cli-login-sync.ts with cloud/login-sync-worker/worker.js): of two copies of a
// login the one whose access token expires later wins, whichever PC holds it; the store only ever
// holds what opens with the PCs' key; a login left out on this PC is neither uploaded nor replaced.
// A wrong direction here signs a PC out with a dead token (the #88 symptom), so the decision is what
// this pins. The store is the real Worker, run here on bun:sqlite behind D1's prepare/bind API; the
// other PC is played by writing to the store with the key from this PC's pairing code.

import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
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

process.env.AGENTHYDRA_CLAUDE_PATH = join(import.meta.dir, 'no-such-claude-for-login-sync.exe')

/** D1's prepare/bind/first/all/run over bun:sqlite: the Worker's storage, nothing more. */
function d1(db: Database) {
  return {
    prepare(sql: string) {
      let args: Array<string | number> = []
      const stmt = {
        bind(...a: Array<string | number>) {
          args = a
          return stmt
        },
        first: async () => db.query(sql).get(...args) ?? null,
        all: async () => ({ results: db.query(sql).all(...args) }),
        run: async () => ({ meta: { changes: db.query(sql).run(...args).changes } }),
      }
      return stmt
    },
  }
}

const token = randomBytes(24).toString('base64url')
const worker = (
  await import(join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js'))
).default as { fetch: (r: Request, env: unknown) => Promise<Response> }
const env = {
  DB: d1(new Database(':memory:')),
  TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
}
const server = Bun.serve({ port: 0, fetch: (req) => worker.fetch(req, env) })
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const store = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }))

const creds = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: `at-${expiresAt}`, refreshToken: `rt-${expiresAt}`, expiresAt },
  })

describe('login sync between two PCs', () => {
  test('the later expiry wins either way, a stale copy never does, and a left-out login stays put', async () => {
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
      expect(here()).toBe(creds(2000))
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
    }
  })
})
