// cloud/login-sync-worker/worker.js — the cloud half of AgentHydra's login sync
// (server/src/core/cli-login-sync.ts, docs/CLIMAYTE.md "Login sync").
//
// A tiny store of encrypted CLI logins that the owner's PCs share. It never sees a login: each PC
// encrypts every login (AES-256-GCM) under a key the PCs keep, and this Worker stores the ciphertext
// with a version number. Writes are compare-and-swap on that version, so two PCs that change the same
// login at once cannot overwrite each other blindly: the second gets 409 and the current version.
//
// Bindings (set when it is deployed):
//   DB            a D1 database (strongly consistent, so a PC reads what the other just wrote)
//   HEAD          the StoreHead Durable Object (SQLite-backed, below): the store's head and the PCs'
//                 lastSeen, so an idle poll reads no D1
//   TOKEN_SHA256  hex SHA-256 of the access token the PCs send as `Authorization: Bearer <token>`.
//                 Only the hash lives here; the token itself stays on the PCs.
//   CHAT_STORE_MB optional: room for chat transcripts in MB of stored text, default 400. D1's free
//                 plan stops a whole database at 500 MB and the logins live in the same one, so chats
//                 stop short of that; on Workers Paid (10 GB per database) it can be raised.
//
// Routes (JSON in and out):
//   GET    /v1/health            {ok:true}, no token needed
//   GET    /v1/changes?since=n   {rev, logins, queues, chats, free, gone:[{table,id}]} changed after n,
//                                or {rev, full:true} when n is below the kept tombstones or above rev;
//                                304 to a matching If-None-Match. The asking PC names itself in
//                                x-agenthydra-pc; every answer carries x-seen: <pc>=<epoch ms>,...
//   GET    /v1/logins            {logins:[{id, version, meta, updatedAt}]}
//   GET    /v1/logins/:id        {id, version, blob, meta, updatedAt} | 404
//   PUT    /v1/logins/:id        {version, blob, meta}: stored as version+1 when `version` is the
//                                current one (0 for a new login) -> {version}; else 409 {current}
//   DELETE /v1/logins/:id?version=n   -> {ok:true} | 409
//   GET    /v1/queues            {queues:[{pc, version, meta, updatedAt}]}   (CliMayte queue snapshots,
//   GET    /v1/queues/:pc        {pc, version, blob, meta, updatedAt} | 404   one per PC, in their own
//   PUT    /v1/queues/:pc        {version, blob, meta} -> {version} | 409     table; blob up to 256 KB)
//   GET    /v1/chats             {chats:[{id, version, meta, updatedAt}]}   (desktop chat sync: one row
//   GET    /v1/chats/:id         {id, version, blob, meta, updatedAt} | 404  per chat, written like a
//   PUT    /v1/chats/:id         {version, blob, meta} -> {version} | 409     login; blob up to 256 KB)
//   DELETE /v1/chats/:id?version=n   -> {ok:true} | 409; the row's transcript (the chunks under its
//                                session, meta.s) goes with it once no other row shares that session
//   PUT    /v1/chats/:id/chunks/:seq {blob, by}: an append-only transcript piece, written once
//                                -> {seq}; 409 {error:'taken', next} when that seq exists;
//                                507 {error, used, room} when it would take chats past their room
//   GET    /v1/chats/:id/chunks?from=n  {chunks:[{seq, blob, by, createdAt}], next, more}
//   GET    /v1/free              {free:[{id, version, meta, updatedAt}]}   (Hydra Desk 2's Free web
//   GET    /v1/free/:id          {id, version, blob, meta, updatedAt}       logins, one row per Free
//   PUT    /v1/free/:id          {version, blob, meta} -> {version} | 409   instance, written like a
//   DELETE /v1/free/:id?version=n   -> {ok:true} | 409                     login; blob up to 64 KB)

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_META = 4 * 1024

// The two tables share one shape and one compare-and-swap write. `queues` holds each PC's CliMayte
// queue snapshot, keyed by that PC's id. It is a table of its own on purpose: an older AgentHydra
// lands every row of `logins` it does not know as a CLI login, so a queue there would become a junk
// login on that PC.
const LOGINS = { table: 'logins', key: 'id', maxBlob: 64 * 1024 }
const QUEUES = { table: 'queues', key: 'pc', maxBlob: 256 * 1024 }
const CHATS = { table: 'chats', key: 'id', maxBlob: 256 * 1024 }
// Hydra Desk 2's Free web logins (claude.ai, chatgpt.com), one row per Free instance. A table of their
// own for the reason `queues` has one: an AgentHydra that predates them would land each as a CLI login.
const FREE = { table: 'free', key: 'id', maxBlob: 64 * 1024 }
const LIST_NAME = { logins: 'logins', queues: 'queues', chats: 'chats', free: 'free' }

// chat transcript chunks: append-only, one row per (chat, seq), never changed once written
const MAX_CHUNK = 1048576
const MAX_SEQ = 1000000
const MAX_BY = 64
const MAX_PAGE_CHARS = 8000000
const CHAT_ROOM_MB = 400
const TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

const chatRoom = (env) => {
  const mb = Number(env.CHAT_STORE_MB)
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : CHAT_ROOM_MB) * 1048576)
}

