// The page tools: browser_take_screenshot, browser_resize, browser_wait_idle, browser_wait_tab and browser_tab_errors.
// Each answers the text Connections' engine gives (browser.mjs browserActionScreenshot :4059, browserActionResize :4279,
// browserActionWaitIdle :3901, browserActionWaitTab :3662, browserActionTabErrors :3862), over the same CDP calls.

import { writeFileSync } from 'node:fs'
import { pageTabs } from '../cdp'
import { ownPage } from '../ledger'
import { readLedger } from '../ownership'
import type { ToolCaller, ToolReply } from './contract'
import { ToolInputError } from './errors'
import { adopt, callerPage, connect, resolveBrowser } from './navigate'
import type { Browser, Link } from './navigate'
import type { ToolDef } from './registry'

type Params = Record<string, unknown>
type Send = (method: string, params?: Record<string, unknown>) => Promise<any>

const ATTACH_PORT_PROP = {
  attachPort: {
    type: 'number',
    description:
      'attach to an ALREADY-RUNNING Chrome exposing this CDP port (e.g. a window the user signed into) instead of the profile browser',
  },
}

const PROFILE_PROP = {
  profile: {
    type: 'string',
    description:
      "Which saved browser to use (a persistent named profile - logins there survive across sessions). Omit = this workspace's company browser. See browser_profiles for the list.",
  },
}

const TAB_ASK_TIMEOUT_MS = 5000
const TAB_ERROR_TEXT_MAX = 500
const TAB_ERRORS_PER_TAB_MAX = 50

const SCREENSHOT_DETAIL: Record<string, { maxWidth: number; quality: number; format: 'png' | 'jpeg' }> = {
  quick: { maxWidth: 800, quality: 45, format: 'jpeg' },
  normal: { maxWidth: 1800, quality: 80, format: 'jpeg' },
  fine: { maxWidth: 2600, quality: 92, format: 'jpeg' },
  max: { maxWidth: 100000, quality: 95, format: 'png' },
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value)
  return value != null && value !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

