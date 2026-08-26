// server/tests/orchestrator.test.ts — the attention watcher's judgment-free half, pinned.
//
// The orchestrator feed is consumed by an AI reviewer that acts on it (nudges live chats), so a
// wrong classification here does not just mislabel a row — it sends a "resume working" message
// into a chat that was mid-tool, or misses the one that has been sitting idle for an hour. Each
// test pins one classification the reviewer depends on, against synthetic transcript records in
// the CLI's own shapes (captured from a real store on 2026-08-25, CLI v2.1.237).
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import {
  ackAttention,
  bandForPct,
  buildInstanceRows,
  commandInstallOutcome,
  computeUsageItems,
  getOrchestratorPrompts,
  getOrchestratorSettings,
  installOrchestratorCommands,
  isInjectedUserText,
  type LiveSession,
  type OrchestratorDeps,
  type OrphanSession,
  orchestratorView,
  parseTranscriptTail,
  planOfAccountLabel,
  projectKeyForCwd,
  proposeArchivesForDoneSessions,
  resetsSoon,
  runOrchestratorOnce,
  samePath,
  setOrchestratorPrompts,
  setOrchestratorSettings,
  setSessionHold,
  type TailInfo,
  uninstallOrchestratorCommands,
} from '../src/orchestrator'
import {
  decideProposal,
  openProposalsForSession,
  proposeAction,
  reportProposalExecuted,
} from '../src/proposals'
import type { AttentionItem, UsageSnapshot } from '../src/types'
import { desktopKey } from '../src/usage-service'

const line = (o: unknown) => JSON.stringify(o)

const assistantText = (text: string, usage?: Record<string, number>) =>
  line({
    type: 'assistant',
    message: { content: [{ type: 'text', text }], usage },
  })

// --- parseTranscriptTail ----------------------------------------------------

test('idle chat with a recap: complete, recap detected, context tokens summed', () => {
  const raw = [
    line({ type: 'user', message: { content: 'Resume working on whatever you recommend next.' } }),
    assistantText(
      '## What I did\n- things\n## Am I 100% done?\n- yes\n## Do I recommend anything else?\n- more',
      { input_tokens: 1000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 2000 },
    ),
  ].join('\n')
  const t = parseTranscriptTail(raw)
  expect(t.unreadable).toBe(false)
  expect(t.ending).toBe('complete')
  expect(t.recapDetected).toBe(true)
  expect(t.midTurn).toBe(false)
  expect(t.ctxTokens).toBe(403_000)
  expect(t.lastHumanText).toContain('Resume working')
})

test('newest record is an assistant tool call: mid-turn, not idle-and-waiting', () => {
  const raw = [
    assistantText('Let me check.'),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running the build now.' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'bun test' } },
        ],
      },
    }),
  ].join('\n')
  const t = parseTranscriptTail(raw)
  expect(t.midTurn).toBe(true)
  expect(t.ending).toBe('complete')
})

test('newest record is a tool result with no assistant after it: also mid-turn', () => {
  const raw = [
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'bun test' } }],
      },
    }),
    line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    }),
  ].join('\n')
  const t = parseTranscriptTail(raw)
  expect(t.midTurn).toBe(true)
})

test('the CLI interrupt marker on a user record classifies as interrupted', () => {
  const raw = [
    assistantText('Working on it…'),
    line({ type: 'user', message: { content: '[Request interrupted by user]' } }),
  ].join('\n')
  expect(parseTranscriptTail(raw).ending).toBe('interrupted')
})

test('cross-session mail and task notifications are not "the human said something"', () => {
  const raw = [
    line({ type: 'user', message: { content: 'please fix the login bug' } }),
    assistantText('Done.'),
    line({
      type: 'user',
      message: {
        content:
          'Another Claude session sent a message: <cross-session-message from="x">hi</cross-session-message>',
      },
    }),
    line({ type: 'user', message: { content: '<task-notification>\n<task-id>t1</task-id>' } }),
    assistantText('Noted.'),
  ].join('\n')
  const t = parseTranscriptTail(raw)
  expect(t.lastHumanText).toBe('please fix the login bug')
  expect(isInjectedUserText('<local-command-stdout>Compacted </local-command-stdout>')).toBe(true)
  // Orchestrator plumbing is never "the human speaking" — a migration notice counted as a human
  // hold made the reviewer avoid every migrated thread forever.
  expect(isInjectedUserText('[orchestrator] You are being migrated to a different account')).toBe(
    true,
  )
})

test('spawn_task chips are captured with id, title and prompt', () => {
  const raw = [
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Flagging this for a separate session.' },
          {
            type: 'tool_use',
            id: 'tu_chip',
            name: 'mcp__ccd_session__spawn_task',
            input: { title: 'Fix stale README badge', prompt: 'In repo X, update the badge…' },
          },
        ],
      },
    }),
    assistantText('## What I did\n- flagged a chip'),
  ].join('\n')
  const t = parseTranscriptTail(raw)
  expect(t.chips).toHaveLength(1)
  expect(t.chips[0].id).toBe('tu_chip')
  expect(t.chips[0].title).toBe('Fix stale README badge')
  expect(t.chips[0].prompt).toContain('update the badge')
})

test('a byte-window starting mid-JSON skips the truncated line instead of failing', () => {
  const good = assistantText('## Am I 100% done?\n- yes')
  const raw = `nt","message":{"content":[{"type":"text","text":"cut off"}]}}\n${good}`
  const t = parseTranscriptTail(raw)
  expect(t.unreadable).toBe(false)
  expect(t.recapDetected).toBe(true)
})

test('a window with no parseable records reports unreadable rather than guessing', () => {
  expect(parseTranscriptTail('garbage\nmore garbage').unreadable).toBe(true)
})

test('the transcript-store key encoding matches the CLI (every non-alphanumeric to dash)', () => {
  expect(projectKeyForCwd('D:\\PublicProjects')).toBe('D--PublicProjects')
  expect(projectKeyForCwd('D:\\NEWProjects\\shared\\Connections')).toBe(
    'D--NEWProjects-shared-Connections',
  )
})

