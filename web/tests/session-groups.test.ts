// web/tests/session-groups.test.ts - the project grouping behind the move dialogs
// (web/src/lib/session-groups.ts).
//
// Largest group first, ties by name, rows in arrival order, and the header is the FOLDER name the
// sessions list shows, never Claude's project-store slug - that slug is what the first live render
// of the dialog put on screen, and it is an identity, not a name.

import { expect, test } from 'bun:test'
import { groupByProject } from '../src/lib/session-groups'

const row = (project: string, cwd: string, title: string) => ({ project, cwd, title })

test('the header is the folder name, not the project-store slug', () => {
  const groups = groupByProject([
    row(
      'C--Users-jacob-Desktop-Project-Connections',
      'C:\\Users\\jacob\\Desktop\\Project\\Connections',
      'a',
    ),
    row(
      'C--Users-jacob-Desktop-Project-Agent-Hydra',
      'C:\\Users\\jacob\\Desktop\\Project\\Agent Hydra',
      'b',
    ),
  ])
  expect(groups.map((g) => g.project).sort()).toEqual(['Agent Hydra', 'Connections'])
})

test('groups by project, largest first', () => {
  const groups = groupByProject([
    row('Connections', 'C:/p/Connections', 'a'),
    row('AgentHydra', 'C:/p/AgentHydra', 'b'),
    row('Connections', 'C:/p/Connections', 'c'),
    row('Connections', 'C:/p/Connections', 'd'),
    row('AgentHydra', 'C:/p/AgentHydra', 'e'),
    row('TavernBag', 'C:/p/TavernBag', 'f'),
  ])
  expect(groups.map((g) => [g.project, g.sessions.length])).toEqual([
    ['Connections', 3],
    ['AgentHydra', 2],
    ['TavernBag', 1],
  ])
})

test('ties break by name, so the order is stable between renders', () => {
  const groups = groupByProject([
    row('slug-z', '/repos/Zeta', 'a'),
    row('slug-a', '/repos/Alpha', 'b'),
    row('slug-m', '/repos/Mid', 'c'),
  ])
  expect(groups.map((g) => g.project)).toEqual(['Alpha', 'Mid', 'Zeta'])
})

test('rows inside a group keep their arrival order', () => {
  const groups = groupByProject([
    row('P', '/p', 'first'),
    row('Q', '/q', 'x'),
    row('P', '/p', 'second'),
    row('P', '/p', 'third'),
  ])
  expect(groups[0]?.sessions.map((s) => s.title)).toEqual(['first', 'second', 'third'])
})

test('folder names come out clean: Windows or POSIX, trailing separator or not', () => {
  const groups = groupByProject([
    row('', 'C:\\Users\\me\\Desktop\\My Repo\\', 'a'),
    row('   ', '/home/me/other-repo', 'b'),
  ])
  expect(groups.map((g) => g.project).sort()).toEqual(['My Repo', 'other-repo'])
})

test('a session with no cwd falls back to the project slug, and with neither still gets a header', () => {
  expect(groupByProject([row('some-slug', '', 'a')])[0]?.project).toBe('some-slug')
  expect(groupByProject([row('', '', 'a')])[0]?.project).toBe('?')
})

test('empty input is an empty list', () => {
  expect(groupByProject([])).toEqual([])
})
