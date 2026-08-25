// server/tests/orchestrator.test.ts — the attention watcher's judgment-free half, pinned.
//
// The orchestrator feed is consumed by an AI reviewer that acts on it (nudges live chats), so a
// wrong classification here does not just mislabel a row — it sends a "resume working" message
// into a chat that was mid-tool, or misses the one that has been sitting idle for an hour. Each
// test pins one classification the reviewer depends on, against synthetic transcript records in
// the CLI's own shapes (captured from a real store on 2026-08-25, CLI v2.1.237).
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ackAttention,
  bandForPct,
  buildInstanceRows,
  commandInstallOutcome,
  computeUsageItems,
  getOrchestratorSettings,
  installOrchestrateCommand,
  isInjectedUserText,
  type LiveSession,
  type OrchestratorDeps,
  orchestratorView,
  parseTranscriptTail,
  planOfAccountLabel,
  projectKeyForCwd,
  resetsSoon,
  runOrchestratorOnce,
  setOrchestratorSettings,
  type TailInfo,
} from '../src/orchestrator'
import type { AttentionItem, UsageSnapshot } from '../src/types'

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
  const rows = buildInstanceRows(
    [
      { dir: 'c:\\i\\empty', name: 'empty-but-open', isRunning: true },
      { dir: 'c:\\i\\busy', name: 'busy', isRunning: true },
      { dir: 'c:\\i\\closed', name: 'closed', isRunning: false },
      { dir: 'c:\\i\\stale', name: 'stale', isRunning: true },
    ],
    {
      [`desktop:${'c:\\i\\empty'}`]: fresh(10, 'a <a@x> · Max 20×'),
      [`desktop:${'c:\\i\\busy'}`]: fresh(80, 'b <b@x> · Max 5×'),
      [`desktop:${'c:\\i\\closed'}`]: fresh(1, 'c <c@x> · Pro'),
      [`desktop:${'c:\\i\\stale'}`]: staleSnap,
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
})

// --- shipping the /orchestrate command --------------------------------------

test('command install decision: write when absent, keep an edited copy unless forced', () => {
  expect(commandInstallOutcome(null, 'shipped', false)).toBe('installed')
  expect(commandInstallOutcome('shipped', 'shipped', false)).toBe('up-to-date')
  expect(commandInstallOutcome('user edited', 'shipped', false)).toBe('differs')
  expect(commandInstallOutcome('user edited', 'shipped', true)).toBe('updated')
})

test('installOrchestrateCommand writes the bundled command and respects edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-cmd-'))
  const first = installOrchestrateCommand(false, dir)
  expect(first.outcome).toBe('installed')
  const written = readFileSync(first.path, 'utf8')
  expect(written).toContain('/orchestrate - the reviewer loop')
  expect(installOrchestrateCommand(false, dir).outcome).toBe('up-to-date')
  writeFileSync(first.path, `${written}\nlocal tweak`)
  expect(installOrchestrateCommand(false, dir).outcome).toBe('differs')
  expect(readFileSync(first.path, 'utf8')).toContain('local tweak')
  expect(installOrchestrateCommand(true, dir).outcome).toBe('updated')
  expect(readFileSync(first.path, 'utf8')).toBe(written)
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
    recapDetected: true,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    unreadable: false,
  }
  const deps: OrchestratorDeps = {
    nowMs: () => Date.now(),
    claudeHome: () => 'unused',
    registry: () => [session],
    tailInfo: () => tail,
    mtimeMs: () => over.mtime ?? Date.now() - 10 * 60_000,
    git: async () => null,
    usage: () => ({}),
    instanceRef: () => null,
    desktopInstances: async () => [],
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
      recapDetected: false,
      handoffDetected: false,
      chips: [],
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

test('a busy session (fresh mtime) produces no idle item', async () => {
  const { deps } = fakeDeps({ mtime: Date.now() - 5_000 })
  await runOrchestratorOnce(deps)
  expect(orchestratorView().attention.some((i: AttentionItem) => i.sessionId === 'sess-1')).toBe(
    false,
  )
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
