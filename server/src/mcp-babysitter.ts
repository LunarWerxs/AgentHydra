// server/src/mcp-babysitter.ts - the `babysitter` MCP tool: which chats a usage limit stopped, on which account,
// when each limit resets, and what the babysitter continued. The babysitter lives in AgentHydra 2.0 (Desk,
// desk2/server/src/plugins/72-babysitter.ts), so this file keeps no state: it reads Desk's /api/babysitter, which
// answers from its last look (a few local reads every five minutes, no model), and turns its times into ISO.
import { desk2Present, desk2Url } from './desk2'
import { S } from './mcp-client'
import type { McpEngineTool } from './mcp-stdio.mjs'

// The parts of desk2/shared/babysitter.ts this reads. Not imported: a release build may carry no desk2/.
interface Chat {
  id: string
  session: string | null
  title: string
  source: string
  account: string
  stoppedAt: number
  notice: string | null
  resetsAt: number | null
  state: string
  reason: string
  tries: number
}
interface Account {
  account: string
  stopped: number
  resetsAt: number | null
}
interface Act {
  at: number
  id: string
  title: string
  account: string
  did: string
  detail: string
}
interface Status {
  enabled: boolean
  checkedAt: number | null
  nextCheckAt: number | null
  stopped: Chat[]
  accounts: Account[]
  acts: Act[]
  error: string | null
}

const ACTS_SHOWN = 10
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

async function babysitter(args: { fresh?: boolean; enabled?: boolean }): Promise<unknown> {
  if (!desk2Present())
    throw new Error(
      'The babysitter lives in AgentHydra 2.0 (desk2/), which this install does not have.',
    )
  const base = desk2Url()
  let res: Response
  try {
    res =
      typeof args.enabled === 'boolean'
        ? await fetch(`${base}/api/babysitter`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: args.enabled, check: args.fresh === true }),
            signal: AbortSignal.timeout(30_000),
          })
        : await fetch(`${base}/api/babysitter${args.fresh ? '?fresh=1' : ''}`, {
            signal: AbortSignal.timeout(30_000),
          })
  } catch {
    throw new Error(
      `AgentHydra's window (Desk 2, ${base}) is not answering. The babysitter runs there: open AgentHydra, then call again.`,
    )
  }
  const json = (await res.json().catch(() => null)) as (Status & { error?: string }) | null
  if (!res.ok || !json)
    throw new Error(
      res.status === 404
        ? 'This AgentHydra window predates the babysitter: restart it (Restart to update in its menu).'
        : (json?.error ?? `HTTP ${res.status}`),
    )
  return {
    enabled: json.enabled,
    checkedAt: iso(json.checkedAt),
    nextCheckAt: iso(json.nextCheckAt),
    stopped: json.stopped.map((c) => ({
      id: c.id,
      session: c.session,
      title: c.title,
      source: c.source,
      account: c.account,
      state: c.state,
      reason: c.reason,
      stoppedAt: iso(c.stoppedAt),
      resetsAt: iso(c.resetsAt),
      tries: c.tries,
    })),
    accounts: json.accounts.map((a) => ({
      account: a.account,
      stopped: a.stopped,
      resetsAt: iso(a.resetsAt),
    })),
    recent: json.acts.slice(0, ACTS_SHOWN).map((a) => ({ ...a, at: iso(a.at) })),
    error: json.error,
  }
}

export const BABYSITTER_TOOLS: McpEngineTool[] = [
  {
    name: 'babysitter',
    description:
      "Chats a usage limit stopped, right now, and what AgentHydra's babysitter does about them: each stopped chat (a Desk chat, or a Claude Desktop or CLI session) with its account, when it stopped, when its limit resets, its state (waiting for the reset, resumed, no-engine: nothing runs it to take a message, gave-up: it stopped again at once three times, left to a person) and why; the stopped count and soonest reset per account; and the last 10 things it did. The babysitter looks every 5 minutes and as soon as a known reset passes, and continues each chat once its limit has reset (a Desk chat through its send queue, a Desktop chat over its own input channel). Answers from its last look in milliseconds, no model asked; `fresh` looks first (a few local reads). MUTATES only with `enabled`: turns the babysitter on or off (it is on by default).",
    inputSchema: S({
      fresh: { type: 'boolean', description: 'Look now before answering.' },
      enabled: {
        type: 'boolean',
        description: 'MUTATES: turn the babysitter on (true) or off (false).',
      },
    }),
    run: (args) => babysitter(args as { fresh?: boolean; enabled?: boolean }),
  },
]
