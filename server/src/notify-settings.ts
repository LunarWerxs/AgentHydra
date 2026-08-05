// server/src/notify-settings.ts — reset-notification settings, in the db `settings` table.
//
// Same shape as usage-refresh.ts's settings half (getSetting/setSetting, a partial patch, an echo
// of the stored result), with one difference worth stating: the SMTP password is the first genuine
// SECRET this settings surface has carried.
//
// How it is handled:
//   · At rest it is sealed with the shared DPAPI helper (server/src/dpapi-seal.mjs) — the same
//     mechanism that protects the Connections refresh token. On Windows that binds the ciphertext
//     to this user account; elsewhere seal() is an honest passthrough (there is no OS keystore to
//     borrow, and pretending otherwise would be worse than saying so).
//   · It is NEVER returned by the settings API. The DTO carries `notifySmtpPassSet: boolean`
//     instead, so the UI can render "•••• (stored)" and a "replace" affordance without the value
//     ever crossing the loopback socket a second time.
//   · An empty string in a patch means "leave it alone", not "clear it" — otherwise every save of
//     an unrelated toggle would wipe the password. Clearing is explicit, via clearSmtpPassword().

import { getSetting, setSetting } from './db'
import { seal, unseal } from './dpapi-seal.mjs'
import type { NotificationSettings } from './types'

/** Repeat cadence guard rails. One minute is already obnoxious; a day is "effectively off". */
const MIN_REPEAT_MIN = 1
const MAX_REPEAT_MIN = 24 * 60
const DEFAULT_REPEAT_MIN = 10
const DEFAULT_MAX_REPEATS = 10
/** A hard ceiling on repeats so a forgotten "unlimited" can't notify forever. 0 still means
 *  "until acknowledged", but bounded by MAX_REPEATS_CEILING deliveries. */
export const MAX_REPEATS_CEILING = 200

const DEFAULT_SMTP_PORT = 587

/** A setting that DEFAULTS ON (mirrors usage-refresh.ts): only an explicit '0' turns it off. */
const onByDefault = (key: string): boolean => getSetting(key) !== '0'
/** A setting that DEFAULTS OFF: only an explicit '1' turns it on. */
const offByDefault = (key: string): boolean => getSetting(key) === '1'

/**
 * A stored integer, or the default when the key was never written.
 *
 * The blank check is load-bearing, not defensive: getSetting returns `''` for an unset key and
 * `Number('')` is **0**, which is finite — so a plain `Number.isFinite` guard silently accepts it
 * and every unset numeric setting clamps to its MINIMUM instead of its default. Caught live: a
 * fresh install came up with a 1-minute repeat interval and SMTP port 1.
 */
