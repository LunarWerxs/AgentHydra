// The read tools: browser_snapshot, browser_get_text and browser_read. Each reads the page the caller already has in its
// browser (callerPage in navigate.ts: a new about:blank when it has none yet, as Connections' pickOwnTab does), and
// answers with the same text Connections' engine gives (browser.mjs browserActionSnapshot :4224, browserActionText
// :3970, browserActionRead :3614).

import type { ToolCaller } from './contract'
import { ToolInputError } from './errors'
import { callerPage, connect } from './navigate'
import type { ToolDef } from './registry'
import { createPageSnapshot } from './snapshot'

const TEXT_CAP = 50_000

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

type Send = (method: string, params?: Record<string, unknown>) => Promise<any>

async function withPage<T>(
  params: Record<string, unknown>,
  caller: ToolCaller,
  work: (send: Send) => Promise<T>,
): Promise<T> {
  const { browser, targetId } = await callerPage(params, caller)
  const link = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`)
  try {
    return await work((method, p = {}) => link.send(method, p))
  } finally {
    link.close()
  }
}

const capped = (text: string): string =>
  text.length <= TEXT_CAP
    ? text
    : `${text.slice(0, TEXT_CAP)}\n…[TRUNCATED: showing ${TEXT_CAP} of ${text.length} characters. Nothing past the cap was kept.]`

export const READ_TOOLS: ToolDef[] = [
  {
    name: 'browser_snapshot',
    description:
      "SEE the page as a compact accessibility outline (YAML: headings, landmarks, lists, links, buttons, fields with their names and states) - the fast, token-cheap way to understand the page and decide what to click or type. Every actionable node carries a ref like [ref=e12]: pass it as browser_click/browser_hover/browser_type {ref:'e12'} (or selector:'aria-ref=e12') to act on exactly that node. Refs belong to the current tab and page: after a navigation or a big re-render, snapshot again. Main frame only (iframe contents: use text/selector targeting). Field values are left out on purpose. mode:'selectors' returns the older flat list of interactables with CSS selectors (what browser_capture_credential needs).",
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: "'aria' (default: outline with refs) or 'selectors' (flat list with CSS selectors)",
        },
        maxLines: { type: 'number', description: 'cap on outline lines (default 600)' },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
    },
    run: (params, caller) =>
      withPage(params, caller, (send) =>
        createPageSnapshot(send).snapshot({
          mode: params.mode as string | undefined,
          maxLines: params.maxLines as number | undefined,
        }),
      ),
  },
  {
    name: 'browser_get_text',
    description:
      "Get the visible text content of the current page (innerText), for reading what's on it. A page over 50,000 characters is cut at 50,000 characters and the rest is not kept.",
    inputSchema: { type: 'object', properties: { ...ATTACH_PORT_PROP, ...PROFILE_PROP } },
    run: async (params, caller) => {
      const text = await withPage(params, caller, async (send) => {
        const r = await send('Runtime.evaluate', {
          expression: 'document.body && document.body.innerText',
          returnByValue: true,
        })
        return String(r.result?.value || '')
      })
      return capped(text)
    },
  },
  {
    name: 'browser_read',
    description:
      'Read ONE element by CSS selector - its form value or visible text (or a named attribute via attr). The clean way to grab a just-generated value (client ID, secret, saved redirect URI, a status message) without hand-writing an eval. Returns the string.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to read' },
        attr: {
          type: 'string',
          description: "read this attribute instead of value/text (e.g. 'href', 'aria-checked')",
        },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
      required: ['selector'],
    },
    run: (params, caller) => {
      if (!params.selector) throw new ToolInputError('read needs a `selector`')
      const selector = String(params.selector)
      const attr = params.attr ? String(params.attr) : null
      const expression = `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return {err:'not found'};${
        attr
          ? `return {v:el.getAttribute(${JSON.stringify(attr)})}`
          : `return {v:('value' in el && el.value!=null && el.value!=='')?el.value:((el.innerText||el.textContent||'').trim())}`
      };})()`
      return withPage(params, caller, async (send) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true })
        if (r.exceptionDetails)
          throw new Error(
            `invalid selector ${JSON.stringify(selector)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`,
          )
        const v = r.result?.value
        if (!v || v.err) throw new Error(`read ${JSON.stringify(selector)}: ${v?.err || 'not found'}`)
        return String(v.v ?? '')
      })
    },
  },
]
