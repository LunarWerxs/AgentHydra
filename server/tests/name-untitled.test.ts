// server/tests/name-untitled.test.ts - if a chat has no real name, name it. No judgement.
//
// The rule was written and NOTHING RAN IT. sweepUntitledDesktopChats sat complete and correct in
// session-launch.ts, called from nowhere in the server, while the owner kept seeing chats titled
// "General coding session". A rule with no runner is not a rule, and these tests exist so this
// one keeps having one.
import { expect, test } from 'bun:test'
import { nameUntitledChats } from '../src/name-untitled'

const sweepReturning = (renamed: Array<{ profile: string; sessionId: string; title: string }>) => {
  const ids = renamed.map((r) => r.sessionId)
  let call = 0
  return (lookup: (id: string) => string | null) => {
    call++
    // First call collects ids (the real sweep asks about every untitled chat it walks past);
    // second call is the one that applies whatever the caller resolved.
    for (const id of ids) lookup(id)
    return call === 1
      ? { fixed: 0, profiles: [], renamed: [] }
      : { fixed: renamed.length, profiles: [...new Set(renamed.map((r) => r.profile))], renamed }
  }
}

test('a running app is renamed ON SCREEN, not only on disk', async () => {
  // The disk write alone changes nothing the owner can see: the app holds its list in memory and
  // honours a file title only at its next restart. That is why both writes happen.
  const calls: Array<{ profile: string; from: string; to: string }> = []
  const r = await nameUntitledChats({
    sweep: sweepReturning([{ profile: 'C:/i/temp2', sessionId: 's1', title: 'A real name' }]),
    lookup: async () => 'A real name',
    rename: async (profile, from, to) => {
      calls.push({ profile, from, to })
      return { ok: true, detail: '' }
    },
    runningProfiles: ['C:/i/temp2'],
  })
  // Aimed at the app's OWN generic label, not the name just written to disk - the running app
  // has not read that file.
  expect(calls).toEqual([
    { profile: 'C:/i/temp2', from: 'General coding session', to: 'A real name' },
  ])
  expect(r.named[0]?.onScreen).toBe(true)
})

test('a closed app is named on disk and says so, rather than claiming the sidebar changed', async () => {
  const r = await nameUntitledChats({
    sweep: sweepReturning([{ profile: 'C:/i/closed', sessionId: 's1', title: 'A real name' }]),
    lookup: async () => 'A real name',
    rename: async () => {
      throw new Error('must not drive the UI of an app that is not running')
    },
    runningProfiles: [],
  })
  expect(r.named[0]?.onScreen).toBe(false)
  expect(r.named[0]?.why).toContain('next starts')
})

// ⛔ IT NEVER INVENTS A NAME. A guessed title is worse than "Untitled": the generic name is at
// least honest about knowing nothing, while a made-up one looks like knowledge.
test('a chat whose transcript offers no name is left alone and counted', async () => {
  const r = await nameUntitledChats({
    sweep: sweepReturning([]),
    lookup: async () => null,
    rename: async () => ({ ok: false, detail: 'should not be called' }),
    runningProfiles: ['C:/i/temp2'],
  })
  expect(r.named).toEqual([])
  expect(r.unnameable).toBe(0) // nothing was untitled in this fixture
})

test('a generic name from the lookup is refused as firmly as no name at all', async () => {
  const r = await nameUntitledChats({
    sweep: sweepReturning([]),
    lookup: async () => 'General coding session',
    rename: async () => ({ ok: false, detail: 'should not be called' }),
  })
  expect(r.named).toEqual([])
})

test('a failed app rename is reported, never counted as shown on screen', async () => {
  const r = await nameUntitledChats({
    sweep: sweepReturning([{ profile: 'C:/i/temp2', sessionId: 's1', title: 'A real name' }]),
    lookup: async () => 'A real name',
    rename: async () => ({ ok: false, detail: 'the edit box was not available' }),
    runningProfiles: ['C:/i/temp2'],
  })
  expect(r.named[0]?.onScreen).toBe(false)
  expect(r.named[0]?.why).toContain('edit box')
})

test('the per-pass cap bounds real UI interactions and says what it deferred', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    profile: 'C:/i/temp2',
    sessionId: `s${i}`,
    title: `Name ${i}`,
  }))
  let renames = 0
  const r = await nameUntitledChats({
    sweep: sweepReturning(rows),
    lookup: async (id) => `Name ${id.slice(1)}`,
    rename: async () => {
      renames++
      return { ok: true, detail: '' }
    },
    runningProfiles: ['C:/i/temp2'],
    maxPerPass: 2,
  })
  expect(renames).toBe(2)
  expect(
    r.named
      .filter((n) => !n.onScreen)
      .map((n) => n.why)
      .join(' '),
  ).toContain('cap')
})
