// server/src/prefix-tax.ts - what does every spawn on this account re-ship before it says a word?
//
// WHY: every Claude/Codex worker sends the account's whole prefix on its first request: the system
// prompt, every built-in tool schema, and every schema of every MCP server the home loads. A fleet
// that runs several MCP servers per home pays that on each spawn, and nothing here said how big it
// was or which server made it big. This measures it locally and names the heaviest schemas, so a
// bloated MCP loadout is visible before a fan-out multiplies it.
//
// HOW (idea from JuliusBrussee/caveman's subagent-tax, written fresh here): a loopback SINK speaks
// the two wire protocols our harnesses use (anthropic-messages for Claude Code, openai-responses
// for Codex) and answers every request with "DONE". The harness is started with its base URL
// pointed at the sink, a placeholder key and every HTTP proxy cleared, so the request it would
// have sent to a model lands here instead. No model runs, no quota is spent, nothing leaves the
// machine. The capture carrying the MOST tool schemas is the prefix (a harness may send a small
// preliminary request first).
//
// NOT A CHAT (see headless-policy.ts): nothing converses. Like the `/usage` probe it asks the CLI
// one thing and reads a number back, it persists no transcript (`--no-session-persistence` for
// Claude, a throwaway CODEX_HOME for Codex), and it only ever runs when a person asks for it
// (`agenthydra --prefix-tax` or the Instances page button) - never on a timer, because a probe
// boots the home's whole MCP roster by design and that must not become a process mill.
//
// Request HEADERS are never read or stored, so a credential a harness might attach never reaches
// a capture. Only the JSON body is kept, and only its sizes leave this module.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { CLAUDE_PROJECTS_ROOT, DATA_DIR, resolveClaudeExe, resolveCodexExe } from './config'
import { listCliInstances } from './core/cli-instances'
import { codexInstanceStores } from './core/codex-instances'
import { instanceRef } from './core/instance-numbers'
import { killProcessTree } from './core/process'
import { createLoopbackGuard } from './loopback-guard.mjs'

export type PrefixProtocol = 'anthropic-messages' | 'openai-responses'

/** One tool schema's weight in the prefix. */
export interface ToolWeight {
  name: string
  /** UTF-8 bytes of the tool's JSON as sent (name + description + schema). */
  bytes: number
  /** The MCP server that contributed it, or null for a harness built-in. */
  mcpServer: string | null
}

/** One MCP server's total share of the prefix. */
export interface ServerWeight {
  server: string
  tools: number
  bytes: number
}

export interface PrefixTax {
  protocol: PrefixProtocol
  /** System prompt / instructions bytes (includes CLAUDE.md or AGENTS.md when the harness sends
   *  them there). */
  systemBytes: number
  /** Bytes of the messages/input items (the harness's own context blocks plus the tiny prompt). */
  messageBytes: number
  tools: number
  toolBytes: number
  mcpTools: number
  mcpToolBytes: number
  totalBytes: number
  /** bytes / 4: a rough token figure for scale, not a tokenizer count. */
  approxTokens: number
  /** Heaviest MCP servers first. */
  byServer: ServerWeight[]
  /** The heaviest tool schemas, built-in or MCP, heaviest first. */
  heaviest: ToolWeight[]
}

const HEAVIEST_KEPT = 8

const byteLen = (v: unknown): number =>
  v === undefined ? 0 : Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')

/** Claude Code and Codex both name MCP tools `mcp__<server>__<tool>`. */
function mcpServerOf(name: string): string | null {
  if (!name.startsWith('mcp__')) return null
  const server = name.slice(5).split('__')[0]
  return server ? server : null
}

function toolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return '?'
  const t = tool as { name?: unknown; type?: unknown }
  if (typeof t.name === 'string' && t.name) return t.name
  return typeof t.type === 'string' ? t.type : '?'
}

/**
 * Split one captured request body into what the prefix is made of. Null when the body is not a
 * model request of a protocol we know (a count_tokens call, a probe the harness makes of its own).
 */