// --- usage banding ----------------------------------------------------------

const S = getOrchestratorSettings()

test('weekly bands follow the 80/85/90 defaults', () => {
  expect(bandForPct(79, S)).toBe('ok')
  expect(bandForPct(80, S)).toBe('elevated')
  expect(bandForPct(85, S)).toBe('high')
  expect(bandForPct(90, S)).toBe('critical')
})

test('resetsSoon only within the window, and never for a long-past reset', () => {
  const now = Date.parse('2026-08-25T10:00:00Z')
  expect(resetsSoon('2026-08-25T11:00:00Z', now, S)).toBe(true)
  expect(resetsSoon('2026-08-25T13:00:00Z', now, S)).toBe(false)
  expect(resetsSoon('2026-08-20T00:00:00Z', now, S)).toBe(false)
  expect(resetsSoon(null, now, S)).toBe(false)
})

const snap = (weekly: number, resetsAt: string | null, account = 'a@x'): UsageSnapshot => ({
  account,
  session: { pct: 10, resets: '' },
  weekAll: { pct: weekly, resets: '', resetsAt },
  weekModel: null,
  capturedAt: new Date().toISOString(),
})

test('a weekly spike between two close readings raises a spike alert', () => {
  const now = Date.now()
  const { items } = computeUsageItems(
    { 'desktop:c:\\i\\one': snap(72, null) },
    { 'desktop:c:\\i\\one': { pct: 60, atMs: now - 10 * 60_000, band: 'ok' } },
    S,
    now,
    new Date(now).toISOString(),
  )
  expect(items.some((i) => i.key.startsWith('usage-spike:'))).toBe(true)
})

test('band escalation alerts; the reset-soon exemption downgrades it to a dump target', () => {
  const now = Date.now()
  const soonIso = new Date(now + 60 * 60_000).toISOString()
  const farIso = new Date(now + 24 * 3600 * 1000).toISOString()
  const escalated = computeUsageItems({ 'desktop:x': snap(91, farIso) }, {}, S, now, 'now')
  expect(escalated.items.some((i) => i.key === 'usage:desktop:x:critical')).toBe(true)
  const exempted = computeUsageItems({ 'desktop:x': snap(91, soonIso) }, {}, S, now, 'now')
  expect(exempted.items).toHaveLength(0)
  // Codex quota is not this feature's business.
  const codex = computeUsageItems({ 'codex:default': snap(100, farIso) }, {}, S, now, 'now')
  expect(codex.items).toHaveLength(0)
})

test('zombie snapshots never alert: pre-reset readings and day-old captures are skipped', () => {
  const now = Date.now()
  // Captured in July, its own reset long past: describes a week that no longer exists.
  const preReset: UsageSnapshot = {
    account: 'old@x',
    session: { pct: 0, resets: '' },
    weekAll: {
      pct: 100,
      resets: '',
      resetsAt: new Date(now - 30 * 24 * 3600 * 1000).toISOString(),
    },
    weekModel: null,
    capturedAt: new Date(now - 35 * 24 * 3600 * 1000).toISOString(),
  }
  // Fresh-looking percentages but nothing has refreshed the reading in over a day.
  const dayOld: UsageSnapshot = {
    account: 'stale@x',
    session: { pct: 0, resets: '' },
    weekAll: { pct: 95, resets: '', resetsAt: new Date(now + 24 * 3600 * 1000).toISOString() },
    weekModel: null,
    capturedAt: new Date(now - 26 * 3600 * 1000).toISOString(),
  }
  const { items } = computeUsageItems(
    { 'desktop:old': preReset, 'desktop:stale': dayOld },
    {},
    S,
    now,
    'now',
  )
  expect(items).toHaveLength(0)
})

test('a /compact command echo is injected text, not the human speaking', () => {
  expect(
    isInjectedUserText(
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
    ),
  ).toBe(true)
})

test('critical stays in the feed every pass; lower bands only on escalation', () => {
  const now = Date.now()
  const prev = { 'desktop:x': { pct: 91, atMs: now - 60_000, band: 'critical' as const } }
  const again = computeUsageItems({ 'desktop:x': snap(92, null) }, prev, S, now, 'now')
  expect(again.items.some((i) => i.key === 'usage:desktop:x:critical')).toBe(true)
  const prevHigh = { 'desktop:x': { pct: 86, atMs: now - 60_000, band: 'high' as const } }
  const still = computeUsageItems({ 'desktop:x': snap(86, null) }, prevHigh, S, now, 'now')
  expect(still.items).toHaveLength(0)
})

// --- settings ---------------------------------------------------------------

test('settings round-trip and clamp', () => {
  const s = setOrchestratorSettings({ enabled: true, tickSecs: 5, dirtyMins: 999999 })
  expect(s.enabled).toBe(true)
  expect(s.tickSecs).toBe(30) // clamped up to the floor
  expect(s.dirtyMins).toBe(7 * 24 * 60) // clamped down to the ceiling
  setOrchestratorSettings({ enabled: false, tickSecs: 60, dirtyMins: 60 })
})

// --- the routing table ------------------------------------------------------

test('plan parses off the account label; absent suffix is null', () => {
  expect(planOfAccountLabel('tobix <t@x.com> · Max 20×')).toBe('Max 20×')
  expect(planOfAccountLabel('wiem <w@x.com> · Pro')).toBe('Pro')
  expect(planOfAccountLabel('just-a-label')).toBe(null)
  expect(planOfAccountLabel(null)).toBe(null)
})

