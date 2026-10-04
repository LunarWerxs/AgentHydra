// server/tests/loop-detector.test.ts — a session stuck re-running one failing tool call is noticed.
//
// The contract: a session whose transcript ends with the same failing tool call, same input, five
// times in a row is reported as ONE incident, and stays one while the loop keeps growing (an
// incident per sweep would page the owner every minute). A shorter run (four), or a run of five
// broken by a call with a different input, is not a loop.
//
// Runs in a child Bun with its own HOME for the same reason sessions-limit-stop.test.ts does:
// config.ts resolves the store and the database from env/homedir() at import time, and `bun test`
// shares one process across files, so an in-process override would point at the real ~/.claude.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = join(tmpdir(), `ccmui-loopdetect-${crypto.randomUUID()}`)
const projectDir = join(home, '.claude', 'projects', 'D--demo')
mkdirSync(projectDir, { recursive: true })
mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })
mkdirSync(join(home, '.codex', 'archived_sessions'), { recursive: true })

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
}
const src = (file: string) => JSON.stringify(join(import.meta.dir, '..', 'src', `${file}.ts`))

const SPAWNS_A_CHILD_BUN = 30_000

/** Transcript lines for Bash calls `from`, `from + 1`, … each failing with the same error. */
function failingCalls(sessionId: string, cwd: string, letter: string, inputs: string[], from = 0) {
  const line = (rest: Record<string, unknown>) =>
    `${JSON.stringify({ ...rest, sessionId, cwd, timestamp: new Date().toISOString() })}\n`
  return inputs
    .map((command, i) => {
      const id = `toolu_${letter}${from + i}`
      return (
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
          },
        }) +
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                is_error: true,
                content: 'error: build failed',
              },
            ],
          },
        })
      )
    })
    .join('')
}

function transcript(sessionId: string, cwd: string, letter: string, inputs: string[]): string {
  const path = join(projectDir, `${sessionId}.jsonl`)
  const opening = { type: 'user', message: { role: 'user', content: 'build it' }, sessionId, cwd }
  writeFileSync(path, `${JSON.stringify(opening)}\n${failingCalls(sessionId, cwd, letter, inputs)}`)
  return path
}

const BUILD = 'bun run build'
const ALPHA = 'cccccccc-0000-4000-8000-000000000001'
const alphaPath = transcript(ALPHA, 'D:\\demo\\alpha', 'a', Array(5).fill(BUILD))
transcript('cccccccc-0000-4000-8000-000000000002', 'D:\\demo\\beta', 'b', Array(4).fill(BUILD))
transcript('cccccccc-0000-4000-8000-000000000003', 'D:\\demo\\gamma', 'c', [
  BUILD,
  BUILD,
  'bun run build --verbose',
  BUILD,
  BUILD,
])
// The stuck session's sixth try, written between the two sweeps.
const sixth = failingCalls(ALPHA, 'D:\\demo\\alpha', 'a', [BUILD], 5)

test(
  'five identical failing calls in a row are one incident, however long the loop runs; four, or a broken run, are none',
  () => {
    // Desktop notifications default ON, and a test must never pop a real notification on the
    // developer's screen, so they are switched off before anything else runs. The second sweep
    // rebuilds the index first, so it really reads the grown transcript rather than skipping it as
    // unchanged.
    const proc = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const { appendFileSync } = await import('node:fs');
        const { setSetting } = await import(${src('db')});
        setSetting('notify_enabled', '0');
        const { scanForLoops } = await import(${src('loop-detector')});
        const { listIncidents } = await import(${src('incidents')});
        const { ensureTranscriptIndex } = await import(${src('transcript')});
        const first = await scanForLoops();
        appendFileSync(${JSON.stringify(alphaPath)}, ${JSON.stringify(sixth)});
        await ensureTranscriptIndex(true);
        const second = await scanForLoops();
        console.log(JSON.stringify({ first, second, incidents: listIncidents().map((i) => ({ scope: i.scope, key: i.key, count: i.count })) }));`,
      ],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    const out = proc.stdout.toString().trim()
    if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
    const { first, second, incidents } = JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(incidents).toEqual([{ scope: 'session-loop', key: 'D:\\demo\\alpha', count: 1 }])
  },
  SPAWNS_A_CHILD_BUN,
)
