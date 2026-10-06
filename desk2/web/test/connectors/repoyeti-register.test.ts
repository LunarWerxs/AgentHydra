import { expect, test } from 'bun:test'
import { reloadAfterRegister, shouldRegister } from '../../src/components/connectors/logic'

const frame = { kind: 'frame', url: 'http://127.0.0.1:7171' } as const

test('a folder is asked once, and only while the frame is up', () => {
  const done = new Set<string>()
  expect(shouldRegister(frame, 'C:/Users/me/proj', done)).toBe(true)
  expect(shouldRegister({ kind: 'start' }, 'C:/Users/me/proj', done)).toBe(false)
  expect(shouldRegister(frame, undefined, done)).toBe(false)
  done.add('C:/Users/me/proj')
  expect(shouldRegister(frame, 'C:/Users/me/proj', done)).toBe(false)
  expect(shouldRegister(frame, 'C:/Users/me/other', done)).toBe(true)
})

test('the frame reloads only when the folder was newly added', () => {
  expect(reloadAfterRegister({ added: true })).toBe(true)
  expect(reloadAfterRegister({ added: false })).toBe(false)
  expect(reloadAfterRegister(null)).toBe(false)
})
