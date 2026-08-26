# Orchestrator - babysit every open chat, so you don't have to

You have five Claude Desktop instances open and ten chats working. One by one they finish,
print their recap ("What I did / Am I 100% done? / Do I recommend anything else?"), and sit
there waiting for you to type the same sentence you always type: *"Resume working on whatever
you recommend next."* Meanwhile one account is quietly at 91% weekly, a repo has been dirty
for three hours because nobody committed, and a chat at 800k context should have handed off to
a fresh thread an hour ago.

The orchestrator automates that babysitting. It is **two halves**, split by a hard technical
boundary that was measured, not assumed:

1. **The watcher** (this daemon, `server/src/orchestrator.ts`) - a deterministic 60-second
   pass that reads what is already on disk and decides *what needs attention*. It costs no
   AI tokens, ever. OFF by default.
2. **The reviewer** - an ordinary interactive Claude chat you keep open, running the
   `/orchestrate` loop. It reads the watcher's attention feed and makes the judgment calls:
   nudge, answer, hand off, stop. It is the only half that can talk to your *live* chats.

## Why two halves (the delivery matrix)

Measured on 2026-08-25, Claude Code v2.1.237:

| Channel | Can reach a LIVE desktop chat? | Can reach a closed/finished session? | Available to |
|---|---|---|---|
| Peer messaging (`SendMessage`/`ListAgents`) | **Yes** - arrives as a user turn, renders in the desktop UI, session acts on it; cross-instance | No | **Interactive** sessions only. A headless `claude -p` dispatch has **no** peer tools (verified: probe returned TOOL-UNAVAILABLE) |
| AgentHydra queue dispatch (`--resume`, instance-pinned) | No - appends to the transcript, but the open renderer showing it is *not a stable interface* (see REFERENCE.md) | **Yes** - verified end-to-end, credential-pinned | The daemon |

So: the daemon cannot nudge a live chat, and a live chat's Claude cannot cheaply poll disk
every 60 seconds. The watcher watches; the reviewer speaks. Each half does the thing only it
can do.

The peer-name ↔ transcript mapping that glues them together is deterministic:
`~/.claude/sessions/<pid>.json` is the live registry - `name` is the peer address
(`publicprojects-c5`), `sessionId` is the transcript id, plus cwd and pid. The watcher
validates the pid is alive and joins the two worlds.

## The watcher

Every tick (default 60s, only while `enabled`):

