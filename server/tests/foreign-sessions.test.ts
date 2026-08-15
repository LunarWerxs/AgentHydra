// server/tests/foreign-sessions.test.ts — the fourth reader (server/src/foreign-sessions.ts).
//
// Five stores, one adapter each, built against real files on a real machine. What is worth pinning
// is not the happy path but the two promises the module makes: a store whose layout has moved on
// contributes NOTHING rather than throwing, and no adapter ever invents a token count, because none
// of these tools records one.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listForeignSessions,
  listForeignSessionsAsync,
  readForeignSession,
} from '../src/foreign-sessions'

const root = mkdtempSync(join(tmpdir(), 'agenthydra-foreign-'))
const write = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

describe('Grok', () => {
  const store = join(root, 'grok')
  const dir = join(store, '019f0672-8107-7070-b2e9-4f2e909c3421')
  write(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id: '019f0672', cwd: 'D:\\Projects\\Thing' },
      session_summary: 'Comprehensive Analysis of the Documentation',
      created_at: '2026-06-27T00:19:55.279871Z',
      updated_at: '2026-06-27T00:21:55.595173800Z',
    }),
  )
  write(
    join(dir, 'chat_history.jsonl'),
    [
      JSON.stringify({ type: 'system', content: 'You are Grok. (a very long system prompt)' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'read the docs' }] }),
      JSON.stringify({
        type: 'assistant',
        content: '',
        tool_calls: [{ name: 'list_dir' }],
        model_id: 'grok-build',
      }),
      JSON.stringify({ type: 'assistant', content: 'Here is what I found.' }),
    ].join('\n'),
  )

  test('the generated summary becomes the title, with the real timestamps', () => {
    const [s] = listForeignSessions('grok', store)
    expect(s?.title).toBe('Comprehensive Analysis of the Documentation')
    expect(s?.cwd).toBe('D:\\Projects\\Thing')
    expect(s?.created_at).toBe(Date.parse('2026-06-27T00:19:55.279871Z'))
  })

  test('the system prompt is not part of the conversation', () => {
    // It is machinery, and on a real Grok session it is thousands of words of it.
    const events = readForeignSession('grok', join(dir, 'chat_history.jsonl'))
    expect(events.some((e) => e.text.includes('You are Grok'))).toBe(false)
    expect(events.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual([
      'read the docs',
      'Here is what I found.',
    ])
  })

  test('tool calls are kept as tool events, named', () => {
    const events = readForeignSession('grok', join(dir, 'chat_history.jsonl'))
    expect(events.find((e) => e.kind === 'tool_use')?.tool_name).toBe('list_dir')
  })

  test('a directory with no chat history is not a session', () => {
    mkdirSync(join(store, 'empty-one'), { recursive: true })
    expect(listForeignSessions('grok', store)).toHaveLength(1)
  })
})

describe('Kimi', () => {
  const store = join(root, 'kimi')
  const dir = join(store, 'wd_thing_30075acadcfb', 'session_1375fbfe-ef30-47e3')
  write(
    join(dir, 'state.json'),
    JSON.stringify({
      createdAt: '2026-06-26T23:34:13.578Z',
      updatedAt: '2026-06-26T23:35:00.000Z',
      title: 'Say hello and name your model',
      agents: { main: { cwd: 'D:\\Projects\\Thing' } },
    }),
  )
  write(
    join(dir, 'agents', 'main', 'wire.jsonl'),
    [
      JSON.stringify({ role: 'user', content: 'hello' }),
      JSON.stringify({ role: 'assistant', content: [{ text: 'Hi, I am Kimi.' }] }),
    ].join('\n'),
  )

  test('the session is found two directories deep, keyed on its own id', () => {
    const [s] = listForeignSessions('kimi', store)
    expect(s?.session_id).toBe('1375fbfe-ef30-47e3')
    expect(s?.title).toBe('Say hello and name your model')
  })

  test('only the MAIN agent is the conversation', () => {
    // The numbered agents are its delegated workers; listing them would show one chat many times.
    const other = join(store, 'wd_thing_30075acadcfb', 'session_no_main')
    write(join(other, 'agents', 'agent-0', 'wire.jsonl'), '{}')
    expect(listForeignSessions('kimi', store)).toHaveLength(1)
  })

  test('both content shapes read', () => {
    const events = readForeignSession('kimi', join(dir, 'agents', 'main', 'wire.jsonl'))
    expect(events.map((e) => e.text)).toEqual(['hello', 'Hi, I am Kimi.'])
  })
})

