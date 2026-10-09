import { afterEach, describe, expect, test } from 'bun:test'
import {
  checkServerUpdate,
  offerOf,
  refusalText,
  restartServer,
  restartState,
  serverHello,
  serverUpdate,
  updateOffer,
} from '../../src/lib/server-update'

const realFetch = globalThis.fetch
const answer = (status: number, body: unknown) => {
  const calls: { url: string; method: string }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
  serverUpdate.value = null
  restartState.value = null
})

describe('Restart to update', () => {
  test('the Menu offers it only while the server runs older code than the files', () => {
    expect(offerOf(null, null)).toBeNull()
    expect(offerOf({ stale: false, restartable: true }, null)).toBeNull()
    expect(offerOf({ stale: true, restartable: true }, null)).toEqual({ restartable: true, restarting: false, error: null })
    expect(offerOf({ stale: true, restartable: false }, { error: 'no' })).toEqual({ restartable: false, restarting: false, error: 'no' })
  })

  test('a server without the route is older than this window, and says nothing it cannot do', async () => {
    answer(404, { error: 'no route GET /api/server/update' })
    await checkServerUpdate()
    expect(updateOffer.value).toEqual({ restartable: false, restarting: false, error: null })
  })

  test('restarting until the new server says hello; a refusal shows its sentence', async () => {
    const calls = answer(202, { ok: true })
    serverUpdate.value = { stale: true, restartable: true }
    await restartServer()
    expect(calls).toEqual([{ url: '/api/server/restart', method: 'POST' }])
    expect(updateOffer.value?.restarting).toBe(true)
    answer(200, { stale: false, restartable: true })
    serverHello()
    expect(restartState.value).toBeNull()
    await Bun.sleep(0)
    expect(updateOffer.value).toBeNull()

    serverUpdate.value = { stale: true, restartable: true }
    answer(409, { error: 'run desk2/launcher/restart.ps1' })
    await restartServer()
    expect(updateOffer.value?.error).toBe('run desk2/launcher/restart.ps1')
  })

  test('a restart whose answer times out stays restarting, not an error', async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      throw new DOMException('timed out', 'TimeoutError')
    }) as unknown as typeof fetch
    await restartServer()
    expect(restartState.value).toEqual({ restarting: true })
  })

  test('a route the running server lacks reads as an old server, not a bare 404', () => {
    expect(refusalText(404, 'no route POST /api/chats/c1/send-now')).toBe("This window's server is older than the window: Menu > Restart to update")
    expect(refusalText(404, 'no such chat')).toBe('no such chat')
    expect(refusalText(500, undefined)).toBeNull()
  })
})
