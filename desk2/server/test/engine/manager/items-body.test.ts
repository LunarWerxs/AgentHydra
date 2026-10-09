import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { ChatManager } from '../../../src/engine/chat-manager'
import { ChatStore } from '../../../src/engine/store'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ACCOUNT = { id: 'default', label: 'Default', configDir: null }
const text = (id: string, t: string): TranscriptItem => ({ kind: 'assistant_text', id, ts: 1, text: t })

function chat(id: string): ChatSummary {
  return {
    id,
    sessionId: 's-' + id,
    title: 'Chat ' + id,
    cwd: 'C:/Users/test/p',
    account: ACCOUNT,
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: false,
    status: 'closed',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 1,
    updatedAt: 2,
    costUsd: 0,
    contextPct: 0,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
  }
}

function boot(): { m: ChatManager; store: ChatStore } {
  const home = mkdtempSync(join(tmpdir(), 'desk-items-body-'))
  temps.push(home)
  const seed = new ChatStore(home, { debounceMs: 1 })
  seed.saveChats([chat('c1')])
  seed.flush()
  seed.appendItem('c1', text('a-1', 'one'))
  seed.appendItem('c1', text('a-2', 'two'))
  const bridge = fakeBridge({}).bridge
  const m = new ChatManager({
    home,
    claudeHome: home,
    emit: () => {},
    settings: () => ({ ...DEFAULT_SETTINGS }),
    bridge,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
    newChats: 'sdk',
  })
  managers.push(m)
  return { m, store: m.store }
}

test('a chat whose file has not changed is answered from the text kept, not read again', () => {
  const { m } = boot()
  const first = m.itemsBody('c1')
  expect(first.count).toBe(2)
  const load = spyOn(m.store, 'loadItems')
  const again = m.itemsBody('c1')
  expect(load).not.toHaveBeenCalled()
  expect(again.body).toBe(first.body)
  load.mockRestore()
})

test('an item appended to the chat shows in the next answer', () => {
  const { m, store } = boot()
  m.itemsBody('c1')
  store.appendItem('c1', text('a-3', 'three'))
  const next = m.itemsBody('c1')
  expect(next.count).toBe(3)
  expect(JSON.parse(next.body).map((i: TranscriptItem) => i.id)).toEqual(['a-1', 'a-2', 'a-3'])
})
