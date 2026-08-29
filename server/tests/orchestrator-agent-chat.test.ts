// server/tests/orchestrator-agent-chat.test.ts — the ORCHESTRATOR AGENT CHAT contract, pinned.
//
// The relay rung — commandeering an awake WORKING chat in another instance as a courier — was
// removed by owner ban (Michael, 2026-08-28: "remove the relay task functionality... don't just
// message other chats"), and the follow-up was "the removal must not cripple any functionality".
// The sanctioned replacement is a marker-titled, system-owned courier per instance
// (orch-agent.ts). These tests pin the properties that keep the replacement from decaying back
// into the banned shape: relay to working chats stays IMPOSSIBLE, the courier rung composes
// ONLY to marker-titled chats, the monitor never counts the courier as a working chat, and the
// janitor never retires it while its instance still has chats.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import { instanceDirForLabel } from '../src/instance-sessions'
import { composeAgentDelivery, isOrchAgentTitle, ORCH_AGENT_TITLE } from '../src/orch-agent'
import type { LiveSession, OrchestratorDeps } from '../src/orchestrator'
import {
  clearPendingRename,
  listPendingRenames,
  orchestratorView,
  proposeAgentChats,
  proposeArchivesForDoneSessions,
  runOrchestratorOnce,
} from '../src/orchestrator'
import {
  agentChatRowFor,
  computeRoute,
  findLiveOrchAgent,
  repoOccupied,
} from '../src/orchestrator-worklist'
import { openProposalsForSession } from '../src/proposals'
import type { OrchestratorInstance } from '../src/types'

// --- fixtures ------------------------------------------------------------------------------------

function liveSession(overrides: Partial<LiveSession>): LiveSession {
  return {
    pid: 1,
    sessionId: 's-live',
    cwd: 'D:\\Repo',
    name: 'peer-aa',
    startedAt: Date.now() - 60_000,
    transcriptPath: null,
    ...overrides,
  }
}

const INST_X = 'desktop:C:\\instances\\martin'
const INST_Y = 'desktop:C:\\instances\\reviewer'

/** Injected metadata: chat meta by session id, instance ref by session id. */
function lookupOf(
  chats: Record<string, { chatId?: string | null; title?: string | null }>,
  refs: Record<string, string>,
) {
  return {
    findChat: (id: string) => chats[id] ?? null,
    instanceRef: (id: string) => refs[id] ?? null,
  }
}

// --- the ban stays banned ------------------------------------------------------------------------

test('a dormant target in another instance NEVER routes through its working chats', () => {
  // The exact pre-ban shape: an awake working chat exists in the target's instance. Before
  // 2026-08-28 this composed a relay step to it; that is the banned behaviour, pinned out.
  const worker = liveSession({ sessionId: 'worker-1', name: 'martin-repo-work' })
  const route = computeRoute({
    targetSessionId: 'dorm-1',
    reviewerSessionId: 'rev-1',
    message: 'hello there',
    live: [worker],
    lookup: lookupOf(
      {
        'dorm-1': { chatId: 'local_dorm', title: 'Fix the parser' },
        'worker-1': { chatId: 'local_worker', title: 'Repo work' },
      },
      { 'dorm-1': INST_X, 'worker-1': INST_X, 'rev-1': INST_Y },
    ),
  })
  expect(route.mode).toBe('none')
  expect(route.step).toBeUndefined()
  expect(route.whyNone).toContain('agent chat')
})

// --- the courier rung ----------------------------------------------------------------------------

