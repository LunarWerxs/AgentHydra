// POST /api/browser/secret: the value-blind page ops Connections uses to fill and read a form: where (the page the caller
// has open), type (a vault value into one field on an allowed https host) and capture (field values). The values arrive in
// the request from Connections, which holds the vault; they are never logged, echoed in a reply, or put in an error.

import type { ToolCaller } from './contract'
import { ToolInputError } from './errors'
import { type Link, connect, knownPage } from './navigate'

export type SecretOp = 'where' | 'type' | 'capture'

export type FieldSpec = string | { selector: string; attr?: string }

export interface SecretRequest {
  op: SecretOp
  caller: ToolCaller
  profile?: string
  attachPort?: number
  name?: string
  value?: string
  hosts?: string[]
  selector?: string
  fields?: Record<string, FieldSpec>
}

export type SecretReply = { ok: true; [key: string]: unknown } | { ok: false; error: string; detail: string }

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/

/** Why a request must be refused, or null: a page's request (Origin or Referer) or one from off this machine. */
export function secretRefusal(headers: Headers, remote: string | null): string | null {
  if (headers.has('origin') || headers.has('referer')) return 'requests from a page are refused'
  if (!remote || !LOOPBACK.test(remote)) return 'only a process on this machine may call this'
  return null
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** A hosts entry as a host name: 'example.com', '*.example.com', or a URL whose host is taken. */
function patternHost(pattern: string): string {
  const p = pattern.trim().toLowerCase()
  if (!p.includes('://')) return p.replace(/\/.*$/, '').replace(/\.$/, '')
  return parseUrl(p)?.hostname ?? ''
}

/** Connections' rule (hostMatchesSecretDomain): 'example.com' is that host only, '*.example.com' it and its subdomains. */
function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  const p = patternHost(pattern)
  if (!h || !p) return false
  if (p.startsWith('*.')) {
    const base = p.slice(2)
    return base !== '' && (h === base || h.endsWith(`.${base}`))
  }
  return h === p
}

/**
 * The page is https (or http on this machine) and on one of the allowed hosts, by the same rule Connections checks
 * before it leases the value; a lookalike host is refused.
 */
export function hostCheck(
  url: string,
  hosts: string[],
): { ok: true; host: string } | { ok: false; error: 'not_https' | 'host_not_allowed'; detail: string } {
  const parsed = parseUrl(url)
  const host = parsed?.hostname.toLowerCase() ?? ''
  if (!parsed || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(host))))
    return { ok: false, error: 'not_https', detail: `the page at ${url} is not https` }
  if (!hosts.some((h) => hostMatches(host, h)))
    return { ok: false, error: 'host_not_allowed', detail: `the page at ${url} is not on an allowed host` }
  return { ok: true, host }
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function validate(req: SecretRequest): void {
  if (req.op === 'where') return
  if (req.op === 'type') {
    if (typeof req.name !== 'string' || req.name.trim() === '') throw new ToolInputError('name is required')
    if (typeof req.value !== 'string') throw new ToolInputError('value is required')
    if (!Array.isArray(req.hosts) || req.hosts.length === 0 || !req.hosts.every((h) => typeof h === 'string'))
      throw new ToolInputError('hosts must be a non-empty list of host names')
    if (typeof req.selector !== 'string' || req.selector.trim() === '') throw new ToolInputError('selector is required')
    return
  }
  if (req.op === 'capture') {
    if (!req.fields || typeof req.fields !== 'object' || Object.keys(req.fields).length === 0)
      throw new ToolInputError('fields must name at least one field')
    for (const [key, spec] of Object.entries(req.fields)) {
      const ok = typeof spec === 'string' || (typeof spec === 'object' && spec !== null && typeof spec.selector === 'string')
      if (!ok) throw new ToolInputError(`field ${key} needs a selector`)
    }
    return
  }
  throw new ToolInputError(`unknown op ${String(req.op)}: use where, type or capture`)
}

async function evaluate(link: Link, expression: string): Promise<unknown> {
  const res = (await link.send('Runtime.evaluate', { expression, returnByValue: true })) as { result?: { value?: unknown } }
  return res.result?.value
}

async function pageUrl(link: Link): Promise<string> {
  const url = await evaluate(link, 'location.href')
  return typeof url === 'string' ? url : ''
}

async function where(link: Link): Promise<SecretReply> {
  const url = await pageUrl(link)
  const parsed = parseUrl(url)
  return { ok: true, url, host: parsed?.hostname ?? '', https: parsed?.protocol === 'https:' }
}

async function typeSecret(link: Link, req: SecretRequest): Promise<SecretReply> {
  const hosts = req.hosts ?? []
  const selector = req.selector ?? ''
  const before = hostCheck(await pageUrl(link), hosts)
  if (!before.ok) return { ok: false, error: before.error, detail: before.detail }
  const focused = await evaluate(
    link,
    `(()=>{try{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'missing';if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA')return 'not_input';el.focus();try{el.select&&el.select();}catch{}return 'ok';}catch{return 'missing';}})()`,
  )
  if (focused === 'missing')
    return { ok: false, error: 'selector_not_found', detail: `no element on the top page matches ${JSON.stringify(selector)}` }
  if (focused === 'not_input')
    return { ok: false, error: 'not_an_input', detail: `${JSON.stringify(selector)} is not an input or textarea` }
  const url = await pageUrl(link)
  const check = hostCheck(url, hosts)
  if (!check.ok) return { ok: false, error: check.error, detail: check.detail }
  await link.send('Input.insertText', { text: req.value })
  return { ok: true, typed: `<secret>${req.name}</secret>`, url, host: check.host }
}

async function capture(link: Link, req: SecretRequest): Promise<SecretReply> {
  const url = await pageUrl(link)
  const parsed = parseUrl(url)
  const values: Record<string, string> = {}
  for (const [key, spec] of Object.entries(req.fields ?? {})) {
    const { selector, attr } = typeof spec === 'string' ? { selector: spec, attr: undefined } : spec
    const read = attr
      ? `el.getAttribute(${JSON.stringify(attr)})`
      : `('value' in el ? el.value : el.textContent)`
    const got = (await evaluate(
      link,
      `(()=>{try{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const raw=${read};return {v:raw==null?'':String(raw)};}catch{return null;}})()`,
    )) as { v: string } | null
    if (!got) return { ok: false, error: 'selector_not_found', detail: `field ${JSON.stringify(key)}: no element matches its selector` }
    if (got.v === '') return { ok: false, error: 'field_empty', detail: `field ${JSON.stringify(key)} is empty` }
    values[key] = got.v
  }
  return { ok: true, url, host: parsed?.hostname ?? '', values }
}

export async function runSecret(req: SecretRequest): Promise<SecretReply> {
  validate(req)
  const page = await knownPage({ profile: req.profile, attachPort: req.attachPort }, req.caller)
  if (!page)
    return { ok: false, error: 'no_page', detail: 'the caller has no page open in its browser; browser_navigate to the site first' }
  const link = await connect(`ws://127.0.0.1:${page.browser.port}/devtools/page/${page.targetId}`)
  try {
    if (req.op === 'where') return await where(link)
    if (req.op === 'type') return await typeSecret(link, req)
    return await capture(link, req)
  } finally {
    link.close()
  }
}
