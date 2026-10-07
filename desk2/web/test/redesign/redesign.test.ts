import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { groupRows, type ToolItem } from '../../src/components/transcript/lib/groups'
import { toolFamily } from '../../src/components/transcript/lib/tools'
import { canSendReply, composeRedesignReply, landedNames, optionLabel, parseDesignOptions, parseReplyChip, pickedOption, redesignSetup, redesignState, replyFor, RETRY_MESSAGE } from '../../src/components/transcript/lib/redesign'

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
    { option: 1, name: 'Card stack', description: 'Calm and airy', image: 'C:/Users/me/design-options/run-1/option-1.png' },
    { option: 2, description: 'Dense dashboard', image: null },
  ],
}

describe('composeRedesignReply', () => {
  const base = { pick: null, name: '', more: false, other: false, text: '' }
  test('a pick carries its number and name', () => {
    expect(composeRedesignReply({ ...base, pick: 2, name: 'Card stack' })).toBe('ReDesign: I pick option 2, Card stack.')
    expect(composeRedesignReply({ ...base, pick: 3 })).toBe('ReDesign: I pick option 3.')
  })
  test('more options and free text', () => {
    expect(composeRedesignReply({ ...base, more: true })).toBe('ReDesign: more options please.')
    expect(composeRedesignReply({ ...base, other: true, text: ' none of these ' })).toBe('ReDesign: none of these')
  })
  test('nothing to send until there is a pick, more, or words under Other', () => {
    expect(canSendReply(base)).toBe(false)
    expect(canSendReply({ ...base, pick: 1 })).toBe(true)
    expect(canSendReply({ ...base, more: true })).toBe(true)
    expect(canSendReply({ ...base, other: true })).toBe(false)
    expect(canSendReply({ ...base, other: true, text: '   ' })).toBe(false)
    expect(canSendReply({ ...base, other: true, text: 'hi' })).toBe(true)
    expect(canSendReply({ ...base, text: 'hi' })).toBe(false)
  })
})

describe('replyFor: the card choice state', () => {
  const send = (...a: Parameters<typeof replyFor>) => {
    const r = replyFor(...a)
    return canSendReply(r) ? composeRedesignReply(r) : null
  }
  test('nothing chosen: nothing to send, whatever was typed', () => {
    expect(send(null, '', 'stale words')).toBeNull()
  })
  test('an option sends its number and name; stale Other words are dropped', () => {
    expect(send(2, 'Minimal list', 'stale words')).toBe('ReDesign: I pick option 2, Minimal list.')
  })
  test('Other needs typed words, then sends just them', () => {
    expect(send('other', '', '  ')).toBeNull()
    expect(send('other', 'x', ' a warmer palette ')).toBe('ReDesign: a warmer palette')
  })
  test('More options is always sendable and carries nothing else', () => {
    expect(send('other', 'x', 'words', true)).toBe('ReDesign: more options please.')
  })
})

describe('pickedOption: which option the card counts as picked', () => {
  const chip = (t: string) => parseReplyChip(t)
  test('editable: the choice when it is an option number', () => {
    expect(pickedOption({ editable: true, choice: 3, aiPick: 1, sentChip: null })).toBe(3)
  })
  test('editable: Other or nothing is no pick, whatever the AI took', () => {
    expect(pickedOption({ editable: true, choice: 'other', aiPick: 1, sentChip: null })).toBeNull()
    expect(pickedOption({ editable: true, choice: null, aiPick: 1, sentChip: null })).toBeNull()
  })
  test('not editable: the AI pick, else the sent pick', () => {
    expect(pickedOption({ editable: false, choice: null, aiPick: 2, sentChip: null })).toBe(2)
    expect(pickedOption({ editable: false, choice: null, aiPick: null, sentChip: chip('ReDesign: I pick option 4, Cards.') })).toBe(4)
  })
  test('a sent More options or Other is no pick', () => {
    expect(pickedOption({ editable: false, choice: null, aiPick: null, sentChip: chip('ReDesign: more options please.') })).toBeNull()
    expect(pickedOption({ editable: false, choice: null, aiPick: null, sentChip: chip('ReDesign: warmer') })).toBeNull()
  })
})

describe('parseReplyChip: the transcript chip and the card footer', () => {
  test('more options', () => {
    const c = parseReplyChip('ReDesign: more options please.')
    expect(c?.label).toBe('More options')
    expect(c?.line(4)).toBe('Asked for 4 more designs')
  })
  test('a pick, with and without a name', () => {
    const c = parseReplyChip('ReDesign: I pick option 2, Card stack.')
    expect(c).toMatchObject({ kind: 'pick', n: 2, label: 'Picked Card stack' })
    expect(c?.line()).toBe('Picked: Card stack')
    expect(parseReplyChip('ReDesign: I pick option 3.')?.label).toBe('Picked option 3')
  })
  test('own words, the retry message, and a plain message', () => {
    expect(parseReplyChip('ReDesign: a warmer palette')).toMatchObject({ kind: 'other', label: 'a warmer palette' })
    expect(parseReplyChip(RETRY_MESSAGE)?.kind).toBe('retry')
    expect(parseReplyChip('hello')).toBeNull()
  })
})

describe('option names', () => {
  test('a name, else Option N', () => {
    expect(optionLabel({ n: 2, name: 'Card stack' })).toBe('Card stack')
    expect(optionLabel({ n: 2, name: '' })).toBe('Option 2')
  })
  test('landed names are read off the progress line', () => {
    expect(landedNames('Option 2 of 4 is ready · Card stack · Minimal list')).toEqual(['Card stack', 'Minimal list'])
    expect(landedNames('ReDesign is making options (0/4)')).toEqual([])
    expect(landedNames(undefined)).toEqual([])
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
    expect(v.options[0]).toEqual({ n: 1, name: 'Card stack', src: '/api/redesign/image/run-1/option-1.png' })
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
      user('u2', 'ReDesign: I pick option 2, Card stack.'),
      user('u3', 'ReDesign: a second message'),
      tool('b', PICK, { run: 'run-1', option: 2 }),
    ]
    const s = redesignState(items)
    expect(s.replies.get('a')).toBe('ReDesign: I pick option 2, Card stack.')
    expect(s.replies.size).toBe(1)
    expect(s.picks.get('run-1')).toBe(2)
  })
  test('an AI-picks call never waits for a reply', () => {
    expect(redesignState([tool('a', OPT, { brief: 'x' }), user('u', 'ReDesign: hi')]).replies.size).toBe(0)
  })
})

describe('redesignSetup', () => {
  test('the no-key text becomes the calm needs-a-key state', () => {
    const s = redesignSetup('ReDesign has no working provider key yet. Tell the person to add one in ReDesign: Settings → Connectors → ReDesign → Open, then the Keys page.')
    expect(s?.kind).toBe('no-key')
    expect(s?.title).toBe('ReDesign needs an AI key')
  })
  test('ReDesign not running is its own setup state', () => {
    expect(redesignSetup('ReDesign is not running')?.kind).toBe('not-running')
  })
  test('an ordinary failure stays the raw error', () => {
    expect(redesignSetup('The run failed: model refused the brief')).toBeNull()
  })
  test('the retry message is a ReDesign: reply the transcript recognises', () => {
    expect(RETRY_MESSAGE.startsWith('ReDesign:')).toBe(true)
  })
})
