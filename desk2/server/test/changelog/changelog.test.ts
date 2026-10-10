import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseChangelog, readChangelog } from '../../src/changelog'

const FIXTURE = `# Changelog

## [Unreleased]

**TL;DR**

- **The window shows what changed**
- **Chats load faster**

**Everything in Unreleased**

- **The window shows what changed.** It opens a pop-up after an update
  with the lines the new version adds, and \`Esc\` closes it.

- **Chats load faster.** A long chat is read once,
  not on every poll.

## [2.0.4] - 2026-10-06

**TL;DR**

- **A new release line**

**Everything in 2.0.4**

- **The row restarts you onto an update.** One click applies the release
  and restarts the server.

## [2.0.3] - 2026-10-01

- Plain bullet one
  that wraps
- Plain bullet two

## Older notes

Not a release section, so its bullets do not belong to 2.0.3.
- Not a release bullet
`

describe('parseChangelog', () => {
  const sections = parseChangelog(FIXTURE)

  test('reads the Unreleased and the versioned sections, newest first', () => {
    expect(sections.map((s) => [s.version, s.date])).toEqual([
      [null, null],
      ['2.0.4', '2026-10-06'],
      ['2.0.3', '2026-10-01'],
    ])
  })

  test('takes headline and detail from the Everything list, joining wrapped lines', () => {
    expect(sections[0]!.entries).toEqual([
      {
        headline: 'The window shows what changed',
        detail: 'It opens a pop-up after an update with the lines the new version adds, and Esc closes it.',
      },
      { headline: 'Chats load faster', detail: 'A long chat is read once, not on every poll.' },
    ])
  })

  test('falls back to plain top-level bullets, with no detail, when there is no Everything list', () => {
    expect(sections[2]!.entries).toEqual([
      { headline: 'Plain bullet one that wraps', detail: '' },
      { headline: 'Plain bullet two', detail: '' },
    ])
  })

  test('stops a section at the next heading that is not a release', () => {
    expect(sections[2]!.entries.some((e) => e.headline.includes('Not a release'))).toBe(false)
  })

  test('keeps at most the ten newest sections', () => {
    const many = Array.from({ length: 12 }, (_, i) => `## [1.0.${i}] - 2026-01-01\n\n**Everything in 1.0.${i}**\n\n- **Change ${i}.** Words.\n`).join('\n')
    expect(parseChangelog(many)).toHaveLength(10)
  })
})

describe('readChangelog', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'changelog-'))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  test('answers no sections when the file is missing', () => {
    const dir = mkdtempSync(join(ROOT, 'case-'))
    expect(readChangelog([join(dir, 'CHANGELOG.md')])).toEqual({ sections: [] })
  })

  test('reads the first file that exists', () => {
    const dir = mkdtempSync(join(ROOT, 'case-'))
    const file = join(dir, 'CHANGELOG.md')
    writeFileSync(file, FIXTURE)
    expect(readChangelog([join(dir, 'missing.md'), file]).sections).toHaveLength(3)
  })
})
