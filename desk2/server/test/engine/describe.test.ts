import { describe, expect, test } from 'bun:test'
import { contextPct, describeToolActivity, titleFromPrompt } from '../../src/engine/describe'

describe('describeToolActivity', () => {
  const cwd = 'C:\\Users\\test\\desk'
  const cases: [string, Record<string, unknown>, string][] = [
    ['Bash', { command: 'bun test\nmore' }, 'Bash: bun test'],
    ['Edit', { file_path: 'C:\\Users\\test\\desk\\web\\src\\App.vue' }, 'Edit: web/src/App.vue'],
    ['Write', { file_path: 'D:/other/x.ts' }, 'Write: D:/other/x.ts'],
    ['Read', { file_path: 'C:/Users/test/desk/notes.txt' }, 'Read: notes.txt'],
    ['Grep', { pattern: 'foo' }, 'Searching'],
    ['Glob', { pattern: '**/*.ts' }, 'Searching'],
    ['WebFetch', { url: 'https://example.com/a/b', prompt: 'x' }, 'Fetching: example.com'],
    ['Agent', { description: 'Survey the repo', prompt: 'x' }, 'Agent: Survey the repo'],
    ['TodoWrite', { todos: [] }, 'Updating todos'],
    ['mcp__agenthydra__climayte_run', {}, 'agenthydra: climayte_run'],
    ['SomethingNew', {}, 'SomethingNew'],
    ['Bash', {}, 'Bash'],
  ]
  for (const [name, input, want] of cases) test(`${name} -> ${want}`, () => expect(describeToolActivity(name, input, cwd)).toBe(want))

  test('cut to 60 chars', () => {
    const line = describeToolActivity('Bash', { command: 'x'.repeat(200) })
    expect(line.length).toBe(60)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('titleFromPrompt', () => {
  test('first non-empty line', () => expect(titleFromPrompt('\n  Fix the build  \nthen more')).toBe('Fix the build'))
  test('at most 60 chars', () => expect(titleFromPrompt('a'.repeat(100)).length).toBe(60))
  test('empty prompt', () => expect(titleFromPrompt('   ')).toBe('New chat'))
})

describe('contextPct', () => {
  test('percentage wins', () => expect(contextPct({ percentage: 42.6, totalTokens: 1, maxTokens: 100 })).toBe(43))
  test('from tokens', () => expect(contextPct({ totalTokens: 50_000, maxTokens: 200_000 })).toBe(25))
  test('clamped', () => expect(contextPct({ percentage: 130 })).toBe(100))
  test('unknown', () => {
    expect(contextPct(null)).toBeNull()
    expect(contextPct({ totalTokens: 5, maxTokens: 0 })).toBeNull()
  })
})
