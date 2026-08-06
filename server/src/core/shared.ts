// server/src/core/shared.ts — DTO types + tier helper + constants for the multi-instance
// backend, adapted from an internal LunarWerx tool's `shared/` (dto.ts, tiers.ts,
// constants.ts) so `server/src/core/*` has no cross-repo imports (PLAN.md §2).
//
// NAMING: these "instance account" types describe which Anthropic account a Claude Desktop
// **instance** is logged into (resolved by decrypting its local safeStorage token cache) —
// this is a DIFFERENT concept from this app's own sqlite `accounts` table (Anthropic auth
// secrets used for queue dispatch, see server/src/db.ts / server/src/types.ts `Account`).
// Do not conflate the two; do not touch the sqlite `accounts` table from this module.

// ----------------------------------------------------------------------------
// Constants (from the internal tool's shared/constants.ts) — only the pieces core/* needs.
// ----------------------------------------------------------------------------

/** Instances live under `~/.claude-instances/<name>` on every OS. */
export const INSTANCES_DIR_NAME = '.claude-instances'

/** The default (non-isolated) Claude Desktop profile dir name — never deletable. */
export const DEFAULT_CLAUDE_DIR_NAME = 'Claude'

export const PROFILE_API_URL = 'https://api.anthropic.com/api/oauth/profile'

export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

// ----------------------------------------------------------------------------
// Tier helper (from the internal tool's shared/tiers.ts, verbatim behavior).
// ----------------------------------------------------------------------------

const KNOWN_TIERS: Record<string, string> = {
  default_claude_max_20x: 'Max 20×',
  default_claude_max_5x: 'Max 5×',
  default_claude_max: 'Max',
  default_claude_pro: 'Pro',
  default_claude_free: 'Free',
}

/** Maps a raw rate-limit tier string (e.g. "default_claude_max_20x") to a friendly display
 *  label (e.g. "Max 20×"). Returns the raw string unchanged if unrecognized, and passes
 *  through null/empty/whitespace-only input as-is. Never throws. */
export function prettyTier(tier: string | null | undefined): string | null {
  if (tier == null) return tier ?? null
  if (tier.trim() === '') return tier

  try {
    const known = KNOWN_TIERS[tier]
    if (known) return known

    if (/^default_claude_team/.test(tier)) return 'Team'
    if (/^default_claude_enterprise/.test(tier)) return 'Enterprise'

    const maxN = tier.match(/^default_claude_max_(\d+)x$/)
    if (maxN) return `Max ${maxN[1]}×`

    return tier
  } catch {
    return tier
  }
}

/**
 * The account's plan / "type" as one display-ready label ("Max 20×" | "Pro" | "Free" | …), or
 * null when it genuinely can't be determined.
 *
 * Evidence, strongest first:
 *
 * 1. A SPECIFIC rate-limit tier ("default_claude_max_20x" → "Max 20×"). Anthropic derives it from
 *    the active subscription, and it is the only signal carrying 5×/20× granularity.
 * 2. `plan`, which is the OAuth grant's own `subscriptionType` (see accounts.ts). The grant is
 *    minted and re-minted by Anthropic on every token refresh, so it tracks the CURRENT
 *    subscription.
 * 3. Nothing → null, and the column renders "—".
 *
 * WHY A GENERIC TIER IS NOT PROOF OF "FREE" (fixed 2026-08-06). This used to return 'Free' the
 * moment the tier came back as an unmapped `default_claude_*` passthrough, on the theory that
 * Anthropic drops a lapsed account to the generic "default_claude_ai". That is true, but it is not
 * the ONLY thing that reports the generic value: an owner-confirmed, actively-paid Pro account
 * reports `rateLimitTier: "default_claude_ai"` on its grant too, and was being shown as Free.
 * A generic tier means "this signal knows nothing", so it now falls through to the grant instead
 * of overriding it.
 *
 * The 2026-07-22 finding this replaces is still respected, because it was about a DIFFERENT field:
 * the profile's `has_claude_max` / `has_claude_pro` booleans, which stay `true` for an account that
 * was paid and has since lapsed. Those are entitlement history, not current state, and accounts.ts
 * no longer lets them override the grant. So `plan` reaching here is grant-derived, and the stale
 * flags are still not trusted to upgrade anybody.
 *
 * Never returns a raw `default_*` string; returns null (callers render "—") when nothing is known.
 */
export function resolvePlanLabel(
  plan: string | null,
  prettyTierLabel: string | null,
): string | null {
  // A specific, recognized tier is the current plan — trust it (keeps the 5×/20× granularity).
  if (prettyTierLabel && !/^default_claude/i.test(prettyTierLabel)) return prettyTierLabel
  // Otherwise the tier told us nothing usable (absent, or a generic `default_claude_*`
  // passthrough): fall through to the grant's subscription type.
  const p = plan?.toLowerCase()
  if (p) {
    if (p.includes('max')) return 'Max'
    if (p.includes('pro')) return 'Pro'
    if (p.includes('free')) return 'Free'
    return plan // some other subscriptionType passthrough (already not a raw default_*)
  }
  // A generic tier with NO subscription evidence behind it is the genuine free/default account:
  // that is exactly what Anthropic reports when there is no paid plan to describe.
  if (prettyTierLabel) return 'Free'
  return null
}

// ----------------------------------------------------------------------------
// DTO shapes (from the internal tool's shared/dto.ts) — instance + instance-account only.
// ----------------------------------------------------------------------------

/** Curated glyph set for the per-instance icon (which replaces the plain status dot in the
 *  UI). These string keys are the single source of truth; the web app maps each one to a
 *  Lucide component in web/src/lib/instance-appearance.ts. */
