// server/src/core/desktop-cli-feed.ts — a CLI instance linked to a desktop instance takes its login
// from the desktop login, so one sign-in (the desktop's) serves both.
//
// WHY (owner, 2026-10-01): "If I log into desktop, can it auto-log into CLI? ... to save me from
// having to do both individually". Checked on real logins, by field names and lifetimes only: a
// desktop token cache holds a grant with the Claude Code scopes (`user:inference user:file_upload
// user:profile user:sessions:claude_code`), an access token good for weeks. A `.credentials.json`
// made from it (access token, expiry, scopes, plan; NO refresh token) passes `claude auth status`
// and answers `/usage` from Anthropic (run 2026-10-01 against a scratch config dir). The other way
// round cannot work: a desktop sign-in also needs the claude.ai browser cookie and grants a CLI
// login never has.
//
// THE RULES
// - Only a CLI instance LINKED to a desktop instance (linkCliInstanceToDesktop: "Add a CLI login…"
//   on the desktop row) is fed, and only while it has no login of its own: a credential with a
//   refresh token is a real CLI sign-in and is never touched.
// - No refresh token is copied. The desktop app owns that one; a CLI that refreshed with it would
//   rotate it and sign the desktop out. The fed login lasts as long as the grant (weeks) and is
//   replaced whenever the desktop app renews its own, so a desktop instance left closed past the
//   grant's expiry leaves its CLI login expired until it is opened once.
// - A Log out of a fed CLI instance cuts the link (routes/usage.ts), so the feed does not sign it
//   straight back in.
//
// ⛔ SECRETS: the token goes from one of the owner's files to another and is never logged.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { listCliInstances } from './cli-instances'
import { credPath } from './cli-login-move'
import { pairDesktopCliLogins } from './desktop-cli-pairing'
import { readDesktopTokens } from './desktop-login-sync'

const CLAUDE_CODE_SCOPE = 'user:sessions:claude_code'
/** A grant this close to its end is not worth writing: the CLI would open on an expired login. */
const MIN_LEFT_MS = 10 * 60_000
export const FEED_EVERY_MS = 60_000

interface CliOauth {
  accessToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
  refreshToken?: string
}

/** The desktop token cache's Claude Code grant as a CLI credential, the longest-lived one that has
 *  time left; null when the cache holds none. */
export function cliCredentialFromDesktop(tokenCache: string, now = Date.now()): CliOauth | null {
  let grants: Record<string, Record<string, unknown>>
  try {
    grants = JSON.parse(tokenCache) as Record<string, Record<string, unknown>>
  } catch {
    return null
  }
  let best: CliOauth | null = null
  for (const [key, g] of Object.entries(grants ?? {})) {
    if (!key.includes(CLAUDE_CODE_SCOPE) || typeof g?.token !== 'string' || !g.token) continue
    const expiresAt = Number(g.expiresAt) || 0
    if (expiresAt - now < MIN_LEFT_MS || (best && best.expiresAt >= expiresAt)) continue
    best = {
      accessToken: g.token,
      expiresAt,
      scopes: key.match(/user:[a-z_:]+/g) ?? [],
      subscriptionType: typeof g.subscriptionType === 'string' ? g.subscriptionType : null,
      rateLimitTier: typeof g.rateLimitTier === 'string' ? g.rateLimitTier : null,
    }
  }
  return best
}

function readCredentials(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether this config dir's login is its own sign-in (it can refresh itself). */
export function hasOwnCliLogin(configDir: string): boolean {
  const own = readCredentials(credPath(configDir))?.claudeAiOauth as CliOauth | undefined
  return typeof own?.refreshToken === 'string' && own.refreshToken.length > 0
}

export type FeedResult = 'fed' | 'current' | 'own-login' | 'no-desktop-login' | 'not-linked'

/** Give one linked CLI instance its desktop instance's login (see the header). */
export async function feedCliFromDesktop(cli: {
  configDir: string
  associatedDesktopDir?: string | null
}): Promise<FeedResult> {
  if (!cli.associatedDesktopDir) return 'not-linked'
  if (hasOwnCliLogin(cli.configDir)) return 'own-login'
  const tokens = existsSync(cli.associatedDesktopDir)
    ? await readDesktopTokens(cli.associatedDesktopDir)
    : null
  const cred = tokens?.v2 ? cliCredentialFromDesktop(tokens.v2) : null
  if (!cred) return 'no-desktop-login'
  const path = credPath(cli.configDir)
  const file = readCredentials(path) ?? {}
  if ((file.claudeAiOauth as CliOauth | undefined)?.accessToken === cred.accessToken)
    return 'current'
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ ...file, claudeAiOauth: cred }))
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
  return 'fed'
}

/** Feed every linked CLI instance; how many logins were written. Never throws. */
export async function feedLinkedCliLogins(): Promise<number> {
  let fed = 0
  for (const cli of listCliInstances()) {
    if (!cli.associatedDesktopDir) continue
    try {
      if ((await feedCliFromDesktop(cli)) === 'fed') fed++
    } catch {
      // one unreadable profile must not stop the rest
    }
  }
  return fed
}

/** One timer pass: pair any new signed-in desktop with a CLI instance (core/desktop-cli-pairing.ts),
 *  then feed, so a CLI instance made now is signed in in the same pass. */
async function feedPass(): Promise<number> {
  await pairDesktopCliLogins()
  return feedLinkedCliLogins()
}

let timer: ReturnType<typeof setInterval> | null = null
/** Start the feed (daemon boot): now-ish, then every FEED_EVERY_MS. */
export function startDesktopCliFeed(): void {
  if (timer || process.platform !== 'win32') return
  // A pass that throws is logged, never left to reject: an unhandled rejection from a timer can
  // take the daemon down (scripts/checks/timer-callback-can-kill-the-daemon.mjs).
  timer = setInterval(
    () => void feedPass().catch((err) => console.error('[desktop-cli-feed] pass failed:', err)),
    FEED_EVERY_MS,
  )
  timer.unref?.()
  setTimeout(
    () => void feedPass().catch((err) => console.error('[desktop-cli-feed] pass failed:', err)),
    20_000,
  ).unref?.()
}

/** Stop the feed (daemon shutdown). */
export function stopDesktopCliFeed(): void {
  if (timer) clearInterval(timer)
  timer = null
}
