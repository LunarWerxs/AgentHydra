import { expect, test } from 'bun:test'
import { browserMajor } from '../../../src/browser/agent/session'

test('the browser version is asked without holding the thread, and asked once per binary', async () => {
  const bin = process.execPath
  let fired = false
  setTimeout(() => {
    fired = true
  }, 0)
  const major = await browserMajor(bin, 'linux')
  expect(fired).toBe(true)
  expect(major).toBe(Number(Bun.version.split('.')[0]))
  expect(browserMajor(bin, 'linux')).toBe(browserMajor(bin, 'linux'))
}, 20_000)
