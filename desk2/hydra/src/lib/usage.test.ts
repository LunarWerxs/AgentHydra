// web/src/lib/usage.ts — the derivations every usage chip, badge and popover reads.
//
// The chip label and window choice (usageCellLabel / usagePctFor) have their own, longer file in
// web/tests/usage-label.test.ts; this one pins the rest of the module's contract: the colour bands,
// the "no data" and "stale" judgements, the money/date formatting that must never throw on what
// claude.ai hands back, which Code credit earns a row icon, and the reason -> message mapping.
import { expect, test } from 'bun:test'
import type { ClaudeCodeCredit, UsageSnapshot } from './api'
import {
  bindingWeeklyPct,
  flaggedCodeCredit,
  formatMoney,
  isNoDataSnap,
  isStaleSnap,
  shortDate,
  usageBadgeVariant,
  usageCellLabel,
  usageCheckedAgo,
  usagePctFor,
  usageReasonMessageKey,
} from './usage'

const snap = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  account: '4claude',
  session: { pct: 13, resets: 'Aug 5, 4:59pm' },
  weekAll: { pct: 92, resets: 'Aug 6, 4:59am' },
  weekModel: null,
  capturedAt: new Date().toISOString(),
  ...over,
})
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const credit = (over: Partial<ClaudeCodeCredit> = {}): ClaudeCodeCredit => ({
  state: 'active',
  limitUsd: 250,
  remainingUsd: 246.11,
  expiresAt: null,
  lockedReason: null,
  ...over,
})
const withCredit = (codeCredit: ClaudeCodeCredit | null) =>
  snap({ claudeApp: { checkedAt: ago(0), codeCredit, usageCredits: null, weeklySplit: null } })

test('the binding percentage is the weekly all-models one, null when never captured', () => {
  expect(bindingWeeklyPct(snap())).toBe(92)
  expect(bindingWeeklyPct(snap({ weekAll: null }))).toBeNull()
})

test('a snapshot is "no data" only when every window is missing', () => {
  expect(isNoDataSnap(snap({ session: null, weekAll: null, weekModel: null }))).toBe(true)
  expect(isNoDataSnap(snap({ session: null, weekAll: null }))).toBe(true)
  expect(
    isNoDataSnap(
      snap({
        session: null,
        weekAll: null,
        weekModel: { pct: 4, resets: 'Aug 6, 4:59am', label: 'Fable' },
      }),
    ),
  ).toBe(false)
})

test('badge colour bands: green under 70, amber 70 through 90, red over 90', () => {
  expect(usageBadgeVariant(0)).toBe('success')
  expect(usageBadgeVariant(69)).toBe('success')
  expect(usageBadgeVariant(70)).toBe('warning')
  expect(usageBadgeVariant(90)).toBe('warning')
  expect(usageBadgeVariant(91)).toBe('destructive')
})

test('chip percentage and label read the same window', () => {
  expect(usagePctFor(snap(), 'session')).toBe(13)
  expect(usageCellLabel(snap(), 'session')).toBe('13%')
  expect(usagePctFor(null)).toBeNull()
})

test('"checked ago" is relative to now, and "—" for an unparseable timestamp', () => {
  expect(usageCheckedAgo(ago(3 * 60 * 60_000))).toBe('3h ago')
  expect(usageCheckedAgo('not a date')).toBe('—')
})

test('a missing amount is "—", never "$0.00"', () => {
  expect(formatMoney(null)).toBe('—')
  expect(formatMoney(undefined, 'EUR')).toBe('—')
})

test('money formats in the given currency, USD when none is given', () => {
  const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })
  expect(formatMoney(246.11)).toBe(usd.format(246.11))
  expect(formatMoney(246.11, null)).toBe(usd.format(246.11))
})

test('a currency code Intl rejects falls back to a plain amount instead of throwing', () => {
  expect(formatMoney(246.1, 'not-a-code')).toBe('246.10 not-a-code')
})

test('shortDate renders a month and day, "—" for a missing or unparseable date', () => {
  const iso = '2020-11-05T12:00:00.000Z'
  expect(shortDate(iso)).toBe(
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  )
  expect(shortDate(null)).toBe('—')
  expect(shortDate(undefined)).toBe('—')
  expect(shortDate('garbage')).toBe('—')
})

test('a Code credit with money left, held back or never claimed is flagged', () => {
  expect(flaggedCodeCredit(withCredit(credit()))?.remainingUsd).toBe(246.11)
  expect(flaggedCodeCredit(withCredit(credit({ state: 'locked', remainingUsd: 0 })))?.state).toBe(
    'locked',
  )
  expect(
    flaggedCodeCredit(withCredit(credit({ state: 'unclaimed', remainingUsd: null })))?.state,
  ).toBe('unclaimed')
})

test('a spent-out or absent Code credit is not flagged', () => {
  expect(flaggedCodeCredit(withCredit(credit({ remainingUsd: 0.5 })))).toBeNull()
  expect(flaggedCodeCredit(withCredit(credit({ remainingUsd: null })))).toBeNull()
  expect(flaggedCodeCredit(withCredit(null))).toBeNull()
  expect(flaggedCodeCredit(snap())).toBeNull()
  expect(flaggedCodeCredit(null)).toBeNull()
})

test('a snapshot older than half an hour is stale; a fresh or unreadable one is not', () => {
  expect(isStaleSnap(snap({ capturedAt: ago(2 * 60 * 60_000) }))).toBe(true)
  expect(isStaleSnap(snap({ capturedAt: ago(60_000) }))).toBe(false)
  expect(isStaleSnap(snap({ capturedAt: 'not a date' }))).toBe(false)
  expect(isStaleSnap(null)).toBe(false)
})

test('each no-data reason maps to its own explanation; ok needs none', () => {
  expect(usageReasonMessageKey('logged_out')).toBe('instances.usageReasonLoggedOut')
  expect(usageReasonMessageKey('no_token')).toBe('instances.usageReasonNoToken')
  expect(usageReasonMessageKey('not_logged_in')).toBe('instances.usageReasonNotLoggedIn')
  expect(usageReasonMessageKey('check_failed')).toBe('instances.usageReasonCheckFailed')
  expect(usageReasonMessageKey('stale_token_app_closed')).toBe('instances.usageReasonAppClosed')
  expect(usageReasonMessageKey('rate_limited')).toBe('instances.usageReasonRateLimited')
  expect(usageReasonMessageKey('ok')).toBeNull()
})

test('an unknown or never-checked reason falls back to "not checked yet"', () => {
  expect(usageReasonMessageKey('unknown')).toBe('instances.usageNotChecked')
  expect(usageReasonMessageKey(undefined)).toBe('instances.usageNotChecked')
})
