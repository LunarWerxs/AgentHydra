// The quick-instances window is AgentHydra 2.0's page (desk2/hydra), built for Desk 2's /ah/ base and served
// by the daemons themselves (src/quick-instances-page.ts). What the shortcut depends on: the page at
// /instances, its files under /ah/ and nothing outside the build, and its /ah/api/* calls answered by the
// daemon's own /api/* routes behind the same guard a direct /api/* call meets.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createLoopbackGuard } from '../src/loopback-guard.mjs'
import { serveQuickInstancesPage } from '../src/quick-instances-page'

const parent = mkdtempSync(join(tmpdir(), 'ah-quick-page-'))
const dist = join(parent, 'dist')
mkdirSync(join(dist, 'assets'), { recursive: true })
writeFileSync(join(dist, 'index.html'), '<div id="app"></div>')
writeFileSync(join(dist, 'assets', 'index-abc.js'), 'export {}')
writeFileSync(join(parent, 'outside.txt'), 'not the build')
afterAll(() => rmSync(parent, { recursive: true, force: true }))

const ORIGIN = 'http://127.0.0.1:7788'
function daemon() {
  const app = new Hono()
  app.use('/api/*', createLoopbackGuard({ allowedOrigins: () => [ORIGIN] }))
  app.post('/api/instances/:dir/open', (c) => c.json({ opened: c.req.param('dir') }))
  serveQuickInstancesPage(app, dist)
  return app
}

test('the shortcut gets the page at /instances and its built files under /ah/, nothing outside the build', async () => {
  const app = daemon()
  const page = await app.request('/instances')
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('id="app"')
  const asset = await app.request('/ah/assets/index-abc.js')
  expect(asset.status).toBe(200)
  expect(asset.headers.get('cache-control')).toContain('immutable')
  // An encoded slash keeps the request on /ah/* while it decodes to a step out of the build.
  expect((await app.request('/ah/..%2foutside.txt')).status).toBe(404)
})

test("the page's /ah/api/* calls reach the daemon's /api/* behind the same guard", async () => {
  const app = daemon()
  const call = (origin: string, site: string) =>
    app.request('/ah/api/instances/a/open', {
      method: 'POST',
      headers: { origin, 'sec-fetch-site': site, host: '127.0.0.1:7788' },
    })
  const own = await call(ORIGIN, 'same-origin')
  expect(own.status).toBe(200)
  expect(await own.json()).toEqual({ opened: 'a' })
  const foreign = await call('https://evil.example.com', 'cross-site')
  expect(foreign.status).toBe(403)
  expect(((await foreign.json()) as { error: string }).error).toMatch(/^forbidden/)
})
