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
//   DELETE /v1/chats/:id?version=n   -> {ok:true} (row and all its chunks) | 409
//   PUT    /v1/chats/:id/chunks/:seq {blob, by}: an append-only transcript piece, written once
//                                -> {seq}; 409 {error:'taken', next} when that seq exists
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

let schemaReady = false
async function ensureSchema(db) {
  if (schemaReady) return
  for (const t of [LOGINS, QUEUES, CHATS])
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${t.table} (${t.key} TEXT PRIMARY KEY, version INTEGER NOT NULL, blob TEXT NOT NULL, meta TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
      )
      .run()
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS chat_chunks (chat TEXT NOT NULL, seq INTEGER NOT NULL, blob TEXT NOT NULL, by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat, seq))',
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
  const { results } = await db
    .prepare(`SELECT ${t.key}, version, meta, updated_at FROM ${t.table} ORDER BY ${t.key}`)
    .all()
  const rows = (results || []).map((r) => row(t, r))
  return json({ [LIST_NAME[t.table]]: rows })
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
// with the current version so the PCs can retry.
async function storeRow(db, t, id, body) {
  const version = Number(body?.version)
  const blob = body?.blob
  const meta = JSON.stringify(body?.meta ?? {})
  if (!Number.isInteger(version) || version < 0) return json({ error: 'bad version' }, 400)
  if (typeof blob !== 'string' || !blob || blob.length > t.maxBlob)
    return json({ error: 'bad blob' }, 400)
  if (meta.length > MAX_META) return json({ error: 'meta too large' }, 400)
  const now = Date.now()
  const result =
    version === 0
      ? await db
          .prepare(
            `INSERT INTO ${t.table} (${t.key}, version, blob, meta, updated_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT(${t.key}) DO NOTHING`,
          )
          .bind(id, blob, meta, now)
          .run()
      : await db
          .prepare(
            `UPDATE ${t.table} SET version = version + 1, blob = ?, meta = ?, updated_at = ? WHERE ${t.key} = ? AND version = ?`,
          )
          .bind(blob, meta, now, id, version)
          .run()
  if ((result?.meta?.changes ?? 0) === 1) return json({ version: version + 1 })
  const current = await db
    .prepare(`SELECT ${t.key}, version, meta, updated_at FROM ${t.table} WHERE ${t.key} = ?`)
    .bind(id)
    .first()
  return json({ error: 'version conflict', current: row(t, current) ?? null }, 409)
}

// DELETE /v1/logins/:id — remove only when `version` is the current one.
async function deleteLogin(db, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)
  const result = await db
    .prepare('DELETE FROM logins WHERE id = ? AND version = ?')
    .bind(id, version)
    .run()
  if ((result?.meta?.changes ?? 0) === 1) return json({ ok: true })
  return json({ error: 'version conflict' }, 409)
}

// DELETE /v1/chats/:id — the row delete is the compare-and-swap; its chunks go only after it won.
async function deleteChat(db, id, version) {
  if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)
  const result = await db
    .prepare('DELETE FROM chats WHERE id = ? AND version = ?')
    .bind(id, version)
    .run()
  if ((result?.meta?.changes ?? 0) !== 1) return json({ error: 'version conflict' }, 409)
  await db.prepare('DELETE FROM chat_chunks WHERE chat = ?').bind(id).run()
  return json({ ok: true })
}

// PUT /v1/chats/:id/chunks/:seq — insert once; a taken seq answers where the chat's chunks end.
async function putChunk(request, db, id, seq) {
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
  const result = await db
    .prepare(
      'INSERT INTO chat_chunks (chat, seq, blob, by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat, seq) DO NOTHING',
    )
    .bind(id, seq, blob, by, Date.now())
    .run()
  if ((result?.meta?.changes ?? 0) === 1) return json({ seq })
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '/v1/health') return json({ ok: true })
    if (!env.DB) return json({ error: 'no DB binding' }, 500)
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    const db = env.DB
    await ensureSchema(db)

    if (path === '/v1/logins' && request.method === 'GET') return listRows(db, LOGINS)
    if (path === '/v1/queues' && request.method === 'GET') return listRows(db, QUEUES)

    if (path === '/v1/chats' && request.method === 'GET') return listRows(db, CHATS)

    const c = /^\/v1\/chats\/([^/]+)\/chunks(?:\/([^/]+))?$/.exec(path)
    if (c) {
      if (!ID_RE.test(c[1])) return json({ error: 'bad id' }, 400)
      if (c[2] === undefined && request.method === 'GET')
        return listChunks(db, c[1], url.searchParams.get('from'))
      if (c[2] !== undefined && request.method === 'PUT')
        return putChunk(request, db, c[1], /^\d+$/.test(c[2]) ? Number(c[2]) : Number.NaN)
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
