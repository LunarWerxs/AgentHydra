// Orchestrator settings section (docs/ORCHESTRATOR.md).
export default {
  title: 'Orchestrator',
  hint: 'Watches every live chat and publishes the attention feed the /orchestrate reviewer acts on: who is idle and pending, what needs a handoff, where usage stands.',
  enabledLabel: 'Watch the fleet',
  enabledHint:
    'The watcher only reads local state on a timer. The judgment half is an interactive chat running /orchestrate; enabling here also installs the /orchestrate, /delayo and /resumeo commands.',
  statusLine: '{live} live chats · {items} pending · {holds} parked',
  newChatModelLabel: 'New-chat model & effort',
  newChatModelHint:
    'Model and reasoning effort for every chat the orchestrator starts: handoff continuations, chips, terminal launches.',
  newChatUltracodeLabel: 'Ultracode on new chats',
  newChatUltracodeHint:
    'Prepends the "ultracode" opt-in keyword to every orchestrator-started chat, so it runs in exhaustive mode.',
  handoffSurfaceLabel: 'Handoff surface',
  handoffSurfaceHint:
    'Where continuations land. Desktop: run headless, then import the finished work into the owning instance’s app as a visible chat. Terminal: a live window you can watch. Queue: headless only.',
  surfaceDesktop: 'Desktop app (import when done)',
  surfaceTerminal: 'Terminal window (watch live)',
  surfaceQueue: 'Queue (headless)',
  openInstancesLabel: 'Open closed instances',
  openInstancesHint:
    'Whether the reviewer may LAUNCH a desktop instance that is not running. Never: sessions on closed accounts are simply out of play. When exhausted: only once every running instance is out of headroom.',
  openNever: 'Never',
  openWhenExhausted: 'Only when every open account is spent',
  openMinPlanLabel: 'Minimum plan to open',
  openMinPlanHint: 'A closed instance qualifies only if its account plan contains this text.',
  reserveLabel: 'Reviewer reserve (weekly %)',
  tickLabel: 'Pass interval (s)',
  idleQuietLabel: 'Idle after (s)',
  ctxLabel: 'Handoff at context (tokens)',
  softLabel: 'Weekly soft %',
  warnLabel: 'Weekly warn %',
  hardLabel: 'Weekly hard %',
  sessionHighLabel: 'Session high %',
  resetSoonLabel: 'Reset-soon window (min)',
  spikeLabel: 'Spike (weekly Δ%)',
  dirtyLabel: 'Dirty repo after (min)',
  cooldownLabel: 'Nudge cooldown (min)',
}