test('with a live agent chat in the target instance, the rung composes to IT and only it', () => {
  const worker = liveSession({ sessionId: 'worker-1', name: 'martin-repo-work' })
  const agent = liveSession({ sessionId: 'agent-1', name: 'martin-agent' })
  const payload = 'line one\nline two with "quotes" and $pecial chars'
  const route = computeRoute({
    targetSessionId: 'dorm-1',
    reviewerSessionId: 'rev-1',
    message: payload,
    live: [worker, agent],
    lookup: lookupOf(
      {
        'dorm-1': { chatId: 'local_dorm', title: 'Fix the parser' },
        'worker-1': { chatId: 'local_worker', title: 'Repo work' },
        'agent-1': { chatId: 'local_agent', title: ORCH_AGENT_TITLE },
      },
      { 'dorm-1': INST_X, 'worker-1': INST_X, 'agent-1': INST_X, 'rev-1': INST_Y },
    ),
  })
  expect(route.mode).toBe('agent-chat')
  expect(route.step?.tool).toBe('SendMessage')
  // Addressed to the AGENT's registry name — never the working chat's.
  expect(route.step?.args.to).toBe('martin-agent')
  // The courier instruction names the target's REAL chat id (from metadata, never constructed)
  // and carries the payload verbatim between the fences.
  expect(route.step?.args.message).toContain('"local_dorm"')
  expect(route.step?.args.message).toContain(
    `===== BEGIN PAYLOAD =====\n${payload}\n===== END PAYLOAD =====`,
  )
  expect(route.step?.args.message.startsWith('[orchestrator]')).toBe(true)
})

test('the rung admits by TITLE MARKER only - lookalike titles and other instances do not route', () => {
  const mk = (title: string | null, ref: string = INST_X) => {
    const agent = liveSession({ sessionId: 'cand-1', name: 'martin-cand' })
    return computeRoute({
      targetSessionId: 'dorm-1',
      reviewerSessionId: 'rev-1',
      message: 'hello',
      live: [agent],
      lookup: lookupOf(
        {
          'dorm-1': { chatId: 'local_dorm', title: 'Fix the parser' },
          'cand-1': { chatId: 'local_cand', title },
        },
        { 'dorm-1': INST_X, 'cand-1': ref, 'rev-1': INST_Y },
      ),
    })
  }
  expect(mk('General coding session').mode).toBe('none')
  expect(mk('agent orchestrator').mode).toBe('none') // marker is a PREFIX, not a bag of words
  expect(mk(null).mode).toBe('none')
  // The marked chat in the WRONG instance is not a route into this one.
  expect(mk(ORCH_AGENT_TITLE, INST_Y).mode).toBe('none')
  // The marker admits; owner-tweaked suffixes stay recognized.
  expect(mk(ORCH_AGENT_TITLE).mode).toBe('agent-chat')
  expect(mk('Orchestrator agent (Martin) - do not use').mode).toBe('agent-chat')
})

test('a dormant target in the reviewer OWN instance still routes natively, agent or no agent', () => {
  const agent = liveSession({ sessionId: 'agent-1', name: 'x-agent' })
  const route = computeRoute({
    targetSessionId: 'dorm-1',
    reviewerSessionId: 'rev-1',
    message: 'hello',
    live: [agent],
    lookup: lookupOf(
      {
        'dorm-1': { chatId: 'local_dorm', title: 'Fix the parser' },
        'agent-1': { chatId: 'local_agent', title: ORCH_AGENT_TITLE },
      },
      { 'dorm-1': INST_X, 'agent-1': INST_X, 'rev-1': INST_X },
    ),
  })
  expect(route.mode).toBe('own-instance')
  expect(route.step?.tool).toBe('send_message')
  expect(route.step?.args.session_id).toBe('local_dorm')
})

