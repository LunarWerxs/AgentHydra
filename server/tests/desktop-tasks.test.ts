// Writing into the Desktop app's own scheduler is what removed the last human touch, so the
// shape it writes is pinned here against the REAL file captured from the app on 2026-08-28.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeAccountDir,
  hasDesktopTask,
  installDesktopTask,
  removeDesktopTask,
} from '../src/desktop-tasks'

function fixtureInstance(): { dir: string; live: string; stale: string } {
  const dir = join(tmpdir(), `dt-${Math.random().toString(36).slice(2)}`)
  const stale = join(dir, 'claude-code-sessions', 'org-old', 'user-old')
  const live = join(dir, 'claude-code-sessions', 'org-new', 'user-new')
  mkdirSync(stale, { recursive: true })
  mkdirSync(live, { recursive: true })
  // The stale account folder is written FIRST, so "most recently touched wins" is a real test
  // rather than an accident of directory order.
  writeFileSync(join(stale, 'local_old.json'), '{}')
  const past = new Date(Date.now() - 60 * 60_000)
  require('node:fs').utimesSync(join(stale, 'local_old.json'), past, past)
  writeFileSync(join(live, 'local_new.json'), '{}')
  return { dir, live, stale }
}

describe('desktop-tasks', () => {
  test('activeAccountDir picks the most recently touched account folder', () => {
    const f = fixtureInstance()
    expect(activeAccountDir(f.dir)).toBe(f.live)
  })

  test('install writes the app-native shape, and is idempotent', () => {
    const f = fixtureInstance()
    const res = installDesktopTask({
      instanceDir: f.dir,
      taskId: 'orch-courier-test',
      description: 'courier',
      prompt: 'do the thing',
      fireAt: 1_800_000_000_000,
      cwd: f.dir,
    })
    if (!res.ok) throw new Error(res.reason)
    const store = JSON.parse(readFileSync(join(f.live, 'scheduled-tasks.json'), 'utf8'))
    // Exactly the keys the real app wrote for its own probe task.
    expect(Object.keys(store).sort()).toEqual([
      'dayFieldsOrBoundaryStamped',
      'recordedSkips',
      'scheduledTasks',
      'sundayAliasBoundaryStamped',
    ])
    expect(store.scheduledTasks.length).toBe(1)
    const row = store.scheduledTasks[0]
    expect(Object.keys(row).sort()).toEqual([
      'createdAt',
      'cwd',
      'enabled',
      'filePath',
      'fireAt',
      'id',
    ])
    expect(row.enabled).toBe(true)
    expect(readFileSync(row.filePath, 'utf8')).toContain('do the thing')
    expect(hasDesktopTask(f.dir, 'orch-courier-test')).toBe(true)

    // Second install: prompt updated, still exactly one row.
    installDesktopTask({
      instanceDir: f.dir,
      taskId: 'orch-courier-test',
      description: 'courier',
      prompt: 'updated body',
      fireAt: 1_800_000_000_000,
      cwd: f.dir,
    })
    const after = JSON.parse(readFileSync(join(f.live, 'scheduled-tasks.json'), 'utf8'))
    expect(after.scheduledTasks.length).toBe(1)
    expect(readFileSync(after.scheduledTasks[0].filePath, 'utf8')).toContain('updated body')
  })

  test("an owner's own task is never removable, and survives our writes", () => {
    const f = fixtureInstance()
    writeFileSync(
      join(f.live, 'scheduled-tasks.json'),
      JSON.stringify({
        scheduledTasks: [
          {
            id: 'my-daily-standup',
            cronExpression: '0 9 * * *',
            enabled: true,
            filePath: 'C:/whatever/SKILL.md',
            createdAt: 1,
            cwd: 'C:/x',
          },
        ],
        recordedSkips: {},
        sundayAliasBoundaryStamped: true,
        dayFieldsOrBoundaryStamped: true,
      }),
    )
    expect(removeDesktopTask(f.dir, 'my-daily-standup').ok).toBe(false)
    installDesktopTask({
      instanceDir: f.dir,
      taskId: 'orch-courier-test',
      description: 'c',
      prompt: 'p',
      fireAt: 1_800_000_000_000,
      cwd: f.dir,
    })
    const store = JSON.parse(readFileSync(join(f.live, 'scheduled-tasks.json'), 'utf8'))
    expect(store.scheduledTasks.map((t: { id: string }) => t.id).sort()).toEqual([
      'my-daily-standup',
      'orch-courier-test',
    ])
    // And removing OURS leaves theirs untouched.
    expect(removeDesktopTask(f.dir, 'orch-courier-test').ok).toBe(true)
    const final = JSON.parse(readFileSync(join(f.live, 'scheduled-tasks.json'), 'utf8'))
    expect(final.scheduledTasks.map((t: { id: string }) => t.id)).toEqual(['my-daily-standup'])
  })

  test('a signed-out instance refuses rather than inventing a folder', () => {
    const dir = join(tmpdir(), `dt-empty-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const res = installDesktopTask({
      instanceDir: dir,
      taskId: 'orch-courier-test',
      description: 'c',
      prompt: 'p',
      fireAt: 1_800_000_000_000,
      cwd: dir,
    })
    expect(res.ok).toBe(false)
  })
})