- **Live sessions** - reads the registry, tails each live session's transcript (adaptive
  window; some transcripts carry multi-MB single lines), and classifies: how long quiet, what
  ended the last turn (reusing `session-ending.ts` - complete / interrupted / usage-limit /
  overload / refused / error), whether a recap block is present, current context tokens (from
  the last assistant event's usage), any `spawn_task` chips in the tail, and the last real
  human message.
- **Usage** - reads the existing usage cache (`usage-cache.ts`; zero extra network) and bands
  every instance: ok < soft (80) ≤ elevated < warn (85) ≤ high < hard (90) ≤ critical. Flags
  band *crossings*, spikes (weekly % jumping ≥ `spikePct` between reads), and applies the
  reset-soon exemption: an account resetting within `resetSoonMins` is a *dump target*, not a
  problem.
- **Git hygiene** - for each live session's cwd that is a git repo: dirty file count, how long
  it has been continuously dirty (persisted across restarts), current branch, unpushed count.
  A non-main branch or a worktree checkout is flagged immediately (standing owner rule: work
  happens on main).
- **Attention feed** - everything that crosses a threshold becomes an attention item with a
  stable key, a tail snippet big enough to judge from (so the reviewer never has to open the
  transcript), and cooldown tracking. The reviewer acks what it acts on; acked items stay
  suppressed until the cooldown passes *and* the session has moved since.

The watcher never calls Anthropic, never messages a session, never touches your repos, and
never resumes rate-limited sessions (the auto-resume monitor's job; they compose fine). Its
one licensed ACTION is auto-revive (below, owner-ordered): starting a dead chat's engine
through the app's own UI, under hard safety gates.

### API

```
GET  /api/orchestrator            settings + attention feed + the instances routing table + holds + tick metadata
POST /api/orchestrator            patch settings ({ enabled: true } is the on switch)
POST /api/orchestrator/ack        { key, action, cooldownMins? } - reviewer marks an item handled
POST /api/orchestrator/check      run one pass now
POST /api/orchestrator/hold       { session_id, held } - park/unpark one thread (/delayo, /resumeo)
POST /api/sessions/launch-terminal  { cwd, prompt, instance_ref?, model? } - open a VISIBLE
                                  terminal running a new interactive session on that account
POST /api/sessions/:id/import-desktop  { instance_ref?, title? } - import a FINISHED session
                                  into that instance's desktop app as a visible chat (refused
                                  when the instance is not running - importing would boot it;
                                  always pass title or the chat lands as "Untitled")
POST /api/sessions/:id/desktop-archive { archived? }     - archive/unarchive the chat in the
                                  desktop app (shows after that instance next restarts when
                                  its app was running at the time)
POST /api/sessions/:id/migrate  { instance_ref }        - move a chat to another account, end to
                                  end: stops its live process if any, archives its old desktop
                                  entries, runs a one-turn migration on the target account, then
                                  auto-imports it into that instance's app under its real title
```

**Migrate-on-limit** (`migrateOnLimit`, off by default): a run stopped by its 5-HOUR limit whose
weekly is fine resumes immediately on another running account with headroom instead of parking
until the reset - the original account rejoins the routing pool naturally once its window
resets. Rides the auto-resume monitor (which must be enabled) and picks targets from the same
routing table the reviewer uses: running, fresh reading, weekly under the hard band, 5-hour
under the high band. In the app, every Claude chat's menu also has **Migrate to another
account**, a flyout of running instances that runs the full migration pipeline on click.

The migrated resume carries `import_to`/`import_title`, so when the borrowed-account run
completes, `finalize()` lands it in that instance's desktop app as a visible chat under the
thread's own name - the same delivery the menu route uses. Without it a limit-migration
finished headless and the owner never saw it anywhere, which was the one gap left in the
migrate story. Three deliberate choices behind it:

- **Only a migration imports.** A same-account auto-resume writes no import fields: that chat is
  already in the app it belongs to, and transcripts are shared across instances
  (`~/.claude/projects`), so a second entry would just duplicate the same thread.
- **It does not archive the old desktop entries**, though the menu route does. That route is
  user-initiated and settles in seconds; this one fires unattended and a migrated run can be
  long, so the target instance may have closed by the time it finishes (the import refuses to
  boot a closed instance, by design). Archive-then-fail would leave the thread visible in no app
  at all, which is strictly worse than the duplicate entry.
- **The title is the thread's, not the plumbing's.** Queue titles nest across stops ("Migrated
  resume: Auto-resume: Ship the parser"); `baseTitle()` in monitor.ts peels those prefixes off
  for both the imported chat's name and the queue row itself.

**A delivery is retried until it lands, and says so if it never does.** Every import in this
document - the migrate menu, migrate-on-limit, the desktop handoff surface - runs through the
same delivery path in dispatch.ts, and all of them share one hazard: the import can only fire
while the target instance is RUNNING, because firing it at a closed one would boot that account.
That refusal used to be terminal - a single `console.error`, and finished work never appeared
anywhere while its queue row still read `completed`. Since the whole point of overnight
migration is that nobody is watching, "their app happened to be shut when it finished" was
enough to lose the delivery outright.

So a completed run with `import_to` is ARMED (`import_state = 'pending'`) rather than fired once.
`deliverPendingImports()` retries every minute until it lands, then records `done`; after 24
hours unreachable it records `gave_up` with the last refusal in `import_error`. The sweep is
ALWAYS ON, gated on neither `scheduler_enabled` nor `monitor_enabled`, for the same reason the
transient-overload retry sweep beside it is not: those switches govern hours-scale autonomy,
while this only finishes delivering something the user already asked for. It also runs inside the
boot window `isDispatchReady()` guards, deliberately - that guard stops two `claude --resume`
landing on one transcript, and an import writes no transcript; the guard that matters here is
inside the import, which refuses a session that is live. In the queue UI a finished run carrying
an undelivered chat wears a badge, so a waiting or abandoned delivery is visible rather than
inferred. A spawn that lands but cannot write the chat's title is `done`, not pending: the
conversation is in the app, which is the delivery, and re-firing would not name it any better.

**Parking a thread**: type `/delayo` in any chat and the orchestrator stops prompting it -
no resumes, no handoffs, no hygiene nudges - until you type `/resumeo` there. The watcher
drops a held thread's items entirely and the feed's `holds` list shows what is parked, so a
delayed thread is invisible to the reviewer but never forgotten. Holds persist across daemon
restarts and have no expiry.

Because they never expire, the Orchestrator settings group **lists the parked threads** (name,
repo, how long ago) with an Unpark button on each, appearing only when there are any. The status
line's count alone could not tell you WHICH thread you parked, so the only way back out was to
remember the chat and type `/resumeo` inside it - which is a poor guarantee for a hold with no
expiry. Unparking adopts the server's returned list rather than splicing locally, since the same
hold can be lifted from inside the chat at any moment.

The feed's `instances` array is the routing table: every desktop instance with `isRunning`,
account, plan, weekly %, band, reset-soon and staleness. **Open means running, nothing else** -
a running instance with zero chats is open capacity, and a session on a non-running instance is
not resumable and not the orchestrator's to touch (the first live run undercounted the fleet by
inferring openness from which chats existed; this table is the fix).

Same four verbs over MCP: `get_orchestrator`, `set_orchestrator`, `orchestrator_ack`,
`orchestrator_check`.

### Attention item kinds

| kind | meaning | typical reviewer action |
|---|---|---|
| `idle_pending` | live chat quiet ≥ `idleQuietSecs` with a completed last turn; payload says if a recap is present, context tokens, ending | read tail → "Resume working on whatever you recommend next.", answer its question, or leave for the human |
| `handoff_due` | an `idle_pending` whose context ≥ `ctxHandoffTokens` | send the handoff instruction instead of a resume |
| `interrupted` / `errored` | last turn ended by interrupt/API error/refusal | usually leave for the human; overload (529) may simply be re-nudged |
| `usage_alert` | band crossing, spike, or hard breach on an instance | stop routing work there; at `hard`, tell that instance's chats to wrap up now |
| `repo_dirty` | cwd dirty ≥ `dirtyMins` with no commit, all its sessions idle | nudge the owning chat to commit + sync (path-scoped adds, never `git add -A`) |
| `branch_off_main` | a session cwd is on a non-main branch / worktree | nudge back onto main |
| `chip` | a session offered a `spawn_task` chip (title + prompt captured) | queue it via `/api/queue` on the best account, or surface to the human |
| `limit_stopped` | a live chat's last turn ended at a usage limit | none (the auto-resume monitor's jurisdiction; check `/api/monitor`) |
| `orphaned` | the session's PROCESS DIED mid-work (computer restart, crash, kill): its live-registry file outlived its pid | revive per the surface preference: desktop → the chat is still in its instance's sidebar, one status line asks the owner to click it back to life; terminal → `launch-terminal` with `resume_session_id` and a verify-first prompt |

### Restart recovery (orphaned sessions)

A graceful CLI exit deletes its own `~/.claude/sessions/<pid>.json`; a hard stop (computer
restart, crash, kill) leaves the file behind with a dead pid. The watcher reads that residue
every tick: superseded files (the session lives again under a new pid), done-marked lineages,
and owner-archived chats are cleaned silently; everything else is genuinely unfinished work
and becomes an `orphaned` item after `idleQuietSecs` of transcript silence.

The second flavor has NO residue: a normal PC restart shuts sessions down gracefully, so the
registry file is deleted while the chat still sits un-archived in a desktop sidebar with a
transcript that ends mid-turn (found live 2026-08-25: an architect chat sat "CLICK TO RESUME"
through a restart, invisible to the dead-pid pass). The STRANDED scan covers it: every tick,
transcripts touched in the last 48h (a ~60ms store walk) are checked, and a non-live,
non-done, non-held, non-archived desktop chat with a mid-turn tail and no in-flight dispatch
becomes the same `orphaned` item with `detail.stranded: true`.

The third flavor is LIVE BUT DEAF (`detail.deaf: true`): import/migrate deliveries spawn a
real process whose ENGINE never starts: peer messages queue into it forever, and it
masquerades as an ordinary idle chat (found live: a migrated chat sat six hours as "idle 6m"
while every reviewer nudge vanished). The deterministic test: the registry's process
`startedAt` against the transcript's newest record timestamp: a process with no record newer
than its own spawn has never run a turn.

### Auto-revive (the daemon acts, `autoRevive`, ON by default)

Owner order 2026-08-25: a dead chat nobody revives means the orchestrator is not working, so
the daemon revives orphaned/stranded/deaf desktop chats ITSELF. `reviveDesktopChat`
(session-launch.ts, Windows only) deep-links the chat open in its app, focuses the window,
clicks the composer, pastes `prompts.orphanRevive`, presses Enter, and then verifies the
ENGINE: only a transcript growing within 75s counts as revived (registry-live is not
running). Safety gates: never while the owner has touched the keyboard in the last 45s
(retries next tick), never over a transcript that is actively growing, never a done-marked
lineage, never a closed instance. One attempt per tick, retries on a 15-minute cooldown after
failure, 60 minutes after success; attempts are visible as `auto-revive:<sid>` acks.

### The visibility sweep (no invisible chats)

Every ~10 minutes: any completed queue run from the last 48h whose session has NO desktop
entry anywhere (a chat the machinery started that the owner cannot see) is imported into its
owning running instance's app. From there the deaf detector and auto-revive take over, so
work the plumbing started always ends up visible and running on screen. The whole flow is
self-healing - the moment the owner clicks a dead desktop chat back to life (or a terminal
resume lands), the next tick sees the live successor and retires the orphan file. Queue runs
that were in flight when the daemon died are a separate, older recovery (`reattachRuns` at
boot: replay the on-disk log, resume tailing or finalize).

### One lineage, one continuation (the duplicate-work guard)

Field report (2026-08-25): chats complained their work was being overridden - two sessions
had ended up continuing the same task. The unique identifier for a thread is its **session
id**; its disposition is the **done-mark ledger** (`session_marks`, written by
`POST /api/sessions/<id>/done`). The rules, enforced in code rather than by convention:

- A done-marked session generates **no attention items** (no nudges, no hygiene addressing) -
  its successor owns the task. The archive janitor is what retires its desktop entries.
- `launch-terminal` (resume), `import-desktop`, and `migrate` all **refuse a done-marked
  session with 409 `superseded`** unless `force: true` (for the owner's deliberate
  resurrections only). The same guard sits inside the primitives, so the finalize auto-import
  and the monitor's surface-aware resumes are covered too.
- The auto-resume monitor **cancels a scheduled resume** whose session was done-marked after
  scheduling.
- The reviewer's rubric orders the handoff flow: done-mark the old chat FIRST, then start the
  successor - so a crash between the two steps leaves a missing continuation (recoverable:
  the handoff is still in the transcript) rather than a duplicate one (not recoverable: both
  copies write to the same repo).

## The reviewer (`/orchestrate`)

An interactive chat - desktop or terminal - because only interactive sessions carry the peer
tools. Open a chat on a **low-usage account**, model **Sonnet**, and start the loop. A plain
`claude` in a terminal works exactly as well as a desktop chat: any interactive session joins
the live registry and gets the peer tools (use a logged-in CLI instance's `CLAUDE_CONFIG_DIR`
to pick which account pays for it).

**The command ships inside AgentHydra itself.** The daemon carries the file's text (bundled
into compiled builds too) and writes `~/.claude/commands/orchestrate.md` on its own the first
time you enable the orchestrator, so a fresh machine needs no manual copy. To (re)install
explicitly - a new machine, or after an update changed the command:

