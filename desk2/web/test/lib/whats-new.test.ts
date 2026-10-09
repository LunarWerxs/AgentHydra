import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ChangelogSection } from '@shared/changelog'
import { checkWhatsNew, dismissWhatsNew, isNewerVersion, markerFor, readMarker, rememberForUpdate, whatsNew, whatsNewSince } from '../../src/lib/whats-new'

const entry = (headline: string) => ({ headline, detail: '' })

function sections(unreleased: string[]): ChangelogSection[] {
  return [
    { version: null, date: null, entries: unreleased.map(entry) },
    { version: '2.0.4', date: '2026-10-06', entries: [entry('Row restarts onto an update')] },
    { version: '2.0.3', date: '2026-10-01', entries: [entry('Plain bullet')] },
  ]
}

const NOW = Date.UTC(2026, 9, 9, 12)

describe('isNewerVersion', () => {
  test('compares major, minor and patch numerically', () => {
    expect(isNewerVersion('2.0.4', '2.0.3')).toBe(true)
    expect(isNewerVersion('2.1.0', '2.0.9')).toBe(true)
    expect(isNewerVersion('10.0.0', '9.9.9')).toBe(true)
    expect(isNewerVersion('2.0.3', '2.0.4')).toBe(false)
    expect(isNewerVersion('2.0.3', '2.0.3')).toBe(false)
  })

  test('never calls a version that does not parse newer', () => {
    expect(isNewerVersion('next', '2.0.3')).toBe(false)
    expect(isNewerVersion('2.0.4', 'unknown')).toBe(false)
  })
})

describe('whatsNewSince', () => {
  test('shows the newer release and the new Unreleased entries after an update', () => {
    const before = sections(['Chats load faster'])
    const marker = markerFor('2.0.3', before, NOW)
    const after = sections(['Chats load faster', 'Dialog shows the changes'])
    const result = whatsNewSince(marker, '2.0.4', after, NOW)
    expect(result?.updated).toBe(true)
    expect(result?.groups.map((g) => [g.version, g.entries.map((e) => e.headline)])).toEqual([
      [null, ['Dialog shows the changes']],
      ['2.0.4', ['Row restarts onto an update']],
    ])
    expect(result?.count).toBe(2)
  })

  test('shows only new Unreleased entries when the version did not change', () => {
    const marker = markerFor('2.0.4', sections(['Chats load faster']), NOW)
    const result = whatsNewSince(marker, '2.0.4', sections(['Chats load faster', 'New thing']), NOW)
    expect(result?.updated).toBe(false)
    expect(result?.groups).toEqual([{ version: null, date: null, entries: [entry('New thing')] }])
  })

  test('answers nothing when nothing is new', () => {
    const marker = markerFor('2.0.4', sections(['Chats load faster']), NOW)
    expect(whatsNewSince(marker, '2.0.4', sections(['Chats load faster']), NOW)).toBeNull()
  })

  test('answers nothing for a marker older than two hours', () => {
    const marker = markerFor('2.0.3', sections(['Chats load faster']), NOW - 3 * 60 * 60_000)
    expect(whatsNewSince(marker, '2.0.4', sections(['Chats load faster', 'New thing']), NOW)).toBeNull()
  })

  test('with a version-only marker shows the newer releases and every Unreleased entry', () => {
    const marker = markerFor('2.0.3', null, NOW)
    const result = whatsNewSince(marker, '2.0.4', sections(['Anything', 'Else']), NOW)
    expect(result?.groups.map((g) => [g.version, g.entries.map((e) => e.headline)])).toEqual([
      [null, ['Anything', 'Else']],
      ['2.0.4', ['Row restarts onto an update']],
    ])
    expect(result?.count).toBe(3)
  })
})

