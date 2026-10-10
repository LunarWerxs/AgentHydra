// server/tests/mocks/fake-claude.ts — a stand-in for the Claude Code CLI, for climayte.test.ts.
//
// Speaks just enough of `claude -p --output-format stream-json`: reads the prompt on stdin, honours
// --session-id / --resume and CLAUDE_CONFIG_DIR. An account whose config dir holds a `fake-quota`
// marker answers with the CLI's own synthetic session-limit notice and exits 1; any other account
// finishes the turn with result 'FAKE DONE'. A --resume needs the transcript in its OWN config dir,
// exactly like the real CLI, so a handoff that forgot to copy it fails loudly.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : null
}
const resume = flag('--resume')
const sessionId = resume ?? flag('--session-id') ?? crypto.randomUUID()
const configDir = process.env.CLAUDE_CONFIG_DIR ?? ''
const prompt = await Bun.stdin.text()

// Every launch is recorded in the account's folder, so a test can see the cache TTL it was given, the
// session it ran in and the prompt it started from.
if (configDir)
  appendFileSync(
    join(configDir, 'fake-launches.jsonl'),
    `${JSON.stringify({ ttl: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null, session: sessionId, resume: !!resume, prompt, brief: flag('--append-system-prompt') })}
`,
  )

const emit = (ev: unknown) => process.stdout.write(`${JSON.stringify(ev)}\n`)
const line = (ev: unknown) => `${JSON.stringify(ev)}\n`
const readJson = (path: string | null): Record<string, unknown> | null => {
  try {
    return path ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}
// The CLI's deniedMcpServers `serverUrl` match (2.1.286, read from its binary): a `*` scheme is any
// scheme, a `*` in the host matches within the host and then any port, and in the path and query
// `*` is any run of characters; a pattern with no path matches any path.
function urlMatches(url: string, pattern: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const p = /^([^:/]+):\/\/([^/?#]*)(.*)$/.exec(pattern)
  if (!p) return false
  const [, scheme, authority, rest] = p as unknown as [string, string, string, string]
  const glob = (s: string, any: string) =>
    new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', any)}$`)
  const [host = '', port] = authority.split(':')
  if (scheme !== '*' && `${scheme}:` !== u.protocol) return false
  if (!glob(host.toLowerCase(), '[^/]*').test(u.hostname.toLowerCase())) return false
  if (port !== undefined ? port !== '*' && port !== u.port : !host.includes('*') && u.port !== '')
    return false
  return rest === '' || glob(rest, '.*').test(u.pathname + u.search)
}
// Like the real CLI, init lists the session's MCP servers: the account's user scope
// (CLAUDE_CONFIG_DIR's .claude.json, none under --strict-mcp-config) and --mcp-config's, a name in
// both being one server, less any the --settings file's deniedMcpServers deny by name or by URL.
function mcpServers(): { name: string; status: string }[] {
  const servers: Record<string, { url?: string }> = {
    ...(args.includes('--strict-mcp-config')
      ? {}
      : ((readJson(join(configDir, '.claude.json'))?.mcpServers as object) ?? {})),
    ...((readJson(flag('--mcp-config'))?.mcpServers as object) ?? {}),
  }
  const denied =
    (readJson(flag('--settings'))?.deniedMcpServers as { serverName?: string; serverUrl?: string }[]) ?? []
  const isDenied = (name: string) =>
    denied.some(
      (d) =>
        d.serverName === name ||
        (d.serverUrl !== undefined && urlMatches(servers[name]?.url ?? '', d.serverUrl)),
    )
  return Object.keys(servers)
    .filter((name) => !isDenied(name))
    .sort()
    .map((name) => ({ name, status: 'connected' }))
}
// Like the real CLI, init reports the model it runs: the one `--model` named, else its default.
const init = () =>
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: flag('--model') ?? 'fake-model',
    mcp_servers: mcpServers(),
  })

function findTranscript(): string | null {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) return null
  for (const dir of readdirSync(projects)) {
    const p = join(projects, dir, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

// `FAKE-THRASH` in the prompt: the run ends in Claude Code's context thrash error. The resume that
// carries the thrash note ("Your context thrashed") runs on normally.
if (/FAKE-THRASH/.test(prompt) && !/Your context thrashed/.test(prompt)) {
  const dir = join(configDir, 'projects', 'fake-proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: prompt } })}\n`,
  )
  init()
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.',
    session_id: sessionId,
    total_cost_usd: 0,
    num_turns: 3,
  })
  process.exit(1)
}
if (existsSync(join(configDir, 'fake-quota'))) {
  // Three hours out unless the marker names minutes, its zone named. A fixed "resets 4am" is 04:00Z
  // under bun test, so from 03:30Z every night the wall was within the wait-at-home window and the
  // move never came.
  const minutes = Number(readFileSync(join(configDir, 'fake-quota'), 'utf8').trim()) || 180
  const at = new Date(Date.now() + minutes * 60_000)
  const h = at.getUTCHours()
  const clock = `${h % 12 || 12}:${String(at.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
  const notice = `You've hit your session limit · resets ${clock} (UTC)`
  const dir = join(configDir, 'projects', 'fake-proj')
  mkdirSync(dir, { recursive: true })
  const wall = {
    type: 'assistant',
    isApiErrorMessage: true,
    session_id: sessionId,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: notice }] },
  }
  // With `FAKE-SPEND:<n>` in the prompt it worked (n output tokens) before the wall, as a real one does.
  const worked = Number(/FAKE-SPEND:(\d+)/.exec(prompt)?.[1] ?? 0)
  const work = worked
    ? line({
        type: 'assistant',
        sessionId,
        timestamp: new Date().toISOString(),
        requestId: `req-${sessionId}-work`,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          id: `msg-${sessionId}-work`,
          usage: { input_tokens: 0, output_tokens: worked, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'Working.' }],
        },
      })
    : ''
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }) + work + line(wall),
  )
  init()
  emit(wall)
  emit({ type: 'result', subtype: 'success', is_error: true, result: notice, session_id: sessionId, total_cost_usd: 0, num_turns: 1 })
  process.exit(1)
}