export function analyzeCapture(protocol: PrefixProtocol, body: unknown): PrefixTax | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  let systemBytes = 0
  let messageBytes = 0
  if (protocol === 'anthropic-messages') {
    if (!Array.isArray(b.messages)) return null
    const sys = b.system
    if (typeof sys === 'string') systemBytes = byteLen(sys)
    else if (Array.isArray(sys))
      for (const block of sys) systemBytes += byteLen((block as { text?: unknown })?.text ?? '')
    messageBytes = byteLen(b.messages)
  } else {
    if (b.input === undefined && b.instructions === undefined) return null
    systemBytes = byteLen(typeof b.instructions === 'string' ? b.instructions : '')
    // Codex sends its developer/system context as input items; those are prefix too, so they are
    // counted with the instructions rather than hidden among the messages.
    for (const item of Array.isArray(b.input) ? b.input : []) {
      const role = (item as { role?: unknown })?.role
      if (role === 'system' || role === 'developer') systemBytes += byteLen(item)
      else messageBytes += byteLen(item)
    }
    if (typeof b.input === 'string') messageBytes += byteLen(b.input)
  }

  const weights: ToolWeight[] = (Array.isArray(b.tools) ? b.tools : []).map((tool) => {
    const name = toolName(tool)
    return { name, bytes: byteLen(tool), mcpServer: mcpServerOf(name) }
  })
  const servers = new Map<string, ServerWeight>()
  for (const w of weights) {
    if (!w.mcpServer) continue
    const s = servers.get(w.mcpServer) ?? { server: w.mcpServer, tools: 0, bytes: 0 }
    s.tools++
    s.bytes += w.bytes
    servers.set(w.mcpServer, s)
  }
  const mcp = weights.filter((w) => w.mcpServer)
  const toolBytes = weights.reduce((n, w) => n + w.bytes, 0)
  const totalBytes = systemBytes + messageBytes + toolBytes
  return {
    protocol,
    systemBytes,
    messageBytes,
    tools: weights.length,
    toolBytes,
    mcpTools: mcp.length,
    mcpToolBytes: mcp.reduce((n, w) => n + w.bytes, 0),
    totalBytes,
    approxTokens: Math.ceil(totalBytes / 4),
    byServer: [...servers.values()].sort((a, c) => c.bytes - a.bytes),
    heaviest: [...weights].sort((a, c) => c.bytes - a.bytes).slice(0, HEAVIEST_KEPT),
  }
}

/** The capture that IS the prefix: the one with the most tool schemas, the larger on a tie. */
export function pickPrefix(taxes: Array<PrefixTax | null>): PrefixTax | null {
  let best: PrefixTax | null = null
  for (const t of taxes) {
    if (!t) continue
    if (!best || t.tools > best.tools || (t.tools === best.tools && t.totalBytes > best.totalBytes))
      best = t
  }
  return best
}

// --- the sink ---------------------------------------------------------------------------------

export interface Capture {
  protocol: PrefixProtocol
  body: unknown
}

export interface PrefixSink {
  /** `http://127.0.0.1:<port>` - no trailing slash, no path. */
  url: string
  captures: Capture[]
  stop(): void
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

function sse(events: Array<[string, unknown]>): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
}

function anthropicDone(model: unknown, stream: boolean): Response {
  const message = {
    id: 'msg_prefix_tax',
    type: 'message',
    role: 'assistant',
    model: typeof model === 'string' ? model : 'prefix-tax-sink',
    content: [] as unknown[],
    stop_reason: null as string | null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  if (!stream)
    return Response.json({
      ...message,
      content: [{ type: 'text', text: 'DONE' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 1 },
    })
  const body = sse([
    ['message_start', { type: 'message_start', message }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
  return new Response(body, { headers: SSE_HEADERS })
}

function responsesDone(stream: boolean): Response {
  const item = {
    type: 'message',
    id: 'msg_prefix_tax',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'DONE', annotations: [] }],
  }
  const response = {
    id: 'resp_prefix_tax',
    object: 'response',
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1,
    },
  }
  if (!stream) return Response.json(response)
  const body = sse([
    [
      'response.created',
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    ],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response }],
  ])
  return new Response(body, { headers: SSE_HEADERS })
}

/**
 * Start the loopback sink on a free port. Loopback only: it is never reachable from another host,
 * and it stops with the probe.
 */
