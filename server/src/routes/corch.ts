// server/src/routes/corch.ts — HTTP face of Corch (delegating work onto the owner's CLI accounts)
// and of quick add (signing a CLI account in from an email). See docs/CORCH.md "Routes".
// The Corch view and the Quick add row in the web app are the callers; MCP calls corch.ts directly.

import { corchCancel, corchGet, corchList, corchRun, corchSend } from '../corch'
import {
  cancelQuickAdd,
  listQuickAdds,
  startQuickAdd,
  submitQuickAddCode,
} from '../core/cli-quick-add'
import { app } from '../http-app'
import { jsonBody } from '../route-helpers'

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

// --- Corch workers -----------------------------------------------------------
app.get('/api/corch/workers', (c) => {
  const active = c.req.query('active')
  return c.json(
    corchList({
      group: optStr(c.req.query('group')),
      active: active === '1' || active === 'true' ? true : undefined,
    }),
  )
})
app.get('/api/corch/workers/:id', (c) => {
  const worker = corchGet(c.req.param('id'))
  return worker ? c.json(worker) : c.json({ error: 'worker not found' }, 404)
})
// corchRun validates the tasks (cwd exists, prompt non-empty, perAccount 1..4) and throws on a bad
// one; that is the caller's mistake, so it answers 400 with the reason rather than a 500.
app.post('/api/corch/workers', async (c) => {
  const body = await jsonBody(c)
  if (!Array.isArray(body.tasks) || !body.tasks.length)
    return c.json({ error: 'tasks must be a non-empty array' }, 400)
  const accounts = Array.isArray(body.accounts)
    ? body.accounts.filter((a): a is string => typeof a === 'string')
    : undefined
  try {
    return c.json(
      corchRun({
        tasks: body.tasks as Parameters<typeof corchRun>[0]['tasks'],
        group: optStr(body.group),
        accounts,
        perAccount: typeof body.perAccount === 'number' ? body.perAccount : undefined,
      }),
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
app.post('/api/corch/workers/:id/send', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.text !== 'string' || !body.text.trim())
    return c.json({ error: 'text is required' }, 400)
  return c.json(corchSend(c.req.param('id'), body.text))
})
app.post('/api/corch/cancel', async (c) => {
  const body = await jsonBody(c)
  const id = optStr(body.id)
  const group = optStr(body.group)
  if (!id && !group) return c.json({ error: 'id or group is required' }, 400)
  return c.json(corchCancel({ id, group }))
})

// --- quick add ---------------------------------------------------------------
app.post('/api/cli-instances/quick-add', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.email !== 'string') return c.json({ error: 'email is required' }, 400)
  const flow = startQuickAdd(body.email)
  return 'error' in flow ? c.json(flow, 400) : c.json(flow)
})
app.get('/api/cli-instances/quick-add', (c) => c.json(listQuickAdds()))
app.post('/api/cli-instances/quick-add/:id/code', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.code !== 'string') return c.json({ error: 'code is required' }, 400)
  return c.json(submitQuickAddCode(c.req.param('id'), body.code))
})
app.post('/api/cli-instances/quick-add/:id/cancel', (c) =>
  c.json(cancelQuickAdd(c.req.param('id'))),
)
