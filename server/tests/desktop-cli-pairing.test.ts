// server/tests/desktop-cli-pairing.test.ts — every signed-in desktop account gets one linked CLI
// instance, once, and a person's delete is respected.
//
// The contract (core/desktop-cli-pairing.ts): a signed-in desktop with no linked CLI instance gets
// one created (or an unlinked CLI instance of the same account linked); a second pass makes nothing;
// the background pass never remakes a deleted one, only the confirmed turn-on does; with the setting
// off nothing changes; a signed-out desktop is skipped until it signs in. Temp profiles and the
// test CLI store only. Windows only: the profile key is DPAPI's.

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  listCliInstances,
} from '../src/core/cli-instances'
import { encryptSafeStorage } from '../src/core/crypto'
import { ensureWindowsMasterKey } from '../src/core/crypto/keys.win'
import { pairDesktopCliLogins, pairingPlan, runPairing } from '../src/core/desktop-cli-pairing'
import { instancesRoot } from '../src/core/paths'
import { setSetting } from '../src/db'
import './no-chats'

// The default install's folder must not be the developer's real one.
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'pairing-appdata-'))

const far = Date.now() + 30 * 86_400_000
const grant = JSON.stringify({
  'c:o:https://api.example.test:user:inference user:file_upload user:profile user:sessions:claude_code':
    { token: 'example-access', expiresAt: far, subscriptionType: 'max', rateLimitTier: 'tier' },
})

/** A desktop profile; `uuid` null leaves it signed out. */
async function desktop(name: string, uuid: string | null): Promise<string> {
  const dir = join(instancesRoot(), name)
  mkdirSync(dir, { recursive: true })
  await ensureWindowsMasterKey(dir)
  const cfg: Record<string, unknown> = { locale: 'en-US' }
  if (uuid) {
    cfg.lastKnownAccountUuid = uuid
    cfg['oauth:tokenCacheV2'] = await encryptSafeStorage(grant, dir)
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
  return dir
}

const linked = (dir: string) =>
  listCliInstances().filter(
    (c) => c.associatedDesktopDir?.toLowerCase() === dir.replace(/\//g, '\\').toLowerCase(),
  )

async function scratch(fn: (names: string[]) => Promise<void>): Promise<void> {
  const names = [`pair-${randomUUID().slice(0, 8)}`, `pair-${randomUUID().slice(0, 8)}`]
  setSetting('desktop_cli_pairing', '1')
  setSetting('desktop_cli_paired', '[]')
  try {
    await fn(names)
  } finally {
    for (const c of listCliInstances())
      if (c.associatedDesktopDir && names.some((n) => c.associatedDesktopDir?.includes(n)))
        deleteCliInstance(c.id, c.name)
    for (const n of names)
      rmSync(join(instancesRoot(), n), { recursive: true, force: true, maxRetries: 10 })
  }
}

describe.skipIf(process.platform !== 'win32')('desktop CLI pairing', () => {
  test('a signed-in desktop with no linked CLI gets one created and linked, once', () =>
    scratch(async ([a]) => {
      const dir = await desktop(a, randomUUID())
      const first = await runPairing({ all: false })
      expect(first.created.filter((p) => p.desktopLabel === a)).toHaveLength(1)
      expect(linked(dir)).toHaveLength(1)
      expect(linked(dir)[0]!.name).toBe(`${a} (CLI)`)
      const second = await runPairing({ all: false })
      expect(second.created.filter((p) => p.desktopLabel === a)).toHaveLength(0)
      expect(linked(dir)).toHaveLength(1)
    }))

  test('an unlinked CLI instance logged in as the same account is linked, not duplicated', () =>
    scratch(async ([a]) => {
      const uuid = randomUUID()
      const dir = await desktop(a, uuid)
      const id = (createCliInstance(`${a} own`).data as { id: string }).id
      const cli = getCliInstance(id)!
      writeFileSync(
        join(cli.configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { accountUuid: uuid } }),
      )
      writeFileSync(
        join(cli.configDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: far } }),
      )
      const plan = (await pairingPlan()).find((p) => p.desktopLabel === a)
      expect(plan?.action).toBe('link')
      expect(plan?.cliId).toBe(id)
      const r = await runPairing({ all: false })
      expect(r.linked.filter((p) => p.desktopLabel === a)).toHaveLength(1)
      expect(r.created.filter((p) => p.desktopLabel === a)).toHaveLength(0)
      expect(linked(dir).map((c) => c.id)).toEqual([id])
    }))

  test('a deleted CLI instance stays deleted for the background pass, and the confirmed turn-on remakes it', () =>
    scratch(async ([a]) => {
      const dir = await desktop(a, randomUUID())
      await pairDesktopCliLogins()
      const made = linked(dir)[0]!
      expect(deleteCliInstance(made.id, made.name).ok).toBe(true)
      await pairDesktopCliLogins()
      expect(linked(dir)).toHaveLength(0)
      await runPairing({ all: true })
      expect(linked(dir)).toHaveLength(1)
    }))

  test('with the setting off the background pass changes nothing', () =>
    scratch(async ([a]) => {
      const dir = await desktop(a, randomUUID())
      setSetting('desktop_cli_pairing', '0')
      await pairDesktopCliLogins()
      expect(linked(dir)).toHaveLength(0)
    }))

  test('a signed-out desktop is skipped and paired once it signs in', () =>
    scratch(async ([a]) => {
      const dir = await desktop(a, null)
      await pairDesktopCliLogins()
      expect(linked(dir)).toHaveLength(0)
      await desktop(a, randomUUID())
      await pairDesktopCliLogins()
      expect(linked(dir)).toHaveLength(1)
    }))
})
