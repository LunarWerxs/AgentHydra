import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import {
  type FolderMoveDeps,
  moveDesktopChatFolder,
  type NativeChatState,
} from '../src/desktop-folder-move'
import { app } from '../src/http-app'
import '../src/routes/desktop-folder'

// http-app.ts is one object for the whole test process, and Hono freezes it on the first request, so
// the route is exercised through a private copy (the same pattern queue-patch-guard.test.ts uses).
const http = new Hono().route('/', app)

const profile = 'C:/Users/me/.claude-instances/example'
const oldId = '11111111-2222-4333-8444-555555555555'
const newId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const oldFolder = 'C:/Users/me/Projects/Alpha'
const missingFolder = 'C:/Users/me/Projects/Missing'
const NOW = Date.parse('2026-10-09T12:00:00Z')
const newFolder = import.meta.dir // an existing folder, so the real validateCwd accepts it

const ARCHIVED = {
  kind: 'result',
  route: 'native',
  ok: true,
  verified: true,
  changed: true,
  dispatch: 'sent',
  timingsMs: { total: 1 },
} as const

function record(cwd: string) {
  return {
    metaPath: 'C:/Users/me/.claude-instances/example/local_chat.json',
    meta: { cliSessionId: oldId, title: 'Example chat', cwd, isArchived: false },
  }
}

// Every effect is a recorded fake, so a refusal can be shown to have touched nothing.
function fakeDeps(over: Partial<FolderMoveDeps> = {}) {
  const calls: string[] = []
  let forkCwd = ''
  const idle: NativeChatState = {
    kind: 'ok',
    session: { isRunning: false, lastActivityAt: NOW - 3 * 3600_000 },
  }
  const deps: FolderMoveDeps = {
    nativeConfigured: () => true,
    findRecord: () => record(oldFolder),
    liveEngine: () => false,
    inspect: async () => idle,
    forkTranscript: (_old, _new, cwd) => {
      calls.push('fork')
      forkCwd = cwd
      return { written: ['C:/Users/me/.claude/projects/example/new.jsonl'] }
    },
    dropFiles: (paths) => calls.push(`drop:${paths.length}`),
    importChat: async () => {
      calls.push('import')
      return { ok: true, unavailable: false, importedSessionId: newId, cwd: newFolder }
    },
    awaitLanded: async () => {
      calls.push('landed')
      return true
    },
    stampLanded: async () => {
      calls.push('stamp')
      return true
    },
    carryDaemonState: () => calls.push('carry'),
    deskMarksRead: async () => ({ state: 'none' }),
    deskMarksWrite: async () => ({ ok: true }),
    archiveChat: async (_profile, id) => {
      calls.push(`archive:${id === oldId ? 'old' : 'new'}`)
      return ARCHIVED
    },
    invalidate: () => {},
    newSessionId: () => newId,
    now: () => NOW,
    ...over,
  }
  return { deps, calls, forkedTo: () => forkCwd }
}

const request = { sessionId: oldId, instanceRef: `desktop:${profile}`, cwd: newFolder }

test.each([
  ['a folder that does not exist', { cwd: missingFolder }, {}, 422, 'folder-missing'],
  [
    'the folder the chat already works in',
    {},
    { findRecord: () => record(newFolder) },
    409,
    'same-folder',
  ],
  [
    'a chat with pending input',
    {},
    { inspect: async () => ({ kind: 'ok' as const, session: { pendingInput: true } }) },
    409,
    'chat-busy',
  ],
  [
    'a chat used in the last 10 minutes',
    {},
    {
      inspect: async () => ({ kind: 'ok' as const, session: { lastActivityAt: NOW - 5 * 60_000 } }),
    },
    409,
    'used-recently',
  ],
  ['a chat with a running engine', {}, { liveEngine: () => true }, 409, 'engine-running'],
  [
    'a profile without native control',
    {},
    { nativeConfigured: () => false },
    409,
    'no-native-control',
  ],
  [
    'a chat the app does not hold natively',
    {},
    { inspect: async () => ({ kind: 'unavailable' as const, reason: 'the app is not running' }) },
    409,
    'native-unavailable',
  ],
])('refuses %s and touches nothing', async (_name, input, over, status, refused) => {
  const { deps, calls } = fakeDeps(over)
  const out = await moveDesktopChatFolder({ ...request, ...input }, deps)
  expect(out.status).toBe(status)
  expect(out.body).toMatchObject({ ok: false, refused })
  expect(calls).toEqual([])
})

