// Frame-budget harness for the streaming reply: drives desk2's transcript (web `#/stream-bench`) in
// chrome-headless-shell while a long reply streams in, one chunk per frame, and writes JSON:
//   (a) frames whose main-thread work (CDP Performance TaskDuration) went over 8.33 ms,
//   (b) RecalcStyleCount and LayoutCount per chunk, (c) DOM mutations per chunk (MutationObserver).
// The reply has an em dash in its prose and a 240-line TypeScript block, the standing check for the
// one-byte highlight path (web/src/components/transcript/lib/highlight.ts).
//
//   bun e2e/stream-frames.e2e.ts [--url http://127.0.0.1:4799] [--out tmp/stream-frames.json]
//
// Needs puppeteer (not in package.json): `bun add -d puppeteer` in desk2, then
// `bunx puppeteer browsers install chrome-headless-shell` (or CHROME_HEADLESS_SHELL=<path to the exe>).
// Without --url it starts the web Vite dev server on 4799 hidden and stops it afterwards.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const BUDGET_MS = 8.33
const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const out = resolve(import.meta.dir, '..', arg('--out') ?? 'tmp/stream-frames.json')

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

let vite: ChildProcess | null = null
let base = arg('--url')
if (!base) {
  base = 'http://127.0.0.1:4799'
  vite = spawn('bun', ['run', '--cwd', 'web', 'dev', '--port', '4799', '--strictPort', '--host', '127.0.0.1'], {
    cwd: resolve(import.meta.dir, '..'),
    windowsHide: true,
    stdio: 'ignore',
  })
  for (let i = 0; i < 120 && !(await answers(base)); i++) await Bun.sleep(500)
  if (!(await answers(base))) {
    vite.kill()
    throw new Error('the Vite dev server did not answer on 4799')
  }
}

let puppeteer: typeof import('puppeteer')
try {
  puppeteer = (await import('puppeteer')).default as unknown as typeof import('puppeteer')
} catch {
  vite?.kill()
  throw new Error('puppeteer is missing: run `bun add -d puppeteer` in desk2, then `bunx puppeteer browsers install chrome-headless-shell`')
}

const browser = await puppeteer.launch({
  headless: 'shell',
  executablePath: process.env.CHROME_HEADLESS_SHELL || undefined,
  args: ['--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 900 },
})

type Metrics = Record<string, number>
type Bench = { __mut: number; __streamBench: { ready: boolean; total: number; push(): Promise<boolean> } }
try {
  const page = await browser.newPage()
  // Counted before any page script runs, so the stream's mutations are all seen.
  await page.evaluateOnNewDocument(() => {
    const w = window as unknown as { __mut: number }
    w.__mut = 0
    new MutationObserver((records) => {
      w.__mut += records.length
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  const cdp = await page.createCDPSession()
  await cdp.send('Performance.enable')
  const metrics = async (): Promise<Metrics> => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
  }
  const mutations = () => page.evaluate(() => (window as unknown as Bench).__mut)
  let ticks = 1000
  const frame = async () => {
    ticks += 1000 / 120
    await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: ticks, interval: 1000 / 120, noDisplayUpdates: false })
  }

  await page.goto(`${base}/#/stream-bench`, { waitUntil: 'load' })
  await page.waitForFunction(() => (window as unknown as Partial<Bench>).__streamBench?.ready, { timeout: 60_000 })
  for (let i = 0; i < 3; i++) await frame()

  const chunks: { chunk: number; recalcs: number; layouts: number; mutations: number; mainThreadMs: number; overBudget: boolean }[] = []
  // Windows are contiguous (each chunk starts where the last one ended, nothing between two chunks goes
  // uncounted) and a chunk is closed only after the page has run its pending timers (40 ms of real time),
  // so a late style recalc lands in the chunk that caused it on every run.
  const settle = () => page.evaluate(() => new Promise<void>((r) => setTimeout(r, 40)))
  let before = await metrics()
  let mutBefore = await mutations()
  for (let n = 0; ; n++) {
    const more = await page.evaluate(() => (window as unknown as Bench).__streamBench.push())
    if (!more) break
    await frame()
    await settle()
    const after = await metrics()
    const mutAfter = await mutations()
    const mainThreadMs = ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000
    chunks.push({
      chunk: n,
      recalcs: (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0),
      layouts: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
      mutations: mutAfter - mutBefore,
      mainThreadMs: Math.round(mainThreadMs * 100) / 100,
      overBudget: mainThreadMs > BUDGET_MS,
    })
    before = after
    mutBefore = mutAfter
  }

  const emDashRendered = await page.evaluate(() => document.body.innerText.includes('—'))
  const sum = (k: 'recalcs' | 'layouts' | 'mutations') => chunks.reduce((a, c) => a + c[k], 0)
  const perChunk = (k: 'recalcs' | 'layouts' | 'mutations') => Math.ceil(sum(k) / Math.max(1, chunks.length))
  const result = {
    schema: 'desk2-stream-frames/1',
    budgetMs: BUDGET_MS,
    chunks: chunks.length,
    framesOverBudget: chunks.filter((c) => c.overBudget).length,
    styleRecalcsPerChunk: perChunk('recalcs'),
    layoutsPerChunk: perChunk('layouts'),
    mutationsPerChunk: perChunk('mutations'),
    totals: { recalcs: sum('recalcs'), layouts: sum('layouts'), mutations: sum('mutations') },
    emDashRendered,
    perChunk: chunks,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2))
  const { perChunk: _rows, ...head } = result
  console.log(JSON.stringify(head))
} finally {
  await browser.close()
  vite?.kill()
}
