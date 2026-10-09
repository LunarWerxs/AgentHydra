import { describe, expect, test } from 'bun:test'
import {
  bashExit,
  DEFAULT_BROWSER,
  formatElapsed,
  isBrowserCall,
  isOwnChromeCall,
  keyArgument,
  ownChromeAction,
  parseBrowserCall,
  parseCliMayte,
  parseMcpName,
  shortPath,
  toolFamily,
  toolLabel,
  truncateText,
} from '../../src/components/transcript/lib/tools'

const CWD = 'C:\\Users\\me\\proj'

describe('keyArgument', () => {
  test('Bash shows the first line of the command', () => {
    expect(keyArgument('Bash', { command: 'bun test' })).toBe('bun test')
    expect(keyArgument('Bash', { command: 'cd web\nbun run build' })).toBe('cd web …')
  })

  test('file tools show the path relative to the chat folder', () => {
    expect(keyArgument('Edit', { file_path: 'C:\\Users\\me\\proj\\src\\a.ts' }, CWD)).toBe('src/a.ts')
    expect(keyArgument('Write', { file_path: 'D:/other/b.ts' }, CWD)).toBe('D:/other/b.ts')
  })

  test('Read adds its line range', () => {
    expect(keyArgument('Read', { file_path: 'C:/Users/me/proj/a.ts', offset: 10, limit: 50 }, CWD)).toBe('a.ts · lines 10-59')
    expect(keyArgument('Read', { file_path: 'a.ts', limit: 20 })).toBe('a.ts · lines 1-20')
  })

  test('search and web tools show pattern, URL or query', () => {
    expect(keyArgument('Grep', { pattern: 'foo\\(', path: 'C:/Users/me/proj/src' }, CWD)).toBe('foo\\( · src')
    expect(keyArgument('Glob', { pattern: '**/*.vue' })).toBe('**/*.vue')
    expect(keyArgument('WebFetch', { url: 'https://example.com/x', prompt: 'p' })).toBe('https://example.com/x')
    expect(keyArgument('WebSearch', { query: 'shiki bundles' })).toBe('shiki bundles')
  })

  test('TodoWrite counts done items; Agent shows description and type', () => {
    expect(
      keyArgument('TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }, { status: 'in_progress' }] }),
    ).toBe('1/3 done')
    expect(keyArgument('Agent', { description: 'Find X', prompt: '…', subagent_type: 'Explore' })).toBe('Find X · Explore')
    expect(keyArgument('Task', { description: 'Find X', subagent_type: 'general-purpose' })).toBe('Find X')
  })

  test('MCP tools pick a telling argument; CliMayte counts tasks', () => {
    expect(keyArgument('mcp__x__y', { limit: 3, query: 'hello' })).toBe('hello')
    expect(keyArgument('mcp__x__y', { foo: 'bar' })).toBe('bar')
    expect(keyArgument('mcp__x__y', { n: 1 })).toBe('')
    expect(keyArgument('mcp__agenthydra__climayte_run', { tasks: [{}, {}] })).toBe('2 tasks')
  })

  test('long arguments are cut with an ellipsis', () => {
    const arg = keyArgument('Bash', { command: 'x'.repeat(500) })
    expect(arg.length).toBe(160)
    expect(arg.endsWith('…')).toBe(true)
  })
})

describe('names and families', () => {
  test('mcp names split into server and tool', () => {
    expect(parseMcpName('mcp__agenthydra__climayte_run')).toEqual({ server: 'agenthydra', tool: 'climayte_run' })
    expect(parseMcpName('Bash')).toBeNull()
    expect(toolLabel('mcp__connections__connections_execute')).toBe('connections · connections_execute')
  })

  test('families route rows to their layout', () => {
    expect(toolFamily('MultiEdit')).toBe('edit')
    expect(toolFamily('Task')).toBe('agent')
    expect(toolFamily('mcp__agenthydra__climayte_manage')).toBe('climayte')
    expect(toolFamily('mcp__agenthydra__sessions_list')).toBe('mcp')
    expect(toolFamily('SomethingNew')).toBe('other')
  })

  test('shortPath only strips a real folder prefix', () => {
    expect(shortPath('C:/a/bc/d.ts', 'C:/a/b')).toBe('C:/a/bc/d.ts')
    expect(shortPath('c:/A/b/d.ts', 'C:/a/b/')).toBe('d.ts')
  })
})

describe('bashExit', () => {
  test('reads the exit code Claude Code reports', () => {
    expect(bashExit('error', 'Exit code 2\nboom')).toEqual({ label: 'exit 2', ok: false })
    expect(bashExit('done', 'all good')).toEqual({ label: 'exit 0', ok: true })
    expect(bashExit('error', 'killed')).toEqual({ label: 'failed', ok: false })
    expect(bashExit('running', undefined).ok).toBeNull()
    expect(bashExit('denied', undefined).label).toBe('denied')
  })
})

describe('truncateText', () => {
  test('keeps short text whole', () => {
    expect(truncateText('a\nb', 30)).toEqual({ shown: 'a\nb', truncated: false, totalLines: 2, hiddenLines: 0 })
  })

  test('cuts by lines and by characters', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const t = truncateText(text, 10)
    expect(t.truncated).toBe(true)
    expect(t.shown.split('\n')).toHaveLength(10)
    expect(t.hiddenLines).toBe(90)
    expect(truncateText('x'.repeat(10_000), 30, 100).shown).toHaveLength(100)
  })
})