// Bump when the schema below changes: a database at this PRAGMA user_version is not migrated again.
const SCHEMA_VERSION = 3
let schemaReady = false
async function ensureSchema(db) {
  if (schemaReady) return
  // One statement tells a cold isolate the database is current. If the PRAGMA is unavailable the
  // version reads as 0 and the migration below runs (idempotent), as it always did.
  const have = await db
    .prepare('PRAGMA user_version')
    .first()
    .then((r) => Number(r?.user_version) || 0)
    .catch(() => 0)
  if (have >= SCHEMA_VERSION) {
    schemaReady = true
    return
  }
  for (const t of [LOGINS, QUEUES, CHATS, FREE]) {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${t.table} (${t.key} TEXT PRIMARY KEY, version INTEGER NOT NULL, blob TEXT NOT NULL, meta TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0)`,
      )
      .run()
    // A table made before the changes feed has no rev column; its rows keep rev 0.
    const { results: cols } = await db.prepare(`PRAGMA table_info(${t.table})`).all()
    if (!(cols || []).some((c) => c.name === 'rev'))
      await db.prepare(`ALTER TABLE ${t.table} ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`).run()
    // Index on rev so WHERE rev > ? reads only the changed rows.
    await db.prepare(`CREATE INDEX IF NOT EXISTS ${t.table}_rev ON ${t.table}(rev)`).run()
  }
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, time INTEGER NOT NULL, PRIMARY KEY (table_name, id))',
    )
    .run()
  // The changes feed and the list check read tombstones by rev: without it each reads them all.
  await db.prepare('CREATE INDEX IF NOT EXISTS tombstones_rev ON tombstones(rev)').run()
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS store_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, floor INTEGER NOT NULL, logins_rev INTEGER NOT NULL DEFAULT 0, queues_rev INTEGER NOT NULL DEFAULT 0, chats_rev INTEGER NOT NULL DEFAULT 0, gone_rev INTEGER NOT NULL DEFAULT 0)',
    )
    .run()
  await db.prepare('INSERT OR IGNORE INTO store_rev (id, rev, floor) VALUES (1, 0, 0)').run()
  // The rev each table last changed at, kept beside the store rev so the check of a list is ONE row.
  // A store_rev made before them gets the columns, set once from the tables.
  const { results: revCols } = await db.prepare('PRAGMA table_info(store_rev)').all()
  if (!(revCols || []).some((c) => c.name === 'logins_rev')) {
    for (const t of [LOGINS, QUEUES, CHATS])
      await db
        .prepare(`ALTER TABLE store_rev ADD COLUMN ${t.table}_rev INTEGER NOT NULL DEFAULT 0`)
        .run()
    await db
      .prepare(
        'UPDATE store_rev SET logins_rev = COALESCE((SELECT MAX(rev) FROM logins), 0), queues_rev = COALESCE((SELECT MAX(rev) FROM queues), 0), chats_rev = COALESCE((SELECT MAX(rev) FROM chats), 0)',
      )
      .run()
  }
  // The rev of the newest tombstone, so a changes poll reads the tombstones only when one is past its
  // cursor. A store_rev without it gets the column, set once from the tombstones.
  if (
    !(await db.prepare('PRAGMA table_info(store_rev)').all()).results?.some(
      (c) => c.name === 'gone_rev',
    )
  ) {
    await db.prepare('ALTER TABLE store_rev ADD COLUMN gone_rev INTEGER NOT NULL DEFAULT 0').run()
    await db
      .prepare('UPDATE store_rev SET gone_rev = COALESCE((SELECT MAX(rev) FROM tombstones), 0)')
      .run()
  }
  // The Free table's rev, added after the others: its table is new with it, so it starts at 0.
  if (
    !(await db.prepare('PRAGMA table_info(store_rev)').all()).results?.some(
      (c) => c.name === 'free_rev',
    )
  )
    await db.prepare('ALTER TABLE store_rev ADD COLUMN free_rev INTEGER NOT NULL DEFAULT 0').run()
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS chat_chunks (chat TEXT NOT NULL, seq INTEGER NOT NULL, blob TEXT NOT NULL, by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat, seq))',
    )
    .run()
  // The characters every chunk holds, kept as one running total: summing the chunks on each write
  // would read every row of the table every time. Counted once, when the table is new.
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS chat_usage (id INTEGER PRIMARY KEY CHECK (id = 1), chars INTEGER NOT NULL)',
    )
    .run()
  if (!(await db.prepare('SELECT chars FROM chat_usage WHERE id = 1').first()))
    await db
      .prepare(
        'INSERT OR IGNORE INTO chat_usage (id, chars) SELECT 1, COALESCE(SUM(length(blob)), 0) FROM chat_chunks',
      )
      .run()
  // Prunes by time: without this index the prune reads every tombstone.
  await db.prepare('CREATE INDEX IF NOT EXISTS tombstones_time ON tombstones(time)').run()
  schemaReady = true
  await db
    .prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    .run()
    .catch(() => {})
}

// Cron (daily, see README): drop tombstones older than 30 days and raise floor to the highest rev
// dropped, so a cursor older than the kept tombstones is answered with full: true.
async function pruneTombstones(env, db) {
  const cutoff = Date.now() - TOMBSTONE_KEEP_MS
  // The floor may rise: like any write, it runs inside a head token and hands the new head back.
  await headWrite(env, async (told) => {
    const res = await db.batch([
      db
        .prepare(
          'UPDATE store_rev SET floor = MAX(floor, COALESCE((SELECT MAX(rev) FROM tombstones WHERE time < ?), 0)) WHERE id = 1',
        )
        .bind(cutoff),
      db.prepare('DELETE FROM tombstones WHERE time < ?').bind(cutoff),
      db.prepare(HEAD_SQL),
    ])
    told(res[2].results?.[0])
  })
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two equal-length hex strings. */
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function authorized(request, env) {
  const expected = (env.TOKEN_SHA256 || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) return false
  const header = request.headers.get('authorization') || ''
  const m = /^Bearer\s+(\S+)$/.exec(header)
  if (!m) return false
  return sameHex(await sha256Hex(m[1]), expected)
}

const row = (t, r) =>
  r && {
    [t.key]: r[t.key],
    version: r.version,
    meta: JSON.parse(r.meta),
    updatedAt: r.updated_at,
    ...(r.blob !== undefined ? { blob: r.blob } : {}),
  }

// The store's head, ONE row of store_rev: the rev, the floor and the rev each table last changed at.
// Every write bumps them in its own batch (storeRow, deleteRow), so together they name every change a
// list can show, and a table's list is unchanged while its rev and the floor are.
//
// The Worker asks for the head on every read route, so it is NOT read from D1 there: the StoreHead
// Durable Object (binding HEAD, one instance) holds it. Free-plan isolates are short-lived and two PCs
// land on different ones, so a head kept per isolate (or in the Cache API, a no-op on *.workers.dev)
// left most idle polls paying a D1 read. The Durable Object outlives them and keeps its head in its
// own storage, so an evicted one comes back with it and still reads no D1.
//
// THE RACE, and the choice made: the Worker writes D1 itself, and a write must never commit unseen by
// the head. So every write is bracketed (headWrite): before its batch the Worker asks the Durable
// Object for a token, which it stores durably as a pending write, and after the batch it hands back the
// token with the head that batch read after its commit. While ANY token is pending the Durable Object
// does not trust its copy: each head request reads store_rev from D1 (one statement) and keeps the
// higher of the two. So a lost, failed or crashed `end` (the Worker died, the request to the Durable
// Object was dropped, the batch threw with its outcome unknown) costs one D1 read per poll until it is
// cleared; it never hides the change. A token is cleared by its `end` with a head, or else by a D1 read
// started PENDING_MAX_MS after it began (a D1 batch gives up long before that, so whatever it did is in
// that read; a batch that threw may still have committed, so an `end` without a head clears nothing).
// A failed `begin` refuses the write (500), so no write runs without its token. Rejected alternative: re-reading D1 when the copy is older than a few
// minutes, which costs idle polls rows forever and still shows a change minutes late. A rev moved by
// hand-run SQL is not seen until the next write; reset the Durable Object with the database.
const HEAD_SQL =
  'SELECT rev, floor, logins_rev, queues_rev, chats_rev, free_rev, gone_rev FROM store_rev WHERE id = 1'
const HEAD_FIELDS = [
  'rev',
  'floor',
  'logins_rev',
  'queues_rev',
  'chats_rev',
  'free_rev',
  'gone_rev',
]
const NO_HEAD = {
  rev: 0,
  floor: 0,
  logins_rev: 0,
  queues_rev: 0,
  chats_rev: 0,
  free_rev: 0,
  gone_rev: 0,
}
const PENDING_MAX_MS = 2 * 60 * 1000

// The characters the chat chunks hold (the chat_usage row), kept in the Durable Object too so a chunk
// write checks the room without reading D1. D1 stays the truth: each write's batch returns the new
// total and hands it back (usageSet), and a copy older than USAGE_KEEP_MS, or none, is read from D1
// once. A lost usageSet leaves the copy short until then; the room check is a limit, not a ledger.
const USAGE_KEEP_MS = 60 * 60 * 1000
const usageUsed = async (env, db) => {
  const kept = await askHead(env, 'usage').catch(() => null)
  if (Number.isFinite(kept?.chars)) return kept.chars
  const chars = (await db.prepare('SELECT chars FROM chat_usage WHERE id = 1').first())?.chars ?? 0
  await askHead(env, 'usageSet', { chars }).catch(() => {})
  return chars
}
const usageNow = (env, chars) =>
  Number.isFinite(chars) ? askHead(env, 'usageSet', { chars }).catch(() => {}) : undefined

// LIVENESS: each PC names itself on every /v1/changes poll (x-agenthydra-pc, its queue id). The Durable
// Object stamps lastSeen[pc] in memory on every poll and saves it to its storage when that PC's saved
// stamp is SEEN_SAVE_MS old (an idle Durable Object is evicted between polls minutes apart, so a save
// timed from its own start would never come), so an evicted one loses at most that much. Every /v1/changes answer, 304 included,
// carries the OTHER PCs' stamps in x-seen (`<pc>=<epoch ms>,...`): a PC reads the other as alive from its
// polls, and no longer uploads its queue every 15 minutes just to say so. A PC not seen for
// SEEN_KEEP_MS is forgotten.
const SEEN_SAVE_MS = 3 * 60 * 1000
const SEEN_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const SEEN_MAX = 32

const higherHead = (a, b) => {
  if (!a) return b
  if (!b) return a
  const out = {}
  for (const f of HEAD_FIELDS) out[f] = Math.max(Number(a[f]) || 0, Number(b[f]) || 0)
  return out
}
const isHead = (h) => !!h && HEAD_FIELDS.every((f) => Number.isInteger(h[f]))

export class StoreHead {
  constructor(ctx, env) {
    this.storage = ctx.storage
    this.env = env
    this.head = null
    this.pending = new Map() // token -> the time its write began
    this.seen = {}
    this.savedSeen = {}
    this.ready = this.load()
  }

  async load() {
    const [head, pending, seen, usage] = await Promise.all([
      this.storage.get('head'),
      this.storage.get('pending'),
      this.storage.get('seen'),
      this.storage.get('usage'),
    ])
    this.head = isHead(head) ? head : null
    this.pending = new Map(Object.entries(pending ?? {}))
    this.seen = seen ?? {}
    this.usage = usage ?? null
    this.savedSeen = { ...this.seen }
  }

  savePending() {
    return this.storage.put('pending', Object.fromEntries(this.pending))
  }

  async fetch(request) {
    await this.ready
    const op = new URL(request.url).pathname.slice(1)
    const body = await request.json().catch(() => ({}))
    if (op === 'head') {
      const head = await this.current()
      return json({ head, seen: await this.stamp(body?.pc) })
    }
    if (op === 'begin') {
      const token = crypto.randomUUID()
      this.pending.set(token, Date.now())
      await this.savePending()
      return json({ token })
    }
    if (op === 'end') {
      if (isHead(body?.head)) {
        this.head = higherHead(this.head, body.head)
        await this.storage.put('head', this.head)
        this.pending.delete(body.token)
        await this.savePending()
      }
      return json({ ok: true })
    }
    if (op === 'usage') {
      const u = this.usage
      const fresh = u && Date.now() - u.at >= 0 && Date.now() - u.at < USAGE_KEEP_MS
      return json({ chars: fresh ? u.chars : null })
    }
    if (op === 'usageSet') {
      if (Number.isFinite(body?.chars) && body.chars >= 0) {
        this.usage = { chars: body.chars, at: Date.now() }
        await this.storage.put('usage', this.usage)
      }
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }

  // The head: its own copy while no write is pending, else D1's (kept the higher, field by field, since
  // a write may have ended with a newer head while the read was out).
  async current() {
    if (this.head && this.pending.size === 0) return this.head
    const startedAt = Date.now()
    await ensureSchema(this.env.DB)
    const row = await this.env.DB.prepare(HEAD_SQL).first()
    this.head = higherHead(this.head, row ?? NO_HEAD)
    await this.storage.put('head', this.head)
    let cleared = false
    for (const [token, at] of this.pending)
      if (at < startedAt - PENDING_MAX_MS) {
        this.pending.delete(token)
        cleared = true
      }
    if (cleared) await this.savePending()
    return this.head
  }

  // Stamp `pc` as seen now and answer the other PCs' stamps.
  async stamp(pc) {
    const now = Date.now()
    const known = typeof pc === 'string' && ID_RE.test(pc)
    if (known) this.seen[pc] = now
    if (known && !(now - (this.savedSeen[pc] ?? 0) < SEEN_SAVE_MS)) {
      const kept = Object.entries(this.seen)
        .filter(([, at]) => now - at < SEEN_KEEP_MS)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SEEN_MAX)
      this.seen = Object.fromEntries(kept)
      this.savedSeen = { ...this.seen }
      await this.storage.put('seen', this.seen)
    }
    const others = {}
    for (const [id, at] of Object.entries(this.seen)) if (id !== pc) others[id] = at
    return others
  }
}

async function askHead(env, op, body = {}) {
  const res = await env.HEAD.get(env.HEAD.idFromName('head')).fetch(`https://head/${op}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`store head ${op}: ${res.status}`)
  return res.json()
}

// {head, seen}: the authoritative head, and the other PCs' lastSeen (stamping `pc` when given).
const headOf = (env, pc) => askHead(env, 'head', pc ? { pc } : {})

// Run one write batch inside its pending token (see THE RACE above). `run` gets `told(head)` to pass
// the head its batch read after the commit. Without one (the batch threw) the token is left to expire.
async function headWrite(env, run) {
  const { token } = await askHead(env, 'begin')
  let head = null
  const out = await run((h) => {
    head = isHead(h) ? h : null
  })
  // floor-ok: a lost end leaves the token pending, which only makes polls read the D1 head until it clears
  if (head) await askHead(env, 'end', { token, head }).catch(() => {})
  return out
}

// Each list, kept in this isolate while its table has not changed. A PC listing a table every 30 s
// paid for every row of it each time; a list that has not changed now costs nothing (the head comes
// from the StoreHead Durable Object), and one that changed reads only its changed rows (by rev, as the
// changes feed does) and the tombstones after them. A list is read whole when this isolate has none,
// when old tombstones were dropped since it (below the floor), and after LIST_KEEP_MS anyway, so a row
// changed by hand-run SQL (which moves no rev) shows within hours; redeploying shows it at once.
const LIST_KEEP_MS = 6 * 60 * 60 * 1000
const listCache = new Map()
const stampOf = (head, t) => `${head[`${t.table}_rev`]}/${head.floor}`

// GET /v1/logins, GET /v1/queues, GET /v1/chats — the shared list, without the encrypted blobs. The
// head is asked before the rows are read and sent as x-store-rev, so a client can start its changes
// cursor there without missing a write: a row newer than it only shows in the list early, and the
// cursor re-sends it at worst.
async function listRows(env, db, t) {
  const now = Date.now()
  const kept = listCache.get(t.table)
  const fresh = kept && now - kept.fullAt >= 0 && now - kept.fullAt < LIST_KEEP_MS
  const { head } = await headOf(env)
  if (fresh && kept.stamp === stampOf(head, t)) return listResponse(kept.body, head.rev)

  await ensureSchema(db)
  const sel = `SELECT ${t.key}, version, meta, updated_at FROM ${t.table}`
  if (fresh && kept.rev >= head.floor && kept.rev <= head.rev) {
    const [changed, tombs] = await db.batch([
      db.prepare(`${sel} WHERE rev > ? ORDER BY rev`).bind(kept.rev),
      db.prepare('SELECT table_name, id FROM tombstones WHERE rev > ? ORDER BY rev').bind(kept.rev),
    ])
    const rows = new Map(kept.rows)
    for (const r of tombs.results || []) if (r.table_name === t.table) rows.delete(r.id)
    for (const r of changed.results || []) rows.set(r[t.key], row(t, r))
    return keepList(t, head, rows, kept.fullAt)
  }
  const { results } = await db.prepare(`${sel} ORDER BY ${t.key}`).all()
  const rows = new Map((results || []).map((r) => [r[t.key], row(t, r)]))
  return keepList(t, head, rows, now)
}

function keepList(t, snapshot, rows, fullAt) {
  const key = t.key
  const sorted = [...rows.values()].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0))
  const body = JSON.stringify({ [LIST_NAME[t.table]]: sorted })
  listCache.set(t.table, { stamp: stampOf(snapshot, t), rev: snapshot.rev, rows, body, fullAt })
  return listResponse(body, snapshot.rev)
}

