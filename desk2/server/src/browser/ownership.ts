// Which of a profile's pages belong to which chat. Every chat of a workspace drives one shared Chrome; the Connections
// MCP gives each chat its own page and records who drives which in a ledger beside the profile (Desk only reads it):
//
//   <profile user-data-dir>/.connections-tabs.json   { v: 1, tabs: { '<CDP targetId>': { chat: '<owner>', at: '<ISO>' } } }
//
// `chat` is the Claude Code session id of the chat that drives the page (other forms, `mcp:...` or `pid:...`, are never
// a Desk chat's). A page the person opens from a chat's pane is that chat's in Desk's own memory (adopt), never written
// to the ledger. A page with no entry belongs to nobody and any chat may use it; a profile with no ledger has no
// owned pages, which is how every browser behaved before the ledger existed.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserTab } from '@shared/browser'
import { newPage, pageTabs } from './cdp'

export const TABS_LEDGER = '.connections-tabs.json'

interface Owned {
  chat: string
  at: number
}

/** Pages opened from a chat's pane, by profile folder then page id. */
const deskPages = new Map<string, Map<string, Owned>>()

/** The ledger's owners by page id (empty when the file is missing or unreadable). */
function readLedger(dir: string): Map<string, Owned> {
  const out = new Map<string, Owned>()
  try {
    const parsed = JSON.parse(readFileSync(join(dir, TABS_LEDGER), 'utf8')) as { tabs?: Record<string, { chat?: unknown; at?: unknown }> }
    for (const [id, row] of Object.entries(parsed?.tabs ?? {})) {
      if (typeof row?.chat !== 'string' || row.chat === '') continue
      const at = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN
      out.set(id, { chat: row.chat, at: Number.isFinite(at) ? at : 0 })
    }
  } catch {
    // floor-ok: no ledger (or a half-written one) means every page is unowned
  }
  return out
}

/** What one Desk chat may see of a profile's pages: its own and the unowned ones. */
export class TabScope {
  /**
   * @param dir the profile folder (where the ledger is)
   * @param chat the Desk chat's id
   * @param sessions its Claude session ids: the current one and the earlier ones it continued from
   */
  constructor(
    private readonly dir: string,
    readonly chat: string,
    private readonly sessions: readonly string[],
  ) {}

  /** The scope's identity for sharing frames: two sockets of one chat share, two chats never do. */
  get key(): string {
    return this.chat
  }

  private classify(tabs: BrowserTab[]): { tab: BrowserTab; state: 'mine' | 'none' | 'other'; at: number }[] {
    const mem = deskPages.get(this.dir)
    if (mem) for (const id of [...mem.keys()]) if (!tabs.some((t) => t.id === id)) mem.delete(id)
    const ledger = readLedger(this.dir)
    return tabs.map((tab) => {
      const desk = mem?.get(tab.id)
      if (desk) return { tab, state: desk.chat === this.chat ? 'mine' : 'other', at: desk.at }
      const row = ledger.get(tab.id)
      if (!row) return { tab, state: 'none', at: 0 }
      return { tab, state: this.sessions.includes(row.chat) ? 'mine' : 'other', at: row.at }
    })
  }

  /** The pages this chat may see, in the browser's order. */
  visible(tabs: BrowserTab[]): BrowserTab[] {
    return this.classify(tabs).filter((c) => c.state !== 'other').map((c) => c.tab)
  }

  /** The page to show: this chat's own with the newest `at`, else the first unowned one, else null. */
  best(tabs: BrowserTab[]): BrowserTab | null {
    const all = this.classify(tabs)
    let own: (typeof all)[number] | null = null
    for (const c of all) if (c.state === 'mine' && (!own || c.at > own.at)) own = c
    return own?.tab ?? all.find((c) => c.state === 'none')?.tab ?? null
  }

  /** Whether a page of `tabs` belongs to another chat. */
  isOther(tabs: BrowserTab[], id: string): boolean {
    return this.classify(tabs).some((c) => c.tab.id === id && c.state === 'other')
  }

  /** Records a page opened for this chat from Desk (memory only). */
  adopt(id: string): void {
    const mem = deskPages.get(this.dir) ?? new Map<string, Owned>()
    mem.set(id, { chat: this.chat, at: Date.now() })
    deskPages.set(this.dir, mem)
  }

  /** The page to show, opening a blank one for this chat when every open page belongs to another chat. */
  async pickOrOpen(port: number): Promise<BrowserTab | null> {
    const found = this.best(await pageTabs(port))
    if (found) return found
    const made = await newPage(port, 'about:blank')
    if (made) this.adopt(made.id)
    return made
  }
}

/** Where a `?tab=` a chat asked for stands: shown, not open, or another chat's. */
export async function askedTab(port: number, scope: TabScope | null, asked: string): Promise<{ tab: BrowserTab } | { error: string; status: 403 | 404 }> {
  const tabs = await pageTabs(port)
  const tab = tabs.find((t) => t.id === asked)
  if (!tab) return { error: 'that page is not open', status: 404 }
  if (scope?.isOther(tabs, asked)) return { error: 'that page belongs to another chat', status: 403 }
  return { tab }
}
