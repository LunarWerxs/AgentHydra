// server/src/core/login-sync-mirror.ts — this PC's copy of the login sync store's three lists
// (logins, queues, chats: id or pc, version, meta, updatedAt), kept current from the Worker's changes
// feed so a pass asks the store for what changed, not for every row of every table.
//
// refresh() with no cursor reads the three lists; the cursor is the lowest x-store-rev among them (the
// Worker reads the rev before the list, so that can only re-send a row, never miss one). With a cursor
// it reads GET /v1/changes?since=cursor, upserts the rows, drops the gone ids and moves the cursor.
// Anything the feed cannot answer (a Worker without the route, a list without x-store-rev, a refused
// request, {full: true}) drops the cursor and takes the first-pass path: the full lists, which is how
// sync worked before the feed. One mirror per store; every consumer of a pass shares it.

export type Table = 'logins' | 'queues' | 'chats'
type Reply = { status: number; json: any; rev?: number }
export type Call = (method: string, path: string) => Promise<Reply>
export interface MirrorRow {
  version: number
  meta?: any
  updatedAt?: number
  [k: string]: any
}

const TABLES: Array<{ name: Table; key: 'id' | 'pc' }> = [
  { name: 'logins', key: 'id' },
  { name: 'queues', key: 'pc' },
  { name: 'chats', key: 'id' },
]
const KEY = { logins: 'id', queues: 'pc', chats: 'id' } as const

/** A refresh younger than this is reused: consumers on separate timers share one request. */
export const MIRROR_FRESH_MS = 20_000

export type View = { ok: true; rows: MirrorRow[] } | { ok: false; reply: Reply }

export class StoreMirror {
  private rowsBy: Record<Table, Map<string, MirrorRow>> = {
    logins: new Map(),
    queues: new Map(),
    chats: new Map(),
  }
  private failed: Partial<Record<Table, Reply>> = {}
  /** Tables whose full list was read (or failed) and that the changes feed keeps current. */
  private listed = new Set<Table>()
  private cursor: number | null = null
  private at = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly call: Call) {}

  /** Bring `tables` (default: logins) up to date. `maxAgeMs` reuses a refresh at most that old (0:
   *  always ask); `full` reads the full lists whatever the cursor. Calls run one after another, so a
   *  second caller within the window finds the first one's answer. A table nobody asked for is never
   *  listed (a PC that shares no chats makes no chat request). */
  refresh(opts: { tables?: Table[]; maxAgeMs?: number; full?: boolean } = {}): Promise<void> {
    const tables = opts.tables ?? ['logins']
    const next = this.queue.then(() => {
      const covered = tables.every((t) => this.listed.has(t))
      if (!opts.full && covered && this.at && Date.now() - this.at < (opts.maxAgeMs ?? 0)) return
      return this.run(tables, opts.full === true)
    })
    this.queue = next.catch(() => {})
    return next
  }

  private async run(tables: Table[], full: boolean): Promise<void> {
    if (full) this.cursor = null
    if (this.cursor !== null && !(await this.applyChanges(this.cursor))) this.cursor = null
    if (this.cursor === null) {
      // The first pass, a fallback, or {full: true}: the lists of what is asked for.
      this.listed = new Set()
      this.failed = {}
      await this.readLists(tables, null)
    } else {
      const missing = tables.filter((t) => !this.listed.has(t))
      if (missing.length) await this.readLists(missing, this.cursor)
    }
    this.at = Date.now()
  }

  /** The feed's answer applied; false when it gave none (the caller then reads the lists). */
  private async applyChanges(since: number): Promise<boolean> {
    let r: Reply
    try {
      r = await this.call('GET', `/v1/changes?since=${since}`)
    } catch {
      return false
    }
    const j = r.json
    if (r.status !== 200 || j?.full === true || !Number.isInteger(j?.rev)) return false
    for (const g of Array.isArray(j.gone) ? j.gone : [])
      if (g?.table in KEY) this.rowsBy[g.table as Table].delete(g.id)
    for (const t of TABLES)
      for (const row of Array.isArray(j[t.name]) ? j[t.name] : [])
        this.rowsBy[t.name].set(row[t.key], row)
    this.cursor = j.rev
    return true
  }

  /** Full lists of `tables`. The cursor becomes the lowest rev among them and `cursor`; none (null)
   *  when a list failed or came without x-store-rev, so the next refresh reads the lists again. */
  private async readLists(tables: Table[], cursor: number | null): Promise<void> {
    let low = cursor
    let complete = true
    for (const t of TABLES.filter((x) => tables.includes(x.name))) {
      delete this.failed[t.name]
      this.listed.add(t.name)
      const res = await this.listOne(t.name, t.key)
      if (!res || res.rev < 0) complete = false
      else low = low === null ? res.rev : Math.min(low, res.rev)
    }
    this.cursor = complete ? low : null
  }

  /** One full list into the mirror; its rev (-1 when the header is missing), null when it failed. */
  private async listOne(name: Table, key: 'id' | 'pc'): Promise<{ rev: number } | null> {
    let r: Reply
    try {
      r = await this.call('GET', `/v1/${name}`)
    } catch (err) {
      r = { status: 0, json: { error: err instanceof Error ? err.message : String(err) } }
    }
    if (r.status !== 200 || !Array.isArray(r.json?.[name])) {
      this.failed[name] = r
      this.rowsBy[name] = new Map()
      return null
    }
    this.rowsBy[name] = new Map((r.json[name] as MirrorRow[]).map((row) => [row[key], row]))
    return { rev: typeof r.rev === 'number' && Number.isInteger(r.rev) ? r.rev : -1 }
  }

  /** The rows of one table as of the last refresh, ordered by id like the list route; or the store's
   *  refusal when that table's list failed. */
  view(table: Table): View {
    const reply = this.failed[table]
    if (reply) return { ok: false, reply }
    const key = KEY[table]
    const rows = [...this.rowsBy[table].values()].sort((a, b) =>
      String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0,
    )
    return { ok: true, rows }
  }
}
