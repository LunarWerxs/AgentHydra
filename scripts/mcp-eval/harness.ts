// Behavioural eval harness for the AgentHydra MCP server.
//
// WHY: a lint of tool definitions cannot tell whether an agent can still REACH a known answer
// through the tools. This drives the real stdio server (server/src/mcp.ts, spawned exactly as an
// MCP client spawns it) against the frozen fleet in fixture.ts, asks the questions in
// qa-pairs.xml, and scores the answers. It records, per question, how many tool calls it took,
// which tools, how long, and any feedback the answering agent left about the tools.
//
// Two answerers, one scorer:
//   · the REFERENCE agent below (one scripted solution per question) runs in the test suite. It
//     pins the path a competent agent takes, so a renamed tool, a changed argument or a reshaped
//     result that breaks that path fails the eval.
//   · any real agent, through `run.ts --serve` (a visible chat connects to the same fixture server)
//     and `run.ts --score <answers.json>`. Nothing here launches a model: AgentHydra never starts
//     a run nobody can see (headless-policy.ts).
//
// Idea from the mcp-builder evaluation harness in anthropics/skills (Apache-2.0); written fresh.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type FixtureDaemon, startFixtureDaemon } from './fixture'

export const MCP_ENTRY = resolve(import.meta.dir, '../../server/src/mcp.ts')
export const DEFAULT_PAIRS = resolve(import.meta.dir, 'qa-pairs.xml')

export interface QaPair {
  id: string
  question: string
  answer: string
}

export interface TaskResult {
  id: string
  question: string
  expected: string
  actual: string | null
  correct: boolean
  toolCalls: number | null
  tools: Record<string, number>
  durationMs: number | null
  feedback?: string
  error?: string
}

export interface EvalReport {
  answerer: 'reference' | 'agent'
  total: number
  correct: number
  accuracy: number
  /** Every mutation the eval refused: a MUTATES: tool the client would not call, or a non-GET
   *  the fixture turned away. Non-empty means an answer path tried to change state. */
  mutationsRefused: string[]
  tasks: TaskResult[]
}

// --- questions --------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]).trim()

/** Read the mcp-builder `<evaluation><qa_pair>` format, plus the `id` this harness keys on. */
export function parseQaPairs(xml: string): QaPair[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  const pairs: QaPair[] = []
  for (const m of body.matchAll(/<qa_pair\b([^>]*)>([\s\S]*?)<\/qa_pair>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[1])?.[1]
    const question = /<question>([\s\S]*?)<\/question>/.exec(m[2])?.[1]
    const answer = /<answer>([\s\S]*?)<\/answer>/.exec(m[2])?.[1]
    if (!id || question === undefined || answer === undefined) {
      throw new Error(`qa_pair #${pairs.length + 1} needs an id, a <question> and an <answer>`)
    }
    pairs.push({ id, question: decode(question), answer: decode(answer) })
  }
  if (pairs.length === 0) throw new Error('no <qa_pair> found')
  return pairs
}

export function loadQaPairs(path = DEFAULT_PAIRS): QaPair[] {
  return parseQaPairs(readFileSync(path, 'utf8'))
}

/** Answers are short and single-valued, so compare them loosely: case, surrounding quotes, a
 *  leading `#` on an instance number and a trailing full stop are how agents vary, not errors. */
export function normalizeAnswer(s: string): string {
  return s
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.$/, '')
    .replace(/^#(?=\d)/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

// --- the MCP server under test ------------------------------------------------------------------

/** How an MCP client starts the server against the fixture. Shared by the harness's own client
 *  and `run.ts --serve`, so both talk to the same thing. `home` keeps the spawned server's data
 *  dir out of the real one. */
export function evalServerConfig(fixtureUrl: string, home: string) {
  return {
    command: process.execPath,
    args: [MCP_ENTRY],
    env: {
      AGENTHYDRA_URL: fixtureUrl,
      AGENTHYDRA_HOME: home,
      AGENTHYDRA_DB: join(home, 'eval.db'),
    },
  }
}

interface ToolInfo {
  name: string
  description?: string
}

interface Rpc {
  id?: number
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: ToolInfo[] }
  error?: { message: string }
}

const RPC_TIMEOUT_MS = 20_000

