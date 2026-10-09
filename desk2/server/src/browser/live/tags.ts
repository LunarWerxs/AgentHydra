// The tags that name one of the person's own browser profiles, kept on this PC. A tag names a profile (browser,
// user-data folder, profile folder), never a window or a display name: many profiles share one name.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { REAL_HOME } from '../../real-home'

export interface LiveTag {
  tag: string
  browser: string
  userDataDir?: string
  root?: string
  profileDir: string
  profileName?: string
  note?: string
  taggedAt?: string
}

export interface LiveWindowProfile {
  browser: string
  profileDir: string
  userDataDir?: string
}

const USER_DATA_PARTS: Record<string, string[]> = {
  Chrome: ['Google', 'Chrome', 'User Data'],
  Edge: ['Microsoft', 'Edge', 'User Data'],
  Brave: ['BraveSoftware', 'Brave-Browser', 'User Data'],
  Vivaldi: ['Vivaldi', 'User Data'],
}

export function liveHome(): string {
  return process.env.HYDRA_DESK_HOME || REAL_HOME
}

export function browserTagsPath(): string {
  return process.env.CONNECTIONS_BROWSER_TAGS || join(liveHome(), 'browser-tags.json')
}

export function browserLiveProfileDir(relaunch: string): string {
  const m = /--profile-directory=(?:"([^"]+)"|(\S+))/.exec(String(relaunch || ''))
  return m ? m[1] || m[2] : ''
}

export function browserLiveFindTag<T extends { tag: string }>(tags: T[], spec: unknown): T | null {
  const want = String(spec ?? '').trim().toLowerCase()
  return (want && tags.find((t) => String(t.tag).toLowerCase() === want)) || null
}

export function browserLiveRoot(browser: string, userDataDir?: string): string {
  if (userDataDir) return resolve(userDataDir)
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, ...(USER_DATA_PARTS[browser] ?? USER_DATA_PARTS.Chrome))
}

export function browserLiveProfileName(root: string, dir: string): string {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8').replace(/^﻿/, ''))
    const info = state?.profile?.info_cache?.[dir]
    return String(info?.name || info?.gaia_name || '')
  } catch {
    return ''
  }
}

export function browserLiveSameProfile(t: LiveWindowProfile, w: LiveWindowProfile): boolean {
  return (
    t.browser === w.browser &&
    t.profileDir.toLowerCase() === String(w.profileDir || '').toLowerCase() &&
    browserLiveRoot(t.browser, t.userDataDir).toLowerCase() === browserLiveRoot(w.browser, w.userDataDir).toLowerCase()
  )
}

/** The tag file Connections kept before browser_live moved here; the real Desk copies it once, so no tag is lost. */
export const CONNECTIONS_TAGS_PATH = join(homedir(), '.connections', 'browser-tags.json')

export function adoptConnectionsTags(file: string, legacy: string): boolean {
  if (existsSync(file) || !existsSync(legacy)) return false
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(legacy, file)
  return true
}

export function readLiveTags(): { tags: LiveTag[]; error?: string } {
  const file = browserTagsPath()
  if (!process.env.CONNECTIONS_BROWSER_TAGS && !process.env.HYDRA_DESK_HOME) adoptConnectionsTags(file, CONNECTIONS_TAGS_PATH)
  if (!existsSync(file)) return { tags: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { tags: [], error: `${file} is not valid JSON (${why}). Fix or delete it; no tag was changed.` }
  }
  const tags = (parsed as { tags?: unknown })?.tags
  return { tags: Array.isArray(tags) ? (tags as LiveTag[]) : [] }
}

export function writeLiveTags(tags: LiveTag[]): void {
  const file = browserTagsPath()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, tags }, null, 2))
  renameSync(tmp, file)
}