async function onPage<T>(browser: Browser, targetId: string, work: (send: Send) => Promise<T>): Promise<T> {
  const link = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`)
  try {
    return await work((method, p = {}) => link.send(method, p))
  } finally {
    link.close()
  }
}

function screenshotSettings(params: Params) {
  const asked = params.detail == null ? '' : String(params.detail).trim().toLowerCase()
  const level = asked || 'normal'
  const row = SCREENSHOT_DETAIL[level]
  if (!row)
    throw new ToolInputError(
      [
        'screenshot_detail_unknown',
        `detail '${String(params.detail)}' is not a level.`,
        `Use one of: ${Object.keys(SCREENSHOT_DETAIL).join(', ')} (default normal), or set maxWidth, quality and format yourself.`,
      ].join('\n'),
    )
  const asFormat = String(params.format ?? '').toLowerCase()
  const format: 'png' | 'jpeg' = asFormat === 'png' ? 'png' : asFormat === 'jpeg' || asFormat === 'jpg' ? 'jpeg' : row.format
  return {
    format,
    fullPage: Boolean(params.fullPage),
    maxWidth: bounded(params.maxWidth, row.maxWidth, 200, 100000),
    quality: bounded(params.quality, row.quality, 1, 100),
    gridStep: bounded(params.gridStep, 100, 40, 100000),
  }
}

async function screenshotViewport(send: Send, fullPage: boolean) {
  const viewport = await send('Runtime.evaluate', {
    expression:
      '({w:Math.round(innerWidth),h:Math.round(innerHeight),x:Math.round(visualViewport?visualViewport.pageLeft:scrollX),y:Math.round(visualViewport?visualViewport.pageTop:scrollY)})',
    returnByValue: true,
  })
  const { w = 1280, h = 800, x = 0, y = 0 } = viewport.result?.value || {}
  if (!fullPage) return { w, h, x, y, capW: w, capH: h }
  const metrics = await send('Page.getLayoutMetrics', {}).catch(() => ({}))
  const content = metrics.cssContentSize || metrics.contentSize || {}
  return {
    w,
    h,
    x: 0,
    y: 0,
    capW: Math.max(w, Math.round(content.width || w)),
    capH: Math.max(h, Math.round(content.height || h)),
  }
}

function gridOverlayScript(step: number, w: number, h: number): string {
  return `(()=>{const id='__cnx_grid__';const old=document.getElementById(id);if(old)old.remove();
    const S=${step},W=${w},H=${h};
    const cv=document.createElement('canvas');cv.id=id;cv.width=W;cv.height=H;
    cv.style.cssText='position:fixed;left:0;top:0;width:'+W+'px;height:'+H+'px;z-index:2147483647;pointer-events:none';
    document.documentElement.appendChild(cv);
    const g=cv.getContext('2d');g.lineWidth=1;g.font='11px monospace';
    for(let x=S;x<W;x+=S){g.strokeStyle='rgba(255,45,85,.30)';g.beginPath();g.moveTo(x,0);g.lineTo(x,H);g.stroke();
      g.fillStyle='rgba(255,45,85,.95)';g.fillText(x,x+2,12);g.fillText(x,x+2,H-3);}
    for(let y=S;y<H;y+=S){g.strokeStyle='rgba(255,45,85,.30)';g.beginPath();g.moveTo(0,y);g.lineTo(W,y);g.stroke();
      g.fillStyle='rgba(255,45,85,.95)';g.fillText(y,2,y-2);g.fillText(y,W-26,y-2);}
    return 'grid';})()`
}

async function captureShot(
  send: Send,
  shot: Record<string, unknown>,
  grid: { step: number; w: number; h: number } | null,
): Promise<string> {
  if (grid) await send('Runtime.evaluate', { expression: gridOverlayScript(grid.step, grid.w, grid.h), returnByValue: true })
  try {
    await send('Page.bringToFront').catch(() => {})
    const shotResult = (await send('Page.captureScreenshot', shot)) as { data: string }
    return shotResult.data
  } finally {
    if (grid)
      await send('Runtime.evaluate', {
        expression: "(()=>{const e=document.getElementById('__cnx_grid__');if(e)e.remove();return 1})()",
        returnByValue: true,
      }).catch(() => {})
  }
}

async function takeScreenshot(params: Params, caller: ToolCaller): Promise<ToolReply> {
  const settings = screenshotSettings(params)
  const wantGrid = Boolean(params.grid) && !settings.fullPage
  const { browser, targetId } = await callerPage(params, caller)
  return onPage(browser, targetId, async (send) => {
    const viewport = await screenshotViewport(send, settings.fullPage)
    const scale = Math.min(1, settings.maxWidth / viewport.capW)
    const shot = {
      format: settings.format,
      ...(settings.format === 'jpeg' ? { quality: settings.quality } : {}),
      ...(settings.fullPage ? { captureBeyondViewport: true } : {}),
      clip: { x: viewport.x || 0, y: viewport.y || 0, width: viewport.capW, height: viewport.capH, scale },
    }
    const data = await captureShot(
      send,
      shot,
      wantGrid ? { step: settings.gridStep, w: viewport.w, h: viewport.h } : null,
    )
    const kb = Math.round((data.length * 0.75) / 1024)
    const shownW = Math.round(viewport.capW * scale)
    const shownH = Math.round(viewport.capH * scale)
    const gridNote =
      params.grid && settings.fullPage
        ? " · grid skipped (full-page coords don't map to clicks)"
        : wantGrid
          ? ` · grid ${settings.gridStep}px (click the CSS-px labels)`
          : ''
    let text = `screenshot ${settings.format} ${kb}KB · ${shownW}×${shownH}px shown of ${viewport.capW}×${viewport.capH} css-px · click at CSS-px coords (0–${viewport.w}×0–${viewport.h})${gridNote}`
    if (params.path) {
      writeFileSync(String(params.path), Buffer.from(data, 'base64'))
      text = `saved → ${String(params.path)} · ${text}`
    }
    return { text, image: { data, mimeType: settings.format === 'png' ? 'image/png' : 'image/jpeg' } }
  })
}

async function resize(params: Params, caller: ToolCaller): Promise<ToolReply> {
  const width = Math.max(1, Math.round(Number(params.width) || 1280))
  const height = Math.max(1, Math.round(Number(params.height) || 800))
  const mobile = params.mobile === true
  const { browser, targetId } = await callerPage(params, caller)
  await onPage(browser, targetId, async (send) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 }).catch(() => {})
    await delay(350)
  })
  return `viewport → ${width}×${height}${mobile ? ' (mobile+touch)' : ''}`
}

async function waitIdle(params: Params, caller: ToolCaller): Promise<ToolReply> {
  const idleMs = Math.min(10_000, Math.max(100, Math.round(Number(params.idleMs) || 500)))
  const limit = params.timeoutMs == null ? 20_000 : Number(params.timeoutMs)
  const { browser, targetId } = await callerPage(params, caller)
  let lastNet = Date.now()
  let inFlight = 0
  const link: Link = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`, (method) => {
    if (!method.startsWith('Network.')) return
    lastNet = Date.now()
    if (method === 'Network.requestWillBeSent') inFlight++
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') inFlight = Math.max(0, inFlight - 1)
  })
  try {
    await link.send('Network.enable', {})
    const t0 = Date.now()
    while (Date.now() - t0 < limit) {
      if (inFlight === 0 && Date.now() - lastNet >= idleMs) {
        const rs = (await link.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(
          () => ({}),
        )) as { result?: { value?: string } }
        if (rs.result?.value === 'complete') return `network idle (${idleMs}ms quiet)`
      }
      await delay(100)
    }
    return `waited ${limit}ms; network still active (proceeding anyway)`
  } finally {
    link.close()
  }
}

