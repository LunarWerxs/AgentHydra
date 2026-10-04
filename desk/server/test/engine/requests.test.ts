import { describe, expect, test } from 'bun:test'
import { checkAnswer, ElicitationAnswerError, elicitationItem, fieldsFromSchema, ruleLine } from '../../src/engine/requests'

describe('fieldsFromSchema: an MCP requested schema as form fields', () => {
  test('every kind of property, in order, with titles, descriptions, defaults and the required list', () => {
    const fields = fieldsFromSchema({
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Your name', description: 'As on the invoice', default: 'Jacob' },
        seats: { type: 'integer', minimum: 1, default: 2 },
        price: { type: 'number' },
        notify: { type: 'boolean', title: 'Notify me', default: true },
        plan: { type: 'string', enum: ['pro', 'max'], enumNames: ['Pro', 'Max'] },
        region: { type: 'string', oneOf: [{ const: 'eu', title: 'Europe' }, { const: 'us', title: 'United States' }] },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        teams: { type: 'array', items: { anyOf: [{ const: 't1', title: 'Team one' }] } },
        meta: { type: 'object', properties: {} },
        odd: 'not a schema',
      },
      required: ['name', 'plan', 42],
    })
    expect(fields).toEqual([
      { name: 'name', label: 'Your name', description: 'As on the invoice', type: 'text', required: true, default: 'Jacob' },
      { name: 'seats', label: 'seats', type: 'number', required: false, integer: true, min: 1, default: 2 },
      { name: 'price', label: 'price', type: 'number', required: false },
      { name: 'notify', label: 'Notify me', type: 'boolean', required: false, default: true },
      { name: 'plan', label: 'plan', type: 'choice', required: true, options: [{ value: 'pro', label: 'Pro' }, { value: 'max', label: 'Max' }] },
      { name: 'region', label: 'region', type: 'choice', required: false, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'United States' }] },
      { name: 'tags', label: 'tags', type: 'multichoice', required: false, options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] },
      { name: 'teams', label: 'teams', type: 'multichoice', required: false, options: [{ value: 't1', label: 'Team one' }] },
      { name: 'meta', label: 'meta', type: 'text', required: false },
      { name: 'odd', label: 'odd', type: 'text', required: false },
    ])
  })

  test('no schema, or one without properties, is an empty form; a default the field cannot hold is dropped', () => {
    expect(fieldsFromSchema(undefined)).toEqual([])
    expect(fieldsFromSchema({ type: 'object' })).toEqual([])
    expect(fieldsFromSchema({ properties: { n: { type: 'number', default: 'many' } } })[0]).toEqual({ name: 'n', label: 'n', type: 'number', required: false })
  })
})

