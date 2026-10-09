// server/tests/climayte-identity-wall.test.ts — an account whose identity is not verified yet is walled
// as an account problem: its task moves on, the wall holds until its credential file changes, and the
// reason is shown. The CLI is tests/mocks/fake-claude.ts, run by the same bun as this suite.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyAttempt,
  climayteCancel,
  climayteList,
  climayteRun,
  climayteWait,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { IDENTITY_RECHECK_MS, setSpendKit, walls } from '../src/climayte-core'
import {
  IDENTITY_WALL,
  isIdentityRequired,
  isLoginWall,
  ORG_DISABLED_WALL,
} from '../src/climayte-lib'
import { credStamp, recheckCredentialWall } from '../src/climayte-stops'
import { harnessKit } from './mocks/climayte-kit'

setSpendKit(harnessKit)

const init = { type: 'system', subtype: 'init', model: 'fake-model' }
const IDENTITY_TEXT = 'API Error: 400 Identity verification is required to continue.'

describe('classifyAttempt: an identity refusal is an auth outcome', () => {
  test('the 400 identity notice is auth, with the notice kept', () => {
    const r = classifyAttempt(
      [
        init,
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: '<synthetic>',
            content: [{ type: 'text', text: IDENTITY_TEXT }],
          },
        },
        { type: 'result', is_error: true, result: IDENTITY_TEXT, total_cost_usd: 0, num_turns: 1 },
      ],
      '',
    )
    expect(r.outcome).toBe('auth')
    expect(isIdentityRequired(r.notice)).toBe(true)
  })

  test('the identity wall is a login wall, so it blocks dispatch until lifted', () => {
    expect(isLoginWall(IDENTITY_WALL)).toBe(true)
  })
})

describe('recheckCredentialWall: the identity wall waits for a new login, never a timer', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-identity-recheck-'))
  const configDir = join(root, 'acct')
  const acct = { id: 'idn-recheck', num: 41, name: 'recheck', configDir, sessionPct: 0, weekPct: 0 }
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, '.credentials.json'), '{}')

  afterAll(() => {
    delete walls[acct.id]
    rmSync(root, { recursive: true, force: true })
  })

  test('an unchanged credential file keeps the wall before 6 hours have passed', () => {
    walls[acct.id] = {
      until: Date.now() + IDENTITY_RECHECK_MS,
      reason: IDENTITY_WALL,
      cred: credStamp(configDir),
    }
    expect(recheckCredentialWall(acct, walls[acct.id])).toBe(true)
    expect(walls[acct.id]?.reason).toBe(IDENTITY_WALL)
  })

  test('after 6 hours with the same credential the wall lifts, so the account is tried again', () => {
    walls[acct.id] = {
      until: Date.now() - 1,
      reason: IDENTITY_WALL,
      cred: credStamp(configDir),
    }
    expect(recheckCredentialWall(acct, walls[acct.id])).toBe(true)
    expect(walls[acct.id]).toBeUndefined()
  })

  test('an organization wall is not lifted by the 6-hour recheck', () => {
    walls[acct.id] = {
      until: Date.now() - 1,
      reason: ORG_DISABLED_WALL,
      cred: credStamp(configDir),
    }
    expect(recheckCredentialWall(acct, walls[acct.id])).toBe(true)
    expect(walls[acct.id]?.reason).toBe(ORG_DISABLED_WALL)
    delete walls[acct.id]
  })

  test('a changed credential file lifts the wall', () => {
    walls[acct.id] = {
      until: Date.now() + IDENTITY_RECHECK_MS,
      reason: IDENTITY_WALL,
      cred: credStamp(configDir),
    }
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(configDir, '.credentials.json'), later, later)
    expect(recheckCredentialWall(acct, walls[acct.id])).toBe(true)
    expect(walls[acct.id]).toBeUndefined()
  })
})

describe('integration: an identity-walled account moves its task and is not picked again', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-identity-move-'))
  const cwd = join(root, 'work')
  const idDir = join(root, 'acct-identity')
  const okDir = join(root, 'acct-ok')
  for (const d of [cwd, idDir, okDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(idDir, 'fake-identity'), '')
  let group: string | null = null

  afterAll(() => {
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    delete walls['idn-move-a']
    rmSync(root, { recursive: true, force: true })
  })

  test('the task moves to the verified account, the identity account is walled with a reason', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'idn-move-a', num: 51, name: 'identity', configDir: idDir, sessionPct: 0, weekPct: 0 },
      {
        id: 'idn-move-b',
        num: 52,
        name: 'verified',
        configDir: okDir,
        sessionPct: 50,
        weekPct: 50,
      },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [{ prompt: 'a task that moves off identity', cwd, title: 'identity' }],
    })
    group = run.group
    const id = run.workers[0]?.id as string

    const deadline = Date.now() + 30_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }

    expect(w?.error ?? null).toBeNull()
    expect(w?.status).toBe('done')
    expect(w?.attempts.map((a) => [a.account.id, a.outcome])).toEqual([
      ['idn-move-a', 'auth'],
      ['idn-move-b', 'done'],
    ])
    expect(walls['idn-move-a']?.reason).toBe(IDENTITY_WALL)
    const until = walls['idn-move-a']?.until ?? 0
    expect(until).toBeGreaterThan(Date.now())
    expect(until).toBeLessThanOrEqual(Date.now() + IDENTITY_RECHECK_MS)
  }, 35_000)
})
