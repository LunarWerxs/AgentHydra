// server/tests/session-row-instance-effort.test.ts — what a Sessions row says about WHO ran it and AT
// WHAT EFFORT, which the sidebar renders as the `#71` chip and the model · effort tag.
//
// Measured on a real store (2026-10-03): every Claude row answered `instance_num: null` and
// `effort: null`, although 22 of the newest 200 rows had a Desktop profile with a permanent number
// and 38 transcripts carried an `effort` stamp on their assistant turns. Pinned here, through the
// same listSessions the route calls: a row from a known profile gets that profile's number, a
// transcript's own effort stamp is read, the effort CliMayte launched a session at beats it, and a
// row nothing records stays null rather than guessing.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-row-facts-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const projectDir = join(home, '.claude', 'projects', 'D--demo')
mkdirSync(projectDir, { recursive: true })

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
  AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
}
const SRC = (file: string) => JSON.stringify(join(import.meta.dir, '..', 'src', file))
const SPAWNS_A_CHILD_BUN = 30_000

const KNOWN = 'aaaaaaaa-0000-4000-8000-000000000001' // Desktop profile with a registry number
const UNNUMBERED = 'aaaaaaaa-0000-4000-8000-000000000002' // Desktop profile the registry never saw
const STAMPED = 'aaaaaaaa-0000-4000-8000-000000000003' // transcript stamps effort 'low'
const CLIMAYTE = 'aaaaaaaa-0000-4000-8000-000000000004' // CliMayte launched it at 'medium'
const BARE = 'aaaaaaaa-0000-4000-8000-000000000005' // nothing records an effort

/** A transcript with one real exchange. `effort` is the stamp Claude writes on an assistant turn. */
function transcript(sessionId: string, mtimeSec: number, effort?: string): void {
  const turn = (uuid: string, role: 'user' | 'assistant', ts: string) =>
    JSON.stringify({
      type: role,
      uuid,
      message: { role, content: 'hello', ...(role === 'assistant' ? { model: 'claude-x' } : {}) },
      ...(role === 'assistant' && effort ? { effort } : {}),
      cwd: 'D:\\demo',
      timestamp: ts,
    })
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    path,
    `${turn(`u-${sessionId}`, 'user', '2026-01-01T10:00:00.000Z')}\n${turn(`a-${sessionId}`, 'assistant', '2026-01-01T10:00:05.000Z')}\n`,
  )
  utimesSync(path, mtimeSec, mtimeSec)
}

/** One Desktop metadata file, in the layout the real store uses. */
function desktopRecord(instanceDir: string, sessionId: string, body: Record<string, unknown>) {
  const dir = join(home, '.claude-instances', instanceDir, 'claude-code-sessions', 'org', 'user')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `local_${sessionId}.json`),
    JSON.stringify({ cliSessionId: sessionId, isArchived: false, ...body }),
  )
}

transcript(KNOWN, 1_780_000_000)
transcript(UNNUMBERED, 1_780_000_100)
transcript(STAMPED, 1_780_000_200, 'low')
transcript(CLIMAYTE, 1_780_000_300, 'low')
transcript(BARE, 1_780_000_400)
desktopRecord('acct-known', KNOWN, {})
desktopRecord('acct-unnumbered', UNNUMBERED, {})
// The app's own setting for this chat disagrees with CliMayte's record; CliMayte chose the effort.
desktopRecord('acct-known', CLIMAYTE, { effort: 'max' })

interface Row {
  id: string
  instance: string | null
  instance_num: number | null
  effort: string | null
}
interface Listed {
  number: number
  rows: Row[]
}
let listed: Listed | null = null

/** listSessions() in a cold process, once for the file: the registry is given a number for
 *  `acct-known` only (what listInstances does when it first sees a profile), and CliMayte's record
 *  of one finished worker is written where the daemon keeps it. */
function list(): Listed {
  if (listed) return listed
  const body = `
    const { join } = require('node:path');
    const { mkdirSync, writeFileSync } = require('node:fs');
    const { instanceNumbers, instanceRef } = await import(${SRC('core/instance-numbers.ts')});
    const { POINTER_DIR } = await import(${SRC('instance.ts')});
    const ref = instanceRef('desktop', join(${JSON.stringify(home)}, '.claude-instances', 'acct-known'));
    const number = instanceNumbers([ref]).get(ref);
    mkdirSync(join(POINTER_DIR, 'corch', 'done'), { recursive: true });
    writeFileSync(join(POINTER_DIR, 'corch', 'done', 'w-fixture.json'), JSON.stringify({
      id: 'w-fixture',
      attempts: [{ sessionId: ${JSON.stringify(CLIMAYTE)}, requested: { model: null, effort: 'medium' } }],
    }));
    const { listSessions } = await import(${SRC('sessions.ts')});
    const rows = await listSessions({ limit: 50, sinceMs: null, archived: 'include' });
    console.log(JSON.stringify({ number, rows: rows.map((r) => ({
      id: r.session_id, instance: r.instance, instance_num: r.instance_num, effort: r.effort })) }));`
  const proc = Bun.spawnSync([process.execPath, '-e', body], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  listed = JSON.parse(out.slice(out.lastIndexOf('\n') + 1)) as Listed
  return listed
}
const row = (id: string): Row => {
  const found = list().rows.find((r) => r.id === id)
  if (!found) throw new Error(`session ${id} was not listed`)
  return found
}

test(
  'a row from a Desktop profile carries that profile permanent number; an unnumbered profile stays null',
  () => {
    const { number } = list()
    expect(number).toBeGreaterThan(0)
    expect(row(KNOWN)).toMatchObject({ instance: 'acct-known', instance_num: number })
    expect(row(UNNUMBERED)).toMatchObject({ instance: 'acct-unnumbered', instance_num: null })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a row takes the effort stamped on its own assistant turns',
  () => {
    expect(row(STAMPED).effort).toBe('low')
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a session CliMayte launched shows the effort CliMayte recorded, over the transcript and the app',
  () => {
    expect(row(CLIMAYTE).effort).toBe('medium')
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a row nothing records an effort for stays null',
  () => {
    expect(row(BARE).effort).toBeNull()
  },
  SPAWNS_A_CHILD_BUN,
)
