// server/src/core/login-history.ts — every account a desktop profile has been signed into.
//
// Nothing new is recorded for this: the profile keeps the history itself. Claude Desktop files each
// chat under `claude-code-sessions/<accountUuid>/<orgUuid>/local_<id>.json` (see login-state.ts)
// and never deletes the folder of an account that signs out, so the folder names ARE the accounts
// that used the profile, and the newest record in each says when that account was last busy there.
// What the profile does not keep is who a uuid is; core/known-accounts.ts remembers that.
//
// The answer to "#75 shows no account, where did it go?": the newest entry that is not `current`
// is the account the profile was on before, `signedInOn` names the instances holding it now, and
// `usedOn` the ones it passed through, which is the trail for an account nobody ever identified.

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { identityForAccount } from './accounts'
import { allInstanceNumbers, instanceRef, parseInstanceRef } from './instance-numbers'
import { readLoginState, readLoginUuid } from './login-state'
import { normalizePath } from './paths'
import type { CMLoginHistory, CMLoginHistoryEntry } from './shared'
import { prettyTier, resolvePlanLabel } from './shared'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Count, oldest and newest mtime of the chat records filed under one account folder. */
function recordSpan(accountDir: string): { chats: number; first: number; last: number } {
  let chats = 0
  let first = Number.POSITIVE_INFINITY
  let last = 0
  for (const org of subdirs(accountDir)) {
    const orgDir = path.join(accountDir, org)
    let names: string[] = []
    try {
      names = readdirSync(orgDir).filter((n) => n.startsWith('local_') && n.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const mtime = statSync(path.join(orgDir, name)).mtimeMs
        chats++
        first = Math.min(first, mtime)
        last = Math.max(last, mtime)
      } catch {
        // Moved or archived mid-scan; the rest still count.
      }
    }
  }
  return { chats, first, last }
}

const iso = (ms: number) => (ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null)

/** Where each account is and has been across the OTHER desktop instances, by number. */
interface Elsewhere {
  /** Signed in there now (config.json's lastKnownAccountUuid). */
  signedIn: Map<string, number[]>
  /** Has a chat-store folder there, so it was signed in there at some point. */
  used: Map<string, number[]>
}

/** One pass over every numbered desktop profile but this one: a small config.json read and one
 *  directory listing each. A deleted profile reads as signed out and unused, and drops out. */
function accountsElsewhere(self: string): Elsewhere {
  const selfRef = instanceRef('desktop', self)
  const signedIn = new Map<string, number[]>()
  const used = new Map<string, number[]>()
  const note = (map: Map<string, number[]>, uuid: string, num: number) =>
    map.set(
      uuid,
      [...(map.get(uuid) ?? []), num].sort((a, b) => a - b),
    )
  for (const [ref, num] of Object.entries(allInstanceNumbers())) {
    const parsed = parseInstanceRef(ref)
    if (ref === selfRef || parsed?.kind !== 'desktop') continue
    const uuid = readLoginUuid(parsed.id)
    if (uuid) note(signedIn, uuid, num)
    for (const folder of subdirs(path.join(parsed.id, 'claude-code-sessions'))) {
      if (UUID.test(folder)) note(used, folder, num)
    }
  }
  return { signedIn, used }
}

function entryFor(
  accountUuid: string,
  current: boolean,
  span: { chats: number; first: number; last: number },
  elsewhere: Elsewhere,
): CMLoginHistoryEntry {
  const who = identityForAccount(accountUuid)
  return {
    accountUuid,
    email: who?.email ?? null,
    name: who?.name ?? null,
    planLabel: who
      ? resolvePlanLabel(who.plan, prettyTier(who.rateLimitTier), who.orgType ?? null)
      : null,
    current,
    firstSeenAt: iso(span.first),
    lastSeenAt: iso(span.last),
    chats: span.chats,
    signedInOn: elsewhere.signedIn.get(accountUuid) ?? [],
    usedOn: elsewhere.used.get(accountUuid) ?? [],
  }
}

/**
 * The accounts that have used this profile: the signed-in one first, then the rest by when each
 * was last busy here, newest first. An account signed in that has not opened a chat yet still
 * appears (it is `current`), with no dates. Reads the profile only, never a token. Never throws.
 */
export function readLoginHistory(instanceDir: string): CMLoginHistory {
  const dir = normalizePath(instanceDir)
  const login = readLoginState(dir)
  const root = path.join(dir, 'claude-code-sessions')
  const elsewhere = accountsElsewhere(dir)
  const entries = subdirs(root)
    .filter((name) => UUID.test(name))
    .map((uuid) =>
      entryFor(uuid, uuid === login.uuid, recordSpan(path.join(root, uuid)), elsewhere),
    )
  if (login.uuid && !entries.some((e) => e.current)) {
    entries.push(entryFor(login.uuid, true, { chats: 0, first: 0, last: 0 }, elsewhere))
  }
  entries.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''),
  )
  return { dir, loginState: login.reason, entries }
}
