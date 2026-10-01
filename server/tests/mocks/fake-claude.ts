// server/tests/mocks/fake-claude.ts — a stand-in for the Claude Code CLI, for corch.test.ts.
//
// Speaks just enough of `claude -p --output-format stream-json`: reads the prompt on stdin, honours
// --session-id / --resume and CLAUDE_CONFIG_DIR. An account whose config dir holds a `fake-quota`
// marker answers with the CLI's own synthetic session-limit notice and exits 1; any other account
// finishes the turn with result 'FAKE DONE'. A --resume needs the transcript in its OWN config dir,
// exactly like the real CLI, so a handoff that forgot to copy it fails loudly.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const emit = (ev: unknown) => process.stdout.write(`${JSON.stringify(ev)}\n`)
const line = (ev: unknown) => `${JSON.stringify(ev)}\n`
// Like the real CLI, init reports the model it runs: the one `--model` named, else its default.
const init = () =>
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: flag('--model') ?? 'fake-model' })

function findTranscript(): string | null {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) return null
  for (const dir of readdirSync(projects)) {
    const p = join(projects, dir, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

if (existsSync(join(configDir, 'fake-quota'))) {
  const notice = "You've hit your session limit · resets 4am"
  const dir = join(configDir, 'projects', 'fake-proj')
  mkdirSync(dir, { recursive: true })
  const wall = {
    type: 'assistant',
    isApiErrorMessage: true,
    session_id: sessionId,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: notice }] },
  }
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }) + line(wall),
  )
  init()
  emit(wall)
  emit({ type: 'result', subtype: 'success', is_error: true, result: notice, session_id: sessionId, total_cost_usd: 0, num_turns: 1 })
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
  // requests would run into overage. Left alone it finishes here.
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
      utilization: 0.985,
      overageStatus: 'allowed',
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.985, resetsAt }, seven_day: { utilization: 0.1, resetsAt: resetsAt + 86400 } },
    },
  })
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'Still working, near the limit.' }] } })
  await Bun.sleep(6_000)
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'FINISHED NEAR LIMIT', session_id: sessionId, total_cost_usd: 1, num_turns: 1 })
  process.exit(0)
}

if (existsSync(join(configDir, 'fake-winddown'))) {
  // An account at 90% of its window, mid-task. After each "tool call" it reads the wind-down
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
      utilization: 0.9,
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.9, resetsAt }, seven_day: { utilization: 0.1, resetsAt: resetsAt + 86400 } },
    },
  })
  const settings = flag('--settings')
  const command: string = settings
    ? JSON.parse(readFileSync(settings, 'utf8')).hooks?.PostToolUse?.[0]?.hooks?.[0]?.command ?? ''
    : ''
  const signal = /cat '([^']+)'/.exec(command)?.[1] ?? ''
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(200)
    if (!signal || !existsSync(signal)) continue
    const context: string = JSON.parse(readFileSync(signal, 'utf8')).hookSpecificOutput.additionalContext
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
appendFileSync(
  transcript,
  line({ type: 'user', sessionId, message: { role: 'user', content: prompt } }) +
    line({ type: 'assistant', sessionId, message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'FAKE DONE' }] } }),
)
init()
emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'Working on it.' }] } })
// A session started from a handoff says so, so a test can see the handoff reached it.
const answer = prompt.includes('HANDOFF: step 3 of 5 done') ? 'FAKE DONE FROM HANDOFF' : 'FAKE DONE'
emit({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sessionId, total_cost_usd: 0.01, num_turns: 1 })
process.exit(0)
