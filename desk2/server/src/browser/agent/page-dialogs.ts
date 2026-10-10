// A page's JavaScript dialogs (alert, confirm, prompt, beforeunload), answered the moment they open. An open dialog
// stops the page: the click that opened it does not return, and every later evaluate waits behind it until its
// command times out. So each agent page keeps a link with the Page domain on (navigate.ts `watchDialogs`), and it
// answers here. The idea is stablyai/orca's agent browser (MIT); this file is written fresh.
//
// alert and beforeunload are accepted (an alert has only OK; accepting beforeunload lets the navigation the agent
// asked for go on). confirm and prompt are dismissed: the agent never agreed to what a page asks. Each answer is
// kept per page, and browser_tab_errors reports them, so an agent can see why its click changed nothing.

export const DIALOGS_PER_PAGE_MAX = 20
const PAGES_MAX = 200
const MESSAGE_MAX = 300
const ACCEPTED = new Set(['alert', 'beforeunload'])

export interface PageDialog {
  type: string
  message: string
  url: string
  at: number
  answered: 'accepted' | 'dismissed' | 'failed'
}

type Send = (method: string, params: object) => Promise<unknown>

const answered = new Map<string, PageDialog[]>()

/** The handler a page link feeds its CDP events to: it answers a dialog as it opens and records the answer. */
export function dialogAnswerer(targetId: string, send: Send): (method: string, params: unknown) => void {
  return (method, params) => {
    if (method !== 'Page.javascriptDialogOpening') return
    const p = (params ?? {}) as { type?: unknown; message?: unknown; url?: unknown }
    const type = String(p.type ?? '')
    const accept = ACCEPTED.has(type)
    const dialog: PageDialog = {
      type,
      message: String(p.message ?? '').slice(0, MESSAGE_MAX),
      url: String(p.url ?? ''),
      at: Date.now(),
      answered: accept ? 'accepted' : 'dismissed',
    }
    remember(targetId, dialog)
    // Not awaited: the answer is a command on this same link, and the event handler must return first.
    send('Page.handleJavaScriptDialog', { accept }).catch(() => {
      dialog.answered = 'failed'
    })
  }
}

function remember(targetId: string, dialog: PageDialog): void {
  const ring = answered.get(targetId) ?? []
  answered.delete(targetId)
  answered.set(targetId, ring)
  ring.push(dialog)
  if (ring.length > DIALOGS_PER_PAGE_MAX) ring.splice(0, ring.length - DIALOGS_PER_PAGE_MAX)
  // Pages come and go for the life of the server; the least recently answered one is dropped first.
  if (answered.size > PAGES_MAX) answered.delete(answered.keys().next().value as string)
}

/** The dialogs answered on this page, oldest first. */
export function pageDialogs(targetId: string): PageDialog[] {
  return answered.get(targetId)?.slice() ?? []
}
