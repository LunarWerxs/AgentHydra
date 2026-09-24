import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { getSetting, setSetting } from '../src/db'

const realNative = { ...(await import('../src/claude-native-archive')) }
const realLaunch = { ...(await import('../src/session-launch')) }
const realUi = { ...(await import('../src/ui-archive')) }
const profile = 'C:\\instances\\native-proof'
const sid = '11111111-2222-4333-8444-555555555555'
let result: Record<string, unknown>
let calls: string[]
let globallyLive: boolean

mock.module('../src/claude-native-archive', () => ({
  ...realNative,
  tryNativeArchiveChat: async (dir: string, id: string) => {
    calls.push(`native:${dir}:${id}`)
    return result
  },
}))
mock.module('../src/session-launch', () => ({
  ...realLaunch,
  liveSessionEntry: () => {
    calls.push('global-live-check')
    return globallyLive ? { pid: 123 } : null
  },
  archiveDesktopChat: async () => {
    calls.push('disk-write')
    return { ok: true, hits: [{ profile, wasRunning: true, changed: true }] }
  },
  reassertChatArchive: async () => {
    calls.push('watcher')
  },
  cancelChatArchiveReassert: () => false,
  findChatMetaPath: () => null,
}))
mock.module('../src/ui-archive', () => ({
  ...realUi,
  uiArchiveChat: async () => {
    calls.push('ui')
    return { clicked: true, verified: true }
  },
}))
afterAll(() => {
  mock.module('../src/claude-native-archive', () => realNative)
  mock.module('../src/session-launch', () => realLaunch)
  mock.module('../src/ui-archive', () => realUi)
})

const { app } = await import('../src/http-app')
await import('../src/routes/desktop-sessions')
const http = new Hono().route('/', app)

beforeEach(() => {
  calls = []
  globallyLive = false
  result = {
    kind: 'result',
    route: 'native',
    ok: true,
    verified: true,
    changed: true,
    dispatch: 'sent',
  }
})

async function post(route: string, body: Record<string, unknown> = {}) {
  const response = await http.request(`/api/sessions/${sid}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_ref: `desktop:${profile}`, ...body }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('native source archive precedes the global destination-live check and every legacy side effect', async () => {
  globallyLive = true
  const response = await post('desktop-archive')
  expect(response.status).toBe(200)
  expect(response.body.verified).toBe(true)
  expect(response.body.stillOnScreen).toBe(false)
  expect(response.body.uiArchive).toEqual([])
  expect(calls).toEqual([`native:${profile}:${sid}`])
})

test.each(['not-sent', 'sent', 'unknown'])(
  'a native refusal with dispatch %s cannot write disk, arm a watcher or click',
  async (dispatch) => {
    result = {
      kind: 'result',
      route: 'native',
      ok: false,
      verified: false,
      changed: false,
      dispatch,
      reason: 'native safety refusal',
    }
    const response = await post('desktop-archive')
    expect(response.status).toBe(409)
    expect(response.body.dispatch).toBe(dispatch)
    expect(response.body.stillOnScreen).toBeNull()
    expect(calls).toEqual([`native:${profile}:${sid}`])
  },
)

test('only explicit pre-dispatch unavailability permits the existing archive path', async () => {
  result = { kind: 'unavailable', route: 'native', dispatch: 'not-sent', reason: 'not configured' }
  const response = await post('desktop-archive')
  expect(response.status).toBe(200)
  expect(calls).toEqual([
    `native:${profile}:${sid}`,
    'global-live-check',
    'disk-write',
    'watcher',
    'ui',
  ])
})

test('the native-only endpoint reports absence without doing any legacy work', async () => {
  result = { kind: 'unavailable', route: 'native', dispatch: 'not-sent', reason: 'not configured' }
  const response = await post('native-archive')
  expect(response.body.available).toBe(false)
  expect(response.body.dispatch).toBe('not-sent')
  expect(calls).toEqual([`native:${profile}:${sid}`])
})

test('the native-only endpoint preserves terminal refusal for orchestrator callers', async () => {
  result = {
    kind: 'result',
    route: 'native',
    ok: false,
    verified: false,
    changed: false,
    dispatch: 'unknown',
    reason: 'reply lost',
  }
  const response = await post('native-archive')
  expect(response.status).toBe(409)
  expect(response.body.available).toBe(true)
  expect(response.body.dispatch).toBe('unknown')
  expect(calls).toEqual([`native:${profile}:${sid}`])
})

test.each(['wrong', 'desktop:', 'desktop:label', 'desktop:C:relative', 'desktop:\\rooted'])(
  'malformed native scope %s is a terminal refusal, never an availability signal',
  async (instance_ref) => {
    const response = await post('native-archive', { instance_ref })
    expect(response.status).toBe(400)
    expect(response.body.available).toBe(true)
    expect(calls).toEqual([])
  },
)

test('an absolute POSIX profile retains the unconfigured legacy availability result', async () => {
  result = { kind: 'unavailable', route: 'native', dispatch: 'not-sent', reason: 'not configured' }
  const response = await post('native-archive', { instance_ref: 'desktop:/home/owner/claude' })
  expect(response.status).toBe(200)
  expect(response.body.available).toBe(false)
  expect(calls).toEqual([`native:/home/owner/claude:${sid}`])
})

test('unarchive retains its existing behavior without invoking the archive adapter', async () => {
  await post('desktop-archive', { archived: false })
  expect(calls).toEqual(['disk-write'])
})

test('settings API persists automatic launch explicitly and rejects mistyped launch settings', async () => {
  const original = getSetting('claude_native_profiles')
  try {
    setSetting('claude_native_profiles', '')
    const put = (config: unknown) =>
      http.request('/api/claude-native/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile, config }),
      })
    expect((await put({ port: 19315, mode: 'native-only', launchDebugger: true })).status).toBe(200)
    const saved = (await (await http.request('/api/claude-native/settings')).json()) as Record<
      string,
      unknown
    >
    expect(saved[profile.toLowerCase()]).toEqual({
      port: 19315,
      mode: 'native-only',
      launchDebugger: true,
    })
    expect((await put({ port: 19315, mode: 'native-only', launchDebugger: 'false' })).status).toBe(
      400,
    )
    expect((await put({ port: 19315, mode: 'native-only', unrecognized: true })).status).toBe(400)
    expect(
      (
        (await (await http.request('/api/claude-native/settings')).json()) as Record<
          string,
          { launchDebugger: boolean }
        >
      )[profile.toLowerCase()].launchDebugger,
    ).toBe(true)
    expect(calls).toEqual([])
  } finally {
    setSetting('claude_native_profiles', original)
  }
})
