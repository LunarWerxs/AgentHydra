// server/tests/codex-instance-sessions.test.ts — the blind spot found 2026-09-11.
//
// AgentHydra's session reader resolved the Codex store from ONE hardcoded CODEX_HOME, so every
// chat on a MANAGED Codex account — which lives at `<CONFIG_DIR>/codex-instances/<id>/sessions` —
// was invisible to all three ways in. Measured that day: `list_sessions {source:"codex",
// period:"all", archived:"include"}` returned 100 rows and not one came from a managed instance;
// `tail_session` answered "transcript not found" for a 2.9 MB rollout that was on disk; and
// `search_sessions` never matched its contents. Three managed accounts' entire history was
// unreachable from the tools whose whole job is to answer "which Codex account was doing X".
//
// The fixture is a REAL managed instance (createCodexInstance, which the test preload has already
// pointed at a scratch CONFIG_DIR) with hand-written rollouts under its own `sessions/` and
// `archived_sessions/`, and its own `session_index.jsonl`. Nothing of the developer's is written;
// the default CODEX_HOME is only ever read.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_HOME } from '../src/config'
import {
  codexInstanceStores,
  createCodexInstance,
  DEFAULT_CODEX_INSTANCE_ID,
  deleteCodexInstance,
} from '../src/core/codex-instances'
import { searchSessionBodies } from '../src/session-search'
import { listSessions } from '../src/sessions'
import {
  ensureTranscriptIndex,
  findTranscriptAsync,
  instanceScopeMatches,
  listTranscriptFiles,
  tailTranscript,
} from '../src/transcript'

const NAME = `codex-sessions-${crypto.randomUUID().slice(0, 8)}`
const created = createCodexInstance(NAME)
const INSTANCE_ID = created.data?.id as string
const CODEX_INSTANCE_HOME = created.data?.codexHome as string

const LIVE_ID = crypto.randomUUID()
const ARCHIVED_ID = crypto.randomUUID()
const SUBAGENT_ID = crypto.randomUUID()
/** Distinctive enough that a body search for it cannot match anything on the real machine. */
const NEEDLE = `zylophantic-${crypto.randomUUID().slice(0, 8)}`

/** One Codex rollout: the session_meta header the identity is read from, then a real user turn and
 *  a real assistant turn (both needed — a transcript with no substantive turn is dropped from the
 *  session list on purpose, as CLI scaffolding). */
function rollout(sessionId: string, text: string, extraMeta: Record<string, unknown> = {}): string {
  const stamp = '2026-09-11T16:11:50.000Z'
  return `${[
    {
      type: 'session_meta',
      timestamp: stamp,
      payload: {
        id: crypto.randomUUID(),
        session_id: sessionId,
        cwd: 'D:\\fixtures\\codex',
        ...extraMeta,
      },
    },
    {
      type: 'response_item',
      timestamp: stamp,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    },
    {
      type: 'response_item',
      timestamp: stamp,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ack' }],
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`
}

function writeRollout(dir: string, sessionId: string, body: string): string {
  const target = join(CODEX_INSTANCE_HOME, dir, '2026', '09', '11')
  mkdirSync(target, { recursive: true })
  const path = join(target, `rollout-2026-09-11T16-11-50-${sessionId}.jsonl`)
  writeFileSync(path, body)
  return path
}

const LIVE_PATH = writeRollout('sessions', LIVE_ID, rollout(LIVE_ID, `looking for ${NEEDLE} here`))
const ARCHIVED_PATH = writeRollout(
  'archived_sessions',
  ARCHIVED_ID,
  rollout(ARCHIVED_ID, 'an archived managed chat'),
)
// A subagent rollout in the same store, to prove the managed roots obey the SAME rule the default
// one does rather than quietly reintroducing thousands of duplicate rows per account.
writeRollout(
  'sessions',
  SUBAGENT_ID,
  rollout(SUBAGENT_ID, 'spawned thread', { thread_source: 'subagent' }),
)

// This instance's OWN sidebar index. The title must come from here and not from the default
// install's, which is what a single shared cache slot would have handed it.
const INSTANCE_TITLE = `titled-by-its-own-sidebar-${crypto.randomUUID().slice(0, 6)}`
writeFileSync(
  join(CODEX_INSTANCE_HOME, 'session_index.jsonl'),
  `${JSON.stringify({
    id: LIVE_ID,
    thread_name: INSTANCE_TITLE,
    updated_at: '2026-09-11T16:12:00.000Z',
  })}\n`,
)

/**
 * ONE full sweep for the whole file.
 *
 * A forced rebuild globs the developer's REAL Claude and Codex stores (this suite isolates
 * CONFIG_DIR, not CODEX_HOME, deliberately — the default install has to be read for its row to be
 * tagged), which measured ~4 s here. Four tests each forcing their own is four of those, and it is
 * the same snapshot every time. Non-forced calls afterwards return that snapshot even once the TTL
 * has lapsed, so nothing below can race a half-built index.
 */
let sweep: Promise<unknown> | null = null
const indexReady = () => (sweep ??= ensureTranscriptIndex(true))

/** Long enough for that one sweep on a machine with a real store, and for a cold CI runner. */
const SWEEP_TIMEOUT_MS = 60_000

afterAll(async () => {
  await deleteCodexInstance(INSTANCE_ID, NAME, { listDesktopProcesses: async () => [] })
})

