// server/src/chat-settings-carry.ts - what a chat "was set to", carried across a migration.
//
// A desktop chat's settings live in its metadata record (`claude-code-sessions/<org>/<user>/
// local_*.json`): model, effort, the ultracode toggle (sessionSettings.ultracode), the Chrome
// permission mode, and the per-chat permission grants. The app's import (`claude://resume`) is a
// bare session id, so the record it creates in the target account carries none of them.
// Measured on 16 migrated chats (owner's PC, 2026-09-03): effort reset on 13, ultracode reset on 13,
// chromePermissionMode reset on 14, every one of them arriving as "manual / extra / ultracode off"
// - and the owner opening each one to put its settings back by hand.
//
// Two ways to carry them, chosen by whether the target app is RUNNING:
//   · running -> the app creates the record; we merge the carried settings onto it right where the
//     title and the bypass stamp are written, and remember them (db migrated_chat_settings) so the
//     standing sweep can put them back each time the running app re-saves its in-memory copy over
//     them. They take effect at that app's next start, exactly like the bypass stamp.
//   · closed  -> there is no app to fight. The record is written straight into the target's store,
//     as a near-copy of the source record, and the app finds it there, settings intact, when it
//     starts. This is the case the owner named: move to a closed account, open it, everything is
//     already right.
//
// NOT carried, on purpose:
//   · permissionMode - owner rule (Michael, 2026-08-28): every migrated chat is bypassPermissions,
//     stamped by session-launch.ts. Carrying the source's mode here would set up a tug-of-war with
//     that stamp and its sweep.
//   · enabledMcpTools / remoteMcpServersConfig - those ids name the SOURCE account's connectors;
//     the target account has its own set, and the app fills it in.
//   · identity, timestamps, error state, worktree bindings - the target record's own business.
//
// Pure functions first (tested without a store); the one filesystem helper picks the store leaf.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The settings a person sets on a chat and expects to keep. Order is documentation, not code. */
export const CARRIED_KEYS = [
  'model',
  'effort',
  'chromePermissionMode',
  'sessionSettings',
  'alwaysAllowedReasons',
  'sessionPermissionUpdates',
] as const
export type CarriedKey = (typeof CARRIED_KEYS)[number]
export type CarriedSettings = Partial<Record<CarriedKey, unknown>>

/** Keys of a source record that must NOT follow the chat into another account's store. */
export const COLD_IMPORT_DENYLIST = [
  'enabledMcpTools',
  'remoteMcpServersConfig',
  'remoteControlAutoEligible',
  'bridgeSessionIds',
  'worktreePath',
  'worktreeName',
  'error',
  'errorAt',
  'errorCategory',
  'priorErrorMark',
  'pendingSystemReminder',
  'indexedAt',
  'armedWorkAtQuit',
] as const

/** The carried subset of a record. Absent keys stay absent: a source with no `effort` says nothing
 *  about effort, and the target keeps whatever the app gives it. */
export function pickCarriedSettings(meta: Record<string, unknown>): CarriedSettings {
  const out: CarriedSettings = {}
  for (const k of CARRIED_KEYS) {
    if (meta[k] !== undefined && meta[k] !== null) out[k] = meta[k]
  }
  return out
}

/** `meta` with the carried settings written over it. `sessionSettings` is merged key by key, so a
 *  target-side flag the source never had survives. Returns a NEW object; never mutates. */
export function applyCarriedSettings(
  meta: Record<string, unknown>,
  carried: CarriedSettings,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta }
  for (const k of CARRIED_KEYS) {
    const v = carried[k]
    if (v === undefined) continue
    if (k === 'sessionSettings' && isPlainObject(v) && isPlainObject(out.sessionSettings)) {
      out.sessionSettings = { ...(out.sessionSettings as object), ...(v as object) }
    } else {
      out[k] = v
    }
  }
  return out
}

/** True when every carried setting already reads the same on `meta` - the sweep's "nothing to do". */
export function carriedSettingsMatch(
  meta: Record<string, unknown>,
  carried: CarriedSettings,
): boolean {
  for (const k of CARRIED_KEYS) {
    const want = carried[k]
    if (want === undefined) continue
    const have = meta[k]
    if (k === 'sessionSettings' && isPlainObject(want) && isPlainObject(have)) {
      for (const [sk, sv] of Object.entries(want as Record<string, unknown>)) {
        if (!sameJson((have as Record<string, unknown>)[sk], sv)) return false
      }
      continue
    }
    if (!sameJson(have, want)) return false
  }
  return true
}

/**
 * The record a closed target's store receives: the source record minus everything that names the
 * source account or a moment in its life, re-identified as an import-shaped chat
 * (`sessionId: local_<cliSessionId>`, the shape the app itself files imports under), visible,
 * titled. `now` is injected so the result is reproducible in tests.
 */
export function buildColdImportRecord(
  sourceMeta: Record<string, unknown>,
  cliSessionId: string,
  title: string,
  now: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(sourceMeta)) {
    if ((COLD_IMPORT_DENYLIST as readonly string[]).includes(k)) continue
    out[k] = v
  }
  out.sessionId = `local_${cliSessionId}`
  out.cliSessionId = cliSessionId
  out.isArchived = false
  out.title = title
  out.titleSource = 'tool'
  out.lastFocusedAt = now
  // Owner rule: every migrated chat is bypass, closed target included.
  out.permissionMode = 'bypassPermissions'
  return out
}

/**
 * The `<org>/<user>` leaf a new record belongs in, inside a profile's store: the leaf whose records
 * were touched most recently, which is the account that profile is signed into now (a profile that
 * has been signed into two accounts carries two leaves, and the stale one must not win). A profile
 * with no store at all, or a store with no leaf, returns null: the app has never signed in there,
 * and there is nowhere the app would look.
 */
export function chooseStoreLeaf(instanceDir: string): string | null {
  const store = join(instanceDir, 'claude-code-sessions')
  if (!existsSync(store)) return null
  let best: { dir: string; touched: number } | null = null
  let orgs: string[]
  try {
    orgs = readdirSync(store, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }
  for (const org of orgs) {
    let users: string[]
    try {
      users = readdirSync(join(store, org), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const user of users) {
      const dir = join(store, org, user)
      const touched = newestActivity(dir)
      if (!best || touched > best.touched) best = { dir, touched }
    }
  }
  return best?.dir ?? null
}

/** The latest lastActivityAt across a leaf's records, falling back to file mtimes, then to the
 *  leaf's own mtime so an empty leaf still ranks (a freshly signed-in profile has exactly that). */
function newestActivity(dir: string): number {
  let best = 0
  try {
    best = statSync(dir).mtimeMs
  } catch {
    return 0
  }
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('local_') && f.endsWith('.json'))
  } catch {
    return best
  }
  for (const f of files) {
    const p = join(dir, f)
    try {
      const meta = JSON.parse(readFileSync(p, 'utf8')) as { lastActivityAt?: unknown }
      const t = typeof meta.lastActivityAt === 'number' ? meta.lastActivityAt : statSync(p).mtimeMs
      if (t > best) best = t
    } catch {
      // one unreadable record says nothing about the leaf
    }
  }
  return best
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