interface TargetRow {
  targetId: string
  type: string
  url: string
  title: string
  openerId?: string
}

async function pageTargets(browser: Browser): Promise<TargetRow[]> {
  const link = await connect(browser.browserWs)
  try {
    const { targetInfos } = (await link.send('Target.getTargets', {})) as { targetInfos?: TargetRow[] }
    return (targetInfos ?? []).filter((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools:'))
  } finally {
    link.close()
  }
}

async function waitTab(params: Params, caller: ToolCaller): Promise<ToolReply> {
  const { browser, targetId: mine } = await callerPage(params, caller)
  const me = caller.session
  const match = String(params.match || '').toLowerCase()
  const limit = params.timeoutMs == null ? 15_000 : Number(params.timeoutMs)
  const before = new Set((await pageTargets(browser)).map((t) => t.targetId))
  const startedAt = Date.now()
  while (Date.now() - startedAt < limit) {
    const ledger = browser.dir ? readLedger(browser.dir) : new Map<string, { chat: string; at: number }>()
    const hit = (await pageTargets(browser)).find((t) => {
      const owner = ledger.get(t.targetId)?.chat
      if (owner && owner !== me) return false
      const fromMe = Boolean(me) && owner === me
      if (before.has(t.targetId) || !(fromMe || t.openerId === mine)) return false
      return !match || t.url.toLowerCase().includes(match) || (t.title || '').toLowerCase().includes(match)
    })
    if (hit) {
      if (browser.dir && me) ownPage(browser.dir, hit.targetId, me)
      adopt(browser, caller, hit.targetId)
      return `new tab → ${hit.title} | ${hit.url}`
    }
    await delay(400)
  }
  throw new Error(`timeout (${limit}ms) waiting for ${match ? `a tab matching: ${String(params.match)}` : 'a new tab to open'}`)
}

interface TabError {
  kind: string
  text: string
  url?: string
  line?: number
  column?: number
}

const clip = (s: unknown): string => String(s || '').slice(0, TAB_ERROR_TEXT_MAX)

function remoteText(arg: any): string {
  if (!arg) return ''
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  return arg.description || arg.unserializableValue || arg.type || ''
}

function location(frame: any): Partial<TabError> {
  if (!frame) return {}
  return {
    url: frame.url || '',
    ...(frame.lineNumber != null ? { line: frame.lineNumber + 1 } : {}),
    ...(frame.columnNumber != null ? { column: frame.columnNumber + 1 } : {}),
  }
}

function tabErrorRow(method: string, p: any): TabError | null {
  if (method === 'Runtime.exceptionThrown') {
    const d = p?.exceptionDetails || {}
    const text = d.exception?.description || [d.text, remoteText(d.exception)].filter(Boolean).join(' ')
    return { kind: 'exception', text: clip(text), ...(d.url ? location(d) : location(d.stackTrace?.callFrames?.[0])) }
  }
  if (method === 'Runtime.consoleAPICalled' && (p?.type === 'error' || p?.type === 'assert'))
    return {
      kind: `console.${p.type}`,
      text: clip((p.args || []).map(remoteText).join(' ')),
      ...location(p.stackTrace?.callFrames?.[0]),
    }
  if (method === 'Log.entryAdded' && p?.entry?.level === 'error') {
    const e = p.entry
    return {
      kind: `log.${e.source || 'other'}`,
      text: clip(e.text),
      ...(e.url ? location(e) : location(e.stackTrace?.callFrames?.[0])),
    }
  }
  return null
}

async function probeTab(port: number, targetId: string, timeoutMs: number) {
  const errors: TabError[] = []
  const seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs)
  })
  let link: Link | undefined
  try {
    link = await Promise.race([
      connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, (method, params) => {
        const row = tabErrorRow(method, params)
        if (!row) return
        const key = `${row.text}\u0000${row.url ?? ''}\u0000${row.line ?? ''}`
        if (seen.has(key)) return
        seen.add(key)
        errors.push(row)
      }),
      deadline,
    ])
    await Promise.race([link.send('Runtime.enable', {}).then(() => link?.send('Log.enable', {})), deadline])
    return { errorCount: errors.length, errors: errors.slice(-TAB_ERRORS_PER_TAB_MAX) }
  } finally {
    clearTimeout(timer)
    link?.close()
  }
}