describe('VS Code Copilot', () => {
  const store = join(root, 'vscode')
  const chats = join(store, 'workspaceStorage', '01514c0831321275', 'chatSessions')
  write(
    join(chats, '8e4bc3b4.json'),
    JSON.stringify({
      sessionId: '8e4bc3b4',
      creationDate: 1749765800000,
      lastMessageDate: 1749765900000,
      requests: [
        {
          timestamp: 1749765802920,
          message: { text: 'Read through my code and suggest cleanups' },
          response: [
            {
              kind: 'toolInvocationSerialized',
              pastTenseMessage: { value: 'Searched text for `ics`, 10 results' },
            },
            { value: { value: 'Here are three things worth changing.' } },
          ],
        },
      ],
    }),
  )

  test('the first question becomes the title, since Copilot stores none', () => {
    const [s] = listForeignSessions('vscode-copilot', store)
    expect(s?.title).toBe('Read through my code and suggest cleanups')
    expect(s?.last_activity_at).toBe(1749765900000)
  })

  test('the workspace hash is the project key, not a guessed folder name', () => {
    // VS Code identifies a workspace by an opaque hash; inventing a path from it would be a guess
    // the reader cannot check.
    expect(listForeignSessions('vscode-copilot', store)[0]?.project).toBe('01514c0831321275')
  })

  test('a response is read through its tagged parts', () => {
    const events = readForeignSession('vscode-copilot', join(chats, '8e4bc3b4.json'))
    expect(events[0]).toMatchObject({ role: 'user', kind: 'text' })
    expect(events[1]).toMatchObject({ role: 'assistant', kind: 'tool_use' })
    expect(events[2]?.text).toBe('Here are three things worth changing.')
  })

  test('a chat with no requests is not a session', () => {
    write(join(chats, 'empty.json'), JSON.stringify({ sessionId: 'x', requests: [] }))
    expect(listForeignSessions('vscode-copilot', store)).toHaveLength(1)
  })
})

// Listing this store means JSON.parse-ing every chat document, because the title and timestamps
// live nowhere else — there is no index file to read instead. That measured 5.2 SECONDS for 355
// chats and was the largest single slice of a whole-store sweep, which runs on a timer. So the
// listing is remembered per file and re-read only when the bytes move. These tests pin the three
// ways that can go wrong: serving a stale answer, evicting a sibling store, and keeping a ghost.
describe('VS Code Copilot listing cache', () => {
  const store = join(root, 'vscode-cached')
  const chats = join(store, 'workspaceStorage', 'ws-one', 'chatSessions')
  const chat = join(chats, 'a.json')
  const doc = (question: string) =>
    JSON.stringify({
      sessionId: 'a',
      creationDate: 1749765800000,
      lastMessageDate: 1749765900000,
      requests: [{ timestamp: 1749765802920, message: { text: question }, response: [] }],
    })

  test('an untouched chat is served from the last parse', () => {
    // Pinned to an exact instant BEFORE the listing that fills the cache, and set again from the
    // same value afterwards. Restoring a previously-read mtime instead would not work: statSync
    // reports fractional milliseconds that utimesSync cannot write back, so the file would look
    // edited for a reason that has nothing to do with the cache.
    const pinned = new Date(1749765900000)
    write(chat, doc('first question here'))
    utimesSync(chat, pinned, pinned)
    expect(listForeignSessions('vscode-copilot', store)[0]?.title).toBe('first question here')

    // A DIFFERENT question of exactly the same length, at exactly the same mtime. Nothing the
    // filesystem reports has changed — so the cache must answer, and the proof that it did is
    // that the superseded title is the one that comes back.
    const before = statSync(chat)
    writeFileSync(chat, doc('SECOND question her'))
    utimesSync(chat, pinned, pinned)
    expect(statSync(chat).size).toBe(before.size)
    expect(statSync(chat).mtimeMs).toBe(before.mtimeMs)

    expect(listForeignSessions('vscode-copilot', store)[0]?.title).toBe('first question here')
  })

  test('a real edit is picked up', () => {
    writeFileSync(chat, doc('a properly different question entirely'))
    expect(listForeignSessions('vscode-copilot', store)[0]?.title).toBe(
      'a properly different question entirely',
    )
  })

  test('listing another VS Code flavour does not evict this store', () => {
    // ONE cache serves every flavour on the machine — Code, Code - Insiders, VSCodium — and each is
    // listed by its own call with its own root. A sweep of one is no evidence at all about
    // another's files, so the prune has to be scoped to the root being listed. Unscoped, every
    // sweep would throw away the other two stores and re-parse them from nothing, which is the
    // whole cost this cache exists to avoid.
    const other = join(root, 'vscode-insiders')
    write(join(other, 'workspaceStorage', 'ws-two', 'chatSessions', 'b.json'), doc('over here'))
    expect(listForeignSessions('vscode-copilot', other)).toHaveLength(1)

    expect(listForeignSessions('vscode-copilot', store)[0]?.title).toBe(
      'a properly different question entirely',
    )
  })

  test('a deleted chat leaves the listing', () => {
    rmSync(chat)
    expect(listForeignSessions('vscode-copilot', store)).toEqual([])
  })
})

