// A deleted chat's Claude sessions stay out of the outside-session list: their files outlive the chat, so
// without a tombstone they came back as "Elsewhere" sessions, and a restart forgot even the live exclusion.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function boot(home: string, bridge: ReturnType<typeof fakeBridge>): ChatManager {
  process.env.HYDRA_DESK_HOME = home
  const m = new ChatManager({
    home,
    claudeHome: home,
    emit: () => {},
    settings: () => ({ ...DEFAULT_SETTINGS }),
    bridge: bridge.bridge,
    queryImpl: fakeQueries().queryImpl,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
    newChats: 'sdk',
  })
  managers.push(m)
  return m
}

async function excluded(bridge: ReturnType<typeof fakeBridge>): Promise<string[]> {
  return [...(await bridge.state.excluded())]
}

test("a deleted chat's Claude sessions stay out of the outside list, also after a restart", async () => {
  const home = temp('desk-tomb-')
  writeFileSync(join(home, 'chats.json'), JSON.stringify([row('gone', { pastSessions: ['session-gone-old'] }), row('kept')]))

  const first = fakeBridge()
  const m = boot(home, first)
  expect(await excluded(first)).toEqual(expect.arrayContaining(['session-gone', 'session-gone-old']))

  await m.delete('gone')
  expect(await excluded(first)).toEqual(expect.arrayContaining(['session-gone', 'session-gone-old']))
  await m.closeAll()

  const second = fakeBridge()
  boot(home, second)
  expect(await excluded(second)).toEqual(expect.arrayContaining(['session-gone', 'session-gone-old']))
})