function int(key: string, fallback: number, min: number, max: number): number {
  const raw = getSetting(key).trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const SMTP_PASS_KEY = 'notify_smtp_pass'

export function getNotificationSettings(): NotificationSettings {
  return {
    // Reset notifications default ON: the feature is "tell me when my quota comes back", and a
    // window only HAS a reset event if it was actually used, so an idle install is silent anyway.
    notifyEnabled: onByDefault('notify_enabled'),
    notifySessionReset: onByDefault('notify_session_reset'),
    notifyWeeklyReset: onByDefault('notify_weekly_reset'),
    notifyMinPct: int('notify_min_pct', 0, 0, 100),
    notifyDesktop: onByDefault('notify_desktop'),
    // Persistent + email are opt-in: both are intrusive in ways a default must not be.
    notifyPersistent: offByDefault('notify_persistent'),
    notifyPersistentIntervalMin: int(
      'notify_persistent_interval_min',
      DEFAULT_REPEAT_MIN,
      MIN_REPEAT_MIN,
      MAX_REPEAT_MIN,
    ),
    notifyPersistentMaxRepeats: int(
      'notify_persistent_max_repeats',
      DEFAULT_MAX_REPEATS,
      0,
      MAX_REPEATS_CEILING,
    ),
    notifyEmail: offByDefault('notify_email'),
    notifyEmailTo: getSetting('notify_email_to'),
    notifyEmailFrom: getSetting('notify_email_from'),
    notifySmtpHost: getSetting('notify_smtp_host'),
    notifySmtpPort: int('notify_smtp_port', DEFAULT_SMTP_PORT, 1, 65535),
    notifySmtpSecure: offByDefault('notify_smtp_secure'),
    notifySmtpUser: getSetting('notify_smtp_user'),
    notifySmtpPassSet: !!getSetting(SMTP_PASS_KEY),
  }
}

/** The stored SMTP password in plaintext, for the sender only. Never route this to an API response. */
export function smtpPassword(): string {
  const stored = getSetting(SMTP_PASS_KEY)
  if (!stored) return ''
  return unseal(stored) ?? ''
}

/** Forget the stored password (the explicit clear; an empty patch value never does this). */
export function clearSmtpPassword(): void {
  setSetting(SMTP_PASS_KEY, '')
}

/**
 * The patch type the API accepts. `notifySmtpPass` is write-only and deliberately absent from
 * NotificationSettings, so a round-trip of the GET response can never re-submit (or erase) it.
 */
export type NotificationSettingsPatch = Partial<
  Omit<NotificationSettings, 'notifySmtpPassSet'> & { notifySmtpPass: string }
>

const bool = (v: boolean) => (v ? '1' : '0')

/** Apply a partial patch and return the resulting settings. Unknown/absent fields are untouched. */
export function setNotificationSettings(patch: NotificationSettingsPatch): NotificationSettings {
  if (typeof patch.notifyEnabled === 'boolean')
    setSetting('notify_enabled', bool(patch.notifyEnabled))
  if (typeof patch.notifySessionReset === 'boolean')
    setSetting('notify_session_reset', bool(patch.notifySessionReset))
  if (typeof patch.notifyWeeklyReset === 'boolean')
    setSetting('notify_weekly_reset', bool(patch.notifyWeeklyReset))
  if (typeof patch.notifyMinPct === 'number' && Number.isFinite(patch.notifyMinPct))
    setSetting('notify_min_pct', String(Math.min(100, Math.max(0, Math.round(patch.notifyMinPct)))))
  if (typeof patch.notifyDesktop === 'boolean')
    setSetting('notify_desktop', bool(patch.notifyDesktop))
  if (typeof patch.notifyPersistent === 'boolean')
    setSetting('notify_persistent', bool(patch.notifyPersistent))
  if (
    typeof patch.notifyPersistentIntervalMin === 'number' &&
    Number.isFinite(patch.notifyPersistentIntervalMin)
  )
    setSetting(
      'notify_persistent_interval_min',
      String(
        Math.min(
          MAX_REPEAT_MIN,
          Math.max(MIN_REPEAT_MIN, Math.round(patch.notifyPersistentIntervalMin)),
        ),
      ),
    )
  if (
    typeof patch.notifyPersistentMaxRepeats === 'number' &&
    Number.isFinite(patch.notifyPersistentMaxRepeats)
  )
    setSetting(
      'notify_persistent_max_repeats',
      String(
        Math.min(MAX_REPEATS_CEILING, Math.max(0, Math.round(patch.notifyPersistentMaxRepeats))),
      ),
    )
  if (typeof patch.notifyEmail === 'boolean') setSetting('notify_email', bool(patch.notifyEmail))
  if (typeof patch.notifyEmailTo === 'string')
    setSetting('notify_email_to', patch.notifyEmailTo.trim())
  if (typeof patch.notifyEmailFrom === 'string')
    setSetting('notify_email_from', patch.notifyEmailFrom.trim())
  if (typeof patch.notifySmtpHost === 'string')
    setSetting('notify_smtp_host', patch.notifySmtpHost.trim())
  if (typeof patch.notifySmtpPort === 'number' && Number.isFinite(patch.notifySmtpPort))
    setSetting(
      'notify_smtp_port',
      String(Math.min(65535, Math.max(1, Math.round(patch.notifySmtpPort)))),
    )
  if (typeof patch.notifySmtpSecure === 'boolean')
    setSetting('notify_smtp_secure', bool(patch.notifySmtpSecure))
  if (typeof patch.notifySmtpUser === 'string')
    setSetting('notify_smtp_user', patch.notifySmtpUser.trim())
  // Empty = "unchanged" (see the header): a settings save that only flipped a toggle must not
  // silently erase a password the user typed three screens ago.
  if (typeof patch.notifySmtpPass === 'string' && patch.notifySmtpPass !== '')
    setSetting(SMTP_PASS_KEY, seal(patch.notifySmtpPass))
  return getNotificationSettings()
}
