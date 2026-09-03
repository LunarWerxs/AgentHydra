// server/tests/session-desktop-continuations.test.ts — the desktop's own word on a rolled chat.
//
// The continuation detector (session-continuations.ts) knows a continuation by the compaction
// marker among a transcript's FIRST records. The desktop app rolls a chat another way: it opens the
// new transcript by replaying the retained history into it and only then writes the marker — so the
// marker sits hundreds of records deep (1,501 on the chat this was measured on, 2026-09-03) and the
// detector never meets it. The user saw one chat, "RusTor", listed three times under two titles:
// "compacted chats become multiple entries".
//
// What the app DOES leave is authoritative: its metadata row lists every transcript id the chat
// has retired (`priorCliSessionIds`). Pinned here: those links fold the retired transcripts into
// the surviving row, the survivor keeps its account, a retired id whose successor is gone stays on
// screen, and — the migration case — a claim made only by an ARCHIVED tombstone still counts,
// because after a move the tombstone is the only record that remembers the lineage.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withDesktopContinuations } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-desktop-cont-'))
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
  AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
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

/** A transcript with one real exchange, opening on its OWN uuid so the copies grouping (which keys
 *  on the first message) has no say here, and carrying no compaction marker so the detector has
 *  nothing to find: the desktop's record is the only link between these files. */
function transcript(sessionId: string, uuid: string, text: string, mtimeSec: number): void {
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    path,
    turn(uuid, 'user', text, '2026-09-03T16:00:00.000Z') +
      turn(`${uuid}-a`, 'assistant', 'on it', '2026-09-03T16:00:05.000Z'),
  )
  utimesSync(path, mtimeSec, mtimeSec)
}

/** One Desktop metadata file, in the layout the real store uses. */
function meta(instanceDir: string, file: string, body: Record<string, unknown>): void {
  const dir = join(
    home,
    '.claude-instances',
    instanceDir,
    'claude-code-sessions',
    'org-uuid',
    'user-uuid',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(body))
}

// One chat, rolled twice. The metadata is filed under the id the chat was CREATED with and points
// at the id it is on now — the shape the real store had for the chat this was measured on.
const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const MID = 'aaaaaaaa-0000-4000-8000-000000000002'
const NEW = 'aaaaaaaa-0000-4000-8000-000000000003'
transcript(OLD, 'u-old', 'review the codebase', 1_770_000_000)
transcript(MID, 'u-mid', 'carry on', 1_770_000_100)
transcript(NEW, 'u-new', 'carry on again', 1_770_000_200)
meta('acct', `local_${OLD}.json`, {
  cliSessionId: NEW,
  priorCliSessionIds: [OLD, MID],
  isArchived: false,
  title: 'RusTor',
})

// The migration case. The import writes a FRESH record on the target with no lineage in it; the
// only row that still remembers the roll is the archived tombstone on the account the chat left.
const MOVED_OLD = 'bbbbbbbb-0000-4000-8000-000000000001'
const MOVED_NEW = 'bbbbbbbb-0000-4000-8000-000000000002'
transcript(MOVED_OLD, 'u-moved-old', 'before the move', 1_770_000_300)
transcript(MOVED_NEW, 'u-moved-new', 'after the move', 1_770_000_400)
meta('zzz-source', `local_${MOVED_OLD}.json`, {
  cliSessionId: MOVED_NEW,
  priorCliSessionIds: [MOVED_OLD],
  isArchived: true,
})
meta('aaa-target', `local_${MOVED_NEW}.json`, { cliSessionId: MOVED_NEW, isArchived: false })

// A retired id whose successor transcript is not in the store at all.
const ORPHAN = 'cccccccc-0000-4000-8000-000000000001'
transcript(ORPHAN, 'u-orphan', 'the only file left', 1_770_000_500)
meta('acct', `local_${ORPHAN}.json`, {
  cliSessionId: 'cccccccc-0000-4000-8000-00000000dead',
  priorCliSessionIds: [ORPHAN],
  isArchived: false,
})

interface Row {
  id: string
  instance: string | null
  archived: boolean
}
let listed: Row[] | null = null
/** listSessions() in a cold process, once for the whole file — every test reads the same list. */
function list(): Row[] {
  const rows =
    listed ??
    child<Row[]>(`const { listSessions } = await import(${SESSIONS});
    const rows = await listSessions({ limit: 50, sinceMs: null, archived: 'include' });
    console.log(JSON.stringify(rows.map((r) => ({ id: r.session_id, instance: r.instance, archived: r.archived }))));`)
  listed = rows
  return rows
}

test(
  'a chat the desktop rolled twice is one row, and it is the newest transcript',
  () => {
    const chat = list().filter((r) => [OLD, MID, NEW].includes(r.id))
    expect(chat.map((r) => r.id)).toEqual([NEW])
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'the survivor keeps the account the desktop links the chat to',
  () => {
    expect(list().find((r) => r.id === NEW)?.instance).toBe('acct')
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a lineage remembered only by the tombstone a migration left behind still folds',
  () => {
    const rows = list()
    const chat = rows.filter((r) => [MOVED_OLD, MOVED_NEW].includes(r.id))
    expect(chat.map((r) => r.id)).toEqual([MOVED_NEW])
    // And the survivor is the LIVE copy on the target, not the tombstone that named the lineage.
    const survivor = rows.find((r) => r.id === MOVED_NEW)
    expect(survivor?.instance).toBe('aaa-target')
    expect(survivor?.archived).toBe(false)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a retired id whose successor is not in the store stays on screen',
  () => {
    // The only surviving evidence of that conversation. Hiding it would lose the chat, not tidy it.
    expect(list().some((r) => r.id === ORPHAN)).toBe(true)
  },
  SPAWNS_A_CHILD_BUN,
)

test('the overlay fills the gaps the detector left and never overwrites its links', () => {
  const file = (id: string, extra: Partial<TranscriptFile> = {}): TranscriptFile => ({
    session_id: id,
    source: 'claude',
    path: `C:/store/${id}.jsonl`,
    project: 'D--demo',
    mtime_ms: 1,
    size_bytes: 1,
    archived: false,
    ...extra,
  })
  const retired = new Map([
    ['a', 'b'],
    ['c', 'c'],
    ['d', 'e'],
    ['f', 'g'],
  ])
  const input = [
    file('a'),
    file('c'),
    file('d', { supersededBy: 'x' }),
    file('f', { source: 'codex' }),
  ]
  const out = withDesktopContinuations(input, retired)
  const by = (id: string) => out.find((f) => f.session_id === id)?.supersededBy
  expect(by('a')).toBe('b')
  // A transcript can never be its own successor.
  expect(by('c')).toBeUndefined()
  // The detector proved 'd' from the transcript itself; the desktop's claim does not override it.
  expect(by('d')).toBe('x')
  // Links are resolved within Claude's own store; another store's id is not the same session.
  expect(by('f')).toBeUndefined()
  // A store with no rolled chat pays nothing: the same array comes back.
  expect(withDesktopContinuations(input, new Map())).toBe(input)
})