```
POST /api/orchestrator/install-command            installs when absent; reports 'differs' if you edited yours
POST /api/orchestrator/install-command {"force": true}   overwrite your copy with the shipped one
```

(also the `orchestrator_install_command` MCP tool). A copy you have edited is never silently
overwritten - your edits are newer intent, not drift.

What the loop does, per wake:

1. `GET /api/orchestrator` (one call). Nothing pending → subscribe `notify_when_idle` to any
   new busy peers and sleep. Something pending → judge each item by the rubric in the command
   file, act, `ack`.
2. Delivery: live chat → `SendMessage` by peer name. Closed session / new work (chips,
   handoff continuations) → `POST /api/queue` instance-pinned to the account with the most
   weekly headroom (respecting the 80/85/90 bands and the reset-soon exemption).
3. Pacing: it does not poll at a fixed 60s. `notify_when_idle` gives push notifications the
   moment a peer finishes its turn - *faster* than polling - and a long heartbeat covers
   usage/git/chips. Idle cost is a few small requests per hour.

Hard rails written into the command file: never enable or use remote control (everything
stays on this machine); never work in a worktree or branch; a real human message in a chat
pauses orchestration of that chat; never answer a session's question by picking a
destructive or regressive option - skip and surface instead; never push a public repo
without the PUBLIC warning protocol.