describe('markerFor', () => {
  test('headlines null on the same version shows every Unreleased entry', () => {
    const marker = markerFor('2.0.4', null, NOW)
    const result = whatsNewSince(marker, '2.0.4', sections(['Chats load faster', 'Dialog shows the changes']), NOW)
    expect(result?.updated).toBe(false)
    expect(result?.groups.map((g) => [g.version, g.entries.map((e) => e.headline)])).toEqual([
      [null, ['Chats load faster', 'Dialog shows the changes']],
    ])
  })

  test('keeps the Unreleased headlines and the running version only', () => {
    const marker = markerFor('2.0.4', sections(['Chats load faster']), NOW)
    expect(marker).toEqual({ version: '2.0.4', headlines: ['Chats load faster', 'Row restarts onto an update'], at: NOW, startedAt: null })
  })

  test('is version-only when the changelog could not be read', () => {
    expect(markerFor('2.0.4', null, NOW)).toEqual({ version: '2.0.4', headlines: null, at: NOW, startedAt: null })
  })
})

describe('the update click and the restarted copy', () => {
  const realFetch = globalThis.fetch
  const g = globalThis as { localStorage?: Storage }
  let kept: Map<string, string>

  beforeEach(() => {
    kept = new Map()
    g.localStorage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    } as unknown as Storage
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    delete g.localStorage
    whatsNew.value = null
  })

  const serving = (version: string | null, sections: ChangelogSection[] | null, startedAt = 100) => {
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(url === '/api/health' ? { version, startedAt } : { sections }), { status: 200 })) as typeof fetch
  }

  const silent = () => {
    globalThis.fetch = ((_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))))) as typeof fetch
  }

  test('a click before anything was read still writes a version-only marker from the version kept', async () => {
    kept.set('hydra-desk.whatsNew.seenVersion', '2.0.3')
    silent()
    const click = rememberForUpdate()
    expect(readMarker()).toEqual({ version: '2.0.3', headlines: null, at: expect.any(Number), startedAt: null })
    await click
  })

  test('a click with a server that never answers writes the marker at once, from what was read', async () => {
    serving('2.0.3', sections(['Chats load faster']))
    await checkWhatsNew()
    silent()
    const click = rememberForUpdate()
    expect(readMarker()).toEqual({ version: '2.0.3', headlines: ['Chats load faster', 'Plain bullet'], at: expect.any(Number), startedAt: 100 })
    await click
    expect(readMarker()?.version).toBe('2.0.3')
  })

  test('a restarted copy shows What\'s new after a click the slow server never answered', async () => {
    serving('2.0.3', sections(['Chats load faster']))
    await checkWhatsNew()
    silent()
    await rememberForUpdate()
    serving('2.0.4', sections(['Chats load faster', 'Dialog shows the changes']), 200)
    await checkWhatsNew()
    expect(whatsNew.value?.updated).toBe(true)
    expect(whatsNew.value?.groups.map((g) => [g.version, g.entries.map((e) => e.headline)])).toEqual([
      [null, ['Dialog shows the changes']],
      ['2.0.4', ['Row restarts onto an update']],
    ])
  })

  test('nothing shows before the restart: the server that was clicked still answering keeps the marker and no pop-up', async () => {
    serving('2.0.3', sections(['Chats load faster']))
    await checkWhatsNew()
    silent()
    await rememberForUpdate()
    serving('2.0.3', sections(['Chats load faster', 'Dialog shows the changes']))
    await checkWhatsNew()
    expect(whatsNew.value).toBeNull()
    expect(readMarker()?.version).toBe('2.0.3')
  })

  test('the restarted server shows What\'s new once, and a reload after that shows nothing', async () => {
    serving('2.0.3', sections(['Chats load faster']))
    await checkWhatsNew()
    silent()
    await rememberForUpdate()
    serving('2.0.3', sections(['Chats load faster', 'Dialog shows the changes']), 200)
    await checkWhatsNew()
    expect(whatsNew.value?.count).toBe(2)
    dismissWhatsNew()
    await checkWhatsNew()
    expect(whatsNew.value).toBeNull()
    expect(readMarker()).toBeNull()
  })

  test('a restart onto the same version with nothing new shows nothing and forgets the marker', async () => {
    serving('2.0.4', sections(['Chats load faster']))
    await checkWhatsNew()
    silent()
    await rememberForUpdate()
    serving('2.0.4', sections(['Chats load faster']), 200)
    await checkWhatsNew()
    expect(whatsNew.value).toBeNull()
    expect(readMarker()).toBeNull()
  })
})
