// The storage pass (climayte.ts planStorage): what it packs and removes, and what it never touches.
// CONFIG_DIR is a scratch dir (tests/setup.ts), so corch/ here is not a real install's.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planStorage } from '../src/climayte'
import { HOOKS, LOGS, PROMPTS, packedPath, packLog, peekLog, ROOT } from '../src/climayte-core'

const DAY = 24 * 3_600_000
const now = Date.now()

function file(path: string, ageMs: number, body = 'x'): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  const t = (now - ageMs) / 1000
  utimesSync(path, t, t)
  return path
}

const attempt = (log: string, outcome: string, endedAt: number | null) =>
  ({ log, outcome, endedAt, runner: null, pid: null, account: { id: 'a' } }) as any
const worker = (id: string, status: string, attempts: unknown[]) =>
  ({ id, status, attempts }) as any

describe('the storage pass', () => {
  test('packs a settled log after 10 minutes, never a running or fresh one, and a packed log still reads', () => {
    const settled = file(
      join(LOGS, 'w-aa-0.jsonl'),
      20 * 60_000,
      '{"type":"system","subtype":"init"}\n',
    )
    const fresh = file(join(LOGS, 'w-bb-0.jsonl'), 60_000)
    const running = file(join(LOGS, 'w-cc-0.jsonl'), 3_600_000)
    const plan = planStorage(
      [
        worker('w-aa', 'done', [attempt(settled, 'done', now - 15 * 60_000)]),
        worker('w-bb', 'done', [attempt(fresh, 'done', now - 60_000)]),
        worker('w-cc', 'running', [attempt(running, 'running', null)]),
      ],
      now,
    )
    expect(plan.pack.map((p) => p.path)).toEqual([settled])
    expect(packLog(settled, now - 10 * 60_000)).toBeGreaterThan(0)
    expect(peekLog(settled).sawInit).toBe(true)
    expect(packedPath(settled).endsWith('.zst')).toBe(true)
  })

  test('removes a finished worker’s files after 14 days, keeps an active worker’s and a recent one’s', () => {
    const old = now - 20 * DAY
    const oldPrompt = file(join(PROMPTS, 'w-dd-0.txt'), 20 * DAY)
    const oldHook = file(join(HOOKS, 'w-dd.json'), 20 * DAY)
    const activePrompt = file(join(PROMPTS, 'w-ee-0.txt'), 20 * DAY)
    const recentPrompt = file(join(PROMPTS, 'w-ff-0.txt'), DAY)
    file(join(ROOT, 'archive', 'stamp-old', 'w-gg', 'x.txt'), 0)
    utimesSync(join(ROOT, 'archive', 'stamp-old'), (now - 40 * DAY) / 1000, (now - 40 * DAY) / 1000)
    const plan = planStorage(
      [
        worker('w-dd', 'done', [attempt('l1', 'done', old)]),
        worker('w-ee', 'running', [attempt('l2', 'running', null)]),
        worker('w-ff', 'done', [attempt('l3', 'done', now - DAY)]),
      ],
      now,
    )
    const gone = plan.remove.map((r) => r.path)
    expect(gone).toContain(oldPrompt)
    expect(gone).toContain(oldHook)
    expect(gone).not.toContain(activePrompt)
    expect(gone).not.toContain(recentPrompt)
    expect(gone.some((p) => p.endsWith('stamp-old'))).toBe(true)
  })
})