export const INSTANCE_ICON_KEYS = [
  'box',
  'boxes',
  'terminal',
  'rocket',
  'star',
  'heart',
  'flame',
  'zap',
  'ghost',
  'cat',
  'bot',
  'cpu',
  'folder',
  'globe',
  'flask',
  'sparkles',
] as const
export type InstanceIconKey = (typeof INSTANCE_ICON_KEYS)[number]

/** Curated color palette for the per-instance icon. Keys map to fixed oklch values (chosen to
 *  read on both light and dark backgrounds) in web/src/lib/instance-appearance.ts. */
export const INSTANCE_COLOR_KEYS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const
export type InstanceColorKey = (typeof INSTANCE_COLOR_KEYS)[number]

/** Max length of an instance display label (see instance-meta.ts). */
export const INSTANCE_LABEL_MAX = 60

/** Status of an instance-account resolution attempt. */
export type CMAccountStatus = 'live' | 'cache' | 'offline' | 'loggedout' | 'unknown'

/** Resolved identity for a single isolated Claude Desktop instance. Never carries a token. */
export interface CMAccount {
  status: CMAccountStatus
  email: string | null
  name: string | null
  /** Normalized plan string, e.g. "max" | "pro" | "free" | subscriptionType passthrough. */
  plan: string | null
  /** Pretty rate-limit tier label, e.g. "Max 20×" (see prettyTier above). Can be a generic
   *  `default_*` passthrough even for a paid account — use `planLabel` for display. */
  rateLimitTier: string | null
  /** Display-ready account type ("Max 20×" | "Pro" | "Free" | …), reconciled from `plan` +
   *  `rateLimitTier` by resolvePlanLabel. Null when it can't be determined (render as "—"). */
  planLabel: string | null
  accountUuid: string | null
  orgUuid: string | null
  orgName: string | null
  /** Where this CMAccount came from: 'live' (network), 'cache', 'offline', etc. */
  source: string | null
  /** One-line display label, e.g. "Michael <lunawerx@gmail.com> · Max 20×". */
  label: string
}

/** A single isolated Claude Desktop instance, running or available. */
export interface CMInstance {
  name: string
  dir: string
  isRunning: boolean
  pid: number | null
  startTime: string | null
  sizeBytes: number | null
  /** Live resident memory (summed working set across the instance's whole process tree —
   *  Electron main + renderer/gpu/utility children). Null when the instance isn't running or
   *  the platform can't cheaply report it (e.g. the unix `ps` path). */
  memoryBytes: number | null
  /** Attached lazily/omitted — null until /account is resolved. */
  account: CMAccount | null
  /** Which account this instance is signed into RIGHT NOW — config.json's `lastKnownAccountUuid`,
   *  null when signed out. Cheap enough (stat-gated, see instances.ts readLoginUuid) to ship with
   *  every list, unlike `account`: the UI compares it against `account.accountUuid` to notice that
   *  an instance was re-logged into a different account and re-resolve the identity immediately,
   *  instead of showing the previous account's email until someone hits Refresh. */
  loginUuid: string | null
  /** True when discovered from a running process whose --user-data-dir isn't under
   *  the instances root. */
  isExternal: boolean
  /** User display label overriding the folder `name` (null = show `name`). Pure UI metadata
   *  (instance-meta.json under appDataDir()), so it can be changed while the instance runs —
   *  unlike the folder, which Claude Desktop holds open. */
  label: string | null
  /** Chosen glyph key (see INSTANCE_ICON_KEYS); null = a deterministic default from the dir. */
  icon: InstanceIconKey | null
  /** Chosen icon color key (see INSTANCE_COLOR_KEYS); null = a deterministic default. */
  color: InstanceColorKey | null
}

/** Result of a mutating action (open/quit/create/delete). */
export interface CMActionResult {
  ok: boolean
  action: string | null
  dir: string | null
  message: string | null
  /** Optional extra payload (e.g. freed byte count, launched PID). Omitted on
   *  the common early-return guard-clause failure paths — callers should treat
   *  a missing `data` as "no extra payload," never as a malformed result. */
  data?: Record<string, unknown>
  /** Create-only: surfaces the "Browser Dance" caveat (quit other instances before first login). */
  needsBrowserDance?: boolean
}

/** How Claude Desktop is installed on this machine (see core/desktop-install.ts). On Windows,
 *  Anthropic ships two installers: the classic Squirrel `.exe` (installs to
 *  `%LOCALAPPDATA%\AnthropicClaude\app-<ver>\Claude.exe` — the only build this app can launch
 *  with `--user-data-dir`) and the MSIX package (PFN `Claude_pzs8sxrjxfjjc`, lands under the
 *  ACL-locked `C:\Program Files\WindowsApps`, AppContainer-sandboxed — NOT manageable here). */
export interface CMDesktopInstall {
  platform: 'win32' | 'darwin' | 'linux'
  /** Launchable classic-install binary (null when only the MSIX build — or nothing — is present). */
  directPath: string | null
  /** True when the MSIX package is detected (win32 only; always false elsewhere). */
  msixDetected: boolean
  /** Which detection signals fired, for debuggability: 'packages-dir' | 'exec-alias' | 'appx' | 'fake'. */
  msixSignals: string[]
  /** False when the Instances/Manager tab cannot launch instances on this machine. */
  manageable: boolean
}

/** Cached instance-account identity — NEVER a token. Written by core/accounts.ts, keyed by
 *  normalized instance dir in the instances-cache.json file under CONFIG_DIR. */
export interface CMAccountCacheEntry {
  email: string | null
  name: string | null
  plan: string | null
  rateLimitTier: string | null
  uuid: string | null
  orgUuid: string | null
  orgName: string | null
  resolvedAt: string
}
