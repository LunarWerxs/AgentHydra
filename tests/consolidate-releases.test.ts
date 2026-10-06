// tests/consolidate-releases.test.ts - the consolidate-releases.mjs script:
// groups releases by minor version (x.y), keeps x.y.0 (or lowest if missing), folds patches,
// and never folds the latest release.
import { describe, expect, test } from 'bun:test'
// @ts-expect-error - consolidate-releases.mjs is a build script with runtime exports
import { classifyVersions, groupByMinor } from '../scripts/consolidate-releases.mjs'

describe('consolidate releases', () => {
  test('groups versions by minor version (x.y)', () => {
    const versions = ['2.0.0', '2.0.1', '2.0.2', '2.1.0', '2.1.1', '1.13.0']
    const groups = groupByMinor(versions)

    expect(groups.has('2.0')).toBe(true)
    expect(groups.get('2.0')).toContain('2.0.0')
    expect(groups.get('2.0')).toContain('2.0.1')
    expect(groups.get('2.0')).toContain('2.0.2')

    expect(groups.has('2.1')).toBe(true)
    expect(groups.get('2.1')).toContain('2.1.0')
    expect(groups.get('2.1')).toContain('2.1.1')

    expect(groups.has('1.13')).toBe(true)
    expect(groups.get('1.13')).toContain('1.13.0')
  })

  test('keeps x.y.0 and folds patches', () => {
    const versions = ['2.0.1', '2.0.0', '2.0.2']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('2.0.0')
    expect(patches).toContain('2.0.1')
    expect(patches).toContain('2.0.2')
    expect(patches.length).toBe(2)
  })

  test('keeps lowest when x.y.0 does not exist', () => {
    const versions = ['2.5.3', '2.5.1', '2.5.2']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('2.5.1')
    expect(patches).toContain('2.5.2')
    expect(patches).toContain('2.5.3')
    expect(patches.length).toBe(2)
  })

  test('single version is kept, no patches', () => {
    const versions = ['2.2.0']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('2.2.0')
    expect(patches.length).toBe(0)
  })

  test('multiple versions keep x.y.0, fold others in release order', () => {
    const versions = ['1.13.0', '1.13.1', '1.13.2']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('1.13.0')
    // Patches are sorted oldest first (for the body)
    expect(patches).toEqual(['1.13.1', '1.13.2'])
  })
})
