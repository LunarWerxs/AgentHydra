// Which Hydra Desk account already holds a session run outside it (ExternalSession.accountId), and
// whether the composer can carry it on (canResume).
//
// WHAT WAS FOUND (2026-10-04, read-only GETs on AgentHydra, file metadata, and one real resume between
// two CLI instances). Claude Desktop's Code sessions do not write into the desktop instance's own
// folder: all 14 desktop-hosted live sessions had their transcript under the machine's default
// ~/.claude, whatever instance hosted them. The SDK cannot borrow a desktop's token, and the default
// ~/.claude login's own CLI token is not one to rely on (its refresh failed: "OAuth session expired
// and could not be refreshed"), so a Desktop session is never resumed in place under 'default'.
//
// A session is a file, so it continues anywhere its transcript is copied (seed-session.ts):
//   - a session whose transcript already sits in a signed-in CLI instance's folder (a terminal
//     session on that instance, a CliMayte worker's) continues there in place: accountId names it;
//   - every other idle Claude Code session (Desktop's included) continues as a copy under the account
//     the window lands it on, the Settings default or Auto's pick: accountId is null.

import { resolve } from 'node:path'
import type { ExternalSession } from '@shared/protocol'
import type { AhCliInstance } from './client'

export interface Login {
  uuid: string | null
  email: string | null
}

export interface DesktopLogin extends Login {
  num: number
  name: string
  label: string | null
  dir: string
}

export interface ResumeData {
  desktops: DesktopLogin[]
  clis: AhCliInstance[]
}

/** What mapExternal knows about one session when it asks. */
export interface ResumeQuery {
  source: ExternalSession['source']
  instance: string | null
  instanceNum: number | null
  /** The folder its transcript lives under (the part before /projects/), when the live registry says. */
  configRoot: string | null
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
const samePath = (a: string, b: string): boolean => norm(resolve(a)).replace(/[\\/]+$/, '') === norm(resolve(b)).replace(/[\\/]+$/, '')

export function sameLogin(a: Login | null, b: Login | null): boolean {
  if (!a || !b) return false
  if (a.uuid && b.uuid) return a.uuid === b.uuid
  return !!norm(a.email) && norm(a.email) === norm(b.email)
}

/** A CLI instance as a login: its latest usage reading names the account, unless it signed out since. */
export function cliLogin(c: AhCliInstance): Login | null {
  if (!c.loggedIn || c.lastUsageCheck?.signedOutAt) return null
  return { uuid: null, email: c.lastUsageCheck?.account ?? null }
}

/** The folder a transcript path lives under: '<root>/projects/<slug>/<id>.jsonl' -> '<root>'. */
export function configRootOf(transcriptPath: string | null | undefined): string | null {
  if (!transcriptPath) return null
  const m = /^(.*?)[\\/]projects[\\/]/.exec(transcriptPath)
  return m ? m[1]! : null
}

function findDesktop(desktops: DesktopLogin[], instance: string | null): DesktopLogin | null {
  const want = norm(instance)
  if (!want) return null
  const num = /^#?(\d+)$/.exec(want)?.[1]
  return desktops.find((d) => (num ? d.num === Number(num) : norm(d.name) === want || norm(d.label) === want)) ?? null
}

/** The signed-in CLI instance whose folder holds this session (it continues there in place), or null. */
export function resumeAccount(q: ResumeQuery, data: ResumeData): string | null {
  if (q.source === 'desktop') {
    const desktop = findDesktop(data.desktops, q.instance)
    const root = q.configRoot
    if (!desktop || !root) return null
    return data.clis.find((c) => samePath(c.configDir, root) && sameLogin(cliLogin(c), desktop))?.id ?? null
  }
  if (q.source === 'cli') {
    const cli = q.configRoot ? data.clis.find((c) => samePath(c.configDir, q.configRoot!)) : q.instanceNum !== null ? data.clis.find((c) => c.num === q.instanceNum) : undefined
    return cli && cliLogin(cli) ? cli.id : null
  }
  return null
}

/** Idle there and a Claude Code session: the composer carries it on, in place or as a copy. */
export function canResume(s: Pick<ExternalSession, 'status' | 'source'>): boolean {
  return (s.status === 'idle' || s.status === 'stale') && (s.source === 'desktop' || s.source === 'cli')
}
