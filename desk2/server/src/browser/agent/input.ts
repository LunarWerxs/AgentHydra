// The input tools: browser_click, browser_hover, browser_select, browser_type and browser_press_key. Each drives the page
// the caller already has (callerPage in navigate.ts) with real mouse and key events, and answers with the same text and
// errors as Connections' engine (browser.mjs browserActionClick :4085, browserActionHover :4093, browserActionSelect :4202,
// browserActionType :4234, browserActionPress :4257), with the targeting they share (resolveTarget :2156, resolvePoint :2435).
// Not ported: cross-origin (OOPIF) iframes, which the per-page link cannot follow. A vault secret is typed through Connections.

import type { ToolCaller } from './contract'
import { ToolInputError } from './errors'
import { callerPage, connect } from './navigate'
import type { ToolDef } from './registry'
import { type CdpSend, createPageSnapshot, type Point } from './snapshot'

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

const CLICKABLE_SEL =
  'a,button,input,textarea,select,[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=switch],[onclick],label,summary,[tabindex]'

const RETRIES = 3
const RETRY_DELAY_MS = 280
const OPTION_POLLS = 14
const OPTION_POLL_MS = 300

const KEYS: Record<string, { keyCode: number; code: string; key: string; text?: string }> = {
  Enter: { keyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
  Tab: { keyCode: 9, code: 'Tab', key: 'Tab' },
  Space: { keyCode: 32, code: 'Space', key: ' ', text: ' ' },
  Escape: { keyCode: 27, code: 'Escape', key: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete', key: 'Delete' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Home: { keyCode: 36, code: 'Home', key: 'Home' },
  End: { keyCode: 35, code: 'End', key: 'End' },
  PageUp: { keyCode: 33, code: 'PageUp', key: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown', key: 'PageDown' },
}

type Send = CdpSend
type Params = Record<string, unknown>

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function withPage<T>(params: Params, caller: ToolCaller, work: (send: Send) => Promise<T>): Promise<T> {
  const { browser, targetId } = await callerPage(params, caller)
  const link = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`)
  try {
    return await work((method, p = {}) => link.send(method, p))
  } finally {
    link.close()
  }
}

const textParam = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v))

function refOf(params: Params): string | null {
  if (params.ref) return String(params.ref)
  if (typeof params.selector === 'string' && /^aria-ref=/.test(params.selector.trim())) return params.selector.trim()
  return null
}

function outsideWindowMessage(pt: Point, { w, h }: { w: number; h: number }, what: string): string | null {
  if (pt.x >= 0 && pt.y >= 0 && pt.x < w && pt.y < h) return null
  return `${what} sits at (${Math.round(pt.x)},${Math.round(pt.y)}), outside the ${w}x${h} window even after scrolling it into view (its container does not scroll), so a click there would hit whatever covers that point. Enlarge the window, or treat it as a layout bug: an element nobody can scroll to is unreachable for a person too.`
}

function findExpression(kind: 'selector' | 'text', value: string): string {
  const vis = `(e)=>{try{const c=getComputedStyle(e);const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&c.visibility!=='hidden'&&c.display!=='none'&&Number(c.opacity)!==0;}catch{return false;}}`
  const per =
    kind === 'selector'
      ? `(root)=>{try{return[...root.querySelectorAll(${JSON.stringify(value)})];}catch(e){throw e;}}`
      : `(root)=>[...root.querySelectorAll(${JSON.stringify(CLICKABLE_SEL)})]`
  const pick =
    kind === 'selector'
      ? `(els)=>els.find(vis)`
      : `(els)=>{const t=${JSON.stringify(value.toLowerCase().trim())};const nm=e=>((e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'')+'').toLowerCase().trim();const v=els.filter(vis);return v.find(e=>nm(e)===t)||v.find(e=>nm(e).includes(t));}`
  return `(()=>{const vis=${vis};const per=${per};const pick=${pick};const search=(root)=>{const hit=pick(per(root));if(hit)return hit;const all=root.querySelectorAll('*');for(const e of all){if(e.shadowRoot){const r=search(e.shadowRoot);if(r)return r;}if(e.tagName==='IFRAME'){let d=null;try{d=e.contentDocument;}catch{}if(d){const r=search(d);if(r)return r;}}}return null;};const el=search(document);if(el)el.scrollIntoView({block:'center',inline:'center'});return el;})()`
}

async function findBox(send: Send, kind: 'selector' | 'text', value: string): Promise<Point | null> {
  const evaluated = await send('Runtime.evaluate', { expression: findExpression(kind, value), returnByValue: false })
  if (evaluated.exceptionDetails) {
    if (kind === 'selector')
      throw new Error(
        `invalid selector ${JSON.stringify(value)}: ${evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text}`,
      )
    return null
  }
  const objectId: string | undefined = evaluated.result?.objectId
  if (!objectId) return null
  const quads: number[][] | undefined = await send('DOM.getContentQuads', { objectId })
    .then((r) => r.quads)
    .catch(() => undefined)
    .finally(() => send('Runtime.releaseObject', { objectId }).catch(() => {}))
  const quad = quads?.[0]
  if (!quad) return null
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  }
}

async function targetPoint(send: Send, params: Params): Promise<{ pt: Point; label: string }> {
  const ref = refOf(params)
  if (ref) {
    const snap = createPageSnapshot(send)
    await snap.aria()
    return { pt: await snap.resolveRef(ref), label: `${ref} @ ` }
  }
  const selector = textParam(params.selector)
  const text = textParam(params.text)
  const kind = selector ? 'selector' : text ? 'text' : null
  if (!kind) throw new ToolInputError('needs text, a selector, a ref, or x,y coordinates')
  const value = (selector || text) as string
  let found: Point | null = null
  let lastErr: unknown
  for (let i = 0; i <= RETRIES && !found; i++) {
    try {
      found = await findBox(send, kind, value)
    } catch (err) {
      lastErr = err
      if (String((err as Error)?.message).startsWith('invalid selector')) throw err
    }
    if (!found && i < RETRIES) await delay(RETRY_DELAY_MS)
  }
  if (!found) {
    if (lastErr) throw lastErr
    throw new Error(`${kind} ${JSON.stringify(value)}: not found (searched 1 frame incl. shadow DOM)`)
  }
  return { pt: found, label: `${kind === 'selector' ? selector : `"${text}"`} @ ` }
}

async function resolvePoint(send: Send, params: Params): Promise<{ pt: Point; label: string }> {
  const x = params.x
  const y = params.y
  if (typeof x === 'number' && typeof y === 'number') return { pt: { x, y }, label: '' }
  const target = await targetPoint(send, params)
  const viewport = await send('Runtime.evaluate', {
    expression: '({w:innerWidth,h:innerHeight})',
    returnByValue: true,
  })
  const what = refOf(params) || textParam(params.selector) || `"${textParam(params.text)}"`
  const outside = outsideWindowMessage(target.pt, viewport.result.value, what)
  if (outside) throw new Error(outside)
  return target
}

async function mouseClick(send: Send, pt: Point, clickCount = 1, button = 'left'): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button, clickCount })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button, clickCount })
}

const at = (pt: Point) => `(${Math.round(pt.x)},${Math.round(pt.y)})`

async function selectNative(send: Send, locator: string | null, option: string): Promise<boolean> {
  if (!locator) return false
  const native = await send('Runtime.evaluate', {
    expression: `(()=>{let el=${locator};if(!el)return {native:false};el=el.tagName==='SELECT'?el:(el.closest&&el.closest('select'));if(!el)return {native:false};const opts=[...el.options];const t=${JSON.stringify(option)},tl=${JSON.stringify(option.toLowerCase())};const o=opts.find(o=>o.text.trim().toLowerCase()===tl)||opts.find(o=>o.value===t)||opts.find(o=>o.text.trim().toLowerCase().includes(tl));if(o){el.value=o.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {native:true,ok:true};}return {native:true,ok:false,options:opts.map(o=>o.text.trim()).slice(0,25)};})()`,
    returnByValue: true,
  })
  const value = native.result?.value
  if (!value?.native) return false
  if (value.ok) return true
  throw new Error(`"${option}" is not an option of that native <select>. Available: ${(value.options || []).join(', ')}`)
}

const OPTION_PROBE_SELECTOR =
  "[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],mat-option,li[role='option']"

function optionProbe(option: string): string {
  return `(()=>{const t=${JSON.stringify(option.toLowerCase())};const out=[];const walk=(root)=>{try{out.push(...root.querySelectorAll(${JSON.stringify(OPTION_PROBE_SELECTOR)}))}catch{}root.querySelectorAll('*').forEach(e=>{if(e.shadowRoot)walk(e.shadowRoot)})};walk(document);const vis=out.filter(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return r.width>0&&r.height>0&&c.visibility!=='hidden'&&c.display!=='none'});const m=vis.find(e=>(e.innerText||'').toLowerCase().trim()===t)||vis.find(e=>(e.innerText||'').toLowerCase().trim().includes(t));if(!m)return null;m.scrollIntoView({block:'center'});const b=m.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`
}

async function findOpenOption(send: Send, option: string): Promise<Point | null> {
  const probe = optionProbe(option)
  for (let attempt = 0; attempt < OPTION_POLLS; attempt++) {
    const result = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
    const point = result.result?.value
    if (point) return point
    await delay(OPTION_POLL_MS)
  }
  return null
}

const focusExpression = (selector: string) =>
  `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el){el.focus();try{el.select&&el.select();}catch{}}return !!el;})()`

const ATTACH_AND_PROFILE = { ...ATTACH_PORT_PROP, ...PROFILE_PROP }

export const INPUT_TOOLS: ToolDef[] = [
  {
    name: 'browser_click',
    description:
      "Click an element. Target by a browser_snapshot ref (ref:'e12' - exact), visible text (text:'Sign in'), a CSS selector, or pixel coordinates (x,y from a grid screenshot). Text/selector targeting pierces shadow DOM, same-origin iframes, AND cross-origin (OOPIF) iframes automatically, computing the true top-level click point; it also retries briefly so a target still rendering settles. x,y are REAL mouse events for canvas/framework UIs. Options: double:true (double-click), button:'right'.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'a ref from browser_snapshot, e.g. e12' },
        text: { type: 'string', description: 'click the element whose visible text matches this' },
        selector: { type: 'string', description: 'CSS selector to click (or aria-ref=e12)' },
        x: { type: 'number', description: 'CSS-pixel X (pair with y; from a grid screenshot)' },
        y: { type: 'number', description: 'CSS-pixel Y (pair with x)' },
        double: { type: 'boolean', description: 'double-click' },
        button: { type: 'string', description: "'left' (default) or 'right'" },
        ...ATTACH_AND_PROFILE,
      },
    },
    run: (params, caller) =>
      withPage(params, caller, async (send) => {
        const { pt, label } = await resolvePoint(send, params)
        const double = params.double === true
        await mouseClick(send, pt, double ? 2 : 1, params.button === 'right' ? 'right' : 'left')
        await delay(Number(params.waitMs) || 400)
        return `${double ? 'double-' : ''}clicked ${label}${at(pt)}`
      }),
  },
  {
    name: 'browser_select',
    description:
      'Pick an option from ANY dropdown in one call - native <select> AND framework popups (Radix / Angular-Material / Headless menus that render into a portal). Opens the trigger with a real mouse event, then polls for the option and clicks it. Use this INSTEAD of hand-driving open-then-click when a plain click on the menu misbehaves. Target the trigger by selector, trigger (visible text of the control), or x,y; name the choice with option (its visible text).',
    inputSchema: {
      type: 'object',
      properties: {
        option: { type: 'string', description: 'the visible text of the choice to pick' },
        selector: { type: 'string', description: 'CSS selector of the dropdown trigger' },
        trigger: { type: 'string', description: 'visible text of the trigger, if no selector' },
        x: { type: 'number' },
        y: { type: 'number' },
        ...ATTACH_AND_PROFILE,
      },
      required: ['option'],
    },
    run: (params, caller) =>
      withPage(params, caller, async (send) => {
        const option = String(params.option ?? '').trim()
        if (!option) throw new ToolInputError('select needs `option` — the visible text of the choice')
        const selector = textParam(params.selector)
        const xy = typeof params.x === 'number' && typeof params.y === 'number' ? { x: params.x, y: params.y } : null
        const locator = selector
          ? `document.querySelector(${JSON.stringify(selector)})`
          : xy
            ? `document.elementFromPoint(${xy.x},${xy.y})`
            : null
        if (await selectNative(send, locator, option)) return `selected "${option}" (native select)`
        const trigger = await resolvePoint(send, params.trigger ? { text: String(params.trigger) } : params)
        await mouseClick(send, trigger.pt)
        await delay(550)
        const found = await findOpenOption(send, option)
        if (!found) throw new Error(`opened the control but no option matching "${option}" appeared`)
        await mouseClick(send, found)
        await delay(400)
        return `selected "${option}"`
      }),
  },
  {
    name: 'browser_hover',
    description:
      'Move the mouse over an element (ref from browser_snapshot, text, selector, or x,y) without clicking - reveals hover menus/tooltips before a follow-up click.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        ...ATTACH_AND_PROFILE,
      },
    },
    run: (params, caller) =>
      withPage(params, caller, async (send) => {
        const { pt, label } = await resolvePoint(send, params)
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
        await delay(Number(params.waitMs) || 350)
        return `hovered ${label}${at(pt)}`
      }),
  },
  {
    name: 'browser_type',
    description:
      "Type text into a field. Pass ref (from browser_snapshot) or selector to focus a specific input first (its existing value is replaced); omit both to type into whatever is focused. This types the text you give; a password or key from the vault is typed by Connections instead (browser_type_secret, through connections_execute).",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        ...ATTACH_AND_PROFILE,
      },
    },
    run: (params, caller) => {
      if (params.secret != null && String(params.secret).trim())
        throw new ToolInputError(
          "Typing a vault secret goes through Connections, which holds the vault: connections_execute { local:true, tool_name:'browser_type_secret', params:{ secret:'<NAME>', selector:'...' } }.",
        )
      if (params.text == null) throw new ToolInputError('pass `text` to type.')
      const text = String(params.text)
      return withPage(params, caller, async (send) => {
        const ref = refOf(params)
        const selector = textParam(params.selector)
        if (ref) {
          const snap = createPageSnapshot(send)
          await snap.aria()
          const pt = await snap.resolveRef(ref)
          await mouseClick(send, pt)
          await send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: 2,
            commands: ['selectAll'],
          })
          await send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: 2,
          })
        } else if (selector) {
          await send('Runtime.evaluate', { expression: focusExpression(selector), returnByValue: true })
        }
        await send('Input.insertText', { text })
        const into = ref || selector
        return `typed ${JSON.stringify(text.slice(0, 80))}${into ? ` → ${into}` : ''}`
      })
    },
  },
  {
    name: 'browser_press_key',
    description:
      'Press a key - Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown. Use after browser_type to submit a form (Enter) or move between fields (Tab).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        waitMs: {
          type: 'number',
          description: 'milliseconds to wait after the key before answering; default 300',
        },
        ...ATTACH_AND_PROFILE,
      },
      required: ['key'],
    },
    run: (params, caller) => {
      const name = String(params.key ?? '')
      if (!Object.prototype.hasOwnProperty.call(KEYS, name))
        throw new ToolInputError(`unknown key: ${name} (known: ${Object.keys(KEYS).join(', ')})`)
      const k = KEYS[name]
      return withPage(params, caller, async (send) => {
        await send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          windowsVirtualKeyCode: k.keyCode,
          code: k.code,
          key: k.key,
          ...(k.text ? { text: k.text } : {}),
        })
        if (k.text) await send('Input.dispatchKeyEvent', { type: 'char', text: k.text, key: k.key })
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          windowsVirtualKeyCode: k.keyCode,
          code: k.code,
          key: k.key,
        })
        await delay(Number(params.waitMs) || 300)
        return `pressed ${name}`
      })
    },
  },
]
