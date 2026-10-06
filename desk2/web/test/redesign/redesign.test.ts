import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { groupRows, type ToolItem } from '../../src/components/transcript/lib/groups'
import { toolFamily } from '../../src/components/transcript/lib/tools'
import { canSendReply, composeRedesignReply, parseDesignOptions, redesignState } from '../../src/components/transcript/lib/redesign'

const OPT = 'mcp__desk_redesign__design_options'
const PICK = 'mcp__desk_redesign__design_pick'
const tool = (id: string, name: string, input: Record<string, unknown>, extra: Partial<ToolItem> = {}): ToolItem => ({
  id,
  ts: 1,
  kind: 'tool_use',
  name,
  input,
  status: 'done',
  startedAt: 1,
  ...extra,
})
const user = (id: string, text: string): TranscriptItem => ({ id, ts: 2, kind: 'user', text })
const result = (data: unknown) => ({ text: `The options are shown.\n${JSON.stringify(data)}`, isError: false })
const DONE = {
  run: 'run-1',
  options: [
    { option: 1, description: 'Calm and airy', image: 'C:/Users/me/design-options/run-1/option-1.png' },
    { option: 2, description: 'Dense dashboard', image: null },
  ],
}

describe('composeRedesignReply', () => {
  const base = { pick: null, notes: {}, more: false, text: '' }
  test('a pick with notes, sorted by option, blanks dropped, quotes softened, free text last', () => {
    expect(composeRedesignReply({ ...base, pick: 2, notes: { 2: ' tighter spacing ', 1: 'bigger "logo"', 3: '  ' }, text: 'Thanks.' })).toBe(
      `ReDesign: I pick option 2. Notes: option 1: "bigger 'logo'"; option 2: "tighter spacing". Thanks.`,
    )
  })
  test('a pick alone', () => {
    expect(composeRedesignReply({ ...base, pick: 3 })).toBe('ReDesign: I pick option 3.')
  })
  test('more options wins over a pick and keeps the free text', () => {
    expect(composeRedesignReply({ ...base, pick: 2, more: true, text: 'Try darker ones.' })).toBe('ReDesign: more options please. Try darker ones.')
  })
  test('free text alone', () => {
    expect(composeRedesignReply({ ...base, text: ' none of these ' })).toBe('ReDesign: none of these')
  })
  test('nothing to send until there is a pick, more, or words', () => {
    expect(canSendReply(base)).toBe(false)
    expect(canSendReply({ ...base, notes: { 1: 'x' } })).toBe(false)
    expect(canSendReply({ ...base, pick: 1 })).toBe(true)
    expect(canSendReply({ ...base, more: true })).toBe(true)
    expect(canSendReply({ ...base, text: 'hi' })).toBe(true)
  })
})

describe('tool to card mapping', () => {
  test('design_options is the redesign family under any server prefix; design_pick is not', () => {
    expect(toolFamily(OPT, { brief: 'x' })).toBe('redesign')
    expect(toolFamily('mcp__other__design_options')).toBe('redesign')
    expect(toolFamily(PICK, { run: 'r', option: 1 })).toBe('mcp')
    expect(toolFamily('mcp__x__design_options_extra')).toBe('mcp')
  })
  test('a design_options call stays out of the folded tools run', () => {
    const rows = groupRows([tool('a', 'Bash', { command: 'ls' }), tool('b', OPT, { brief: 'x' }), tool('c', 'Bash', { command: 'pwd' })])
    expect(rows.map((r) => r.kind)).toEqual(['tools', 'item', 'tools'])
  })
})

describe('parseDesignOptions', () => {
  test('a finished run: brief, mode, image urls through the Desk route', () => {
    const v = parseDesignOptions(tool('t', OPT, { brief: ' A pricing page ', ask_owner: true }, { result: result(DONE) }))
    expect(v).toMatchObject({ state: 'done', brief: 'A pricing page', askOwner: true, run: 'run-1' })
    expect(v.options[0]).toEqual({ n: 1, description: 'Calm and airy', src: '/api/redesign/image/run-1/option-1.png' })
    expect(v.options[1].src).toBeNull()
  })
  test('ask_owner is off unless exactly true', () => {
    expect(parseDesignOptions(tool('t', OPT, { brief: 'x', ask_owner: 'true' }, { result: result(DONE) })).askOwner).toBe(false)
  })
  test('running and error states', () => {
    expect(parseDesignOptions(tool('t', OPT, { brief: 'x' }, { status: 'running' })).state).toBe('running')
    const e = parseDesignOptions(tool('t', OPT, { brief: 'x' }, { status: 'error', result: { text: 'No key set', isError: true } }))
    expect(e).toMatchObject({ state: 'error', error: 'No key set' })
  })
})

describe('redesignState', () => {
  test('design_pick marks the run; the first ReDesign message after an ask call is its reply', () => {
    const items: TranscriptItem[] = [
      user('u0', 'ReDesign: unrelated, before any call'),
      tool('a', OPT, { brief: 'x', ask_owner: true }),
      user('u1', 'looks fine'),
      user('u2', 'ReDesign: I pick option 2.'),
      user('u3', 'ReDesign: a second message'),
      tool('b', PICK, { run: 'run-1', option: 2 }),
    ]
    const s = redesignState(items)
    expect(s.replies.get('a')).toBe('ReDesign: I pick option 2.')
    expect(s.replies.size).toBe(1)
    expect(s.picks.get('run-1')).toBe(2)
  })
  test('an AI-picks call never waits for a reply', () => {
    expect(redesignState([tool('a', OPT, { brief: 'x' }), user('u', 'ReDesign: hi')]).replies.size).toBe(0)
  })
})
