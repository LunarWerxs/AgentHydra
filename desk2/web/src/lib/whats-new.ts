// The What's new pop-up after the update row's restart. Before the restart the row saves what this copy shows
// (its version, and the headlines it has now); the restarted copy diffs its changelog against that marker.

import { ref } from 'vue'
import type { ChangelogEntry, ChangelogSection } from '@shared/changelog'

const KEY = 'hydra-desk.whatsNew'
const SEEN_KEY = 'hydra-desk.whatsNew.seenVersion'
const MAX_AGE_MS = 2 * 60 * 60_000
const READ_MS = 4_000
const REFRESH_MS = 1_500
const store = () => (typeof localStorage === 'undefined' ? null : localStorage)

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

interface Running {
  version: string
  sections: ChangelogSection[] | null
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
    const v = JSON.parse(store()?.getItem(KEY) ?? 'null') as Partial<WhatsNewMarker> | null
    if (!v || typeof v.version !== 'string' || typeof v.at !== 'number') return null
    return { version: v.version, headlines: Array.isArray(v.headlines) ? v.headlines : null, at: v.at }
  } catch {
    return null
  }
}

function writeMarker(marker: WhatsNewMarker): void {
  store()?.setItem(KEY, JSON.stringify(marker))
}

function forget(): void {
  store()?.removeItem(KEY)
}

/** The dialog closed: the marker is done with. */
export function dismissWhatsNew(): void {
  forget()
  whatsNew.value = null
}

/** The version and changelog the window last read from the running server; the version survives a reload. */
let running: Running | null = null

function seenVersion(): string | null {
  return running?.version ?? store()?.getItem(SEEN_KEY) ?? null
}

function noteRunning(read: Running): void {
  running = read
  store()?.setItem(SEEN_KEY, read.version)
}

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal })
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function readRunning(ms: number): Promise<Running | null> {
  const signal = AbortSignal.timeout(ms)
  const [health, changelog] = await Promise.all([getJson('/api/health', signal), getJson('/api/changelog', signal)])
  const version = health?.version
  if (typeof version !== 'string') return null
  const sections = changelog?.sections
  return { version, sections: Array.isArray(sections) ? (sections as ChangelogSection[]) : null }
}

/**
 * The update row's click, before its steps run: the marker is written at once from what the window has read, and
 * refreshed from the server only when it answers within a moment.
 */
export async function rememberForUpdate(): Promise<void> {
  const version = seenVersion()
  if (version) writeMarker(markerFor(version, running?.sections ?? null, Date.now()))
  const read = await readRunning(REFRESH_MS)
  if (!read) return
  noteRunning(read)
  writeMarker(markerFor(read.version, read.sections, Date.now()))
}

/** A server said hello: after the restart the row asked for, shows what is new, or forgets the marker when nothing is. */
export async function checkWhatsNew(): Promise<void> {
  const read = await readRunning(READ_MS)
  if (read) noteRunning(read)
  const marker = readMarker()
  if (!marker || whatsNew.value || !read?.sections) return
  const result = whatsNewSince(marker, read.version, read.sections, Date.now())
  if (result) whatsNew.value = result
  else forget()
}
