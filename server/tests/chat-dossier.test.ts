// The dossier's one job is joining the stores by ANY id a chat has ever had. The fixture
// pins the shape that made the 2026-08-28 diagnosis slow: a chat that rolled through prior
// cliSessionIds, where a mark names a PRIOR id and the file is addressed by a third.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatDossier, chatMatches, collectChats, lineageIdsOf } from '../src/chat-dossier'

function fixtureRoot(): { dir: string; label: string } {
  const dir = join(tmpdir(), `dossier-fixture-${Math.random().toString(36).slice(2)}`)
  const store = join(dir, 'claude-code-sessions', 'org', 'user')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, 'local_chat-one.json'),
    JSON.stringify({
      sessionId: 'local_chat-one',
      cliSessionId: 'current-id',
      priorCliSessionIds: ['prior-id-a', 'prior-id-b'],
      title: 'Rolling thread',
      cwd: 'D:\\somewhere',
      createdAt: 1000,
      lastActivityAt: 2000,
      isArchived: true,
      permissionMode: 'bypassPermissions',
    }),
  )
  writeFileSync(
    join(store, 'local_chat-two.json'),
    JSON.stringify({
      sessionId: 'local_chat-two',
      cliSessionId: 'other-id',
      title: 'Unrelated work',
      isArchived: false,
    }),
  )
  return { dir, label: 'fixture' }
}

describe('chat-dossier', () => {
  const root = fixtureRoot()

  test('collectChats reads lineage, archive flag and timestamps off disk', () => {
    const chats = collectChats([root])
    expect(chats.length).toBe(2)
    const one = chats.find((c) => c.title === 'Rolling thread')
    expect(one).toBeDefined()
    expect(one?.archived).toBe(true)
    expect(one?.priorCliSessionIds).toEqual(['prior-id-a', 'prior-id-b'])
    expect(one?.lastActivityAt).toBe(new Date(2000).toISOString())
  })

  test('a chat answers to its title, its current id, any PRIOR id, and its filename id', () => {
    const one = collectChats([root]).find((c) => c.title === 'Rolling thread')
    if (!one) throw new Error('fixture missing')
    expect(lineageIdsOf(one).sort()).toEqual(['chat-one', 'current-id', 'prior-id-a', 'prior-id-b'])
    for (const q of ['rolling', 'current-id', 'prior-id-b', 'chat-one', 'PRIOR-ID-A'])
      expect(chatMatches(one, q)).toBe(true)
    expect(chatMatches(one, 'other-id')).toBe(false)
  })

  test('the joins run on the WHOLE lineage, not just the current id', () => {
    const askedWith: string[][] = []
    const { matches } = chatDossier('prior-id-a', {
      roots: [root],
      markFor: (ids) => {
        askedWith.push(ids)
        return { done: true, updatedAt: 'ts' }
      },
      liveFor: () => null,
    })
    expect(matches.length).toBe(1)
    expect(matches[0]?.doneMark?.done).toBe(true)
    // The mark join was handed every id the chat ever had — the whole point of the module.
    expect(askedWith[0]?.sort()).toEqual(['chat-one', 'current-id', 'prior-id-a', 'prior-id-b'])
  })

  test('a blank-ish query still behaves: no match means an empty list, never a throw', () => {
    const { matches } = chatDossier('zzz-not-a-chat', { roots: [root] })
    expect(matches).toEqual([])
  })
})
