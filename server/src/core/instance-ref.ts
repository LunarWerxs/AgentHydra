// server/src/core/instance-ref.ts — turn whatever a human or an AI typed into ONE real instance.
//
// The number registry (instance-numbers.ts) is deliberately dumb: ref <-> integer, nothing else.
// This module is the layer above it that knows about the three instance families, and it exists so
// there is exactly ONE resolution rule shared by the REST route, the MCP tools and the queue's
// `instance_ref` field. Every caller accepts the same spellings, and a change to what counts as a
// valid reference happens in one place.
//
// Accepted spellings, in the order they are tried:
//   7 · "7" · "#7"                 the permanent number — the spoken handle this all exists for
//   "desktop:<dir>" · "cli:<id>"   an explicit ref (what the queue stores, what usage caches key on)
//   "<uuid>" · "default"           a bare CLI/Codex instance id
//   "C:\…\.claude-instances\x"     a desktop instance directory
//   "4claude"                      a name or label, case-insensitive, if it matches exactly one
//
// A name is tried LAST and only accepted when unambiguous: labels are user-editable and two
// instances may share the account name they default to, so a name that matches two rows resolves to
// nothing rather than to a coin flip. The number never has that problem, which is the argument for
// preferring it in anything written down.

import { resolveAccount } from './accounts'
import { listCliInstances } from './cli-instances'
import { listCodexInstances } from './codex-instances'
import { type InstanceKind, instanceRef, refForNumber } from './instance-numbers'
import { listInstances } from './instances'
import { normalizeInstancePath } from './paths'

/** One instance, flattened to the fields any caller needs to act on or display it. */
export interface ResolvedInstance {
  /** The permanent number (`#7`). */
  num: number
  kind: InstanceKind
  /** The handle the existing per-kind routes/tools take: a DIR for desktop, an ID for cli/codex. */
  handle: string
  /** `desktop:<dir>` | `cli:<id>` | `codex:<id>` — the registry/usage-cache key and the value the
   *  queue's `instance_ref` column stores. */
  ref: string
  /** What the UI calls it: user label, else account name, else folder/instance name. */
  name: string
  /** The account this instance is signed into, when it is known without a network call. */
  email: string | null
  plan: string | null
  /** Where its credentials live: the desktop user-data dir, the CLAUDE_CONFIG_DIR, or CODEX_HOME.
   *  This is what a usage check ultimately reads. */
  configDir: string
  loggedIn: boolean
  /** Desktop/Codex-desktop only: whether a window is up right now. Null when not applicable. */
  isRunning: boolean | null
}

/** Every instance across all three families, numbered, in number order. */
export async function listAllInstances(): Promise<ResolvedInstance[]> {
  // `noNetwork` identity: reads the already-resolved instances-cache.json and never decrypts or
  // calls out. That matters because this listing is the cheap lookup every other tool funnels
  // through — "who is #7" must not cost a round trip per instance.
  const [desktops, codexes] = await Promise.all([
    listInstances({
      includeAccount: true,
      includeSize: false,
      resolveAccount: (dir) => resolveAccount(dir, { noNetwork: true }),
    }),
    listCodexInstances(),
  ])
  const clis = listCliInstances()
  const desktopByDir = new Map(desktops.map((d) => [normalizeInstancePath(d.dir), d]))

  const rows: ResolvedInstance[] = []

  for (const inst of desktops) {
    rows.push({
      num: inst.num,
      kind: 'desktop',
      handle: inst.dir,
      ref: instanceRef('desktop', inst.dir),
      name: inst.label ?? inst.account?.name ?? inst.name,
      email: inst.account?.email ?? null,
      plan: inst.account?.planLabel ?? null,
      configDir: inst.dir,
      // `loginUuid` is config.json's lastKnownAccountUuid, read on every list — present means a
      // login is on file, which is the cheapest honest answer available without touching a token.
      loggedIn: inst.loginUuid !== null,
      isRunning: inst.isRunning,
    })
  }

  for (const inst of clis) {
    // A CLI login and the desktop instance it is LINKED to are the same Anthropic account with two
    // auth stores (see usage-service.ts), so the linked instance's resolved identity is this row's
    // identity too. Without this, every CLI row would report a null email — the exact question
    // ("which account is #9?") the number is supposed to answer.
    const linked = inst.associatedDesktopDir
      ? (desktopByDir.get(normalizeInstancePath(inst.associatedDesktopDir)) ?? null)
      : null
    rows.push({
      num: inst.num,
      kind: 'cli',
      handle: inst.id,
      ref: instanceRef('cli', inst.id),
      name: inst.name,
      email: linked?.account?.email ?? null,
      plan: linked?.account?.planLabel ?? null,
      configDir: inst.configDir,
      loggedIn: inst.loggedIn,
      isRunning: null,
    })
  }

  for (const inst of codexes) {
    rows.push({
      num: inst.num,
      kind: 'codex',
      handle: inst.id,
      ref: instanceRef('codex', inst.id),
      name: inst.name,
      email: inst.account?.email ?? null,
      plan: inst.account?.planLabel ?? null,
      configDir: inst.codexHome,
      loggedIn: inst.loggedIn,
      isRunning: inst.isDesktopRunning,
    })
  }

  return rows.sort((a, b) => a.num - b.num)
}

