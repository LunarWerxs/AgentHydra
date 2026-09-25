#!/usr/bin/env node
// Idea from nexu-io/open-design mocks/mock-agent.mjs (Apache-2.0); written fresh for AgentHydra,
// no code copied. Differences: recordings live in the repo (no download step), and there is a
// Codex app-server JSON-RPC mode because that is the protocol AgentHydra actually speaks to Codex.
//
// WHY THIS EXISTS. The daemon spawns real agent CLIs and parses what they print: `claude -p
// /usage` (usage.ts), `claude -p --output-format stream-json` (dispatch.ts, transcript.ts) and
// `codex app-server` (core/codex-rpc.ts). A test that runs the real CLI burns an account's quota
// and is not repeatable; a test that stubs the parser skips the process boundary, which is where
// the pipe, line-splitting and exit-code bugs live. This script stands in for the CLI: it is
// spawned the same way, prints a RECORDED session in that CLI's own wire format, and exits.
//
//   node mock-agent.mjs --as claude -p "prompt" --output-format stream-json
//   node mock-agent.mjs --as codex app-server
//
// The wrappers in ./bin (claude, codex, claude.cmd, codex.cmd) put it on PATH, or point
// AGENTHYDRA_CLAUDE_PATH / AGENTHYDRA_CODEX_PATH at one of them.
//
// Which recording plays (first match wins):
//   1. AGENTHYDRA_MOCK_RECORDING  a recording name (file stem) or a path to a .json file
//   2. the sha256 of the prompt (the positional arg, or stdin when there is none) against a
//      recording's `promptSha256`, among recordings for this agent and mode
//   3. the recording marked `"default": true` for this agent and mode
// AGENTHYDRA_MOCK_RECORDINGS_DIR swaps the folder searched (default: ./recordings beside this file).
// AGENTHYDRA_MOCK_NO_DELAY=1 skips each recording's `delayMs` pacing, for fast tests.
//
// Recording shape (JSON):
//   { "agent": "claude" | "codex", "mode": "text" | "json" | "stream-json" | "exec-json" | "app-server",
//     "default"?: true, "promptSha256"?: "<hex>", "delayMs"?: 0,
//     "stdout"?: [line, ...], "stderr"?: [line, ...], "exitCode"?: 0,        // every mode but app-server
//     "responses"?: { "<method>": [{ "result": ... } | { "error": {...} }, ...] },   // app-server
//     "afterInitialized"?: [message, ...] }                                           // app-server
// A stdout/stderr entry that is a string is written as one line; anything else as one JSON line.
// An app-server method's responses are used in order and the last one repeats. The built-in
// method `mock/received` answers with every message the client has sent so far, so a test can
// see what the client said back (for example, how it answered a server-initiated request).

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RECORDINGS = process.env.AGENTHYDRA_MOCK_RECORDINGS_DIR || join(HERE, 'recordings')
const NO_DELAY = process.env.AGENTHYDRA_MOCK_NO_DELAY === '1'

// Flags that take a value, so the value is never mistaken for the prompt.
const CLAUDE_VALUED = new Set([
  '--output-format',
  '--input-format',
  '--mcp-config',
  '--model',
  '--fallback-model',
  '--resume',
  '-r',
  '--session-id',
  '--permission-mode',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--append-system-prompt',
  '--system-prompt',
  '--max-turns',
  '--settings',
  '--add-dir',
])
const CODEX_VALUED = new Set([
  '-m',
  '--model',
  '-C',
  '--cd',
  '-s',
  '--sandbox',
  '-c',
  '--config',
  '-p',
  '--profile',
  '-o',
  '--output-last-message',
  '-i',
  '--image',
  '--color',
])

function fail(message) {
  process.stderr.write(`mock-agent: ${message}\n`)
  process.exit(2)
}

function positionals(args, valued) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (valued.has(arg)) i++
    else if (!arg.startsWith('-') || arg === '-') out.push(arg)
  }
  return out
}

