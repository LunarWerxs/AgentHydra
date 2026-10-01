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

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BLOB = 64 * 1024
const MAX_META = 4 * 1024

let schemaReady = false
async function ensureSchema(db) {
  if (schemaReady) return
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS logins (id TEXT PRIMARY KEY, version INTEGER NOT NULL, blob TEXT NOT NULL, meta TEXT NOT NULL, updated_at INTEGER NOT NULL)',
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

const row = (r) =>
  r && {
    id: r.id,
    version: r.version,
    meta: JSON.parse(r.meta),
    updatedAt: r.updated_at,
    ...(r.blob !== undefined ? { blob: r.blob } : {}),
  }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '/v1/health') return json({ ok: true })
    if (!env.DB) return json({ error: 'no DB binding' }, 500)
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    await ensureSchema(env.DB)

    if (path === '/v1/logins' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, version, meta, updated_at FROM logins ORDER BY id',
      ).all()
      return json({ logins: (results || []).map(row) })
    }

    const m = /^\/v1\/logins\/([^/]+)$/.exec(path)
    if (!m) return json({ error: 'not found' }, 404)
    const id = m[1]
    if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400)

    if (request.method === 'GET') {
      const r = await env.DB.prepare(
        'SELECT id, version, blob, meta, updated_at FROM logins WHERE id = ?',
      )
        .bind(id)
        .first()
      return r ? json(row(r)) : json({ error: 'not found' }, 404)
    }

    if (request.method === 'PUT') {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ error: 'body must be JSON' }, 400)
      }
      const version = Number(body?.version)
      const blob = body?.blob
      const meta = JSON.stringify(body?.meta ?? {})
      if (!Number.isInteger(version) || version < 0) return json({ error: 'bad version' }, 400)
      if (typeof blob !== 'string' || !blob || blob.length > MAX_BLOB)
        return json({ error: 'bad blob' }, 400)
      if (meta.length > MAX_META) return json({ error: 'meta too large' }, 400)
      const now = Date.now()
      const result =
        version === 0
          ? await env.DB.prepare(
              'INSERT INTO logins (id, version, blob, meta, updated_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
            )
              .bind(id, blob, meta, now)
              .run()
          : await env.DB.prepare(
              'UPDATE logins SET version = version + 1, blob = ?, meta = ?, updated_at = ? WHERE id = ? AND version = ?',
            )
              .bind(blob, meta, now, id, version)
              .run()
      if ((result?.meta?.changes ?? 0) === 1) return json({ version: version + 1 })
      const current = await env.DB.prepare(
        'SELECT id, version, meta, updated_at FROM logins WHERE id = ?',
      )
        .bind(id)
        .first()
      return json({ error: 'version conflict', current: row(current) ?? null }, 409)
    }

    if (request.method === 'DELETE') {
      const version = Number(url.searchParams.get('version'))
      if (!Number.isInteger(version) || version < 1) return json({ error: 'bad version' }, 400)
      const result = await env.DB.prepare('DELETE FROM logins WHERE id = ? AND version = ?')
        .bind(id, version)
        .run()
      return (result?.meta?.changes ?? 0) === 1
        ? json({ ok: true })
        : json({ error: 'version conflict' }, 409)
    }

    return json({ error: 'method not allowed' }, 405)
  },
}
