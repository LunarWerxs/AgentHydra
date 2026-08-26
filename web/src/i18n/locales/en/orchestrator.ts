// Orchestrator settings section (docs/ORCHESTRATOR.md).
export default {
  title: 'Orchestrator',
  hint: 'Watches every live chat and publishes the attention feed the /orchestrate reviewer acts on: who is idle and pending, what needs a handoff, where usage stands.',
  enabledLabel: 'Watch the fleet',
  enabledHint:
    'The watcher only reads local state on a timer. The judgment half is an interactive chat running /orchestrate; enabling here also installs the /orchestrate, /delayo and /resumeo commands.',
  statusLine: '{live} live chats · {items} pending · {holds} parked',
  holdsLabel: 'Parked threads ({n})',
  holdsHint:
    'Threads you parked with /delayo. The orchestrator never prompts a parked thread - no resumes, no handoffs, no hygiene nudges - and a hold has no expiry, so it waits here until you lift it. /resumeo inside the chat does the same thing.',
  holdsUnpark: 'Unpark',
  newChatModelLabel: 'New-chat model & effort',
  newChatModelHint:
    'Model and reasoning effort for every chat the orchestrator starts: handoff continuations, chips, terminal launches.',
  newChatUltracodeLabel: 'Ultracode on new chats',
  newChatUltracodeHint:
    'Prepends the "ultracode" opt-in keyword to every orchestrator-started chat, so it runs in exhaustive mode.',
  migrateOnLimitLabel: 'Migrate 5-hour-limited chats',
  migrateOnLimitHint:
    'When a run hits its 5-hour limit but its weekly is fine, resume it immediately on another running account with headroom instead of parking it until the reset. The original account rejoins the pool once its window resets. When the borrowed run finishes, the chat is imported into that account’s desktop app under its own name, so you can see it and carry on there. Needs the auto-resume monitor enabled.',
  autoReviveLabel: 'Auto-revive dead chats',
  autoReviveHint:
    'When a desktop chat is found dead or deaf (killed by a restart, or spawned by plumbing and never started), the orchestrator revives it itself: opens the chat in its app, types the revive prompt, and verifies the engine actually started. Only acts while you are away from the keyboard, never touches a chat that is actively working, and never boots a closed account. Windows only.',
  promptsLabel: 'Prompts',
  promptsHint:
    'The exact messages the orchestrator sends into chats. The shipped texts are the defaults; edit any of them and your wording is used instead - blank it (or Reset) to go back to the default. Placeholders in <angle brackets> are filled in when sent.',
  promptsPlaceholders:
    'Placeholders: <n> a number, <cwd> a repo path, <m> minutes, <duration> a time span, <x> a branch name. Leave them in - they are filled at send time.',
  promptReset: 'Reset',
  prompt_resumeNudge: 'Resume nudge (idle chat with a recap)',
  prompt_handoffRequest: 'Handoff request (context too large)',
  prompt_staleTaskNudge: 'Dead-tasks intervention',
  prompt_hardCutoff: 'Hard usage cutoff',
  prompt_overloadNudge: 'Server-overload retry',
  prompt_commitNudge: 'Uncommitted-repo nudge',
  prompt_branchNudge: 'Off-main-branch nudge',
  prompt_orphanRevive: 'Crash / restart revival',
  prompt_migrationNotice: 'Account-migration notice',
  commandsLabel: 'Slash commands',
  commandsHint:
    'The orchestrator installs /orchestrate, /delayo and /resumeo into ~/.claude/commands when enabled. Remove deletes those files and turns the orchestrator off; Reinstall puts the shipped versions back (overwriting local edits).',
  commandsReinstall: 'Reinstall',
  commandsRemove: 'Remove & disable',
  maxActiveChatsLabel: 'Max running chats',
  maxActiveChatsHint:
    'Caps how many chats may actively work at once, fleet-wide. 0 = unlimited. Past the cap, idle chats wait their turn and the orchestrator rotates them round-robin: the chat idle longest gets the next free slot. Answers, handoffs, and revives are never blocked - only "resume working" nudges wait.',
  maxActiveChatsUnlimited: 'Unlimited',
  handoffSurfaceLabel: 'Work surface',
  handoffSurfaceHint:
    'Where the orchestrator places ALL the work it starts or continues. Desktop: threads live as chats in your apps - continuations arrive as queued messages and your first click on a chat activates it; no terminals, nothing headless. Terminal: visible windows you can watch live. Queue: classic headless runs.',
  surfaceDesktop: 'Desktop app (chats + your click)',
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
  staleTaskLabel: 'Dead tasks after (min)',
  cooldownLabel: 'Nudge cooldown (min)',
}