test('instance rows: running-with-no-chats is open capacity; stale readings are unknown', () => {
  const now = Date.now()
  const fresh = (pct: number, account: string): UsageSnapshot => ({
    account,
    session: { pct: 5, resets: '' },
    weekAll: { pct, resets: '', resetsAt: new Date(now + 48 * 3600 * 1000).toISOString() },
    weekModel: null,
    capturedAt: new Date(now - 60_000).toISOString(),
  })
  const staleSnap: UsageSnapshot = {
    ...fresh(95, 'old <o@x> · Max 20×'),
    capturedAt: new Date(now - 30 * 3600 * 1000).toISOString(),
  }
  // Cache keys built by the SAME normalizer the code under test uses — hand-built keys only
  // matched on Windows (case-folding path normalization) and failed the ubuntu CI leg.
  const rows = buildInstanceRows(
    [
      { dir: 'c:\\i\\empty', name: 'empty-but-open', isRunning: true },
      { dir: 'c:\\i\\busy', name: 'busy', isRunning: true },
      { dir: 'c:\\i\\closed', name: 'closed', isRunning: false },
      { dir: 'c:\\i\\stale', name: 'stale', isRunning: true },
    ],
    {
      [desktopKey('c:\\i\\empty')]: fresh(10, 'a <a@x> · Max 20×'),
      [desktopKey('c:\\i\\busy')]: fresh(80, 'b <b@x> · Max 5×'),
      [desktopKey('c:\\i\\closed')]: fresh(1, 'c <c@x> · Pro'),
      [desktopKey('c:\\i\\stale')]: staleSnap,
    },
    S,
    now,
  )
  // Running first, most headroom first; the chatless-but-running instance is plain open capacity.
  expect(rows[0].name).toBe('empty-but-open')
  expect(rows[0].isRunning).toBe(true)
  expect(rows[0].plan).toBe('Max 20×')
  expect(rows.findIndex((r) => r.name === 'closed')).toBe(3) // closed sorts after ALL running
  const stale = rows.find((r) => r.name === 'stale')
  expect(stale?.stale).toBe(true)
  expect(stale?.weeklyPct).toBe(null)
  expect(stale?.band).toBe('unknown')
  const busy = rows.find((r) => r.name === 'busy')
  expect(busy?.band).toBe('elevated')
})

test('new settings round-trip: open-instances mode, min plan, reserve, handoff surface', () => {
  const s = setOrchestratorSettings({
    openInstances: 'when-exhausted',
    openMinPlan: 'Max 20',
    reviewerReservePct: 75,
    handoffSurface: 'queue',
  })
  expect(s.openInstances).toBe('when-exhausted')
  expect(s.openMinPlan).toBe('Max 20')
  expect(s.reviewerReservePct).toBe(75)
  expect(s.handoffSurface).toBe('queue')
  const back = setOrchestratorSettings({ openInstances: 'never', handoffSurface: 'terminal' })
  expect(back.openInstances).toBe('never')
  expect(back.handoffSurface).toBe('terminal')
  expect(setOrchestratorSettings({ handoffSurface: 'desktop' }).handoffSurface).toBe('desktop')
})

test('new-chat defaults: Opus 5 at max effort with ultracode, all overridable', () => {
  const s = getOrchestratorSettings()
  expect(s.newChatModel).toBe('opus')
  expect(s.newChatEffort).toBe('max')
  expect(s.newChatUltracode).toBe(true)
  const changed = setOrchestratorSettings({
    newChatModel: 'sonnet',
    newChatEffort: 'high',
    newChatUltracode: false,
  })
  expect(changed.newChatModel).toBe('sonnet')
  expect(changed.newChatEffort).toBe('high')
  expect(changed.newChatUltracode).toBe(false)
  // An invalid effort is refused, not stored.
  expect(setOrchestratorSettings({ newChatEffort: 'ultracode' as never }).newChatEffort).toBe(
    'high',
  )
  setOrchestratorSettings({ newChatModel: 'opus', newChatEffort: 'max', newChatUltracode: true })
})

test('the archive janitor PROPOSES retiring done-marked chats, and never flips flags itself', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-archjan-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, 'local_done-sess-1.json'),
    JSON.stringify({ cliSessionId: 'done-sess-1', isArchived: false }),
  )
  writeFileSync(
    join(store, 'local_active-sess-1.json'),
    JSON.stringify({ cliSessionId: 'active-sess-1', isArchived: false }),
  )
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, 1, ?) on conflict(session_id) do update set done = 1',
  ).run('done-sess-1', Date.now())
  expect(await proposeArchivesForDoneSessions([profile])).toBe(1)
  const read = (n: string) => JSON.parse(readFileSync(join(store, n), 'utf8'))
  // The action gate: nothing on disk changes until the reviewer approves and executes.
  expect(read('local_done-sess-1.json').isArchived).toBe(false)
  expect(read('local_active-sess-1.json').isArchived).toBe(false) // no done-mark, no proposal
  const open = openProposalsForSession('done-sess-1')
  expect(open).toHaveLength(1)
  expect(open[0].kind).toBe('archive')
  // A second sweep refreshes the open proposal instead of stacking a duplicate.
  expect(await proposeArchivesForDoneSessions([profile])).toBe(1)
  expect(openProposalsForSession('done-sess-1')).toHaveLength(1)
  // Approved + executed (the reviewer flipped the flag): the ask leaves the open set...
  const id = open[0].id
  expect(decideProposal(id, true, 'test-reviewer', 'retire it').ok).toBe(true)
  expect(reportProposalExecuted(id, true, 'archived natively').ok).toBe(true)
  writeFileSync(
    join(store, 'local_done-sess-1.json'),
    JSON.stringify({ cliSessionId: 'done-sess-1', isArchived: true }),
  )
  // ...and once every entry is archived, the sweep has nothing left to propose.
  expect(await proposeArchivesForDoneSessions([profile])).toBe(0)
  db.query('update session_marks set done = 0 where session_id = ?').run('done-sess-1')
})

