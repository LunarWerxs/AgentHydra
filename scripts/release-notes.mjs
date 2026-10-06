#!/usr/bin/env node
// scripts/release-notes.mjs - a GitHub release's body, built from that version's CHANGELOG.md section.
//
// The layout is SageThumbs 2K's (its scripts/release-manifest-lib.ps1, Format-ReleaseNotesBody). The owner
// asked for it on 2026-10-06, of AgentHydra's release page: "We always need to do it like Sage does. You
// have a TL;DR, bullet points ... then you have the details in, like, a read more. 'Cause I ain't
// fucking reading that 10,000-mile-long detailed bullshit list just to figure out that you fixed two
// little things." So the page opens with the icon and a TL;DR of one-line headlines. Every line of the
// section follows, folded under "Read more", and the downloads come last.
//
// The CHANGELOG section writes its own TL;DR:
//
//   ## [2.0.0] - 2026-10-07
//
//   **TL;DR**
//
//   - **AgentHydra has a new window**
//   - **Free claude.ai and ChatGPT accounts can take work**
//
//   **Everything in 2.0.0**
//
//   ### Added
//   - ...
//
// A section with more than two changes and no TL;DR is refused. A wall of text on the release page is
// what this script exists to stop, and bold leads cut from long bullets do not read as headlines. A
// section of one or two changes is short already and is shown whole. Nothing in the section is dropped:
// the body is checked to hold every line of it.
//
// AgentHydra 2.0 is the AgentHydra window that was Hydra Desk 2 (desk2/). On 2026-10-06 the owner asked
// "why do we keep releasing updates to GitHub on the 1.x path of Agent Hydra?" after 1.11.0 to 1.13.0
// shipped on the old line. So no version below MIN_RELEASE is released.
//
// usage: node scripts/release-notes.mjs <version> [CHANGELOG.md]           prints the body
//        node scripts/release-notes.mjs --check <version> [CHANGELOG.md]   exit 1 with the reason when refused

import { readFileSync } from 'node:fs'

/** The lowest version AgentHydra may release: 2.0 is the AgentHydra window that was Hydra Desk 2. */
export const MIN_RELEASE = '2.0.0'

const REPO = 'LunarWerxs/AgentHydra'
const DISCORD = 'https://discord.gg/PsWpeNUzhk'
const HEADING_EMOJI = {
  Added: '🆕 Added',
  Changed: '🔁 Changed',
  Fixed: '🩹 Fixed',
  Removed: '🗑️ Removed',
  Deprecated: '⚠️ Deprecated',
  Security: '🔒 Security',
}
const HEADING = /^###[ ]+(Added|Changed|Fixed|Removed|Deprecated|Security)\s*$/
const BULLET = /^-[ ]+\S/

/** -1, 0 or 1, comparing two x.y.z versions (a pre-release suffix is ignored). */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).slice(0, 3).map(Number)
  const pb = String(b).split(/[.-]/).slice(0, 3).map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1
  }
  return 0
}

/** The lines under `## [<version>]` up to the next `## ` heading, or null when the version has none. */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n')
}

/** The section's written TL;DR bullets (a wrapped bullet folded onto one line) and the rest of the
 *  section without the TL;DR block and its two marker lines. `tldr` is empty when there is none. */
export function splitTldr(section) {
  const lines = section.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\*\*TL;DR\*\*\s*$/.test(l))
  if (start < 0) return { tldr: [], rest: section }
  const tldr = []
  let end = lines.length
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\*\*[^*]+\*\*\s*$/.test(lines[j])) {
      end = j
      break
    }
    if (BULLET.test(lines[j])) tldr.push(lines[j].trimEnd())
    else if (/^\s+\S/.test(lines[j]) && tldr.length) tldr[tldr.length - 1] += ` ${lines[j].trim()}`
  }
  return { tldr, rest: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n') }
}

