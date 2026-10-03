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
//   TOKEN_SHA256  hex SHA-256 of the access token the PCs send as `Authorization: Bearer <token>`.
//                 Only the hash lives here; the token itself stays on the PCs.
//   CHAT_STORE_MB optional: room for chat transcripts in MB of stored text, default 400. D1's free
//                 plan stops a whole database at 500 MB and the logins live in the same one, so chats
//                 stop short of that; on Workers Paid (10 GB per database) it can be raised.
//
// Routes (JSON in and out):
//   GET    /v1/health            {ok:true}, no token needed
//   GET    /v1/changes?since=n   {rev, logins, queues, chats, gone:[{table,id}]} changed after cursor n,
//                                or {rev, full:true} when n is below the kept tombstones or above rev
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

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_META = 4 * 1024

// The two tables share one shape and one compare-and-swap write. `queues` holds each PC's CliMayte
// queue snapshot, keyed by that PC's id. It is a table of its own on purpose: an older AgentHydra
// lands every row of `logins` it does not know as a CLI login, so a queue there would become a junk
// login on that PC.
const LOGINS = { table: 'logins', key: 'id', maxBlob: 64 * 1024 }
const QUEUES = { table: 'queues', key: 'pc', maxBlob: 256 * 1024 }
const CHATS = { table: 'chats', key: 'id', maxBlob: 256 * 1024 }
const LIST_NAME = { logins: 'logins', queues: 'queues', chats: 'chats' }

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

