// Orchestrator settings section (docs/ORCHESTRATOR.md).
export default {
  title: 'Orchestrator',
  hint: 'Watches every live chat and publishes the attention feed the /orchestrate reviewer acts on: who is idle and pending, what needs a handoff, where usage stands.',
  enabledLabel: 'Watch the fleet',
  enabledHint:
    'The watcher only reads local state on a timer. The judgment half is an interactive chat running /orchestrate; enabling here also installs the /orchestrate, /orcstop and /orcstart commands.',
  statusLine: '{live} live chats · {items} pending · {holds} parked',
  holdsLabel: 'Parked threads ({n})',
  holdsHint:
    'Threads you parked with /orcstop. The orchestrator never prompts a parked thread - no resumes, no handoffs, no hygiene nudges - and a hold has no expiry, so it waits here until you lift it. /orcstart inside the chat does the same thing.',
  holdsUnpark: 'Unpark',
  newChatModelLabel: 'New-chat model & effort',
  newChatModelHint:
    'Model and reasoning effort for every chat the orchestrator starts: handoff continuations, chips, terminal launches.',
  newChatUltracodeLabel: 'Ultracode on new chats',
  newChatUltracodeHint:
    'Prepends the "ultracode" opt-in keyword to every orchestrator-started chat, so it runs in exhaustive mode.',
  workModeLabel: 'Full mode (find outstanding work)',
  workModeHint:
    'Off, the orchestrator only watches the chats that already exist - it can revive a dead one or retire a finished one, but it is blind to work nobody has started, so a fleet where every chat is healthy looks like a fleet with nothing left to do. On, it also sweeps your repositories for work that is genuinely outstanding and starts a visible chat to do each one: a quality gate that has not been green since the code last changed, FIXME/HACK/BUG comments that appeared since the previous sweep, and unticked "- [ ]" task boxes in TODO/PROGRESS/ROADMAP files. The sweep itself only reads - it never runs your repo\'s scripts, installs anything, or touches a repository a chat is currently working in. Every find still passes the same check as everything else: the orchestrator AI rules on it before any chat is started, and the chat it starts is one you can watch.',
  backlogStatusLine: '{items} found · {repos} repos · {open} in progress',
  backlogRootsLabel: 'Where to look',
  backlogRootsHint:
    'One path per line. A path that is itself a repository is swept as-is; a path that is not is expanded one level to the repositories directly inside it, so a projects folder covers everything in it without listing each one. Leave it EMPTY and it uses the repositories this machine has actually worked in, which is usually the right answer and needs no setup. Scan now runs a sweep immediately and reports what it found without starting anything.',
  backlogRootsPlaceholder: 'Empty = the repos your chats already work in',
  backlogScanNow: 'Scan now',
  backlogScanMinsLabel: 'Sweep every (minutes)',
  backlogScanMinsHint:
    'How often to look. The sweep is cheap and read-only, but it is not free, and outstanding work does not appear by the second - 30 minutes is the default. Turning full mode on always sweeps immediately rather than waiting for the first interval.',
  backlogMaxOpenLabel: 'Max jobs at once',
  backlogMaxOpenHint:
    'How many pieces of found work may be in flight at the same time. The whole backlog is always discovered and ranked - most serious first - and this only caps how much of it is offered at a time, so the first sweep of a large fleet cannot bury the feed your own chats depend on. Work is never started in a repository another chat is already in.',
  backlogTodoMarkersLabel: 'Count plain TODO comments',
  backlogTodoMarkersHint:
    'Off by default. FIXME, HACK, BUG and XXX are the author saying something is actually wrong; TODO is usually just a note, and in most codebases it is by far the noisiest of the five. Either way, only markers that were NOT there at the previous sweep are ever reported - the first sweep of a repository records what it already has and says nothing, so years of accumulated comments never arrive as news.',
  migrateOnLimitLabel: 'Migrate 5-hour-limited chats',
  migrateOnLimitHint:
    'When a run hits its 5-hour limit but its weekly is fine, resume it immediately on another running account with headroom instead of parking it until the reset. The original account rejoins the pool once its window resets. When the borrowed run finishes, the chat is imported into that account’s desktop app under its own name, so you can see it and carry on there. Needs the auto-resume monitor enabled.',
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
  prompt_closeoutDocs: 'Closeout before archiving (bring docs current)',
  prompt_workStart: 'Backlog job opening turn (full mode)',
  prompt_migrationNotice: 'Account-migration notice',
  commandsLabel: 'Slash commands',
  commandsHint:
    'The orchestrator installs /orchestrate, /orcstop and /orcstart into ~/.claude/commands when enabled. Remove deletes those files and turns the orchestrator off; Reinstall puts the shipped versions back (overwriting local edits).',
  commandsReinstall: 'Reinstall',
  commandsRemove: 'Remove & disable',
  maxActiveChatsLabel: 'Max running chats',
  maxActiveChatsHint:
    'Caps how many chats may actively work at once, fleet-wide. 0 = unlimited. Past the cap, idle chats wait their turn and the orchestrator rotates them round-robin: the chat idle longest gets the next free slot. Answers, handoffs, and revives are never blocked - only "resume working" nudges wait.',
  maxActiveChatsUnlimited: 'Unlimited',
  loadBalanceLabel: 'Balance work across accounts',
  loadBalanceHint:
    'Spreads new work over your open accounts instead of stacking one. Two things change. An account whose 5-hour window is about to reset counts as free capacity rather than a busy one, because whatever it reads now is about to be wiped. And accounts that are about equally loaded are ordered by which was given work least recently, which is what stops several placements decided in the same minute from all landing on the same account - the usage numbers only refresh about once a minute, so without this they all see the same reading and all pick the same winner. It never sends work to a busier account to be fair: having headroom always wins, and balancing only breaks the tie between accounts that are already close.',
  balanceWindowLabel: 'Balancing memory (minutes)',
  balanceWindowHint:
    'How long a placement keeps counting against an account when balancing. It needs to outlast the usage refresh, which is the blind spot this covers; 90 minutes is the default. Shorter reacts faster and spreads less; longer spreads harder and can keep steering away from an account whose usage has already settled.',
  handoffSurfaceLabel: 'Work surface',
  handoffSurfaceHint:
    'Where the orchestrator places ALL the work it starts or continues. Desktop: threads live as chats in your apps and the orchestrator delivers each turn through the app itself, so a chat wakes and runs where you can watch it - no clicking, no terminals, nothing headless. Terminal: visible windows you can watch live. Queue: classic headless runs.',
  surfaceDesktop: 'Desktop app (chats, delivered natively)',
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