test('the proposal gate: decide-then-execute is enforced, rejections stay quiet on old evidence', () => {
  const id = proposeAction({
    kind: 'revive',
    sessionId: 'gate-sess-1',
    summary: 'gate test',
    evidence: { flavor: 'crash' },
    evidenceAt: new Date(Date.now() - 3600_000).toISOString(),
  })
  expect(id).toBeTruthy()
  // Executing an undecided proposal is refused: the check comes FIRST, by law.
  expect(reportProposalExecuted(id as string, true).ok).toBe(false)
  // Double-deciding is refused too (the first ruling stands).
  expect(decideProposal(id as string, false, 'test-reviewer', 'not real').ok).toBe(true)
  expect(decideProposal(id as string, true, 'test-reviewer').ok).toBe(false)
  // Same evidence after a rejection: suppressed. NEWER evidence: a fresh proposal.
  expect(
    proposeAction({
      kind: 'revive',
      sessionId: 'gate-sess-1',
      summary: 'gate test again',
      evidence: { flavor: 'crash' },
      evidenceAt: new Date(Date.now() - 3600_000).toISOString(),
    }),
  ).toBe(null)
  const fresh = proposeAction({
    kind: 'revive',
    sessionId: 'gate-sess-1',
    summary: 'it moved again',
    evidence: { flavor: 'crash' },
    evidenceAt: new Date(Date.now() + 1000).toISOString(),
  })
  expect(fresh).toBeTruthy()
  expect(fresh).not.toBe(id)
  decideProposal(fresh as string, false, 'test-reviewer', 'cleanup')
})

// --- shipping the /orchestrate command --------------------------------------

test('command install decision: write when absent, keep an edited copy unless forced', () => {
  expect(commandInstallOutcome(null, 'shipped', false)).toBe('installed')
  expect(commandInstallOutcome('shipped', 'shipped', false)).toBe('up-to-date')
  expect(commandInstallOutcome('user edited', 'shipped', false)).toBe('differs')
  expect(commandInstallOutcome('user edited', 'shipped', true)).toBe('updated')
})

test('installOrchestratorCommands ships all three commands and respects edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-cmd-'))
  const first = installOrchestratorCommands(false, dir)
  expect(first.map((f) => [f.file, f.outcome])).toEqual([
    ['orchestrate.md', 'installed'],
    ['delayo.md', 'installed'],
    ['resumeo.md', 'installed'],
  ])
  const orch = first[0]
  const written = readFileSync(orch.path, 'utf8')
  expect(written).toContain('/orchestrate - the reviewer loop')
  expect(readFileSync(first[1].path, 'utf8')).toContain('"held": true')
  expect(readFileSync(first[2].path, 'utf8')).toContain('"held": false')
  expect(installOrchestratorCommands(false, dir).every((f) => f.outcome === 'up-to-date')).toBe(
    true,
  )
  writeFileSync(orch.path, `${written}\nlocal tweak`)
  const mixed = installOrchestratorCommands(false, dir)
  expect(mixed[0].outcome).toBe('differs')
  expect(mixed[1].outcome).toBe('up-to-date')
  expect(readFileSync(orch.path, 'utf8')).toContain('local tweak')
  expect(installOrchestratorCommands(true, dir)[0].outcome).toBe('updated')
  expect(readFileSync(orch.path, 'utf8')).toBe(written)
})

test('a held session produces NO feed items; lifting the hold restores them', async () => {
  // Clocks sit an hour ahead of the other tests so no earlier ack on this session id can
  // shadow the re-arm assertion (ack suppression needs mtime <= acked_at AND now < until).
  const { deps } = fakeDeps({
    nowMs: () => Date.now() + 60 * 60_000,
    mtime: Date.now() + 50 * 60_000,
  })
  setSessionHold('sess-1', true)
  await runOrchestratorOnce(deps)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.sessionId === 'sess-1')).toBe(
    false,
  )
  expect(orchestratorView().holds.some((h) => h.sessionId === 'sess-1')).toBe(true)
  setSessionHold('sess-1', false)
  await runOrchestratorOnce(deps)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.key === 'idle:sess-1')).toBe(
    true,
  )
  expect(orchestratorView().holds).toHaveLength(0)
})

// --- the pass, with injected deps -------------------------------------------

function fakeDeps(over: Partial<OrchestratorDeps> & { tail?: TailInfo; mtime?: number }): {
  deps: OrchestratorDeps
} {
  const session: LiveSession = {
    pid: 1234,
    sessionId: 'sess-1',
    cwd: 'D:\\Fake',
    name: 'fake-aa',
    startedAt: 0,
    transcriptPath: 'D:\\fake\\sess-1.jsonl',
  }
  const tail: TailInfo = over.tail ?? {
    ending: 'complete',
    lastAssistantText: '## Am I 100% done?\n- yes\n## Do I recommend anything else?\n- next steps',
    ctxTokens: 120_000,
    midTurn: false,
    pendingTool: null,
    recapDetected: true,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: null,
    unreadable: false,
  }
  const deps: OrchestratorDeps = {
    nowMs: () => Date.now(),
    claudeHome: () => 'unused',
    registry: () => [session],
    orphans: () => [],
    recentTranscripts: () => [],
    // Codex is observe-only and off this fixture's path by default; the codex tests inject it.
    codexThreads: () => [],
    codexTail: () => ({
      ending: 'complete' as const,
      lastAgentText: null,
      recapDetected: false,
      unreadable: true,
    }),
    dispatchActive: () => false,
    sessionMeta: () => new Map(),
    tailInfo: () => tail,
    mtimeMs: () => over.mtime ?? Date.now() - 10 * 60_000,
    git: async () => null,
    usage: () => ({}),
    instanceRef: () => null,
    desktopInstances: async () => [],
    taskActivity: () => null,
    ...over,
  }
  return { deps }
}

test('an idle session with a recap becomes idle_pending; huge context becomes handoff_due', async () => {
  const { deps } = fakeDeps({})
  await runOrchestratorOnce(deps)
  let feed = orchestratorView().attention
  expect(
    feed.some((i: AttentionItem) => i.key === 'idle:sess-1' && i.kind === 'idle_pending'),
  ).toBe(true)
  const { deps: bigCtx } = fakeDeps({
    tail: {
      ending: 'complete',
      lastAssistantText: 'recap',
      ctxTokens: 900_000,
      midTurn: false,
      pendingTool: null,
      recapDetected: false,
      handoffDetected: false,
      chips: [],
      lastEventAt: null,
      lastHumanText: null,
      lastHumanAt: null,
      unreadable: false,
    },
  })
  await runOrchestratorOnce(bigCtx)
  feed = orchestratorView().attention
  expect(feed.some((i: AttentionItem) => i.key === 'idle:sess-1' && i.kind === 'handoff_due')).toBe(
    true,
  )
})

