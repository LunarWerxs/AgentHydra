// server/src/notify-settings.ts — the settings half of reset notifications.
//
// The interesting cases are the two that bit in practice: an UNSET numeric key must resolve to its
// DEFAULT (not to its minimum), and an empty password in a patch must mean "leave it alone" rather
// than "erase it".
import { afterAll, beforeEach, expect, test } from 'bun:test'

// Point the db at a scratch dir BEFORE importing anything that touches it — db.ts opens the file on
// import, so the env has to be in place first.
const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-notify-settings-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = scratch

const { getSetting, setSetting } = await import('../src/db')
const { clearSmtpPassword, getNotificationSettings, setNotificationSettings, smtpPassword } =
  await import('../src/notify-settings')

const KEYS = [
  'notify_enabled',
  'notify_session_reset',
  'notify_weekly_reset',
  'notify_min_pct',
  'notify_desktop',
  'notify_persistent',
  'notify_persistent_interval_min',
  'notify_persistent_max_repeats',
  'notify_email',
  'notify_email_to',
  'notify_email_from',
  'notify_smtp_host',
  'notify_smtp_port',
  'notify_smtp_secure',
  'notify_smtp_user',
  'notify_smtp_pass',
]

beforeEach(() => {
  for (const k of KEYS) setSetting(k, '')
})

afterAll(() => {
  try {
    require('node:fs').rmSync(scratch, { recursive: true, force: true })
  } catch {
    // scratch dir cleanup is best-effort
  }
})

test('an UNSET numeric setting resolves to its default, never to its minimum', () => {
  // getSetting returns '' for an unset key and Number('') === 0, which is finite. Without an
  // explicit blank check that 0 clamps into range and a fresh install comes up with a 1-minute
  // repeat interval and SMTP port 1. This is that regression.
  const s = getNotificationSettings()
  expect(s.notifyPersistentIntervalMin).toBe(10)
  expect(s.notifyPersistentMaxRepeats).toBe(10)
  expect(s.notifySmtpPort).toBe(587)
  expect(s.notifyMinPct).toBe(0)
})

test('defaults: announcing is on, the intrusive channels are opt-in', () => {
  const s = getNotificationSettings()
  expect(s.notifyEnabled).toBe(true)
  expect(s.notifySessionReset).toBe(true)
  expect(s.notifyWeeklyReset).toBe(true)
  expect(s.notifyDesktop).toBe(true)
  expect(s.notifyPersistent).toBe(false)
  expect(s.notifyEmail).toBe(false)
})

test('a garbage stored number also falls back to the default', () => {
  setSetting('notify_smtp_port', 'not-a-port')
  expect(getNotificationSettings().notifySmtpPort).toBe(587)
})

test('values are clamped into range on write', () => {
  const s = setNotificationSettings({
    notifyMinPct: 500,
    notifySmtpPort: 99999,
    notifyPersistentIntervalMin: 0,
    notifyPersistentMaxRepeats: 100000,
  })
  expect(s.notifyMinPct).toBe(100)
  expect(s.notifySmtpPort).toBe(65535)
  expect(s.notifyPersistentIntervalMin).toBe(1)
  expect(s.notifyPersistentMaxRepeats).toBe(200)
})

test('a patch touches only the fields it carries', () => {
  setNotificationSettings({ notifySmtpHost: 'smtp.example.com', notifySmtpUser: 'me' })
  const s = setNotificationSettings({ notifyPersistent: true })
  expect(s.notifySmtpHost).toBe('smtp.example.com')
  expect(s.notifySmtpUser).toBe('me')
  expect(s.notifyPersistent).toBe(true)
})

// --- the SMTP password --------------------------------------------------------

test('the password round-trips through the seal and is readable by the sender', () => {
  setNotificationSettings({ notifySmtpPass: 'hunter2' })
  expect(smtpPassword()).toBe('hunter2')
  expect(getNotificationSettings().notifySmtpPassSet).toBe(true)
})

test('the password is NEVER in the settings DTO', () => {
  setNotificationSettings({ notifySmtpPass: 'hunter2' })
  expect(JSON.stringify(getNotificationSettings())).not.toContain('hunter2')
})

test('it is not stored as plaintext where DPAPI is available', () => {
  setNotificationSettings({ notifySmtpPass: 'hunter2' })
  const stored = getSetting('notify_smtp_pass')
  if (process.platform === 'win32') expect(stored).toStartWith('DPAPIv1:')
  // Elsewhere seal() is an honest passthrough; the DTO still never carries it.
  expect(smtpPassword()).toBe('hunter2')
})

test('an EMPTY password in a patch means "leave it alone", not "erase it"', () => {
  // Every settings save sends the whole form. If '' cleared the password, flipping an unrelated
  // toggle would silently log the user out of their mail server.
  setNotificationSettings({ notifySmtpPass: 'hunter2' })
  setNotificationSettings({ notifySmtpPass: '', notifyPersistent: true })
  expect(smtpPassword()).toBe('hunter2')
  expect(getNotificationSettings().notifySmtpPassSet).toBe(true)
})

test('clearing the password is explicit', () => {
  setNotificationSettings({ notifySmtpPass: 'hunter2' })
  clearSmtpPassword()
  expect(smtpPassword()).toBe('')
  expect(getNotificationSettings().notifySmtpPassSet).toBe(false)
})