function flagValue(args, name) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/** The CLI mode the arguments ask for, and the prompt they carry (undefined = read stdin). */
function parseInvocation(agent, args) {
  if (agent === 'claude') {
    if (!args.includes('-p') && !args.includes('--print'))
      fail('only print mode (-p) is recorded; the interactive TUI is not')
    const format = flagValue(args, '--output-format') ?? 'text'
    const mode = format === 'stream-json' ? 'stream-json' : format === 'json' ? 'json' : 'text'
    return { mode, prompt: positionals(args, CLAUDE_VALUED)[0] }
  }
  if (agent === 'codex') {
    if (args[0] === 'app-server') return { mode: 'app-server', prompt: null }
    if (args[0] === 'exec' || args[0] === 'e') {
      const rest = positionals(args.slice(1), CODEX_VALUED)
      const prompt = rest.at(-1)
      return { mode: args.includes('--json') ? 'exec-json' : 'text', prompt }
    }
    fail(`codex ${args[0] ?? ''} is not recorded (app-server and exec are)`)
  }
  fail(`unknown agent "${agent}"`)
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

function loadRecording(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read recording ${path}: ${error.message}`)
  }
}

function pickRecording(agent, mode, prompt) {
  const wanted = process.env.AGENTHYDRA_MOCK_RECORDING?.trim()
  if (wanted) {
    const path = wanted.endsWith('.json') && existsSync(wanted) ? wanted : join(RECORDINGS, `${wanted}.json`)
    return loadRecording(path)
  }
  const candidates = readdirSync(RECORDINGS)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => loadRecording(join(RECORDINGS, name)))
    .filter((rec) => rec.agent === agent && rec.mode === mode)
  if (prompt != null) {
    const sha = createHash('sha256').update(prompt).digest('hex')
    const hit = candidates.find((rec) => rec.promptSha256 === sha)
    if (hit) return hit
  }
  return candidates.find((rec) => rec.default) ?? fail(`no recording for ${agent} ${mode}`)
}

const pause = (ms) =>
  NO_DELAY || !(ms > 0) ? Promise.resolve() : new Promise((done) => setTimeout(done, ms))

function lineOf(entry) {
  return `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`
}

async function replayStream(rec) {
  for (const entry of rec.stderr ?? []) process.stderr.write(lineOf(entry))
  for (const entry of rec.stdout ?? []) {
    await pause(rec.delayMs)
    process.stdout.write(lineOf(entry))
  }
  process.exitCode = rec.exitCode ?? 0
}

/** Answer JSON-RPC requests from the recording, one line per message, until stdin closes. */
function replayAppServer(rec) {
  const received = []
  const used = new Map()
  const send = (message) => process.stdout.write(lineOf(message))
  const answer = (method) => {
    const list = rec.responses?.[method]
    if (!Array.isArray(list) || list.length === 0)
      return { error: { code: -32601, message: `mock: no recorded response for ${method}` } }
    const n = used.get(method) ?? 0
    used.set(method, n + 1)
    return list[Math.min(n, list.length - 1)]
  }
  const lines = createInterface({ input: process.stdin })
  let queue = Promise.resolve()
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    // Serialised so paced replies still leave in the order their requests arrived.
    queue = queue.then(async () => {
      if (message.method === 'mock/received') {
        send({ id: message.id, result: { messages: received.slice() } })
        return
      }
      received.push(message)
      if (message.method === 'initialized') {
        for (const out of rec.afterInitialized ?? []) {
          await pause(rec.delayMs)
          send(out)
        }
        return
      }
      if (message.method === undefined || message.id === undefined) return
      await pause(rec.delayMs)
      send({ id: message.id, ...answer(message.method) })
    })
  })
  lines.on('close', () => {
    queue.then(() => process.exit(0))
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const asAt = argv.indexOf('--as')
  if (asAt < 0 || !argv[asAt + 1]) fail('usage: mock-agent.mjs --as <claude|codex> <cli args...>')
  const agent = argv[asAt + 1]
  const args = argv.filter((_, i) => i !== asAt && i !== asAt + 1)
  const { mode, prompt } = parseInvocation(agent, args)
  if (mode === 'app-server') return replayAppServer(pickRecording(agent, mode, null))
  const text = prompt === undefined || prompt === '-' ? await readStdin() : prompt
  await replayStream(pickRecording(agent, mode, text))
}

await main()