test('a busy session (fresh mtime) produces no idle item, but IS flagged if unmapped', async () => {
  const { deps } = fakeDeps({ mtime: Date.now() - 5_000 })
  await runOrchestratorOnce(deps)
  const feed = orchestratorView().attention
  expect(feed.some((i: AttentionItem) => i.key === 'idle:sess-1')).toBe(false)
  // The owner's tell (2026-08-26): a session with no desktop home shows as "unknown account"
  // in the UI - broken headless residue. On the desktop surface it is flagged busy or not.
  const unmapped = feed.find((i: AttentionItem) => i.key === 'unmapped:sess-1')
  expect(unmapped?.kind).toBe('errored')
  expect(unmapped?.detail?.unmappedInstance).toBe(true)
})

test('an acked item is suppressed, and re-arms when the transcript moves after the ack', async () => {
  const { deps } = fakeDeps({ mtime: Date.now() - 10 * 60_000 })
  await runOrchestratorOnce(deps)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.key === 'idle:sess-1')).toBe(
    true,
  )
  ackAttention('idle:sess-1', 'nudged', 30)
  await runOrchestratorOnce(deps)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.key === 'idle:sess-1')).toBe(
    false,
  )
  // The chat did something after the ack (mtime advances past acked_at), then went idle again —
  // long enough ago to clear idleQuietSecs. That must re-arm without waiting out the cooldown.
  const { deps: moved } = fakeDeps({
    nowMs: () => Date.now() + 20 * 60_000,
    mtime: Date.now() + 10 * 60_000,
  })
  await runOrchestratorOnce(moved)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.key === 'idle:sess-1')).toBe(
    true,
  )
})

test('dead background tasks: silent waiting flags for intervention; live tasks do not', async () => {
  const waitingTail: TailInfo = {
    ending: 'complete',
    lastAssistantText: 'Kicked off the sweep in the background.',
    ctxTokens: 100_000,
    midTurn: true,
    pendingTool: 'Bash',
    recapDetected: false,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: null,
    unreadable: false,
  }
  // Clocks sit 4h ahead of the other tests, with the transcript mtime AFTER any earlier ack on
  // this session id, so cooldown suppression from previous tests cannot shadow these items.
  const base = Date.now() + 4 * 3600 * 1000
  // Transcript quiet 3h, newest task output 3h old (past the 120min default): DEAD.
  const { deps: dead } = fakeDeps({
    tail: waitingTail,
    nowMs: () => base,
    mtime: base - 3 * 3600 * 1000,
    taskActivity: () => base - 3 * 3600 * 1000,
  })
  await runOrchestratorOnce(dead)
  let item = orchestratorView().attention.find((i: AttentionItem) => i.key === 'idle:sess-1')
  expect(item?.detail?.staleTasks).toBe(true)
  expect(item?.summary).toContain('DEAD BACKGROUND TASKS')
  // Same quiet transcript but a task wrote output 5 minutes ago: alive, leave it be.
  const { deps: alive } = fakeDeps({
    tail: waitingTail,
    nowMs: () => base,
    mtime: base - 3 * 3600 * 1000,
    taskActivity: () => base - 5 * 60_000,
  })
  await runOrchestratorOnce(alive)
  item = orchestratorView().attention.find((i: AttentionItem) => i.key === 'idle:sess-1')
  expect(item?.detail?.staleTasks).toBe(false)
  expect(item?.summary).toContain('likely a background task')
  // No task dir at all + waiting + silent: also dead (the wait excuse has no evidence).
  const { deps: noDir } = fakeDeps({
    tail: waitingTail,
    nowMs: () => base,
    mtime: base - 3 * 3600 * 1000,
  })
  await runOrchestratorOnce(noDir)
  item = orchestratorView().attention.find((i: AttentionItem) => i.key === 'idle:sess-1')
  expect(item?.detail?.staleTasks).toBe(true)
})

test('branch and dirty hygiene: off-main flags immediately; dirty flags after dirtyMins', async () => {
  const git = async () => ({
    isRepo: true,
    branch: 'feature/x',
    detached: false,
    dirtyCount: 3,
    dirtySample: [' M a.ts'],
    aheadCount: 2,
  })
  const base = Date.now()
  const { deps } = fakeDeps({ git, nowMs: () => base, mtime: base - 10 * 60_000 })
  await runOrchestratorOnce(deps)
  let feed = orchestratorView().attention
  expect(feed.some((i: AttentionItem) => i.kind === 'branch_off_main')).toBe(true)
  expect(feed.some((i: AttentionItem) => i.kind === 'repo_dirty')).toBe(false) // just seen dirty
  // Same dirt an hour later (dirtyMins default 60), sessions still idle: now it flags.
  const { deps: later } = fakeDeps({
    git,
    nowMs: () => base + 61 * 60_000,
    mtime: base - 10 * 60_000,
  })
  await runOrchestratorOnce(later)
  feed = orchestratorView().attention
  expect(feed.some((i: AttentionItem) => i.kind === 'repo_dirty')).toBe(true)
  expect(feed.find((i: AttentionItem) => i.kind === 'repo_dirty')?.peerName).toBe('fake-aa')
})

// --- orphaned sessions: died mid-process (computer restart / crash / kill) ---

/** A stale registry file on disk (json + key sibling), as a hard restart leaves them. */
function orphanOnDisk(sessionId: string, pid: number): OrphanSession {
  const dir = mkdtempSync(join(tmpdir(), 'ah-orph-'))
  const registryPath = join(dir, `${pid}.json`)
  writeFileSync(
    registryPath,
    JSON.stringify({ sessionId, cwd: 'D:\\Fake', pid, name: `orph-${pid}` }),
  )
  writeFileSync(join(dir, `${pid}.abc.key`), 'k')
  return {
    pid,
    sessionId,
    cwd: 'D:\\Fake',
    name: `orph-${pid}`,
    startedAt: 1,
    transcriptPath: 'D:\\fake\\orph.jsonl',
    registryPath,
  }
}

