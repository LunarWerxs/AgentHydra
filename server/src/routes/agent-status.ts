// Live agent status (server/src/agent-status.ts) over HTTP: the Claude Code hook receiver, the
// read side for the web session list and the MCP tool, and the opt-in hook installer
// (server/src/status-hooks.ts).
import {
  getAgentStatus,
  hookEventFromPayload,
  listAgentStatus,
  recordAgentStatus,
} from '../agent-status'
import { app } from '../http-app'
import { DEFAULT_URL, readInstanceInfo } from '../instance'
import { setStatusHooks, statusHooksState } from '../status-hooks'

// The hook receiver. Always 204 with no body, whatever arrives: a hook that failed or printed
// something would surface inside the agent's session, and a status signal must never do that.
app.post('/api/agent-status/hook', async (c) => {
  const body = await c.req.json().catch(() => null)
  const event = hookEventFromPayload(body, new Date().toISOString())
  if (event) recordAgentStatus(event)
  return c.body(null, 204)
})

app.get('/api/agent-status', (c) => c.json(listAgentStatus()))

app.get('/api/agent-status/hooks', (c) => c.json(statusHooksState()))

// { install: true } writes the hooks into Claude Code's user settings for THIS daemon's URL;
// { install: false } removes only them. Both answer the resulting state.
app.post('/api/agent-status/hooks', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { install?: unknown } | null
  if (typeof body?.install !== 'boolean') return c.json({ error: 'install must be a boolean' }, 400)
  const url = readInstanceInfo()?.url ?? DEFAULT_URL
  const result = setStatusHooks(body.install ? url : null)
  return c.json(result, result.error ? 500 : 200)
})

// Registered after /hooks so that path is never read as a session id.
app.get('/api/agent-status/:sessionId', (c) => {
  const status = getAgentStatus(c.req.param('sessionId'))
  if (!status) return c.json({ error: 'no status recorded for this session' }, 404)
  return c.json(status)
})