if (existsSync(join(configDir, 'fake-org-disabled'))) {
  // An account whose organization turned Claude Code off (#91 in run 1): init, then the refusal,
  // and nothing written. Its folder was gone by the next move, so any transcript copied in before
  // the attempt goes with it.
  rmSync(join(configDir, 'projects'), { recursive: true, force: true })
  const text =
    'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access'
  init()
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: sessionId, total_cost_usd: 0, num_turns: 1 })
  process.exit(1)
}

if (existsSync(join(configDir, 'fake-identity'))) {
  // An account whose identity is not verified yet: the CLI refuses the turn with a 400 and writes nothing.
  rmSync(join(configDir, 'projects'), { recursive: true, force: true })
  const text = 'API Error: 400 Identity verification is required to continue.'
  init()
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: sessionId, total_cost_usd: 0, num_turns: 1 })
  process.exit(1)
}

if (existsSync(join(configDir, 'fake-overage'))) {
  // An account with paid extra usage switched on: the window runs out, the CLI says so in its own
  // rate_limit_event (shape measured live 2026-09-30) and carries on, billing overage, for as
  // long as nobody stops it.
  const dir = join(configDir, 'projects', 'fake-proj')
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }),
  )
  init()
  emit({
    type: 'rate_limit_event',
    session_id: sessionId,
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      overageStatus: 'allowed',
      isUsingOverage: true,
      overageInUse: true,
    },
  })
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'Still working, on overage.' }] } })
  await Bun.sleep(6_000)
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'FINISHED ON OVERAGE', session_id: sessionId, total_cost_usd: 1, num_turns: 1 })
  process.exit(0)
}