/** Why this version may not be released, or null when it may. */
export function refusal(changelog, version) {
  if (compareVersions(version, MIN_RELEASE) < 0) {
    return (
      `${version} is below ${MIN_RELEASE}. AgentHydra is 2.0 now (the window that was Hydra Desk 2), ` +
      'and the 1.x line is closed (owner, 2026-10-06).'
    )
  }
  const section = changelogSection(changelog, version)
  if (section === null || !section.trim()) return `CHANGELOG.md has no section for ${version}.`
  const { tldr, rest } = splitTldr(section)
  const changes = rest.split(/\r?\n/).filter((l) => BULLET.test(l)).length
  if (changes > 2 && !tldr.length) {
    return (
      `CHANGELOG.md's ${version} section has ${changes} changes and no TL;DR. Open it with a **TL;DR** ` +
      `line, one short headline bullet per change that matters, then **Everything in ${version}** ` +
      'before the full list.'
    )
  }
  return null
}

/** The release page: the icon, the TL;DR, every line of the section under "Read more", the downloads. */
export function formatReleaseBody(changelog, version) {
  const why = refusal(changelog, version)
  if (why) throw new Error(why)
  const section = changelogSection(changelog, version)
  const { tldr, rest } = splitTldr(section)
  const lines = rest.split(/\r?\n/)

  // GitHub renders a release body with hard line breaks, so a CHANGELOG bullet wrapped for an editor
  // would come out as a ragged staircase on a phone (SageThumbs, 2026-09-20). Each bullet is folded
  // back onto one line here; the file itself stays as written.
  const body = []
  let pending = null
  let fenced = false
  let sawHeading = false
  const flush = () => {
    if (pending !== null) body.push(pending)
    pending = null
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush()
      fenced = !fenced
      body.push(line)
      continue
    }
    if (fenced) {
      body.push(line)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      if (sawHeading) body.push('', '---', '')
      body.push(`### ${HEADING_EMOJI[heading[1]]}`)
      sawHeading = true
      continue
    }
    if (pending !== null && /^\s+\S/.test(line) && !/^\s*[-*+][ ]/.test(line)) {
      pending += ` ${line.trim()}`
      continue
    }
    flush()
    if (/^\s*[-*+][ ]/.test(line)) pending = line.trimEnd()
    else body.push(line)
  }
  flush()
  const details = body.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  const out = [
    '<div align="center">',
    `<img src="https://raw.githubusercontent.com/${REPO}/v${version}/misc/AgentHydra-icon.png" width="96" alt="AgentHydra logo">`,
    '</div>',
    '',
  ]
  if (tldr.length) {
    out.push('## TL;DR', '', ...tldr, '', '<details>')
    out.push(`<summary><b>Read more: everything in ${version}</b></summary>`, '', details, '', '</details>')
  } else {
    out.push("## What's changed", '', details)
  }
  out.push(
    '',
    '## Downloads',
    '',
    `- **Windows:** \`AgentHydra-${version}-windows-x64.zip\` is the app with its tray icon and the orchestrator tools. The \`.exe\` is the same app as one file, without the orchestrator tools.`,
    '- **Linux and macOS:** the `.tar.gz` for your system.',
    '- `SHA256SUMS.txt` lets you check that a download is the one published here.',
    '',
    '---',
    '',
    `💬 Questions, ideas, or a hello: the [LunarWerx Discord](${DISCORD}).`,
  )
  const text = out.join('\n')

  // Nothing dropped: every line of the section is on the page (a heading in its emoji form).
  for (const line of [...lines, ...tldr]) {
    const t = line.trim()
    if (!t) continue
    const h = HEADING.exec(t)
    const want = h ? `### ${HEADING_EMOJI[h[1]]}` : t
    if (!text.includes(want)) throw new Error(`the release page dropped a CHANGELOG line: ${t}`)
  }
  return text
}

const invokedDirectly = process.argv[1] && /release-notes\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const check = args[0] === '--check'
  const [version, file = 'CHANGELOG.md'] = check ? args.slice(1) : args
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs [--check] <version> [CHANGELOG.md]')
    process.exit(2)
  }
  const changelog = readFileSync(file, 'utf8')
  const why = refusal(changelog, version.replace(/^v/, ''))
  if (why) {
    console.error(`release refused: ${why}`)
    process.exit(1)
  }
  if (!check) process.stdout.write(`${formatReleaseBody(changelog, version.replace(/^v/, ''))}\n`)
}
