// The dead-owner tab sweep and the chat-end close: liveness rules, the last-page guard, and a real headless Chrome
// whose pages belong to a live chat, a dead owner and a deleted chat.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome, LIVE_CHROME_FLAGS, newPage, pageTabs } from '../../src/browser/cdp'
import { ownPage } from '../../src/browser/ledger'
import { readLedger } from '../../src/browser/ownership'
import { closeChatTabs, deadOwnerTargetIds, makeLiveness, ownerLive, profileFolders, sessionOwnerLiveness, sweepDeadOwnerTabs } from '../../src/browser/tab-sweep'

setDefaultTimeout(60_000)

const DEAD_PID = 2147483640

let base: string
let claudeRoot: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'tab-sweep-'))
  claudeRoot = join(base, 'claude')
  mkdirSync(join(claudeRoot, 'sessions'), { recursive: true })
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

describe('owner liveness', () => {
  test('a Desk chat or an active worker session is alive, anything else is not', () => {
    const desk = new Set(['desk-chat-session', 'worker-session'])
    expect(ownerLive('desk-chat-session', desk, [claudeRoot])).toBe(true)
    expect(ownerLive('worker-session', desk, [claudeRoot])).toBe(true)
    expect(ownerLive('deleted-chat-session', desk, [claudeRoot])).toBe(false)
  })

  test('a pid owner is alive while its process is', () => {
    expect(ownerLive(`pid:${process.pid}`, new Set())).toBe(true)
    expect(ownerLive(`pid:${DEAD_PID}`, new Set())).toBe(false)
  })

  test('an mcp owner is never judged dead here', () => {
    expect(ownerLive('mcp:some-server', new Set(), [claudeRoot])).toBe(null)
  })

  test('an unknown owner is alive only when a live pid file names its session', () => {
    const roots = [join(base, 'live-roots')]
    mkdirSync(join(roots[0]!, 'sessions'), { recursive: true })
    writeFileSync(join(roots[0]!, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: 'unknown-live', pid: process.pid }))
    writeFileSync(join(roots[0]!, 'sessions', `${DEAD_PID}.json`), JSON.stringify({ sessionId: 'unknown-dead-pid', pid: DEAD_PID }))
    expect(sessionOwnerLiveness('unknown-live', roots)).toBe(true)
    expect(sessionOwnerLiveness('unknown-dead-pid', roots)).toBe(false)
    expect(sessionOwnerLiveness('unknown-without-file', roots)).toBe(false)
    expect(sessionOwnerLiveness('unknown-live', [join(base, 'no-such-root')])).toBe(null)
    expect(ownerLive('unknown-live', new Set(), roots)).toBe(true)
  })

  test('the last open page of a browser is never picked, even when its owner is dead', () => {
    const dead = () => false
    const both = { tabs: { p1: { chat: 'dead' }, p2: { chat: 'dead' } }, pages: [{ targetId: 'p1' }, { targetId: 'p2' }] }
    expect(deadOwnerTargetIds(both, dead)).toEqual(['p1'])
    const one = { tabs: { p1: { chat: 'dead' } }, pages: [{ targetId: 'p1' }] }
    expect(deadOwnerTargetIds(one, dead)).toEqual([])
    const mixed = { tabs: { p1: { chat: 'dead' }, p2: { chat: 'live' } }, pages: [{ targetId: 'p1' }, { targetId: 'p2' }] }
    expect(deadOwnerTargetIds(mixed, (owner) => owner !== 'dead' ? true : false)).toEqual(['p1'])
  })
})

function announcedPort(file: string): number {
  try {
    const m = /^(\d+)\n/.exec(readFileSync(file, 'utf8'))
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

async function launchChrome(profile: string): Promise<{ proc: Bun.Subprocess; port: number }> {
  mkdirSync(profile, { recursive: true })
  const proc = Bun.spawn(
    [findChrome()!, `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check', ...LIVE_CHROME_FLAGS, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  const file = join(profile, 'DevToolsActivePort')
  const until = Date.now() + 20_000
  let port = announcedPort(file)
  while (!port) {
    if (Date.now() > until) {
      proc.kill()
      throw new Error('Chrome did not announce its debugging port')
    }
    await Bun.sleep(100)
    port = announcedPort(file)
  }
  return { proc, port }
}

describe('real headless Chrome', () => {
  let proc: Bun.Subprocess | null = null
  let root: string
  let profile: string
  let port: number
  let liveId: string
  let deadId: string
  let deletedId: string

  beforeAll(async () => {
    root = join(base, 'store')
    profile = join(root, 'ws', 'main', 'default')
    const launched = await launchChrome(profile)
    proc = launched.proc
    port = launched.port
    liveId = (await newPage(port, 'about:blank'))!.id
    deadId = (await newPage(port, 'about:blank'))!.id
    deletedId = (await newPage(port, 'about:blank'))!.id
    ownPage(profile, liveId, 'live-chat-session')
    ownPage(profile, deadId, 'dead-chat-session')
    ownPage(profile, deletedId, 'deleted-chat-session')
  })

  afterAll(async () => {
    proc?.kill()
    await proc?.exited
  })

  test('closing a deleted chat closes only its own page and drops its row', async () => {
    expect(await closeChatTabs(['deleted-chat-session'], root)).toBe(1)
    const ids = (await pageTabs(port)).map((t) => t.id)
    expect(ids).not.toContain(deletedId)
    expect(ids).toContain(liveId)
    expect(ids).toContain(deadId)
    expect([...readLedger(profile).keys()].sort()).toEqual([deadId, liveId].sort())
  })

  test('the sweep closes only the dead owner\'s page and drops only its row', async () => {
    const liveness = makeLiveness(new Set(['live-chat-session']), [claudeRoot])
    expect(await sweepDeadOwnerTabs(liveness, root)).toBe(1)
    const ids = (await pageTabs(port)).map((t) => t.id)
    expect(ids).not.toContain(deadId)
    expect(ids).toContain(liveId)
    expect([...readLedger(profile).keys()]).toEqual([liveId])
  })
})

describe('a bare profile folder directly under the store root', () => {
  let proc: Bun.Subprocess | null = null
  let root: string
  let profile: string
  let port: number
  let deadId: string
  let liveId: string

  beforeAll(async () => {
    root = join(base, 'bare-store')
    profile = join(root, 'bare-example')
    mkdirSync(join(root, 'ws'), { recursive: true })
    const launched = await launchChrome(profile)
    proc = launched.proc
    port = launched.port
    liveId = (await newPage(port, 'about:blank'))!.id
    deadId = (await newPage(port, 'about:blank'))!.id
    ownPage(profile, liveId, 'live-bare-session')
    ownPage(profile, deadId, 'dead-bare-session')
  })

  afterAll(async () => {
    proc?.kill()
    await proc?.exited
  })

  test('ws is never a profile, and a bare folder is', () => {
    expect(profileFolders(root)).toEqual([profile])
  })

  test('the sweep closes the dead owner\'s page in a bare profile and drops only its row', async () => {
    const liveness = makeLiveness(new Set(['live-bare-session']), [claudeRoot])
    expect(await sweepDeadOwnerTabs(liveness, root)).toBe(1)
    const ids = (await pageTabs(port)).map((t) => t.id)
    expect(ids).not.toContain(deadId)
    expect(ids).toContain(liveId)
    expect([...readLedger(profile).keys()]).toEqual([liveId])
  })
})
