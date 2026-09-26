// A moved chat's old copy that its RUNNING app would not archive is flagged once that app is
// closed, never under it (move-retire-on-close.ts; review, 2026-09-26). A flag under a running app
// hid nothing and made the next move from that account answer "No chats to move" for a chat the
// owner was looking at. Every route is faked; nothing here touches a real profile.

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dropRetireOnClose,
  queueRetireOnClose,
  RETIRE_MAX_AGE_MS,
  type RetireDeps,
  type RetireEntry,
  type RetireStore,
  retireStoreAt,
  runRetireOnCloseOnce,
  setRetireStoreForTests,
} from '../src/move-retire-on-close'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const A = 'C:\\instances\\a'
const SID = 'aaaaaaaa-1111-2222-3333-444444444444'

function memStore(entries: RetireEntry[]): RetireStore & { entries: RetireEntry[] } {
  const s = {
    entries,
    load: () => [...s.entries],
    save: (next: RetireEntry[]) => {
      s.entries = next
    },
  }
  return s
}

const entry = (over: Partial<RetireEntry> = {}): RetireEntry => ({
  profile: A,
  sessionId: SID,
  queuedAt: new Date(NOW - 60_000).toISOString(),
  ...over,
})

function harness(opts: {
  entries?: RetireEntry[]
  running?: string[]
  archived?: boolean | null
  liveElsewhere?: boolean
  flag?: () => Promise<boolean>
}) {
  const store = memStore(opts.entries ?? [entry()])
  const flagged: string[] = []
  const deps: RetireDeps = {
    store,
    listRunningDirs: async () => opts.running ?? [],
    archivedIn: () => (opts.archived === undefined ? false : opts.archived),
    liveElsewhere: () => opts.liveElsewhere ?? true,
    flag: async (id, profile) => {
      flagged.push(`${profile}:${id}`)
      return opts.flag ? opts.flag() : true
    },
    now: () => NOW,
  }
  return { deps, store, flagged }
}

test('an app still RUNNING keeps its entry and gets no flag', async () => {
  const { deps, store, flagged } = harness({ running: ['C:/instances/a/'] })
  expect(await runRetireOnCloseOnce(deps)).toBe(0)
  expect(flagged).toEqual([])
  expect(store.entries).toHaveLength(1)
})

test('once the app is CLOSED, the old copy is flagged and the entry is done', async () => {
  const { deps, store, flagged } = harness({})
  expect(await runRetireOnCloseOnce(deps)).toBe(1)
  expect(flagged).toEqual([`${A}:${SID}`])
  expect(store.entries).toEqual([])
})

test('a record already archived is dropped without a write', async () => {
  const { deps, store, flagged } = harness({ archived: true })
  await runRetireOnCloseOnce(deps)
  expect(flagged).toEqual([])
  expect(store.entries).toEqual([])
})

test('a record not found, or unreadable, is not an answer: the entry waits', async () => {
  const missing = harness({ archived: null })
  await runRetireOnCloseOnce(missing.deps)
  expect(missing.flagged).toEqual([])
  expect(missing.store.entries).toHaveLength(1)
  const unreadable = harness({})
  unreadable.deps.liveElsewhere = () => {
    throw new Error('half-written record')
  }
  await runRetireOnCloseOnce(unreadable.deps)
  expect(unreadable.flagged).toEqual([])
  expect(unreadable.store.entries).toHaveLength(1)
})

test('a FAILED process scan is not "closed": the pass writes nothing and keeps every entry', async () => {
  // listInstances would have answered "nothing running" here (review, 2026-09-26).
  const { deps, store, flagged } = harness({})
  deps.listRunningDirs = async () => {
    throw new Error('could not read the Claude processes: CIM timed out')
  }
  expect(await runRetireOnCloseOnce(deps)).toBe(0)
  expect(flagged).toEqual([])
  expect(store.entries).toHaveLength(1)
})

test('a pass for one profile (before AgentHydra opens it) leaves the others alone', async () => {
  const other = entry({ profile: 'C:\\instances\\b' })
  const { deps, store, flagged } = harness({ entries: [entry(), other] })
  expect(await runRetireOnCloseOnce(deps, { profile: 'c:/instances/a' })).toBe(1)
  expect(flagged).toEqual([`${A}:${SID}`])
  expect(store.entries).toEqual([other])
})

test('never the only visible copy: no other account shows it unarchived -> dropped, not flagged', async () => {
  const { deps, store, flagged } = harness({ liveElsewhere: false })
  await runRetireOnCloseOnce(deps)
  expect(flagged).toEqual([])
  expect(store.entries).toEqual([])
})

test('an entry older than the cap is dropped without a write', async () => {
  const old = entry({ queuedAt: new Date(NOW - RETIRE_MAX_AGE_MS - 1000).toISOString() })
  const { deps, store, flagged } = harness({ entries: [old] })
  await runRetireOnCloseOnce(deps)
  expect(flagged).toEqual([])
  expect(store.entries).toEqual([])
})

test('a move back onto that account during the pass wins: the dropped entry is not flagged', async () => {
  const { deps, store, flagged } = harness({})
  deps.liveElsewhere = () => {
    store.entries = [] // /migrate landed it on A again and dropped the entry
    return true
  }
  await runRetireOnCloseOnce(deps)
  expect(flagged).toEqual([])
})

test('a flag that throws keeps the entry for the next tick', async () => {
  const { deps, store } = harness({
    flag: async () => {
      throw new Error('store contended')
    },
  })
  expect(await runRetireOnCloseOnce(deps)).toBe(0)
  expect(store.entries).toHaveLength(1)
})

// --- the queue file itself ------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), 'ah-retire-'))
afterAll(() => {
  setRetireStoreForTests(retireStoreAt(join(ROOT, 'unused.json')))
  rmSync(ROOT, { recursive: true, force: true })
})

test('queue and drop: one entry per chat and profile, whatever the path spelling', () => {
  const file = retireStoreAt(join(ROOT, 'q.json'))
  setRetireStoreForTests(file)
  queueRetireOnClose('C:\\instances\\a', SID, NOW)
  queueRetireOnClose('c:/instances/a/', SID, NOW + 1000)
  expect(file.load()).toHaveLength(1)
  expect(file.load()[0]?.queuedAt).toBe(new Date(NOW + 1000).toISOString())
  expect(dropRetireOnClose('C:/Instances/A', 'other-id')).toBe(false)
  expect(dropRetireOnClose('C:/Instances/A', SID)).toBe(true)
  expect(file.load()).toEqual([])
})

test('an unreadable queue file reads as empty instead of throwing', () => {
  const bad = join(ROOT, 'bad.json')
  writeFileSync(bad, '{not json')
  expect(retireStoreAt(bad).load()).toEqual([])
})
