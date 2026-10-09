// The CHANGELOG this copy ships with, read into sections for the window's What's new pop-up. A checkout keeps it
// at the repo root; an installed release copies it into desk2/ (scripts/package-release.ts).

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChangelogAnswer, ChangelogEntry, ChangelogSection } from '@shared/changelog'

export const CHANGELOG_FILES = [resolve(import.meta.dir, '../../CHANGELOG.md'), resolve(import.meta.dir, '../../../CHANGELOG.md')]
const NEWEST_SECTIONS = 10

const SECTION_HEADER = /^## \[([^\]]+)\](?: - (\S+))?/
const ANY_SECTION_HEADER = /^## /
const EVERYTHING_HEADER = /^\*\*Everything in .+\*\*\s*$/
const TOP_BULLET = /^- (.*)$/
const CONTINUATION = /^\s+\S/
const BOLD_HEADLINE = /^\*\*(.+?)\*\*\s*(.*)$/

/** Markdown turned into the words it shows: links keep their text, emphasis and code ticks go. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The bullets under a block: each bullet's lines joined, wrapped lines included, a blank line ending it. */
function bullets(lines: string[]): string[] {
  const items: string[][] = []
  let open = false
  for (const line of lines) {
    const bullet = line.match(TOP_BULLET)
    if (bullet) {
      items.push([bullet[1]!])
      open = true
    } else if (open && CONTINUATION.test(line)) {
      items.at(-1)!.push(line.trim())
    } else {
      open = false
    }
  }
  return items.map((parts) => parts.join(' '))
}

function entryOf(item: string, withDetail: boolean): ChangelogEntry {
  const bold = withDetail ? item.match(BOLD_HEADLINE) : null
  if (!bold) return { headline: plain(item), detail: '' }
  return { headline: plain(bold[1]!).replace(/\.$/, ''), detail: plain(bold[2]!) }
}

function sectionOf(header: string, body: string[]): ChangelogSection {
  const [, name, date] = header.match(SECTION_HEADER) ?? []
  const everything = body.findIndex((line) => EVERYTHING_HEADER.test(line))
  const entries =
    everything === -1
      ? bullets(body).map((item) => entryOf(item, false))
      : bullets(body.slice(everything + 1)).map((item) => entryOf(item, true))
  return { version: name === undefined || /^unreleased$/i.test(name) ? null : name, date: date ?? null, entries }
}

/** The sections of a CHANGELOG, newest first as the file lists them, at most the ten newest. */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  let header: string | null = null
  let body: string[] = []
  const close = () => {
    if (header !== null) sections.push(sectionOf(header, body))
    header = null
    body = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (SECTION_HEADER.test(line)) {
      close()
      header = line
    } else if (ANY_SECTION_HEADER.test(line)) {
      close()
    } else if (header) {
      body.push(line)
    }
  }
  close()
  return sections.slice(0, NEWEST_SECTIONS)
}

/** What GET /api/changelog answers: the first file that exists, or no sections when none can be read. */
export function readChangelog(files: readonly string[] = CHANGELOG_FILES): ChangelogAnswer {
  const file = files.find((f) => existsSync(f))
  if (!file) return { sections: [] }
  try {
    return { sections: parseChangelog(readFileSync(file, 'utf8')) }
  } catch {
    return { sections: [] }
  }
}
