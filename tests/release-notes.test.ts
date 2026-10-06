// tests/release-notes.test.ts - the public release page scripts/release-notes.mjs builds from CHANGELOG.md:
// a TL;DR, then every line folded under "Read more" (owner, 2026-10-06: "do it like Sage does"), and the
// refusals that keep a 1.x release or a wall of text off GitHub.
import { describe, expect, test } from 'bun:test'
import { formatReleaseBody, refusal } from '../scripts/release-notes.mjs'

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

  test('refused: a 1.x version, a long section with no TL;DR, a version with no section', () => {
    expect(refusal(changelog(LONG.replace('2.0.0', '1.14.0')), '1.14.0')).toContain('below 2.0.0')
    const noTldr = LONG.replace(/\*\*TL;DR\*\*[\s\S]*?\*\*Everything in 2\.0\.0\*\*\n/, '')
    expect(refusal(changelog(noTldr), '2.0.0')).toContain('3 changes and no TL;DR')
    expect(() => formatReleaseBody(changelog(noTldr), '2.0.0')).toThrow('no TL;DR')
    expect(refusal(changelog(LONG), '2.0.1')).toContain('no section for 2.0.1')
    expect(refusal(changelog(LONG), '2.0.0')).toBeNull()
  })

  test('a section of one or two changes needs no TL;DR and is shown whole', () => {
    const short = '## [2.0.1] - 2026-10-08\n\n### Fixed\n\n- **Two little things.** Both fixed.'
    const body = formatReleaseBody(changelog(short), '2.0.1')
    expect(body).toContain("## What's changed")
    expect(body).toContain('- **Two little things.** Both fixed.')
    expect(body).not.toContain('<details>')
  })
})
