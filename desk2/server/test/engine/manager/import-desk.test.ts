// Hydra Desk's own chats copied into Desk 2 (POST /api/chats/import-desk): every chat not here yet, as saved there,
// with its Desk file and the pictures it names; a chat already here is left alone, a second import adds nothing.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

const PICTURE = `${'ab'.repeat(32)}.png`

/** A chat as Hydra Desk saves it in chats.json. */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sessionId: `session-${id}`,
  title: `Example chat ${id}`,
  cwd: 'C:/Users/me/project',
  account: { id: 'acct-1', label: '#1 example (Pro)', configDir: 'C:/Users/me/.claude-1', number: 1 },
  model: 'claude-opus-5-5',
  effort: 'high',
  permissionMode: 'bypassPermissions',
  delegateToCliMayte: true,
  lastError: null,
  unread: false,
  pinned: false,
  archived: false,
  createdAt: 1_000,
  updatedAt: 2_000,
  costUsd: 0,
  contextPct: 0,
  accountAuto: false,
  group: null,
  forkedFrom: null,
  ...over,
})

function boot(home: string) {
  process.env.HYDRA_DESK_HOME = home
  const m = new ChatManager({
    home,
    claudeHome: home,
    emit: () => {},
    settings: () => ({ ...DEFAULT_SETTINGS }),
    bridge: fakeBridge().bridge,
    queryImpl: fakeQueries().queryImpl,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
    newChats: 'sdk',
  })
  managers.push(m)
  return m
}

test("Hydra Desk's chats come over as saved there, with their Desk files and pictures; ones already here stay as they are", async () => {
  const desk = temp('desk-one-')
  mkdirSync(join(desk, 'chats'))
  mkdirSync(join(desk, 'media'))
  writeFileSync(
    join(desk, 'chats.json'),
    JSON.stringify([
      row('worker-chat', { workerId: 'w-1', pastSessions: ['older-session'] }),
      row('archived-chat', { archived: true, ranIn: 'C:/Users/me/.claude-2' }),
      row('both-chat', { title: 'Desk title' }),
    ]),
  )
  const item = { kind: 'user', id: 'u1', ts: 1, text: 'look', images: [{ url: `/api/media/${PICTURE}` }] }
  writeFileSync(join(desk, 'chats', 'worker-chat.jsonl'), JSON.stringify(item) + '\n')
  writeFileSync(join(desk, 'media', PICTURE), 'png bytes')
  writeFileSync(join(desk, 'media', `${'cd'.repeat(32)}.png`), 'a picture no chat names')

  const home = temp('desk-two-')
  writeFileSync(join(home, 'chats.json'), JSON.stringify([row('both-chat', { title: 'Desk 2 title' })]))
  const m = boot(home)

  expect(m.importDesk(desk)).toEqual({ imported: ['worker-chat', 'archived-chat'], already: ['both-chat'] })
  expect(m.get('worker-chat')).toMatchObject({ title: 'Example chat worker-chat', workerId: 'w-1', status: 'closed' })
  expect(m.get('archived-chat').archived).toBe(true)
  expect(m.get('both-chat').title).toBe('Desk 2 title')
  expect(m.listItems('worker-chat').map((i) => i.id)).toEqual(['u1'])
  expect(readFileSync(join(home, 'media', PICTURE), 'utf8')).toBe('png bytes')
  expect(existsSync(join(home, 'media', `${'cd'.repeat(32)}.png`))).toBe(false)
  expect(m.sessionIds()).toContain('older-session')
  expect(m.importDesk(desk, ['worker-chat'])).toEqual({ imported: [], already: ['worker-chat'] })
  expect(() => m.importDesk(home)).toThrow("this Hydra Desk's own data folder")

  managers.splice(managers.indexOf(m), 1)
  await m.closeAll()
  const saved = JSON.parse(readFileSync(join(home, 'chats.json'), 'utf8')) as Record<string, unknown>[]
  expect(saved.map((r) => r.id).sort()).toEqual(['archived-chat', 'both-chat', 'worker-chat'])
  expect(saved.find((r) => r.id === 'archived-chat')).toMatchObject({ ranIn: 'C:/Users/me/.claude-2' })
  expect(saved.find((r) => r.id === 'worker-chat')).toMatchObject({ pastSessions: ['older-session'] })
})

test('ids limits the import to those chats; a folder with no chat list is refused in words', () => {
  const desk = temp('desk-one-')
  writeFileSync(join(desk, 'chats.json'), JSON.stringify([row('one'), row('two')]))
  const m = boot(temp('desk-two-'))
  expect(m.importDesk(desk, ['two'])).toEqual({ imported: ['two'], already: [] })
  expect(m.list({ archived: true }).map((c) => c.id)).toEqual(['two'])
  expect(() => m.importDesk(temp('empty-'))).toThrow('no Hydra Desk chats in')
})
