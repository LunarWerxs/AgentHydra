// server/tests/cli-login-move.test.ts — a CLI login moves to another PC whole, and only whole.
//
// The contract (core/cli-login-move.ts): the bundle never holds a credential in the clear, the
// export signs this PC out of the login in the same step, a wrong passphrase lands nothing, and the
// right one puts the exact credential back under the same instance. The other PC is this one here:
// an import matches the instance by id first, which is the same path a login moved there and back
// takes. `claude auth status` is pointed at a program that is not there, so it reads "not signed
// in" without spawning the real CLI; the bytes are what this pins.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance, getCliInstance } from '../src/core/cli-instances'
import { exportCliLogins, importCliLogins } from '../src/core/cli-login-move'

process.env.AGENTHYDRA_CLAUDE_PATH = join(tmpdir(), 'no-such-claude-for-cli-login-move.exe')

describe('moving a CLI login between PCs', () => {
  test('export seals it and signs this PC out; only the right passphrase brings it back', async () => {
    const made = createCliInstance('mover@example.com (Pro)')
    const id = (made.data as { id: string }).id
    let out = ''
    try {
      const dir = getCliInstance(id)!.configDir
      const credentials = JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at-plain-123',
          refreshToken: 'rt-plain-SECRET-456',
          expiresAt: 1,
          subscriptionType: 'pro',
        },
      })
      writeFileSync(join(dir, '.credentials.json'), credentials)
      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'mover@example.com' } }),
      )
      out = mkdtempSync(join(tmpdir(), 'ah-login-move-'))
      const passphrase = 'correct horse battery staple'

      const exported = exportCliLogins({ ids: [id], passphrase, dir: out })
      expect(exported.ok).toBe(true)
      const bundle = readFileSync(exported.file!, 'utf8')
      expect(bundle).not.toContain('rt-plain-SECRET-456')
      expect(bundle).not.toContain('at-plain-123')
      expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
      expect(getCliInstance(id)!.loggedIn).toBe(false)
      expect(getCliInstance(id)!.movedAway?.file).toBe(exported.file!)

      const wrong = await importCliLogins({ bundle, passphrase: 'not the passphrase at all' })
      expect(wrong.ok).toBe(false)
      expect(wrong.rows).toEqual([])
      expect(existsSync(join(dir, '.credentials.json'))).toBe(false)

      const back = await importCliLogins({ bundle, passphrase })
      expect(back.rows.map((r) => [r.id, r.matchedBy])).toEqual([[id, 'id']])
      expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(credentials)
      expect(getCliInstance(id)!.movedAway).toBeNull()
    } finally {
      // The registry and CONFIG_DIR are shared with every later file in a serial run (CI's), and an
      // instance left here reads as an orphan dir to registry-integrity's AH-01 reconcile.
      deleteCliInstance(id, getCliInstance(id)?.name)
      if (out) rmSync(out, { recursive: true, force: true })
    }
  })
})
