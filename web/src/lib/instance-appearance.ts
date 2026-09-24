// Per-instance icon + color: the visual layer for the glyph that replaced the plain green
// status dot in the Instances table. The KEY SETS (which icons, which colors) are the single
// source of truth from the server package (server/src/core/shared.ts), which also validates
// them; this module owns only the presentation — key -> Lucide component, key -> oklch value —
// plus a deterministic default so an un-customized instance still gets a stable, distinct look.

// The two VALUE constants come straight from where they are declared, not through lib/api's
// re-export. api.ts is a barrel that also carries the whole DTO surface and every request helper,
// and importing a runtime constant through it means this module cannot link until that whole graph
// has evaluated. Under `bun test`, where files load concurrently, that window is real: this file
// began failing on Linux with "export 'INSTANCE_ICON_KEYS' not found in '@/lib/api'" for a constant
// api.ts does export, purely because another test file had api.ts mid-evaluation. Types still come
// from the barrel — a type import is erased and cannot have an evaluation order.
import { INSTANCE_COLOR_KEYS, INSTANCE_ICON_KEYS } from '@agenthydra/server/types'
import {
  Bot,
  Box,
  Boxes,
  Cat,
  Cpu,
  Flame,
  FlaskConical,
  Folder,
  Ghost,
  Globe,
  Heart,
  type LucideIcon,
  Rocket,
  Sparkles,
  Star,
  Terminal,
  Zap,
} from '@lucide/vue'
import type { CMAccount, CMInstance, InstanceColorKey, InstanceIconKey } from '@/lib/api'

/** key -> Lucide component. Keys match INSTANCE_ICON_KEYS exactly (kept in lockstep). */
const ICON_COMPONENTS: Record<InstanceIconKey, LucideIcon> = {
  box: Box,
  boxes: Boxes,
  terminal: Terminal,
  rocket: Rocket,
  star: Star,
  heart: Heart,
  flame: Flame,
  zap: Zap,
  ghost: Ghost,
  cat: Cat,
  bot: Bot,
  cpu: Cpu,
  folder: Folder,
  globe: Globe,
  flask: FlaskConical,
  sparkles: Sparkles,
}

/** key -> fixed oklch color. Lightness/chroma picked to stay legible on both the light and the
 *  dark table/popover backgrounds (mid-L, saturated). Fixed values, NOT theme vars — an
 *  instance's chosen hue should look the same in either theme. */
const COLOR_VALUES: Record<InstanceColorKey, string> = {
  slate: 'oklch(0.60 0.03 255)',
  red: 'oklch(0.62 0.21 25)',
  orange: 'oklch(0.67 0.17 50)',
  amber: 'oklch(0.72 0.15 80)',
  green: 'oklch(0.62 0.16 150)',
  teal: 'oklch(0.66 0.11 195)',
  blue: 'oklch(0.60 0.17 250)',
  indigo: 'oklch(0.55 0.19 280)',
  violet: 'oklch(0.60 0.20 310)',
  pink: 'oklch(0.65 0.21 350)',
}