if (existsSync(join(configDir, 'fake-near-limit'))) {
  // An account that CAN bill (extra usage switched on), at 98.5% of its 5-hour window: the next
  // requests would run into overage. Left alone it finishes here. A marker reading 'rising': the
  // account reads 50% on the first request and climbs to 98.5% on the next.
  const dir = join(configDir, 'projects', 'fake-proj')
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }),
  )
  init()
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  const reading = (utilization: number) =>
    emit({
      type: 'rate_limit_event',
      session_id: sessionId,
      rate_limit_info: {
        status: utilization >= 0.8 ? 'allowed_warning' : 'allowed',
        rateLimitType: 'five_hour',
        resetsAt,
        utilization,
        overageStatus: 'allowed',
        isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization, resetsAt }, seven_day: { utilization: 0.1, resetsAt: resetsAt + 86400 } },
      },
    })
  if (readFileSync(join(configDir, 'fake-near-limit'), 'utf8').includes('rising')) {
    reading(0.5)
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'Working.' }] } })
    await Bun.sleep(1_500)
  }
  reading(0.985)
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'Still working, near the limit.' }] } })
  await Bun.sleep(6_000)
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'FINISHED NEAR LIMIT', session_id: sessionId, total_cost_usd: 1, num_turns: 1 })
  process.exit(0)
}

if (existsSync(join(configDir, 'fake-winddown'))) {
  // An account at 87% of its window (past the stop line, short of the ceiling), mid-task. After each "tool call" it reads the wind-down
  // signal the way the CLI's PostToolUse hook would (the hook command names the signal file), and
  // when one appears it writes the handoff the message asks for and ends its turn.
  const dir = join(configDir, 'projects', 'fake-proj')
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }),
  )
  init()
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  emit({
    type: 'rate_limit_event',
    session_id: sessionId,
    rate_limit_info: {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      resetsAt,
      utilization: 0.87,
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.87, resetsAt }, seven_day: { utilization: 0.1, resetsAt: resetsAt + 86400 } },
    },
  })
  const settings = flag('--settings')
  const hook = settings ? JSON.parse(readFileSync(settings, 'utf8')).hooks?.PostToolUse?.[0]?.hooks?.[0] : null
  const command: string = hook?.command ?? ''
  const signal = /cat '([^']+)'/.exec(command)?.[1] ?? ''
  // The hook is either the `cat` command (the settings as the daemon wrote them) or an http hook (the
  // runner rewrote them to point at itself): the CLI calls it the same way a real one would.
  const signalContext = async (): Promise<string | null> => {
    if (hook?.type === 'http') {
      const body = (await (await fetch(hook.url, { method: 'POST', body: '{}' })).json()) as {
        hookSpecificOutput?: { additionalContext?: string }
      }
      return body.hookSpecificOutput?.additionalContext ?? null
    }
    if (!signal || !existsSync(signal)) return null
    return JSON.parse(readFileSync(signal, 'utf8')).hookSpecificOutput.additionalContext
  }
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(200)
    const context = await signalContext()
    if (!context) continue
    const path = /Write tool to (\S+?\.md)/.exec(context)?.[1]
    if (path) writeFileSync(path, 'HANDOFF: step 3 of 5 done; next is step 4.')
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Handoff written.', session_id: sessionId, total_cost_usd: 0.5, num_turns: 1 })
    process.exit(0)
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'NO WIND-DOWN', session_id: sessionId, total_cost_usd: 1, num_turns: 1 })
  process.exit(0)
}

// `fake-slow`: a first turn that runs 30 s (long enough to be steered or cancelled mid-run); a
// resumed turn answers at once, saying whether it was given the steering message.
if (existsSync(join(configDir, 'fake-slow'))) {
  let file = findTranscript()
  if (!file) {
    const dir = join(configDir, 'projects', 'fake-proj')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `${sessionId}.jsonl`)
  }
  appendFileSync(file, line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }))
  init()
  if (!resume) {
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'Working slowly.' }] } })
    await Bun.sleep(30_000)
  }
  const answer = prompt.includes('STEER NOW') ? 'STEERED' : 'SLOW DONE'
  emit({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sessionId, total_cost_usd: 0.01, num_turns: 1 })
  process.exit(0)
}