export function startPrefixSink(): PrefixSink {
  const captures: Capture[] = []
  const sink = new Hono()
  // Same exact-origin guard as every other listener in server/src (scripts/checks/
  // local-api-origin-allowlist.mjs). The harness sends no Origin and passes; no browser page has
  // any business here, so the allowlist is empty and any page on another localhost port is refused.
  sink.use('*', createLoopbackGuard({ allowedOrigins: () => [] }))
  sink.post('*', async (c) => {
    const path = new URL(c.req.url).pathname
    let body: unknown = null
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'not json' }, 400)
    }
    const b = (body ?? {}) as { stream?: unknown; model?: unknown }
    if (path.endsWith('/messages/count_tokens')) return c.json({ input_tokens: 0 })
    if (path.endsWith('/messages')) {
      captures.push({ protocol: 'anthropic-messages', body })
      return anthropicDone(b.model, b.stream === true)
    }
    if (path.endsWith('/responses')) {
      captures.push({ protocol: 'openai-responses', body })
      return responsesDone(b.stream !== false)
    }
    return c.json({ error: 'prefix-tax sink: unknown route' }, 404)
  })
  sink.all('*', (c) => c.json({ error: 'prefix-tax sink' }, 404))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: sink.fetch })
  return {
    url: `http://127.0.0.1:${server.port}`,
    captures,
    stop: () => server.stop(true),
  }
}

// --- the probes -------------------------------------------------------------------------------

/** A placeholder, never a credential: the sink ignores it and a real endpoint would refuse it. */
const SINK_KEY = 'prefix-tax-sink-placeholder'

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
]

/**
 * The child's environment: proxies cleared (a proxy would carry the request off the loopback),
 * every ambient model credential and base-URL override removed, then the sink pointed at.
 */
export function probeEnv(
  base: Record<string, string | undefined>,
  over: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
  for (const k of [
    ...PROXY_VARS,
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
  ])
    delete env[k]
  env.NO_PROXY = '127.0.0.1,localhost'
  env.no_proxy = '127.0.0.1,localhost'
  return { ...env, ...over }
}

/**
 * `claude -p` argv for a sink run. `--settings` carries the sink too, because settings files may
 * set an `env` block of their own and the flag outranks them: a home whose settings.json points
 * ANTHROPIC_BASE_URL at a real endpoint must still land here, never there.
 * `--no-session-persistence` keeps the probe out of the account's chat list.
 */
export function claudeProbeArgs(exe: string, sinkUrl: string): string[] {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: sinkUrl,
    ANTHROPIC_API_KEY: SINK_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  for (const k of PROXY_VARS) env[k] = ''
  return [exe, '-p', 'DONE', '--no-session-persistence', '--settings', JSON.stringify({ env })]
}

/** `codex exec` argv for a sink run: a provider of our own, so no home setting can reroute it. */
export function codexProbeArgs(exe: string, sinkUrl: string): string[] {
  const provider = `{ name = "prefix-tax sink", base_url = "${sinkUrl}/v1", env_key = "PREFIX_TAX_SINK_KEY", wire_api = "responses" }`
  return [
    exe,
    'exec',
    '--skip-git-repo-check',
    '-c',
    'model_provider="prefix_tax_sink"',
    '-c',
    `model_providers.prefix_tax_sink=${provider}`,
    'DONE',
  ]
}

export interface PrefixTaxRow {
  ref: string
  kind: 'claude' | 'codex'
  name: string
  home: string
  tax: PrefixTax | null
  error: string | null
  measuredAt: string
}

/** A capture with tools arrived; give a follow-up request this long before stopping the child. */
const SETTLE_MS = 1500
/** MCP servers boot before the first request; a slow roster can take most of a minute. */
const PROBE_TIMEOUT_MS = 120_000

