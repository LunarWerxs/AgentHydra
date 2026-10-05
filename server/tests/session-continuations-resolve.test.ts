// server/tests/session-continuations-resolve.test.ts — a capped parent search picks up where it stopped.
//
// resolveOne reads at most MAX_CANDIDATES (24) transcripts per pass, nearest mtime first. Before
// 2026-10-04 a pass that hit the cap without finding the uuid started over on the next sweep and
// read the SAME 24 again: on the owner's PC four such links re-read ~425 MB every sweep (as often
// as every 10 s), forever, in step with the page-in spikes behind "my PC freezes every 30 seconds".
// And a parent ranked 25th or later was never reached at all. Pinned here: the second pass reads
// only transcripts the first did not, and so reaches the parent.

import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetContinuationMemoForTests,
  resolveContinuations,
  supersededSessions,
} from '../src/session-continuations'

const root = mkdtempSync(join(tmpdir(), 'agenthydra-cont-resolve-'))
afterAll(() => {
  resetContinuationMemoForTests()
  rmSync(root, { recursive: true, force: true })
})

test('a search stopped at the cap reads the next candidates on the next pass, not the same ones', async () => {
  resetContinuationMemoForTests()
  const dir = join(root, 'D--demo')
  mkdirSync(dir, { recursive: true })
  const tag = Math.random().toString(36).slice(2)
  const uuid = `uuid-${tag}-0000-0000-000000000000`
  const childId = `child-${tag}`
  const parentId = `parent-${tag}`
  const at = (ms: number, path: string) => utimesSync(path, new Date(ms), new Date(ms))
  const T = Date.now() - 10 * 86_400_000

  const childPath = join(dir, `${childId}.jsonl`)
  writeFileSync(childPath, `${JSON.stringify({ type: 'system', logicalParentUuid: uuid })}\n`)
  at(T, childPath)
  // 30 decoys all nearer in mtime than the parent: more than one pass's worth.
  const decoys: string[] = []
  for (let i = 0; i < 30; i++) {
    const p = join(dir, `decoy-${tag}-${String(i).padStart(2, '0')}.jsonl`)
    writeFileSync(
      p,
      `${JSON.stringify({ type: 'user', uuid: `other-${i}`, text: 'x'.repeat(200) })}\n`,
    )
    at(T - (i + 1) * 1000, p)
    decoys.push(p)
  }
  const parentPath = join(dir, `${parentId}.jsonl`)
  writeFileSync(parentPath, `${JSON.stringify({ type: 'assistant', uuid })}\n`)
  at(T - 5_000_000, parentPath)

  const entry = { sessionId: childId, logicalParentUuid: uuid, path: childPath, mtimeMs: T }
  const opened = spyOn(Bun, 'file')
  try {
    await resolveContinuations([entry])
    const first = new Set(opened.mock.calls.map((c) => String(c[0])))
    expect(supersededSessions().get(parentId)).toBeUndefined()
    expect(first.size).toBe(24)
    expect([...first].every((p) => decoys.includes(p))).toBe(true)

    opened.mockClear()
    await resolveContinuations([entry])
    const second = opened.mock.calls.map((c) => String(c[0]))
    expect(second.filter((p) => first.has(p))).toEqual([])
    expect(supersededSessions().get(parentId)).toBe(childId)
  } finally {
    opened.mockRestore()
  }
})
