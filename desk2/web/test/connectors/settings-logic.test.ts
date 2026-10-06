import { describe, expect, test } from 'bun:test'
import type { ConnectorView } from '@shared/connectors'
import { note, pollDelay, rowButtons, stateLabel, stateTone, versionLabel } from '@/components/connectors/settings-logic'

const view = (o: Partial<ConnectorView>): ConnectorView => ({
  id: 'repoyeti', name: 'RepoYeti', blurb: 'b', homepage: 'https://example.com', installable: true, pane: false,
  state: 'absent', url: null, version: null, enabled: true, givesChats: false, checkedAt: 0, ...o
})

describe('connector row', () => {
  test('words and tones per state', () => {
    expect(stateLabel(view({ state: 'running' }))).toBe('Running')
    expect(stateLabel(view({ state: 'installed' }))).toBe('Installed, not running')
    expect(stateLabel(view({ state: 'absent' }))).toBe('Not installed')
    expect(stateLabel(view({ state: 'installing', reason: 'Downloading 1 / 2 MB' }))).toBe('Installing… Downloading 1 / 2 MB')
    expect(stateLabel(view({ state: 'starting' }))).toBe('Starting…')
    expect(stateLabel(view({ state: 'failed', reason: 'bad checksum' }))).toBe('Failed: bad checksum')
    expect(['running', 'installing', 'failed', 'absent'].map((s) => stateTone(view({ state: s as ConnectorView['state'] })))).toEqual(['ok', 'busy', 'bad', 'idle'])
  })

  test('buttons: Install for an installable absent or failed one, Start for an installed one, Open for a running pane', () => {
    expect(rowButtons(view({ state: 'absent' }))).toEqual({ install: true, start: false, open: false })
    expect(rowButtons(view({ state: 'failed' })).install).toBe(true)
    expect(rowButtons(view({ state: 'absent', installable: false })).install).toBe(false)
    expect(rowButtons(view({ state: 'installing' }))).toEqual({ install: false, start: false, open: false })
    expect(rowButtons(view({ state: 'installed' })).start).toBe(true)
    expect(rowButtons(view({ state: 'running', pane: true, url: 'http://127.0.0.1:1' })).open).toBe(true)
    expect(rowButtons(view({ state: 'running', pane: false, url: 'http://127.0.0.1:1' })).open).toBe(false)
  })

  test('version, note and poll speed', () => {
    expect(versionLabel(view({ version: '1.2.3' }))).toBe('v1.2.3')
    expect(versionLabel(view({ version: 'v1.2.3' }))).toBe('v1.2.3')
    expect(versionLabel(view({}))).toBeNull()
    expect(note(view({ state: 'absent', reason: 'the copy is missing' }))).toBe('the copy is missing')
    expect(note(view({ state: 'failed', reason: 'x' }))).toBeNull()
    expect(pollDelay([view({}), view({ state: 'starting' })])).toBe(3000)
    expect(pollDelay([view({}), view({ state: 'running' })])).toBe(15000)
  })
})