test('a dead-pid registry entry becomes an orphaned item: mid-process death is resumable', async () => {
  const o = orphanOnDisk('orph-sess-1', 90001)
  const { deps } = fakeDeps({ registry: () => [], orphans: () => [o] })
  await runOrchestratorOnce(deps)
  const item = orchestratorView().attention.find(
    (i: AttentionItem) => i.key === 'orphan:orph-sess-1',
  )
  expect(item?.kind).toBe('orphaned')
  expect(item?.summary).toContain('died mid-process')
  expect(existsSync(o.registryPath)).toBe(true) // evidence kept while the item stands
})

test('an orphan superseded by a live session with the same id is cleaned, not reported', async () => {
  const o = orphanOnDisk('sess-1', 90002) // fakeDeps' live session is also sess-1
  const { deps } = fakeDeps({ orphans: () => [o], mtime: Date.now() - 5_000 })
  await runOrchestratorOnce(deps)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.key === 'orphan:sess-1')).toBe(
    false,
  )
  expect(existsSync(o.registryPath)).toBe(false) // residue removed, key sibling included
  expect(existsSync(join(o.registryPath, '..', '90002.abc.key'))).toBe(false)
})

test('a done-marked orphan is finished work: cleaned, never resumed', async () => {
  const o = orphanOnDisk('orph-done-1', 90003)
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, 1, ?) on conflict(session_id) do update set done = 1',
  ).run('orph-done-1', Date.now())
  const { deps } = fakeDeps({ registry: () => [], orphans: () => [o] })
  await runOrchestratorOnce(deps)
  expect(
    orchestratorView().attention.some((i: AttentionItem) => i.key === 'orphan:orph-done-1'),
  ).toBe(false)
  expect(existsSync(o.registryPath)).toBe(false)
})

test('a held orphan stays parked: no item, evidence kept', async () => {
  const o = orphanOnDisk('orph-held-1', 90004)
  setSessionHold('orph-held-1', true)
  const { deps } = fakeDeps({ registry: () => [], orphans: () => [o] })
  await runOrchestratorOnce(deps)
  expect(
    orchestratorView().attention.some((i: AttentionItem) => i.key === 'orphan:orph-held-1'),
  ).toBe(false)
  expect(existsSync(o.registryPath)).toBe(true)
  setSessionHold('orph-held-1', false)
})

test('a fresh orphan (inside the quiet window) waits: a relaunch may be in flight', async () => {
  const o = orphanOnDisk('orph-fresh-1', 90005)
  const { deps } = fakeDeps({ registry: () => [], orphans: () => [o], mtime: Date.now() - 5_000 })
  await runOrchestratorOnce(deps)
  expect(
    orchestratorView().attention.some((i: AttentionItem) => i.key === 'orphan:orph-fresh-1'),
  ).toBe(false)
  expect(existsSync(o.registryPath)).toBe(true)
})

test('prompts: defaults resolve, edits override, blank or default-text saves reset', () => {
  const p0 = getOrchestratorPrompts()
  expect(p0.resumeNudge).toBe('Resume working on whatever you recommend next.')
  expect(setOrchestratorPrompts({ resumeNudge: 'Go on then.' }).resumeNudge).toBe('Go on then.')
  // Saving the default text verbatim clears the override (future default improvements land).
  expect(setOrchestratorPrompts({ resumeNudge: p0.resumeNudge }).resumeNudge).toBe(p0.resumeNudge)
  // Blank resets too.
  setOrchestratorPrompts({ handoffRequest: 'custom handoff ask' })
  expect(setOrchestratorPrompts({ handoffRequest: '   ' }).handoffRequest).toBe(p0.handoffRequest)
})

test('uninstall removes the shipped commands; a second pass reports them missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-cmds-'))
  installOrchestratorCommands(false, dir)
  expect(uninstallOrchestratorCommands(dir).every((f) => f.outcome === 'removed')).toBe(true)
  expect(uninstallOrchestratorCommands(dir).every((f) => f.outcome === 'missing')).toBe(true)
})

test('LIVE BUT DEAF: a process with no turn since it spawned is orphaned, not idle', async () => {
  const now = Date.now()
  const deafSession: LiveSession = {
    pid: 92001,
    sessionId: 'deaf-1',
    cwd: 'D:\\Fake',
    name: 'deaf-1',
    startedAt: now - 5 * 60_000, // process spawned 5 minutes ago...
    transcriptPath: 'D:\\fake\\deaf-1.jsonl',
  }
  const deafTail: TailInfo = {
    ending: 'complete',
    lastAssistantText: 'old recap',
    ctxTokens: 100_000,
    midTurn: false,
    pendingTool: null,
    recapDetected: true,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: new Date(now - 6 * 3600_000).toISOString(), // ...but the last turn is 6h old
    unreadable: false,
  }
  const { deps } = fakeDeps({
    registry: () => [deafSession],
    nowMs: () => now,
    mtimeMs: () => now - 10 * 60_000,
    tail: deafTail,
  })
  await runOrchestratorOnce(deps)
  const feed = orchestratorView().attention
  const hit = feed.find((i: AttentionItem) => i.key === 'orphan:deaf-1')
  expect(hit?.kind).toBe('orphaned')
  expect(hit?.detail?.deaf).toBe(true)
  expect(hit?.summary).toContain('LIVE BUT DEAF')
  expect(feed.some((i: AttentionItem) => i.key === 'idle:deaf-1')).toBe(false)
})

test('a live chat that HAS run since spawning is ordinary idle, never deaf', async () => {
  const now = Date.now()
  const okSession: LiveSession = {
    pid: 92002,
    sessionId: 'live-ok-1',
    cwd: 'D:\\Fake',
    name: 'live-ok-1',
    startedAt: now - 2 * 3600_000,
    transcriptPath: 'D:\\fake\\live-ok-1.jsonl',
  }
  const okTail: TailInfo = {
    ending: 'complete',
    lastAssistantText: '## Am I 100% done?\n- yes',
    ctxTokens: 100_000,
    midTurn: false,
    pendingTool: null,
    recapDetected: true,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: new Date(now - 10 * 60_000).toISOString(), // ran a turn after spawn
    unreadable: false,
  }
  const { deps } = fakeDeps({
    registry: () => [okSession],
    nowMs: () => now,
    mtimeMs: () => now - 10 * 60_000,
    tail: okTail,
  })
  await runOrchestratorOnce(deps)
  const feed = orchestratorView().attention
  expect(feed.some((i: AttentionItem) => i.key === 'idle:live-ok-1')).toBe(true)
  expect(feed.some((i: AttentionItem) => i.key === 'orphan:live-ok-1')).toBe(false)
})