let schemaReady = false
async function ensureSchema(db) {
  if (schemaReady) return
  for (const t of [LOGINS, QUEUES, CHATS]) {
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
      'CREATE TABLE IF NOT EXISTS store_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, floor INTEGER NOT NULL, logins_rev INTEGER NOT NULL DEFAULT 0, queues_rev INTEGER NOT NULL DEFAULT 0, chats_rev INTEGER NOT NULL DEFAULT 0)',
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
  // Once per isolate, not per request: drop tombstones older than 30 days and raise floor to the
  // highest rev dropped, so a cursor older than the kept tombstones is answered with full: true.
  const cutoff = Date.now() - TOMBSTONE_KEEP_MS
  const dropped = await db.batch([
    db
      .prepare(
        'UPDATE store_rev SET floor = MAX(floor, COALESCE((SELECT MAX(rev) FROM tombstones WHERE time < ?), 0)) WHERE id = 1',
      )
      .bind(cutoff),
    db.prepare('DELETE FROM tombstones WHERE time < ?').bind(cutoff),
  ])
  schemaReady = true
  // Tombstones dropped means the floor may have risen: the head any tier holds is behind it.
  if ((dropped?.[1]?.meta?.changes ?? 0) > 0) keepHead(await db.prepare(HEAD_SQL).first())
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
// list can show, and a table's list is unchanged while its rev and the floor are. D1 bills the rows a
// query looks at: the head is one row, where the lists it stands in for are dozens.
//
// This isolate also keeps the head it last read for HEAD_TRUST_MS (env HEAD_TRUST_S; 0 reads it every
// time). An older client lists the whole logins and queues tables every 30 s and cannot be changed, and
// even a one-row check twice a poll is 5,760 rows a day. Within the window a change made on ANOTHER
// isolate shows a poll later (a write through this one drops the head at once); a write itself is a
// compare-and-swap on D1 and never reads it.
//
// Free-plan isolates are short-lived and two PCs often land on different ones, so most polls still
// found no head here and read D1 (about 310 reads an hour, idle). A second, shared tier stands behind
// the isolate: the Workers Cache API (caches.default, free, no D1 read), one synthetic GET entry per
// colo holding the head with max-age HEAD_CACHE_S (env HEAD_CACHE_S; default 120, 0 = off; skipped
// silently where `caches` is missing: tests, wrangler dev). Read order: isolate memory, cache entry,
// D1. Every write refreshes BOTH with the head its own batch read after the commit, and so does every
// D1 head read, so a PC on the same colo sees its own and the other PC's writes at once. TRADE-OFF: a
// colo the write did not go through keeps its entry until max-age runs out, so a change made through
// another colo shows up to HEAD_CACHE_S late there (an entry's age also counts against HEAD_TRUST_MS,
// so an isolate never trusts a head longer than the entry it came from).
const HEAD_TRUST_MS = 75 * 1000
const HEAD_CACHE_S = 120
const HEAD_SQL = 'SELECT rev, floor, logins_rev, queues_rev, chats_rev FROM store_rev WHERE id = 1'
const NO_HEAD = { rev: 0, floor: 0, logins_rev: 0, queues_rev: 0, chats_rev: 0 }
let headKept = null
const trustOf = (env) => {
  const s = env?.HEAD_TRUST_S
  const n = s === undefined || s === '' ? Number.NaN : Number(s)
  return Number.isFinite(n) && n >= 0 ? n * 1000 : HEAD_TRUST_MS
}
// Shared tier. `headKey` and `headCacheMs` are set by each request; puts wait in `headPuts` until the
// request's end (ctx.waitUntil where there is one).
let headKey = null
let headCacheMs = HEAD_CACHE_S * 1000
let headPuts = []
const sharedCache = () => (typeof caches !== 'undefined' && caches?.default) || null
const headCacheOf = (env) => {
  const s = env?.HEAD_CACHE_S
  const n = s === undefined || s === '' ? Number.NaN : Number(s)
  return Number.isFinite(n) && n >= 0 ? n * 1000 : HEAD_CACHE_S * 1000
}
const keepHead = (row) => {
  headKept = { at: Date.now(), row: row ?? NO_HEAD }
  const cache = sharedCache()
  if (cache && headKey && headCacheMs > 0)
    headPuts.push(
      Promise.resolve(
        cache.put(
          headKey,
          new Response(JSON.stringify(headKept), {
            headers: { 'cache-control': `max-age=${Math.ceil(headCacheMs / 1000)}` },
          }),
        ),
      ).catch(() => {}), // floor-ok: best-effort cache tier; a failed put only means the next poll reads the D1 head
    )
  return headKept.row
}
// An isolate with no head of its own takes the shared entry, keeping the entry's own age.
async function seedHeadFromCache() {
  const cache = sharedCache()
  if (!cache || !headKey || headCacheMs <= 0) return
  try {
    const hit = await cache.match(headKey)
    const kept = hit ? await hit.json() : null
    const age = kept ? Date.now() - kept.at : -1
    if (age >= 0 && age < headCacheMs && kept.row && (!headKept || headKept.at < kept.at))
      headKept = { at: kept.at, row: kept.row }
  } catch {} // floor-ok: best-effort cache tier; a failed match or unreadable entry falls through to the D1 head read
}
// The head this isolate still trusts, else null.
const trustedHead = (trust) => {
  const age = headKept ? Date.now() - headKept.at : -1
  return trust > 0 && age >= 0 && age < trust ? headKept.row : null
}

// Each list, kept in this isolate while its table has not changed. A PC listing a table every 30 s
// paid for every row of it each time; a list that has not changed now costs nothing beyond the head,
// and one that changed reads only its changed rows (by rev, as the changes feed does) and the
// tombstones after them. A list is read whole when this isolate has none, when old tombstones were
// dropped since it (below the floor), and after LIST_KEEP_MS anyway, so a row changed by hand-run SQL
// (which moves no rev) shows within hours; redeploying shows it at once.
const LIST_KEEP_MS = 6 * 60 * 60 * 1000
const listCache = new Map()
const stampOf = (head, t) => `${head[`${t.table}_rev`]}/${head.floor}`

// GET /v1/logins, GET /v1/queues, GET /v1/chats — the shared list, without the encrypted blobs. The
// store rev is read with the list and sent as x-store-rev, so a client can start its changes cursor
// there without missing a write. A kept list whose head is trusted (or whose stamp the head reads
// equal) is answered with no list read; one that changed reads the head and the changed rows in one
// batch, which is also the only head read of the request.
async function listRows(db, t, trust) {
  const now = Date.now()
  const kept = listCache.get(t.table)
  const fresh = kept && now - kept.fullAt >= 0 && now - kept.fullAt < LIST_KEEP_MS
  const trusted = trustedHead(trust)
  if (fresh && trusted && kept.stamp === stampOf(trusted, t))
    return listResponse(kept.body, trusted.rev)

  const sel = `SELECT ${t.key}, version, meta, updated_at FROM ${t.table}`
  if (fresh) {
    // Behind a trusted head the head is not read again: the rows after the kept rev are the change,
    // and one newer than the head only shows in the list earlier than the head would have said.
    const res = await db.batch([
      ...(trusted ? [] : [db.prepare(HEAD_SQL)]),
      db.prepare(`${sel} WHERE rev > ? ORDER BY rev`).bind(kept.rev),
      db.prepare('SELECT table_name, id FROM tombstones WHERE rev > ? ORDER BY rev').bind(kept.rev),
    ])
    const [changed, tombs] = res.slice(-2)
    const snapshot = trusted ?? keepHead(res[0].results?.[0])
    if (kept.stamp === stampOf(snapshot, t)) return listResponse(kept.body, snapshot.rev)
    if (kept.rev >= snapshot.floor && kept.rev <= snapshot.rev) {
      const rows = new Map(kept.rows)
      for (const r of tombs.results || []) if (r.table_name === t.table) rows.delete(r.id)
      for (const r of changed.results || []) rows.set(r[t.key], row(t, r))
      return keepList(t, snapshot, rows, kept.fullAt)
    }
  }
  const [headRes, listRes] = await db.batch([
    db.prepare(HEAD_SQL),
    db.prepare(`${sel} ORDER BY ${t.key}`),
  ])
  const snapshot = keepHead(headRes.results?.[0])
  const rows = new Map((listRes.results || []).map((r) => [r[t.key], row(t, r)]))
  return keepList(t, snapshot, rows, now)
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
async function fetchRow(db, t, id, trust) {
  const path = `${t.table}/${id}`
  const kept = itemCache.get(path)
  let head = trustedHead(trust)
  if (kept && !head) head = keepHead(await db.prepare(HEAD_SQL).first())
  const age = kept ? Date.now() - kept.at : -1
  if (kept && head && age >= 0 && age < LIST_KEEP_MS && kept.stamp === stampOf(head, t))
    return json(kept.body)
  const sql = `SELECT ${t.key}, version, blob, meta, updated_at FROM ${t.table} WHERE ${t.key} = ?`
  let r
  if (head) r = await db.prepare(sql).bind(id).first()
  else {
    const [headRes, rowRes] = await db.batch([db.prepare(HEAD_SQL), db.prepare(sql).bind(id)])
    head = keepHead(headRes.results?.[0])
    r = rowRes.results?.[0]
  }
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
// refused write changes nothing, rev included.
async function storeRow(db, t, id, body) {
  const version = Number(body?.version)
  const blob = body?.blob
  const meta = JSON.stringify(body?.meta ?? {})
  if (!Number.isInteger(version) || version < 0) return json({ error: 'bad version' }, 400)
  if (typeof blob !== 'string' || !blob || blob.length > t.maxBlob)
    return json({ error: 'bad blob' }, 400)
  if (meta.length > MAX_META) return json({ error: 'meta too large' }, 400)
  const now = Date.now()
  const has = `EXISTS (SELECT 1 FROM ${t.table} WHERE ${t.key} = ?`

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

  keepHead(results[results.length - 1].results?.[0])
  if ((results[1]?.meta?.changes ?? 0) === 1) return json({ version: version + 1 })

  const current = await db
    .prepare(`SELECT ${t.key}, version, meta, updated_at FROM ${t.table} WHERE ${t.key} = ?`)
    .bind(id)
    .first()
  return json({ error: 'version conflict', current: row(t, current) ?? null }, 409)
}

// The compare-and-swap delete of a logins or chats row: bump rev, leave a tombstone at that rev and
// delete the row, in one batch whose statements only act while `version` is still the current one.
// Resolves to the deleted row's meta, or null when the delete was refused (nothing changed).
async function deleteRow(db, t, id, version) {
  const has = `EXISTS (SELECT 1 FROM ${t.table} WHERE ${t.key} = ? AND version = ?)`
  const results = await db.batch([
    db
      .prepare(
        `UPDATE store_rev SET rev = rev + 1, ${t.table}_rev = rev + 1 WHERE id = 1 AND ${has}`,
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
  keepHead(results[3].results?.[0])
  return results[2]?.results?.[0] ?? null
}

// DELETE /v1/logins/:id — remove only when `version` is the current one.
async function deleteLogin(db, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)
  return (await deleteRow(db, LOGINS, id, version))
    ? json({ ok: true })
    : json({ error: 'version conflict' }, 409)
}

// DELETE /v1/chats/:id — the row delete is the compare-and-swap; the transcript goes only after it
// won. A transcript lives under the chat's session (meta.s), which two rows can share (a chat moved
// between profiles), so it stays while another row still reads it.
async function deleteChat(db, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)
  const gone = await deleteRow(db, CHATS, id, version)
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
  await db
    .prepare('UPDATE chat_usage SET chars = MAX(0, chars - ?) WHERE id = 1')
    .bind(freed?.n ?? 0)
    .run()
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
  const used = (await db.prepare('SELECT chars FROM chat_usage WHERE id = 1').first())?.chars ?? 0
  const room = chatRoom(env)
  if (used + blob.length > room) return json({ error: 'no room for more chats', used, room }, 507)
  const result = await db
    .prepare(
      'INSERT INTO chat_chunks (chat, seq, blob, by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat, seq) DO NOTHING',
    )
    .bind(id, seq, blob, by, Date.now())
    .run()
  if ((result?.meta?.changes ?? 0) === 1) {
    await db.prepare('UPDATE chat_usage SET chars = chars + ? WHERE id = 1').bind(blob.length).run()
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

async function putRow(request, db, t, id) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'body must be JSON' }, 400)
  }
  return storeRow(db, t, id, body)
}

const changed = (t, r) => ({
  [t.key]: r[t.key],
  version: r.version,
  meta: JSON.parse(r.meta),
  updatedAt: r.updated_at,
})

// GET /v1/changes?since=<n> — what changed after cursor n. A cursor equal to the head this isolate
// trusts is answered from it, with no read. Otherwise the head (store_rev, one row), the changed rows
// and the tombstones come from ONE batch, one consistent snapshot, and an idle cursor costs that one row. full: true when n is older than the
// kept tombstones (below floor) or newer than the store (it was reset). Each query is in rev order so
// it walks the rev index from n and reads only the changed rows; in key order D1 read the whole
// table on every call.
async function getChanges(db, sinceParam, trust) {
  const since = Number(sinceParam)
  if (sinceParam === null || sinceParam === '' || !Number.isInteger(since))
    return json({ error: 'bad since' }, 400)
  const age = headKept ? Date.now() - headKept.at : -1
  if (trust > 0 && age >= 0 && age < trust && since === headKept.row.rev)
    return json({ rev: since, logins: [], queues: [], chats: [], gone: [] })
  const [revRes, logins, queues, chats, tombs] = await db.batch([
    db.prepare(HEAD_SQL),
    db
      .prepare('SELECT id, version, meta, updated_at FROM logins WHERE rev > ? ORDER BY rev')
      .bind(since),
    db
      .prepare('SELECT pc, version, meta, updated_at FROM queues WHERE rev > ? ORDER BY rev')
      .bind(since),
    db
      .prepare('SELECT id, version, meta, updated_at FROM chats WHERE rev > ? ORDER BY rev')
      .bind(since),
    db.prepare('SELECT table_name, id FROM tombstones WHERE rev > ? ORDER BY rev').bind(since),
  ])
  const { rev, floor } = keepHead(revRes.results?.[0])
  if (since === rev) return json({ rev, logins: [], queues: [], chats: [], gone: [] })
  if (since < floor || since > rev) return json({ rev, full: true })
  return json({
    rev,
    logins: (logins.results || []).map((r) => changed(LOGINS, r)),
    queues: (queues.results || []).map((r) => changed(QUEUES, r)),
    chats: (chats.results || []).map((r) => changed(CHATS, r)),
    gone: (tombs.results || []).map((r) => ({ table: r.table_name, id: r.id })),
  })
}

function routeList(db, path, trust) {
  const tables = { '/v1/logins': LOGINS, '/v1/queues': QUEUES, '/v1/chats': CHATS }
  return tables[path] ? listRows(db, tables[path], trust) : null
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

function routeRow(request, db, url, match, trust) {
  const t = match[1] === 'queues' ? QUEUES : match[1] === 'chats' ? CHATS : LOGINS
  const id = match[2]
  if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400)
  if (request.method === 'GET') return fetchRow(db, t, id, trust)
  if (request.method === 'PUT') return putRow(request, db, t, id)
  const version = Number(url.searchParams.get('version'))
  if (request.method === 'DELETE' && t === LOGINS) return deleteLogin(db, id, version)
  if (request.method === 'DELETE' && t === CHATS) return deleteChat(db, id, version)
  return json({ error: 'method not allowed' }, 405)
}

function route(request, db, env, url, path) {
  if (path === '/v1/changes' && request.method === 'GET')
    return getChanges(db, url.searchParams.get('since'), trustOf(env))
  if (request.method === 'GET') {
    const listed = routeList(db, path, trustOf(env))
    if (listed) return listed
  }
  const c = /^\/v1\/chats\/([^/]+)\/chunks(?:\/([^/]+))?$/.exec(path)
  if (c) return routeChunks(request, db, env, url, c)
  const m = /^\/v1\/(logins|queues|chats)\/([^/]+)$/.exec(path)
  return m ? routeRow(request, db, url, m, trustOf(env)) : json({ error: 'not found' }, 404)
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '/v1/health') return json({ ok: true })
    if (!env.DB) return json({ error: 'no DB binding' }, 500)
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    const db = env.DB
    headKey = sharedCache() ? new URL('/__head', request.url) : null
    headCacheMs = headCacheOf(env)
    await ensureSchema(db)
    const trust = trustOf(env)
    if (
      request.method === 'GET' &&
      trust > 0 &&
      !trustedHead(trust) &&
      (path === '/v1/changes' || /^\/v1\/(logins|queues|chats)(\/[^/]+)?$/.test(path))
    )
      await seedHeadFromCache()

    try {
      return await route(request, db, env, url, path)
    } finally {
      const puts = headPuts
      headPuts = []
      if (puts.length) {
        const done = Promise.all(puts)
        if (ctx?.waitUntil) ctx.waitUntil(done)
        else await done
      }
    }
  },
  // For tests: what a fresh isolate starts without (the head, the kept lists and rows).
  forgetIsolate() {
    headKept = null
    listCache.clear()
    itemCache.clear()
  },
}
