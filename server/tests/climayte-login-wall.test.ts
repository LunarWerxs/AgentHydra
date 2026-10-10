// server/tests/climayte-login-wall.test.ts — a dead login is not launched by the clock, and a task that
// bounced off one starts on the next account with room in the same tick.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walls, workers } from '../src/climayte-core'
import type { CliMayteAccount, CliMayteWorker } from '../src/climayte-lib'
import { scheduleDue, setLauncher, tickState } from '../src/climayte-schedule'
import { credStamp } from '../src/climayte-stops'
import './no-chats'

const now = 1_800_000_000_000
const WEEK_MS = 7 * 24 * 3_600_000
const halfWeek = now + WEEK_MS / 2
const root = mkdtempSync(join(tmpdir(), 'ah-climayte-login-wall-'))
const configDir = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), '{}')
  return dir
}

const dead: CliMayteAccount = {
  id: 'login-wall-dead',
  num: 181,
  name: 'dead@example.com',
  configDir: configDir('dead'),
  sessionPct: 0,
  weekPct: 0,
}
// Under its weekly pace with room now: the account a 30-minute retry of the dead login would have used.
const room: CliMayteAccount = {
  id: 'login-wall-room',
  num: 182,
  name: 'room@example.com',
  configDir: configDir('room'),
  sessionPct: 10,
  weekPct: 40,
  weekResetsAt: halfWeek,
  planFactor: 5,
}
// Refills in four minutes, so it has no room for the task now.
const soon: CliMayteAccount = {
  id: 'login-wall-soon',
  num: 183,
  name: 'soon@example.com',
  configDir: configDir('soon'),
  sessionPct: 80,
  weekPct: 30,
  weekResetsAt: halfWeek,
  planFactor: 1,
  sessionResetsAt: now + 4 * 60_000,
}
const accounts = [dead, room, soon]

const ids: string[] = []
let launched: string[] = []

const mk = (id: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker => {
  const w = {
    id,
    group: `g-${id}`,
    title: id,
    cwd: 'C:/Users/me/repo',
    prompt: 'p',
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    status: 'queued',
    accountId: null,
    attempts: [],
    result: null,
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as unknown as CliMayteWorker
  workers.set(id, w)
  ids.push(id)
  return w
}

const tickAt = (at: number): void => {
  const due = [...workers.values()].filter((w) => ids.includes(w.id) && w.status === 'queued')
  scheduleDue(tickState(accounts, at), due)
}

beforeEach(() => {
  launched = []
  setLauncher((w, acct) => {
    w.status = 'running'
    launched.push(acct.id)
  })
  walls[dead.id] = {
    reason: 'signed out',
    until: now - 30 * 60_000,
    cred: credStamp(dead.configDir),
  }
})

afterEach(() => {
  setLauncher(null)
  for (const id of ids.splice(0)) workers.delete(id)
  delete walls[dead.id]
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('a dead login is not launched by the clock', () => {
  test('a lapsed signed-out wall keeps the account out while its credential file is unchanged', () => {
    mk('fresh')
    tickAt(now)
    expect(launched).toEqual([room.id])

    launched = []
    workers.get('fresh')!.status = 'queued'
    tickAt(now + 31 * 60_000)
    expect(launched).not.toContain(dead.id)
  })
})

describe('a task that bounced off a dead login', () => {
  test('starts on the account with room in the same tick, not held for another account reset', () => {
    room.weekPct = 70
    mk('bounced', {
      accountId: dead.id,
      attempts: [
        {
          account: dead,
          startedAt: now - 60_000,
          endedAt: now,
          outcome: 'auth',
          notice: 'Failed to authenticate. API Error: 401 OAuth access token has expired',
        },
      ] as any,
    })
    tickAt(now)
    expect(launched).toEqual([room.id])
    expect(workers.get('bounced')?.status).toBe('running')
  })
})
