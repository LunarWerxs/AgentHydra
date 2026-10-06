import { describe, expect, test } from 'bun:test'
import type { ConnectorView, RepoYetiGitState } from '@shared/connectors'
import { barItems, commitText, gitStepText, installItem, primaryItem, undoLine, yetiRuns } from '@/components/composer/repoyeti-bar'

const view = (o: Partial<ConnectorView>): ConnectorView => ({
  id: 'repoyeti', name: 'RepoYeti', blurb: 'b', homepage: 'https://example.com', installable: true, pane: true,
  state: 'running', url: 'http://127.0.0.1:7171', version: '1.3.0', enabled: true, givesChats: true, checkedAt: 0, ...o
})
const state = (o: Partial<RepoYetiGitState> = {}): RepoYetiGitState => ({
  repoId: 'r', branch: 'main', defaultBranch: 'main', branches: ['main', 'dev'], remote: { owner: 'example-owner', repo: 'x' }, undo: 'commit: add b', redo: null, ...o
})
const clean = { branch: 'main', ahead: 0, behind: 0, changed: 0 }
const on = (keys: ReturnType<typeof barItems>) => Object.fromEntries(keys.map((i) => [i.key, i.enabled]))

describe('the bar leads with the next step the repo waits for', () => {
  test('uncommitted work first, then unpushed commits, then upstream commits, else Create PR', () => {
    expect(primaryItem({ ...clean, changed: 3, ahead: 1 })).toEqual({ key: 'commit', label: 'Commit' })
    expect(primaryItem({ ...clean, ahead: 2, behind: 1 })).toEqual({ key: 'push', label: 'Push ↑2' })
    expect(primaryItem({ ...clean, behind: 4 })).toEqual({ key: 'pull', label: 'Pull ↓4' })
    expect(primaryItem(clean)).toEqual({ key: 'create-pr', label: 'Create PR' })
  })
})

describe('which menu items are on', () => {
  test('a clean, synced repo offers only what still makes sense', () => {
    expect(on(barItems(clean, state(), true))).toEqual({
      commit: false, push: false, pull: false, 'create-pr': true, 'new-branch': true, undo: true, redo: false, 'undo-chat': true, open: true
    })
  })
  test('changes, ahead and behind turn Commit, Push and Pull on, with their counts', () => {
    const items = barItems({ branch: 'dev', ahead: 2, behind: 3, changed: 5 }, state(), true)
    expect(on(items)).toMatchObject({ commit: true, push: true, pull: true })
    expect(items.map((i) => i.hint).slice(0, 3)).toEqual(['5 files', '↑2', '↓3'])
  })
  test('Create PR needs a GitHub origin; undo needs RepoYeti to say it can; this chat undo needs a chat', () => {
    expect(barItems(clean, state({ remote: null }), true).find((i) => i.key === 'create-pr')).toMatchObject({ enabled: false, hint: 'origin is not on GitHub' })
    expect(barItems(clean, state({ undo: null, undoWhy: 'that commit is already pushed' }), false).filter((i) => i.key === 'undo' || i.key === 'undo-chat')).toMatchObject([
      { key: 'undo', enabled: false, hint: 'that commit is already pushed' },
      { key: 'undo-chat', enabled: false }
    ])
    expect(on(barItems(clean, null, true))).toMatchObject({ 'create-pr': false, undo: false, redo: false })
  })
  test('on the default branch Create PR says it will use a new branch', () => {
    expect(barItems(clean, state(), true).find((i) => i.key === 'create-pr')?.hint).toBe('on a new branch')
    expect(barItems({ ...clean, branch: 'dev' }, state(), true).find((i) => i.key === 'create-pr')?.hint).toBeUndefined()
  })
})

describe('without RepoYeti running', () => {
  test('one small item gets it going, by what the connector says', () => {
    expect(yetiRuns(view({}))).toBe(true)
    expect(installItem(view({}))).toBeNull()
    expect(installItem(null)).toBeNull()
    expect(installItem(view({ state: 'absent' }))).toEqual({ action: 'install', label: 'Install RepoYeti', enabled: true })
    expect(installItem(view({ state: 'absent', installable: false }))).toMatchObject({ action: null, enabled: false })
    expect(installItem(view({ state: 'installed' }))).toEqual({ action: 'start', label: 'Start RepoYeti', enabled: true })
    expect(installItem(view({ state: 'starting' }))).toMatchObject({ action: null, enabled: false })
    expect(installItem(view({ state: 'failed' }))?.action).toBe('install')
  })
})

describe('texts', () => {
  test('the commit box keeps what was typed over the draft; confirm lines', () => {
    expect(commitText('Add b', '')).toBe('Add b')
    expect(commitText('Add b', 'my words')).toBe('my words')
    expect(commitText(null, '  ')).toBe('')
    expect(gitStepText('Undo', 'commit: add b')).toBe('Undo: commit: add b')
    expect(gitStepText('Redo', null)).toBe('Nothing to redo')
    expect(undoLine({ path: 'src/a.ts', added: 4, removed: 1 })).toBe('src/a.ts  +4 −1')
  })
})