test('parseTranscriptTail captures the newest record timestamp as lastEventAt', () => {
  const raw = [
    line({ type: 'user', timestamp: '2026-08-25T14:00:00.000Z', message: { content: 'go' } }),
    line({
      type: 'assistant',
      timestamp: '2026-08-25T15:00:00.000Z',
      message: { content: [{ type: 'text', text: 'done' }] },
    }),
  ].join('\n')
  expect(parseTranscriptTail(raw).lastEventAt).toBe('2026-08-25T15:00:00.000Z')
})

test('a STRANDED desktop chat (graceful shutdown, no registry residue) is surfaced', async () => {
  const now = Date.now()
  const midTail: TailInfo = {
    ending: 'complete',
    lastAssistantText: 'Editing the policy file now.',
    ctxTokens: 200_000,
    midTurn: true,
    pendingTool: 'Bash',
    recapDetected: false,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: null,
    unreadable: false,
  }
  const recent = [
    { sessionId: 'strand-1', path: 'D:\\fake\\strand-1.jsonl', mtimeMs: now - 30 * 60_000 },
    // Finished tail: a chat idling in a sidebar is normal, not stranded.
    { sessionId: 'strand-2', path: 'D:\\fake\\strand-2.jsonl', mtimeMs: now - 30 * 60_000 },
    // No desktop metadata: not a sidebar chat, not this scan's business.
    { sessionId: 'strand-3', path: 'D:\\fake\\strand-3.jsonl', mtimeMs: now - 30 * 60_000 },
  ]
  const { deps } = fakeDeps({
    registry: () => [],
    nowMs: () => now,
    recentTranscripts: () => recent,
    sessionMeta: () =>
      new Map([
        ['strand-1', { instance: 'work', archived: false }],
        ['strand-2', { instance: 'work', archived: false }],
      ]),
    tailInfo: (p: string) => (p.includes('strand-1') ? midTail : { ...midTail, midTurn: false }),
  })
  await runOrchestratorOnce(deps)
  const feed = orchestratorView().attention
  const hit = feed.find((i: AttentionItem) => i.key === 'orphan:strand-1')
  expect(hit?.kind).toBe('orphaned')
  expect(hit?.summary).toContain('STRANDED')
  expect(hit?.detail?.stranded).toBe(true)
  expect(feed.some((i: AttentionItem) => i.key === 'orphan:strand-2')).toBe(false)
  expect(feed.some((i: AttentionItem) => i.key === 'orphan:strand-3')).toBe(false)
})

test('an ACKED orphan disappears from the feed but never from the revive list', async () => {
  const now = Date.now()
  const deafSession: LiveSession = {
    pid: 92003,
    sessionId: 'deaf-acked-1',
    cwd: 'D:\\Fake',
    name: 'deaf-acked-1',
    startedAt: now - 5 * 60_000,
    transcriptPath: 'D:\\fake\\deaf-acked-1.jsonl',
  }
  const deafTail: TailInfo = {
    ending: 'complete',
    lastAssistantText: 'old recap',
    ctxTokens: 100_000,
    midTurn: false,
    pendingTool: null,
    recapDetected: true,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: new Date(now - 6 * 3600_000).toISOString(),
    unreadable: false,
  }
  // The reviewer acks the orphan — the move that used to blindfold the old reviver for the
  // chat that most needed it. Acks shape the READING list; the proposal ledger sees pre-ack.
  ackAttention('orphan:deaf-acked-1', 'orphan-revive-awaiting-click', 15)
  const { deps } = fakeDeps({
    registry: () => [deafSession],
    nowMs: () => now,
    mtimeMs: () => now - 10 * 60_000,
    tail: deafTail,
  })
  await runOrchestratorOnce(deps)
  const view = orchestratorView()
  expect(view.attention.some((i: AttentionItem) => i.key === 'orphan:deaf-acked-1')).toBe(false)
  const open = openProposalsForSession('deaf-acked-1')
  expect(open).toHaveLength(1)
  expect(open[0].kind).toBe('revive')
  expect(open[0].evidence.flavor).toBe('deaf')
  expect(view.meta.proposalsPending).toBeGreaterThanOrEqual(1)
  decideProposal(open[0].id, false, 'test-reviewer', 'cleanup')
})

test('samePath survives the exact casing mismatch that let the daemon kill a live chat', () => {
  // 2026-08-26 incident: instanceRefForSession returned the real-cased dir while the restart
  // marker stored it lowercased; strict === matched nothing, "zero live sessions" was always
  // true, and the visibility restart quit the work app under a live mid-turn chat.
  expect(
    samePath(
      'C:\\Users\\blogi\\.claude-instances\\work',
      'c:\\users\\blogi\\.claude-instances\\work',
    ),
  ).toBe(true)
  expect(samePath('C:\\A\\work\\', 'c:\\a\\work')).toBe(true)
  expect(samePath('C:\\A\\work', 'C:\\A\\work2')).toBe(false)
})