// The sync and async listings drain ONE generator, and that generator emits a placeholder for every
// file it looks at rather than only for the ones that become sessions — otherwise the async drain,
// which spends its yields per file examined, would run an unbroken block through any stretch of
// empty or unreadable chats and freeze the daemon exactly as it did before it was made async. The
// placeholders must never reach a caller, and the two listings must never disagree.
describe('VS Code Copilot sync and async listings agree', () => {
  const store = join(root, 'vscode-async')
  const chats = join(store, 'workspaceStorage', 'ws-mixed', 'chatSessions')
  const real = (id: string, question: string) =>
    JSON.stringify({
      sessionId: id,
      creationDate: 1749765800000,
      lastMessageDate: 1749765900000,
      requests: [{ timestamp: 1749765802920, message: { text: question }, response: [] }],
    })

  // Deliberately mostly junk: empty chats, an unparseable one, two real ones. Every junk file is a
  // file the generator examines and discards, which is the case the placeholder exists for.
  write(join(chats, '01-real.json'), real('01', 'the first real question'))
  for (let i = 2; i <= 40; i++)
    write(join(chats, `${String(i).padStart(2, '0')}-empty.json`), JSON.stringify({ requests: [] }))
  write(join(chats, '41-broken.json'), '{ this is not json')
  write(join(chats, '42-real.json'), real('42', 'the second real question'))

  test('both return the same real sessions, and no placeholders escape', async () => {
    const sync = listForeignSessions('vscode-copilot', store)
    const async_ = await listForeignSessionsAsync('vscode-copilot', store)

    expect(sync.map((s) => s.session_id).sort()).toEqual(['01', '42'])
    expect(async_.map((s) => s.session_id).sort()).toEqual(['01', '42'])
    // A placeholder that leaked would arrive as a null entry, or as a row with no id.
    expect(async_.every((s) => s && typeof s.session_id === 'string' && s.session_id)).toBe(true)
    expect(async_.map((s) => s.title).sort()).toEqual(sync.map((s) => s.title).sort())
  })

  test('the async listing survives a store that yields nothing but junk', async () => {
    const junk = join(root, 'vscode-junk')
    const only = join(junk, 'workspaceStorage', 'ws-junk', 'chatSessions')
    for (let i = 0; i < 40; i++) write(join(only, `${i}.json`), JSON.stringify({ requests: [] }))
    expect(await listForeignSessionsAsync('vscode-copilot', junk)).toEqual([])
  })
})

describe('Copilot CLI', () => {
  const store = join(root, 'copilot')
  const dir = join(store, 'session-state', 'd0ffaae4')
  write(
    join(dir, 'workspace.yaml'),
    [
      'id: d0ffaae4',
      'cwd: D:\\Projects\\Thing',
      'created_at: 2026-04-15T01:37:04.760Z',
      'updated_at: 2026-04-15T01:38:00.000Z',
      'repository: Owner/thing',
      'branch: main',
    ].join('\n'),
  )

  test('the repository and branch make a title, because there is no conversation to take one from', () => {
    const [s] = listForeignSessions('copilot', store)
    expect(s?.title).toBe('Owner/thing (main)')
    expect(s?.cwd).toBe('D:\\Projects\\Thing')
    expect(s?.created_at).toBe(Date.parse('2026-04-15T01:37:04.760Z'))
  })
})

describe('every adapter fails closed', () => {
  test('a root that does not exist yields no sessions and does not throw', () => {
    for (const tool of ['grok', 'kimi', 'vscode-copilot', 'copilot', 'zed'])
      expect(listForeignSessions(tool, join(root, 'nope'))).toEqual([])
  })

  test('a tool with no adapter reads as empty rather than as an error', () => {
    expect(listForeignSessions('not-a-tool', root)).toEqual([])
    expect(readForeignSession('not-a-tool', join(root, 'x'))).toEqual([])
  })

  test('malformed files are skipped, not fatal', () => {
    const store = join(root, 'broken')
    write(join(store, 'sess', 'summary.json'), '{not json')
    write(join(store, 'sess', 'chat_history.jsonl'), 'not\njson\nat\nall')
    const [s] = listForeignSessions('grok', store)
    // Still listed — the conversation file exists — but with the fallback title.
    expect(s?.title).toBe('Grok session')
    expect(readForeignSession('grok', join(store, 'sess', 'chat_history.jsonl'))).toEqual([])
  })
})
