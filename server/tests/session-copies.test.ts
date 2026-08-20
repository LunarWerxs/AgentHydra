// server/tests/session-copies.test.ts — one conversation, several transcripts.
//
// Interrupt a chat and resume it and the CLI does not keep writing to the same file: it opens a new
// transcript, replays the history and carries on. So one conversation becomes two or three files
// with different session ids, and in a list they look like unrelated chats that happen to share a
// title. The owner hit this and asked, reasonably, where they had all come from.
//
// THE FIX IS A LABEL, NOT A FOLD, AND THAT WAS A MEASUREMENT RATHER THAN A PREFERENCE. Hiding all
// but the fullest copy is the obvious move and it is wrong: across all 36 such transcripts on a
// real store, EVERY older copy held turns the newer one did not. They were not bookkeeping — they
// were the user's own words, typically the last thing said before the interruption ("See you
// soon.", "skip domains4sale.uk,, do the rest"), which the resumed file never carried over. Not one
// was safely absorbable, so nothing is hidden and the rows are told which copy they are.
//
// The grouping key is the FIRST message's uuid. A uuid is unique, so two transcripts whose first
// message is the same message necessarily share that history — no content comparison needed, and
// no reliance on the title, which two genuinely different chats routinely share.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-copies-'))
const projectDir = join(home, '.claude', 'projects', 'D--demo')
mkdirSync(projectDir, { recursive: true })
mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })
mkdirSync(join(home, '.codex', 'archived_sessions'), { recursive: true })

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
}
const SESSIONS = JSON.stringify(join(import.meta.dir, '..', 'src', 'sessions.ts'))
const SPAWNS_A_CHILD_BUN = 30_000

function child<T>(body: string): T {
  const proc = Bun.spawnSync([process.execPath, '-e', body], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  return JSON.parse(out.slice(out.lastIndexOf('\n') + 1)) as T
}

const turn = (uuid: string, role: 'user' | 'assistant', text: string, ts: string) =>
  `${JSON.stringify({ type: role, uuid, message: { role, content: text }, cwd: 'D:\\demo', timestamp: ts })}\n`

/** Write a transcript and stamp its mtime, which is what orders the copies. */
function write(sessionId: string, body: string, mtimeSec: number): void {
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(path, body)
  utimesSync(path, mtimeSec, mtimeSec)
}

const OPENING = '11111111-1111-4111-8111-111111111111'

// Part one: the conversation, interrupted. Its LAST turn is the thing the resumed copy never has.
write(
  'cccccccc-0000-4000-8000-00000000000a',
  turn(OPENING, 'user', 'start the migration', '2026-08-19T04:00:00.000Z') +
    turn('a1', 'assistant', 'starting', '2026-08-19T04:00:05.000Z') +
    turn('a2', 'user', 'see you soon', '2026-08-19T04:10:00.000Z'),
  1_770_000_000,
)
// Part two: resumed. Replays the opening (same uuid), carries on, and does NOT carry 'a2'.
write(
  'cccccccc-0000-4000-8000-00000000000b',
  turn(OPENING, 'user', 'start the migration', '2026-08-19T04:00:00.000Z') +
    turn('a1', 'assistant', 'starting', '2026-08-19T04:00:05.000Z') +
    turn('b1', 'assistant', 'resumed and finished it', '2026-08-19T05:00:00.000Z') +
    turn('b2', 'user', 'thanks', '2026-08-19T05:00:10.000Z'),
  1_770_000_500,
)
// An unrelated conversation that happens to open with a different message.
write(
  'cccccccc-0000-4000-8000-00000000000c',
  turn(
    '99999999-9999-4999-8999-999999999999',
    'user',
    'something else',
    '2026-08-19T06:00:00.000Z',
  ) + turn('c1', 'assistant', 'sure', '2026-08-19T06:00:05.000Z'),
  1_770_001_000,
)

interface Row {
  id: string
  copy_index: number
  copy_count: number
  msgs: number
}
/** listSessions() in a cold process. `runs` calls it more than once in the SAME process. */
function list(runs = 1): Row[] {
  return child(`const { listSessions } = await import(${SESSIONS});
    let rows;
    for (let i = 0; i < ${runs}; i++)
      rows = await listSessions({ limit: 50, sinceMs: null, archived: 'include' });
    console.log(JSON.stringify(rows.map((r) => ({ id: r.session_id, copy_index: r.copy_index, copy_count: r.copy_count, msgs: r.message_count }))));`)
}

test(
  'two transcripts of one conversation are both listed, and both say so',
  () => {
    const rows = list()
    const a = rows.find((r) => r.id.endsWith('000a'))
    const b = rows.find((r) => r.id.endsWith('000b'))
    // BOTH present. The whole point: the older copy holds a turn the newer one lost.
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.copy_count).toBe(2)
    expect(b!.copy_count).toBe(2)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'copies are numbered oldest first',
  () => {
    const rows = list()
    expect(rows.find((r) => r.id.endsWith('000a'))!.copy_index).toBe(1)
    expect(rows.find((r) => r.id.endsWith('000b'))!.copy_index).toBe(2)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'an unrelated conversation is not dragged into the group',
  () => {
    const c = list().find((r) => r.id.endsWith('000c'))
    expect(c!.copy_count).toBe(1)
    expect(c!.copy_index).toBe(1)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'the grouping works on the FIRST list, not only once the cache is warm',
  () => {
    // The regression this pins: the group is built from thread_key, which only exists after a
    // transcript has been scanned. Reading that table before the parses answers nothing on a cold
    // cache, and every row calls itself the only copy on the first list after an upgrade — which is
    // exactly the moment a user looks. A fresh database plus a single call must already group.
    // (`list()` above runs in a child with its own DB file, so every call here is a cold one; this
    // test states the property that makes the three above meaningful rather than accidental.)
    const first = list(1)
    expect(first.find((r) => r.id.endsWith('000a'))!.copy_count).toBe(2)
    // ...and it stays correct once warm, rather than double-counting on a second pass.
    const second = list(2)
    expect(second.find((r) => r.id.endsWith('000a'))!.copy_count).toBe(2)
    expect(second.find((r) => r.id.endsWith('000c'))!.copy_count).toBe(1)
  },
  SPAWNS_A_CHILD_BUN,
)