const listResponse = (body, rev) =>
  new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-store-rev': String(rev),
    },
  })

// GET /v1/logins/:id, GET /v1/queues/:pc, GET /v1/chats/:id — one stored row, blob included. The rows
// this isolate served are kept (a few, ITEMS_KEPT) under the table's stamp: asked again while that
// table has not changed, a row is answered from memory. An older client asks for the same few rows
// every poll and each of those was a row read.
const ITEMS_KEPT = 24
const itemCache = new Map()
async function fetchRow(env, db, t, id) {
  const path = `${t.table}/${id}`
  const kept = itemCache.get(path)
  const { head } = await headOf(env)
  const age = kept ? Date.now() - kept.at : -1
  if (kept && age >= 0 && age < LIST_KEEP_MS && kept.stamp === stampOf(head, t))
    return json(kept.body)
  await ensureSchema(db)
  const r = await db
    .prepare(`SELECT ${t.key}, version, blob, meta, updated_at FROM ${t.table} WHERE ${t.key} = ?`)
    .bind(id)
    .first()
  itemCache.delete(path)
  if (!r) return json({ error: 'not found' }, 404)
  const body = row(t, r)
  itemCache.set(path, { at: Date.now(), stamp: stampOf(head, t), body })
  if (itemCache.size > ITEMS_KEPT) itemCache.delete(itemCache.keys().next().value)
  return json(body)
}

