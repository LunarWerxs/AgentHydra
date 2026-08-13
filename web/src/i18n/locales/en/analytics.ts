// Analytics view — spend, activity and health, drawn from per-session totals.
export default {
  title: 'Analytics',
  // Said before any chart. These are subscription accounts, so nobody is billed per token; the
  // dollar figure answers "what would this have cost on the API", which is the useful comparison.
  listPrice:
    'Costed at published list prices. A subscription plan is not billed per token, so read these as what the same work would cost on the API.',
  partial: 'Totals cover {n} of {total} sessions scanned so far.',
  complete: 'Totals cover all {n} scanned sessions.',
  empty: 'Nothing scanned yet. The totals build in the background shortly after the app starts.',
  rescan: 'Rescan now',
  rescanHint: 'Read any transcript that changed since the last scan',
  rescanDone: 'Scanned {n} session(s).',
  rescanPartial: 'Scanned {n} session(s), then stopped on time. Run it again to continue.',
  rescanFailed: "Couldn't rescan.",
  rescanFailedSome: "Couldn't read {n} transcript(s). They will be retried next time.",
  // --- headline numbers ---
  totalCost: 'Cost',
  sessions: 'Sessions',
  agentHours: 'Agent hours',
  tokens: 'Weighted tokens',
  // --- charts ---
  costByDay: 'Cost by day',
  costByModel: 'Cost by model',
  costByProject: 'Cost by project',
  costByAccount: 'Cost by account',
  accountNote:
    'Only work AgentHydra dispatched: every run records the account it used, so this is known rather than guessed.',
  accountDetail: '{sessions} session(s)',
  modelDetail: '{turns} replies across {sessions} session(s)',
  other: '{n} more',
  whenYouWork: 'When the work happens',
  hourNote: 'Replies by hour of the week, darker where there were more.',
  concurrency: 'Sessions running at once',
  concurrencyNote: 'How many sessions were alive in each window.',
  toolMix: 'Tool mix',
  health: 'Worth a look',
  healthNote:
    'Sessions with a run of failing tools, heavy edit churn, or a context compaction. A signal to go and read one, not a verdict.',
  healthNone: 'Nothing stood out in this window.',
  streak: '{n} failures in a row',
  compactions: '{n} compaction(s)',
  churn: '{n} edits',
  recentEdits: 'Recently edited files',
  editsNote: 'Paths only, grouped by project. Newest first.',
  editsNone: 'No file changes recorded in this window.',
}
