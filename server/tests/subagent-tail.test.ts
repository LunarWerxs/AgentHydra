// server/tests/subagent-tail.test.ts - opening an Agent step into what the agent did.
//
// Claude writes a Task-tool subagent's run to `<project>/<session>/subagents/agent-<id>.jsonl`,
// beside a meta.json naming the toolUseId of the call that started it. The viewer asks for a run by
// that call id, so the contract is the lookup: the call opens ITS agent's transcript, a call with
// no agent answers "not found" rather than another agent's run, and an id can never reach a file
// outside that one session's folder.
//
// A child Bun with its own HOME, for the reason sessions-limit-stop.test.ts gives: config.ts fixes
// the store's location at import time, and `bun test` shares one process across files.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = join(tmpdir(), `ah-subagent-${crypto.randomUUID()}`)
const projectDir = join(home, '.claude', 'projects', 'D--demo')
const SESSION = '0f4e2a6c-1111-4222-8333-944455556666'
const subDir = join(projectDir, SESSION, 'subagents')
mkdirSync(subDir, { recursive: true })
mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })

const line = (type: 'user' | 'assistant', content: unknown) =>
  `${JSON.stringify({ type, isSidechain: type === 'assistant', cwd: 'D:\\demo', timestamp: '2026-10-04T10:00:00.000Z', message: { role: type, content } })}\n`

writeFileSync(
  join(projectDir, `${SESSION}.jsonl`),
  line('user', 'find the bug') +
    line('assistant', [
      { type: 'tool_use', id: 'toolu_01Find', name: 'Agent', input: { description: 'Find it' } },
    ]),
)
// two agents, so a lookup that takes the first file it sees is caught
for (const [agent, call, said] of [
  ['agent-a1', 'toolu_01Other', 'the other agent'],
  ['agent-a2', 'toolu_01Find', 'found it in parser.ts'],
] as const) {
  writeFileSync(
    join(subDir, `${agent}.meta.json`),
    JSON.stringify({ toolUseId: call, description: said }),
  )
  writeFileSync(join(subDir, `${agent}.jsonl`), line('user', 'look') + line('assistant', said))
}
// another session's agent: a lookup that searched wider than this session's folder would find it
const elsewhere = join(projectDir, 'another-session', 'subagents')
mkdirSync(elsewhere, { recursive: true })
writeFileSync(
  join(elsewhere, 'agent-z.meta.json'),
  JSON.stringify({ toolUseId: 'toolu_01Elsewhere' }),
)
writeFileSync(join(elsewhere, 'agent-z.jsonl'), line('assistant', 'not yours'))

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
}
const TRANSCRIPT = JSON.stringify(join(import.meta.dir, '..', 'src', 'transcript.ts'))

function tail(call: string): { texts: string[]; error: string | null } {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { tailSubagent } = await import(${TRANSCRIPT});
       const r = await tailSubagent(${JSON.stringify(SESSION)}, ${JSON.stringify(call)});
       console.log(JSON.stringify({ texts: r.events.map((e) => e.text), error: r.error ?? null }));`,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  return JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
}

// Each case spawns a child Bun that imports the transcript module from source; nothing is timed.
const SPAWNS_A_CHILD_BUN = 30_000

test(
  'an Agent call opens the run of the agent it started, not another one',
  () => {
    expect(tail('toolu_01Find')).toEqual({ texts: ['look', 'found it in parser.ts'], error: null })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  "a call with no agent here, another session's agent, or an id shaped like a path finds nothing",
  () => {
    for (const call of [
      'toolu_01Nobody',
      'toolu_01Elsewhere',
      '../another-session/subagents/agent-z',
    ]) {
      const r = tail(call)
      expect(r.texts).toEqual([])
      expect(r.error).toBeTruthy()
    }
  },
  SPAWNS_A_CHILD_BUN,
)
