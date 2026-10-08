import { describe, expect, it } from 'bun:test'
import type { ProjectEntry, ProjectGit } from '@shared/protocol'
import { filterProjects, syncLabel } from '../../src/components/shell/projects'

const git = (over: Partial<ProjectGit>): ProjectGit => ({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, fetchedAt: null, ...over })

const project = (name: string, path: string): ProjectEntry => ({ path, name, group: null, icon: null, sources: ['chats'], git: null, lastCommitAt: null, lastChatAt: null })

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
