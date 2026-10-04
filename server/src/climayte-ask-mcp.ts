// Worker MCP endpoint: `/api/corch/ask/:workerId` gives one CliMayte worker the tool climayte_ask,
// so a headless worker can ask the one that started it a question instead of guessing. Every call
// is refused unless the calling process is that worker's own CLI (callerPidOf in index.ts, against
// the worker's latest attempt's pid), the same check the manager endpoint makes, so a worker cannot
// ask in another's name. A refusal is a 404, never a 401 or 403 (callerRefused). The question is recorded on the worker and pinged to its origin (climayteAsk,
// climayte-ping.ts); the tool answers at once and never holds the CLI open. See docs/CLIMAYTE.md,
// "Questions from a worker".

import type { Hono } from 'hono'
import { climayteAsk } from './climayte'
import { load, workers } from './climayte-core'
import type { CliMayteAttempt } from './climayte-lib'
import { readRunnerPids } from './climayte-runner'
import { VERSION } from './config'
import { handleMcpHttp, PARSE_ERROR } from './mcp-http.mjs'
import { handleRpc, type McpEngineTool } from './mcp-stdio.mjs'

/** The tool, bound to the worker `workerId`. */
export function askTools(workerId: string): McpEngineTool[] {
  return [
    {
      name: 'climayte_ask',
      description:
        'Ask the chat or worker that started you ONE question when you are blocked on a real decision the task does not settle and a wrong guess would cost real work. Give `question` (self-contained: the asker sees nothing of your session), `options` (the answers you would choose between, if it is a choice) and `context` (what you found and what you will do meanwhile). The call answers at once and does not wait: after it, end your turn with one line saying what you asked; the answer arrives as a message and this same session resumes with it. Do not ask what you can look up or decide yourself: make the reasonable call and say which.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, self-contained.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'The answers you would choose between, when it is a choice.',
          },
          context: { type: 'string', description: 'What you found, and what you do meanwhile.' },
        },
        required: ['question'],
      },
      run: async (args) => climayteAsk(workerId, args),
    },
  ]
}

const ASK_INSTRUCTIONS =
  'You are a CliMayte worker. climayte_ask puts one question to whoever started you; then end your turn and the answer resumes this session.'

/** The pid of an attempt's CLI: the attempt's own, or, until the daemon's next poll takes it
 *  (takeRunnerPids, climayte.ts), the one its runner wrote the moment the CLI started. The CLI
 *  connects to its MCP servers within a second or two of starting, before that poll: measured
 *  2026-10-04, account #35's and this account's CLI cached `climayte-worker` as needing sign-in 2
 *  to 5 s after their attempts started, with the attempt's pid still unread. */
export function attemptCliPid(at: CliMayteAttempt): number | null {
  if (at.pid != null) return at.pid
  return at.runner ? (readRunnerPids(at.runner.pidFile)?.child ?? null) : null
}

/** The status a refused caller gets: 404, never 401 or 403. Claude Code reads BOTH 401 and 403 from
 *  an http MCP server as "needs authorization" (2.1.286: its auth check is `status===401||
 *  status===403`), shows the server as needing sign-in instead of failed, and writes that into the
 *  account's `mcp-needs-auth-cache.json` for 15 minutes, keyed by server name: every worker started
 *  on that account in that window skipped `climayte-worker` without even connecting. A 404 is a
 *  plain failure the next CLI tries again. */
export const CALLER_REFUSED = 404

/** POST /api/corch/ask/:workerId. Refused unless the worker's latest attempt is the calling process
 *  (attemptCliPid): `callerPidOf` is the OS's answer for the socket, null when it cannot be told,
 *  which never matches. */
export function registerAskMcpRoute(
  app: Hono,
  callerPidOf: (c: { env: unknown; req: { raw: Request } }) => Promise<number | null>,
): void {
  app.post('/api/corch/ask/:workerId', async (c) => {
    const workerId = c.req.param('workerId')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      body = PARSE_ERROR
    }
    load()
    const worker = workers.get(workerId)
    const attempt = worker?.attempts[worker.attempts.length - 1]
    if (!worker || !attempt) return c.json({ error: 'Not a valid CliMayte worker' }, CALLER_REFUSED)
    const callerPid = await callerPidOf(c)
    if (callerPid === null || attemptCliPid(attempt) !== callerPid)
      return c.json({ error: "Caller is not the worker's CLI process" }, CALLER_REFUSED)
    const ctx = {
      serverInfo: { name: 'climayte-worker', version: VERSION },
      tools: askTools(workerId),
      instructions: ASK_INSTRUCTIONS,
    }
    const { status, json } = await handleMcpHttp(body, ctx, handleRpc)
    return json === null ? c.body(null, status as 202) : c.json(json, status as 200)
  })
}
