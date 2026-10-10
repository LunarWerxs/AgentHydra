// The browser_live tool: the person's own open browser windows, driven through Windows UI Automation. Its request
// contract is request.ts and its engine is engine.ts; this file is the tag book and the answers a person reads.

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolReply } from '../agent/contract'
import { ToolInputError } from '../agent/errors'
import type { ToolDef } from '../agent/registry'
import { type EngineAnswer, runBrowserLiveEngine } from './engine'
import {
  BROWSER_LIVE_ACTIONS,
  BROWSER_LIVE_STEP_ACTIONS,
  BROWSER_LIVE_TARGETED,
  browserLiveRequest,
  type LiveError,
  type LiveRequest,
} from './request'
import {
  browserLiveFindTag,
  browserLiveProfileName,
  browserLiveRoot,
  browserLiveSameProfile,
  type LiveTag,
  type LiveWindowProfile,
  readLiveTags,
  writeLiveTags,
} from './tags'

const refusal = (code: string, detail: string, hint?: string): ToolInputError =>
  new ToolInputError([code, detail, hint].filter(Boolean).join('\n'))

const failure = (answer: EngineAnswer, fallback: string, extra = ''): ToolInputError =>
  refusal(
    String(answer.error || fallback),
    `${String(answer.detail || 'The engine gave no answer.')}${extra}`,
    answer.hint ? String(answer.hint) : undefined,
  )

function outlineText(out: EngineAnswer, head: boolean): string {
  const { outline, url, title, note, truncated, window: _window, id: _id, ...rest } = out
  const lines: string[] = []
  if (head) lines.push(JSON.stringify(rest, null, 2))
  if (outline || url) lines.push(`url: ${url || '(unknown)'}`, `title: ${title || ''}`, ...((outline as string[] | undefined) ?? []))
  if (note) lines.push(String(note))
  if (truncated) lines.push('(truncated: narrow with find, from or max)')
  return lines.join('\n')
}

async function runLive(args: Record<string, unknown>): Promise<ToolReply> {
  if (process.platform !== 'win32')
    throw refusal(
      'browser_live_windows_only',
      "browser_live drives the person's own browser through Windows UI Automation, so it runs on Windows only.",
      'Use the managed-profile browser_* tools (browser_profile_find first).',
    )
  const built = browserLiveRequest(args)
  if ('error' in built) {
    const [code, detail, hint] = built.error as LiveError
    throw refusal(code, detail, hint)
  }
  const request = built.request
  const book = readLiveTags()
  if (book.error && (request.action === 'tag' || request.action === 'untag'))
    throw refusal('browser_live_tags_unreadable', book.error)

  if (request.action === 'untag') return untagReply(book.tags, request)

  const tagged = typeof request.window === 'string' ? browserLiveFindTag(book.tags, request.window) : null
  if (tagged) {
    delete request.window
    request.profileMatch = { tag: tagged.tag, browser: tagged.browser, profileDir: tagged.profileDir, userDataDir: tagged.userDataDir || '' }
  }
  if (request.action === 'tag') return tagReply(book, request)

  if (request.action === 'screenshot' && !request.path)
    request.path = join(tmpdir(), `browser-live-${Date.now()}.${request.format === 'png' ? 'png' : 'jpg'}`)
  return answerOf(await runBrowserLiveEngine(request), request, book)
}

function untagReply(tags: LiveTag[], request: LiveRequest): string {
  const hit = browserLiveFindTag(tags, request.tag)
  if (!hit) throw refusal('browser_live_tag_not_found', `No browser is tagged '${String(request.tag)}'.`, 'action:list shows every tag.')
  writeLiveTags(tags.filter((t) => t !== hit))
  return JSON.stringify({ ok: true, removed: hit.tag, browser: hit.browser, profile: hit.profileName || hit.profileDir }, null, 2)
}