async function tabErrors(params: Params, caller: ToolCaller): Promise<ToolReply> {
  const browser = await resolveBrowser(params, caller)
  const match = String(params.match || '').toLowerCase()
  const tabs = (await pageTabs(browser.port)).filter(
    (t) => !t.url.startsWith('devtools:') && (!match || `${t.url} ${t.title}`.toLowerCase().includes(match)),
  )
  if (!tabs.length) return match ? `(no open tab matches "${String(params.match)}")` : '(no open tabs)'
  const timeoutMs = Number(params.timeoutMs) > 0 ? Math.min(Number(params.timeoutMs), 30_000) : TAB_ASK_TIMEOUT_MS
  const outcomes = await Promise.all(
    tabs.map((tab) =>
      probeTab(browser.port, tab.id, timeoutMs).then(
        (answer) => ({ tab, answer, reason: '' }),
        (err: unknown) => ({ tab, answer: null, reason: messageOf(err) }),
      ),
    ),
  )
  const answered = outcomes.flatMap((o) => (o.answer ? [{ url: o.tab.url, title: o.tab.title, ...o.answer }] : []))
  const missing = outcomes.flatMap((o) => (o.answer ? [] : [{ url: o.tab.url, reason: o.reason }]))
  if (!answered.length)
    throw new Error(
      `no tab answered: ${missing.map((m) => `${m.url || m.reason} (${m.reason})`).join('; ')}`,
    )
  const errors = answered.reduce((n, t) => n + t.errorCount, 0)
  return JSON.stringify(
    {
      tabs: tabs.length,
      answered: answered.length,
      errors,
      results: answered,
      ...(missing.length ? { missing } : {}),
    },
    null,
    2,
  )
}