const NEXT_REV = '(SELECT rev FROM store_rev WHERE id = 1)'

// parse the PUT body and run the compare-and-swap write: version 0 inserts (losing a
// concurrent insert), a matching version updates atomically, anything else returns 409
// with the current version so the PCs can retry. The rev bump, the row write and the tombstone
// clean-up are ONE batch whose statements only act while the compare-and-swap still holds, so a
// refused write changes nothing, rev included. The batch runs inside a head token (headWrite).
async function storeRow(env, db, t, id, body) {
  const version = Number(body?.version)
  const blob = body?.blob
  const meta = JSON.stringify(body?.meta ?? {})
  if (!Number.isInteger(version) || version < 0) return json({ error: 'bad version' }, 400)
  if (typeof blob !== 'string' || !blob || blob.length > t.maxBlob)
    return json({ error: 'bad blob' }, 400)
  if (meta.length > MAX_META) return json({ error: 'meta too large' }, 400)
  const now = Date.now()
  const has = `EXISTS (SELECT 1 FROM ${t.table} WHERE ${t.key} = ?`

  return headWrite(env, async (told) => {
    const results =
      version === 0
        ? await db.batch([
            db
              .prepare(
                `UPDATE store_rev SET rev = rev + 1, ${t.table}_rev = rev + 1 WHERE id = 1 AND NOT ${has})`,
              )
              .bind(id),
            db
              .prepare(
                `INSERT INTO ${t.table} (${t.key}, version, blob, meta, updated_at, rev) SELECT ?, 1, ?, ?, ?, rev FROM store_rev WHERE id = 1 AND NOT ${has})`,
              )
              .bind(id, blob, meta, now, id),
            db
              .prepare(`DELETE FROM tombstones WHERE table_name = ? AND id = ? AND ${has})`)
              .bind(t.table, id, id),
            db.prepare(HEAD_SQL),
          ])
        : await db.batch([
            db
              .prepare(
                `UPDATE store_rev SET rev = rev + 1, ${t.table}_rev = rev + 1 WHERE id = 1 AND ${has} AND version = ?)`,
              )
              .bind(id, version),
            db
              .prepare(
                `UPDATE ${t.table} SET version = version + 1, blob = ?, meta = ?, updated_at = ?, rev = ${NEXT_REV} WHERE ${t.key} = ? AND version = ?`,
              )
              .bind(blob, meta, now, id, version),
            db.prepare(HEAD_SQL),
          ])

    told(results[results.length - 1].results?.[0])
    if ((results[1]?.meta?.changes ?? 0) === 1) return json({ version: version + 1 })

    const current = await db
      .prepare(`SELECT ${t.key}, version, meta, updated_at FROM ${t.table} WHERE ${t.key} = ?`)
      .bind(id)
      .first()
    return json({ error: 'version conflict', current: row(t, current) ?? null }, 409)
  })
}