/** Names the profile of the window the engine identifies, and keeps the tag for it (a tag that moves profile says so). */
async function tagReply(book: ReturnType<typeof readLiveTags>, request: LiveRequest): Promise<string> {
  const who = await runBrowserLiveEngine({
    action: 'identify',
    ...(request.window ? { window: request.window } : {}),
    ...(request.profileMatch ? { profileMatch: request.profileMatch } : {}),
  })
  if (who.ok === false) throw failure(who, 'browser_live_failed')
  if (!who.profileDir)
    throw refusal(
      'browser_live_profile_unknown',
      `The ${String(who.browser)} window '${String(who.title)}' does not say which profile it belongs to, so a tag could never find it again.`,
      'Tag a normal browser window; app windows carry no profile.',
    )
  const browser = String(who.browser)
  const profileDir = String(who.profileDir)
  const userDataDir = String(who.userDataDir || '')
  const root = browserLiveRoot(browser, userDataDir)
  const entry: LiveTag = {
    tag: String(request.tag),
    browser,
    userDataDir,
    root,
    profileDir,
    profileName: browserLiveProfileName(root, profileDir),
    ...(request.note ? { note: String(request.note) } : {}),
    taggedAt: new Date().toISOString(),
  }
  const previous = browserLiveFindTag(book.tags, entry.tag)
  const tags = [...book.tags.filter((t) => t !== previous), entry]
  writeLiveTags(tags)
  return JSON.stringify(
    {
      ok: true,
      tag: entry.tag,
      browser,
      profile: entry.profileName || profileDir,
      profileDir,
      window: who.hwnd,
      ...(previous && !browserLiveSameProfile(previous, entry)
        ? { movedFrom: `${previous.browser} profile '${previous.profileName || previous.profileDir}'` }
        : {}),
      tagsOnThisBrowser: tags.filter((t) => browserLiveSameProfile(t, entry)).map((t) => t.tag),
      use: `browser_live { window: '${entry.tag}', ... } drives it; browser_profile_find { for: '${entry.tag}' } finds it.`,
    },
    null,
    2,
  )
}

/** What the engine answered, as the person reads it: the steps' outline, a screenshot, an outline, or the JSON. */
function answerOf(out: EngineAnswer, request: LiveRequest, book: ReturnType<typeof readLiveTags>): ToolReply {
  // steps answers every step it ran, the failed one included, and the page after; a failed step makes the call an
  // error that still carries what the steps before it did.
  if (request.action === 'steps' && Array.isArray(out.steps)) {
    const text = outlineText(out, true)
    if (out.ok === false) throw new ToolInputError(text)
    return text
  }
  if (out.ok === false) {
    const extra = out.requested != null ? ` (requested ${String(out.requested)}, landed ${String(out.landed)})` : ''
    throw failure(out, 'browser_live_failed', extra)
  }
  if (request.action === 'screenshot') return screenshotReply(out, request)
  if (request.action === 'read' || BROWSER_LIVE_TARGETED.has(request.action)) return outlineText(out, request.action !== 'read')
  if (request.action === 'list' && Array.isArray(out.windows)) tagWindows(out, book)
  return JSON.stringify(out, null, 2)
}

function screenshotReply(out: EngineAnswer, request: LiveRequest): ToolReply {
  const path = String(out.path)
  const data = readFileSync(path).toString('base64')
  const shown = Number(out.shownWidth)
  const size = shown
    ? `${shown}x${String(out.shownHeight)}px${Number(out.windowWidth) > shown ? ` of ${String(out.windowWidth)}x${String(out.windowHeight)}` : ''} ${String(request.format)}${request.format === 'png' ? '' : ` q${String(request.quality)}`}, `
    : ''
  return {
    text: `window ${String(out.window)}, ${size}saved to ${path}`,
    image: { data, mimeType: request.format === 'png' ? 'image/png' : 'image/jpeg' },
  }
}

