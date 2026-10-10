// The request browser_live hands the engine, or the refusal (code, detail, hint) that stops a call before it gets there.
// Pure, so the contract is testable with no browser: which actions exist, what each one needs, and which URLs open may take.

import { ToolInputError } from '../agent/errors'
import { screenshotSettings } from '../agent/page-tools'

export const BROWSER_LIVE_ACTIONS = new Set([
  'list', 'read', 'activate', 'open', 'wait', 'click', 'type', 'select', 'key', 'paste', 'screenshot', 'close', 'tag', 'untag', 'steps',
])
export const BROWSER_LIVE_TARGETED = new Set(['click', 'type', 'select', 'paste'])
export const BROWSER_LIVE_STEP_ACTIONS = new Set(['click', 'type', 'select', 'key', 'paste', 'wait'])
export const BROWSER_LIVE_MAX_STEPS = 30

const STRING_KEYS = ['window', 'tab', 'ref', 'name', 'role', 'option', 'keys', 'find', 'from', 'profileDirectory', 'url', 'path', 'note'] as const
const FLAG_KEYS = ['mouse', 'keyboard', 'force'] as const
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u

export type Args = Record<string, unknown>
export type LiveError = [code: string, detail: string, hint: string]

export interface LiveProfileMatch {
  tag: string
  browser: string
  profileDir: string
  userDataDir: string
}

export interface LiveRequest {
  action: string
  [key: string]: string | number | boolean | string[] | LiveRequest[] | LiveProfileMatch | undefined
}

export type Built = { request: LiveRequest } | { error: LiveError }

const refuse = (code: string, detail: string, hint = ''): Built => ({ error: [code, detail, hint] })

function parsesAsUrl(text: string): boolean {
  try {
    return Boolean(new URL(text).hostname)
  } catch {
    return false
  }
}

export function browserLiveRequest(args: Args = {}): Built {
  const action = String(args.action ?? '').trim().toLowerCase()
  if (!BROWSER_LIVE_ACTIONS.has(action))
    return refuse('browser_live_unknown_action', `Unknown action '${action}'.`, `Use one of: ${[...BROWSER_LIVE_ACTIONS].join(', ')}.`)
  const request: LiveRequest = { action }
  for (const key of STRING_KEYS) if (args[key] != null && String(args[key]) !== '') request[key] = String(args[key])
  const refused = tagRefusal(request, args, action) ?? screenshotRefusal(request, args, action)
  if (refused) return refused
  applyOptions(request, args, action)
  const missing = openRefusal(request, action) ?? requiredRefusal(request, action)
  if (missing) return missing
  if (action === 'steps') {
    const steps = stepsOf(args)
    if (!('steps' in steps)) return steps
    request.steps = steps.steps
  }
  return { request }
}

/** A tag or untag call's tag, cleaned and checked; the refusal when it is missing or not a usable name. */
function tagRefusal(request: LiveRequest, args: Args, action: string): Built | null {
  if (action !== 'tag' && action !== 'untag') return null
  const tag = String(args.tag ?? '').trim().replace(/\s+/g, ' ')
  if (!tag) return refuse('browser_live_tag_required', `${action} needs tag: a short name such as 'work' or 'example-owner'.`)
  if (tag.length > 40 || !TAG_PATTERN.test(tag))
    return refuse('browser_live_tag_invalid', `'${tag}' is not a usable tag.`, "Up to 40 letters, digits, spaces, dots, dashes, underscores or apostrophes, starting with a letter or digit.")
  request.tag = tag
  return null
}

/** A screenshot's size and format; the refusal when its settings are not usable. */
function screenshotRefusal(request: LiveRequest, args: Args, action: string): Built | null {
  if (action !== 'screenshot') return null
  let shot: ReturnType<typeof screenshotSettings>
  try {
    shot = screenshotSettings(args)
  } catch (e) {
    if (!(e instanceof ToolInputError)) throw e
    const [code = 'screenshot_detail_unknown', detail = '', hint = ''] = e.message.split('\n')
    return refuse(code, detail, hint)
  }
  request.maxWidth = shot.maxWidth
  request.quality = shot.quality
  request.format = shot.format
  return null
}