export const PAGE_TOOLS: ToolDef[] = [
  {
    name: 'browser_take_screenshot',
    description:
      'See the page RIGHT NOW as an inline image. You choose how sharp with detail: quick (800px wide, a glance in a screenshot→click loop) · normal (default, 1800px, text is readable) · fine (2600px, small print and dense UI) · max (native size, lossless PNG). THE reliable way to drive a stubborn UI: pass grid:true to overlay a coordinate ruler, read the label nearest your target, then browser_click {x,y} at those exact CSS-pixel coords. Overrides on top of detail: grid (coordinate overlay), gridStep (px spacing, default 100), format (\'png\' lossless or \'jpeg\'), quality (JPEG 1–100), maxWidth (downscale cap in px), fullPage (whole scroll; grid is skipped there), path (also save to disk).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        fullPage: { type: 'boolean' },
        grid: { type: 'boolean', description: 'overlay a CSS-pixel coordinate ruler to click straight off of' },
        gridStep: { type: 'number', description: 'grid spacing in px (default 100)' },
        detail: {
          type: 'string',
          enum: ['quick', 'normal', 'fine', 'max'],
          description:
            'how sharp: quick 800px q45 · normal 1800px q80 (default) · fine 2600px q92 · max native size, lossless PNG. format, quality and maxWidth override it.',
        },
        format: { type: 'string', description: "'jpeg' or 'png' (lossless); default comes from detail" },
        quality: { type: 'number', description: 'JPEG quality 1–100; default comes from detail' },
        maxWidth: { type: 'number', description: 'downscale so width ≤ this many px; default comes from detail' },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
    },
    run: takeScreenshot,
  },
  {
    name: 'browser_resize',
    description:
      'Resize the page viewport (CDP device-metrics override, headless session) - e.g. width 375, height 812 to render-verify a mobile layout, then 1280×800 to return to desktop. Keeps the session (and any signed-in auth) alive. Pass mobile:true to also emulate the mobile viewport bit.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        mobile: { type: 'boolean' },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
      required: ['width', 'height'],
    },
    run: resize,
  },
  {
    name: 'browser_wait_idle',
    description:
      "Wait until the page's network goes quiet (no requests in flight for idleMs, default 500) and the document is ready - the reliable 'the app has settled' wait for async multi-step wizards where you don't yet know the next selector to wait for. Beats a fixed sleep. timeoutMs default 20000.",
    inputSchema: {
      type: 'object',
      properties: {
        idleMs: { type: 'number' },
        timeoutMs: { type: 'number' },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
    },
    run: waitIdle,
  },
  {
    name: 'browser_wait_tab',
    description:
      'Wait for a NEW browser tab/window to appear (an OAuth consent screen or redirect callback opens one) and switch the tools to drive it. Pass `match` (a URL/title substring) to target a specific one, or omit it to grab whatever popup opens next. Use right after clicking an Authorize/Test/Sign-in button that pops a window.',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string' },
        timeoutMs: { type: 'number' },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
    },
    run: waitTab,
  },
  {
    name: 'browser_tab_errors',
    description:
      'Ask EVERY open tab what is broken on the page right now: uncaught exceptions, unhandled promise rejections, console.error/console.assert calls, and browser-logged errors (failed loads, CSP and CORS refusals) - including ones logged BEFORE this call, with no reload and without switching the tab you are driving. Each tab answers on its own; the call returns when all have answered, or after timeoutMs (default 5000) with the tabs that did plus a `missing` list naming the ones that did not (a paused or frozen tab). Pass match to ask only tabs whose URL or title contains it (e.g. \'localhost:5173\'). To read a dev server\'s tabs in your OWN Chrome, start it with --remote-debugging-port and pass attachPort.',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: 'only ask tabs whose URL or title contains this (case-insensitive)' },
        timeoutMs: {
          type: 'number',
          description: 'how long to wait for the slowest tab before returning what arrived (default 5000, max 30000)',
        },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
    },
    run: tabErrors,
  },
]
