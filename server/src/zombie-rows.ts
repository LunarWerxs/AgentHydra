// server/src/zombie-rows.ts - THE ROWS THE OWNER SEES AND THE GATE DOES NOT.
//
// THE FAILURE THIS EXISTS FOR, measured on the live fleet 2026-08-31. The owner reported ~10
// chats sitting in one account's sidebar; the sweep reported six chats in the entire fleet. Both
// were reading honestly. The sweep enumerates from the metadata files on disk and skips anything
// flagged archived - and two chats in that account were flagged archived on disk while the
// running app went on rendering them:
//
//   temp2  isArchived=true  "Fix 54 tests with dates hardcoded into them"      <- still on screen
//   temp2  isArchived=true  "Clear the 58 stale auto-filed to-do markers"      <- still on screen
//
// The archive flag is written to disk immediately; the app holds its chat list in MEMORY and only
// re-reads at restart, so the UI click is what actually removes the row. When that click fails -
// and it did, silently, for weeks, on a bug that reported itself as an app-UI change - the chat
// enters a state nothing can escape: archived, therefore filtered out of every future sweep, and
// rendered, therefore still the owner's problem. It can never be re-attempted, because the thing
// that would re-attempt it has been told it is done.
//
// That is the whole "why can't it orchestrate across accounts" complaint. Not a missing account,
// not a permission: a census that reads one source while the human reads another.
//
// So this reconciles the two. For every RUNNING instance it asks the app what it is actually
// showing and re-drives the archive for anything the disk already considers retired.
//
// ⛔ AN UNREADABLE SIDEBAR IS NOT AN EMPTY ONE. listRenderedTitles returns [] both when an
// instance genuinely shows nothing and when the UI read FAILED - and measured on this fleet, two
// of four running instances returned zero rows from a read that plainly did not work. Reporting
// those as "clean" would rebuild the exact lie this module exists to remove, so they are reported
// separately, by name, and never counted as covered.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isGenericChatTitle } from './chat-title'
import { listRenderedTitles, uiArchiveChat } from './ui-archive'

export interface ZombieRow {
  sessionId: string
  title: string
  instance: string
  action: 'cleared' | 'still-rendered' | 'over-cap'
  why: string
}

export interface ZombieReport {
  /** Chats the app renders that the disk already calls archived. */
  rows: ZombieRow[]
  /** Instances whose sidebar could not be read. NOT "nothing to do" - unknown coverage. */
  unreadInstances: Array<{ instance: string; why: string }>
  /** How many rendered rows were compared, so a zero result is legible as measured, not absent. */
  renderedSeen: number
}

/**
 * Every chat row in one profile's store, INCLUDING duplicates.
 *
 * Deliberately not sessionMetaMap(): that returns a Map keyed by session id, so two metadata
 * files carrying the same cliSessionId - exactly what a re-surfaced chat produces - collapse to
 * one entry and the other row becomes invisible. A module about rows the census cannot see must
 * not inherit the census's blind spot.
 */
export function scanChatRows(profileDir: string): Array<{
  sessionId: string
  title: string | null
  archived: boolean
  path: string
}> {
  const out: Array<{ sessionId: string; title: string | null; archived: boolean; path: string }> =
    []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (!e.name.startsWith('local_') || !e.name.endsWith('.json')) continue
      try {
        const meta = JSON.parse(readFileSync(p, 'utf8')) as {
          cliSessionId?: unknown
          title?: unknown
          isArchived?: unknown
        }
        if (typeof meta.cliSessionId !== 'string' || !meta.cliSessionId) continue
        out.push({
          sessionId: meta.cliSessionId,
          title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : null,
          archived: meta.isArchived === true,
          path: p,
        })
      } catch {
        // One unreadable row says nothing about the others.
      }
    }
  }
  walk(join(profileDir, 'claude-code-sessions'), 0)
  return out
}

/**
 * Which rendered rows are already archived on disk? Pure, so the matching rule is pinned by
 * tests without an app.
 *
 * The rendered name carries a LOCALIZED prefix ('More options for <title>', 'Weitere Optionen
 * für <title>'), so the match is by suffix against the exact disk title - the same rule
 * ui-archive.ts settled on, for the same reason: the phrase is localized, the title is not.
 * A generic or empty title never matches, because a generic row could be any chat.
 */
export function zombieCandidates(
  rendered: string[],
  rows: Array<{ sessionId: string; title: string | null; archived: boolean }>,
): Array<{ sessionId: string; title: string }> {
  const out: Array<{ sessionId: string; title: string }> = []
  const claimed = new Set<string>()
  for (const row of rows) {
    if (!row.archived || !row.title || isGenericChatTitle(row.title)) continue
    if (claimed.has(row.sessionId)) continue
    const title = row.title
    if (rendered.some((r) => r === title || r.endsWith(title))) {
      claimed.add(row.sessionId)
      out.push({ sessionId: row.sessionId, title })
    }
  }
  return out
}

export interface ZombieDeps {
  list?: (profileDir: string) => Promise<{ ok: boolean; titles: string[]; why?: string }>
  scan?: typeof scanChatRows
  archive?: typeof uiArchiveChat
  /** Most rows to re-drive in one pass; the rest are reported as over-cap, never as clean. */
  maxPerPass?: number
}

/** The strict reader: separates "showed nothing" from "could not be read". */
async function strictList(
  profileDir: string,
): Promise<{ ok: boolean; titles: string[]; why?: string }> {
  try {
    const titles = await listRenderedTitles(profileDir)
    // Zero rows from an app that is running is itself suspicious: every sidebar renders at
    // least its own navigation chrome, so an empty read is a failed read, not an empty app.
    if (titles.length === 0)
      return { ok: false, titles: [], why: 'the sidebar read returned nothing at all' }
    return { ok: true, titles }
  } catch (err) {
    return { ok: false, titles: [], why: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Reconcile what each RUNNING instance renders against what the disk says is archived, and
 * re-drive the archive for anything stranded in between.
 */
export async function reconcileRenderedRows(
  instances: Array<{ dir: string; name: string; isRunning: boolean }>,
  deps: ZombieDeps = {},
): Promise<ZombieReport> {
  const list = deps.list ?? strictList
  const scan = deps.scan ?? scanChatRows
  const archive = deps.archive ?? uiArchiveChat
  const cap = deps.maxPerPass ?? 10

  const report: ZombieReport = { rows: [], unreadInstances: [], renderedSeen: 0 }
  let cleared = 0
  for (const inst of instances) {
    if (!inst.isRunning) continue
    const read = await list(inst.dir)
    if (!read.ok) {
      report.unreadInstances.push({
        instance: inst.name,
        why: read.why ?? 'the sidebar could not be read - coverage here is UNKNOWN, not clean',
      })
      continue
    }
    report.renderedSeen += read.titles.length
    for (const z of zombieCandidates(read.titles, scan(inst.dir))) {
      if (cleared >= cap) {
        report.rows.push({
          ...z,
          instance: inst.name,
          action: 'over-cap',
          why: `the per-pass cap of ${cap} is spent - this row is still on screen and will be retried next pass`,
        })
        continue
      }
      cleared++
      const r = await archive(inst.dir, z.sessionId)
      report.rows.push({
        ...z,
        instance: inst.name,
        action: r.verified ? 'cleared' : 'still-rendered',
        why: r.verified
          ? "the app's own Archive was driven and the row left the sidebar"
          : `still on screen after re-driving Archive: ${r.reason ?? 'no reason given'}`,
      })
    }
  }
  return report
}
