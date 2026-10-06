// Analytics view — spend, activity and health, drawn from per-session totals.
export default {
  title: 'Analytics',
  // Behind the title's and the cost tile's info icons. These are subscription accounts, so nobody is
  // billed per token; the dollar figure answers "what would this have cost on the API".
  listPrice:
    'Costed at published list prices. A subscription plan is not billed per token, so read these as what the same work would cost on the API.',
  partial: 'Totals cover {n} of {total} sessions scanned so far.',
  complete: 'Totals cover all {n} scanned sessions.',
  empty: 'Nothing scanned yet. The totals build in the background shortly after the app starts.',
  emptySources: 'No usage for the selected sources in this period.',
  noExactPrice: 'no exact price',
  rescan: 'Rescan now',
  rescanHint: 'Read any transcript that changed since the last scan',
  rescanDone: 'Scanned {n} session(s).',
  rescanPartial: 'Scanned {n} session(s), then stopped on time. Run it again to continue.',
  rescanFailed: "Couldn't rescan.",
  rescanFailedSome: "Couldn't read {n} transcript(s). They will be retried next time.",
  // --- the unit switch ---
  // Money answers "what would this have cost on the API"; tokens answer "how much did I actually
  // use". Several panels could only ever say the first, which made the second unanswerable on a
  // tab named Analytics. One switch, whole tab, see composables/useAnalyticsPrefs.ts.
  unitMoney: 'Money',
  unitTokens: 'Tokens',
  showTokens: 'Show tokens instead of money',
  showMoney: 'Show money instead of tokens',
  unitToggleHint: 'Switches every chart on this tab between dollars and raw token counts.',
  // Blank bars and "you spent nothing" look identical, so a chart that CANNOT answer in this unit
  // has to say so. Per-day/project/account token splits are newer than the rest of the tab, so a
  // daemon running older code serves buckets with a cost and no token figures at all.
  noTokenData:
    'This build has no token figures for this chart yet. Restart AgentHydra to pick them up, or switch back to money.',
  // --- the lead row: the four numbers that matter most, each beside what it compares with (owner,
  // 2026-10-05: "my eyeballs don't know what to focus on and what I'm supposed to see out of it") ---
  leadUsed: 'Tokens used',
  leadUsedNote:
    'Everything sent and received, cache reads included. On a 30-day or all-time window it is the newest 7 days, compared with the 7 before.',
  leadCost: 'Cost at API rates',
  leadAtRate: '{cost} at your rate',
  leadSaved: 'Saved by HSwarm',
  leadSavedOpen: 'Open HSwarm',
  leadModel: 'Busiest model',
  leadModelNote:
    'The model with the most use in this window, in the unit the tab shows, and its share of all the models in the model chart.',
  leadModelCost: '{pct} of the cost',
  leadModelTokens: '{pct} of the tokens',
  leadUp: '▲ {pct} vs the 7 days before',
  leadDown: '▼ {pct} vs the 7 days before',
  leadSame: 'Same as the 7 days before',
  leadNoneBefore: 'None in the 7 days before',
  leadNoWeekBefore: 'Pick 30 days or All time to compare weeks',
  // --- sessions and tokens: the volume, its kinds and its tools ---
  volume: 'Sessions and tokens',
  volumeNote:
    'How much went through in this window. Tokens is everything sent and received; weighted tokens is a cost-shaped total.',
  totalTokens: 'Tokens',
  sessions: 'Sessions',
  agentHours: 'Agent hours',
  // Why the raw and weighted token figures disagree, said where they sit side by side. Weighted
  // discounts cache reads and multiplies output to approximate cost, so the raw figure is
  // routinely several times the weighted one and neither is wrong.
  tokens: 'Weighted tokens',
  tokensNote: 'Cache reads ×0.1, output ×5: a cost-shaped total, not a raw count.',
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
  costByHour: 'Cost by hour',
  tokensByHour: 'Tokens by hour',
  timeNote:
    'Hover a bar for its exact value, its share of the window and the busiest bar. The current period is blue, the rest gray.',
  // The one accent on the time panel marks the current period; this names it beside the title.
  accentToday: 'Today',
  accentWeek: 'Last 7 days',
  accentMonth: 'This month',
  grainDay: 'Daily',
  grainMonth: 'Monthly',
  grainBars: 'Bars',
  costByModel: 'Cost by model',
  costByProject: 'Cost by project',
  tokensByModel: 'Tokens by model',
  tokensByProject: 'Tokens by project',
  tokensByAccount: 'Tokens by account',
  unpricedTitle: 'No published price',
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
  showMore: '+{n} more',
  showLess: 'Show fewer',
  allVendors: 'All providers',
  sourceFilter: 'Sources',
  pcAll: 'All PCs',
  pcSelf: 'This PC',
  sourceCli: 'Claude CLI',
  sourceDesktop: 'Claude Desktop',
  sourceClimayte: 'CliMayte',
  sourceCodex: 'Codex',
  sourceOpencode: 'OpenCode',
  sourceDsh: 'DSH',
  sourceHermes: 'Hermes',
  sourceHswarm: 'HydraSwarm',
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
  tipBusiestHour: 'Busiest hour',
  tipSessions: 'Sessions',
  tipChange: 'Change',
  tipPeak: 'Peak',
  hoursTitle: 'Busiest hours of the week',
  hourNote:
    'Replies by hour of the week, darker where there were more. The busiest hour is blue.',
  // Two views, two questions. The hour grid answers "what time of day do I work" and throws the
  // calendar away to do it, so it could never answer "which weeks was I actually working": that is
  // the time panel's calendar view.
  grainCalendar: 'Calendar',
  calendarNote:
    'One square per day, darker where more went through. Gaps are days with nothing. The current period is blue.',
  concurrency: 'Sessions running at once',
  concurrencyNote: 'How many sessions were alive in each window.',
  toolMix: 'Tools agents call most',
  // Token sinks: WHY the spend happened, not only how much. Weighted tokens, the same unit as the
  // weighted total under "Sessions and tokens", so the sinks rank against each other.
  sinks: 'What eats tokens',
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
  health: 'Sessions worth a look',
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
  // --- recurring mistakes (fail-then-fix command pairs) ---
  mistakes: 'Commands agents keep getting wrong',
  mistakesNote:
    'Shell commands that failed with a recognisable error and were fixed a few commands later, grouped by kind and command. Read from the newest transcripts when you ask; nothing is stored.',
  mistakesScan: 'Scan',
  mistakesRescan: 'Scan again',
  mistakesCopy: 'Copy as rules',
  mistakesCopied:
    'Rules copied. Paste them into a rules file such as .claude/rules/cli-corrections.md.',
  mistakesCopyFailed: "Couldn't copy to the clipboard.",
  mistakesFailed: "Couldn't read the transcripts.",
  mistakesCoverage: 'Read the newest {n} of {total} sessions.',
  mistakesCoveragePartial: 'Read {n} of {total} sessions, then stopped on time.',
  mistakesNone: 'No fail-then-fix pairs found in these sessions.',
  mistakesCount: '{n}× in {sessions} session(s)',
  mistakeUnknownFlag: 'unknown flag',
  mistakeMissingArg: 'missing argument',
  mistakeWrongPath: 'wrong path',
  mistakeNotFound: 'command not found',
  mistakePermission: 'permission denied',
}
