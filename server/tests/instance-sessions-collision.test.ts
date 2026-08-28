// server/tests/instance-sessions-collision.test.ts — which profile owns a chat that TWO profiles
// both describe.
//
// This is the ordinary aftermath of a move, not an exotic case. `POST /api/sessions/:id/migrate`
// ARCHIVES the source profile's metadata rather than deleting it, so from the instant a chat is
// migrated, two stores carry a record of it: a fresh tombstone on the account it left, and the
// live chat on the account it joined.
//
// The scan indexed those with a plain `map.set`, so the winner was whichever profile `readdirSync`
// happened to return last. In the field that was usually the tombstone: measured 2026-08-28, all
// 13 migrated chats reported as archived on the account they had just left, disappeared from every
// `archived: 'hide'` listing, and the live copies on the new account were invisible to the API
// while sitting correctly on disk. Every "the chat is in both accounts" report traces back here.
//
// The property pinned below is the one worth breaking a build over: a LIVE entry must beat an
// ARCHIVED one no matter what order the directories are scanned in. The fixture names are chosen
// so the archived copy sorts LAST, which is exactly the order that produced the bug.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-collision-'))
const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
}
const MOD = JSON.stringify(join(import.meta.dir, '..', 'src', 'instance-sessions.ts'))
const SPAWNS_A_CHILD_BUN = 30_000

/** One Desktop metadata file, in the layout the real store uses. */
function meta(
  instanceDir: string,
  file: string,
  body: Record<string, unknown>,
  mtime?: number,
): void {
  const dir = join(
    home,
    '.claude-instances',
    instanceDir,
    'claude-code-sessions',
    'org-uuid',
    'user-uuid',
  )
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  writeFileSync(path, JSON.stringify(body))
  if (mtime !== undefined) utimesSync(path, new Date(mtime), new Date(mtime))
}

// The move: 'aaa-target' holds the live chat, 'zzz-source' the tombstone it left behind. Scanned
// alphabetically the tombstone lands LAST, so last-writer-wins picks exactly the wrong one.
meta('aaa-target', 'local_moved.json', { cliSessionId: 'moved-chat', isArchived: false })
meta('zzz-source', 'local_moved.json', { cliSessionId: 'moved-chat', isArchived: true })

// Both live, and neither is a tombstone: the tie-break falls through to "whoever wrote last".
// The mtimes are assigned AGAINST the scan order on purpose. `aaa-target` is scanned FIRST, so
// last-write-wins would answer `zzz-source`; giving `aaa-target` the newer file means only a real
// mtime comparison can produce the expected answer. Written the other way round the test passes
// against the very bug it is meant to catch, which is how it was first drafted.
const OLD = Date.parse('2026-08-01T00:00:00.000Z')
const NEW = Date.parse('2026-08-28T00:00:00.000Z')
meta('aaa-target', 'local_tie.json', { cliSessionId: 'tie-chat', isArchived: false }, NEW)
meta('zzz-source', 'local_tie.json', { cliSessionId: 'tie-chat', isArchived: false }, OLD)

// Archived in both places: genuinely retired, so rule 1 cannot decide it and the recency rule
// does. Mtimes again run against scan order, so the expected answer is only reachable by comparing
// them.
meta('aaa-target', 'local_dead.json', { cliSessionId: 'dead-chat', isArchived: true }, NEW)
meta('zzz-source', 'local_dead.json', { cliSessionId: 'dead-chat', isArchived: true }, OLD)

// Identical mtimes and identical archived state: nothing distinguishes these two, and the point is
// that the answer must still be the SAME one every scan rather than whatever the glob visited last.
const SAME = Date.parse('2026-08-15T00:00:00.000Z')
meta('aaa-target', 'local_twin.json', { cliSessionId: 'twin-chat', isArchived: false }, SAME)
meta('zzz-source', 'local_twin.json', { cliSessionId: 'twin-chat', isArchived: false }, SAME)

function findChat(sessionId: string): { instance: string; archived: boolean } | null {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { findDesktopChat } = await import(${MOD});
       console.log(JSON.stringify(findDesktopChat(${JSON.stringify(sessionId)}) ?? null));`,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  return JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
}

test(
  'a migrated chat resolves to the account holding it, not the tombstone it left',
  () => {
    expect(findChat('moved-chat')).toMatchObject({ instance: 'aaa-target', archived: false })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'two live copies fall back to the most recently written one',
  () => {
    // `aaa-target` is scanned first AND holds the newer file, so only the mtime comparison can
    // return it; plain last-write-wins would answer `zzz-source`.
    expect(findChat('tie-chat')).toMatchObject({ instance: 'aaa-target', archived: false })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a chat archived everywhere still resolves, to its most recent copy',
  () => {
    // A retired chat still needs a location, and with rule 1 unable to decide it, recency picks.
    expect(findChat('dead-chat')).toMatchObject({ instance: 'aaa-target', archived: true })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'an indistinguishable pair resolves the same way every time',
  () => {
    // Same archived state, same mtime: nothing about these two chats differs, so any answer is
    // defensible EXCEPT an unstable one. Attribution that flips between scans would show a chat
    // moving between accounts on its own. Repeated across fresh scans because a single call could
    // pass by luck.
    const first = findChat('twin-chat')
    expect(first).not.toBe(null)
    for (let i = 0; i < 3; i++) expect(findChat('twin-chat')).toEqual(first)
  },
  SPAWNS_A_CHILD_BUN,
)
