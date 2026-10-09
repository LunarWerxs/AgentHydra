// browser_script: runs a whole browser choreography in one call, one step after another, and answers a per-step transcript.
// Ported from Connections' browser.mjs browserActionScript (:3560) and its browser_script definition (src-impl/15-tools-browser.mjs).
// A step names a tool by `do`; the wait, sleep and scroll steps run here on the caller's page, every other step calls its tool.

import type { CallResult, ToolCaller, ToolReply } from './contract'
import { ToolInputError } from './errors'
import { callerPage, connect, type Link } from './navigate'
import type { ToolDef } from './registry'

type Step = Record<string, unknown>

const MAX_STEPS = 60
const DEFAULT_LIMIT = 600
const DEFAULT_ERROR_LIMIT = 300
const DEFAULT_WAIT_MS = 15_000
const POLL_MS = 250
const MAX_SLEEP_MS = 30_000
const DEFAULT_SCROLL_PX = 600

const TOOL_OF_STEP = new Map<string, string>([
  ['goto', 'browser_navigate'],
  ['click', 'browser_click'],
  ['select', 'browser_select'],
  ['hover', 'browser_hover'],
  ['type', 'browser_type'],
  ['upload', 'browser_upload_file'],
  ['press', 'browser_press_key'],
  ['read', 'browser_read'],
  ['text', 'browser_get_text'],
  ['snapshot', 'browser_snapshot'],
  ['eval', 'browser_evaluate'],
  ['screenshot', 'browser_take_screenshot'],
  ['waitIdle', 'browser_wait_idle'],
  ['waitTab', 'browser_wait_tab'],
  ['tab', 'browser_tab'],
  ['frames', 'browser_frames'],
  ['targets', 'browser_targets'],
  ['status', 'browser_status'],
  ['tabErrors', 'browser_tab_errors'],
  ['resize', 'browser_resize'],
])

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function onPage<T>(params: Step, caller: ToolCaller, use: (link: Link) => Promise<T>): Promise<T> {
  const { browser, targetId } = await callerPage(params, caller)
  const link = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`)
  try {
    return await use(link)
  } finally {
    link.close()
  }
}

async function pageValue(link: Link, expression: string): Promise<unknown> {
  const res = (await link.send('Runtime.evaluate', { expression, returnByValue: true })) as { result?: { value?: unknown } }
  return res.result?.value
}

async function waitText(params: Step, caller: ToolCaller): Promise<string> {
  const text = String(params.text ?? '')
  const limit = params.timeoutMs === undefined ? DEFAULT_WAIT_MS : Number(params.timeoutMs)
  return onPage(params, caller, async (link) => {
    const t0 = Date.now()
    while (Date.now() - t0 < limit) {
      if (String((await pageValue(link, 'document.body && document.body.innerText')) || '').includes(text)) return `found: ${text}`
      await delay(POLL_MS)
    }
    throw new Error(`timeout (${limit}ms) waiting for page text: ${text}`)
  })
}

async function waitSel(params: Step, caller: ToolCaller): Promise<string> {
  const selector = String(params.selector ?? '')
  const limit = params.timeoutMs === undefined ? DEFAULT_WAIT_MS : Number(params.timeoutMs)
  const expression = `!!document.querySelector(${JSON.stringify(selector)})`
  return onPage(params, caller, async (link) => {
    const t0 = Date.now()
    while (Date.now() - t0 < limit) {
      if (await pageValue(link, expression)) return `present: ${selector}`
      await delay(POLL_MS)
    }
    throw new Error(`timeout (${limit}ms) waiting for selector: ${selector}`)
  })
}

async function scroll(params: Step, caller: ToolCaller): Promise<string> {
  const dy = typeof params.y === 'number' ? params.y : DEFAULT_SCROLL_PX
  return onPage(params, caller, async (link) => {
    await link.send('Runtime.evaluate', { expression: `window.scrollBy(0, ${dy})`, returnByValue: true })
    return `scrolled ${dy}px`
  })
}

async function sleepStep(params: Step): Promise<string> {
  const ms = Math.min(Number(params.ms) || 1000, MAX_SLEEP_MS)
  await delay(ms)
  return `slept ${ms}ms`
}

async function runStep(step: Step, script: Step, caller: ToolCaller): Promise<string> {
  const params: Step = { ...step, profile: script.profile, attachPort: script.attachPort, headed: script.headed }
  delete params.do
  delete params.optional
  delete params.limit
  const action = String(step.do)
  if (action === 'waitText') return waitText(params, caller)
  if (action === 'waitSel') return waitSel(params, caller)
  if (action === 'scroll') return scroll(params, caller)
  if (action === 'sleep') return sleepStep(params)
  const tool = TOOL_OF_STEP.get(action)
  if (!tool) throw new Error(`unknown browser action: ${action}`)
  const { callTool } = await import('./tools')
  const result: CallResult = await callTool(tool, params, caller)
  if (!result.ok) throw new Error(result.error)
  return result.text
}

async function run(params: Step, caller: ToolCaller): Promise<ToolReply> {
  if (!Array.isArray(params.steps)) throw new ToolInputError('steps must be an array of { do, ... } steps')
  if (params.steps.some((step) => step && typeof step === 'object' && (step as Step).secret != null))
    throw new ToolInputError(
      'a browser_script step cannot type a `secret` - nothing ran. Split the script: run the steps before it, call browser_type { secret, selector }, then run the rest.',
    )
  const steps = params.steps.slice(0, MAX_STEPS) as Step[]
  const out: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const step: Step = steps[i] || {}
    const label = `${i + 1}. ${String(step.do)}`
    if (!step.do || step.do === 'script' || step.do === 'close') {
      out.push(`${label} SKIPPED (not allowed in a script)`)
      continue
    }
    try {
      const text = await runStep(step, params, caller)
      out.push(`${label} → ${text.slice(0, typeof step.limit === 'number' ? step.limit : DEFAULT_LIMIT)}`)
    } catch (error) {
      out.push(`${label} FAILED: ${String((error as Error)?.message || error).slice(0, DEFAULT_ERROR_LIMIT)}`)
      if (!step.optional) {
        out.push(`(aborted — ${steps.length - i - 1} step(s) not run)`)
        break
      }
    }
  }
  return out.join('\n')
}

export const SCRIPT_TOOLS: ToolDef[] = [
  {
    name: 'browser_script',
    description:
      "Run a whole browser choreography in ONE call - steps execute back-to-back in-process (navigate → wait → type → select → click → read), which is MUCH faster than one tool call per action. Each step is { do, ...args } where do is any browser action: goto{url,waitMs} · click{ref|text|selector|x,y,double,button} (pierces iframes + shadow DOM) · select{option,trigger|selector|x,y} (dropdowns, incl. framework popups) · hover{ref|text|selector|x,y} · type{ref|selector,text} · upload{file|files,selector} (attach a local file to a file input - never click the page's own Select-file button, it opens an undrivable native OS dialog) · press{key} · scroll{y} · read{selector,attr} (read one element's value/text/attr) · waitText{text,timeoutMs} · waitSel{selector,timeoutMs} · waitIdle{idleMs,timeoutMs} (wait for network to settle) · waitTab{match,timeoutMs} (wait for + switch to a new OAuth popup tab; omit match for any) · sleep{ms} · tab{match} (switch to the tab whose URL/title contains match) · frames · targets (list CDP targets: tabs, workers, service workers) · status (which window/profile am I driving, temp-profile warning, open windows) · text · snapshot · eval{expression,timeoutMs} (a returned Promise is awaited - an async fetch/postMessage probe resolves to its value; timeoutMs bounds it) · screenshot{grid,path}. A failed step aborts the rest unless it has optional:true. Returns a per-step transcript. Prefer this over single calls whenever you know 2+ actions in advance.",
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object' }, description: 'the choreography, in order' },
        ...ATTACH_PORT_PROP,
        headed: { type: 'boolean' },
        ...PROFILE_PROP,
      },
      required: ['steps'],
    },
    run,
  },
]
