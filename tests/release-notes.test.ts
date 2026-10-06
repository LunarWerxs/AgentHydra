// tests/release-notes.test.ts - the public release page scripts/release-notes.mjs builds from CHANGELOG.md:
// a TL;DR, then every line folded under "Read more" (owner, 2026-10-06: "do it like Sage does"), and the
// refusals that keep a 1.x release or a wall of text off GitHub. formatLineBody folds patches into a
// kept release with synthesized TL;DR, version headings, and proper ordering.
import { describe, expect, test } from 'bun:test'
import {
  formatLineBody,
  formatReleaseBody,
  refusal,
  renderSectionDetails,
  unreleasedRefusal,
} from '../scripts/release-notes.mjs'

const changelog = (section: string) =>
  `# Changelog\n\n## [Unreleased]\n\n${section}\n\n## [1.13.0] - 2026-10-06\n\n### Added\n\n- **Old.** Old.\n`

const LONG = `## [2.0.0] - 2026-10-07

**TL;DR**

- **A new window**
- **Free accounts take work**

**Everything in 2.0.0**

### Added

- **A new window.** It replaces the old one
  and keeps your settings.
- **Free accounts take work.** Chats can send them tasks.

### Fixed

- **A move mid-turn carries on.** It used to stop.`

describe('release notes', () => {
  test('a long section: the TL;DR on top, every line folded under Read more, downloads last', () => {
    const body = formatReleaseBody(changelog(LONG), '2.0.0')
    const tldrAt = body.indexOf('## TL;DR')
    const detailsAt = body.indexOf('<summary><b>Read more: everything in 2.0.0</b></summary>')
    expect(tldrAt).toBeGreaterThan(body.indexOf('misc/AgentHydra-icon.png'))
    expect(body.slice(tldrAt, detailsAt)).toContain(
      '- **A new window**\n- **Free accounts take work**',
    )
    // The detail keeps every bullet, a wrapped one folded onto one line, under emoji headings.
    const details = body.slice(detailsAt, body.indexOf('</details>'))
    expect(details).toContain(
      '- **A new window.** It replaces the old one and keeps your settings.',
    )
    expect(details).toContain('### 🆕 Added')
    expect(details).toContain('### 🩹 Fixed')
    expect(details).toContain('- **A move mid-turn carries on.** It used to stop.')
    // The markers are layout, not content, and an older version's section never leaks in.
    expect(body).not.toContain('**Everything in 2.0.0**')
    expect(body).not.toContain('Old.')
    expect(body.indexOf('## Downloads')).toBeGreaterThan(body.indexOf('</details>'))
  })

  test('refused: a 1.x version, a long section with no TL;DR (also [Unreleased]), a version with no section', () => {
    expect(refusal(changelog(LONG.replace('2.0.0', '1.14.0')), '1.14.0')).toContain('below 2.0.0')
    const noTldr = LONG.replace(/\*\*TL;DR\*\*[\s\S]*?\*\*Everything in 2\.0\.0\*\*\n/, '')
    expect(refusal(changelog(noTldr), '2.0.0')).toContain('3 changes and no TL;DR')
    expect(() => formatReleaseBody(changelog(noTldr), '2.0.0')).toThrow('no TL;DR')
    expect(refusal(changelog(LONG), '2.0.1')).toContain('no section for 2.0.1')
    expect(refusal(changelog(LONG), '2.0.0')).toBeNull()
    // --check-unreleased holds [Unreleased] to the same rule; an empty or short one passes.
    const asUnreleased = (s: string) => changelog(s.replace(/^## \[2\.0\.0\][^\n]*\n/, ''))
    expect(unreleasedRefusal(asUnreleased(noTldr))).toContain(
      'Unreleased section has 3 changes and no TL;DR',
    )
    expect(unreleasedRefusal(asUnreleased(LONG))).toBeNull()
    expect(unreleasedRefusal(changelog(''))).toBeNull()
    expect(
      unreleasedRefusal(asUnreleased('### Fixed\n\n- **Two little things.** Both fixed.')),
    ).toBeNull()
  })

  test('a section of one or two changes needs no TL;DR and is shown whole', () => {
    const short = '## [2.0.1] - 2026-10-08\n\n### Fixed\n\n- **Two little things.** Both fixed.'
    const body = formatReleaseBody(changelog(short), '2.0.1')
    expect(body).toContain("## What's changed")
    expect(body).toContain('- **Two little things.** Both fixed.')
    expect(body).not.toContain('<details>')
  })

  test('a past release (below 2.0.0) is refused for publishing but renders as a history page', () => {
    const past = '## [0.9.0] - 2026-01-01\n\n### Fixed\n\n- **Two little things.** Both fixed.'
    expect(() => formatReleaseBody(changelog(past), '0.9.0')).toThrow('below 2.0.0')
    expect(formatReleaseBody(changelog(past), '0.9.0', { history: true })).toContain(
      '- **Two little things.** Both fixed.',
    )
  })

  test('formatLineBody synthesizes TL;DR from headlines when versions have no explicit TL;DR', () => {
    const patches = `## [0.35.4] - 2026-08-26

### Fixed

- **Renamed chats show their new name right away.** A running app kept showing the old name until
  it restarted. Renames now trigger the same restart the archive flow uses, as soon as that app
  has no live chats.

## [0.35.0] - 2026-08-25

### Changed

- **Auto-revive runs through the queue instead of the keyboard.** Typing into the app failed over
  Remote Desktop and on a locked screen. A revive now runs one resume turn through the queue and
  lands the chat back in its desktop app, with no screen or keyboard needed.
`
    const body = formatLineBody(patches, '0.35.0', ['0.35.4'], { history: true })
    expect(body).toContain('## TL;DR')
    expect(body).toContain('- **Auto-revive runs through the queue instead of the keyboard**')
    expect(body).toContain('- **Renamed chats show their new name right away**')
  })

  test('formatLineBody puts folded patches under <details> with oldest to newest order', () => {
    const patches = `## [0.35.2] - 2026-08-25

### Fixed

- **A just-revived chat is no longer flagged as unresponsive.** Must sit quiet before counting.

## [0.35.0] - 2026-08-25

### Changed

- **Auto-revive runs through the queue.** Revive now runs one resume turn through the queue.
`
    const body = formatLineBody(patches, '0.35.0', ['0.35.2'], { history: true })
    expect(body).toContain('<details>')
    expect(body).toContain('<summary><b>Read more: everything in 0.35.0 to 0.35.2</b></summary>')
    expect(body).toContain('#### 0.35.0')
    expect(body).toContain('#### 0.35.2')
    const idx0 = body.indexOf('#### 0.35.0')
    const idx2 = body.indexOf('#### 0.35.2')
    expect(idx0).toBeLessThan(idx2)
  })

  test('renderSectionDetails folds wrapped bullets onto one line, converts headings to emoji form, collapses blank lines', () => {
    const lines = [
      '### Added',
      '',
      '- **Renamed chats show their new name right away.** A running app kept showing the old name',
      '  until it restarted. Renames now trigger the same restart the archive flow uses, as soon as',
      '  that app has no live chats.',
      '',
      '',
      '',
      '### Fixed',
      '',
      '- **Something.** Fixed it.',
    ]
    const result = renderSectionDetails(lines)
    expect(result).toContain('### 🆕 Added')
    expect(result).toContain('### 🩹 Fixed')
    expect(result).toContain(
      '**Renamed chats show their new name right away.** A running app kept showing the old name until it restarted. Renames now trigger the same restart the archive flow uses, as soon as that app has no live chats.',
    )
    const matches = result.match(/\n\n\n/g)
    expect(matches).toBeNull()
  })

  test('formatLineBody deduplicates TL;DR across versions', () => {
    const dups = `## [0.35.1] - 2026-08-25

**TL;DR**

- **Headline one**

**Everything in 0.35.1**

### Added

- **Headline one.** Detail.

## [0.35.0] - 2026-08-25

**TL;DR**

- **Headline one**

**Everything in 0.35.0**

### Changed

- **Headline one.** Different detail.
`
    const body = formatLineBody(dups, '0.35.0', ['0.35.1'], { history: true })
    const tldrMatch = body.match(/- \*\*Headline one\*\*/g)
    expect(tldrMatch?.length).toBe(1)
  })
})
