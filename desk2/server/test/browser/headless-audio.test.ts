import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MuteBook,
  chatOfOwner,
  isSessionOwner,
  pageIsAudible,
  profileHoldsChats,
  profilesOf,
  userDataDirOf,
} from '../../src/browser/headless-audio'

const BROWSER = (pid: number, dir: string) => ({
  pid,
  ppid: 1,
  cmd: `chrome.exe --user-data-dir="${dir}" --remote-debugging-port=0`,
})
const AUDIO = (pid: number, parent: number) => ({
  pid,
  ppid: parent,
  cmd: `chrome.exe --type=utility --utility-sub-type=audio.mojom.AudioService --user-data-dir="C:/x"`,
})

describe('userDataDirOf', () => {
  test('reads a quoted and a bare profile folder', () => {
    expect(userDataDirOf('chrome.exe --user-data-dir="C:/Users/me/p one" --x')).toBe('C:/Users/me/p one')
    expect(userDataDirOf('chrome.exe --user-data-dir=C:/Users/me/p2 --x')).toBe('C:/Users/me/p2')
    expect(userDataDirOf('chrome.exe --type=gpu')).toBeNull()
  })
})

describe('profilesOf', () => {
  test('attributes an audio service to its browser profile through the parent pid', () => {
    const procs = [BROWSER(10, 'C:/profiles/a'), AUDIO(11, 10), BROWSER(20, 'C:/profiles/b')]
    const rows = [{ pid: 11, peak: 0.4, muted: false }]
    const out = profilesOf(rows, procs)
    expect(out).toEqual([{ dir: 'C:/profiles/a', browserPid: 10, sessionPids: [11], peak: 0.4 }])
  })

  test('a silent profile is still listed, with peak 0', () => {
    const out = profilesOf([], [BROWSER(10, 'C:/profiles/a'), AUDIO(11, 10)])
    expect(out[0]?.peak).toBe(0)
  })

  test('an audio service with no browser parent is ignored', () => {
    expect(profilesOf([{ pid: 11, peak: 0.9, muted: false }], [AUDIO(11, 999)])).toEqual([])
  })
})

describe('owners', () => {
  const chatOfSession = (s: string) => (s === 'sess-a' ? 'chat-1' : s === 'sess-w' ? 'chat-2' : null)

  test('mcp: and pid: owners are never a Desk chat', () => {
    expect(isSessionOwner('mcp:abc')).toBe(false)
    expect(isSessionOwner('pid:123')).toBe(false)
    expect(chatOfOwner('mcp:abc', chatOfSession)).toBeNull()
  })

  test('a session owner resolves to its chat, and an unknown or missing owner to nothing', () => {
    expect(chatOfOwner('sess-a', chatOfSession)).toBe('chat-1')
    expect(chatOfOwner('sess-unknown', chatOfSession)).toBeNull()
    expect(chatOfOwner(undefined, chatOfSession)).toBeNull()
  })

  test('a CliMayte worker session resolves to the parent chat the caller maps it to', () => {
    expect(chatOfOwner('sess-w', chatOfSession)).toBe('chat-2')
  })

  test('a profile is checked only when its ledger names a page of a chat being watched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap-'))
    try {
      writeFileSync(
        join(dir, '.connections-tabs.json'),
        JSON.stringify({ v: 1, tabs: { T1: { chat: 'sess-a', at: 1 }, T2: { chat: 'mcp:x', at: 2 } } }),
      )
      expect(profileHoldsChats(dir, new Set(['chat-1']), chatOfSession)).toBe(true)
      expect(profileHoldsChats(dir, new Set(['chat-2']), chatOfSession)).toBe(false)
      expect(profileHoldsChats(dir, new Set(), chatOfSession)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pageIsAudible', () => {
  test('a playing element or a running AudioContext is audible; neither is silent', () => {
    expect(pageIsAudible({ audible: 1, contexts: 0 })).toBe(true)
    expect(pageIsAudible({ audible: 0, contexts: 1 })).toBe(true)
    expect(pageIsAudible({ audible: 0, contexts: 0 })).toBe(false)
  })
})

describe('MuteBook', () => {
  test('hold records a thing once, and release returns only what that chat changed', () => {
    const book = new MuteBook()
    expect(book.hold('chat-1', 'page:T1')).toBe(true)
    expect(book.hold('chat-1', 'page:T1')).toBe(false)
    expect(book.hold('chat-1', 'session:11')).toBe(true)
    expect(book.hold('chat-2', 'page:T9')).toBe(true)

    expect(book.release('chat-1').sort()).toEqual(['page:T1', 'session:11'])
    expect(book.holds('chat-1')).toEqual([])
    expect(book.holds('chat-2')).toEqual(['page:T9'])
  })

  test('releasing a chat that held nothing returns nothing', () => {
    expect(new MuteBook().release('nobody')).toEqual([])
  })
})
