import { describe, expect, it } from 'bun:test'
import type { ElicitationField } from '@shared/protocol'
import { formAnswer, initialForm, limitHint, linkOf, togglePick } from '../../src/components/transcript/lib/elicitation'

// The MCP elicitation form: what its inputs start with, and the answer it sends.
const fields: ElicitationField[] = [
  { name: 'name', label: 'Name', type: 'text', required: true, default: 'Jacob' },
  { name: 'seats', label: 'Seats', type: 'number', required: false, default: 2 },
  { name: 'notify', label: 'Notify', type: 'boolean', required: false },
  { name: 'plan', label: 'Plan', type: 'choice', required: true, options: [{ value: 'pro', label: 'Pro' }, { value: 'max', label: 'Max' }] },
  { name: 'tags', label: 'Tags', type: 'multichoice', required: false, options: [{ value: 'a', label: 'A' }], default: ['a'] },
]

describe('initialForm', () => {
  it('starts each input from the field default, as the input holds it', () => {
    expect(initialForm(fields)).toEqual({ name: 'Jacob', seats: '2', notify: false, plan: '', tags: ['a'] })
  })
})

describe('formAnswer', () => {
  it('sends numbers as numbers, a checkbox always, and leaves empty inputs out', () => {
    const form = { ...initialForm(fields), plan: 'max', tags: [] }
    expect(formAnswer(fields, form)).toEqual({ values: { name: 'Jacob', seats: 2, notify: false, plan: 'max' }, missing: [], invalid: [] })
  })

  it('names the required fields still empty and says what is wrong with a filled-in one', () => {
    const answer = formAnswer(fields, { name: '  ', seats: 'two', notify: true, plan: '', tags: [] })
    expect(answer.missing).toEqual(['Name', 'Plan'])
    expect(answer.invalid).toEqual(['Seats must be a number'])
    expect(answer.values).toEqual({ notify: true })
  })

  it("keeps the schema's limits, in the server's words", () => {
    const limited: ElicitationField[] = [
      { name: 'age', label: 'Age', type: 'number', required: false, integer: true, min: 0, max: 130 },
      { name: 'code', label: 'Code', type: 'text', required: false, minLength: 2, maxLength: 4 },
    ]
    const invalid = (age: string, code: string) => formAnswer(limited, { age, code }).invalid
    expect(invalid('1.5', '')).toEqual(['Age must be a whole number'])
    expect(invalid('-3', '')).toEqual(['Age must be at least 0'])
    expect(invalid('131', '')).toEqual(['Age must be at most 130'])
    expect(invalid('0x10', '')).toEqual(['Age must be a number'])
    expect(invalid('', 'a')).toEqual(['Code must be at least 2 characters'])
    expect(invalid('', 'abcde')).toEqual(['Code must be at most 4 characters'])
    expect(formAnswer(limited, { age: ' 42 ', code: 'ab' })).toEqual({ values: { age: 42, code: 'ab' }, missing: [], invalid: [] })
  })
})

describe('limitHint', () => {
  it('says the limits under the input, and nothing when there are none', () => {
    expect(limitHint({ name: 'a', label: 'A', type: 'number', required: false, integer: true, min: 1, max: 10 })).toBe('A whole number, 1 to 10')
    expect(limitHint({ name: 'a', label: 'A', type: 'number', required: false, min: 0 })).toBe('At least 0')
    expect(limitHint({ name: 'a', label: 'A', type: 'text', required: false, maxLength: 200 })).toBe('At most 200 characters')
    expect(limitHint({ name: 'a', label: 'A', type: 'number', required: false })).toBeNull()
    expect(limitHint(fields[3]!)).toBeNull()
  })
})

describe('linkOf', () => {
  it('shows where a link goes, warns on plain http, and opens nothing but web pages', () => {
    expect(linkOf('https://github.com/login/oauth?x=1')).toEqual({ href: 'https://github.com/login/oauth?x=1', host: 'github.com', insecure: false })
    expect(linkOf('http://auth.example.test:8080/start')).toMatchObject({ host: 'auth.example.test:8080', insecure: true })
    expect(linkOf('javascript:alert(1)')).toBeNull()
    expect(linkOf('not a url')).toBeNull()
    expect(linkOf(undefined)).toBeNull()
  })
})

describe('togglePick', () => {
  it('adds a pick, and takes it away again', () => {
    expect(togglePick(['a'], 'b')).toEqual(['a', 'b'])
    expect(togglePick(['a', 'b'], 'a')).toEqual(['b'])
  })
})