/** A minimal newline-delimited JSON-RPC client over the server's stdio, counting tool calls. */
export class McpStdioClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private next = 1
  private pending = new Map<number, (msg: Rpc) => void>()
  private tools: ToolInfo[] = []
  calls: string[] = []
  refusedMutations: string[] = []

  async start(config: ReturnType<typeof evalServerConfig>): Promise<void> {
    const proc = Bun.spawn([config.command, ...config.args], {
      env: { ...process.env, ...config.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    })
    this.proc = proc
    void this.readLines(proc.stdout as ReadableStream<Uint8Array>)
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agenthydra-mcp-eval', version: '1' },
    })
    this.tools = (await this.request('tools/list', {})).result?.tools ?? []
  }

  private async readLines(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true })
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const msg = JSON.parse(line) as Rpc
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg)
      }
    }
  }

  private request(method: string, params: unknown): Promise<Rpc> {
    const stdin = this.proc?.stdin
    if (!stdin || typeof stdin === 'number') throw new Error('the MCP server is not running')
    const id = this.next++
    return new Promise<Rpc>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`${method} got no answer in ${RPC_TIMEOUT_MS}ms`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        this.pending.delete(id)
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`))
        else res(msg)
      })
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      stdin.flush()
    })
  }

  toolNames(): string[] {
    return this.tools.map((t) => t.name)
  }

  /** Call one tool and parse its JSON result. A MUTATES: tool is refused before it is sent: eval
   *  questions are read-only, so reaching for one is itself a finding. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push(name)
    const tool = this.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`the server lists no tool named ${name}`)
    if (tool.description?.startsWith('MUTATES:')) {
      this.refusedMutations.push(`tool ${name}`)
      throw new Error(`${name} mutates state; eval questions are read-only`)
    }
    const res = await this.request('tools/call', { name, arguments: args })
    const text = res.result?.content?.[0]?.text ?? ''
    if (res.result?.isError) throw new Error(`${name} failed: ${text}`)
    return JSON.parse(text) as unknown
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }
}

// --- the reference agent ------------------------------------------------------------------------

type Call = (tool: string, args?: Record<string, unknown>) => Promise<unknown>
interface SurveyRow {
  num: number
  result: { snapshot: { weekAll: { pct: number } | null } }
}
interface NumberedInstance {
  num: number
  kind: string
  email: string | null
}
interface IncidentRow {
  key: string
  count: number
}

const weekly = (r: SurveyRow) => r.result.snapshot.weekAll?.pct ?? Number.NaN
const surveyRows = async (call: Call) => ((await call('list_usage')) as { rows: SurveyRow[] }).rows
const openIncidents = async (call: Call) =>
  (await call('list_incidents', { state: 'open' })) as IncidentRow[]
const pick = <T>(rows: T[], better: (a: T, b: T) => boolean): T =>
  rows.reduce((best, r) => (better(r, best) ? r : best))

/** One scripted solution per question id: the tool path an agent that read the descriptions
 *  should take. Keep each to the fewest calls that reach the answer. */
export const REFERENCE: Record<string, (call: Call) => Promise<string>> = {
  'most-weekly-headroom': async (call) =>
    String(pick(await surveyRows(call), (a, b) => weekly(a) < weekly(b)).num),
  'closest-to-weekly-cap': async (call) =>
    String(pick(await surveyRows(call), (a, b) => weekly(a) > weekly(b)).num),
  'instance-4-email': async (call) =>
    String(((await call('resolve_instance', { instance: 4 })) as NumberedInstance).email),
  'codex-instance-number': async (call) => {
    const all = (await call('list_instance_numbers')) as NumberedInstance[]
    return String(all.find((i) => i.kind === 'codex')?.num ?? 'none')
  },
  'open-incident-count': async (call) => String((await openIncidents(call)).length),
  'worst-open-incident': async (call) =>
    pick(await openIncidents(call), (a, b) => a.count > b.count).key,
}

// --- running and scoring ------------------------------------------------------------------------

function summarize(
  answerer: EvalReport['answerer'],
  tasks: TaskResult[],
  mutationsRefused: string[],
): EvalReport {
  const correct = tasks.filter((t) => t.correct).length
  return {
    answerer,
    total: tasks.length,
    correct,
    accuracy: tasks.length ? correct / tasks.length : 0,
    mutationsRefused,
    tasks,
  }
}

/** A running fixture plus a scratch data dir for the server, torn down together. */
export function startEvalEnvironment(): { fixture: FixtureDaemon; home: string; stop(): void } {
  const fixture = startFixtureDaemon()
  const home = mkdtempSync(join(tmpdir(), 'agenthydra-mcp-eval-'))
  return {
    fixture,
    home,
    stop: () => {
      fixture.stop()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Answer every pair with the reference agent over the real stdio server. */
export async function runReferenceEval(
  pairs: QaPair[] = loadQaPairs(),
  reference: Record<string, (call: Call) => Promise<string>> = REFERENCE,
): Promise<EvalReport> {
  const missing = pairs.filter((p) => !reference[p.id]).map((p) => p.id)
  if (missing.length) throw new Error(`no reference solution for: ${missing.join(', ')}`)

  const env = startEvalEnvironment()
  const client = new McpStdioClient()
  const tasks: TaskResult[] = []
  try {
    await client.start(evalServerConfig(env.fixture.url, env.home))
    for (const pair of pairs) {
      const before = client.calls.length
      const started = performance.now()
      let actual: string | null = null
      let error: string | undefined
      try {
        actual = await reference[pair.id]((name, args) => client.callTool(name, args))
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      const used = client.calls.slice(before)
      tasks.push({
        id: pair.id,
        question: pair.question,
        expected: pair.answer,
        actual,
        correct: actual !== null && normalizeAnswer(actual) === normalizeAnswer(pair.answer),
        toolCalls: used.length,
        tools: countBy(used),
        durationMs: Math.round(performance.now() - started),
        ...(error ? { error } : {}),
      })
    }
  } finally {
    client.stop()
    env.stop()
  }
  const refused = [...client.refusedMutations, ...env.fixture.refused.map((r) => `request ${r}`)]
  return summarize('reference', tasks, refused)
}

/** One agent answer, as `run.ts --serve` asks a real agent to write them. */
export interface AgentAnswer {
  id: string
  answer: string
  feedback?: string
  toolCalls?: number
  tools?: Record<string, number>
  durationMs?: number
}

/** Score a real agent's answers file against the pairs. A pair left unanswered counts as wrong. */
export function scoreAnswers(pairs: QaPair[], answers: AgentAnswer[]): EvalReport {
  const byId = new Map(answers.map((a) => [a.id, a]))
  const tasks = pairs.map((pair): TaskResult => {
    const a = byId.get(pair.id)
    const actual = typeof a?.answer === 'string' ? a.answer : null
    return {
      id: pair.id,
      question: pair.question,
      expected: pair.answer,
      actual,
      correct: actual !== null && normalizeAnswer(actual) === normalizeAnswer(pair.answer),
      toolCalls: a?.toolCalls ?? null,
      tools: a?.tools ?? {},
      durationMs: a?.durationMs ?? null,
      ...(a?.feedback ? { feedback: a.feedback } : {}),
      ...(a ? {} : { error: 'not answered' }),
    }
  })
  return summarize('agent', tasks, [])
}

function countBy(names: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of names) out[n] = (out[n] ?? 0) + 1
  return out
}

/** The human-readable report: one line per question, then the summary line. */
export function formatReport(r: EvalReport): string {
  const lines = r.tasks.map((t) => {
    const mark = t.correct ? 'PASS' : 'FAIL'
    const calls = t.toolCalls === null ? '' : ` ${t.toolCalls} call(s)`
    const tools = Object.keys(t.tools).length ? ` [${Object.keys(t.tools).join(', ')}]` : ''
    const ms = t.durationMs === null ? '' : ` ${t.durationMs}ms`
    const why = t.correct ? '' : ` - expected "${t.expected}", got "${t.actual ?? ''}"`
    const err = t.error ? ` (${t.error})` : ''
    const fb = t.feedback ? `\n      feedback: ${t.feedback}` : ''
    return `  ${mark} ${t.id}:${calls}${tools}${ms}${why}${err}${fb}`
  })
  if (r.mutationsRefused.length) lines.push(`  refused mutations: ${r.mutationsRefused.join(', ')}`)
  const pct = Math.round(r.accuracy * 100)
  lines.push(`mcp eval (${r.answerer}): ${r.correct}/${r.total} correct (${pct}%)`)
  return lines.join('\n')
}
