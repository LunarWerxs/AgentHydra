import { expect, test } from 'bun:test'
import { appModeForPath } from '../src/lib/app-mode'

test('only the dedicated instances pathname selects the lightweight UI root', () => {
  expect(appModeForPath('/instances')).toBe('instances')
  expect(appModeForPath('/instances/')).toBe('instances')
  expect(appModeForPath('/')).toBe('full')
  expect(appModeForPath('/settings')).toBe('full')
  expect(appModeForPath('/instances/something')).toBe('full')
})
