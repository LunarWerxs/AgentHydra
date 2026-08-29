// server/tests/orchestrator-usage-evidence.test.ts — the session→instance→account join in
// attention evidence, and the limit-risk flag the item composer derives from it.
//
// Field report 2026-08-29 (chat "Gods Eye View integration review" on 2uhmany): the worklist item
// carried evidence {"account":null,"accountWeeklyPct":null} for a chat whose instance was
// perfectly known, no field for the 5-hour session window existed at all, the reviewer approved
// the resume blind, and 24 minutes later the chat died mid-edit on "You've hit your session
// limit · resets 10:30pm". Root cause: the usage cache is keyed by desktopKey() — NORMALIZED
// (win32: resolved + lowercased) — while instanceRefForSession() returns the real-cased dir, and
// the evidence composer indexed one with the other raw, so the join matched nothing on Windows.
// These tests pin (1) the join landing across spelling differences, (2) the evidence shape
// carrying all four account fields, and (3) the composer flag that makes a blind approve
// impossible to repeat.
import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import {
  accountUsageEvidence,
  getOrchestratorSettings,
  type LiveSession,
  type OrchestratorDeps,
  orchestratorView,
  runOrchestratorOnce,
  type TailInfo,
  usageForInstanceRef,
} from '../src/orchestrator'
import { buildWorklist, usageRiskFlag } from '../src/orchestrator-worklist'
import type { AttentionItem, UsageSnapshot } from '../src/types'
import { desktopKey } from '../src/usage-service'

// Mixed case on purpose: on win32 desktopKey lowercases this, so the cache key and the raw
// `desktop:<dir>` ref genuinely differ — the exact incident shape.
const INSTANCE_DIR = join(tmpdir(), 'AgentHydra-UsageJoin', '2uhmany')

const snapshot = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  account: 'tobix · Max 20×',
  session: { pct: 87, resets: '10:30pm', resetsAt: null },
  weekAll: { pct: 42, resets: 'Sep 3, 11:00am', resetsAt: '2026-09-03T18:00:00.000Z' },
  weekModel: null,
  capturedAt: new Date().toISOString(),
  ...over,
})

test('usageForInstanceRef joins a raw desktop ref onto the normalized cache key', () => {
  const cache = { [desktopKey(INSTANCE_DIR)]: snapshot() }
  // The incident shape: the ref as instanceRefForSession spells it (real casing).
  expect(usageForInstanceRef(cache, `desktop:${INSTANCE_DIR}`)?.account).toBe('tobix · Max 20×')
  // An unresolved spelling of the same dir (redundant `..` segment) must land on EVERY
  // platform — this is the branch a linux CI run exercises, where casing alone cannot differ.
  const unresolved = `desktop:${INSTANCE_DIR}${sep}..${sep}${basename(INSTANCE_DIR)}`
  expect(usageForInstanceRef(cache, unresolved)?.weekAll?.pct).toBe(42)
  expect(usageForInstanceRef(cache, null)).toBeNull()
  expect(usageForInstanceRef(cache, `desktop:${join(tmpdir(), 'no-such-instance')}`)).toBeNull()
})

test('accountUsageEvidence carries the 5-hour window, falling back to the human reset string', () => {
  expect(accountUsageEvidence(snapshot())).toEqual({
    account: 'tobix · Max 20×',
    accountWeeklyPct: 42,
    accountSessionPct: 87,
    accountSessionResetsAt: '10:30pm',
  })
  // The null-join shape itself: unknown stays unknown, never fabricated.
  expect(accountUsageEvidence(null)).toEqual({
    account: null,
    accountWeeklyPct: null,
    accountSessionPct: null,
    accountSessionResetsAt: null,
  })
})

// --- the pass, with injected deps: evidence shape end to end ---------------------------------

function joinDeps(sessionId: string, snap: UsageSnapshot): OrchestratorDeps {
  const session: LiveSession = {
    pid: 4321,
    sessionId,
    cwd: 'D:\\Fake',
    name: `fake-${sessionId.slice(-2)}`,
    startedAt: 0,
    transcriptPath: `D:\\fake\\${sessionId}.jsonl`,
  }
  const tail: TailInfo = {
    ending: 'complete',
    lastAssistantText: '## Am I 100% done?\n- yes',
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
  return {
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
    sessionMeta: () => new Map(),
    tailInfo: () => tail,
    mtimeMs: () => Date.now() - 10 * 60_000,
    git: async () => null,
    // Keyed exactly as setCachedUsage keys it; the ref exactly as instanceRefForSession forms it.
    usage: () => ({ [desktopKey(INSTANCE_DIR)]: snap }),
    instanceRef: () => `desktop:${INSTANCE_DIR}`,
    desktopInstances: async () => [],
    taskActivity: () => null,
  }
}

test('attention evidence carries account, weekly AND the 5-hour session window when the instance resolves', async () => {
  await runOrchestratorOnce(joinDeps('sess-usage-join', snapshot()))
  const item = orchestratorView().attention.find(
    (i: AttentionItem) => i.key === 'idle:sess-usage-join',
  )
  expect(item).toBeDefined()
  expect(item?.detail?.account).toBe('tobix · Max 20×')
  expect(item?.detail?.accountWeeklyPct).toBe(42)
  expect(item?.detail?.accountSessionPct).toBe(87)
  expect(item?.detail?.accountSessionResetsAt).toBe('10:30pm')
})

// --- the composer flag ------------------------------------------------------------------------

test('usageRiskFlag: healthy or unknown accounts produce no line', () => {
  const s = getOrchestratorSettings()
  expect(usageRiskFlag({ account: 'a', accountWeeklyPct: 42, accountSessionPct: 30 }, s)).toBeNull()
  // Unknown must never fabricate a warning — the unmapped-instance item owns that case.
  expect(
    usageRiskFlag({ account: null, accountWeeklyPct: null, accountSessionPct: null }, s),
  ).toBeNull()
})

test('usageRiskFlag: weekly high/critical and a hot 5-hour window each flag', () => {
  const s = getOrchestratorSettings() // defaults: warnPct 85, hardPct 90, sessionHighPct 90
  const weekly = usageRiskFlag({ account: 'acct-a', accountWeeklyPct: 86 }, s)
  expect(weekly).toContain('LIMIT RISK')
  expect(weekly).toContain('weekly at 86% (high)')
  const sessionHot = usageRiskFlag(
    { account: 'acct-b', accountSessionPct: 93, accountSessionResetsAt: '10:30pm' },
    s,
  )
  expect(sessionHot).toContain('5-hour window at 93%')
  expect(sessionHot).toContain('resets 10:30pm')
  expect(usageRiskFlag({ accountWeeklyPct: 91 }, s)).toContain('(critical)')
})

test('a resume item for a chat on a hot 5-hour window carries the flag in constraintsApplied', async () => {
  const hot = snapshot({ session: { pct: 93, resets: '10:30pm', resetsAt: null } })
  await runOrchestratorOnce(joinDeps('sess-usage-flag', hot))
  const wl = buildWorklist('reviewer-of-this-test')
  const item = wl.items.find((i) => i.id === 'att:idle:sess-usage-flag')
  expect(item).toBeDefined()
  const flag = item?.constraintsApplied.find((c) => c.includes('LIMIT RISK'))
  expect(flag).toContain('5-hour window at 93%')
  expect(flag).toContain('resets 10:30pm')
  // …and the evidence the reviewer reads shows the same numbers, not null.
  expect(item?.evidence.accountSessionPct).toBe(93)
})