## Turning it on

1. Daemon side: `POST /api/orchestrator {"enabled": true}` (or the `set_orchestrator` MCP
   tool). Defaults are sane; tune later.
2. Reviewer side: open a fresh chat on a quiet account and type `/orchestrate`.

Turning it off is the reverse in either order; each half degrades safely without the other
(the feed just accumulates; the reviewer just finds an empty feed).

## Settings (all `POST /api/orchestrator`)

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | master switch for the watcher |
| `tickSecs` | 60 | pass interval (30–600) |
| `idleQuietSecs` | 150 | quiet time before a live chat counts as pending |
| `ctxHandoffTokens` | 700000 | context size that turns a nudge into a handoff |
| `softPct` / `warnPct` / `hardPct` | 80 / 85 / 90 | weekly-band thresholds |
| `sessionHighPct` | 90 | 5-hour band threshold reported alongside |
| `resetSoonMins` | 120 | within this of a reset, a high band is a dump target instead |
| `spikePct` | 5 | weekly jump between reads that flags a spike |
| `dirtyMins` | 60 | continuous dirty time before a repo is flagged |
| `staleTaskMins` | 120 | a "waiting on background tasks" chat whose transcript AND task outputs have both been silent this long is flagged as stuck on dead tasks (the reviewer intervenes instead of waiting forever) |
| `nudgeCooldownMins` | 15 | default ack cooldown for session items |
| `openInstances` | `never` | whether the reviewer may LAUNCH a closed instance; `when-exhausted` allows it only once every running instance is out of headroom |
| `openMinPlan` | `Max 20` | minimum plan an auto-opened instance must have |
| `reviewerReservePct` | 75 | the reviewer's own account stays under this weekly % so it can always keep orchestrating |
| `handoffSurface` | `desktop` | where handoff continuations land: `desktop` (headless run, then imported into the desktop app as a visible chat), `terminal` (watchable live window), or `queue` (headless only) |
| `newChatModel` | `opus` | model for every orchestrator-started chat (handoffs, chips, launches) |
| `newChatEffort` | `max` | reasoning effort for those chats (`low`/`medium`/`high`/`xhigh`/`max`) |
| `newChatUltracode` | `true` | prepend the `ultracode` opt-in keyword to every orchestrator-started chat's prompt |
| `migrateOnLimit` | `false` | 5-hour-limited runs (weekly fine) resume immediately on another running account instead of waiting for the reset; needs the auto-resume monitor on |
| `maxActiveChats` | 0 (unlimited) | caps how many chats may actively WORK at once, fleet-wide. Past the cap the watcher marks overflow idle chats `waitingForSlot` and the reviewer skips them without acking; the rotation is round-robin by construction: longest-idle gets the next free slot, a nudged chat re-enters at the back. Only resume nudges and new work are gated; answers, handoff continuations (replacements), and orphan revives never wait |

