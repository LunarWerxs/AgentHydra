import { expect, test } from 'bun:test'
import { validateBindHost } from '../src/config'
import {
  CLAUDE_LAUNCH_EFFORTS,
  CODEX_LAUNCH_EFFORTS,
  launchOptionError,
} from '../src/core/launch-options'
import { isPathInside } from '../src/core/paths'
import { normalizeSchedulerNumber } from '../src/scheduler'
import { searchSessionBodies } from '../src/session-search'

test('daemon binding is restricted to loopback hosts', () => {
  expect(validateBindHost(undefined)).toBe('127.0.0.1')
  expect(validateBindHost('localhost')).toBe('localhost')
  expect(validateBindHost('::1')).toBe('::1')
  expect(() => validateBindHost('0.0.0.0')).toThrow('loopback-only')
  expect(() => validateBindHost('192.168.1.20')).toThrow('loopback-only')
})

test('terminal launch options reject shell syntax and unknown efforts', () => {
  expect(
    launchOptionError({ model: 'claude-sonnet-4-5', effort: 'high' }, CLAUDE_LAUNCH_EFFORTS),
  ).toBeNull()
  expect(
    launchOptionError({ model: 'gpt-5.6-codex', effort: 'xhigh' }, CODEX_LAUNCH_EFFORTS),
  ).toBeNull()
  expect(launchOptionError({ model: 'model & calc.exe' }, CLAUDE_LAUNCH_EFFORTS)).toContain(
    'model must be',
  )
  expect(launchOptionError({ effort: 'surprise' }, CODEX_LAUNCH_EFFORTS)).toContain(
    'effort must be',
  )
})

test('path containment rejects the root, siblings with a shared prefix, and traversal', () => {
  const root = process.platform === 'win32' ? 'C:\\safe\\instances' : '/safe/instances'
  const child = process.platform === 'win32' ? 'C:\\safe\\instances\\abc' : '/safe/instances/abc'
  const sibling =
    process.platform === 'win32' ? 'C:\\safe\\instances-evil\\abc' : '/safe/instances-evil/abc'
  const traversal =
    process.platform === 'win32' ? 'C:\\safe\\instances\\..\\outside' : '/safe/instances/../outside'
  expect(isPathInside(root, child)).toBe(true)
  expect(isPathInside(root, root)).toBe(false)
  expect(isPathInside(root, sibling)).toBe(false)
  expect(isPathInside(root, traversal)).toBe(false)
})

test.skipIf(process.platform !== 'win32')(
  'path containment accepts Codex extended paths without accepting siblings',
  () => {
    const root = 'C:\\safe\\instances'
    expect(isPathInside(root, '\\\\?\\C:\\safe\\instances\\sessions\\thread.jsonl')).toBe(true)
    expect(isPathInside('\\\\?\\C:\\safe\\instances', 'C:\\safe\\instances\\sessions')).toBe(true)
    expect(isPathInside(root, '\\\\?\\C:\\safe\\instances-evil\\thread.jsonl')).toBe(false)
    expect(isPathInside(root, '\\\\?\\C:\\safe\\instances')).toBe(false)
    expect(
      isPathInside('\\\\server\\share\\safe', '\\\\?\\UNC\\server\\share\\safe\\sessions'),
    ).toBe(true)
    expect(isPathInside('\\\\server\\share\\safe', '\\\\?\\UNC\\server\\share\\outside')).toBe(
      false,
    )
  },
)

test('body search rejects catastrophic regular expressions before scanning files', async () => {
  await expect(searchSessionBodies({ query: '(a+)+$', regex: true })).rejects.toThrow(
    'unsafe regular expression',
  )
})

test('scheduler settings are finite, bounded, and integral', () => {
  expect(normalizeSchedulerNumber('spacing_seconds', -1)).toBe(0)
  expect(normalizeSchedulerNumber('poll_seconds', 0)).toBe(1)
  expect(normalizeSchedulerNumber('poll_seconds', 3.6)).toBe(4)
  expect(normalizeSchedulerNumber('max_concurrent', 1000)).toBe(100)
  expect(normalizeSchedulerNumber('max_concurrent', Number.POSITIVE_INFINITY)).toBe(3)
})