/**
 * Which instance owns a given credential directory — the reverse lookup that lets a running agent
 * answer "WHICH one am I?".
 *
 * A Claude Code process launched as CLI instance #9 has `CLAUDE_CONFIG_DIR` set to that instance's
 * config dir and knows nothing else about itself; a Codex process has `CODEX_HOME`. Matching that
 * one env var back to a row is what turns "check your usage" into a check of the RIGHT account.
 * Returns null for the plain `~/.claude` login, which belongs to no managed instance.
 */
export async function instanceForConfigDir(configDir: string): Promise<ResolvedInstance | null> {
  if (!configDir?.trim()) return null
  const wanted = normalizeInstancePath(configDir)
  return (
    (await listAllInstances()).find((r) => normalizeInstancePath(r.configDir) === wanted) ?? null
  )
}

/** Parse `7`, `"7"` or `"#7"` into a number. Null for anything else — including `"7claude"`, which
 *  must fall through to the name match rather than being read as instance 7. */
export function parseInstanceNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isInteger(input) && input > 0 ? input : null
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/^#/, '')
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 10)
  return n > 0 ? n : null
}

/**
 * Resolve any accepted spelling to one live instance, or null.
 *
 * `null` means "no LIVE instance", which is not the same as "never existed": a number belonging to
 * a deleted instance still resolves in the registry but has nothing behind it, and the caller
 * should say so rather than silently acting on a different row.
 */
export async function resolveInstance(input: unknown): Promise<ResolvedInstance | null> {
  const all = await listAllInstances()

  const num = parseInstanceNumber(input)
  if (num !== null) {
    const direct = all.find((r) => r.num === num)
    if (direct) return direct
    // The number is known to the registry but its instance is gone. Nothing to return — but this
    // is deliberately distinguished from an unknown number by resolveInstanceError() below.
    return null
  }

  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw) return null

  // An explicit ref, and the same string normalized (a desktop ref's dir may be spelled any way).
  const byRef = all.find((r) => r.ref === raw)
  if (byRef) return byRef
  if (raw.startsWith('desktop:')) {
    const wanted = instanceRef('desktop', raw.slice('desktop:'.length))
    const hit = all.find((r) => r.ref === wanted)
    if (hit) return hit
  }

  // A bare handle: a CLI/Codex id, or a desktop dir in any spelling.
  const byHandle = all.find(
    (r) =>
      r.handle === raw ||
      (r.kind === 'desktop' && normalizeInstancePath(r.handle) === normalizeInstancePath(raw)),
  )
  if (byHandle) return byHandle

  // A name/label — only when it identifies exactly one row.
  const needle = raw.toLowerCase()
  const byName = all.filter((r) => r.name.toLowerCase() === needle)
  if (byName.length === 1) return byName[0]!

  return null
}

/** A message explaining a failed resolve, phrased for whoever passed the bad reference. Separate
 *  from resolveInstance so the happy path stays a plain nullable and never builds a string. */
export async function resolveInstanceError(input: unknown): Promise<string> {
  const num = parseInstanceNumber(input)
  if (num !== null) {
    const retired = refForNumber(num)
    if (retired) {
      return `instance #${num} was '${retired.ref}', which no longer exists (deleted). Numbers are never reused, so this one stays retired — call list_instance_numbers for the current fleet.`
    }
    return `no instance #${num}. Call list_instance_numbers to see every instance and its number.`
  }
  return `could not resolve instance '${String(input)}'. Pass its number (e.g. 7 or "#7"), its dir/id, or an unambiguous name — list_instance_numbers shows all three.`
}
