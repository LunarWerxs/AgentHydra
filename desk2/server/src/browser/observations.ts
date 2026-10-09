// The per-profile site ledger: after a browser_* call on a saved profile, the pages it reached are noted as reached, behind a
// sign-in wall, or challenged by a bot check, so a later agent can answer "where is this profile signed in?" from data.
// Ports Connections' recordBrowserProfileObservation (src-impl/05-proc-and-module-loaders.mjs:1714-1772).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ToolReply } from './agent/contract'
import { profileLocation } from './agent/handoff'
import { storeRoot } from './store'

const SIGNIN_URL_MARKERS = /\/(signin|sign-in|login|log-in|auth\/login|authorize)\b|accounts\.google\.com/i
const CHALLENGE_TITLE_MARKERS = /just a moment|performing security verification|attention required|you have been blocked|verify you are/i
const PAGE_PATTERN = /"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"url"\s*:\s*("(?:[^"\\]|\\.)*")/g

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function observationLedgerPath(): string {
  return join(dirname(storeRoot()), 'browser-profile-logins.json')
}

function readLedger(file: string): Dict {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isDict(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function observedPagesIn(payload: unknown): Array<{ title: string; url: string }> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const pages: Array<{ title: string; url: string }> = []
  for (const match of text.matchAll(PAGE_PATTERN)) {
    try {
      pages.push({ title: JSON.parse(match[1]) as string, url: JSON.parse(match[2]) as string })
    } catch {
      continue
    }
  }
  return pages
}

export function recordBrowserProfileObservation(profile: string, payload: unknown): void {
  try {
    const name = String(profile || '').trim()
    if (!name) return
    const pages = observedPagesIn(payload)
    if (!pages.length) return
    const file = observationLedgerPath()
    const ledger = readLedger(file)
    const existing = ledger[name]
    const forProfile: Dict = isDict(existing) ? existing : {}
    let changed = false
    for (const { title, url } of pages) {
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        continue
      }
      const state = CHALLENGE_TITLE_MARKERS.test(title)
        ? 'challenged'
        : SIGNIN_URL_MARKERS.test(url)
          ? 'signin-wall'
          : 'reached'
      forProfile[host] = { state, title: title.slice(0, 120), at: new Date().toISOString() }
      changed = true
    }
    if (!changed) return
    ledger[name] = forProfile
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(ledger, null, 2))
    renameSync(tmp, file)
  } catch {
    // The ledger is a convenience: a failed write never fails the tool call that produced the page.
  }
}

export async function observeProfile(name: string, cwd: string | undefined, reply: ToolReply): Promise<void> {
  try {
    const text = typeof reply === 'string' ? reply : reply.text
    const { key } = await profileLocation(name, cwd)
    recordBrowserProfileObservation(key, text)
  } catch {
    // Same as the write itself: a profile that cannot be located is simply not recorded.
  }
}
