// server/tests/desktop-login-sync.test.ts — a desktop login reaches the other PC readable, and only
// where it should.
//
// The contract (core/desktop-login-sync.ts, run by core/cli-login-sync.ts's pass): what a profile's
// key encrypts opens with that key and no other; an account only the store holds gets a profile here
// with the sender's folder name and number, its tokens and claude.ai cookies encrypted under the new
// profile's own key (the cookie plaintext led by SHA-256 of its host, as Chromium writes it); of two
// copies in one family the later expiry wins; a login this PC signed in on its own is left alone
// both ways; a login left out here is not replaced. A wrong write here signs a desktop app out, and
// a wrong direction ties two working sign-ins to each other's refreshes. The store is the real
// Worker on bun:sqlite; the other PC is played by writing to the store with this PC's key.
// Windows only: the profile key is DPAPI's.

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  linkCliInstanceToDesktop,
} from '../src/core/cli-instances'
import {
  configureLoginSync,
  disconnectLoginSync,
  loginSyncPairingCode,
  loginSyncStatus,
  runLoginSync,
  sealLogin,
  setLoginSyncExcluded,
} from '../src/core/cli-login-sync'
import { logoutCliInstance } from '../src/core/cli-logout'
import {
  decryptSafeStorage,
  decryptV10Gcm,
  encryptSafeStorage,
  encryptV10Gcm,
} from '../src/core/crypto'
import { ensureWindowsMasterKey } from '../src/core/crypto/keys.win'
import { feedCliFromDesktop, feedLinkedCliLogins } from '../src/core/desktop-cli-feed'
import {
  listDesktopProfiles,
  type PortableDesktopLogin,
  readAuthCookies,
  readDesktopTokens,
  tokenExpiry,
} from '../src/core/desktop-login-sync'
import { instancesRoot } from '../src/core/paths'
import { base, store, token } from './login-sync-store'
import './no-chats'

const HOST = '.claude.ai'
const grants = (expiresAt: number) =>
  JSON.stringify({
    'client:org:https://api:user:inference': { token: `t-${expiresAt}`, expiresAt },
  })
const cookie = (value: string) => ({
  creation_utc: '13400000000000000',
  host_key: HOST,
  top_frame_site_key: '',
  name: 'sessionKey',
  value,
  path: '/',
  expires_utc: '13500000000000000',
  is_secure: 1,
  is_httponly: 1,
  last_access_utc: '13400000000000001',
  has_expires: 1,
  is_persistent: 1,
  priority: 1,
  samesite: 0,
  source_scheme: 2,
  source_port: 443,
  last_update_utc: '13400000000000002',
  source_type: 0,
  has_cross_site_ancestor: 0,
})

/** A signed-in desktop profile as Claude Desktop leaves one: its key in Local State, its token cache
 *  in config.json and its sign-in cookie in a version-24 cookie database, all under that key. */
async function profile(name: string, uuid: string, expiresAt: number, session: string) {
  const dir = join(instancesRoot(), name)
  mkdirSync(join(dir, 'Network'), { recursive: true })
  const key = (await ensureWindowsMasterKey(dir))!
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      locale: 'en-US',
      lastKnownAccountUuid: uuid,
      'oauth:tokenCacheV2': await encryptSafeStorage(grants(expiresAt), dir),
    }),
  )
  const d = new Database(join(dir, 'Network', 'Cookies'), { create: true })
  d.run('CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)')
  d.run(
    'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL)',
  )
  d.run(
    'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port)',
  )
  d.run("insert into meta values ('version', '24'), ('last_compatible_version', '24')")
  const c = cookie(session)
  const sealed = await encryptV10Gcm(
    key,
    new Uint8Array([
      ...createHash('sha256').update(HOST).digest(),
      ...new TextEncoder().encode(session),
    ]),
  )
  d.run('insert into cookies values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    BigInt(c.creation_utc),
    c.host_key,
    c.top_frame_site_key,
    c.name,
    '',
    sealed,
    c.path,
    BigInt(c.expires_utc),
    c.is_secure,
    c.is_httponly,
    BigInt(c.last_access_utc),
    c.has_expires,
    c.is_persistent,
    c.priority,
    c.samesite,
    c.source_scheme,
    c.source_port,
    BigInt(c.last_update_utc),
    c.source_type,
    c.has_cross_site_ancestor,
  ])
  d.close()
  return dir
}

