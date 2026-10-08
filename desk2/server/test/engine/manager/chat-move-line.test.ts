// A chat is told its own Desk id and the one call that moves it: the line names the base URL the server listens on.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager } from '../../../src/engine/chat-manager'
import { chatAddOns, deskAppend } from '../../../src/engine/desk-prompt'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SELF = { id: 'c1', base: 'http://127.0.0.1:7801' }
const LINE = `This is Desk chat c1. To move this chat to another folder (its sidebar group), PATCH http://127.0.0.1:7801/api/chats/c1 with JSON {"cwd":"<absolute folder>"}; check the answer's cwd. Never move it by cd, climayte_send or a Connections workspace.`

test('a chat with its Desk id gets the one line that moves it, right after the standard text', () => {
  const { append } = chatAddOns('C:/Users/me/proj', true, SELF)
  expect(append.startsWith(`${deskAppend(true)} ${LINE}`)).toBe(true)
})

test('a chat without a Desk id gets no move line', () => {
  const { append } = chatAddOns('C:/Users/me/proj', true)
  expect(append).not.toContain('Desk chat')
  expect(append).not.toContain('/api/chats/')
})

test("a CliMayte worker gets its chat's id and move line at its start and on every send", async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-move-line-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const folder = join(home, 'proj')
  mkdirSync(folder, { recursive: true })
  const b = fakeBridge()
  const sent: string[] = []
  const sendToWorker = b.bridge.sendToWorker
  b.bridge.sendToWorker = (id, text, cwd, urgent, desk) => {
    sent.push(desk?.append ?? '')
    return sendToWorker(id, text, cwd, urgent, desk)
  }
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, deskUrl: () => 'http://127.0.0.1:7801' })
  managers.push(m)
  const chat = await m.create({ cwd: folder, prompt: 'go' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  const line = `This is Desk chat ${chat.id}. `
  expect(b.state.started[0]!.desk?.append).toContain(`${line}`)
  expect(b.state.started[0]!.desk?.append).toContain(`PATCH http://127.0.0.1:7801/api/chats/${chat.id} `)
  await m.send(chat.id, 'again')
  expect(sent.at(-1)).toContain(`PATCH http://127.0.0.1:7801/api/chats/${chat.id} `)
})
