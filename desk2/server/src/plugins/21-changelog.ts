// What's new (GET /api/changelog): the CHANGELOG sections the window shows after an update.

import type { Hono } from 'hono'
import { readChangelog } from '../changelog'

export default async function plugin(app: Hono): Promise<void> {
  app.get('/api/changelog', (c) => c.json(readChangelog()))
}
