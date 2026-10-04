import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { ChatStore } from '../../src/engine/store'

const temps: string[] = []
function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'desk-store-'))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function chat(id: string, over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    sessionId: 's-' + id,
    title: 'Chat ' + id,
    cwd: 'C:/Users/test/p',
    account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: true,
    status: 'working',
    activity: 'Bash: ls',
    turnStartedAt: 5,
    lastError: null,
    limitResetsAt: null,
    unread: true,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 1,
    updatedAt: 2,
    costUsd: 0.5,
    contextPct: 12,
    pendingCount: 1,
    queuedCount: 2,
    climayteActive: 3,
    ...over,
  }
}

const text = (id: string, t: string): TranscriptItem => ({ kind: 'assistant_text', id, ts: 1, text: t })

describe('ChatStore chats.json', () => {
  test('saves without volatile fields and loads every chat closed', () => {
    const h = home()
    const store = new ChatStore(h, { debounceMs: 10_000 })
    store.saveChats([chat('a'), chat('b')])
    expect(existsSync(join(h, 'chats.json'))).toBe(false) // debounced
    store.flush()
    const raw = JSON.parse(readFileSync(join(h, 'chats.json'), 'utf8'))
    expect(raw[0].status).toBeUndefined()
    expect(raw[0].activity).toBeUndefined()
    expect(raw[0].pendingCount).toBeUndefined()
    const loaded = new ChatStore(h).loadChats()
    expect(loaded.map((c) => c.id)).toEqual(['a', 'b'])
    expect(loaded[0]).toMatchObject({ status: 'closed', activity: null, turnStartedAt: null, pendingCount: 0, queuedCount: 0, climayteActive: 0, unread: true, costUsd: 0.5, accountAuto: true })
    expect(readdirSync(h).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('a chat saved before accountAuto existed loads as a named account', () => {
    const h = home()
    const { accountAuto: _a, ...old } = chat('a')
    writeFileSync(join(h, 'chats.json'), JSON.stringify([old]))
    expect(new ChatStore(h).loadChats()[0]).toMatchObject({ id: 'a', accountAuto: false })
  })

  test('debounce writes the latest list once', async () => {
    const h = home()
    const store = new ChatStore(h, { debounceMs: 5 })
    store.saveChats([chat('a')])
    store.saveChats([chat('a'), chat('b')])
    await Bun.sleep(30)
    expect(new ChatStore(h).loadChats().map((c) => c.id)).toEqual(['a', 'b'])
  })

  test('missing or corrupt chats.json is an empty list', () => {
    const h = home()
    expect(new ChatStore(h).loadChats()).toEqual([])
    writeFileSync(join(h, 'chats.json'), '{not json')
    expect(new ChatStore(h).loadChats()).toEqual([])
  })
})

describe('ChatStore items', () => {
  test('last line per id wins, first-seen order kept', () => {
    const store = new ChatStore(home())
    store.appendItem('c1', text('x', 'one'))
    store.appendItem('c1', text('y', 'two'))
    store.appendItem('c1', text('x', 'one, final'))
    expect(store.loadItems('c1').map((i) => [i.id, (i as { text: string }).text])).toEqual([
      ['x', 'one, final'],
      ['y', 'two'],
    ])
    expect(store.loadItems('nothing')).toEqual([])
  })

  test('a torn last line is skipped, and the next append starts on its own line', () => {
    const h = home()
    const store = new ChatStore(h)
    store.appendItem('c2', text('a', 'ok'))
    appendFileSync(join(h, 'chats', 'c2.jsonl'), '{"kind":"assistant_text","id":"b","te') // crash mid-write
    const again = new ChatStore(h)
    expect(again.loadItems('c2').map((i) => i.id)).toEqual(['a'])
    again.appendItem('c2', text('c', 'after'))
    expect(again.loadItems('c2').map((i) => i.id)).toEqual(['a', 'c'])
  })

  test('deleteChat removes the transcript', () => {
    const h = home()
    const store = new ChatStore(h)
    store.appendItem('c3', text('a', 'ok'))
    store.deleteChat('c3')
    expect(existsSync(join(h, 'chats', 'c3.jsonl'))).toBe(false)
    expect(store.loadItems('c3')).toEqual([])
    store.appendItem('c3', text('b', 'new'))
    expect(store.loadItems('c3').map((i) => i.id)).toEqual(['b'])
  })

  test('chat ids cannot escape the folder', () => {
    expect(() => new ChatStore(home()).appendItem('../x', text('a', 'x'))).toThrow()
  })
})
