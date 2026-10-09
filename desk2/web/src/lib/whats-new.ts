// The What's new pop-up after the update row's restart. Before the restart the row saves what this copy shows
// (its version, and the headlines it has now); the restarted copy diffs its changelog against that marker.

import { ref } from 'vue'
import type { ChangelogEntry, ChangelogSection } from '@shared/changelog'

const KEY = 'hydra-desk.whatsNew'
const MAX_AGE_MS = 2 * 60 * 60_000
const storage = typeof localStorage === 'undefined' ? null : localStorage

/** headlines null when the changelog could not be read before the restart: only the version is known. */
export interface WhatsNewMarker {
  version: string
  headlines: string[] | null
  at: number
}

export interface WhatsNewGroup {
  version: string | null
  date: string | null
  entries: ChangelogEntry[]
}

export interface WhatsNew {
  version: string
  updated: boolean
  groups: WhatsNewGroup[]
  count: number
}

export const whatsNew = ref<WhatsNew | null>(null)

function parts(version: string): number[] | null {
  const m = version.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether version a is a later release than b (semver's major.minor.patch); a version that does not parse is never newer. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parts(a)
  const pb = parts(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!
  return false
}

/** What to remember of the running copy's changelog: the Unreleased headlines and the running version's own. */
export function markerFor(version: string, sections: ChangelogSection[] | null, now: number): WhatsNewMarker {
  if (!sections) return { version, headlines: null, at: now }
  const headlines = sections
    .filter((s) => s.version === null || s.version === version)
    .flatMap((s) => s.entries.map((e) => e.headline))
  return { version, headlines, at: now }
}

/** The sections and Unreleased entries that are new since the marker, or null when there are none (or the marker is too old). */
export function whatsNewSince(marker: WhatsNewMarker, version: string, sections: ChangelogSection[], now: number): WhatsNew | null {
  if (now - marker.at > MAX_AGE_MS) return null
  const groups: WhatsNewGroup[] = []
  for (const section of sections) {
    if (section.version === null) {
      const seen = marker.headlines ?? []
      const entries = section.entries.filter((e) => !seen.includes(e.headline))
      if (entries.length) groups.push({ version: null, date: section.date, entries })
    } else if (isNewerVersion(section.version, marker.version) && section.entries.length) {
      groups.push({ version: section.version, date: section.date, entries: section.entries })
    }
  }
  if (!groups.length) return null
  const count = groups.reduce((n, g) => n + g.entries.length, 0)
  return { version, updated: version !== marker.version, groups, count }
}

export function readMarker(): WhatsNewMarker | null {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? 'null') as Partial<WhatsNewMarker> | null
    if (!v || typeof v.version !== 'string' || typeof v.at !== 'number') return null
    return { version: v.version, headlines: Array.isArray(v.headlines) ? v.headlines : null, at: v.at }
  } catch {
    return null
  }
}

function writeMarker(marker: WhatsNewMarker): void {
  storage?.setItem(KEY, JSON.stringify(marker))
}

function forget(): void {
  storage?.removeItem(KEY)
}

/** The dialog closed: the marker is done with. */
export function dismissWhatsNew(): void {
  forget()
  whatsNew.value = null
}

async function runningVersion(): Promise<string | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    const version = res.ok ? ((await res.json()) as { version?: unknown }).version : null
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

async function changelogSections(): Promise<ChangelogSection[] | null> {
  try {
    const res = await fetch('/api/changelog', { cache: 'no-store' })
    if (!res.ok) return null
    const sections = ((await res.json()) as { sections?: unknown }).sections
    return Array.isArray(sections) ? (sections as ChangelogSection[]) : null
  } catch {
    return null
  }
}

/** The update row's click, before its steps run: remembers what the running copy shows. */
export async function rememberForUpdate(): Promise<void> {
  const version = await runningVersion()
  if (!version) return
  writeMarker(markerFor(version, await changelogSections(), Date.now()))
}

/** A server said hello: after the restart the row asked for, shows what is new, or forgets the marker when nothing is. */
export async function checkWhatsNew(): Promise<void> {
  const marker = readMarker()
  if (!marker || whatsNew.value) return
  const version = await runningVersion()
  const sections = version ? await changelogSections() : null
  if (!version || !sections) return
  const result = whatsNewSince(marker, version, sections, Date.now())
  if (result) whatsNew.value = result
  else forget()
}
