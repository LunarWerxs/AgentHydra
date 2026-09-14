// server/tests/live-registry-pid-recycling.test.ts — a dead session whose pid got recycled.
//
// THE FAILURE THIS PINS, measured 2026-09-13 while draining an account: a session had died
// un-gracefully, its `<pid>.json` stayed behind (the registry is written on start, never cleaned
// on crash), and Windows handed that number to an unrelated instance's Electron renderer. Every
// consumer then believed the chat was live: `list_chats` reported live:true, the move gates would
// have refused it, and `--terminate-live` would have killed a STRANGER'S process tree.
//
// pid existence cannot answer "is THIS session alive" and never could. `messagingSocketPath` can:
// it names that one session, so a recycled pid cannot answer for it. These tests use THIS process's
// own pid — genuinely alive — so the pid leg is never what decides the verdict.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLiveRegistry, readOrphanedRegistry } from '../src/live-registry'

function home(records: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-live-registry-'))
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  for (const r of records) {
    writeFileSync(join(dir, 'sessions', `${r.pid}.json`), JSON.stringify(r))
  }
  return dir
}

function record(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: process.pid,
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: 'D:\\NEWProjects',
    startedAt: 1789319298925,
    ...patch,
  }
}

describe('readLiveRegistry: a live pid is not a live session', () => {
  test('a recycled pid whose session socket is gone is NOT live', () => {
    // The pid is this very process, so it is unambiguously alive. Only the missing socket can
    // produce the right answer here — which is the whole point.
    const dir = home([record({ messagingSocketPath: join(tmpdir(), 'ah-no-such-socket-xyz') })])
    try {
      expect(readLiveRegistry(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('and it is reported as an ORPHAN, which is what crash evidence is for', () => {
    const dir = home([record({ messagingSocketPath: join(tmpdir(), 'ah-no-such-socket-xyz') })])
    try {
      expect(readOrphanedRegistry(dir).map((s) => s.sessionId)).toEqual([
        '11111111-1111-4111-8111-111111111111',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a session whose socket exists IS live', () => {
    // Any path that exists stands in for the socket — existence is the entire signal.
    const dir = home([record({ messagingSocketPath: tmpdir() })])
    try {
      expect(readLiveRegistry(dir).map((s) => s.pid)).toEqual([process.pid])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a record too old to carry a socket path still falls back to the pid alone', () => {
    // Narrowing liveness must not blind the daemon to an older CLI's sessions.
    const dir = home([record()])
    try {
      expect(readLiveRegistry(dir).map((s) => s.pid)).toEqual([process.pid])
      expect(readOrphanedRegistry(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
