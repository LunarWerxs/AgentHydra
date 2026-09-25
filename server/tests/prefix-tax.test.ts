// Pins the prefix-tax meter: how a captured first request is split, which capture counts as the
// prefix, that the sink answers both wire protocols so a harness gets as far as its first request,
// and that a probe can only ever reach the loopback sink.
import { expect, test } from 'bun:test'
import {
  analyzeCapture,
  claudeProbeArgs,
  codexProbeArgs,
  pickPrefix,
  probeEnv,
  startPrefixSink,
} from '../src/prefix-tax'

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')

const readTool = { name: 'Read', description: 'read a file', input_schema: { type: 'object' } }
const bigMcp = {
  name: 'mcp__fleet__list_usage',
  description: 'x'.repeat(900),
  input_schema: { type: 'object', properties: { a: { type: 'string' } } },
}
const smallMcp = { name: 'mcp__notes__search', description: 'find', input_schema: {} }

test('an anthropic capture is split into system, built-in and per-server MCP schema bytes', () => {
  const tax = analyzeCapture('anthropic-messages', {
    model: 'm',
    system: [
      { type: 'text', text: 'abc' },
      { type: 'text', text: 'de' },
    ],
    messages: [{ role: 'user', content: 'DONE' }],
    tools: [readTool, bigMcp, smallMcp],
  })
  expect(tax).not.toBeNull()
  expect(tax?.systemBytes).toBe(5)
  expect(tax?.tools).toBe(3)
  expect(tax?.mcpTools).toBe(2)
  expect(tax?.toolBytes).toBe(bytes(readTool) + bytes(bigMcp) + bytes(smallMcp))
  expect(tax?.mcpToolBytes).toBe(bytes(bigMcp) + bytes(smallMcp))
  // Heaviest server first, so the tile names the one to trim.
  expect(tax?.byServer.map((s) => s.server)).toEqual(['fleet', 'notes'])
  expect(tax?.heaviest[0]?.name).toBe('mcp__fleet__list_usage')
  expect(tax?.heaviest.find((h) => h.name === 'Read')?.mcpServer).toBeNull()
})

test('a responses capture counts developer input as prefix and function tools by name', () => {
  const dev = { role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }
  const user = { role: 'user', content: [{ type: 'input_text', text: 'DONE' }] }
  const tax = analyzeCapture('openai-responses', {
    instructions: 'hello',
    input: [dev, user],
    tools: [
      { type: 'function', name: 'shell', parameters: {} },
      { type: 'function', name: 'mcp__fleet__list_usage', parameters: {} },
      { type: 'web_search' },
    ],
  })
  expect(tax?.systemBytes).toBe(5 + bytes(dev))
  expect(tax?.messageBytes).toBe(bytes(user))
  expect(tax?.tools).toBe(3)
  expect(tax?.mcpTools).toBe(1)
  expect(tax?.heaviest.map((h) => h.name)).toContain('web_search')
})

test('a body that is not a model request is not a capture', () => {
  expect(analyzeCapture('anthropic-messages', { hello: 1 })).toBeNull()
  expect(analyzeCapture('openai-responses', null)).toBeNull()
})

test('the prefix is the capture with the most tools, not the first one sent', () => {
  const preflight = analyzeCapture('anthropic-messages', {
    system: 'x'.repeat(5000),
    messages: [{ role: 'user', content: 'quota' }],
  })
  const real = analyzeCapture('anthropic-messages', {
    system: 'x',
    messages: [{ role: 'user', content: 'DONE' }],
    tools: [readTool, smallMcp],
  })
  expect(pickPrefix([preflight, null, real])).toBe(real)
  expect(pickPrefix([])).toBeNull()
})

test('the sink answers both protocols with DONE and records only the body', async () => {
  const sink = startPrefixSink()
  try {
    expect(sink.url).toStartWith('http://127.0.0.1:')
    const a = await fetch(`${sink.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'not-kept' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [readTool] }),
    })
    const aText = await a.text()
    expect(a.headers.get('content-type')).toContain('text/event-stream')
    expect(aText).toContain('"text":"DONE"')
    expect(aText).toContain('event: message_stop')

    const r = await fetch(`${sink.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, input: [], tools: [] }),
    })
    const rText = await r.text()
    expect(rText).toContain('"text":"DONE"')
    expect(rText).toContain('event: response.completed')

    expect(sink.captures.map((c) => c.protocol)).toEqual(['anthropic-messages', 'openai-responses'])
    expect(JSON.stringify(sink.captures)).not.toContain('not-kept')
  } finally {
    sink.stop()
  }
})

test('the probe env drops proxies and every ambient credential before pointing at the sink', () => {
  const env = probeEnv(
    {
      HTTPS_PROXY: 'http://proxy:8080',
      http_proxy: 'http://proxy:8080',
      CLAUDE_CODE_OAUTH_TOKEN: 'real',
      ANTHROPIC_BASE_URL: 'https://elsewhere',
      OPENAI_API_KEY: 'real',
      CLAUDE_CONFIG_DIR: '/ambient',
      PATH: '/bin',
    },
    { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
  )
  expect(env.HTTPS_PROXY).toBeUndefined()
  expect(env.http_proxy).toBeUndefined()
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  expect(env.OPENAI_API_KEY).toBeUndefined()
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1')
  expect(env.NO_PROXY).toContain('127.0.0.1')
  expect(env.PATH).toBe('/bin')
})

test('the claude probe persists no session and outranks a home settings base URL', () => {
  const argv = claudeProbeArgs('claude', 'http://127.0.0.1:9')
  // Without this flag every measurement files a stub chat into the account's list.
  expect(argv).toContain('--no-session-persistence')
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] as string)
  expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9')
  expect(settings.env.HTTPS_PROXY).toBe('')
})

test('the codex probe uses a provider of its own aimed at the sink', () => {
  const argv = codexProbeArgs('codex', 'http://127.0.0.1:9')
  expect(argv).toContain('model_provider="prefix_tax_sink"')
  const provider = argv.find((a) => a.startsWith('model_providers.prefix_tax_sink='))
  expect(provider).toContain('base_url = "http://127.0.0.1:9/v1"')
  expect(provider).toContain('wire_api = "responses"')
})
