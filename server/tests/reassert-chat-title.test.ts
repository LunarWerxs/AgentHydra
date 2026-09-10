// server/tests/reassert-chat-title.test.ts - the name a person confirmed one click before a move
// has to still be the chat's name after it.
//
// THE FAILURE THIS PINS (owner, 2026-09-09: "does the flipping thing seriously transfer the chats
// with the stupid name general coding session?"). A hot landing aims at a RUNNING target app, which
// is holding the record it just created in memory with the title unset, and re-saves that over our
// single disk write the first time the chat wakes. The file then reads a blank title, and the app
// renders a blank as "General coding session". Two watchers already existed for exactly this shape
// of loss - the permission stamp and the archive flag - and the TITLE, the one the owner actually
// looks at, had neither: `titleDurable: !running` reported the loss honestly and nothing acted on
// it, and the janitor that was meant to be the floor had had no production caller since 2026-08-29.
//
// The asymmetry with its two siblings is the whole design and is tested below: they drive one
// correct value home unconditionally, this one MUST NOT, because a title has a second legitimate
// author - the owner renaming the chat in the app while the watcher is still running.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reassertChatTitle } from '../src/session-launch'

function seed(
  prefix: string,
  sessionId: string,
  record: Record<string, unknown>,
): { profile: string; metaPath: string } {
  const profile = mkdtempSync(join(tmpdir(), prefix))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, `local_${sessionId}.json`)
  writeFileSync(metaPath, JSON.stringify(record))
  return { profile, metaPath }
}

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

test('the app blanks a moved chat to a generic name; the watcher puts the real one back', async () => {
  const sid = 'sess-title-1'
  const landed = { cliSessionId: sid, title: 'Ship the parser rewrite', titleSource: 'tool' }
  const { profile, metaPath } = seed('agenthydra-retitle-', sid, landed)
  let ticks = 0
  const restores = await reassertChatTitle(profile, sid, 'Ship the parser rewrite', {
    windowMs: 10_000,
    intervalMs: 1_000,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
      // Tick 2 is the app's first wake of the chat: the whole record rewritten from memory, where
      // the import handler never put a title. This is the exact byte-level shape measured on
      // 2026-08-26 (five imports all came back `title: undefined`).
      if (ticks === 2) writeFileSync(metaPath, JSON.stringify({ cliSessionId: sid }))
    },
  })
  expect(restores).toBe(1) // restored once, then left alone - no tug-of-war on a settled file
  expect(read(metaPath).title).toBe('Ship the parser rewrite')
  expect(read(metaPath).titleSource).toBe('tool')
  // Idempotence: a second watch over an already-correct file writes nothing at all.
  ticks = 0
  const again = await reassertChatTitle(profile, sid, 'Ship the parser rewrite', {
    windowMs: 3_000,
    intervalMs: 1_000,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
    },
  })
  expect(again).toBe(0)
})

test('the literal "General coding session" is treated as a blank, not as the name to keep', async () => {
  const sid = 'sess-title-generic'
  const { profile, metaPath } = seed('agenthydra-retitle-generic-', sid, {
    cliSessionId: sid,
    title: 'PyOverdrive batch 15',
  })
  let ticks = 0
  const restores = await reassertChatTitle(profile, sid, 'PyOverdrive batch 15', {
    windowMs: 10_000,
    intervalMs: 1_000,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
      // Not a blank this time: the app writes its own generic label. Same loss, different bytes -
      // and a watcher that only checked for emptiness would have walked straight past it.
      if (ticks === 2)
        writeFileSync(
          metaPath,
          JSON.stringify({ cliSessionId: sid, title: 'General coding session' }),
        )
    },
  })
  expect(restores).toBe(1)
  expect(read(metaPath).title).toBe('PyOverdrive batch 15')
})

test("⛔ it never overwrites a REAL name - the owner's rename during the window wins", async () => {
  const sid = 'sess-title-renamed'
  const { profile, metaPath } = seed('agenthydra-retitle-rename-', sid, {
    cliSessionId: sid,
    title: 'The name the move landed',
  })
  let ticks = 0
  const restores = await reassertChatTitle(profile, sid, 'The name the move landed', {
    windowMs: 10_000,
    intervalMs: 1_000,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
      // The owner renames the chat in the app two ticks in. This is the case that separates a
      // title from a permission mode: there is no single correct value to drive home, so a
      // watcher shaped like reassertChatAutomation would silently undo a person's own edit for
      // the rest of its ten-minute window.
      if (ticks === 2)
        writeFileSync(metaPath, JSON.stringify({ cliSessionId: sid, title: 'My hand-picked name' }))
    },
  })
  expect(restores).toBe(0)
  expect(read(metaPath).title).toBe('My hand-picked name')
})

test('a generic title is never written: the watcher refuses the job rather than doing harm', async () => {
  const sid = 'sess-title-refuse'
  const { profile, metaPath } = seed('agenthydra-retitle-refuse-', sid, { cliSessionId: sid })
  // Asked to defend a non-name, it declines outright - no walk, no write, no timer. Writing
  // "Untitled" over a blank would be this bug with extra steps.
  for (const bad of ['Untitled', 'General coding session', '   ', '[plumbing] seed']) {
    expect(await reassertChatTitle(profile, sid, bad, { windowMs: 5_000, intervalMs: 1_000 })).toBe(
      0,
    )
  }
  expect(read(metaPath).title).toBeUndefined()
})

test('bounded: a restore cap against a hostile flipper, a miss cap for a chat that never appears', async () => {
  const sid = 'sess-title-fight'
  const { profile, metaPath } = seed('agenthydra-retitle-bound-', sid, { cliSessionId: sid })
  let ticks = 0
  // The app "wins" every tick. The watcher restores maxRestores times and stands down long before
  // its window: a tug-of-war that reaches the cap is the app's to win, and the standing sweep
  // (title-sweep.ts) is the floor that picks it up afterwards.
  const restores = await reassertChatTitle(profile, sid, 'A real name', {
    windowMs: 600_000,
    intervalMs: 1_000,
    maxRestores: 3,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
      writeFileSync(metaPath, JSON.stringify({ cliSessionId: sid }))
    },
  })
  expect(restores).toBe(3)
  expect(ticks).toBe(3)
  // A landing whose record never appears: give up at the miss cap, not at the far window - there
  // is nothing to guard.
  let missTicks = 0
  const none = await reassertChatTitle(profile, 'sess-never-created', 'A real name', {
    windowMs: 600_000,
    intervalMs: 1_000,
    maxMisses: 5,
    now: () => missTicks * 1_000,
    sleep: async () => {
      missTicks++
    },
  })
  expect(none).toBe(0)
  expect(missTicks).toBe(5)
})
