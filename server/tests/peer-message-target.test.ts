// server/tests/peer-message-target.test.ts - a moved chat has one live engine per copy, and the
// peer pipe must only ever reach the copy the caller named.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { peerTargetFor } from '../src/peer-message'

const SID = 'moved-1111-2222-3333-444455556666'
const home = mkdtempSync(join(tmpdir(), 'peer-target-'))
const sessions = join(home, 'sessions')
mkdirSync(sessions)
writeFileSync(
  join(sessions, `${process.pid}.json`),
  JSON.stringify({
    sessionId: SID,
    pid: process.pid,
    messagingSocketPath: 'cc-msg-test',
    hostSessionId: 'local_copy-on-temp1',
  }),
)

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

test('a live entry for another copy of the same chat is not the target', () => {
  expect(peerTargetFor(SID, home, 'local_copy-on-temp2')).toBeNull()
})

test('the named copy live entry is the target', () => {
  expect(peerTargetFor(SID, home, 'local_copy-on-temp1')?.pid).toBe(process.pid)
})

test('without a named host the live entry is found as before', () => {
  expect(peerTargetFor(SID, home)?.pid).toBe(process.pid)
})
