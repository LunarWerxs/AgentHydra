import { describe, expect, test } from 'bun:test'
import type { ConnectorView } from '../../../shared/connectors'
import { changesTabFor, parseChangesTab, pollDelay, repoYetiOf, repoYetiView, showChangesSwitch } from '../../src/components/connectors/logic'

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

describe("the Changes pane's switch", () => {
  test('shows while the connector is listed and on, even when RepoYeti is not installed (the pane offers Install)', () => {
    expect(showChangesSwitch(view({}))).toBe(true)
    expect(showChangesSwitch(view({ state: 'absent', url: null }))).toBe(true)
    expect(showChangesSwitch(view({ enabled: false }))).toBe(false)
    expect(showChangesSwitch(null)).toBe(false)
  })
  test('the remembered side is used only while the switch shows; disabled shows plain Changes', () => {
    expect(changesTabFor('repoyeti', view({}))).toBe('repoyeti')
    expect(changesTabFor('repoyeti', view({ enabled: false }))).toBe('changes')
    expect(changesTabFor('repoyeti', null)).toBe('changes')
    expect(changesTabFor('changes', view({}))).toBe('changes')
  })
  test('storage text that is not a known side reads as Changes', () => {
    expect(parseChangesTab('repoyeti')).toBe('repoyeti')
    expect(parseChangesTab('nonsense')).toBe('changes')
    expect(parseChangesTab(null)).toBe('changes')
  })
})

test('repoYetiOf picks its entry out of the list; polling speeds up while Desk works', () => {
  expect(repoYetiOf([view({ id: 'devwebui' }), view({ version: '1' })])?.version).toBe('1')
  expect(repoYetiOf(null)).toBeNull()
  expect(pollDelay(view({ state: 'starting' }))).toBeLessThan(pollDelay(view({})))
})
