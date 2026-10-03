// Manager MCP endpoint: `/api/corch/mcp/:managerId` gives a manager only its wave's tools and
// no verdict tool. Every call is refused unless that worker is the live manager of a running wave
// and the calling process is that worker's CLI (callerPidOf in index.ts, against the attempt's pid).
// The tools act on the CALLING manager's wave: managerTools(managerId) closes over the manager.
// See docs/CLIMAYTE.md, "Scope and identity of the manager endpoint".

import { spawnSync } from 'node:child_process'
import type { Hono } from 'hono'
import {
  CliMayteSplitNeeded,
  climayteCancel,
  climayteRun,
  climayteSend,
  climayteWave,
  climayteWaveEdit,
} from './climayte'
import { load, workers } from './climayte-core'
import type { CliMayteWave } from './climayte-lib'
import { waveStateText } from './climayte-wave'
import { VERSION } from './config'
import { handleMcpHttp, PARSE_ERROR } from './mcp-http.mjs'
import { handleRpc, type McpEngineTool } from './mcp-stdio.mjs'

type Task = CliMayteWave['tasks'][number]

/** The text caps: the manager's notes and its report. */
export const WAVE_TEXT_CAP = 2000

/** Appended to every brief a manager dispatches. */
export const DISPATCH_SUFFIX =
  'Do not deploy, publish or release; end with a line `Commits: <sha> ...` or `Commits: none`.'

const NO_WAVE = 'This manager has no wave on record.'

/** The wave of `managerId`: the id its worker carries. */
function waveIdOf(managerId: string): string | null {
  return workers.get(managerId)?.wave ?? null
}

/** Edit the manager's own wave; the answer says so when it is gone. */
function onWave<T>(managerId: string, fn: (wave: CliMayteWave) => T): T | { error: string } {
  const id = waveIdOf(managerId)
  const out = id ? climayteWaveEdit(id, fn) : null
  return out === null ? { error: NO_WAVE } : out
}

const taskOf = (wave: CliMayteWave, key: unknown): Task | undefined =>
  wave.tasks.find((t) => t.key === key)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Why `task` cannot be dispatched now, or null. */
function refusal(wave: CliMayteWave, task: Task): string | null {
  if (task.kind === 'manage') return 'a wave task cannot be of kind manage (no manager of managers)'
  if (task.state === 'passed') return 'already passed'
  const live = task.workerId ? workers.get(task.workerId) : undefined
  if (task.state === 'running' && live && (live.status === 'running' || live.status === 'queued'))
    return `already running (${live.id})`
  const unmet = task.after.filter((k) => taskOf(wave, k)?.state !== 'passed')
  if (unmet.length) return `after not met: ${unmet.join(', ')} must pass first`
  // The first dispatch is not a re-dispatch: the limit counts the ones after it.
  if ((task.dispatches ?? 0) - 1 >= wave.maxRounds)
    return `past maxRounds (${wave.maxRounds} re-dispatches): escalate it or report`
  return null
}

/** Start ONE worker for `task` through climayte_run's own path, in the wave's group. */
function startTask(wave: CliMayteWave, task: Task): Record<string, unknown> {
  try {
    const reply = climayteRun({
      tasks: [
        {
          prompt: `${task.prompt}\n\n${DISPATCH_SUFFIX}`,
          cwd: wave.cwd,
          title: task.title,
          kind: task.kind,
          ...(task.check ? { check: task.check } : {}),
        },
      ],
      group: wave.group,
      model: 'auto',
      wave: wave.id,
      copies: true,
    })
    const id = reply.workers[0]?.id as string
    task.workerId = id
    task.state = 'running'
    task.proof = null
    task.dispatches = (task.dispatches ?? 0) + 1
    wave.rounds = Math.max(wave.rounds, task.dispatches - 1)
    return { key: task.key, started: id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      key: task.key,
      refused: err instanceof CliMayteSplitNeeded ? `split needed: ${message}` : message,
    }
  }
}