test('codexInstanceStores lists the default install AND every managed instance', () => {
  const stores = codexInstanceStores()
  const fallback = stores.find((s) => s.id === DEFAULT_CODEX_INSTANCE_ID)
  expect(fallback?.codexHome).toBe(CODEX_HOME)

  const managed = stores.find((s) => s.id === INSTANCE_ID)
  expect(managed).toBeDefined()
  expect(managed?.codexHome).toBe(CODEX_INSTANCE_HOME)
  expect(managed?.name).toBe(NAME)
  // The ref instance-numbers.ts and the usage cache already key on, and the permanent handle.
  expect(managed?.ref).toBe(`codex:${INSTANCE_ID}`)
  expect(managed?.num).toBeGreaterThan(0)

  // Synchronous and store-only: it runs inside the transcript sweep, so it must never enumerate
  // desktop processes (a shell-out on Windows). Nothing here stubs a process lister and it still
  // answers — that IS the assertion.
  expect(stores.length).toBeGreaterThanOrEqual(2)
})

test(
  'a managed instance rollout is in the index, tagged with the account that owns it',
  async () => {
    await indexReady()
    const files = listTranscriptFiles()
    const live = files.find((f) => f.session_id === LIVE_ID)
    expect(live).toBeDefined()
    expect(live?.path).toBe(LIVE_PATH)
    expect(live?.source).toBe('codex')
    expect(live?.archived).toBe(false)
    // The whole point: `instance` used to be null for every Codex row because the row was never
    // there to tag.
    expect(live?.instance?.name).toBe(NAME)
    expect(live?.instance?.ref).toBe(`codex:${INSTANCE_ID}`)
    expect(live?.instance?.num).toBeGreaterThan(0)
    // Its OWN sidebar supplied the title, not the default install's.
    expect(live?.title).toBe(INSTANCE_TITLE)

    // Both halves of the managed store, same as the default install gets.
    const archived = files.find((f) => f.session_id === ARCHIVED_ID)
    expect(archived?.path).toBe(ARCHIVED_PATH)
    expect(archived?.archived).toBe(true)
    expect(archived?.instance?.ref).toBe(`codex:${INSTANCE_ID}`)

    // …and the subagent rule still applies inside a managed store.
    expect(files.some((f) => f.session_id === SUBAGENT_ID)).toBe(false)

    // A row from the DEFAULT install, if this machine has one, is tagged too rather than left null.
    const fromDefault = files.find((f) => f.source === 'codex' && f.path.startsWith(CODEX_HOME))
    if (fromDefault) expect(fromDefault.instance?.ref).toBe(`codex:${DEFAULT_CODEX_INSTANCE_ID}`)
  },
  SWEEP_TIMEOUT_MS,
)

test(
  'tail_session finds a managed rollout by id — the "transcript not found" bug',
  async () => {
    await indexReady()
    const tf = await findTranscriptAsync(LIVE_ID, 'codex')
    expect(tf?.path).toBe(LIVE_PATH)

    const tail = await tailTranscript(LIVE_ID, { limit: 10 }, 'codex')
    expect(tail.events.length).toBeGreaterThan(0)
    expect(tail.events.some((e) => (e.text ?? '').includes(NEEDLE))).toBe(true)
  },
  SWEEP_TIMEOUT_MS,
)

test(
  'list_sessions returns the row with instance set, and scopes to it',
  async () => {
    await indexReady()
    // No period/since: listSessions has no window of its own (the ROUTE applies the 24h default),
    // so this is the whole store scoped to one account.
    const rows = await listSessions({ instance: NAME, archived: 'include' })
    const row = rows.find((r) => r.session_id === LIVE_ID)
    expect(row).toBeDefined()
    expect(row?.instance).toBe(NAME)
    expect(row?.instance_ref).toBe(`codex:${INSTANCE_ID}`)
    expect(row?.instance_num).toBeGreaterThan(0)
    // The scope is exclusive: nothing from any other account rides along.
    expect(rows.every((r) => r.instance === NAME)).toBe(true)
    expect(rows.some((r) => r.session_id === ARCHIVED_ID)).toBe(true)
  },
  SWEEP_TIMEOUT_MS,
)

test(
  'the instance scope accepts the name, the ref and the permanent number',
  async () => {
    await indexReady()
    const live = listTranscriptFiles().find((f) => f.session_id === LIVE_ID)
    if (!live) throw new Error('fixture row missing')
    const num = live.instance?.num ?? 0

    expect(instanceScopeMatches(live, NAME)).toBe(true)
    expect(instanceScopeMatches(live, NAME.toUpperCase())).toBe(true)
    expect(instanceScopeMatches(live, `codex:${INSTANCE_ID}`)).toBe(true)
    expect(instanceScopeMatches(live, String(num))).toBe(true)
    expect(instanceScopeMatches(live, `#${num}`)).toBe(true)
    // The bare id is deliberately NOT a spelling: the default install's id is the literal string
    // "default", which already means the non-isolated CLAUDE install to this filter.
    expect(instanceScopeMatches(live, INSTANCE_ID)).toBe(false)
    expect(instanceScopeMatches(live, 'other')).toBe(false)
    expect(instanceScopeMatches(live, 'some-other-account')).toBe(false)

    // "other" means "no instance at all", so a row that names one must never answer to it.
    const other = await listSessions({ instance: 'other', archived: 'include' })
    expect(other.some((r) => r.session_id === LIVE_ID)).toBe(false)
  },
  SWEEP_TIMEOUT_MS,
)

test(
  'search_sessions matches inside a managed instance transcript',
  async () => {
    await indexReady()
    const found = await searchSessionBodies({ query: NEEDLE, instance: NAME, limit: 10 })
    expect(found.results.some((r) => r.session_id === LIVE_ID)).toBe(true)
  },
  SWEEP_TIMEOUT_MS,
)
