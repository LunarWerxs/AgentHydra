import { describe, expect, test } from 'bun:test'
import type { ChangelogSection } from '@shared/changelog'
import { isNewerVersion, markerFor, whatsNewSince } from '../../src/lib/whats-new'

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

  test('with a version-only marker shows the newer releases and skips Unreleased', () => {
    const marker = markerFor('2.0.3', null, NOW)
    const result = whatsNewSince(marker, '2.0.4', sections(['Anything']), NOW)
    expect(result?.groups.map((g) => g.version)).toEqual(['2.0.4'])
  })
})

describe('markerFor', () => {
  test('keeps the Unreleased headlines and the running version only', () => {
    const marker = markerFor('2.0.4', sections(['Chats load faster']), NOW)
    expect(marker).toEqual({ version: '2.0.4', headlines: ['Chats load faster', 'Row restarts onto an update'], at: NOW })
  })

  test('is version-only when the changelog could not be read', () => {
    expect(markerFor('2.0.4', null, NOW)).toEqual({ version: '2.0.4', headlines: null, at: NOW })
  })
})