/** The table the report starts with: one line per key, then the branch head (git, hidden). */
function reportTable(wave: CliMayteWave): string {
  const head = spawnSync('git', ['rev-parse', wave.branch], {
    cwd: wave.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  const sha = head.status === 0 ? (head.stdout ?? '').trim() : 'unknown'
  const lines = wave.tasks.map((t) => {
    const p = t.proof
    const proof = p
      ? [
          p.check === null ? '' : `check ${p.check ? 'pass' : 'fail'}`,
          p.paths === null ? '' : `paths ${p.paths ? 'ok' : 'mismatch'}`,
          p.note,
        ]
          .filter(Boolean)
          .join('; ')
      : 'none'
    return `${t.key} | ${t.state} | ${proof} | ${p?.commits.length ? p.commits.join(' ') : 'none'}`
  })
  return [`key | state | proof | commits`, ...lines, `branch ${wave.branch} head ${sha}`].join('\n')
}

/** The seven wave tools, bound to the wave of `managerId`. Each writes the wave record after a
 *  change and answers compact JSON. */
export function managerTools(managerId: string): McpEngineTool[] {
  return [
    {
      name: 'wave_state',
      description:
        'Read the current wave state and the state of its tasks. Used at the start of a wake to decide what to dispatch, re-dispatch, or escalate.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const id = waveIdOf(managerId)
        const wave = id ? climayteWave(id) : null
        return wave ? waveStateText(wave, workers) : { error: NO_WAVE }
      },
    },
    {
      name: 'wave_dispatch',
      description:
        "Dispatch tasks into the wave's group, one worker per key. Refuses a key whose `after` keys have not passed, the manage kind (no manager of managers) and a key past maxRounds; each key answers started (worker id) or refused (why).",
      inputSchema: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task keys from the plan to dispatch or re-dispatch.',
          },
        },
        required: ['keys'],
      },
      run: async (args) => {
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
        if (!keys.length) return { error: 'keys must be a non-empty array of task keys' }
        return onWave(managerId, (wave) => {
          if (wave.status !== 'running') return { error: `the wave is ${wave.status}` }
          return {
            results: keys.map((key) => {
              const task = taskOf(wave, key)
              if (!task) return { key, refused: 'no such key in this wave' }
              const why = refusal(wave, task)
              return why ? { key, refused: why } : startTask(wave, task)
            }),
          }
        })
      },
    },
    {
      name: 'wave_send',
      description:
        'Send a message to the current worker of a task in the wave (for a follow-up on an escalated or stuck key).',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The task key.' },
          text: { type: 'string', description: 'The message text.' },
        },
        required: ['key', 'text'],
      },
      run: async (args) =>
        onWave(managerId, (wave) => {
          const task = taskOf(wave, args.key)
          if (!task) return { error: `no such key: ${str(args.key)}` }
          if (!task.workerId) return { error: `${task.key} has no worker yet` }
          return climayteSend(task.workerId, str(args.text))
        }),
    },
    {
      name: 'wave_cancel',
      description: 'Cancel the running worker of a task in the wave; the task becomes failed.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The task key.' } },
        required: ['key'],
      },
      run: async (args) =>
        onWave(managerId, (wave) => {
          const task = taskOf(wave, args.key)
          if (!task) return { error: `no such key: ${str(args.key)}` }
          if (!task.workerId) return { error: `${task.key} has no worker to cancel` }
          if (task.state === 'passed') return { error: `${task.key} already passed` }
          const { cancelled } = climayteCancel({ id: task.workerId })
          task.state = 'failed'
          task.proof = {
            check: task.proof?.check ?? null,
            commits: task.proof?.commits ?? [],
            paths: task.proof?.paths ?? null,
            note: 'Cancelled by the manager.',
          }
          return { key: task.key, cancelled, state: task.state }
        }),
    },
    {
      name: 'wave_escalate',
      description:
        'Mark a task as escalated (needs orchestrator decision): a report says something was left undone, a worker made a choice the plan does not cover, or a plan step says to deploy.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The task key.' },
          reason: { type: 'string', description: 'Why this task is escalated.' },
        },
        required: ['key', 'reason'],
      },
      run: async (args) =>
        onWave(managerId, (wave) => {
          const task = taskOf(wave, args.key)
          if (!task) return { error: `no such key: ${str(args.key)}` }
          wave.escalations.push({ key: task.key, reason: str(args.reason), at: Date.now() })
          task.state = 'escalated'
          return { key: task.key, state: task.state }
        }),
    },
    {
      name: 'wave_note',
      description: "Set the wave's notes (the manager's scratch, capped at 2,000 chars).",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The notes text.' } },
        required: ['text'],
      },
      run: async (args) =>
        onWave(managerId, (wave) => {
          wave.notes = str(args.text).slice(0, WAVE_TEXT_CAP)
          return { ok: true, chars: wave.notes.length }
        }),
    },
    {
      name: 'wave_report',
      description:
        'Report that the wave is done: every key is passed, failed or escalated. At most 2,000 chars; the daemon prefixes a table with one line per key.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: "The manager's final report." } },
        required: ['text'],
      },
      run: async (args) =>
        onWave(managerId, (wave) => {
          if (wave.status !== 'running') return { error: `the wave is already ${wave.status}` }
          wave.report = `${reportTable(wave)}\n\n${str(args.text).slice(0, WAVE_TEXT_CAP)}`
          wave.status = 'reported'
          return { ok: true, status: wave.status }
        }),
    },
  ]
}

const MANAGER_INSTRUCTIONS =
  'You are the manager of a wave. These tools let you read the wave state, dispatch tasks, handle escalations, and report when done. You never deploy, publish or release. End with a line `Commits: <sha>...` or `Commits: none` in every brief.'

/** POST /api/corch/mcp/:managerId. Refused unless the worker is a manager with a wave and the
 *  calling process is that worker's CLI: its latest attempt's pid against `callerPidOf` (the OS's
 *  answer for the socket; null when it cannot be told, which never matches). */
export function registerManagerMcpRoute(
  app: Hono,
  callerPidOf: (c: { env: unknown; req: { raw: Request } }) => Promise<number | null>,
): void {
  app.post('/api/corch/mcp/:managerId', async (c) => {
    const managerId = c.req.param('managerId')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      body = PARSE_ERROR
    }
    load()
    const manager = workers.get(managerId)
    const attempt = manager?.attempts[manager.attempts.length - 1]
    if (!manager || manager.kind !== 'manage' || !manager.wave || !attempt)
      return c.json({ error: 'Not a valid manager of a running wave' }, 403)
    const callerPid = await callerPidOf(c)
    if (callerPid === null || attempt.pid !== callerPid)
      return c.json({ error: "Caller is not the manager's CLI process" }, 403)
    const ctx = {
      serverInfo: { name: 'climayte-manager', version: VERSION },
      tools: managerTools(managerId),
      instructions: MANAGER_INSTRUCTIONS,
    }
    const { status, json } = await handleMcpHttp(body, ctx, handleRpc)
    return json === null ? c.body(null, status as 202) : c.json(json, status as 200)
  })
}
