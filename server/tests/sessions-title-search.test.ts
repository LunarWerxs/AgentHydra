// server/src/sessions.ts - the title search answers from the scan cache and the index fields, parses
// a transcript the cache has never seen (in the background, within a short budget) and returns the
// best matches first. Each test is a cold process, so the first run has nothing cached and the
// second run in the same process is answered from the cache.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-title-search-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
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
const SESSIONS = JSON.stringify(join(import.meta.dir, '..', 'src', 'sessions.ts'))
const SPAWNS_A_CHILD_BUN = 30_000

const turn = (uuid: string, role: 'user' | 'assistant', text: string, ts: string) =>
  `${JSON.stringify({ type: role, uuid, message: { role, content: text }, cwd: 'D:\\demo', timestamp: ts })}\n`

function write(sessionId: string, firstMessage: string, mtimeSec: number): void {
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    path,
    turn(`${sessionId}-1`, 'user', firstMessage, '2026-08-19T04:00:00.000Z') +
      turn(`${sessionId}-2`, 'assistant', 'ok', '2026-08-19T04:00:05.000Z'),
  )
  utimesSync(path, mtimeSec, mtimeSec)
}

// The substring match in the newest title, the same substring in an older one, a title that only
// has the letters in order, and one that has nothing to do with it.
write('dddddddd-0000-4000-8000-00000000000a', 'fix the login timeout', 1_770_000_000)
write('dddddddd-0000-4000-8000-00000000000b', 'login page redesign', 1_770_000_500)
write('dddddddd-0000-4000-8000-00000000000c', 'lots of old green inputs', 1_770_001_000)
write('dddddddd-0000-4000-8000-00000000000d', 'water the plants', 1_770_001_500)

function search(title: string, runs: number, extra = ''): string[][] {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { listSessions } = await import(${SESSIONS});
      const out = [];
      for (let i = 0; i < ${runs}; i++) {
        const rows = await listSessions({ limit: 50, archived: 'include', title: ${JSON.stringify(title)}${extra} });
        out.push(rows.map((r) => r.session_id.slice(-1)));
      }
      console.log(JSON.stringify(out));`,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  return JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
}

test(
  'a transcript nobody has parsed is still found, and the match survives the cache',
  () => {
    const [cold, warm] = search('login', 2)
    // Substring matches only, best first within a tier means the more recent one (b) leads.
    expect(cold).toEqual(['b', 'a', 'c'])
    expect(warm).toEqual(['b', 'a', 'c'])
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a search that matches nothing returns nothing',
  () => {
    expect(search('zzzz', 1)[0]).toEqual([])
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'offset pages past the best matches',
  () => {
    expect(search('login', 1, ', offset: 1')[0]).toEqual(['a', 'c'])
  },
  SPAWNS_A_CHILD_BUN,
)