// A `fake-leftover` file on the account: the session starts a background process that outlives it
// (a dev server left running) and writes its pid beside the marker.
if (existsSync(join(configDir, 'fake-leftover'))) {
  const { spawn } = await import('node:child_process')
  const bg = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  bg.unref()
  writeFileSync(join(configDir, 'leftover.pid'), String(bg.pid))
}

let transcript = findTranscript()
if (resume && !transcript) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`)
  process.exit(1)
}
if (!transcript) {
  const dir = join(configDir, 'projects', 'fake-proj')
  mkdirSync(dir, { recursive: true })
  transcript = join(dir, `${sessionId}.jsonl`)
}
// `FAKE-SPEND:<n>` in the prompt: the done turn bills n output tokens, so the task has a cost on record.
// A `fake-reread` file (holding n) on the account: a resumed session's first request writes n tokens
// to the cache, the conversation read again where the cache does not hold it, and outputs 50k.
const rereadFile = join(configDir, 'fake-reread')
const reread = resume && existsSync(rereadFile) ? Number(readFileSync(rereadFile, 'utf8')) : 0
const spend = Number(/FAKE-SPEND:(\d+)/.exec(prompt)?.[1] ?? 0) || (reread ? 50_000 : 0)
const billed = spend
  ? {
      timestamp: new Date().toISOString(),
      requestId: `req-${sessionId}-${Date.now()}`,
      usage: { input_tokens: 0, output_tokens: spend, cache_read_input_tokens: 0, cache_creation_input_tokens: reread },
    }
  : null
// `FAKE-EDIT:<name>` in the prompt: the session writes <cwd>/<name> with the Write tool, as its
// transcript records it, and does not commit it.
const edited = /FAKE-EDIT:(\S+)/.exec(prompt)?.[1]
let editLine = ''
if (edited) {
  const file = join(process.cwd(), edited)
  writeFileSync(file, 'drafted\n')
  editLine = line({
    type: 'assistant',
    sessionId,
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'tool_use', id: `toolu-${sessionId}`, name: 'Write', input: { file_path: file, content: 'drafted\n' } }],
    },
  })
}
appendFileSync(
  transcript,
  line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }) +
    editLine +
    line({
      type: 'assistant',
      sessionId,
      ...(billed ? { timestamp: billed.timestamp, requestId: billed.requestId } : {}),
      message: {
        role: 'assistant',
        model: billed ? 'claude-sonnet-5-5' : 'fake-model',
        ...(billed ? { id: `msg-${sessionId}`, usage: billed.usage } : {}),
        content: [{ type: 'text', text: 'FAKE DONE' }],
      },
    }),
)
init()
// `FAKE-CONTEXT:<n>` in the prompt: the newest request read n tokens (the conversation's size).
const context = Number(/FAKE-CONTEXT:(\d+)/.exec(prompt)?.[1] ?? 0)
// `FAKE-ETA:<n>` in the prompt: the first text is the brief's `ETA: <n> min` line.
const eta = /FAKE-ETA:(\d+)/.exec(prompt)?.[1]
emit({
  type: 'assistant',
  session_id: sessionId,
  message: {
    role: 'assistant',
    model: 'fake-model',
    ...(context ? { usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: context, cache_creation_input_tokens: 0 } } : {}),
    content: [{ type: 'text', text: eta ? `ETA: ${eta} min\n\nWorking on it.` : 'Working on it.' }],
  },
})
// A session started from a handoff says so, so a test can see the handoff reached it.
const answer = prompt.includes('HANDOFF: step 3 of 5 done') ? 'FAKE DONE FROM HANDOFF' : 'FAKE DONE'
// `FAKE-COMMITS:<shas>` in the prompt: the report ends with the Commits line a wave task is judged on.
const commits = /FAKE-COMMITS:(\S+)/.exec(prompt)?.[1]
const report = commits ? `${answer}\nCommits:${commits.replaceAll(',', ' ')}` : answer
emit({ type: 'result', subtype: 'success', is_error: false, result: report, session_id: sessionId, total_cost_usd: 0.01, num_turns: 1 })
process.exit(0)
