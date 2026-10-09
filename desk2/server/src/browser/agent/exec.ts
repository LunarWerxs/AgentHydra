// The exec tools: browser_evaluate and browser_upload_file. Each drives the page the caller already has (callerPage in
// navigate.ts) and answers with the same text as Connections' engine (browser.mjs browserActionEval :3941,
// browserActionUpload :4113, fileInputFinder :4103). Not ported: the egress receipt (26h-tools-egress-ledger) and the
// capability path grant (91-tool-policy), and cross-origin (OOPIF) iframes, which the per-page link cannot reach.

import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ToolCaller } from './contract'
import { ToolInputError } from './errors'
import { callerPage, connect } from './navigate'
import type { ToolDef } from './registry'
import type { CdpSend } from './snapshot'

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

async function withPage<T>(
  params: Record<string, unknown>,
  caller: ToolCaller,
  work: (send: CdpSend) => Promise<T>,
): Promise<T> {
  const { browser, targetId } = await callerPage(params, caller)
  const link = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`)
  try {
    return await work((method, p = {}) => link.send(method, p))
  } finally {
    link.close()
  }
}

async function evaluate(params: Record<string, unknown>, caller: ToolCaller): Promise<string> {
  if (typeof params.expression !== 'string' || !params.expression)
    throw new ToolInputError('evaluate needs `expression`')
  const expression = params.expression
  const timeout = Number(params.timeoutMs)
  const limit = timeout > 0 ? Math.min(timeout, 120_000) : 0
  return withPage(params, caller, async (send) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const answer: any = await Promise.race([
      send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(limit ? { timeout: limit } : {}),
      }).catch((e) => ({ thrown: String((e as Error)?.message || e).replace(/^Runtime\.evaluate:\s*/, '') })),
      limit
        ? new Promise<'timed out'>((resolve) => {
            timer = setTimeout(() => resolve('timed out'), limit + 1000)
          })
        : new Promise<never>(() => {}),
    ]).finally(() => clearTimeout(timer))
    if (answer === 'timed out') return `page error: evaluation exceeded timeoutMs=${timeout}`
    if (answer.thrown !== undefined) {
      if (limit && /collected|timed out|timeout/i.test(answer.thrown))
        return `page error: evaluation exceeded timeoutMs=${timeout} (${answer.thrown})`
      return `page error: ${answer.thrown}`
    }
    const r = answer
    if (r.exceptionDetails) return `page error: ${r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)}`
    const v = r.result?.value
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
}

function fileInputFinder(selector: string): string {
  return `(()=>{const per=(root)=>root.querySelectorAll(${JSON.stringify(selector)});const search=(root)=>{const hit=per(root)[0];if(hit)return hit;for(const e of root.querySelectorAll('*')){if(e.shadowRoot){const r=search(e.shadowRoot);if(r)return r;}if(e.tagName==='IFRAME'){let d=null;try{d=e.contentDocument;}catch{}if(d){const r=search(d);if(r)return r;}}}return null;};return search(document);})()`
}

async function upload(params: Record<string, unknown>, caller: ToolCaller): Promise<string> {
  const listed = Array.isArray(params.files) ? params.files : [params.files ?? params.file]
  const files = listed.filter(Boolean).map((f) => resolve(String(f)))
  if (!files.length) throw new ToolInputError('upload needs `file` (a path) or `files` (an array of paths)')
  const missing = files.filter((f) => !existsSync(f))
  if (missing.length) throw new Error(`upload: file not found: ${missing.join(', ')}`)

  const selector = String(params.selector || 'input[type=file]')
  const waitMs = Number(params.waitMs) || 700
  return withPage(params, caller, async (send) => {
    const evaluated = await send('Runtime.evaluate', { expression: fileInputFinder(selector), returnByValue: false })
    if (evaluated.exceptionDetails)
      throw new Error(
        `invalid selector ${JSON.stringify(selector)}: ${evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text}`,
      )
    const objectId: string | undefined = evaluated.result?.objectId
    if (!objectId)
      throw new Error(
        `upload: no ${selector} found (searched the main frame and its same-origin iframes, incl. shadow DOM). ` +
          `If the page only creates its input on demand, click its own "Select file"/"Browse" control first, then retry - but note that control usually opens a NATIVE OS dialog, which no automation can drive; this tool exists precisely so you never have to open one.`,
      )

    const described = await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function(){return {accept:this.accept||'',inFrame:!!this.ownerDocument.defaultView.frameElement}}",
      returnByValue: true,
    }).catch(() => null)
    await send('DOM.enable', {}).catch(() => {})
    await send('DOM.setFileInputFiles', { files, objectId })
    await send('Runtime.releaseObject', { objectId }).catch(() => {})
    await delay(waitMs)

    const info = described?.result?.value
    const where = info?.inFrame ? 'same-origin iframe' : 'main frame'
    const acceptNote = info?.accept ? ` (input accepts ${info.accept})` : ''
    return `attached to ${selector} in the ${where}${acceptNote}: ${files.map((f) => basename(f)).join(', ')}`
  })
}

export const EXEC_TOOLS: ToolDef[] = [
  {
    name: 'browser_evaluate',
    description:
      'Run a JavaScript expression in the page and return its result. A returned Promise is AWAITED - so `await fetch(...)` or a postMessage round-trip resolves to its VALUE, not "[object Promise]": this is the supported way to run an async in-page probe. Pass timeoutMs to bound the whole evaluation (a slow or never-settling promise then errors loudly instead of hanging). Escape hatch for anything the other browser_* tools don\'t cover (read DOM, scroll, set values). Refused (web_access_eval_refused) when web_access is in `approve` or `provenance` mode, since page JavaScript can reach any host past the per-host gate.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        timeoutMs: {
          type: 'number',
          description:
            'bound the whole evaluation (including an awaited Promise) in ms; a slow/never-settling probe then errors instead of hanging',
        },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
      required: ['expression'],
    },
    run: (params, caller) => evaluate(params, caller),
  },
  {
    name: 'browser_upload_file',
    description:
      "Attach a LOCAL file to a page's file input - the way to answer any 'Upload file' / 'Choose file' / 'Attach' control. NEVER click the page's own Select-file button first: that opens a NATIVE OS dialog which no automation can drive, and you will be stuck. Call this instead - it finds the (usually display:none) input and hands the path straight to Chrome, including inside same-origin iframes where a page renders its picker. Pass an absolute path in `file` (or several in `files` when the input is multiple). `selector` only when a page has more than one file input; the default is the first input[type=file] anywhere on the page. Verify with browser_take_screenshot: a correctly attached file shows its NAME in the picker box and enables the form's Submit.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute path to the file to attach' },
        files: { type: 'array', items: { type: 'string' }, description: 'Several paths, for a multiple-file input' },
        selector: {
          type: 'string',
          description:
            'CSS selector of the file input (default: the first input[type=file] found, incl. shadow DOM + same-origin iframes)',
        },
        waitMs: {
          type: 'number',
          description:
            'Settle time after attaching, default 700 - React pickers re-render before the filename appears',
        },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
    },
    run: (params, caller) => upload(params, caller),
  },
]
