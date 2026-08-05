// Reset notifications — the Settings → Notifications section and the in-app toast raised when the
// daemon reports a quota window rolling over (server/src/reset-watch.ts).
export default {
  title: 'Notifications',
  // --- the in-app toast ---
  windowSession: '5-hour session',
  windowWeekly: 'weekly (all models)',
  toastTitle: '{label}: {window} limit reset',
  toastBody: 'Your {window} quota window has rolled over.',
  toastBodyWas: 'Your {window} quota window has rolled over. You were at {pct}%.',
  acknowledge: 'Got it',

  // --- settings ---
  enabled: 'Reset notifications',
  enabledHint:
    'Tell me when a quota window rolls over. Only windows you actually used have a reset to announce, so an idle machine stays quiet.',
  sessionReset: 'Notify on 5-hour reset',
  weeklyReset: 'Notify on weekly reset',
  minPct: 'Only if usage was at least',
  minPctHint:
    'Skip a reset whose window was barely used. 0 announces every rollover; 50 announces only the ones you were actually pressing against.',
  desktop: 'Desktop notification',
  desktopHint:
    'A native notification from the operating system, so it reaches you with the app minimised to the tray.',
  persistent: 'Keep reminding me',
  persistentHint:
    'Re-raise the notification until you acknowledge it, instead of showing it once. The desktop notification also becomes sticky, so it waits on screen rather than fading after a few seconds.',
  persistentInterval: 'Remind every',
  persistentMaxRepeats: 'Stop after',
  persistentMaxRepeatsHint:
    'Number of reminders before it gives up. 0 means keep going until acknowledged.',
  minutes: 'minutes',
  reminders: 'reminders',
  email: 'Also send an email',
  emailHint:
    'Sent through your own SMTP server. The password is stored encrypted for this Windows account and is never sent back to this screen.',
  emailTo: 'Send to',
  emailFrom: 'From address',
  smtpHost: 'SMTP host',
  smtpPort: 'Port',
  smtpSecure: 'Implicit TLS (port 465)',
  smtpSecureHint:
    'Off uses a plain connection upgraded with STARTTLS, which is what ports 587 and 25 expect.',
  smtpUser: 'Username',
  smtpPass: 'Password',
  smtpPassStored:
    'Stored. Type a new one to replace it; leaving this empty keeps the current password.',
  test: 'Send a test notification',
  testHint: 'Proves the plumbing works now, instead of finding out in five hours that it does not.',
  testSending: 'Sending…',
  testDesktopOk: 'Desktop notification sent.',
  testDesktopFailed: 'Desktop notification failed: {error}',
  testEmailOk: 'Test email sent.',
  testEmailFailed: 'Test email failed: {error}',
  testNothingEnabled: 'No notification channel is enabled, so nothing was sent.',
}