### Prompts (editable, defaults shipped)

Every message the machinery sends into a chat is a named template: `resumeNudge`,
`handoffRequest`, `staleTaskNudge`, `hardCutoff`, `overloadNudge`, `commitNudge`,
`branchNudge`, `orphanRevive`, `migrationNotice`. The shipped texts are the defaults; the
owner edits any of them under Settings -> Automation -> Orchestrator -> Prompts (or
`POST /api/orchestrator {"prompts": {...}}`), and a blank edit (or saving the default text
verbatim) restores the default so future shipped improvements still land. `GET
/api/orchestrator` serves the resolved set as `prompts` plus `promptDefaults`; the reviewer
always sends `prompts.<name>` from the feed, and the daemon uses `migrationNotice` itself for
migrate flows. Placeholders in `<angle brackets>` are substituted at send time.

### Load balancing (5-hour windows)

The `instances` routing table arrives pre-sorted for placement: running first, then weekly
band (reset-soon counts as healthy, the dump-target exemption), then LOWEST 5-hour session
%, then lowest weekly %. With several accounts open, consecutive placements spread across the
top rows instead of stacking one account's 5-hour window (owner rule 2026-08-25).

### Removing it

`POST /api/orchestrator/uninstall-command` (Settings: "Remove & disable", or the
`orchestrator_uninstall_command` MCP tool) turns the watcher off and deletes the three
shipped command files from `~/.claude/commands`, edited copies included. Reinstalling is one
enable (or the install endpoint) away.

