import { describe, expect, test } from 'bun:test'
import type { ConnectorView } from '../../../shared/connectors'
import { pollDelay, repoYetiOf, repoYetiView, showRepoYetiButton } from '../../src/components/connectors/logic'

const view = (over: Partial<ConnectorView>): ConnectorView => ({
  id: 'repoyeti', name: 'RepoYeti', blurb: '', homepage: 'https://example.com', installable: true, pane: true,
  state: 'running', url: 'http://127.0.0.1:7171', version: null, enabled: true, givesChats: true, checkedAt: 0, ...over
})

describe('repoYetiView', () => {
  test('running with an address is framed at that address', () => {
    expect(repoYetiView(view({}))).toEqual({ kind: 'frame', url: 'http://127.0.0.1:7171' })
  })
  test('installed offers Start, absent offers Install', () => {
    expect(repoYetiView(view({ state: 'installed', url: null })).kind).toBe('start')
    expect(repoYetiView(view({ state: 'absent', url: null })).kind).toBe('install')
  })
  test('installing shows its progress line; failed shows why', () => {
    expect(repoYetiView(view({ state: 'installing', url: null, reason: 'Downloading 3 / 90 MB' }))).toEqual({ kind: 'busy', line: 'Downloading 3 / 90 MB' })
    expect(repoYetiView(view({ state: 'failed', url: null, reason: 'checksum' }))).toEqual({ kind: 'failed', reason: 'checksum' })
  })
  test('before the first answer it is loading', () => {
    expect(repoYetiView(null).kind).toBe('loading')
  })
})

describe('the title-bar button', () => {
  test('shows when enabled and not absent, never when off or absent', () => {
    expect(showRepoYetiButton(view({}))).toBe(true)
    expect(showRepoYetiButton(view({ state: 'installing', url: null }))).toBe(true)
    expect(showRepoYetiButton(view({ state: 'absent', url: null }))).toBe(false)
    expect(showRepoYetiButton(view({ enabled: false }))).toBe(false)
    expect(showRepoYetiButton(null)).toBe(false)
  })
})

test('repoYetiOf picks its entry out of the list; polling speeds up while Desk works', () => {
  expect(repoYetiOf([view({ id: 'devwebui' }), view({ version: '1' })])?.version).toBe('1')
  expect(repoYetiOf(null)).toBeNull()
  expect(pollDelay(view({ state: 'starting' }))).toBeLessThan(pollDelay(view({})))
})