/** The window list with each window's profile name and tags, and the tag book with which tags are open. */
function tagWindows(out: EngineAnswer, book: ReturnType<typeof readLiveTags>): void {
  const windows = out.windows as (LiveWindowProfile & { profile?: string; tags?: string[] })[]
  for (const w of windows) {
    if (!w.profileDir) continue
    w.profile = browserLiveProfileName(browserLiveRoot(w.browser, w.userDataDir), w.profileDir) || w.profileDir
    const mine = book.tags.filter((t) => browserLiveSameProfile(t, w)).map((t) => t.tag)
    if (mine.length) w.tags = mine
  }
  out.tags = book.tags.map((t) => ({
    tag: t.tag,
    browser: t.browser,
    profile: t.profileName || t.profileDir,
    open: windows.some((w) => Boolean(w.profileDir) && browserLiveSameProfile(t, w)),
    ...(t.note ? { note: t.note } : {}),
  }))
  if (book.error) out.tagsError = book.error
}

const ACTION_LIST = [...BROWSER_LIVE_ACTIONS]
const STEP_ACTION_LIST = [...BROWSER_LIVE_STEP_ACTIONS]

export const LIVE_TOOLS: ToolDef[] = [
  {
    name: 'browser_live',
    description:
      "Drive the person's OWN browser windows that are already open on this PC - their everyday Chrome, Edge or Brave with every login they have - through Windows accessibility. Nothing is installed in the browser, no debug port is opened, nothing leaves this machine. Use it when the site needs a login only the person's own browser holds; for everything else the managed-profile browser_* tools are the default. " +
      'Actions: list (every window and its tabs, which one is in front) · read (the front tab as an outline; each line carries a ref like [0.3.1]; narrow with find:\'text\' (find:\'Email|Password\' = either), from:\'<ref>\' or max) · open {url} (a NEW tab - it never navigates one of the person\'s tabs) · wait {text?, timeoutMs?} (until the page shows text) · click {ref | name + role?} · type {ref | name, text, commit?} (read back: a page that cuts the text answers browser_live_value_mismatch; commit:true then picks the matching suggestion or presses Enter, for a chip box such as an IP allow-list) · select {ref | name, option} · steps {steps:[{action, ref | name, role?, text?, option?, keys?, commit?, mouse?, keyboard?}]} (up to 30 click/type/select/key/wait steps in ONE call: stops at the first failure, answers every step, then the page) · activate {tab} (switch tabs by number, id or title) · key {keys} (SendKeys: {ENTER}, {TAB}, ^a; refused while focus sits in the browser itself, not the page, unless force:true) · paste {ref | name, text} (for a rich-text editor that type refuses: clicks the field, selects its content, pastes text in its place in one step, then puts the clipboard back as it was) · screenshot {detail?: quick | normal | fine | max} (the window as an image; you pick how sharp: quick for a glance, normal to read the page, fine for small print, max for native lossless; the reply says the size you got) · close (shuts every tab browser_live opened and puts the person\'s front tab back - ALWAYS finish with it) · tag {tag, window?, note?} (name the browser PROFILE of a window, e.g. \'work\', kept on this PC only; after that window:\'work\' picks it, open {window:\'work\'} starts it when closed, and browser_profile_find finds it) · untag {tag}. list shows each window\'s profile and tags. ' +
      'click, type, select and steps answer with the page as it stands after them (bounded by max, narrowed by find), so a separate read is rarely needed. Fill a form with ONE steps call, targeting fields by name + role: refs are paths into the page, an earlier step can move them, and a ref that now points at a different element than it showed is refused (browser_live_ref_gone). ' +
      'click and type act through accessibility, so the person keeps their mouse and keyboard; mouse:true / keyboard:true fall back to the real ones and bring the window to the front for a moment. Password fields are never typed or read - the person types those. Windows only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTION_LIST },
        window: { type: 'string', description: 'Which window: a tag (a window of that tagged profile), its number from list, or part of its title. Default: the browser window in front.' },
        tag: { type: 'string', description: "tag/untag: the name for this browser profile, e.g. 'work'." },
        note: { type: 'string', description: "tag: what this browser is, for the next AI, e.g. 'example-owner's everyday Chrome, signed in to the work accounts'." },
        tab: { type: 'string', description: "activate: the tab's number, id or part of its title." },
        url: { type: 'string', description: 'open: the http(s) address to open in a new tab.' },
        ref: { type: 'string', description: 'click/type/select: a ref from read, e.g. 0.3.1.' },
        name: { type: 'string', description: "click/type/select: the element's accessible name (exact match first, then contains)." },
        role: { type: 'string', description: 'With name: button, link, edit (textbox), checkbox, radio, combobox (select), tab, menuitem, listitem (option), text.' },
        text: { type: 'string', description: 'type: the text to put in the field (replaces what is there). paste: the text to paste.' },
        commit: { type: 'boolean', description: 'type: then commit the entry - pick the suggestion named exactly the text, else press Enter - for a creatable chip box (react-select style) that otherwise drops typed text.' },
        option: { type: 'string', description: 'select: the visible text of the choice.' },
        keys: { type: 'string', description: 'key: Windows SendKeys, e.g. {ENTER}, {TAB}, ^a.' },
        steps: {
          type: 'array',
          description:
            "steps: the steps to run in order in one call, each { action: click|type|select|key|paste|wait, ref | name, role?, text?, option?, keys?, commit?, mouse?, keyboard?, offsetX?, offsetY?, timeoutMs? }. They act in the call's window and tab.",
          items: { type: 'object', properties: { action: { type: 'string', enum: STEP_ACTION_LIST } }, required: ['action'] },
        },
        find: { type: 'string', description: "read, click, type, select, steps: only outline lines whose name contains this; 'a|b' = either. wait: the text to wait for is `text`." },
        from: { type: 'string', description: 'read, click, type, select, steps: start the outline at this ref (one panel of a page).' },
        max: { type: 'number', description: 'read, click, type, select, steps: most outline lines to return (default 250, max 1500).' },
        timeoutMs: { type: 'number', description: 'wait: how long to wait (default 15000).' },
        mouse: { type: 'boolean', description: 'click: fall back to a real mouse click when the element offers no accessible action.' },
        offsetX: { type: 'number', description: "click: real-mouse click this many screen pixels right of the element's left edge (negative = left of it), for a control with no accessible node of its own, such as a bare checkbox beside its label. Implies mouse:true." },
        offsetY: { type: 'number', description: "click: the same, down from the element's top edge (default: its vertical middle)." },
        keyboard: { type: 'boolean', description: 'type: fall back to real keystrokes when the field takes no accessible value.' },
        force: { type: 'boolean', description: 'close {tab}: also close a tab browser_live did not open - only when the person asked for it. key: send the keys even though focus is in the browser itself - only when the person asked for that.' },
        profileDirectory: { type: 'string', description: "open: the Chrome profile folder to open in, e.g. 'Profile 3' (default: the last one used)." },
        detail: { type: 'string', enum: ['quick', 'normal', 'fine', 'max'], description: 'screenshot: how sharp. quick 800px q45 (a glance) · normal 1800px q80 (default, text is readable) · fine 2600px q92 (small print, dense UI) · max the window\'s native size as lossless PNG. maxWidth, quality and format override it.' },
        maxWidth: { type: 'number', description: 'screenshot: downscale cap in pixels; default comes from detail.' },
        quality: { type: 'number', description: 'screenshot: JPEG quality 1-100; default comes from detail.' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'screenshot: jpeg (small) or png (lossless); default comes from detail.' },
        path: { type: 'string', description: 'screenshot: also keep the image at this path.' },
      },
      required: ['action'],
    },
    run: (params) => runLive(params),
  },
]