// The compare-and-swap delete of a logins or chats row: bump rev, leave a tombstone at that rev and
// delete the row, in one batch whose statements only act while `version` is still the current one.
// Resolves to the deleted row's meta, or null when the delete was refused (nothing changed).
async function deleteRow(env, db, t, id, version) {
  const has = `EXISTS (SELECT 1 FROM ${t.table} WHERE ${t.key} = ? AND version = ?)`
  return headWrite(env, async (told) => {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE store_rev SET rev = rev + 1, ${t.table}_rev = rev + 1, gone_rev = rev + 1 WHERE id = 1 AND ${has}`,
        )
        .bind(id, version),
      db
        .prepare(
          `INSERT OR REPLACE INTO tombstones (table_name, id, rev, time) SELECT ?, ?, rev, ? FROM store_rev WHERE id = 1 AND ${has}`,
        )
        .bind(t.table, id, Date.now(), id, version),
      db
        .prepare(`DELETE FROM ${t.table} WHERE ${t.key} = ? AND version = ? RETURNING meta`)
        .bind(id, version),
      db.prepare(HEAD_SQL),
    ])
    told(results[3].results?.[0])
    return results[2]?.results?.[0] ?? null
  })
}

// DELETE /v1/logins/:id, DELETE /v1/free/:id — remove only when `version` is the current one.
async function deleteLogin(env, db, t, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)
  return (await deleteRow(env, db, t, id, version))
    ? json({ ok: true })
    : json({ error: 'version conflict' }, 409)
}

// DELETE /v1/chats/:id — the row delete is the compare-and-swap; the transcript goes only after it
// won. A transcript lives under the chat's session (meta.s), which two rows can share (a chat moved
// between profiles), so it stays while another row still reads it.
async function deleteChat(env, db, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)
  const gone = await deleteRow(env, db, CHATS, id, version)
  if (!gone) return json({ error: 'version conflict' }, 409)

  let session = null
  try {
    session = JSON.parse(gone.meta)?.s
  } catch {}
  if (typeof session !== 'string' || !ID_RE.test(session)) return json({ ok: true })
  const shared = await db
    .prepare("SELECT 1 FROM chats WHERE json_extract(meta, '$.s') = ? LIMIT 1")
    .bind(session)
    .first()
  if (shared) return json({ ok: true })
  const freed = await db
    .prepare('SELECT COALESCE(SUM(length(blob)), 0) AS n FROM chat_chunks WHERE chat = ?')
    .bind(session)
    .first()
  await db.prepare('DELETE FROM chat_chunks WHERE chat = ?').bind(session).run()
  takenKept.delete(session)
  const left = await db
    .prepare('UPDATE chat_usage SET chars = MAX(0, chars - ?) WHERE id = 1 RETURNING chars')
    .bind(freed?.n ?? 0)
    .first()
  await usageNow(env, left?.chars)
  return json({ ok: true })
}

// Chunk seqs this isolate learned are already stored, per chat, for TAKEN_KEEP_MS. A client whose first
// chunk was refused as taken sends it again every poll (it cannot take the chat's stored copy), and
// each refusal read the usage total and the chat's top seq: the same two rows for the same answer.
// Chunks are written once and never changed, so a seq that was stored stays stored while its transcript
// does; deleteChat drops the entry. The room check and the insert still run for a seq not known stored.
const TAKEN_KEEP_MS = 15 * 60 * 1000
const TAKEN_MAX_CHATS = 200
const takenKept = new Map()
const rememberTaken = (chat, seq, next) => {
  const kept = takenKept.get(chat)
  const entry =
    kept && Date.now() - kept.at < TAKEN_KEEP_MS ? kept : { at: Date.now(), seqs: new Set() }
  entry.seqs.add(seq)
  entry.next = next
  takenKept.delete(chat)
  takenKept.set(chat, entry)
  if (takenKept.size > TAKEN_MAX_CHATS) takenKept.delete(takenKept.keys().next().value)
}
const knownTaken = (chat, seq) => {
  const kept = takenKept.get(chat)
  if (!kept) return null
  if (Date.now() - kept.at >= TAKEN_KEEP_MS || Date.now() < kept.at) {
    takenKept.delete(chat)
    return null
  }
  return kept.seqs.has(seq) ? kept : null
}

// Where a chat's chunks end, as the answer to a taken seq.
async function takenAnswer(db, id, seq) {
  const top = await db
    .prepare('SELECT MAX(seq) AS top FROM chat_chunks WHERE chat = ?')
    .bind(id)
    .first()
  const next = (top?.top ?? -1) + 1
  rememberTaken(id, seq, next)
  return json({ error: 'taken', next }, 409)
}

// PUT /v1/chats/:id/chunks/:seq — insert once; a taken seq answers where the chat's chunks end, and a
// chunk that would take chats past their room is refused before it is written. A request that stores
// nothing (the seq is already there) reads neither the usage total nor anything it need not.
async function putChunk(request, db, env, id, seq) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'body must be JSON' }, 400)
  }
  const blob = body?.blob
  const by = body?.by ?? ''
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return json({ error: 'bad seq' }, 400)
  if (typeof blob !== 'string' || !blob || blob.length > MAX_CHUNK)
    return json({ error: 'bad blob' }, 400)
  if (typeof by !== 'string' || by.length > MAX_BY) return json({ error: 'bad by' }, 400)
  const known = knownTaken(id, seq)
  if (known) return json({ error: 'taken', next: known.next }, 409)
  const stored = await db
    .prepare('SELECT 1 AS x FROM chat_chunks WHERE chat = ? AND seq = ?')
    .bind(id, seq)
    .first()
  if (stored) return takenAnswer(db, id, seq)
  const used = await usageUsed(env, db)
  const room = chatRoom(env)
  if (used + blob.length > room) return json({ error: 'no room for more chats', used, room }, 507)
  // The insert and the counter are one batch: the counter moves only when the chunk was stored.
  const [result, total] = await db.batch([
    db
      .prepare(
        'INSERT INTO chat_chunks (chat, seq, blob, by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat, seq) DO NOTHING',
      )
      .bind(id, seq, blob, by, Date.now()),
    db
      .prepare(
        'UPDATE chat_usage SET chars = chars + ? WHERE id = 1 AND changes() = 1 RETURNING chars',
      )
      .bind(blob.length),
  ])
  if ((result?.meta?.changes ?? 0) === 1) {
    await usageNow(env, total?.results?.[0]?.chars)
    takenKept.delete(id)
    return json({ seq })
  }
  return takenAnswer(db, id, seq)
}

// GET /v1/chats/:id/chunks?from=n — chunks in seq order, one page of at most ~8,000,000 characters.
// Sizes first, blobs for this page only: a long chat's whole transcript (hundreds of MB) never sits
// in the Worker's 128 MB at once.
async function listChunks(db, id, fromParam) {
  const from = fromParam === null ? 0 : Number(fromParam)
  if (!Number.isInteger(from) || from < 0) return json({ error: 'bad from' }, 400)
  const { results: sizes } = await db
    .prepare(
      'SELECT seq, length(blob) AS n FROM chat_chunks WHERE chat = ? AND seq >= ? ORDER BY seq',
    )
    .bind(id, from)
    .all()
  const all = sizes || []
  let chars = 0
  let count = 0
  for (const r of all) {
    if (count && chars > MAX_PAGE_CHARS) break
    chars += r.n
    count++
  }
  if (!count) return json({ chunks: [], next: from, more: false })
  const last = all[count - 1].seq
  const { results } = await db
    .prepare(
      'SELECT seq, blob, by, created_at FROM chat_chunks WHERE chat = ? AND seq >= ? AND seq <= ? ORDER BY seq',
    )
    .bind(id, from, last)
    .all()
  const chunks = (results || []).map((r) => ({
    seq: r.seq,
    blob: r.blob,
    by: r.by,
    createdAt: r.created_at,
  }))
  return json({ chunks, next: last + 1, more: count < all.length })
}

async function putRow(request, env, db, t, id) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'body must be JSON' }, 400)
  }
  return storeRow(env, db, t, id, body)
}

const changed = (t, r) => ({
  [t.key]: r[t.key],
  version: r.version,
  meta: JSON.parse(r.meta),
  updatedAt: r.updated_at,
})

// GET /v1/changes?since=<n> — what changed after cursor n. The head comes from the StoreHead Durable
// Object, so a cursor equal to it is answered with no D1 statement at all (no schema check either).
// Behind it, the changed rows and the tombstones come from ONE batch; full: true when n is older than
// the kept tombstones (below floor) or newer than the store (it was reset). Each query is in rev order
// so it walks the rev index from n and reads only the changed rows.
//
// The cursor is also the ETag ("<rev>"). A client that sends If-None-Match: "<rev>" with since=<rev>
// gets 304 (no body) while the store is still at that rev. The head is asked before the rows are read,
// so a row newer than it is re-sent at worst, never missed. A client that sends no If-None-Match gets
// the same 200 bodies as ever. Every answer carries x-seen (see LIVENESS), stamping the asking PC.
const etagOf = (rev) => `"${rev}"`
const matchesEtag = (request, rev) =>
  (request.headers.get('if-none-match') || '')
    .split(',')
    .some((v) => v.trim().replace(/^W\//, '') === etagOf(rev))
const seenHeader = (seen) =>
  Object.entries(seen || {})
    .map(([pc, at]) => `${pc}=${at}`)
    .join(',')
const changesJson = (body, seen) => {
  const res = json(body)
  res.headers.set('etag', etagOf(body.rev))
  res.headers.set('x-seen', seenHeader(seen))
  return res
}
const idleChanges = (request, rev, seen) =>
  matchesEtag(request, rev)
    ? new Response(null, {
        status: 304,
        headers: { etag: etagOf(rev), 'cache-control': 'no-store', 'x-seen': seenHeader(seen) },
      })
    : changesJson({ rev, logins: [], queues: [], chats: [], free: [], gone: [] }, seen)

async function getChanges(request, env, db, sinceParam) {
  const since = Number(sinceParam)
  if (sinceParam === null || sinceParam === '' || !Number.isInteger(since))
    return json({ error: 'bad since' }, 400)
  const pc = request.headers.get('x-agenthydra-pc')
  const { head, seen } = await headOf(env, pc && ID_RE.test(pc) ? pc : null)
  const { rev, floor } = head
  if (since === rev) return idleChanges(request, rev, seen)
  if (since < floor || since > rev) return changesJson({ rev, full: true }, seen)
  // A table is read only when its rev in the head is past the cursor: after one chat write the poll
  // runs the chats query, not all four. A table not read answers [] exactly as an empty read would.
  const wanted = [
    [LOGINS, 'logins', head.logins_rev],
    [QUEUES, 'queues', head.queues_rev],
    [CHATS, 'chats', head.chats_rev],
    [FREE, 'free', head.free_rev],
  ].filter(([, , at]) => at > since)
  const goneNew = head.gone_rev > since
  const out = { rev, logins: [], queues: [], chats: [], free: [], gone: [] }
  if (wanted.length || goneNew) {
    await ensureSchema(db)
    const stmts = wanted.map(([t]) =>
      db
        .prepare(
          `SELECT ${t.key}, version, meta, updated_at FROM ${t.table} WHERE rev > ? ORDER BY rev`,
        )
        .bind(since),
    )
    if (goneNew)
      stmts.push(
        db.prepare('SELECT table_name, id FROM tombstones WHERE rev > ? ORDER BY rev').bind(since),
      )
    const res = await db.batch(stmts)
    wanted.forEach(([t, name], i) => {
      out[name] = (res[i].results || []).map((r) => changed(t, r))
    })
    if (goneNew)
      out.gone = (res[wanted.length].results || []).map((r) => ({ table: r.table_name, id: r.id }))
  }
  return changesJson(out, seen)
}

function routeList(env, db, path) {
  const tables = {
    '/v1/logins': LOGINS,
    '/v1/queues': QUEUES,
    '/v1/chats': CHATS,
    '/v1/free': FREE,
  }
  return tables[path] ? listRows(env, db, tables[path]) : null
}

function routeChunks(request, db, env, url, match) {
  if (!ID_RE.test(match[1])) return json({ error: 'bad id' }, 400)
  if (match[2] === undefined && request.method === 'GET')
    return listChunks(db, match[1], url.searchParams.get('from'))
  if (match[2] !== undefined && request.method === 'PUT')
    return putChunk(
      request,
      db,
      env,
      match[1],
      /^\d+$/.test(match[2]) ? Number(match[2]) : Number.NaN,
    )
  return json({ error: 'method not allowed' }, 405)
}

function routeRow(request, env, db, url, match) {
  const t = { queues: QUEUES, chats: CHATS, free: FREE }[match[1]] ?? LOGINS
  const id = match[2]
  if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400)
  if (request.method === 'GET') return fetchRow(env, db, t, id)
  if (request.method === 'PUT') return putRow(request, env, db, t, id)
  const version = Number(url.searchParams.get('version'))
  if (request.method === 'DELETE' && (t === LOGINS || t === FREE))
    return deleteLogin(env, db, t, id, version)
  if (request.method === 'DELETE' && t === CHATS) return deleteChat(env, db, id, version)
  return json({ error: 'method not allowed' }, 405)
}

function route(request, db, env, url, path) {
  if (path === '/v1/changes' && request.method === 'GET')
    return getChanges(request, env, db, url.searchParams.get('since'))
  if (request.method === 'GET') {
    const listed = routeList(env, db, path)
    if (listed) return listed
  }
  const c = /^\/v1\/chats\/([^/]+)\/chunks(?:\/([^/]+))?$/.exec(path)
  if (c) return routeChunks(request, db, env, url, c)
  const m = /^\/v1\/(logins|queues|chats|free)\/([^/]+)$/.exec(path)
  return m ? routeRow(request, env, db, url, m) : json({ error: 'not found' }, 404)
}

// The read routes that may answer from the head alone check the schema only when they reach D1.
const HEAD_FIRST = /^\/v1\/(changes|logins|queues|chats|free)(\/[^/]+)?$/

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '/v1/health') return json({ ok: true })
    if (!env.DB) return json({ error: 'no DB binding' }, 500)
    if (!env.HEAD) return json({ error: 'no HEAD binding (the StoreHead Durable Object)' }, 500)
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    const db = env.DB
    if (!(request.method === 'GET' && HEAD_FIRST.test(path))) await ensureSchema(db)
    return route(request, db, env, url, path)
  },
  async scheduled(_event, env) {
    if (!env.DB || !env.HEAD) return
    await ensureSchema(env.DB)
    await pruneTombstones(env, env.DB)
  },
  // For tests: what a fresh isolate starts without (the kept lists and rows).
  forgetIsolate() {
    listCache.clear()
    itemCache.clear()
  },
}
