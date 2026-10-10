import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { API_BODY_LIMIT_BYTES, apiBodyLimit } from '../src/api-body-limit'

const app = new Hono()
app.use('/api/*', apiBodyLimit())
app.post('/api/climayte/run', async (c) => c.json({ n: (await c.req.json()).tasks.length }))

const post = (tasks: string[]) =>
  app.request('/api/climayte/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks }),
  })

describe('api body limit', () => {
  test('accepts a climayte_run of 40 prompts of 90 KB', async () => {
    const res = await post(Array.from({ length: 40 }, () => 'x'.repeat(90 * 1024)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ n: 40 })
  })
  test('over the limit answers 413 naming the limit', async () => {
    const res = await post(['x'.repeat(API_BODY_LIMIT_BYTES + 1)])
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toContain('16 MiB')
  })
})