async function runProbe(
  argv: string[],
  env: Record<string, string>,
  cwd: string | undefined,
  sink: PrefixSink,
): Promise<{ tax: PrefixTax | null; error: string | null }> {
  let proc: Bun.Subprocess
  try {
    proc = Bun.spawn(argv, {
      env,
      cwd,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
  } catch (e) {
    return { tax: null, error: `could not start ${argv[0]}: ${(e as Error).message}` }
  }
  let exited = false
  void proc.exited.then(() => {
    exited = true
  })
  const started = Date.now()
  let toolsSeenAt: number | null = null
  while (!exited && Date.now() - started < PROBE_TIMEOUT_MS) {
    if (
      toolsSeenAt === null &&
      sink.captures.some((c) => (analyzeCapture(c.protocol, c.body)?.tools ?? 0) > 0)
    )
      toolsSeenAt = Date.now()
    if (toolsSeenAt !== null && Date.now() - toolsSeenAt >= SETTLE_MS) break
    await Bun.sleep(200)
  }
  if (!exited && proc.pid) killProcessTree(proc.pid)
  const tax = pickPrefix(sink.captures.map((c) => analyzeCapture(c.protocol, c.body)))
  if (tax) return { tax, error: null }
  return {
    tax: null,
    error: exited
      ? 'the harness exited without sending a model request'
      : `no model request within ${PROBE_TIMEOUT_MS / 1000}s`,
  }
}

async function measureClaudeHome(
  configDir: string | null,
): Promise<{ tax: PrefixTax | null; error: string | null }> {
  const sink = startPrefixSink()
  try {
    const over: Record<string, string> = {
      ANTHROPIC_BASE_URL: sink.url,
      ANTHROPIC_API_KEY: SINK_KEY,
    }
    if (configDir) over.CLAUDE_CONFIG_DIR = configDir
    // A scratch cwd with no project .mcp.json or CLAUDE.md, so what is measured is the HOME's
    // loadout: the part every spawn on this account pays wherever it runs.
    const cwd = join(DATA_DIR, 'prefix-tax-probe')
    mkdirSync(cwd, { recursive: true })
    return await runProbe(
      claudeProbeArgs(resolveClaudeExe(), sink.url),
      probeEnv(process.env, over),
      cwd,
      sink,
    )
  } finally {
    sink.stop()
  }
}

/** The files a Codex home's prefix is made of: its config (MCP servers) and its AGENTS files. */
const CODEX_PREFIX_FILES = ['config.toml', 'AGENTS.md', 'AGENTS.override.md']

async function measureCodexHome(
  codexHome: string,
): Promise<{ tax: PrefixTax | null; error: string | null }> {
  // A throwaway CODEX_HOME with the prefix-bearing files copied in: Codex writes a rollout for
  // every exec, and in the real home that would surface as a chat in the account's list.
  const scratch = mkdtempSync(join(tmpdir(), 'ah-prefix-tax-'))
  const sink = startPrefixSink()
  try {
    for (const f of CODEX_PREFIX_FILES)
      if (existsSync(join(codexHome, f))) copyFileSync(join(codexHome, f), join(scratch, f))
    const env = probeEnv(process.env, { CODEX_HOME: scratch, PREFIX_TAX_SINK_KEY: SINK_KEY })
    return await runProbe(codexProbeArgs(resolveCodexExe(), sink.url), env, scratch, sink)
  } finally {
    sink.stop()
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // a child still holding a file; the OS temp sweep gets it
    }
  }
}

export interface PrefixTaxTarget {
  ref: string
  kind: 'claude' | 'codex'
  name: string
  home: string
}

/** Every Claude CLI home and Codex home this app manages, plus the default of each. */
export function prefixTaxTargets(): PrefixTaxTarget[] {
  const out: PrefixTaxTarget[] = [
    { ref: 'cli:default', kind: 'claude', name: 'default', home: dirname(CLAUDE_PROJECTS_ROOT) },
  ]
  for (const i of listCliInstances())
    out.push({ ref: instanceRef('cli', i.id), kind: 'claude', name: i.name, home: i.configDir })
  for (const s of codexInstanceStores())
    out.push({ ref: s.ref, kind: 'codex', name: s.name, home: s.codexHome })
  return out
}

/** Measure one target. Sequential by design at the call sites: each probe boots an MCP roster. */
export async function measurePrefixTax(target: PrefixTaxTarget): Promise<PrefixTaxRow> {
  const r =
    target.kind === 'claude'
      ? await measureClaudeHome(target.ref === 'cli:default' ? null : target.home)
      : await measureCodexHome(target.home)
  return { ...target, ...r, measuredAt: new Date().toISOString() }
}