/** Stable non-negative hash of a string (FNV-1a-ish). Same dir -> same default forever. */
function hash(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Deterministic default icon/color for an instance that hasn't been customized, derived from
 *  its dir so it's stable across reloads and gives instant visual variety across instances. */
function defaultIconKey(dir: string): InstanceIconKey {
  return INSTANCE_ICON_KEYS[hash(dir) % INSTANCE_ICON_KEYS.length] as InstanceIconKey
}
function defaultColorKey(dir: string): InstanceColorKey {
  // A second, differently-seeded index so icon and color don't move in lockstep.
  return INSTANCE_COLOR_KEYS[hash(`${dir}#color`) % INSTANCE_COLOR_KEYS.length] as InstanceColorKey
}

/** The effective icon key: the user's choice, else the deterministic default. */
export function resolveIconKey(inst: Pick<CMInstance, 'dir' | 'icon'>): InstanceIconKey {
  return inst.icon ?? defaultIconKey(inst.dir)
}

/** The effective color key: the user's choice, else the deterministic default. */
export function resolveColorKey(inst: Pick<CMInstance, 'dir' | 'color'>): InstanceColorKey {
  return inst.color ?? defaultColorKey(inst.dir)
}

export function iconComponent(key: InstanceIconKey): LucideIcon {
  return ICON_COMPONENTS[key]
}

export function colorValue(key: InstanceColorKey): string {
  return COLOR_VALUES[key]
}

/** The short human name of a resolved account: the profile's full name, else the local part of
 *  its email ("4claude" out of "4claude@lunarwerx.com"). Null when nothing is resolved yet, or
 *  the instance is logged out — both leave name/email null, so no status check is needed.
 *
 *  FRIENDLY, NOT IDENTIFYING. Whether it returns a profile name or an email fragment depends on
 *  whether that account happens to have `full_name` set on its Anthropic profile, and nothing on
 *  screen says which one you got. That is fine for NAMING a row (see displayName) and wrong for
 *  the account column, which is answering "which login is this?" — use {@link accountHandle}. */
export function accountName(account: CMAccount | null | undefined): string | null {
  const name = account?.name?.trim()
  if (name) return name
  const localPart = accountHandle(account)
  return localPart || null
}

/**
 * The account's IDENTIFYING handle: the local part of the email it is signed in with, always.
 *
 * One rule for every row, which is the entire point. The account column used to render
 * {@link accountName}, so a machine with several logins showed a column reading "kestrel",
 * "5claude", "Martin", "Michael Griswold" — a mix of Anthropic profile display names and email
 * fragments, indistinguishable from each other and from the instance's own name and folder. There
 * was no way to tell that "kestrel" was a profile name for t.mercer@example.com while "5claude" was
 * just an email with the domain cut off.
 *
 * The email is the one field that every signed-in account has, that is unique, and that the user
 * actually typed — so it is what identifies a login. The local part fits the column; the full
 * address and the profile name ride in the tooltip. Null when nothing is resolved or the instance
 * is signed out.
 */
export function accountHandle(account: CMAccount | null | undefined): string | null {
  return account?.email?.trim().split('@')[0]?.trim() || null
}

/** The FULL address the account is signed in with — what a copy action puts on the clipboard, and
 *  the only form that identifies the login outside this app (the handle alone is ambiguous across
 *  domains: `5claude@lunarwerx.com` and `5claude@gmail.com` collapse to the same chip).
 *
 *  Null when nothing is resolved yet or the instance is signed out — a signed-out account still
 *  carries a non-empty `label` ("(not logged in)"), and that label must never reach a clipboard as
 *  if it were an address. */
export function accountEmail(account: CMAccount | null | undefined): string | null {
  return account?.email?.trim() || null
}

/**
 * What to CALL an account on screen: its email handle, falling back to the Anthropic profile name.
 *
 * The handle comes first, which is the reverse of {@link accountName}, and it is the same argument
 * the account COLUMN already settled: the profile's `full_name` is whatever the person typed into
 * claude.ai, so a fleet named that way reads "Toby", "Martin", "Michael Griswold" — friendly words
 * that do not say WHICH LOGIN each row is, and cannot be matched against the folder, the number, or
 * anything the user would search for. Observed: an instance in the folder `6claude`, signed into
 * 6claude@…, displayed as "Toby", and there was no way to tell from the table that those were the
 * same thing.
 *
 * The email is the one field every signed-in account has, is unique, and the user actually typed.
 * The profile name is kept only as a fallback for an account that somehow has a name but no
 * address — dropping to the folder name there would throw away the better answer. Null when
 * nothing is resolved or the instance is signed out.
 */
export function accountDisplayName(account: CMAccount | null | undefined): string | null {
  return accountHandle(account) ?? account?.name?.trim() ?? null
}

/**
 * The instance row a SESSION belongs to, from the instance LABEL the session carries.
 *
 * `SessionSummary.instance` is what server/src/instance-sessions.ts stamped on the chat: the dir
 * NAME of an isolated instance, or the literal `'default'` for the regular non-isolated Claude
 * Desktop. Those are two different kinds of name. A dir name matches `CMInstance.name`; `'default'`
 * normally cannot, because the regular install's row is named after its folder ("Claude" on
 * Windows) — so it is matched on `isDefault`, which the server sets from the same dir comparison
 * it uses to refuse quitting and deleting that profile.
 *
 * ⛔ THE TWO KINDS CAN COLLIDE, and that is why this returns AT MOST ONE match rather than the
 * first. Creating an instance folder literally called "default" is refused now
 * (server/src/core/lifecycle.ts RESERVED_INSTANCE_LABELS), but that guard only covers NEW folders —
 * one made before it existed, or dropped in by hand, is still there. scanAll then stamps ITS chats
 * with the same string the regular install's chats carry. When both exist the server itself cannot
 * say which store a given chat came from, so neither can this: two candidates means the answer is
 * unknown, and unknown is returned as null.
 *
 * Null is also the answer for an unknown label, an instance folder deleted since the chat ran, the
 * regular install simply not running (its row exists only while a process for it does), and two
 * rows sharing a folder name. A caller must treat null as "no account known", NEVER as a reason to
 * fall back to another row — one account's address against another account's chat is the exact
 * failure `loginChanged` exists to prevent, and it is worse than saying nothing.
 */
export function instanceForSessionLabel<T extends Pick<CMInstance, 'name' | 'isDefault'>>(
  instances: readonly T[],
  label: string | null | undefined,
): T | null {
  if (!label) return null
  // A row qualifies by NAME always, and additionally by `isDefault` for the 'default' sentinel —
  // so an isolated folder actually named "default" is a candidate alongside the regular install
  // rather than being silently outranked by it.
  const matches = instances.filter((i) => i.name === label || (label === 'default' && i.isDefault))
  return matches.length === 1 ? (matches[0] ?? null) : null
}

/** The name to show for an instance: the user's own label, else the ACCOUNT it is signed into
 *  (its Anthropic profile NAME — "kestrel" — falling back to the email handle when the account has
 *  no name, see accountName), else the folder name.
 *
 *  ⛔ THE NAME COLUMN SHOWS THE PROFILE NAME, NOT THE EMAIL HANDLE (owner directive, 2026-09-11:
 *  "the name column should pull the account's name", i.e. the profile name over the email handle).
 *  The identifying
 *  handle still lives in its own Account column and the row's tooltip, so nothing is lost by
 *  naming this column after the person — which is the friendlier answer the owner wants here. This
 *  is why displayName reaches for accountName (name-first) and not accountDisplayName (handle-first,
 *  which the Account column keeps).
 *
 *  The account comes before the folder because the folder name is a lie the moment you sign a
 *  profile into a different account than the one you named it after — and nothing stops that
 *  drift or corrects it later. The account is what the instance actually IS, so it is the right
 *  default; the folder name survives only as the last resort for an instance that has no
 *  resolved identity at all. Two profiles on the same account will share a name — the dir shown
 *  beneath it is what tells them apart. */
export function displayName(inst: Pick<CMInstance, 'name' | 'label' | 'account'>): string {
  return inst.label?.trim() || accountName(inst.account) || inst.name
}

/** How many characters of a name the Name column shows before it elides the rest.
 *
 *  Sized to the column, not picked for looks: all three stacked tables give Name `w-44` (176px),
 *  and the cell spends ~32px of that on the permanent #N chip and its gap before a letter is
 *  drawn, leaving ~144px — about 18 characters of 14px medium-weight text, with the external /
 *  stale-label / linked-CLI markers still to fit after it. */
export const NAME_DISPLAY_MAX = 18

/**
 * A name cut to {@link NAME_DISPLAY_MAX} with an ellipsis, or unchanged when it already fits.
 *
 * ⛔ THIS IS A DISPLAY CUT ONLY. Never store it, never compare it, never hand it to anything that
 * matches or copies — a truncated name is not an identifier, and two accounts can share a prefix.
 * The full name belongs in the hover (owner directive, 2026-09-11): the Name column began showing
 * the ACCOUNT behind a row rather than its folder, and an Anthropic profile name or a long email
 * handle is routinely wider than the column. Table layout is auto, so `w-44` is a hint a long cell
 * simply overruns — one long name therefore widened the Name column and knocked the desktop, CLI
 * and Codex tables out of the alignment their fixed widths exist to guarantee.
 *
 * Counted in CODE POINTS (`Array.from`), not UTF-16 units, so a cut never lands between the halves
 * of a surrogate pair and leaves a replacement glyph on the row — profile names carry emoji and
 * non-BMP characters. A multi-code-point grapheme (a ZWJ family, a flag) can still be split at the
 * boundary; that is a cosmetic edge the browser renders as its parts, not as broken text.
 *
 * The ellipsis counts toward the budget, and trailing whitespace is dropped before it so a cut
 * landing after a space does not read as " …".
 */
export function shortDisplayName(name: string, max: number = NAME_DISPLAY_MAX): string {
  const trimmed = name.trim()
  const chars = Array.from(trimmed)
  if (chars.length <= max) return trimmed
  // max < 1 would otherwise slice(0, -1), dropping the last character of the whole name and
  // returning something LONGER than asked for. An ellipsis is the smallest honest answer.
  if (max < 1) return '…'
  const kept = chars.slice(0, max - 1).join('')
  return `${kept.trimEnd()}…`
}

/** Native `title` for a name cell that has no rich tooltip to hang the full name on — the CLI and
 *  Codex tables. Undefined when nothing was cut, so a cell showing the whole name does not sprout a
 *  hover box repeating itself. The desktop table uses IconTooltip instead (it already has a hover
 *  carrying the profile folder), which is why this returns a string rather than rendering. */
export function nameOverflowTitle(
  name: string,
  max: number = NAME_DISPLAY_MAX,
): string | undefined {
  const trimmed = name.trim()
  return shortDisplayName(trimmed, max) === trimmed ? undefined : trimmed
}

/**
 * Is this row's stored label no longer telling the truth about the account behind it?
 *
 * A label is a deliberate override and it wins over everything (see displayName), which is right —
 * but nothing has ever re-examined one. Sign a profile into a different account and the name you
 * typed for the OLD one stays on the row for good, so the table ends up naming instances after
 * accounts they are not signed into. Observed on the owner's machine, and it is not a subtle
 * failure: the folder `4claude` was labelled "3claude" while the folder `3claude` was labelled
 * something else again, which makes the column actively misleading rather than merely stale.
 *
 * This does not change what is shown — the override is still the user's call — it only lets the UI
 * SAY that the two disagree and offer one click to drop the label. Deliberately narrow so it cannot
 * cry wolf:
 *   - no label, or no resolved account -> nothing to disagree about, false.
 *   - the label matching the account's own name or its email handle -> false, since the user simply
 *     typed the account's name themselves, which is agreement, not drift.
 * Compared case-insensitively and trimmed, because "5Claude" and "5claude" are the same intent.
 */
export function labelDisagreesWithAccount(inst: Pick<CMInstance, 'label' | 'account'>): boolean {
  const label = inst.label?.trim().toLowerCase()
  if (!label) return false
  const name = accountName(inst.account)?.trim().toLowerCase()
  const handle = accountHandle(inst.account)?.trim().toLowerCase()
  // An unresolved account is "we don't know yet", never "it disagrees" — flagging every row for the
  // second between load and resolve would train the marker straight out of usefulness.
  if (!name && !handle) return false
  return label !== name && label !== handle
}

/** True when an instance is signed into a DIFFERENT account than the identity attached to it:
 *  `loginUuid` (config.json's lastKnownAccountUuid, re-read on every list) against the uuid of the
 *  identity we resolved earlier.
 *
 *  This is the drift displayName() warns about, caught in the act. A resolved identity is what
 *  names the row AND what fills the account column, so an instance signed into another account
 *  goes on presenting the PREVIOUS account's name, email and plan until something re-resolves it —
 *  and nothing did, because a resolved identity used to be treated as final. Callers use this to
 *  drop the stale identity and to re-resolve promptly instead of on the slow refresh timer.
 *
 *  False whenever either side is unknown: an unresolved identity is already being chased, and a
 *  signed-out instance has no uuid to disagree with. */
export function loginChanged(inst: Pick<CMInstance, 'loginUuid' | 'account'>): boolean {
  const shown = inst.account?.accountUuid
  return Boolean(inst.loginUuid && shown && inst.loginUuid !== shown)
}

export type { InstanceColorKey, InstanceIconKey }
export { INSTANCE_COLOR_KEYS, INSTANCE_ICON_KEYS }