describe('checkAnswer: the values sent back to the MCP server', () => {
  const fields = fieldsFromSchema({
    properties: {
      name: { type: 'string', title: 'Name' },
      seats: { type: 'integer', title: 'Seats' },
      notify: { type: 'boolean', title: 'Notify' },
      plan: { type: 'string', title: 'Plan', enum: ['pro', 'max'] },
      tags: { type: 'array', title: 'Tags', items: { enum: ['a', 'b'] } },
    },
    required: ['name', 'plan'],
  })

  test('coerces to each field type and drops what the form does not have or left empty', () => {
    expect(checkAnswer(fields, { name: 'Jacob', seats: '3', notify: 'false', plan: 'max', tags: ['b', 'a', 'b'], extra: 1 })).toEqual({
      name: 'Jacob',
      seats: 3,
      notify: false,
      plan: 'max',
      tags: ['b', 'a'],
    })
    expect(checkAnswer(fields, { name: 7, plan: 'pro', seats: '', tags: [] })).toEqual({ name: '7', plan: 'pro' })
    expect(checkAnswer(fields, { name: 'x', plan: 'pro', tags: 'a' })).toEqual({ name: 'x', plan: 'pro', tags: ['a'] })
  })

  test('refuses a missing required field or a value the field cannot hold, with the field named', () => {
    const refused = (values: Record<string, unknown>) => {
      try {
        checkAnswer(fields, values)
      } catch (err) {
        expect(err).toBeInstanceOf(ElicitationAnswerError)
        return (err as Error).message
      }
      throw new Error('accepted')
    }
    expect(refused({ plan: 'pro' })).toBe('Name is required')
    expect(refused({ name: '   ', plan: 'pro' })).toBe('Name is required')
    expect(refused({ name: 'x', plan: 'team' })).toBe('Plan must be one of pro, max')
    expect(refused({ name: 'x', plan: 'pro', seats: 'three' })).toBe('Seats must be a number')
    expect(refused({ name: 'x', plan: 'pro', notify: 'yes' })).toBe('Notify must be true or false')
    expect(refused({ name: 'x', plan: 'pro', tags: ['c'] })).toBe('Tags takes only a, b')
    expect(refused({ name: { first: 'J' }, plan: 'pro' })).toBe('Name must be text')
  })

  test("keeps the schema's limits, so the MCP server's own check takes the answer", () => {
    const limited = fieldsFromSchema({
      properties: {
        age: { type: 'integer', title: 'Age', minimum: 0, maximum: 130 },
        ratio: { type: 'number', title: 'Ratio', maximum: 1 },
        code: { type: 'string', title: 'Code', minLength: 2, maxLength: 4 },
        size: { type: 'number', title: 'Size', enum: [1, 2] },
      },
    })
    expect(limited.map(({ name, integer, min, max, minLength, maxLength, numeric }) => ({ name, integer, min, max, minLength, maxLength, numeric }))).toEqual([
      { name: 'age', integer: true, min: 0, max: 130, minLength: undefined, maxLength: undefined, numeric: undefined },
      { name: 'ratio', integer: undefined, min: undefined, max: 1, minLength: undefined, maxLength: undefined, numeric: undefined },
      { name: 'code', integer: undefined, min: undefined, max: undefined, minLength: 2, maxLength: 4, numeric: undefined },
      { name: 'size', integer: undefined, min: undefined, max: undefined, minLength: undefined, maxLength: undefined, numeric: true },
    ])
    const refused = (values: Record<string, unknown>) => {
      try {
        checkAnswer(limited, values)
      } catch (err) {
        expect(err).toBeInstanceOf(ElicitationAnswerError)
        return (err as Error).message
      }
      throw new Error('accepted')
    }
    expect(refused({ age: '1.5' })).toBe('Age must be a whole number')
    expect(refused({ age: -3 })).toBe('Age must be at least 0')
    expect(refused({ age: '131' })).toBe('Age must be at most 130')
    expect(refused({ age: '0x10' })).toBe('Age must be a number')
    expect(refused({ ratio: '1e0' })).toBe('Ratio must be a number')
    expect(refused({ code: 'a' })).toBe('Code must be at least 2 characters')
    expect(refused({ code: 'abcde' })).toBe('Code must be at most 4 characters')
    expect(checkAnswer(limited, { age: ' 42 ', ratio: '.5', code: 'ab', size: '2' })).toEqual({ age: 42, ratio: 0.5, code: 'ab', size: 2 })
    // A default outside the limits is not offered.
    expect(fieldsFromSchema({ properties: { n: { type: 'integer', minimum: 5, default: 1 } } })[0]?.default).toBeUndefined()
  })
})

describe('elicitationItem', () => {
  test('a form keeps its fields; a link keeps an http(s) url only', () => {
    const form = elicitationItem('r1', 5, { serverName: 'connections', message: 'Pick', requestedSchema: { properties: { a: { type: 'string' } } } })
    expect(form).toEqual({ kind: 'elicitation', id: 'r1', ts: 5, serverName: 'connections', message: 'Pick', mode: 'form', state: 'pending', fields: [{ name: 'a', label: 'a', type: 'text', required: false }] })
    expect(elicitationItem('r2', 5, { serverName: 's', message: 'Sign in', mode: 'url', url: 'https://x.test/a' }).url).toBe('https://x.test/a')
    expect(elicitationItem('r3', 5, { serverName: 's', message: 'Sign in', mode: 'url', url: 'javascript:alert(1)' }).url).toBeUndefined()
    expect(elicitationItem('r4', 5, { serverName: 's', message: 'Sign in', mode: 'url', url: 'not a url' }).url).toBeUndefined()
  })

  test("an elicitation-driven permission prompt keeps the server's header and subtitle", () => {
    const item = elicitationItem('r5', 5, { serverName: 's', message: 'Delete the repo?', title: 'Allow s to delete a repository', description: 'acme/site', requestedSchema: {} })
    expect(item).toMatchObject({ title: 'Allow s to delete a repository', description: 'acme/site' })
    expect(elicitationItem('r6', 5, { serverName: 's', message: 'Pick', title: '  ' })).not.toHaveProperty('title')
  })
})

describe('ruleLine: what "Always allow" saves, and where', () => {
  test('rules, modes and folders, each with its place', () => {
    expect(ruleLine({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }], behavior: 'allow', destination: 'projectSettings' })).toBe(
      'Bash(npm test:*), Read in this project, shared',
    )
    expect(ruleLine({ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'deny', destination: 'userSettings' })).toBe('Deny WebFetch in your user settings')
    expect(ruleLine({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe('Accept edits mode for this session')
    expect(ruleLine({ type: 'addDirectories', directories: ['C:/work/other'], destination: 'localSettings' })).toBe('Access to C:/work/other in this project')
  })
})
