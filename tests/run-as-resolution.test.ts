// tests/run-as-resolution.test.ts — which login does a queued message go out under?
//
// The bug this locks out, from a real pair of runs (2026-07-27): two resumes of a chat belonging to
// the `temp1` desktop instance both died on "You've hit your weekly limit". The instance's own
// account was at 22% — it was never asked. Every desktop instance is a DIFFERENT Anthropic account,
// but they all write transcripts into the SHARED `~/.claude/projects` store, so a resume that
// carries no `instance_ref` runs on whatever the ambient CLI login happens to be. Here that was an
// unrelated account which genuinely WAS maxed, so the app reported someone else's wall as this
// chat's.
//
// The pinning machinery already existed (dispatch.ts 'desktop:<dir>' → value-blind token injection);
// what was missing was anyone filling it in for a resume. These pin the four-way precedence, and in
// particular the two directions that must NOT auto-resolve — an explicit choice, of either shape,
// is never second-guessed.
import { expect, test } from 'bun:test'
import { instanceRefForSession, resolveRunAsRef } from '../server/src/instance-sessions'
import { AMBIENT_RUN_AS } from '../server/src/types'

const SESSION = 'sess-abc'
const PINNED = 'desktop:C:\\Users\\u\\.claude-instances\\temp1'
// Injected so the decision is tested without a desktop instance store on disk.
const lookup = (id: string) => (id === SESSION ? PINNED : null)

test('a resume that says nothing is pinned to the session own desktop instance', () => {
  expect(resolveRunAsRef({}, SESSION, lookup)).toBe(PINNED)
})

test('an explicitly null instance_ref still resolves (null on the wire means "nobody said")', () => {
  expect(resolveRunAsRef({ instance_ref: null, account_id: null }, SESSION, lookup)).toBe(PINNED)
})

test('AMBIENT_RUN_AS is the opt-out: stored as null, never auto-resolved', () => {
  expect(resolveRunAsRef({ instance_ref: AMBIENT_RUN_AS }, SESSION, lookup)).toBeNull()
})

test('an explicit instance ref wins — nothing is inferred over a named instance', () => {
  const other = 'desktop:C:\\Users\\u\\.claude-instances\\5claude'
  expect(resolveRunAsRef({ instance_ref: other }, SESSION, lookup)).toBe(other)
  expect(resolveRunAsRef({ instance_ref: 'cli:abc-123' }, SESSION, lookup)).toBe('cli:abc-123')
})

test('a pasted-credential account is an explicit choice too, so it is not overridden', () => {
  expect(resolveRunAsRef({ account_id: 'acct-1' }, SESSION, lookup)).toBeNull()
})

test('a new chat has no transcript to inherit an instance from', () => {
  expect(resolveRunAsRef({ new_chat: true }, SESSION, lookup)).toBeNull()
})

test('a session with no desktop instance (plain CLI transcript) stays unpinned', () => {
  expect(resolveRunAsRef({}, 'sess-not-in-any-instance', lookup)).toBeNull()
  // …and the real lookup agrees for an id that cannot be in any instance's metadata.
  expect(instanceRefForSession('definitely-not-a-real-session-id')).toBeNull()
})
