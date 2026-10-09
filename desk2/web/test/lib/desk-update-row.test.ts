import { afterEach, describe, expect, test } from 'bun:test'
import { clickUpdate, footerUpdate, runUpdateSteps, updateClicking, type ReleaseWaiting } from '../../src/lib/desk-update-row'
import { checkServerUpdate, restartServer, updateOffer, type UpdateOffer } from '../../src/lib/server-update'
import { rememberForUpdate } from '../../src/lib/whats-new'

const stale: UpdateOffer = { restartable: true, restarting: false, error: null }
const waiting = (over: Partial<ReleaseWaiting> = {}): ReleaseWaiting => ({
  updateAvailable: true,
  canApply: true,
  latestVersion: null,
  ...over,
})
const idle = { applying: false, applyError: null }

describe('the sidebar update row', () => {
  test('nothing waiting, no row', () => {
    expect(footerUpdate({ release: null, server: null, ...idle })).toBeNull()
    expect(footerUpdate({ release: waiting({ updateAvailable: false }), server: null, ...idle })).toBeNull()
  })

  test('a stale Desk server that can restart reads Click to restart and update', () => {
    expect(footerUpdate({ release: null, server: stale, ...idle })).toEqual({
      label: 'Click to restart and update',
      steps: ['restart'],
      clickable: true,
      busy: false,
      error: null,
    })
  })

  test('a waiting release names its version and is applied before the restart', () => {
    const row = footerUpdate({ release: waiting({ latestVersion: 'v0.33.1' }), server: null, ...idle })
    expect(row?.label).toBe('Click to restart and update to v0.33.1')
    expect(row?.steps).toEqual(['apply', 'restart'])
    expect(row?.clickable).toBe(true)
  })

  test('a release without a version number keeps the plain label, and a commit is not shown as one', () => {
    expect(footerUpdate({ release: waiting({ latestVersion: 'a1b2c3d' }), server: null, ...idle })?.label).toBe('Click to restart and update')
    expect(footerUpdate({ release: waiting(), server: null, ...idle })?.label).toBe('Click to restart and update')
  })

  test('both waiting: apply, then restart', () => {
    const row = footerUpdate({ release: waiting({ latestVersion: '0.33.1' }), server: stale, ...idle })
    expect(row?.steps).toEqual(['apply', 'restart'])
    expect(row?.label).toBe('Click to restart and update to v0.33.1')
  })

  test('a blocked release shows no row, even with the server stale', () => {
    expect(footerUpdate({ release: waiting({ canApply: false }), server: null, ...idle })).toBeNull()
    expect(footerUpdate({ release: waiting({ canApply: false }), server: stale, ...idle })).toBeNull()
  })

  test('a stale server that cannot restart is told to run the launcher, and the row is not a button', () => {
    expect(footerUpdate({ release: null, server: { restartable: false, restarting: false, error: null }, ...idle })).toEqual({
      label: 'Server out of date: run launcher/restart.ps1',
      steps: [],
      clickable: false,
      busy: false,
      error: null,
    })
  })

  test('a refusal shows its text and the row stays clickable to retry', () => {
    const row = footerUpdate({
      release: null,
      server: { ...stale, error: 'run desk2/launcher/restart.ps1' },
      ...idle,
    })
    expect(row?.error).toBe('run desk2/launcher/restart.ps1')
    expect(row?.clickable).toBe(true)
    expect(row?.steps).toEqual(['restart'])
  })

  test('an apply error shows in the row too', () => {
    const row = footerUpdate({ release: waiting(), server: null, applying: false, applyError: 'disk full' })
    expect(row?.error).toBe('disk full')
    expect(row?.clickable).toBe(true)
  })

  test('while restarting or applying the row is busy and not a button', () => {
    expect(footerUpdate({ release: null, server: { ...stale, restarting: true }, ...idle })).toEqual({
      label: 'Restarting…',
      steps: [],
      clickable: false,
      busy: true,
      error: null,
    })
    expect(footerUpdate({ release: waiting(), server: null, applying: true, applyError: null })).toEqual({
      label: 'Updating…',
      steps: [],
      clickable: false,
      busy: true,
      error: null,
    })
  })
})

describe('the row click', () => {
  test('runs its steps in order and stops when the apply fails', async () => {
    const order: string[] = []
    await runUpdateSteps(['apply', 'restart'], {
      apply: async () => (order.push('apply'), true),
      restartIfStale: async () => void order.push('restart'),
    })
    expect(order).toEqual(['apply', 'restart'])

    const failed: string[] = []
    await runUpdateSteps(['apply', 'restart'], {
      apply: async () => (failed.push('apply'), false),
      restartIfStale: async () => void failed.push('restart'),
    })
    expect(failed).toEqual(['apply'])
  })
})

describe('the row click with a server that never answers', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    updateClicking.value = false
  })

  test('the row says Restarting at once, and a second click does nothing', async () => {
    globalThis.fetch = ((_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))))) as typeof fetch
    const deps = {
      remember: rememberForUpdate,
      apply: async () => true,
      restartIfStale: async () => {
        await checkServerUpdate()
        if (updateOffer.value?.restartable) await restartServer()
      },
    }
    const first = clickUpdate(['apply', 'restart'], deps)
    expect(updateClicking.value).toBe(true)
    expect(footerUpdate({ release: waiting({ latestVersion: '0.33.1' }), server: null, ...idle, clicking: updateClicking.value })).toEqual({
      label: 'Restarting…',
      steps: [],
      clickable: false,
      busy: true,
      error: null,
    })
    let second = 0
    await clickUpdate(['restart'], { ...deps, remember: async () => void second++, restartIfStale: async () => void second++ })
    expect(second).toBe(0)
    void first
  })
})
