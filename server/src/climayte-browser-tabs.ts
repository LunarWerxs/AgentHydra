// Closes the browser tabs a CliMayte worker opened in the Connections profiles once it has ended.
// The MCP's ledger (`.connections-tabs.json` beside each profile) names each tab's owning session.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_PROFILES_ROOT = join(homedir(), '.connections', 'browser-profiles')

const LEDGER = '.connections-tabs.json'
const TIMEOUT_MS = 2_000
const ENDED = new Set(['done', 'failed', 'cancelled'])

export interface TabsWorker {
  id: string
  status: string
  question?: unknown
  sessionId?: string | null
  attempts: { sessionId?: string | null }[]
}

type Ledger = Record<string, { chat?: unknown } | undefined>

export function endedForGood(w: Pick<TabsWorker, 'status' | 'question'>): boolean {
  return ENDED.has(w.status) && !w.question
}

export function sessionIdsOf(w: Pick<TabsWorker, 'sessionId' | 'attempts'>): string[] {
  const ids = [w.sessionId, ...w.attempts.map((a) => a.sessionId)]
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

function profileDirs(root: string): string[] {
  const out: string[] = []
  const ws = join(root, 'ws')
  if (!existsSync(ws)) return out
  for (const workspace of readdirSync(ws, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const wsDir = join(ws, workspace.name)
    for (const profile of readdirSync(wsDir, { withFileTypes: true })) {
      if (profile.isDirectory()) out.push(join(wsDir, profile.name))
    }
  }
  return out
}

function readLedger(file: string): Ledger | null {
  try {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
    const tabs = (JSON.parse(text) as { tabs?: unknown }).tabs
    return tabs && typeof tabs === 'object' ? (tabs as Ledger) : null
  } catch {
    return null
  }
}

function devToolsPort(profileDir: string): number | null {
  try {
    const first = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]
    const port = Number(first?.trim())
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function closeInProfile(port: number, ledger: Ledger, chats: Set<string>): Promise<number> {
  const base = `http://127.0.0.1:${port}`
  try {
    await getJson(`${base}/json/version`)
    const targets = (await getJson(`${base}/json/list`)) as { id?: unknown; type?: unknown }[]
    const mine = targets.flatMap((t) => {
      if (t.type !== 'page' || typeof t.id !== 'string') return []
      if (!Object.hasOwn(ledger, t.id)) return []
      const chat = ledger[t.id]?.chat
      return typeof chat === 'string' && chats.has(chat) ? [t.id] : []
    })
    const results = await Promise.all(
      mine.map((id) =>
        fetch(`${base}/json/close/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }).then((res) => res.ok),
      ),
    )
    return results.filter(Boolean).length
  } catch {
    return 0
  }
}

export async function closeChatTabs(
  sessionIds: string[],
  root: string = DEFAULT_PROFILES_ROOT,
): Promise<number> {
  const chats = new Set(sessionIds)
  if (!chats.size) return 0
  const counts = await Promise.all(
    profileDirs(root).map(async (dir) => {
      const ledger = readLedger(join(dir, LEDGER))
      const port = ledger ? devToolsPort(dir) : null
      return ledger && port !== null ? closeInProfile(port, ledger, chats) : 0
    }),
  )
  return counts.reduce((sum, n) => sum + n, 0)
}

export async function closeWorkerTabs(
  w: TabsWorker,
  root: string = DEFAULT_PROFILES_ROOT,
): Promise<number> {
  if (!endedForGood(w)) return 0
  try {
    return await closeChatTabs(sessionIdsOf(w), root)
  } catch (err) {
    console.error(`[climayte] ${w.id}: could not close its browser tabs:`, err)
    return 0
  }
}
