#!/usr/bin/env bun
/**
 * The README's and the website's pictures of AgentHydra's window, from its demo world.
 *
 *   bun run build                        # first: it shoots the built window (web/dist)
 *   bun run screenshots                  # shoot, then install into ../.github/screenshots
 *   bun run screenshots -- --keep        # stop after ../tmp/screenshots-window, to look first
 *
 * The pictures are public, so nothing real may be in them. They are of `#/gallery/shell`, the whole
 * window drawn on invented chats, accounts and projects (web/src/components/shell/demo.ts). The page is
 * served here, by a server that holds no data: it answers every /api/, /dw/ and /ah/ request with a 503,
 * and the browser is allowed no other origin, so no daemon or Desk is ever reached. Each shot has an
 * `expect` that must hold (the demo's own words on screen) before the picture is kept, and a picture is
 * copied into .github/screenshots only when every shot passed. The AgentHydra pages' own pictures
 * (Instances, Analytics) come from ../scripts/screenshots/capture.mjs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer'

const DESK = join(import.meta.dir, '..')
const DIST = join(DESK, 'web', 'dist')
const STAGE = join(DESK, '..', 'tmp', 'screenshots-window')
const INSTALL = join(DESK, '..', '.github', 'screenshots')
const KEEP = process.argv.includes('--keep')
const PORT = 5196
const SCALE = 2
/** A picture smaller than this never holds a drawn window. */
const MIN_PNG_BYTES = 40_000

interface Shot {
  name: string
  route: string
  viewport: [number, number]
  /** Run in the page; true once the view is drawn as it should be. */
  expect: string
}

const SHOTS: Shot[] = [
  {
    name: 'window',
    route: '/gallery/shell',
    viewport: [1280, 800],
    expect: `/Desktop client rewrite plan/.test(document.body.innerText) && /To-dos/.test(document.body.innerText)`,
  },
  {
    name: 'new',
    route: '/gallery/shell/new',
    viewport: [1280, 800],
    expect: `/What’s up next/.test(document.body.innerText) && /nexuscode-2d/.test(document.body.innerText) && /docs-site/.test(document.body.innerText) && document.querySelectorAll('[aria-label$="open chats"], [aria-label$="open chat"]').length >= 1`,
  },
]

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('web/dist is missing: run `bun run build` first.')
  process.exit(1)
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname)
    if (/^\/(api|dw|ah|events)(\/|$)/.test(path)) return new Response('no data here: window-shots serves the demo window only', { status: 503 })
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path))
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) return new Response(readFileSync(join(DIST, 'index.html')), { headers: { 'content-type': 'text/html' } })
    return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } })
  },
})
const origin = `http://127.0.0.1:${PORT}`

const browser = await puppeteer.launch({ headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] })
let failed = false
try {
  mkdirSync(STAGE, { recursive: true })
  for (const shot of SHOTS) {
    const page = await browser.newPage()
    const elsewhere: string[] = []
    await page.setRequestInterception(true)
    page.on('request', (r) => {
      const url = r.url()
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return void r.continue()
      elsewhere.push(url)
      void r.abort()
    })
    await page.setViewport({ width: shot.viewport[0], height: shot.viewport[1], deviceScaleFactor: SCALE })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.goto(`${origin}/#${shot.route}`, { waitUntil: 'networkidle0' })
    const drawn = await page.waitForFunction(shot.expect, { timeout: 30_000 }).then(
      () => true,
      () => false,
    )
    await new Promise((go) => setTimeout(go, 800))
    const file = join(STAGE, `${shot.name}.png`)
    await page.screenshot({ path: file })
    const size = statSync(file).size
    if (!drawn || size < MIN_PNG_BYTES) {
      console.error(`[${shot.name}] not drawn as expected (expect held: ${drawn}, ${size} bytes): not installed`)
      failed = true
    } else console.log(`[${shot.name}] ${file} (${Math.round(size / 1024)} KB)${elsewhere.length ? `; refused ${elsewhere.length} request(s) to other origins` : ''}`)
    await page.close()
  }
} finally {
  await browser.close()
  server.stop(true)
}

if (failed) process.exit(1)
if (KEEP) console.log(`kept in ${STAGE}; nothing installed`)
else {
  mkdirSync(INSTALL, { recursive: true })
  for (const shot of SHOTS) copyFileSync(join(STAGE, `${shot.name}.png`), join(INSTALL, `${shot.name}.png`))
  console.log(`installed ${SHOTS.length} picture(s) into ${INSTALL}`)
}