## Where new sessions show up (and where they cannot)

- A **desktop import** (`POST /api/sessions/:id/import-desktop`, the default handoff surface)
  lands a FINISHED session as a real chat in the target instance's desktop app - the app's own
  `claude://resume` one-way import, aimed at one instance via its profile dir. Verified live:
  the chat appears in the sidebar, fully rendered, on the right account. Two hard rules: never
  import a session that is still running (the import rewrites the transcript under an active
  writer), and a just-imported chat does not process orchestrator messages until you first
  click into it - import delivers finished work; it is not a steering channel.
- A **terminal launch** appears as a real window on your screen, joins the live registry, and
  is orchestratable while it works - the surface for watching a continuation live.
- A **queue run** is headless: it exists only in AgentHydra's Sessions/Queue tabs (live-tail
  there). It never appears in the desktop app and the orchestrator cannot nudge it mid-run.
- **Desktop archiving works, with one honest caveat.** The desktop keeps a per-chat metadata
  flag, and `POST /api/sessions/:id/desktop-archive` flips it in every profile that carries the
  chat. For an instance whose app is RUNNING, the sidebar reflects it only after that app next
  restarts (the running app holds its list in memory and may even re-save the old state); for
  closed instances it is reliable. Handed-off chats get AgentHydra's done-mark as the immediate
  signal plus the archive flag for the desktop's next start.

## Limitations, stated out loud

- The reviewer must be an interactive session; a scheduled task or headless run cannot carry
  the loop (no peer tools there - measured, not guessed).
- Headless continuation of a chat whose window is *open* is deliberately not done: the
  transcript would advance under a renderer that may not show it (REFERENCE.md documents the
  instability). Open chats are nudged through the front door instead.
- Context-size numbers come from the last assistant event's token usage - accurate enough for
  a handoff threshold, not an accounting tool.
- Windows-verified. The registry/transcript formats are the CLI's own and could shift with a
  CLI release; every parser here fails soft (a session it cannot read is reported as
  unreadable, never guessed at).