test('moves in the move order and answers the new session id', async () => {
  const { deps, calls, forkedTo } = fakeDeps()
  const out = await moveDesktopChatFolder(request, deps)
  expect(out.status).toBe(200)
  expect(out.body).toMatchObject({
    ok: true,
    verified: true,
    sessionId: oldId,
    newSessionId: newId,
    archivedOld: true,
    cwd: resolve(newFolder),
  })
  expect(forkedTo()).toBe(resolve(newFolder))
  expect(calls).toEqual(['fork', 'import', 'landed', 'stamp', 'carry', 'archive:old'])
})

test('an import the app refused drops the written files and archives nothing', async () => {
  const { deps, calls } = fakeDeps({
    importChat: async () => ({ ok: false, unavailable: true, reason: 'the app is not running' }),
  })
  const out = await moveDesktopChatFolder(request, deps)
  expect(out.body).toMatchObject({ refused: 'native-unavailable' })
  expect(calls).toEqual(['fork', 'drop:1'])
})

test('an import sent but not confirmed keeps its files and is never retried', async () => {
  let imports = 0
  const { deps, calls } = fakeDeps({
    importChat: async () => {
      imports++
      return { ok: false, unavailable: false, reason: 'no confirmation' }
    },
  })
  const out = await moveDesktopChatFolder(request, deps)
  expect(out.status).toBe(502)
  expect(out.body).toMatchObject({ refused: 'import-unconfirmed', newSessionId: newId })
  expect(imports).toBe(1)
  expect(calls).toEqual(['fork'])
})

test('a landing in another folder archives the new copy, never the old chat', async () => {
  const { deps, calls } = fakeDeps({
    importChat: async () => ({
      ok: true,
      unavailable: false,
      importedSessionId: newId,
      cwd: 'C:/Users/me/Elsewhere',
    }),
  })
  const out = await moveDesktopChatFolder(request, deps)
  expect(out.body).toMatchObject({ refused: 'landed-in-other-folder', copyArchived: true })
  expect(calls).toEqual(['fork', 'archive:new'])
})

test('an old chat the native archive did not verify is reported with the new id, with no retry', async () => {
  const { deps, calls } = fakeDeps({
    archiveChat: async (_profile, id) => {
      calls.push(`archive:${id === oldId ? 'old' : 'new'}`)
      return {
        kind: 'result',
        route: 'native',
        ok: false,
        verified: false,
        changed: false,
        dispatch: 'sent',
        reason: 'not verified',
        timingsMs: { total: 1 },
      }
    },
  })
  const out = await moveDesktopChatFolder(request, deps)
  expect(out.status).toBe(409)
  expect(out.body).toMatchObject({ refused: 'old-copy-not-archived', newSessionId: newId })
  expect(calls.filter((c) => c === 'archive:old')).toHaveLength(1)
})

test('the route rejects a bad request before any effect runs', async () => {
  const post = (body: unknown) =>
    http.request(`/api/sessions/${oldId}/desktop-folder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const noInstance = await post({ cwd: newFolder })
  expect(noInstance.status).toBe(400)
  expect(await noInstance.json()).toMatchObject({ ok: false, refused: 'bad-request' })

  const relative = await post({ instance_ref: `desktop:${profile}`, cwd: 'Projects/Alpha' })
  expect(relative.status).toBe(400)
  expect(await relative.json()).toMatchObject({ ok: false, refused: 'bad-request' })

  const absent = await post({ instance_ref: `desktop:${profile}`, cwd: missingFolder })
  expect(absent.status).toBe(422)
  expect(await absent.json()).toMatchObject({ ok: false, refused: 'folder-missing' })
})