/** The numbers, flags and find list a call may carry, each cleaned as it is read. */
function applyOptions(request: LiveRequest, args: Args, action: string): void {
  if (typeof args.text === 'string') request.text = args.text
  for (const key of ['max', 'timeoutMs'] as const)
    if (args[key] != null && Number.isFinite(Number(args[key]))) request[key] = Number(args[key])
  for (const key of FLAG_KEYS) if (args[key] === true) request[key] = true
  if (action === 'type' && args.commit === true) request.commit = true
  if (typeof request.max === 'number') request.max = Math.min(Math.max(Math.round(request.max), 1), 1500)
  if (typeof request.find === 'string') {
    const parts = request.find
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length) request.find = parts
    else delete request.find
  }
  for (const key of ['offsetX', 'offsetY'] as const)
    if (args[key] != null && Number.isFinite(Number(args[key]))) request[key] = Math.min(Math.max(Math.round(Number(args[key])), -2000), 2000)
  if (request.offsetX != null || request.offsetY != null) request.mouse = true
}

/** An open call's URL: required, and only an http(s) web address. */
function openRefusal(request: LiveRequest, action: string): Built | null {
  if (action !== 'open') return null
  const url = typeof request.url === 'string' ? request.url : ''
  if (!url) return refuse('browser_live_url_required', 'open needs a url.', 'Pass the https:// address to open in a new tab.')
  if (!/^https?:\/\//i.test(url))
    return refuse('browser_live_url_refused', `open takes only an http(s) URL, not '${url}'.`, 'A file:, javascript:, data: or browser-internal URL is refused.')
  if (!parsesAsUrl(url)) return refuse('browser_live_url_refused', `'${url}' is not a whole web address.`, 'Pass a full https:// address with a host name.')
  return null
}

/** The field each action cannot run without; the refusal names it. */
function requiredRefusal(request: LiveRequest, action: string): Built | null {
  if (action === 'activate' && !request.tab)
    return refuse('browser_live_tab_required', 'activate needs tab: its number from action:list, its id, or part of its title.')
  if (BROWSER_LIVE_TARGETED.has(action) && !request.ref && !request.name)
    return refuse('browser_live_target_required', `${action} needs ref (from action:read) or name (+ role).`)
  if (action === 'type' && request.text == null) return refuse('browser_live_text_required', 'type needs text.')
  if (action === 'select' && !request.option) return refuse('browser_live_option_required', 'select needs option: the visible text of the choice.')
  if (action === 'key' && !request.keys) return refuse('browser_live_keys_required', 'key needs keys, in Windows SendKeys form: {ENTER}, {TAB}, ^a (Ctrl+A).')
  if (action === 'paste' && request.text == null) return refuse('browser_live_text_required', 'paste needs text.')
  return null
}

/** A steps call's list: at most BROWSER_LIVE_MAX_STEPS, each one a step action with no window or tab of its own. */
function stepsOf(args: Args): Built | { steps: LiveRequest[] } {
  const raw = Array.isArray(args.steps) ? (args.steps as unknown[]) : null
  if (!raw?.length)
    return refuse('browser_live_steps_required', "steps needs a list of steps, e.g. [{ action:'type', name:'Email', text:'user@example.test' }, { action:'click', name:'Save', role:'button' }].")
  if (raw.length > BROWSER_LIVE_MAX_STEPS)
    return refuse('browser_live_steps_too_many', `${raw.length} steps; one call takes at most ${BROWSER_LIVE_MAX_STEPS}.`, 'Split the list over two calls.')
  const steps: LiveRequest[] = []
  for (const [i, step] of raw.entries()) {
    const built = stepOf(step, `Step ${i + 1}: `)
    if ('error' in built) return built
    steps.push(built.request)
  }
  return { steps }
}

/** One entry of a steps call, built as a call of its own with the call's window and tab left to the steps call. */
function stepOf(step: unknown, label: string): Built {
  const s: Args = step && typeof step === 'object' ? (step as Args) : {}
  const stepAction = String(s.action ?? '').trim().toLowerCase()
  if (!BROWSER_LIVE_STEP_ACTIONS.has(stepAction))
    return refuse('browser_live_step_refused', `${label}'${stepAction}' cannot run inside steps.`, `A step is one of ${[...BROWSER_LIVE_STEP_ACTIONS].join(', ')}; open, close, activate and tag are calls of their own.`)
  if (s.window != null || s.tab != null)
    return refuse('browser_live_step_refused', `${label}a step acts in the call's window and tab, so it takes no window or tab of its own.`, 'Put window/tab on the steps call itself.')
  const built = browserLiveRequest({ ...s, action: stepAction })
  if ('error' in built) return refuse(built.error[0], `${label}${built.error[1]}`, built.error[2])
  delete built.request.max
  delete built.request.find
  delete built.request.from
  return built
}