describe('parseCliMayte', () => {
  test('tasks from the input, worker ids from a JSON result', () => {
    const r = parseCliMayte(
      'mcp__agenthydra__climayte_run',
      { tasks: [{ title: 'Build it', cwd: 'C:/p', kind: 'code' }, { prompt: 'Check the thing\nmore' }] },
      JSON.stringify({ workers: [{ id: 'w-123456' }, { id: 'w-abcdef' }] }),
    )
    expect(r.action).toBe('run')
    expect(r.tasks).toEqual([
      { title: 'Build it', cwd: 'C:/p', kind: 'code' },
      { title: 'Check the thing …', cwd: undefined, kind: undefined },
    ])
    expect(r.workerIds).toEqual(['w-123456', 'w-abcdef'])
  })

  test('worker ids from plain text, and the id argument of status calls', () => {
    expect(parseCliMayte('mcp__agenthydra__climayte_run', {}, 'Started worker id: w-35125796').workerIds).toEqual(['w-35125796'])
    expect(parseCliMayte('mcp__agenthydra__climayte_status', { id: 'w-1a2b3c' }).workerIds).toEqual(['w-1a2b3c'])
  })
})

describe('formatElapsed', () => {
  test('ms, s, m ss, h mm', () => {
    expect(formatElapsed(820)).toBe('820ms')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
    expect(formatElapsed(3_780_000)).toBe('1h 03m')
    expect(formatElapsed(-5)).toBe('0ms')
  })
})

describe('browser cards: direct browser MCP calls', () => {
  test('a direct navigate is a browser card with its url and profile in the input', () => {
    const name = 'mcp__browser__browser_navigate'
    const input = { profile: 'example-stores', url: 'https://shop.example.test/cart' }
    expect(isBrowserCall(name, input)).toBe(true)
    expect(toolFamily(name, input)).toBe('browser')
    expect(parseBrowserCall(name, input)).toEqual({ verb: 'Opened', url: 'https://shop.example.test/cart', profile: 'example-stores' })
  })

  test('a Connections browser call still reads its nested params', () => {
    const name = 'mcp__connections__connections_execute'
    const input = { local: true, tool_name: 'browser_navigate', params: { profile: 'example-stores', url: 'https://shop.example.test/cart' } }
    expect(isBrowserCall(name, input)).toBe(true)
    expect(parseBrowserCall(name, input)).toEqual({ verb: 'Opened', url: 'https://shop.example.test/cart', profile: 'example-stores' })
  })

  test('a direct browser_live action is the person\'s own Chrome, named by its verb', () => {
    const name = 'mcp__browser__browser_live'
    const input = { action: 'click', name: 'Continue' }
    expect(isOwnChromeCall(name, input)).toBe(true)
    expect(ownChromeAction(name, input)).toBe("Clicked 'Continue'")
    expect(parseBrowserCall(name, input).verb).toBe('Clicked')
    expect(parseBrowserCall(name, input).profile).toBe(DEFAULT_BROWSER)
  })

  test('another MCP server\'s browser_* tools are not browser cards', () => {
    const input = { url: 'https://shop.example.test/cart' }
    expect(isBrowserCall('mcp__playwright__browser_navigate', input)).toBe(false)
    expect(toolFamily('mcp__playwright__browser_navigate', input)).toBe('mcp')
  })
})
