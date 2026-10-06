// Reset notifications: the in-app toast raised when the daemon reports a quota window rolling over
// (server/src/reset-watch.ts). Their settings are Desk's (Settings, Usage alerts).
export default {
  windowSession: '5-hour session',
  windowWeekly: 'weekly (all models)',
  toastTitle: '{label}: {window} limit reset',
  toastBody: 'Your {window} quota window has rolled over.',
  toastBodyWas: 'Your {window} quota window has rolled over. You were at {pct}%.',
  acknowledge: 'Got it',
  // Shown instead of N separate cards when a whole backlog arrives at once (e.g. the window was
  // closed while several accounts rolled over).
  toastSummaryTitle: '{count} quota windows reset',
  toastSummaryBody: 'Several accounts rolled over while you were away.',
  acknowledgeAll: 'Got it, all',
}
