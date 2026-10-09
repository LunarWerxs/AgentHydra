// Closes the saved-browser pages a chat left behind. Every page a chat drives has a row in the profile's tab ledger
// (ownership.ts) naming the chat's Claude session. A chat's end (delete or archive) closes its rows' pages at once
// (closeChatTabs); a timer backstops that by closing the pages whose owner is dead (startTabSweep). Ported from
// Connections' browser engine (services/studio/local-mcp/browser.mjs: chatOwner, chatOwnerAlive, deadOwnerTargetIds,
// sweepDeadOwnerTabs, releaseOwnTabs). Pages with no row, and pages of a live owner, are never touched.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closePage, liveBrowser, pageTabs } from './cdp'
import { dropPage } from './ledger'
import { readLedger } from './ownership'
import { realDirs, storeRoot } from './store'

export const SWEEP_MS = 3 * 60_000

export type Liveness = (owner: string) => boolean | null

interface LedgerState {
  tabs: Record<string, { chat: string }>
  pages: { targetId: string }[]
}

/** The page ids to close: those whose owner `pick` names. The browser's last open page is never among them. */
function ownedTargetIds({ tabs, pages }: LedgerState, pick: (owner: string) => boolean): string[] {
  const hit = pages.filter((t) => {
    const entry = tabs[t.targetId]
    return entry !== undefined && pick(entry.chat)
  })
  if (hit.length && hit.length === pages.length) hit.pop()
  return hit.map((t) => t.targetId)
}

/** The pages whose owner is definitely dead (liveness false). */
export function deadOwnerTargetIds(state: LedgerState, liveness: Liveness): string[] {
  return ownedTargetIds(state, (owner) => liveness(owner) === false)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The config roots Claude Code writes <root>/sessions/<pid>.json into (as Connections' sessionFileRoots). */
export function sessionFileRoots(): string[] {
  const home = homedir()
  const roots: string[] = []
  const configured = String(process.env.CLAUDE_CONFIG_DIR || '').trim()
  if (configured) roots.push(configured)
  roots.push(join(home, '.claude'))
  for (const parent of [join(home, '.agenthydra', 'cli-instances'), join(home, '.claude-instances')]) {
    try {
      for (const name of readdirSync(parent)) roots.push(join(parent, name))
    } catch {
      // floor-ok: no such install on this machine
    }
  }
  return roots
}

/** true: a session file names this id under a live pid. false: the session dirs were readable and none does. null: none could be read. */
export function sessionOwnerLiveness(sessionId: string, roots: string[] = sessionFileRoots()): boolean | null {
  let judged = false
  for (const root of roots) {
    const dir = join(root, 'sessions')
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    judged = true
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      let parsed: { sessionId?: unknown; pid?: unknown }
      try {
        parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      } catch {
        continue
      }
      const pid = Number(parsed?.pid)
      if (parsed?.sessionId === sessionId && Number.isInteger(pid) && pid > 0 && String(pid) === file.slice(0, -5) && processAlive(pid)) return true
    }
  }
  return judged ? false : null
}

/**
 * Whether an owner is alive: a session of a Desk chat or an active CliMayte worker (`deskSessions`), a `pid:` owner's
 * process, or a session a live Claude process names. `mcp:` owners are judged by the Connections MCP's own server, which
 * this process cannot see, so they are never dead here.
 */
export function ownerLive(owner: string, deskSessions: ReadonlySet<string>, roots: string[] = sessionFileRoots()): boolean | null {
  if (deskSessions.has(owner)) return true
  const pid = /^pid:(\d+)$/.exec(owner)
  if (pid) return processAlive(Number(pid[1]))
  if (owner.startsWith('mcp:')) return null
  return sessionOwnerLiveness(owner, roots)
}

export function makeLiveness(deskSessions: ReadonlySet<string>, roots: string[] = sessionFileRoots()): Liveness {
  const memo = new Map<string, boolean | null>()
  return (owner) => {
    if (!memo.has(owner)) memo.set(owner, ownerLive(owner, deskSessions, roots))
    return memo.get(owner) ?? null
  }
}

export function profileFolders(root: string): string[] {
  const out = realDirs(root).map((n) => join(root, n))
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

/** Closes the pages of one profile's live Chrome whose owner `pick` names, and drops their rows. */
async function closeOwned(dir: string, port: number, pick: (owner: string) => boolean): Promise<number> {
  const rows = readLedger(dir)
  if (!rows.size) return 0
  const pages = (await pageTabs(port).catch(() => [])).filter((t) => !t.url.startsWith('devtools:'))
  const tabs = Object.fromEntries([...rows].map(([id, row]) => [id, { chat: row.chat }]))
  const ids = ownedTargetIds({ tabs, pages: pages.map((t) => ({ targetId: t.id })) }, pick)
  let closed = 0
  for (const id of ids) {
    if (await closePage(port, id).catch(() => false)) closed++
    dropPage(dir, id)
  }
  return closed
}

/** Closes the pages of every live profile whose owner is in `sessions` (a chat that ended), and drops their rows. */
export async function closeChatTabs(sessions: readonly string[], root: string = storeRoot()): Promise<number> {
  const chats = new Set(sessions)
  if (!chats.size) return 0
  let closed = 0
  for (const dir of profileFolders(root)) {
    const live = await liveBrowser(dir)
    if (live) closed += await closeOwned(dir, live.port, (owner) => chats.has(owner))
  }
  return closed
}

/** Closes the pages whose owner is dead in every live profile, and drops their rows. */
export async function sweepDeadOwnerTabs(liveness: Liveness, root: string = storeRoot()): Promise<number> {
  let closed = 0
  for (const dir of profileFolders(root)) {
    const live = await liveBrowser(dir)
    if (live) closed += await closeOwned(dir, live.port, (owner) => liveness(owner) === false)
  }
  return closed
}

/**
 * Runs the dead-owner sweep every `everyMs` (unref'd). `deskSessions` gives the sessions that are alive; it may throw,
 * and then nothing is closed. Returns the stop.
 */
export function startTabSweep(o: {
  deskSessions: () => Promise<ReadonlySet<string>>
  root?: string
  everyMs?: number
  log?: (msg: string, err: unknown) => void
}): () => void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await sweepDeadOwnerTabs(makeLiveness(await o.deskSessions()), o.root ?? storeRoot())
    } catch (err) {
      ;(o.log ?? ((m, e) => console.error(m, e)))('[desk] the browser tab sweep failed:', err)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), o.everyMs ?? SWEEP_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
