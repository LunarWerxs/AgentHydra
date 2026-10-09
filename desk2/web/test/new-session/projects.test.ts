import { describe, expect, it } from 'bun:test'
import type { ProjectEntry, ProjectGit } from '@shared/protocol'
import { filterProjects, projectActions, projectSourceGroups, shownProjects, syncLabel } from '../../src/components/shell/projects'

const git = (over: Partial<ProjectGit>): ProjectGit => ({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, fetchedAt: null, ...over })

const project = (name: string, path: string, over: Partial<ProjectEntry> = {}): ProjectEntry => ({ path, name, group: null, icon: null, sources: ['chats'], git: null, lastCommitAt: null, lastChatAt: null, openChats: 0, hidden: false, ...over })

describe('syncLabel', () => {
  it('says a clean, level checkout is up to date, and nothing for a folder that is no repo', () => {
    expect(syncLabel(git({}))).toBe('up to date')
    expect(syncLabel(null)).toBeNull()
  })

  it('lists behind, ahead and uncommitted counts in that order', () => {
    expect(syncLabel(git({ behind: 2 }))).toBe('2 behind')
    expect(syncLabel(git({ ahead: 1, dirty: 4 }))).toBe('1 ahead · 4 uncommitted')
    expect(syncLabel(git({ behind: 3, ahead: 1, dirty: 2 }))).toBe('3 behind · 1 ahead · 2 uncommitted')
  })
})

describe('filterProjects', () => {
  const list = [project('connections', 'C:/Users/me/Desktop/Project/connections'), project('Audio Lab', 'C:/Users/me/Desktop/audio-lab')]

  it('keeps the order and everything for an empty query', () => {
    expect(filterProjects(list, '  ')).toEqual(list)
  })

  it('matches the name or the path, ignoring case', () => {
    expect(filterProjects(list, 'AUDIO').map((p) => p.name)).toEqual(['Audio Lab'])
    expect(filterProjects(list, 'project/conn').map((p) => p.name)).toEqual(['connections'])
  })
})

describe('shownProjects', () => {
  const list = [project('visible', 'C:/a'), project('gone', 'C:/b', { hidden: true })]

  it('leaves hidden projects out unless the owner asked to see them', () => {
    expect(shownProjects(list, false).map((p) => p.name)).toEqual(['visible'])
    expect(shownProjects(list, true).map((p) => p.name)).toEqual(['visible', 'gone'])
  })
})

describe('projectSourceGroups', () => {
  const list = [
    project('both', 'C:/both', { sources: ['projecthydra', 'chats'] }),
    project('registry', 'C:/registry', { sources: ['projecthydra'] }),
    project('chatted', 'C:/chatted', { sources: ['chats'] }),
    project('hiddenChat', 'C:/hc', { sources: ['chats'], hidden: true }),
  ]

  it('files a project in both sources under Project Hydra only, and leaves hidden ones out', () => {
    const groups = projectSourceGroups(list)
    expect(groups.hydra.map((p) => p.name)).toEqual(['both', 'registry'])
    expect(groups.chats.map((p) => p.name)).toEqual(['chatted'])
  })
})

describe('projectActions', () => {
  it('offers Hide for a shown project and Unhide for a hidden one, after the same three actions', () => {
    const shown = projectActions(false)
    const hidden = projectActions(true)
    expect(shown.map((a) => a.action)).toEqual(['reveal', 'newChat', 'copy', 'hide'])
    expect(hidden.map((a) => a.action)).toEqual(['reveal', 'newChat', 'copy', 'unhide'])
    expect(hidden[3]?.label).toBe('Unhide')
  })
})
