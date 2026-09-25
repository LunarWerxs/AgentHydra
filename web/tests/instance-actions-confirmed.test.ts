// 2026-09-25 (owner: "why is Agent Hydra so friggin slow at closing instances and opening
// instances"): after the server CONFIRMED an open or quit, the row waited for one more full
// re-list - a fresh 1.0-1.5s process scan on the daemon - before it flipped and its buttons came
// back. The confirmed state now lands on the row at once and the re-list runs behind it.
//
// Drives the real composable against a patched globalThis.fetch (never mock.module - see
// resource-status.test.ts), with the re-list held open so the test can look at the row before it
// lands.
import { afterEach, expect, test } from 'bun:test'
import { useInstances } from '../src/composables/useInstances'
import type { CMInstance } from '../src/lib/api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const dir = 'C:\\Users\\me\\.claude-instances\\luis'
const row = (running: boolean, pid: number | null) =>
  ({ dir, isRunning: running, pid, memoryBytes: running ? 1 : null, account: null }) as CMInstance

/** Answers the action POST at once and holds the re-list until `release` is called. */
function serve(action: 'open' | 'quit', data: Record<string, unknown>, listed: CMInstance[]) {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (url.endsWith(`/${action}`)) return body({ ok: true, action, dir, message: 'ok', data })
    if (url.endsWith('/api/instances')) {
      await held
      return body(listed)
    }
    return body({})
  }) as unknown as typeof fetch
  return () => release()
}

test('a confirmed quit greys the row and frees its buttons before the re-list returns', async () => {
  const { instances, busyDirs, quit } = useInstances()
  instances.value = [row(true, 4242)]
  const release = serve('quit', { killedCount: 3 }, [row(false, null)])
  expect(await quit(dir)).toBe(true)
  expect(instances.value[0]).toMatchObject({ isRunning: false, pid: null, memoryBytes: null })
  expect(busyDirs.value.has(dir)).toBe(false)
  release()
})

test('a confirmed open shows the row running with the launched pid before the re-list returns', async () => {
  const { instances, busyDirs, open } = useInstances()
  instances.value = [row(false, null)]
  const release = serve('open', { pid: 5150 }, [row(true, 5150)])
  expect((await open(dir))?.ok).toBe(true)
  expect(instances.value[0]).toMatchObject({ isRunning: true, pid: 5150 })
  expect(busyDirs.value.has(dir)).toBe(false)
  release()
})
