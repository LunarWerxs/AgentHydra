// The ReDesign card's pictures: GET /api/redesign/image/<run>/option-<n>.png, read only, from <home>/design-options
// (where redesign-mcp.ts writes them). The run and the file are each one plain name; anything else, or a path that
// resolves outside the folder, is refused.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FILE = /^option-\d{1,3}\.png$/

/** The picture file for a run and file name inside `dir`, or null when either is not a plain name or the file is not there. */
export function designImagePath(dir: string, run: string, file: string): string | null {
  if (!RUN.test(run) || run.includes('..') || !FILE.test(file)) return null
  const path = resolve(join(dir, run, file))
  if (!existsSync(path) || !statSync(path).isFile()) return null
  // A symlink inside the folder must not lead out of it.
  const rel = relative(realpathSync(dir), realpathSync(path))
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..') || resolve(rel) === rel) return null
  return path
}

export function serveDesignImage(dir: string, run: string, file: string): Response {
  const path = designImagePath(dir, run, file)
  if (!path) return Response.json({ error: 'no such design option picture' }, { status: 404 })
  return new Response(Bun.file(path), {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'"
    }
  })
}
