// POST /api/attachments?name=<file name>: a file the composer attaches, the body its bytes. It is kept under
// <home>/attachments/<hash>/<name>, where the hash is of the bytes, so the same file is kept once, and the
// response names its path: the chat sends the path, and the model opens it with Read.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { cardTypeOf } from '../media/cache'
import { renameOver, writeFlushed } from '../write-flushed'

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/** A file name as one path segment on Windows and Unix: no folders, no reserved characters, never empty. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  let clean = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '')
  if (!clean) return 'file'
  // Shortened in the middle: the extension says what the file is, to the model and to Read.
  if (clean.length > 120) {
    const ext = extname(clean).length <= 16 ? extname(clean) : ''
    clean = clean.slice(0, 120 - ext.length).replace(/[\s.]+$/, '') + ext
  }
  return RESERVED.test(clean) ? `_${clean}` : clean
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  app.post('/api/attachments', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > MAX_ATTACHMENT_BYTES) return c.json({ error: 'a file over 100 MB cannot be attached' }, 413)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (!bytes.length) return c.json({ error: 'the file is empty' }, 400)
    if (bytes.length > MAX_ATTACHMENT_BYTES) return c.json({ error: 'a file over 100 MB cannot be attached' }, 413)
    const name = safeName(c.req.query('name') ?? '')
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const dir = join(ctx.home, 'attachments', hash)
    const file = join(dir, name)
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFlushed(tmp, bytes)
      renameOver(tmp, file)
    }
    return c.json({ path: file, name, bytes: bytes.length, mediaType: cardTypeOf(name) })
  })
}
