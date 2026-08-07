// server/src/core/instance-numbers.ts — the permanent short NUMBER every instance is known by.
//
// WHY this exists: nothing an instance already carries is usable as a spoken/typed handle.
// A desktop instance is identified by its FOLDER (`C:\Users\me\.claude-instances\3claude`), a CLI
// or Codex instance by a random `crypto.randomUUID()`. Neither is something you can say out loud,
// and the folder name is actively misleading the moment a profile is signed into a different
// account than the one it was named after (this machine has exactly that: the folder `3claude`
// is labelled "4claude" and vice versa). So "check instance 7's usage" had no way to be said.
//
// A number fixes that: `#7` is short, unambiguous, stable, and the same string in the UI, in the
// REST API and in the MCP tools — which is the whole point, since the human reads it off the
// Instances table and an AI on the other end has to resolve it to a credential.
//
// GUARANTEES
//   * Assigned once, on first sight, and then PERMANENT. Never reused, never renumbered — a number
//     freed by a deleted instance stays retired, because the entire value of the handle is that
//     "instance 7" means the same account tomorrow as it did when it was written into a prompt.
//   * Unique across ALL kinds (desktop / CLI / Codex share one sequence), so a bare `7` never needs
//     a kind alongside it to be unambiguous.
//   * Deterministic on a cold start: an empty registry numbers a whole fleet in sorted-ref order,
//     not in whatever order the lister happened to walk the disk.
//
// Keyed by REF — `desktop:<normalized dir>` / `cli:<id>` / `codex:<id>`, deliberately the same
// shape usage-service.ts already uses for its cache keys, so the two are readable side by side in
// a debug dump. (Duplicated here rather than imported: core/ must not depend on the service layer.)
//
// Best-effort persistence, like instance-meta.ts: a missing or corrupt file reads as empty and an
// unwritable dir loses the write, but never throws into a list call.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appDataDir, instanceNumbersFile, normalizeInstancePath } from './paths'

/** Which family of instance a number points at. One sequence spans all three. */
export type InstanceKind = 'desktop' | 'cli' | 'codex'

/** The stable string key a number is attached to: `desktop:<dir>` | `cli:<id>` | `codex:<id>`. */
export type InstanceRef = string

/** Build the registry key for an instance. Desktop dirs are normalized because the same folder
 *  reaches this spelled several ways (`C:\Users\…`, `c:\users\…`, `C:/Users/…`) and each spelling
 *  would otherwise claim its own number. */
export function instanceRef(kind: InstanceKind, id: string): InstanceRef {
  return kind === 'desktop' ? `desktop:${normalizeInstancePath(id)}` : `${kind}:${id}`
}

/** Split a ref back into its parts. Returns null for anything unrecognized. */
export function parseInstanceRef(ref: string): { kind: InstanceKind; id: string } | null {
  const idx = ref.indexOf(':')
  if (idx <= 0) return null
  const kind = ref.slice(0, idx)
  const id = ref.slice(idx + 1)
  if (!id) return null
  if (kind === 'desktop' || kind === 'cli' || kind === 'codex') return { kind, id }
  return null
}

interface RegistryFile {
  /** The next number to hand out. Monotonic; never decreases, even as instances are deleted. */
  next: number
  /** ref -> number. */
  byRef: Record<InstanceRef, number>
}

/** A fresh registry. Built per call rather than shared, so a caller mutating what it gets back can
 *  never poison the next read with a half-filled "empty". */
const empty = (): RegistryFile => ({ next: 1, byRef: {} })

function read(): RegistryFile {
  try {
    const file = instanceNumbersFile()
    if (!existsSync(file)) return empty()
    const raw = readFileSync(file, 'utf8')
    if (!raw?.trim()) return empty()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return empty()
    const source = (parsed as { byRef?: unknown }).byRef
    const byRef: Record<string, number> = {}
    let highest = 0
    if (source && typeof source === 'object') {
      for (const [ref, value] of Object.entries(source as Record<string, unknown>)) {
        const n = typeof value === 'number' ? Math.floor(value) : Number.NaN
        // Drop anything that is not a usable positive integer rather than letting a corrupt row
        // hand out `NaN` as a number forever.
        if (!Number.isFinite(n) || n < 1) continue
        if (!parseInstanceRef(ref)) continue
        byRef[ref] = n
        if (n > highest) highest = n
      }
    }
    const storedNext = (parsed as { next?: unknown }).next
    const next =
      typeof storedNext === 'number' && storedNext > highest ? Math.floor(storedNext) : highest + 1
    return { next, byRef }
  } catch {
    return empty()
  }
}

function write(reg: RegistryFile): void {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = instanceNumbersFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(reg, null, 2))
    renameSync(tmp, file)
  } catch {
    // Best-effort. A lost write costs at most a renumber on the next boot, and the in-memory
    // values already returned to the caller stay coherent for this process's lifetime.
  }
}

/**
 * Get the numbers for a whole fleet at once, assigning one to anything not yet known.
 *
 * BULK on purpose: `listInstances()` runs on a timer over ~14 instances, and a per-instance
 * get-or-assign would read and rewrite the registry file 14 times per refresh. This does one read
 * and — only when something is genuinely new — one write.
 *
 * New refs are sorted before being numbered so a cold start (or a fresh machine restoring a
 * backup) produces the same numbering every time rather than one that depends on directory
 * enumeration order.
 */
export function instanceNumbers(refs: InstanceRef[]): Map<InstanceRef, number> {
  const reg = read()
  const fresh = [...new Set(refs)].filter((r) => reg.byRef[r] === undefined).sort()
  if (fresh.length > 0) {
    for (const ref of fresh) {
      reg.byRef[ref] = reg.next
      reg.next += 1
    }
    write(reg)
  }
  const out = new Map<InstanceRef, number>()
  for (const ref of refs) {
    const n = reg.byRef[ref]
    if (n !== undefined) out.set(ref, n)
  }
  return out
}

/** One instance's number, assigning it if this is the first sighting. */
export function instanceNumberFor(kind: InstanceKind, id: string): number {
  const ref = instanceRef(kind, id)
  return instanceNumbers([ref]).get(ref) ?? 0
}

/** The ref a number points at, or null if that number was never handed out. Retired numbers (the
 *  instance has since been deleted) still resolve here — the caller decides what a ref with no
 *  live instance behind it means. */
export function refForNumber(
  num: number,
): { kind: InstanceKind; id: string; ref: InstanceRef } | null {
  if (!Number.isFinite(num) || num < 1) return null
  const reg = read()
  for (const [ref, n] of Object.entries(reg.byRef)) {
    if (n !== num) continue
    const parsed = parseInstanceRef(ref)
    return parsed ? { ...parsed, ref } : null
  }
  return null
}

/** The whole registry, ref -> number. For diagnostics and the fleet listing. */
export function allInstanceNumbers(): Record<InstanceRef, number> {
  return read().byRef
}
