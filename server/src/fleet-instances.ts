// server/src/fleet-instances.ts - PIECE 4 of the orchestrator rebuild (owner-picked,
// 2026-08-29): account identity. Which instances exist, which is WHICH (the one question the
// owner named), whether each is running, and who each is signed in as.
//
// Same doctrine: deterministic, read-only, zero AI, and - deliberately - ZERO NETWORK. Identity
// comes from core/instances.ts's list (dir, permanent #num, label, loginUuid, pid) joined to
// core/accounts.ts's resolveAccount on its noNetwork path: config.json + the identity cache on
// disk, never a live API call. An observation read must not spend anything or block on the
// internet; the cache is refreshed by the surfaces that already do (the UI's account resolve).
// Re-login staleness is handled a layer DOWN, not here: resolveAccount's cache guard compares
// the cached identity's uuid against config.json's fresh lastKnownAccountUuid and DISCARDS a
// mismatched entry (accounts-stale-login.test.ts pins it), so an email this module reports is
// never a previous login's. The first cut carried an `identityStale` flag re-deriving that
// comparison up here; adversarial review proved it structurally unreachable - the layer below
// has already reconciled both sides - so it was removed rather than shipped dead.
//
// Starting and stopping instances is NOT this module's job: openInstance/quitInstance and their
// routes (/api/instances/:dir/open, /quit) already exist and are the tested primitives the
// lifecycle drill uses. Observation observes.

import { resolveAccount } from './core/accounts'
import { listInstances } from './core/instances'
import type { CMAccount, CMInstance } from './core/shared'

export interface FleetInstanceIdentity {
  status: CMAccount['status']
  email: string | null
  planLabel: string | null
  accountUuid: string | null
}

export interface FleetInstanceEntry {
  /** Permanent short handle (#7) - the one identifier a human says out loud. */
  num: number
  /** Folder name, and the display label when the owner set one. */
  name: string
  label: string | null
  dir: string
  /** The ref vocabulary the rest of the system speaks: 'desktop:<dir>'. */
  ref: string
  isRunning: boolean
  pid: number | null
  /** Which account is signed in RIGHT NOW (config.json, read fresh); null = signed out. */
  loginUuid: string | null
  signedIn: boolean
  /** Cached identity (email/plan) - null when never resolved. Token-free by construction,
   *  and never a previous login's (see the module header on re-login staleness). */
  account: FleetInstanceIdentity | null
}

/** The owner's account-tier order (2026-08-30, verbatim: "there are four types of accounts.
 *  free. pro. Max 5x. and Max 20x. We always will prefer the highest one. AKA Max 20x. and
 *  the lowest usage"): Max 20x > Max 5x > Max (family known, multiplier unknown) > Pro >
 *  everything else. Only the four he named are ranked; unlisted labels (Free, Team,
 *  Enterprise, unknown) rank together at the bottom rather than being guessed. Accepts the
 *  display '×' and a plain 'x' both, case-insensitively. */
export function planRank(planLabel: string | null | undefined): number {
  const l = (planLabel ?? '').toLowerCase()
  if (/max\s*20\s*[x×]/.test(l)) return 4
  if (/max\s*5\s*[x×]/.test(l)) return 3
  if (/\bmax\b/.test(l)) return 2
  if (/\bpro\b/.test(l)) return 1
  return 0
}

export interface FleetInstancesDeps {
  /** Seams for tests; defaults are the real list and the no-network account resolve. */
  list?: () => Promise<CMInstance[]>
  account?: (dir: string) => Promise<CMAccount>
}

/** Every known desktop instance, identified, ordered by permanent #num. */
export async function fleetInstances(deps: FleetInstancesDeps = {}): Promise<FleetInstanceEntry[]> {
  const list = deps.list ?? (() => listInstances())
  const account = deps.account ?? ((dir: string) => resolveAccount(dir, { noNetwork: true }))
  const instances = await list()
  const entries = await Promise.all(
    instances.map(async (i): Promise<FleetInstanceEntry> => {
      let acct: CMAccount | null = i.account
      if (!acct) {
        try {
          acct = await account(i.dir)
        } catch {
          acct = null
        }
      }
      const identity: FleetInstanceIdentity | null =
        acct && acct.status !== 'unknown'
          ? {
              status: acct.status,
              email: acct.email,
              planLabel: acct.planLabel,
              accountUuid: acct.accountUuid,
            }
          : null
      return {
        num: i.num,
        name: i.name,
        label: i.label,
        dir: i.dir,
        ref: `desktop:${i.dir}`,
        isRunning: i.isRunning,
        pid: i.pid,
        loginUuid: i.loginUuid,
        signedIn: i.loginUuid !== null,
        account: identity,
      }
    }),
  )
  entries.sort((a, b) => a.num - b.num)
  return entries
}
