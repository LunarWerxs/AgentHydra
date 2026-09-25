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
  // --- the unit switch ---
  // Money answers "what would this have cost on the API"; tokens answer "how much did I actually
  // use". Several panels could only ever say the first, which made the second unanswerable on a
  // tab named Analytics. One switch, whole tab — see composables/useAnalyticsPrefs.ts.
  unitMoney: 'Money',
  unitTokens: 'Tokens',
  showTokens: 'Show tokens instead of money',
  showMoney: 'Show money instead of tokens',
  unitToggleHint: 'Switches every chart on this tab between dollars and raw token counts.',
  // Blank bars and "you spent nothing" look identical, so a chart that CANNOT answer in this unit
  // has to say so. Per-day/project/account token splits are newer than the rest of the tab, so a
  // daemon running older code serves buckets with a cost and no token figures at all.
  noTokenData:
    'This build has no token figures for this chart yet — restart AgentHydra to pick them up, or switch back to money.',
  // --- headline numbers ---
  totalCost: 'Cost',
  totalTokens: 'Tokens',
  // Why the two token tiles disagree, said where they disagree. Raw is everything sent and
  // received; weighted discounts cache reads and multiplies output to approximate cost, so the
  // raw figure is routinely several times the weighted one and neither is wrong.
  totalTokensNote: 'Everything sent and received, uncounted by price.',
  sessions: 'Sessions',
  agentHours: 'Agent hours',
  tokens: 'Weighted tokens',
  tokensNote: 'Cache reads ×0.1, output ×5 — a cost-shaped total, not a raw count.',
  // --- token split ---
  tokenSplit: 'Where the tokens went',
  tokenSplitNote:
    'Cached reads cost about a tenth of fresh input, and output costs several times either, so the split matters more than the total.',
  tokenInput: 'Fresh input',
  tokenCacheRead: 'Cached input',
  tokenCacheWrite: 'Cache writes',
  tokenOutput: 'Output',
  byProvider: 'Tokens by tool',
  providerDetail: '{sessions} session(s) · {cost}',
  // --- charts ---
  costByDay: 'Cost by day',
  costByMonth: 'Cost by month',
  tokensByDay: 'Tokens by day',
  tokensByMonth: 'Tokens by month',
  grainDay: 'Daily',
  grainMonth: 'Monthly',
  costByModel: 'Cost by model',
  costByProject: 'Cost by project',
  tokensByModel: 'Tokens by model',
  tokensByProject: 'Tokens by project',
  tokensByAccount: 'Tokens by account',
  unpricedNote:
    'No published price for these, so their tokens are counted but their cost is not. Showing tokens instead of a dollar figure, because zero would be a claim that they were free.',
  toolsFound: 'Coding tools on this machine',
  toolsFoundNote:
    'Where each one keeps its conversations, and whether AgentHydra can read them yet. Counts are files under the store, capped at 1,000.',
  toolRead: 'read',
  toolUnread: 'not read yet',
  toolNoteEncrypted: 'encrypted',
  toolNoteCredits: 'no token data',
  toolNoteOptIn: 'set its env var',
  pricesFetched: 'Rates downloaded {date}',
  pricesBundled: 'Rates shipped with this build, {date}',
  costByAccount: 'Cost by account',
  accountNote:
    'Only work AgentHydra dispatched: every run records the account it used, so this is known rather than guessed.',
  accountDetail: '{sessions} session(s)',
  modelDetail: '{turns} replies across {sessions} session(s)',
  showMore: 'Show {n} more',
  showLess: 'Show fewer',
  allVendors: 'All providers',
  // --- hover cards ---
  tipReplies: 'Replies',
  tipShare: 'Share of week',
  tipDayTotal: '{day} total',
  tipHourTotal: '{hour}:00 total',
  tipCost: 'Cost',
  tipTokens: 'Tokens',
  tipShareOfWindow: 'Share of window',
  tipBusiestMonth: 'Busiest month',
  tipBusiestDay: 'Busiest day',
  tipSessions: 'Sessions',
  tipChange: 'Change',
  tipPeak: 'Peak',
  whenYouWork: 'When the work happens',
  hourNote: 'Replies by hour of the week, darker where there were more.',
  // Two grains, two questions. The hour grid answers "what time of day do I work" and throws the
  // calendar away to do it, so it could never answer "which weeks was I actually working" — which
  // over a window of months is the one people open this panel for.
  grainCalendar: 'Calendar',
  grainHour: 'Hour of week',
  calendarNote: 'One square per day, darker where more went through. Gaps are days with nothing.',
  concurrency: 'Sessions running at once',
  concurrencyNote: 'How many sessions were alive in each window.',
  toolMix: 'Tool mix',
  // Token sinks: WHY the spend happened, not only how much. Weighted tokens, the same unit as the
  // headline, so the sinks rank against each other.
  sinks: 'Where the tokens went',
  sinksNote:
    'Ranked in weighted tokens. Structural sinks are configuration, behavioral ones are how sessions ran. They overlap, so the shares do not add up to 100%.',
  sinkDeadSkills: 'Skills loaded but never used',
  sinkDeadMcp: 'MCP servers loaded but never called',
  sinkDeepContext: 'Calls past {threshold} tokens of context',
  sinkSubagents: 'Subagent spend',
  sinkCacheWrites: 'Cache writes',
  sinkStructural: 'Structural',
  sinkBehavioral: 'Behavioral',
  sinkEstimated: 'Estimate',
  fixDeadSkills:
    'Uninstall the skills these sessions never invoke, or scope them to the projects that do: each one is re-read on every call.',
  fixDeadMcp:
    'Disable MCP servers these sessions never call, or scope them per project: their instructions ride along on every call.',
  fixDeepContext:
    'Compact or start a fresh session before the context gets this deep: every call re-reads the whole history.',
  fixSubagents:
    'Spawn subagents for wide, parallel searches only: each one pays for its own prefix and history.',
  fixCacheWrites:
    'Keep gaps between turns inside the cache window and avoid editing instructions mid-session.',
  deadSkills: 'Dead skill load',
  deadMcp: 'Dead MCP load',
  deadNone: 'Everything loaded here was used.',
  deadDetail: '~{tokens} tokens each call, loaded in {loaded} session(s), used in {used}',
  sinkCounts:
    '{deep} of {calls} calls ran past the deep-context threshold. {spawns} subagents spawned.',
  cacheByAccount: 'Prompt served from cache, per account',
  sinkUnlinked: 'Not linked to an account',
  health: 'Worth a look',
  healthNote:
    'Sessions with a run of failing tools, heavy edit churn, a context compaction, or code that mostly did not survive. A signal to go and read one, not a verdict.',
  healthNone: 'Nothing stood out in this window.',
  streak: '{n} failures in a row',
  compactions: '{n} compaction(s)',
  churn: '{n} edits',
  survived: '{pct}% kept',
  survivalAverage:
    'Code kept: {pct}% of what agents wrote was still in the file two hours or more later, averaged over {n} session(s).',
  recentEdits: 'Recently edited files',
  editsNote: 'Paths only, grouped by project. Newest first.',
  editsNone: 'No file changes recorded in this window.',
}
