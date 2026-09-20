import { describe, expect, test } from 'bun:test'
import { expectedSourceSha256, fixture, provenance } from './archive-fixture'

describe('installed Claude archive methods with inert fixture dependencies (not live app)', () => {
  test('records source checksum and exact-ID archive/unarchive amid duplicate titles', async () => {
    expect(provenance.sha256).toBe(expectedSourceSha256)
    expect(provenance.methods).toHaveLength(7)
    console.info('Archive POC provenance', JSON.stringify(provenance))
    const f = fixture()
    const target = f.add('local_target'),
      other = f.add('local_other')
    await f.guardedArchive(target.sessionId)
    expect(target.isArchived).toBe(true)
    expect(other.isArchived).toBe(false)
    expect(f.saved[0].sessionId).toBe(target.sessionId)
    expect(f.events[0]).toMatchObject({
      type: 'archived',
      sessionId: target.sessionId,
      alsoArchived: [],
    })
    f.manager.unarchiveSession(target.sessionId)
    expect(target.isArchived).toBe(false)
    expect(f.events[1]).toMatchObject({ type: 'unarchived', sessionId: target.sessionId })
    expect(f.saved).toHaveLength(2)
    expect(other).toMatchObject({ isArchived: false, title: 'Duplicate title' })
  })
  test('cleanupWorktree:false bypasses actual cleanup branch and preserves transcript identity', async () => {
    const f = fixture(),
      target = f.add('local_keep')
    await f.guardedArchive(target.sessionId)
    expect(target.worktreePath).toBe('fixture://worktree')
    expect(target.cliSessionId).toBe('cli-local_keep')
    expect(f.sessions.has(target.sessionId)).toBe(true)
    expect(f.calls.some((c) => c.name === 'removeWorktree' || c.name === 'gitStatus')).toBe(false)
  })
  test('native closure exposes shared-checkout bystanders; guard refuses before mutation', async () => {
    const f = fixture(),
      parent = f.add('local_parent')
    const child = f.add('local_child', {
      isStarred: true,
      spawnedFrom: { sideSession: true, sharedCheckout: true, sessionId: parent.sessionId },
    })
    f.add('local_grandchild', {
      spawnedFrom: { sideSession: true, sharedCheckout: true, sessionId: child.sessionId },
    })
    expect(f.manager.archiveCascadeClosureOf(parent).map((s: any) => s.sessionId)).toEqual([
      'local_child',
      'local_grandchild',
    ])
    await expect(f.guardedArchive(parent.sessionId)).rejects.toThrow('Refusing cascade')
    expect([...f.sessions.values()].every((s: any) => !s.isArchived)).toBe(true)
    expect(f.saved).toHaveLength(0)
    expect(f.events).toHaveLength(0)
  })
  test('title and CLI ID cannot substitute for the native ID', async () => {
    const f = fixture(),
      target = f.add('local_target')
    await expect(f.guardedArchive(target.title)).rejects.toThrow('Exact native session ID')
    await expect(f.guardedArchive(target.cliSessionId)).rejects.toThrow('Exact native session ID')
    expect(f.saved).toHaveLength(0)
  })
  test('harness refuses live or starting sessions before invoking native teardown', async () => {
    const f = fixture(),
      target = f.add('local_busy', { isRunning: true })
    await expect(f.guardedArchive(target.sessionId)).rejects.toThrow('stopped session')
    target.isRunning = false
    f.manager.startingSessionIds.add(target.sessionId)
    await expect(f.guardedArchive(target.sessionId)).rejects.toThrow('stopped session')
    expect(target.isArchived).toBe(false)
    expect(f.calls).toHaveLength(0)
    expect(f.saved).toHaveLength(0)
  })
  test('native archive preserves carried settings and leaves unrelated session objects unchanged', async () => {
    const f = fixture()
    const carried = {
      title: 'Archive POC',
      model: 'claude-opus-5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
      sessionSettings: { ultracode: true },
    }
    const target = f.add('local_keep_settings', carried)
    const other = f.add('local_untouched', { messageBuffer: [{ type: 'fixture-history' }] })
    const before = structuredClone(other)
    await f.guardedArchive(target.sessionId)
    expect(target).toMatchObject(carried)
    expect(other).toEqual(before)
    expect(f.saved.every((s: any) => s.sessionId === target.sessionId)).toBe(true)
    expect(f.events.every((event: any) => event.sessionId === target.sessionId)).toBe(true)
  })
})
