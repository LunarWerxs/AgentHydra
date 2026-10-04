// The ⋯ menu's all / none / toggle / label rules, kept as plain functions so they are tested here
// rather than through a rendered menu.
import { expect, test } from 'bun:test'
import {
  isAllSelected,
  parseStoredSelection,
  SOURCE_VALUES,
  scopeParam,
  summarizeSelection,
  toggleValue,
} from './session-scopes'

const text = {
  all: 'All',
  none: 'None',
  label: (v: string) => v.toUpperCase(),
  more: (first: string, n: number) => `${first} +${n}`,
}

test('trigger label: All, None, one name, first name plus count', () => {
  const u = ['claude', 'codex', 'opencode', 'hermes'] as const
  expect(summarizeSelection([...u], u, text)).toBe('All')
  expect(summarizeSelection([], u, text)).toBe('None')
  expect(summarizeSelection(['codex'], u, text)).toBe('CODEX')
  // First in menu order, not tick order.
  expect(summarizeSelection(['opencode', 'claude', 'codex'], u, text)).toBe('CLAUDE +2')
})

test('toggling keeps menu order; all ticked sends no param, none sends none', () => {
  let sel = toggleValue([...SOURCE_VALUES], SOURCE_VALUES, 'codex')
  expect(sel).not.toContain('codex')
  expect(scopeParam(sel, SOURCE_VALUES)).toBe('claude,opencode,hermes,dsh,zswarm')
  sel = toggleValue(sel, SOURCE_VALUES, 'codex')
  expect(isAllSelected(sel, SOURCE_VALUES)).toBe(true)
  expect(scopeParam(sel, SOURCE_VALUES)).toBeUndefined()
  expect(scopeParam([], SOURCE_VALUES)).toBe('none')
})

test('a stored value that does not validate falls back to the default', () => {
  expect(parseStoredSelection(['codex', 'claude'], SOURCE_VALUES)).toEqual(['claude', 'codex'])
  expect(parseStoredSelection('claude', SOURCE_VALUES)).toBeUndefined()
  expect(parseStoredSelection(['claude', 'bogus'], SOURCE_VALUES)).toBeUndefined()
  expect(parseStoredSelection([], SOURCE_VALUES)).toEqual([])
})
