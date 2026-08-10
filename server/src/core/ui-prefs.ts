// server/src/core/ui-prefs.ts — the handful of UI preferences that must agree across WINDOWS.
//
// The quick-instances window normally opens on the running daemon's own port, so it shares the full
// manager's localStorage and needs nothing from here. But when no daemon is running, the quick
// launcher starts its own tiny server on a DIFFERENT port (INSTANCE_MODE_PORT, see
// server/src/instance-mode.ts) — and a browser scopes localStorage to scheme+host+PORT. Same
// machine, same user, same app, different origin: the usage filter you set in the full manager
// simply is not there. Persisting these few keys server-side is what makes "it remembered how I had
// it set" true in both cases, and across a reinstall of the browser profile besides.
//
// Deliberately a FLAT STRING MAP rather than a typed settings object, and it is the whole design:
//  * The client mirrors its own storage keys verbatim, in vueuse's own wire format (String() for
//    booleans and numbers alike), so a value round-trips through here byte-identical to what
//    useStorage would have written. No parse/serialize pair to keep in sync, and no second
//    definition of what a threshold is.
//  * Adding a preference later is a web-only change. The server never learns what these mean.
//
// It is NOT a general key-value store for the frontend, and the caps below are what keep it from
// becoming one: a bounded number of bounded values under one namespace. Nothing here is a secret,
// nothing here is authoritative over server settings (those live in /api/settings), and a totally
// absent or corrupt file just means "no preference recorded yet".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appDataDir, uiPrefsFile } from './paths'

/** Mirrored UI preferences: storage key → value, exactly as the browser would store it. */
export type UiPrefs = Record<string, string>

/** Only this app's own namespaced keys. Anything else is not ours to hold. */
const KEY_PATTERN = /^agenthydra\.[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Three times what the client mirrors today (the usage mode, both filter windows and their
 *  thresholds, the open tab, three table collapse states, the sessions filters, the sidebar width),
 *  so a new preference is a web-only change for a long time yet — and small enough that a buggy
 *  client cannot turn this into a database. Writes beyond the cap are dropped, not rejected: a
 *  preference file is best-effort by nature and failing a settings write over a quota is worse
 *  than quietly keeping the ones that fit. */
const MAX_KEYS = 64
/** A mirrored value is a number, a boolean or a short enum — never a document. */
const MAX_VALUE_LENGTH = 256

function isMirrorable(key: string, value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VALUE_LENGTH && KEY_PATTERN.test(key)
}

/** Keep only well-formed, in-namespace, in-budget entries. Used on BOTH read and write, so a file
 *  hand-edited into a bad shape degrades to the defaults rather than reaching the UI. */
function sanitize(raw: unknown): UiPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: UiPrefs = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_KEYS) break
    if (!isMirrorable(key, value)) continue
    out[key] = value
    kept += 1
  }
  return out
}

/** Every mirrored preference. Never throws; an unreadable or corrupt file reads as "none set". */
export function readUiPrefs(): UiPrefs {
  try {
    const file = uiPrefsFile()
    if (!existsSync(file)) return {}
    const raw = readFileSync(file, 'utf8')
    if (!raw?.trim()) return {}
    return sanitize(JSON.parse(raw))
  } catch {
    return {}
  }
}

/**
 * Merge `patch` into the stored preferences and persist atomically (temp file + rename, matching
 * core/instance-meta.ts). Returns the resulting map so the caller can echo it back and the client
 * can absorb exactly what was kept rather than assuming its write survived.
 *
 * A key whose patch value is `null` is REMOVED — that is how a client says "I no longer have an
 * opinion about this", which is distinct from writing an empty string.
 */
export function writeUiPrefs(patch: Record<string, unknown>): UiPrefs {
  const merged = readUiPrefs()
  for (const [key, value] of Object.entries(patch)) {
    if (!KEY_PATTERN.test(key)) continue
    if (value === null) {
      delete merged[key]
      continue
    }
    if (!isMirrorable(key, value)) continue
    // An existing key may always be updated; only NEW keys are subject to the budget, so a full
    // file can still have its recorded preferences changed.
    if (!(key in merged) && Object.keys(merged).length >= MAX_KEYS) continue
    merged[key] = value
  }

  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = uiPrefsFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2))
    renameSync(tmp, file)
  } catch {
    // Best-effort: a preference that fails to persist still applies to the running window.
  }

  return merged
}
