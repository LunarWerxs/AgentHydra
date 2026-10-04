// Git status, one file's diff, and folder browsing (SPEC.md REST rows /api/git, /api/git/diff,
// /api/folders/browse). Bad input and git failures answer 400 with the real reason.

import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { browse, BrowseError } from '../git/browse'
import { GitError, gitDiff, gitStatus } from '../git/git'

function badRequest(err: unknown): string | null {
  return err instanceof GitError || err instanceof BrowseError ? err.message : null
}

export default function plugin(app: Hono, _ctx: ServerContext): void {
  app.get('/api/git', async (c) => {
    try {
      return c.json(await gitStatus(c.req.query('cwd') ?? ''))
    } catch (err) {
      const msg = badRequest(err)
      if (msg) return c.json({ error: msg }, 400)
      throw err
    }
  })

  app.get('/api/git/diff', async (c) => {
    try {
      return c.json({ diff: await gitDiff(c.req.query('cwd') ?? '', c.req.query('path') ?? '') })
    } catch (err) {
      const msg = badRequest(err)
      if (msg) return c.json({ error: msg }, 400)
      throw err
    }
  })

  app.get('/api/folders/browse', async (c) => {
    try {
      return c.json(await browse(c.req.query('path') ?? ''))
    } catch (err) {
      const msg = badRequest(err)
      if (msg) return c.json({ error: msg }, 400)
      throw err
    }
  })
}
