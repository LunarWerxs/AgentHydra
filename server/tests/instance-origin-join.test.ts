// server/tests/instance-origin-join.test.ts — attributing a session to an account when Claude
// Desktop never wrote down which one ran it.
//
// WHY THERE IS A SECOND JOIN AT ALL. instance-sessions.ts opens with a hard rule: match Desktop's
// metadata to a transcript ONLY by cliSessionId, never by the metadata's filename or title. That
// rule is right — two chats in one project are routinely called the same thing, so a title match
// hands one account's work to another. But it left 64 of the newest 400 sessions on a real machine
// with no account at all, every one of them launched from Desktop, and the UI rendered that as an
// empty space, which reads as a missing feature rather than a missing fact.
//
// The join added here is a different key: same working directory, same creation instant to the
// millisecond. That is not a label, it is a coincidence that does not happen. 19 of the 64 came
// back with ZERO ambiguous matches; the other 45 have no Desktop record anywhere on disk and are
// now labelled "Unknown account" out loud.
//
// What these tests pin is the SAFETY property, because that is the one worth breaking a build over:
// where the answer is not unique, it must be null. Attributing a session to the wrong account is
// worse than admitting we do not know, since the whole point of the chip is whose quota paid.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-origin-'))
const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  // This child drives its own HOME, so it must also claim the instance root explicitly: the
  // preload exports AGENTHYDRA_INSTANCES_ROOT for the parent's scratch, and an inherited value
  // outranks USERPROFILE inside instancesRoot() — the child would then look for these fixtures
  // in the parent's world and find an empty one.
  AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
}
const MOD = JSON.stringify(join(import.meta.dir, '..', 'src', 'instance-sessions.ts'))
const SPAWNS_A_CHILD_BUN = 30_000

/** One Desktop metadata file, in the layout the real store uses. */
function meta(instanceDir: string | null, file: string, body: Record<string, unknown>): void {
  // null = the non-isolated install, which labels as "default".
  const base = instanceDir
    ? join(home, '.claude-instances', instanceDir)
    : join(home, 'AppData', 'Roaming', 'Claude')
  const dir = join(base, 'claude-code-sessions', 'org-uuid', 'user-uuid')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(body))
}

const CREATED = Date.parse('2026-08-18T21:25:52.000Z')

meta('work', 'local_a.json', {
  cliSessionId: 'known-by-id',
  cwd: 'D:\\PublicProjects',
  createdAt: CREATED,
  isArchived: false,
})
// Two different accounts opened a chat in the SAME folder at the SAME instant. Contrived, and the
// only case where this join could be wrong — so it must refuse rather than pick.
meta('lunarwerx', 'local_b.json', {
  cliSessionId: 'contested-1',
  cwd: 'D:\\Contested',
  createdAt: CREATED,
  isArchived: false,
})
meta('temp1', 'local_c.json', {
  cliSessionId: 'contested-2',
  cwd: 'D:\\Contested',
  createdAt: CREATED,
  isArchived: false,
})
// Same account, two metadata rows for one origin: agreement, not ambiguity. Must still resolve.
meta('work', 'local_d.json', {
  cliSessionId: 'twin-1',
  cwd: 'D:\\Twins',
  createdAt: CREATED,
  isArchived: true,
})
meta('work', 'local_e.json', {
  cliSessionId: 'twin-2',
  cwd: 'D:\\Twins',
  createdAt: CREATED + 500,
  isArchived: true,
})

function resolve(cwd: string, createdAt: number | null): unknown {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { resolveInstanceByOrigin } = await import(${MOD});
       console.log(JSON.stringify(resolveInstanceByOrigin(${JSON.stringify(cwd)}, ${createdAt === null ? 'null' : createdAt}) ?? null));`,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  return JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
}

test(
  'a unique origin resolves to its account',
  () => {
    expect(resolve('D:\\PublicProjects', CREATED)).toMatchObject({
      instance: 'work',
      archived: false,
    })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'the match is case-insensitive on the path, because Windows is',
  () => {
    // Desktop writes "D:\\PublicProjects" and a transcript can carry "d:\\publicprojects" for the
    // same folder; a case-sensitive compare would silently drop the match on half the store.
    expect(resolve('d:\\publicprojects', CREATED)).toMatchObject({
      instance: 'work',
      archived: false,
    })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a small clock gap between the two records still counts as one birth',
  () => {
    // Desktop stamps createdAt as it opens the chat; the CLI stamps its first turn a moment later.
    expect(resolve('D:\\PublicProjects', CREATED + 1500)).toMatchObject({
      instance: 'work',
      archived: false,
    })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a large gap does not — that is a different conversation in the same folder',
  () => {
    expect(resolve('D:\\PublicProjects', CREATED + 90_000)).toBeNull()
    expect(resolve('D:\\PublicProjects', CREATED + 10 * 60_000)).toBeNull()
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'the window sits exactly where it was measured to be safe',
  () => {
    // ORIGIN_SKEW_MS is 60s because that is the top of the measured plateau: correct on 305 known
    // sessions with zero wrong answers, with the first ambiguity at 120s and the first WRONG answer
    // at 240s. Pinned in both directions so widening it has to be a decision someone makes on
    // purpose, with the cross-check re-run, rather than a number that drifts.
    expect(resolve('D:\\PublicProjects', CREATED + 59_000)).toMatchObject({
      instance: 'work',
      archived: false,
    })
    expect(resolve('D:\\PublicProjects', CREATED + 61_000)).toBeNull()
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'TWO accounts at the same origin resolves to nothing, never to a coin toss',
  () => {
    // THE safety property. Naming the wrong account is worse than naming none: the chip exists to
    // say whose quota paid for the run.
    expect(resolve('D:\\Contested', CREATED)).toBeNull()
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'two rows from the SAME account are agreement, not ambiguity',
  () => {
    expect(resolve('D:\\Twins', CREATED)).toMatchObject({ instance: 'work', archived: true })
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a transcript with no start time cannot be joined, and says so',
  () => {
    // created_at is null on transcripts whose turns carry no parseable timestamp. Without a time
    // there is only the folder, which is nowhere near enough.
    expect(resolve('D:\\PublicProjects', null)).toBeNull()
    expect(resolve('', CREATED)).toBeNull()
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'an unknown folder resolves to nothing',
  () => {
    expect(resolve('D:\\NeverSeen', CREATED)).toBeNull()
  },
  SPAWNS_A_CHILD_BUN,
)
