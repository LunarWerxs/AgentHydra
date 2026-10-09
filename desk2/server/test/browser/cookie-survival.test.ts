// A persistent cookie set in a profile folder survives a clean close and a relaunch of the same Chrome binary and folder.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome, LIVE_CHROME_FLAGS } from '../../src/browser/cdp'

setDefaultTimeout(60_000)

const chrome = findChrome()
const started: Bun.Subprocess[] = []

async function launch(dir: string): Promise<{ proc: Bun.Subprocess; wsUrl: string }> {
  rmSync(join(dir, 'DevToolsActivePort'), { force: true })
  const proc = Bun.spawn(
    [
      chrome!,
      `--user-data-dir=${dir}`,
      '--remote-debugging-port=0',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      ...LIVE_CHROME_FLAGS,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  started.push(proc)
  const until = Date.now() + 20_000
  const file = join(dir, 'DevToolsActivePort')
  while (Date.now() < until) {
    if (existsSync(file)) {
      const [port, wsPath] = readFileSync(file, 'utf8').split('\n')
      if (/^\d+$/.test(port?.trim() ?? '') && wsPath?.trim()) {
        return { proc, wsUrl: `ws://127.0.0.1:${port.trim()}${wsPath.trim()}` }
      }
    }
    await Bun.sleep(100)
  }
  proc.kill()
  throw new Error('Chrome did not announce its debugging port')
}

async function cdp(wsUrl: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('CDP connection failed'))
  })
  try {
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 15_000)
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data))
        if (msg.id !== 1) return
        clearTimeout(timer)
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`))
        else res(msg.result)
      }
      ws.send(JSON.stringify({ id: 1, method, params }))
    })
  } finally {
    ws.close()
  }
}

async function closeClean(wsUrl: string): Promise<void> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('CDP connection failed'))
  })
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  await Bun.sleep(200)
  ws.close()
}

const NAME = 'ah_survival'
const DOMAIN = 'example.test'

describe.skipIf(!chrome)('cookie survival across a clean close and relaunch', () => {
  let home = ''
  let fixture = ''
  let value = ''

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ah-cookie-home-'))
    process.env.HYDRA_DESK_HOME = home
    fixture = join(mkdtempSync(join(tmpdir(), 'ah-cookie-profile-')), 'profile')
    mkdirSync(fixture, { recursive: true })
    value = `v${crypto.randomUUID()}`
  })

  afterAll(() => {
    for (const p of started) {
      try {
        p.kill()
      } catch {
        // floor-ok: already exited
      }
    }
    for (const dir of [home, fixture]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a persistent cookie is present after close and relaunch with the same binary and folder', async () => {
    const first = await launch(fixture)
    const expires = Math.floor(Date.now() / 1000) + 365 * 86400
    await cdp(first.wsUrl, 'Storage.setCookies', { cookies: [{ name: NAME, value, domain: DOMAIN, path: '/', expires }] })
    const before = await cdp(first.wsUrl, 'Storage.getCookies')
    expect(before.cookies.some((c: { name: string; value: string }) => c.name === NAME && c.value === value)).toBe(true)

    await closeClean(first.wsUrl)
    const exited = await Promise.race([first.proc.exited.then(() => true), Bun.sleep(20_000).then(() => false)])
    expect(exited).toBe(true)

    const second = await launch(fixture)
    const after = await cdp(second.wsUrl, 'Storage.getCookies')
    const kept = after.cookies.find((c: { name: string }) => c.name === NAME)
    expect(kept?.value).toBe(value)
    expect(kept?.domain).toBe(DOMAIN)

    await closeClean(second.wsUrl)
    await Promise.race([second.proc.exited, Bun.sleep(20_000)])
  })
})