test('a chat frozen at a permission prompt is diagnosed as that, not as dead background tasks', async () => {
  // Measured 2026-08-26: five revived chats each ran one Bash call and froze at an approval the
  // remote owner could never click - alive, ~300MB, no CPU, nothing in any log. The old code
  // called this "waiting on dead background tasks", which is the wrong diagnosis AND the wrong
  // fix. What separates the two is whether this chat's permission mode prompts for the tool it
  // is sitting on.
  const now = Date.now()
  const stuckTail: TailInfo = {
    ending: 'complete',
    lastAssistantText: 'Let me check the tree.',
    ctxTokens: 100_000,
    midTurn: true,
    pendingTool: 'Bash',
    recapDetected: false,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: null,
    unreadable: false,
  }
  const base = {
    nowMs: () => now,
    // Quiet well past staleTaskMins (120 default), so the stale-task rule fires either way.
    mtimeMs: () => now - 5 * 3600_000,
    tail: stuckTail,
    registry: () => [slotSession('perm-stuck', 93001)],
  }
  // 'acceptEdits' auto-approves EDITS but prompts on every shell command -> an approval stall.
  const blocked = fakeDeps({
    ...base,
    sessionMeta: () =>
      new Map([
        ['perm-stuck', { instance: 'work', archived: false, permissionMode: 'acceptEdits' }],
      ]),
  })
  await runOrchestratorOnce(blocked.deps)
  const hit = orchestratorView().attention.find((i: AttentionItem) => i.key === 'idle:perm-stuck')
  expect(hit?.detail?.approvalStall).toBe(true)
  expect(hit?.detail?.pendingTool).toBe('Bash')
  expect(hit?.summary).toContain('FROZEN AT A PERMISSION PROMPT')
  expect(hit?.summary).not.toContain('DEAD BACKGROUND TASKS')

  // Same evidence, bypass mode: the identical dangling Bash is a long build, NOT a stall. A
  // detector that cried wolf here would get ignored, which is how the real one gets missed.
  const running = fakeDeps({
    ...base,
    sessionMeta: () =>
      new Map([
        ['perm-stuck', { instance: 'work', archived: false, permissionMode: 'bypassPermissions' }],
      ]),
  })
  await runOrchestratorOnce(running.deps)
  const hit2 = orchestratorView().attention.find((i: AttentionItem) => i.key === 'idle:perm-stuck')
  expect(hit2?.detail?.approvalStall).toBe(false)
  expect(hit2?.summary).not.toContain('FROZEN AT A PERMISSION PROMPT')
})

test('parseTranscriptTail names the tool a mid-turn chat is sitting on', () => {
  const raw = [
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'checking' }] } }),
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_9', name: 'Bash', input: { command: 'cargo test' } }],
      },
    }),
  ].join('\n')
  const t = parseTranscriptTail(raw)
  expect(t.midTurn).toBe(true)
  expect(t.pendingTool).toBe('Bash')
})

// --- the concurrency cap (round-robin rotation) ------------------------------

function slotSession(id: string, pid: number): LiveSession {
  return {
    pid,
    sessionId: id,
    cwd: 'D:\\Fake',
    name: id,
    startedAt: 0,
    transcriptPath: `D:\\fake\\${id}.jsonl`,
  }
}

test('maxActiveChats round-trips, clamps at 0, and defaults to unlimited', () => {
  expect(getOrchestratorSettings().maxActiveChats).toBe(0)
  expect(setOrchestratorSettings({ maxActiveChats: 15 }).maxActiveChats).toBe(15)
  expect(setOrchestratorSettings({ maxActiveChats: -3 }).maxActiveChats).toBe(0)
})

test('cap: free slots go longest-idle first; the overflow is marked waiting, never dropped', async () => {
  setOrchestratorSettings({ maxActiveChats: 1 })
  const now = Date.now()
  const mtimes: Record<string, number> = {
    'D:\\fake\\slot-a.jsonl': now - 40 * 60_000, // longest idle — gets the slot
    'D:\\fake\\slot-b.jsonl': now - 20 * 60_000, // waits
  }
  const { deps } = fakeDeps({
    registry: () => [slotSession('slot-a', 91001), slotSession('slot-b', 91002)],
    mtimeMs: (p: string) => mtimes[p] ?? now - 10 * 60_000,
    nowMs: () => now,
  })
  await runOrchestratorOnce(deps)
  const feed = orchestratorView().attention
  const a = feed.find((i: AttentionItem) => i.key === 'idle:slot-a')
  const b = feed.find((i: AttentionItem) => i.key === 'idle:slot-b')
  expect(a?.detail?.waitingForSlot).toBeUndefined()
  expect(b?.detail?.waitingForSlot).toBe(true)
  expect(b?.summary).toContain('WAITING FOR A SLOT')
  expect(orchestratorView().meta.slotsFree).toBe(1)
  setOrchestratorSettings({ maxActiveChats: 0 })
})

test('cap: a BUSY chat holds a slot, so every idle chat waits; 0 disables the whole gate', async () => {
  setOrchestratorSettings({ maxActiveChats: 1 })
  const now = Date.now()
  const mtimes: Record<string, number> = {
    'D:\\fake\\slot-c.jsonl': now - 5_000, // busy: holds the only slot
    'D:\\fake\\slot-d.jsonl': now - 20 * 60_000, // idle: must wait
  }
  const { deps } = fakeDeps({
    registry: () => [slotSession('slot-c', 91003), slotSession('slot-d', 91004)],
    mtimeMs: (p: string) => mtimes[p] ?? now - 10 * 60_000,
    nowMs: () => now,
  })
  await runOrchestratorOnce(deps)
  let view = orchestratorView()
  expect(view.meta.runningChats).toBe(1)
  expect(view.meta.slotsFree).toBe(0)
  expect(
    view.attention.find((i: AttentionItem) => i.key === 'idle:slot-d')?.detail?.waitingForSlot,
  ).toBe(true)
  // Unlimited: same fleet, no gate, slotsFree is null (not a number to obey).
  setOrchestratorSettings({ maxActiveChats: 0 })
  await runOrchestratorOnce(deps)
  view = orchestratorView()
  expect(view.meta.slotsFree).toBe(null)
  expect(
    view.attention.find((i: AttentionItem) => i.key === 'idle:slot-d')?.detail?.waitingForSlot,
  ).toBeUndefined()
})

test('one lineage, one continuation: a done-marked LIVE session gets no nudge items', async () => {
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, 1, ?) on conflict(session_id) do update set done = 1',
  ).run('sess-1', Date.now())
  const { deps } = fakeDeps({})
  await runOrchestratorOnce(deps)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.sessionId === 'sess-1')).toBe(
    false,
  )
  db.query('update session_marks set done = 0 where session_id = ?').run('sess-1')
})