test('a seeded-but-never-booted (deaf) agent chat is not a route - it cannot run its tool yet', () => {
  // A REAL transcript whose newest event predates the process spawn by more than the deaf
  // floor: exactly the state a freshly seeded courier is in before anyone boots it.
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-deaf-agent-'))
  const path = join(dir, 'agent.jsonl')
  const old = new Date(Date.now() - 2 * 3600_000).toISOString()
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'user',
      timestamp: old,
      message: { role: 'user', content: [{ type: 'text', text: '[orchestrator] seeded' }] },
    })}\n`,
  )
  const deafAgent = liveSession({
    sessionId: 'agent-deaf',
    name: 'martin-agent',
    startedAt: Date.now() - 3600_000, // spawned an hour ago, newest record is older still
    transcriptPath: path,
  })
  const lookup = lookupOf(
    { 'agent-deaf': { chatId: 'local_agent', title: ORCH_AGENT_TITLE } },
    { 'agent-deaf': INST_X },
  )
  expect(findLiveOrchAgent(INST_X, [deafAgent], Date.now(), lookup)).toBeNull()
  rmSync(dir, { recursive: true, force: true })
})

test('composeAgentDelivery carries the payload byte-for-byte and the real chat id', () => {
  const payload = 'a\n\nb\t"c"\\d ===== not a fence'
  const msg = composeAgentDelivery('local_target', payload)
  expect(msg.startsWith('[orchestrator]')).toBe(true)
  expect(msg).toContain('"local_target"')
  expect(msg).toContain(`===== BEGIN PAYLOAD =====\n${payload}\n===== END PAYLOAD =====`)
})

// --- the monitor never counts the courier --------------------------------------------------------

function agentDeps(over: Partial<OrchestratorDeps> & { mtime?: number; title?: string }): {
  deps: OrchestratorDeps
} {
  const session: LiveSession = {
    pid: 4321,
    sessionId: 'orch-agent-sess-1',
    cwd: 'C:\\instances\\martin',
    name: 'martin-agent',
    startedAt: 0,
    transcriptPath: 'D:\\fake\\orch-agent-sess-1.jsonl',
  }
  const deps: OrchestratorDeps = {
    nowMs: () => Date.now(),
    claudeHome: () => 'unused',
    registry: () => [session],
    orphans: () => [],
    recentTranscripts: () => [],
    codexThreads: () => [],
    codexTail: () => ({
      ending: 'complete' as const,
      lastAgentText: null,
      recapDetected: false,
      unreadable: true,
    }),
    dispatchActive: () => false,
    sessionMeta: () =>
      new Map([
        [
          'orch-agent-sess-1',
          {
            instance: 'martin',
            archived: false,
            title: over.title ?? ORCH_AGENT_TITLE,
            chatId: 'local_agent',
          },
        ],
      ]),
    tailInfo: () => ({
      ending: 'complete',
      lastAssistantText: 'ready',
      ctxTokens: 1_000,
      midTurn: false,
      pendingTool: null,
      recapDetected: true,
      handoffDetected: false,
      chips: [],
      lastHumanText: null,
      lastHumanAt: null,
      lastEventAt: null,
      unreadable: false,
    }),
    mtimeMs: () => over.mtime ?? Date.now() - 60 * 60_000,
    git: async () => null,
    usage: () => ({}),
    instanceRef: () => 'desktop:C:\\instances\\martin',
    desktopInstances: async () => [],
    taskActivity: () => null,
    ...over,
  }
  return { deps }
}

test('the monitor produces NO attention items for the agent chat, however long it idles', async () => {
  const { deps } = agentDeps({})
  await runOrchestratorOnce(deps)
  const feed = orchestratorView().attention
  expect(feed.some((i) => i.sessionId === 'orch-agent-sess-1')).toBe(false)
})

test('the exclusion is the MARKER: the same session under a working title is classified again', async () => {
  const { deps } = agentDeps({ title: 'Repo work' })
  await runOrchestratorOnce(deps)
  const feed = orchestratorView().attention
  expect(feed.some((i) => i.sessionId === 'orch-agent-sess-1')).toBe(true)
})

test('a BUSY agent chat holds no concurrency slot - it is never a running working chat', async () => {
  const { deps } = agentDeps({ mtime: Date.now() - 5_000 }) // fresh transcript = "working"
  await runOrchestratorOnce(deps)
  expect(orchestratorView().meta.runningChats).toBe(0)
})

// --- the courier never blocks real work placement ------------------------------------------------

test('a live agent chat does not occupy a repo for one-chat-per-repo purposes', () => {
  const base = mkdtempSync(join(tmpdir(), 'agenthydra-agent-occ-'))
  const repo = join(base, 'RealRepo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const agent = liveSession({ sessionId: 'agent-occ-1', name: 'martin-agent', cwd: repo })
  const titles: Record<string, string> = { 'agent-occ-1': ORCH_AGENT_TITLE }
  expect(repoOccupied(repo, [agent], (id) => titles[id] ?? null)).toBeNull()
  // Differential: the same occupant under a working title blocks, as ever.
  expect(repoOccupied(repo, [agent], () => 'Repo work')).toBe('martin-agent')
  rmSync(base, { recursive: true, force: true })
})

// --- the janitor rail ----------------------------------------------------------------------------

test('the archive janitor skips a done-marked agent chat while its instance has other chats', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-agentjan-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, 'local_agent-jan-1.json'),
    JSON.stringify({ cliSessionId: 'agent-jan-1', isArchived: false }),
  )
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, 1, ?) on conflict(session_id) do update set done = 1',
  ).run('agent-jan-1', Date.now())
  const lookup = (others: boolean) => ({
    titleFor: () => ORCH_AGENT_TITLE,
    hasOtherOpenChats: () => others,
  })
  // While the instance has chats: the courier stays, whatever the done-mark says.
  expect(await proposeArchivesForDoneSessions([profile], lookup(true))).toBe(0)
  expect(openProposalsForSession('agent-jan-1')).toHaveLength(0)
  // Instance otherwise empty: the courier is residue like any other finished chat.
  expect(await proposeArchivesForDoneSessions([profile], lookup(false))).toBe(1)
  db.query('update session_marks set done = 0 where session_id = ?').run('agent-jan-1')
  db.query("delete from orchestrator_proposals where session_id = 'agent-jan-1'").run()
  rmSync(profile, { recursive: true, force: true })
})

// --- the daemon tracks which instances have an agent chat ----------------------------------------

function instRow(over: Partial<OrchestratorInstance>): OrchestratorInstance {
  return {
    ref: INST_X,
    name: 'martin',
    isRunning: true,
    account: null,
    plan: null,
    weeklyPct: null,
    weeklyResetsAt: null,
    sessionPct: null,
    sessionResetsAt: null,
    sessionResetsSoon: false,
    recentPlacements: 0,
    eligible: true,
    blockedWhy: null,
    band: 'unknown',
    resetsSoon: false,
    stale: false,
    ...over,
  }
}

test('proposeAgentChats surfaces "instance X has no agent chat" through the action gate', () => {
  // The label->dir mapping is the real one, so the fixture instance must live where a real
  // instance of that label would: refs are built from instanceDirForLabel's own convention.
  const dirX = instanceDirForLabel('agenttest-x')
  const chat = (over: Record<string, unknown>) => ({
    instance: 'agenttest-x',
    archived: false,
    title: 'Repo work',
    cliSessionId: 'c-1',
    chatId: 'local_c-1',
    path: join(dirX, 'c-1.json'),
    ...over,
  })
  const rows = [instRow({ ref: `desktop:${dirX}`, name: 'agenttest-x' })]

  // A running instance with open working chats and no courier: exactly one proposal.
  expect(proposeAgentChats(rows, [chat({})], () => null)).toBe(1)
  const open = openProposalsForSession('agent:agenttest-x')
  expect(open).toHaveLength(1)
  expect(open[0].kind).toBe('seed-agent')
  expect(open[0].instanceRef).toBe(`desktop:${dirX}`)
  // A second sweep refreshes the open row instead of stacking a duplicate.
  proposeAgentChats(rows, [chat({})], () => null)
  expect(openProposalsForSession('agent:agenttest-x')).toHaveLength(1)
  db.query("delete from orchestrator_proposals where session_id = 'agent:agenttest-x'").run()

  // An instance that already has its marker-titled courier gets nothing.
  expect(
    proposeAgentChats(
      rows,
      [
        chat({}),
        chat({ title: ORCH_AGENT_TITLE, cliSessionId: 'a-1', path: join(dirX, 'a.json') }),
      ],
      () => null,
    ),
  ).toBe(0)
  // A stopped instance gets nothing (seeding into a closed app helps nobody yet).
  expect(
    proposeAgentChats(
      [instRow({ ref: `desktop:${dirX}`, isRunning: false })],
      [chat({})],
      () => null,
    ),
  ).toBe(0)
  // An EMPTY instance gets nothing - a courier with nobody to deliver to is residue on arrival.
  expect(proposeAgentChats(rows, [], () => null)).toBe(0)
})

test('an agent chat that LOST its marker gets a rename back, never a duplicate courier', () => {
  const dirX = instanceDirForLabel('agenttest-y')
  const rows = [instRow({ ref: `desktop:${dirX}`, name: 'agenttest-y' })]
  const chats = [
    {
      instance: 'agenttest-y',
      archived: false,
      title: 'General coding session', // the app's boot re-save wiped the seeded title
      cliSessionId: 'lost-agent-1',
      chatId: 'local_lost-agent-1',
      path: join(dirX, 'lost.json'),
    },
  ]
  expect(proposeAgentChats(rows, chats, () => 'lost-agent-1')).toBe(0)
  expect(openProposalsForSession('agent:agenttest-y')).toHaveLength(0)
  const rename = listPendingRenames().find((r) => r.sessionId === 'lost-agent-1')
  expect(rename?.title).toBe(ORCH_AGENT_TITLE)
  clearPendingRename('lost-agent-1')
})

// --- the dry run's per-instance tracking ---------------------------------------------------------

test('agentChatRowFor reports presence and liveness by the marker', () => {
  const chats = [
    {
      instance: 'x',
      metaPath: '',
      metaMtime: null,
      chatId: 'local_w',
      cliSessionId: 'w-1',
      priorCliSessionIds: [],
      title: 'Repo work',
      cwd: null,
      createdAt: null,
      lastActivityAt: null,
      archived: false,
      permissionMode: null,
    },
    {
      instance: 'x',
      metaPath: '',
      metaMtime: null,
      chatId: 'local_a',
      cliSessionId: 'a-1',
      priorCliSessionIds: [],
      title: ORCH_AGENT_TITLE,
      cwd: null,
      createdAt: null,
      lastActivityAt: null,
      archived: false,
      permissionMode: null,
    },
  ]
  expect(agentChatRowFor(chats.slice(0, 1), [])).toBeNull()
  const dormant = agentChatRowFor(chats, [])
  expect(dormant).toEqual({ chatId: 'local_a', sessionId: 'a-1', live: false })
  const alive = agentChatRowFor(chats, [liveSession({ sessionId: 'a-1', name: 'x-agent' })])
  expect(alive?.live).toBe(true)
})

// --- the marker itself ---------------------------------------------------------------------------

test('isOrchAgentTitle is a prefix marker, not a heuristic', () => {
  expect(isOrchAgentTitle(ORCH_AGENT_TITLE)).toBe(true)
  expect(isOrchAgentTitle('orchestrator agent')).toBe(true)
  expect(isOrchAgentTitle('  Orchestrator Agent (Martin)')).toBe(true)
  expect(isOrchAgentTitle('The orchestrator agent chat')).toBe(false)
  expect(isOrchAgentTitle('agent orchestrator')).toBe(false)
  expect(isOrchAgentTitle('')).toBe(false)
  expect(isOrchAgentTitle(null)).toBe(false)
  expect(isOrchAgentTitle(undefined)).toBe(false)
})