describe.skipIf(process.platform !== 'win32')('desktop login sync', () => {
  test('a value encrypted for a profile opens with that profile’s key and no other', async () => {
    const a = join(instancesRoot(), 'key-a')
    const b = join(instancesRoot(), 'key-b')
    try {
      const keyA = await ensureWindowsMasterKey(a)
      expect(keyA?.length).toBe(32)
      // A second call keeps the key the profile already has: it encrypts what the profile stores.
      expect(Buffer.from((await ensureWindowsMasterKey(a))!).equals(Buffer.from(keyA!))).toBe(true)
      await ensureWindowsMasterKey(b)
      const sealed = (await encryptSafeStorage('{"grant":"é ünïcode"}', a))!
      expect(await decryptSafeStorage(sealed, a)).toBe('{"grant":"é ünïcode"}')
      expect(await decryptSafeStorage(sealed, b)).toBeNull()
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test('the store’s account gets a profile here, the later expiry wins, and a separate sign-in is left alone', async () => {
    const [UA, UB, UC] = [randomUUID(), randomUUID(), randomUUID()]
    const made: string[] = []
    try {
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync() // the pass that setting up starts: later calls would otherwise join it
      const key = Buffer.from(
        JSON.parse(
          Buffer.from(loginSyncPairingCode()!.slice('ahsync1:'.length), 'base64url').toString(),
        ).k,
        'base64',
      )
      const meta = async (id: string) =>
        ((await store('GET', '/v1/logins')).json.logins as any[]).find((r) => r.id === id)
      /** The other PC writes its copy of `id` into the store. */
      const otherPc = async (
        id: string,
        name: string,
        num: number,
        expiresAt: number,
        session: string,
      ) => {
        const login: PortableDesktopLogin = {
          kind: 'desktop',
          id,
          num,
          name,
          tokenCacheV2: grants(expiresAt),
          tokenCache: null,
          cookies: [cookie(session)],
          expiresAt,
        }
        const r = await store('PUT', `/v1/logins/${id}`, {
          version: (await meta(id))?.version ?? 0,
          blob: sealLogin(key, login),
          meta: { kind: 'desktop', num, name, expiresAt },
        })
        expect(r.status).toBe(200)
      }
      const here = async (dir: string) => ({
        expiry: tokenExpiry((await readDesktopTokens(dir))?.v2 ?? null),
        session: (await readAuthCookies(dir))?.find((c) => c.name === 'sessionKey')?.value,
      })

      // An account only the store holds, on a PC with no desktop profile yet (so no cookie database
      // to copy a layout from): a profile here with the sender's folder name and number, signed in
      // under its OWN key, its cookie written the way Chromium stores one.
      await otherPc(UB, 'from-pc1', 4242, 5000, 'sk-b')
      await runLoginSync()
      const b = listDesktopProfiles().find((p) => p.name === 'from-pc1')!
      made.push(b.dir)
      expect(b).toMatchObject({ uuid: UB, num: 4242 })
      expect(await here(b.dir)).toEqual({ expiry: 5000, session: 'sk-b' })
      const row = new Database(join(b.dir, 'Network', 'Cookies'), { readonly: true })
        .query('select value, encrypted_value from cookies')
        .get() as { value: string; encrypted_value: Uint8Array }
      const plain = (await decryptV10Gcm(
        (await ensureWindowsMasterKey(b.dir))!,
        new Uint8Array(row.encrypted_value),
      ))!
      expect(row.value).toBe('')
      expect(
        Buffer.from(plain.subarray(0, 32)).equals(createHash('sha256').update(HOST).digest()),
      ).toBe(true)

      // A login signed in here goes up, keyed by its account.
      const a = await profile('acct-a', UA, 1000, 'sk-a1')
      made.push(a)
      await runLoginSync()
      expect(await meta(UA)).toMatchObject({
        meta: { kind: 'desktop', name: 'acct-a', expiresAt: 1000 },
      })
      // The other PC refreshed the shared login: its newer copy lands here.
      await otherPc(UA, 'acct-a', 1, 2000, 'sk-a2')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 2000, session: 'sk-a2' })
      // An older copy in the store never replaces the newer one here; this PC's goes back up.
      await otherPc(UA, 'acct-a', 1, 500, 'sk-old')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 2000, session: 'sk-a2' })
      expect((await meta(UA)).meta.expiresAt).toBe(2000)
      // The same tokens with other cookies (a profile that was open when its tokens went up sends
      // its cookies once it closes): the cookies land.
      await otherPc(UA, 'acct-a', 1, 2000, 'sk-a3')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 2000, session: 'sk-a3' })

      // Signed in here on its own while the store holds the other PC's sign-in of that account:
      // neither replaces the other.
      await otherPc(UC, 'solo', 9, 9000, 'sk-theirs')
      const solo = await profile('solo', UC, 100, 'sk-mine')
      made.push(solo)
      const before = (await meta(UC)).version
      await runLoginSync()
      expect(await here(solo)).toEqual({ expiry: 100, session: 'sk-mine' })
      expect((await meta(UC)).version).toBe(before)
      expect(loginSyncStatus().logins.find((l) => l.id === UC)?.note).toBe('own')

      // Left out on this PC: a newer copy in the store does not land.
      setLoginSyncExcluded(UA, true)
      await otherPc(UA, 'acct-a', 1, 9999, 'sk-a9')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 2000, session: 'sk-a3' })
    } finally {
      disconnectLoginSync()
      // Retried: on the Windows runner a handle the sync just closed can still hold the folder a moment
      // (EBUSY failed CI run 36986153843 after every assertion had passed).
      for (const dir of made)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)

  test('a linked CLI instance takes its desktop login, a CLI sign-in of its own is never touched, and a logout cuts the link', async () => {
    const dir = await profile('feeds', randomUUID(), 1000, 'sk')
    const made = createCliInstance('fed (CLI)')
    const id = (made.data as { id: string }).id
    const cliDir = getCliInstance(id)!.configDir
    const far = Date.now() + 30 * 86_400_000
    /** The desktop app's token cache: its Claude Code grant, and one a CLI cannot use. */
    const desktopHas = async (accessToken: string, expiresAt: number) =>
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          lastKnownAccountUuid: randomUUID(),
          'oauth:tokenCacheV2': await encryptSafeStorage(
            JSON.stringify({
              'c:o:https://api.anthropic.com:user:profile': { token: 'profile-only', expiresAt },
              'c:o:https://api.anthropic.com:user:inference user:file_upload user:profile user:sessions:claude_code':
                {
                  token: accessToken,
                  refreshToken: 'the-desktop-keeps-this',
                  expiresAt,
                  subscriptionType: 'max',
                  rateLimitTier: 'tier',
                },
            }),
            dir,
          ),
        }),
      )
    const login = () =>
      JSON.parse(readFileSync(join(cliDir, '.credentials.json'), 'utf8')).claudeAiOauth
    try {
      await desktopHas('desk-1', far)
      linkCliInstanceToDesktop(id, dir, 'feeds')
      expect(await feedLinkedCliLogins()).toBe(1)
      // The Claude Code grant, and no refresh token: that one stays the desktop app's.
      expect(login()).toEqual({
        accessToken: 'desk-1',
        expiresAt: far,
        scopes: ['user:inference', 'user:file_upload', 'user:profile', 'user:sessions:claude_code'],
        subscriptionType: 'max',
        rateLimitTier: 'tier',
      })
      // The desktop app renewed its grant: the CLI login follows.
      await desktopHas('desk-2', far + 1000)
      await feedLinkedCliLogins()
      expect(login().accessToken).toBe('desk-2')
      // Logged out: the link goes with it, so the feed does not sign it back in.
      expect(logoutCliInstance(id).ok).toBe(true)
      expect(getCliInstance(id)?.associatedDesktopDir ?? null).toBeNull()
      expect(await feedLinkedCliLogins()).toBe(0)
      // A CLI sign-in of its own (it can refresh itself) is left exactly as it is.
      linkCliInstanceToDesktop(id, dir, 'feeds')
      writeFileSync(
        join(cliDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'own', refreshToken: 'own-refresh', expiresAt: far },
        }),
      )
      expect(await feedCliFromDesktop(getCliInstance(id)!)).toBe('own-login')
      expect(login().accessToken).toBe('own')
    } finally {
      deleteCliInstance(id, getCliInstance(id)?.name)
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
