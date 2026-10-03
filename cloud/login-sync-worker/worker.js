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

const chatRoom = (env) => {
  const mb = Number(env.CHAT_STORE_MB)
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : CHAT_ROOM_MB) * 1048576)
}

let schemaReady = false
async function ensureSchema(db) {
  if (schemaReady) return
  for (const t of [LOGINS, QUEUES, CHATS])
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${t.table} (${t.key} TEXT PRIMARY KEY, version INTEGER NOT NULL, blob TEXT NOT NULL, meta TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0)`,
      )
      .run()
  // Index on rev so WHERE rev > ? reads only changed rows.
  for (const t of [LOGINS, QUEUES, CHATS])
    await db.prepare(`CREATE INDEX IF NOT EXISTS ${t.table}_rev ON ${t.table}(rev)`).run()
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, time INTEGER NOT NULL, PRIMARY KEY (table_name, id))',
    )
    .run()
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS store_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, floor INTEGER NOT NULL)',
    )
    .run()
  // Initialize store_rev if it doesn't exist.
  if (!(await db.prepare('SELECT rev FROM store_rev WHERE id = 1').first()))
    await db.prepare('INSERT INTO store_rev (id, rev, floor) VALUES (1, 0, 0)').run()
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
  schemaReady = true
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

// GET /v1/logins, GET /v1/queues — the shared list, without the encrypted blobs.
async function listRows(db, t) {
  const storeRevRow = await db.prepare('SELECT rev FROM store_rev WHERE id = 1').first()
  const { results } = await db
    .prepare(`SELECT ${t.key}, version, meta, updated_at FROM ${t.table} ORDER BY ${t.key}`)
    .all()
  const rows = (results || []).map((r) => row(t, r))
  const response = json({ [LIST_NAME[t.table]]: rows })
  if (storeRevRow) {
    response.headers.set('x-store-rev', String(storeRevRow.rev))
  }
  return response
}

// GET /v1/logins/:id, GET /v1/queues/:pc — one stored row, blob included.
async function fetchRow(db, t, id) {
  const r = await db
    .prepare(`SELECT ${t.key}, version, blob, meta, updated_at FROM ${t.table} WHERE ${t.key} = ?`)
    .bind(id)
    .first()
  return r ? json(row(t, r)) : json({ error: 'not found' }, 404)
}

// parse the PUT body and run the compare-and-swap write: version 0 inserts (losing a
// concurrent insert), a matching version updates atomically, anything else returns 409
// with the current version so the PCs can retry. A successful write increments store rev and
// stamps the row with it, atomically in one batch.
async function storeRow(db, t, id, body) {
  const version = Number(body?.version)
  const blob = body?.blob
  const meta = JSON.stringify(body?.meta ?? {})
  if (!Number.isInteger(version) || version < 0) return json({ error: 'bad version' }, 400)
  if (typeof blob !== 'string' || !blob || blob.length > t.maxBlob)
    return json({ error: 'bad blob' }, 400)
  if (meta.length > MAX_META) return json({ error: 'meta too large' }, 400)
  const now = Date.now()

  // Increment store rev and get the new value. This is as atomic as we can make it with D1.
  const newRevRow = await db
    .prepare('UPDATE store_rev SET rev = rev + 1 WHERE id = 1 RETURNING rev')
    .first()
  const newRev = newRevRow?.rev ?? 1

  const result =
    version === 0
      ? await db
          .prepare(
            `INSERT INTO ${t.table} (${t.key}, version, blob, meta, updated_at, rev) VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT(${t.key}) DO NOTHING`,
          )
          .bind(id, blob, meta, now, newRev)
          .run()
      : await db
          .prepare(
            `UPDATE ${t.table} SET version = version + 1, blob = ?, meta = ?, updated_at = ?, rev = ? WHERE ${t.key} = ? AND version = ?`,
          )
          .bind(blob, meta, now, newRev, id, version)
          .run()

  if ((result?.meta?.changes ?? 0) === 1) {
    // Successful write: clear any tombstone for this id. The store rev was already incremented above.
    await db
      .prepare('DELETE FROM tombstones WHERE table_name = ? AND id = ?')
      .bind(t.table, id)
      .run()
    return json({ version: version + 1 })
  }

  const current = await db
    .prepare(`SELECT ${t.key}, version, meta, updated_at FROM ${t.table} WHERE ${t.key} = ?`)
    .bind(id)
    .first()
  return json({ error: 'version conflict', current: row(t, current) ?? null }, 409)
}

// DELETE /v1/logins/:id — remove only when `version` is the current one. A deletion leaves a
// tombstone and increments the store rev.
async function deleteLogin(db, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)

  // Increment store rev and get the new value.
  const newRevRow = await db
    .prepare('UPDATE store_rev SET rev = rev + 1 WHERE id = 1 RETURNING rev')
    .first()
  const newRev = newRevRow?.rev ?? 1

  const result = await db
    .prepare('DELETE FROM logins WHERE id = ? AND version = ?')
    .bind(id, version)
    .run()
  if ((result?.meta?.changes ?? 0) === 1) {
    // Successful delete: create a tombstone. The store rev was already incremented above.
    await db
      .prepare('INSERT OR REPLACE INTO tombstones (table_name, id, rev, time) VALUES (?, ?, ?, ?)')
      .bind('logins', id, newRev, Date.now())
      .run()
    return json({ ok: true })
  }
  // Delete failed, but we already incremented store_rev. This is acceptable because failed deletes
  // are rare and the rev is only used for the changes feed.
  return json({ error: 'version conflict' }, 409)
}

// DELETE /v1/chats/:id — the row delete is the compare-and-swap; the transcript goes only after it
// won. A transcript lives under the chat's session (meta.s), which two rows can share (a chat moved
// between profiles), so it stays while another row still reads it. A deletion leaves a tombstone
// and increments the store rev.
async function deleteChat(db, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)

  // Increment store rev and get the new value.
  const newRevRow = await db
    .prepare('UPDATE store_rev SET rev = rev + 1 WHERE id = 1 RETURNING rev')
    .first()
  const newRev = newRevRow?.rev ?? 1

  const gone = await db
    .prepare('DELETE FROM chats WHERE id = ? AND version = ? RETURNING meta')
    .bind(id, version)
    .first()
  if (!gone) return json({ error: 'version conflict' }, 409)

  // Create a tombstone for the deleted chat. The store rev was already incremented above.
  await db
    .prepare('INSERT OR REPLACE INTO tombstones (table_name, id, rev, time) VALUES (?, ?, ?, ?)')
    .bind('chats', id, newRev, Date.now())
    .run()

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
  await db
    .prepare('UPDATE chat_usage SET chars = MAX(0, chars - ?) WHERE id = 1')
    .bind(freed?.n ?? 0)
    .run()
  return json({ ok: true })
}

// PUT /v1/chats/:id/chunks/:seq — insert once; a taken seq answers where the chat's chunks end, and a
// chunk that would take chats past their room is refused before it is written.
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
    return json({ seq })
  }
  const top = await db
    .prepare('SELECT MAX(seq) AS top FROM chat_chunks WHERE chat = ?')
    .bind(id)
    .first()
  return json({ error: 'taken', next: (top?.top ?? -1) + 1 }, 409)
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

// Prune tombstones older than 30 days and raise floor. Called occasionally, not on every request.
async function pruneTombstones(db) {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  const toDelete = await db
    .prepare('SELECT MAX(rev) AS maxRev FROM tombstones WHERE time < ?')
    .bind(thirtyDaysAgo)
    .first()
  if (!toDelete?.maxRev) return // Nothing to prune.
  const maxRev = toDelete.maxRev
  await db.prepare('DELETE FROM tombstones WHERE rev <= ?').bind(maxRev).run()
  await db.prepare('UPDATE store_rev SET floor = MAX(floor, ?) WHERE id = 1').bind(maxRev).run()
}

// GET /v1/changes?since=<n> — delta updates: rows changed since cursor n, or full: true if the cursor
// is too old or the store was reset. Reads store_rev first; if n equals rev, answers with empty lists
// (one row read). Otherwise reads all changed rows in one batch.
async function getChanges(db, sinceParam) {
  const since = sinceParam === null ? -1 : Number(sinceParam)
  if (!Number.isInteger(since)) return json({ error: 'bad since' }, 400)

  // Read store_rev first.
  const storeRevRow = await db.prepare('SELECT rev, floor FROM store_rev WHERE id = 1').first()
  const rev = storeRevRow?.rev ?? 0
  const floor = storeRevRow?.floor ?? 0

  // If n equals rev, nothing has changed since the cursor.
  if (since === rev) {
    return json({ rev, logins: [], queues: [], chats: [], gone: [] })
  }

  // If n < floor or n > rev, the cursor is too old or invalid.
  if (since < floor || since > rev) {
    return json({ rev, full: true })
  }

  // Otherwise, read all changed rows in one batch.
  const logins = await db
    .prepare('SELECT id, version, meta, updated_at FROM logins WHERE rev > ? ORDER BY id')
    .bind(since)
    .all()
  const queues = await db
    .prepare('SELECT pc, version, meta, updated_at FROM queues WHERE rev > ? ORDER BY pc')
    .bind(since)
    .all()
  const chats = await db
    .prepare('SELECT id, version, meta, updated_at FROM chats WHERE rev > ? ORDER BY id')
    .bind(since)
    .all()
  const tombstones = await db
    .prepare('SELECT table_name, id FROM tombstones WHERE rev > ? ORDER BY table_name, id')
    .bind(since)
    .all()

  const gone = (tombstones.results || []).map((r) => ({
    table: r.table_name,
    id: r.id,
  }))

  return json({
    rev,
    logins: (logins.results || []).map((r) => ({
      id: r.id,
      version: r.version,
      meta: JSON.parse(r.meta),
      updatedAt: r.updated_at,
    })),
    queues: (queues.results || []).map((r) => ({
      pc: r.pc,
      version: r.version,
      meta: JSON.parse(r.meta),
      updatedAt: r.updated_at,
    })),
    chats: (chats.results || []).map((r) => ({
      id: r.id,
      version: r.version,
      meta: JSON.parse(r.meta),
      updatedAt: r.updated_at,
    })),
    gone,
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '/v1/health') return json({ ok: true })
    if (!env.DB) return json({ error: 'no DB binding' }, 500)
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    const db = env.DB
    await ensureSchema(db)

    if (path === '/v1/changes' && request.method === 'GET')
      return getChanges(db, url.searchParams.get('since'))

    if (path === '/v1/logins' && request.method === 'GET') return listRows(db, LOGINS)
    if (path === '/v1/queues' && request.method === 'GET') return listRows(db, QUEUES)

    if (path === '/v1/chats' && request.method === 'GET') return listRows(db, CHATS)

    const c = /^\/v1\/chats\/([^/]+)\/chunks(?:\/([^/]+))?$/.exec(path)
    if (c) {
      if (!ID_RE.test(c[1])) return json({ error: 'bad id' }, 400)
      if (c[2] === undefined && request.method === 'GET')
        return listChunks(db, c[1], url.searchParams.get('from'))
      if (c[2] !== undefined && request.method === 'PUT')
        return putChunk(request, db, env, c[1], /^\d+$/.test(c[2]) ? Number(c[2]) : Number.NaN)
      return json({ error: 'method not allowed' }, 405)
    }

    const m = /^\/v1\/(logins|queues|chats)\/([^/]+)$/.exec(path)
    if (!m) return json({ error: 'not found' }, 404)
    const t = m[1] === 'queues' ? QUEUES : m[1] === 'chats' ? CHATS : LOGINS
    const id = m[2]
    if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400)

    if (request.method === 'GET') return fetchRow(db, t, id)
    if (request.method === 'PUT') return putRow(request, db, t, id)

    if (request.method === 'DELETE' && t === LOGINS)
      return deleteLogin(db, id, Number(url.searchParams.get('version')))
    if (request.method === 'DELETE' && t === CHATS)
      return deleteChat(db, id, Number(url.searchParams.get('version')))

    return json({ error: 'method not allowed' }, 405)
  },
}
