// server/src/fleet-instances.ts - PIECE 4 of the orchestrator rebuild (owner-picked,
// 2026-08-29): account identity. Which instances exist, which is WHICH (the one question the
// owner named), whether each is running, and who each is signed in as.
//
// Same doctrine: deterministic, read-only, zero AI, and - deliberately - ZERO NETWORK. Identity
// comes from core/instances.ts's list (dir, permanent #num, label, loginUuid, pid) joined to
// core/accounts.ts's resolveAccount on its noNetwork path: config.json + the identity cache on
// disk, never a live API call. An observation read must not spend anything or block on the
// internet; the cache is refreshed by the surfaces that already do (the UI's account resolve).
// A cache-path identity can therefore be stale after a re-login - which is exactly what
// `loginUuid` exists to expose: it is read fresh from config.json every list, so
// `identityStale: true` (loginUuid != account.accountUuid) says "this instance was re-logged
// into a DIFFERENT account than the cached identity describes" - reported, never hidden.
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
  /** Cached identity (email/plan) - null when never resolved. Token-free by construction. */
  account: FleetInstanceIdentity | null
  /** True when the fresh loginUuid disagrees with the cached identity's accountUuid: the
   *  instance was re-logged into a different account than `account` describes. */
  identityStale: boolean
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
        identityStale:
          i.loginUuid !== null &&
          identity?.accountUuid != null &&
          identity.accountUuid !== i.loginUuid,
      }
    }),
  )
  entries.sort((a, b) => a.num - b.num)
  return entries
}
