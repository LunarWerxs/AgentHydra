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
never acts on a thread AT ALL (owner law 2026-08-26, the ACTION GATE): when it wants
something done - a revive, an archive, an import - it writes a PROPOSAL and the reviewer
decides it, executes the approved ones itself, and reports the outcome. The only things the
daemon still does alone are thread-neutral hygiene: naming untitled chats from the scanner,
cleaning dead-pid registry residue, and restarting an idle app so approved changes repaint.

### API

```
GET  /api/orchestrator            settings + attention feed + the instances routing table + holds + tick metadata
POST /api/orchestrator            patch settings ({ enabled: true } is the on switch)
POST /api/orchestrator/ack        { key, action, cooldownMins? } - reviewer marks an item handled
POST /api/orchestrator/check      run one pass now
POST /api/orchestrator/hold       { session_id, held } - park/unpark one thread (/orcstop, /orcstart)
POST /api/orchestrator/proposals/:id/decide    { approved, by?, note? } - the reviewer's ruling
                                  on one proposed action (the action gate; decide-then-execute
                                  is enforced)
POST /api/orchestrator/proposals/:id/executed  { ok, result? } - the execution report after the
                                  reviewer carried an approved proposal out
POST /api/orchestrator/renamed    { session_id } - the reviewer reports a NATIVE rename done,
                                  dropping that chat from the feed's `renames` list
POST /api/orchestrator/placement  { instance_ref, kind?, session_id? } - record that work was
                                  placed on an account, for balancing. The primitives record
                                  themselves; this is for the one path they cannot see, the
                                  reviewer delivering a turn natively into an existing chat
POST /api/orchestrator/backlog/scan      sweep the repositories for outstanding work NOW instead
                                  of at the next interval (full mode; read-only). A scan asked
                                  for while the mode is OFF answers "what would this find?" and
                                  starts nothing
POST /api/orchestrator/backlog/resolved  { key, ok?, sha? } - the reviewer's outcome report for
                                  one backlog item. A `gate` item resolved with its sha stays
                                  quiet until that repo's code moves; `ok: false` counts against
                                  the item's retry budget
POST /api/orchestrator/selftest   { deep? } - run the real guards against real state and report
                                  each check (see below). Safe on a live fleet; `deep` also seeds
                                  ONE real chat, proves it visible, and archives it
GET  /api/orchestrator/reviewer-journal   the compact successor briefing the server maintains by
                                  itself: recent rulings with their notes, in-flight items with
                                  their saved verbatim steps, standing context (workMode, holds,
                                  pending renames). Records, never decides
GET  /api/orchestrator/reviewer-seed      ready-to-paste opening prompt that briefs ANY fresh
                                  chat as the SUCCESSOR reviewer (?format=text for the raw
                                  prompt). The reviewer is a role, not a chat: reviving it means
                                  booting a new chat with this, never resurrecting the dead one.
                                  Neither endpoint stamps lastReviewerAt - they are read while
                                  the reviewer is dead, and a probe that stamps presence masks
                                  the very stall it exists to fix
POST /api/screenshot              { path? } - capture the screen to a PNG and return its path, so
                                  a claim about what is ON SCREEN can be looked at rather than
                                  inferred from disk. Interprets nothing: a camera, not a judge
POST /api/sessions/seed-desktop   { cwd, title, instance_ref } - create a brand-new VISIBLE
                                  desktop chat (fabricated minimal transcript + import); the
                                  reviewer then delivers the real prompt through the app's own
                                  message channel, which boots the engine and runs the turn in
                                  the app - the desktop-native replacement for queue-with-
                                  import-back
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
                                  entries, and imports it into the target instance's app. NO turn
                                  is run and nothing goes headless - transcripts are shared across
                                  instances, so a move needs no work done to it. The caller
                                  delivers any prompt natively afterwards.
```

**Migrate-on-limit** (`migrateOnLimit`, off by default): a run stopped by its 5-HOUR limit whose
weekly is fine resumes immediately on another running account with headroom instead of parking
until the reset - the original account rejoins the routing pool naturally once its window
resets. Rides the auto-resume monitor (which must be enabled) and picks targets from the same
routing table the reviewer uses: running, fresh reading, weekly under the hard band, 5-hour
under the high band. In the app, every Claude chat's menu also has **Migrate to another
account**, a flyout of running instances that runs the full migration pipeline on click.

A limit-migration still runs on the borrowed account through the queue, because a run stopped
by a usage wall is AgentHydra's own work rather than one of the owner's desktop threads; it
carries `import_to`/`import_title` so `finalize()` lands the result in that instance's app
instead of finishing where nobody looks. **A DESKTOP thread never takes this path** - the
surface-purity guard in dispatch.ts refuses to continue one headlessly at all, and the monitor
hands those to the reviewer as a revive proposal delivered natively.

> **SUPERSEDED 2026-08-27.** Since the no-headless law (above), NO thread takes this path, not
> merely desktop ones: `dispatchItem` refuses every headless run, so a limit-migration cannot run
> on the borrowed account through the queue any more. The migration itself is unaffected, because
> moving a chat between accounts never needed a turn run against it; what is gone is the headless
> resume that used to follow. The paragraphs below describe the import-back as it was built and
> are kept because the reasoning still explains the surrounding machinery.

Three deliberate choices behind the import-back that remains:

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

**Parking a thread**: type `/orcstop` in any chat and the orchestrator stops prompting it -
no resumes, no handoffs, no hygiene nudges - until you type `/orcstart` there. The watcher
drops a held thread's items entirely and the feed's `holds` list shows what is parked, so a
delayed thread is invisible to the reviewer but never forgotten. Holds persist across daemon
restarts and have no expiry.

Because they never expire, the Orchestrator settings group **lists the parked threads** (name,
repo, how long ago) with an Unpark button on each, appearing only when there are any. The status
line's count alone could not tell you WHICH thread you parked, so the only way back out was to
remember the chat and type `/orcstart` inside it - which is a poor guarantee for a hold with no
expiry. Unparking adopts the server's returned list rather than splicing locally, since the same
hold can be lifted from inside the chat at any moment.

The feed's `instances` array is the routing table: every desktop instance with `isRunning`,
account, plan, weekly %, band, reset-soon and staleness. **Open means running, nothing else** -
a running instance with zero chats is open capacity, and a session on a non-running instance is
not resumable and not the orchestrator's to touch (the first live run undercounted the fleet by
inferring openness from which chats existed; this table is the fix).

Over MCP: `get_orchestrator`, `set_orchestrator`, `orchestrator_ack`,
`orchestrator_check`, plus `orchestrator_hold` (park/unpark one thread, the /orcstop pair) and
`orchestrator_install_command` / `orchestrator_uninstall_command`.

**Every revive proposal carries `evidence.chatId`, the id the app's own tools take.** It is the
chat's metadata FILENAME, which is `local_<sessionId>` only for IMPORTED chats; a chat the app
created is filed under the app's own id, and 1,325 of this fleet's 1,343 chats are that shape.
The reviewer previously had a session id and tools that wanted a chat id, with nothing bridging
them, and a relay round landed 0 of 4 addressing chats that did not exist. The bridge already
existed inside the store scan and was being discarded.

**Every session-scoped item's evidence names the account that would pay for acting on it:**
`account`, `accountWeeklyPct`, `accountSessionPct`, `accountSessionResetsAt` - weekly AND the
5-hour window, because the 5-hour cap is the one that kills a resume mid-turn. Until 2026-08-29
all four read null on Windows for every chat: the usage cache is keyed through `desktopKey()`
(normalized, lowercased) while `instanceRefForSession()` returns the real-cased dir, and the
evidence composer indexed one with the other raw, so the join never landed. A reviewer
blind-approved a resume on that blank evidence and the chat died 24 minutes later on "You've hit
your session limit". The join now goes through `usageForInstanceRef()` (orchestrator.ts), and
any resume/nudge/revive item whose account is weekly high/critical or 5-hour ≥ `sessionHighPct`
carries a `⚠ LIMIT RISK` line in `constraintsApplied`, the same thresholds placement uses to
refuse the account new work. Reviewers: treat that line as a strong default-reject; it is
deliberately a WARNING, not a refusal, so a genuinely urgent nudge stays possible; tightening
it to a hard block is a one-line policy change still open for the owner to call. Verified by
`server/tests/orchestrator-usage-evidence.test.ts` and green CI on both legs (commits 8349b9a,
9382512). This was the THIRD case-normalized-key-vs-real-cased-ref bug in this repo (after the
archive-restart guard and the dry run's instance overview): any new lookup into the usage cache
must go through `desktopKey()`/`usageForInstanceRef()`, never raw string indexing.

**A proposal is retired when its target is archived.** Open rows stand for up to 48 hours and a
chat can be retired inside that window; four approved revives once pointed at chats that had
since been archived. The detectors already refuse to propose for an archived chat, and every
tick now applies the same test to rows already on the books, marking them `expired` (nobody
ruled against them, the world moved).

**Every UNATTENDED terminal launch asks for `bypassPermissions`.** The auto-resume monitor's
visible window and the `terminal` handoff surface both open while nobody is watching, so a
per-command approval prompt there is a silent deadlock rather than a safeguard. Measured
2026-08-27: a session started without it loaded its instructions, issued one shell command and
froze for good.

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
| `orphaned` | the thread needs REVIVING: a dead pid (crash), a stranded mid-turn transcript (graceful restart), or a live-but-deaf plumbing process | informational twin of a `revive` PROPOSAL - the proposal is where the reviewer rules and acts (native delivery), the item just keeps the feed honest |
| `loop_break` | the circuit breaker tripped on a live loop: the same (kind, session) proposed past its cap, or the same item drawing the same ruling over and over | none - OWNER-facing by construction; the worklist builders return null for it, so it can never become a work item that re-enters the loop it reports |

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

### The self-test, and what it deliberately cannot tell you

`POST /api/orchestrator/selftest` runs the real guards against real state and reports each check
with the evidence behind it. It is safe against a live fleet by construction: sacrificial ids, a
throwaway metadata directory, and it never reads or writes a real chat. `{"deep": true}` adds the
one check that touches an app - it seeds a real chat, proves it is visible, then archives it.

It reports **`visualChecks: false`**, and that is the honest part. Everything it verifies is on
DISK. Whether the sidebar then SHOWS it is a different question, and the gap between the two is
where this feature's worst failures lived. The `screen-lag` check measures how much is currently
sitting behind that glass (metadata changed since its app started), which is as close as a
process outside the app can get. Confirming what is actually rendered needs the app's own view -
the reviewer's session tools, which is why the reviewer rubric requires it after every archive
and every import - or a screenshot.

It earned its place on its first live run by finding that archiving matched the metadata
FILENAME, so the archive endpoint quietly did nothing for 1,325 of 1,343 real chats.

### The two laws (owner orders 2026-08-26)

**The action gate.** Every action is checked by the orchestrator AI before it is made -
before a resume, before an archive, before a "you crashed, please resume". The daemon's
detectors (dead-pid orphans, stranded transcripts, deaf processes, monitor limit-resets, the
archive janitor, the visibility sweep) all write `orchestrator_proposals` rows instead of
acting; the reviewer rules on each with a recorded reason, executes the approved ones, and
reports the outcome. The ledger (served as `proposals` in the feed, open + last-day decided)
is the audit trail of everything the machinery wanted and what the AI said.

Its lifecycle runs on three windows, none of which need tending. An undecided proposal EXPIRES
after 48 hours and is simply re-proposed if the condition still holds, so a reviewer that was
offline for a day resumes to current asks rather than stale ones. A REJECTED one stays rejected
for 24 hours unless the detector can show evidence NEWER than the ruling - a transcript that
moved after the AI said no is a new situation, the same re-arm rule the acks use, and it is what
stops a rejected proposal reappearing every minute. Decided rows are pruned after 14 days.

**Surface purity.** Desktop stays desktop, CLI stays CLI, headless stays headless - a thread
is never continued on a surface it does not live on, and every one of the owner's threads is
a VISIBLE DESKTOP CHAT. This deleted the v0.35 auto-revive mechanism outright (it ran a
headless `--resume` and imported the result back - a desktop thread running headless) and
retired the queue-with-import-back pattern everywhere: handoffs and chips are now seeded as
real desktop chats and delivered natively.

**NO HEADLESS CHATS** (owner law, 2026-08-27: *"We should never have any headless chats. No
headless."*). Surface purity above is now the weaker half of this. It asked only whether a thread
already lived in a desktop app and let everything else through, which meant an orphaned CLI
thread, a migrate-on-limit resume or a scheduled run still became a conversation nobody could
watch. The property being banned is INVISIBLE, not cross-surface. `dispatchItem` refuses **every**
headless run now, at the one chokepoint all five call sites funnel through (route, run-due, retry
sweep, scheduler, monitor), and the per-row `allow_headless` override no longer buys a way past:
an override that defeats "never" is just the old behaviour behind a flag. A refused run fails with
a reason naming the law, so it is visible in the queue rather than silently dropped. The single
remaining switch is the `dispatch_allow_headless` setting, off unless deliberately set, and its
polarity is inverted from every other setting here on purpose: absence means the ban applies. The
`/usage` probe is untouched and is not covered, because it asks the CLI a question and reads a
number back rather than holding a conversation. See `server/src/headless-policy.ts`.

**The native actuator** (proven live 2026-08-26): the desktop app itself delivers messages
into its chats, and a delivery BOOTS a dormant chat's engine and runs the turn visibly in
the app - zero clicks, zero headless processes. A session hosted in an instance reaches that
instance's chats via `mcp__ccd_session_mgmt__send_message`; live chats anywhere are reachable
directly by peer message. **The RELAY rung - asking a live working chat in another instance to
run its own send_message as a courier - is BANNED (owner directive, Michael, 2026-08-28:
"remove the relay task functionality... don't just message other chats").** A working chat is
someone's thread of work, not the orchestrator's errand runner; `computeRoute` no longer
composes relay steps to working chats.

**The sanctioned courier** (same day, after the owner's follow-up that the removal "must not
cripple any functionality"): each instance gets ONE dedicated, system-owned **orchestrator
agent chat** - seeded through `seedDesktopSession` with the marker title `"Orchestrator agent -
do not use"` (`server/src/orch-agent.ts`), bypass-verified against the app-boot re-save race
before its first boot. Its only job is performing delivery steps the server composes:
`send_message` into its own instance's dormant chats, then report. `computeRoute` gained the
rung: target dormant in another instance AND that instance has a live agent chat -> compose the
courier step addressed to the AGENT chat, admitted by TITLE MARKER and nothing else (a
heuristic would readmit working chats, i.e. the banned relay under a new name). The courier is
excluded from the monitor's idle/nudge/handoff detection and from concurrency slots, never
counts as a repo occupant, and the janitor refuses to retire it while its instance still has
chats. Deliveries through it verify the same way as every delivery: the TARGET's transcript
must move. Instances without one surface as `seed-agent` proposals (the normal action gate) and
as an always-printed `agent chat:` line in the dry run. When no courier is live and no reviewer
is inside, the action still WAITS visibly instead of falling back to anything headless or
borrowing a working chat.

### Codex threads, in the same feed

AgentHydra manages both agents this machine runs, and the orchestrator watched exactly one of
them - so a Codex thread that stopped mid-work was invisible to the machinery that babysits
every Claude chat. Codex rollouts (`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`) are now
scanned on the same tick and classified from their own event stream: `task_complete` finished,
`turn_aborted` with `reason: "interrupted"` is a human stop, anything else newest is mid-turn.
The `session_meta` first record gives the cwd, so their repos join the same git hygiene pass.

**Observe-only, and every item says so.** Codex exposes no live-process registry and no message
channel, so there is no rung of the delivery ladder that reaches it. Items carry
`source: 'codex'` and `deliverable: false` for exactly that reason: a reviewer that believed it
could nudge one would be talking into a void, which is the deaf-chat failure in a new costume.
The owner picks these up; the orchestrator only makes sure they are not invisible. Switched by
`watchCodex`.

**Observe-only is a DECISION, not an unfinished feature** (re-examined 2026-08-27, after
"could `codex resume` in a visible terminal make these actionable?"). It could not, and the
repo had already ruled on it twice: `session-resume.ts` refuses non-Claude sources outright,
with the stated reason that Codex has its own resume syntax and inventing one here would
produce a command that looks authoritative and does not work. Two things would have to exist
first, and neither does. A rollout carries no record of WHICH frontend wrote it, and Codex
Desktop and the Codex CLI share one `CODEX_HOME`, so "resume it on the surface it lives on"
is not a question the data can answer. And there is no live-writer guard for Codex at all,
so a resume could double-write a transcript the Desktop app already holds open, which is the
two-writers hazard the Claude path has an explicit refusal for. Do not treat this as a gap.

### Retiring a thread: the closeout, then the archive ladder

**THE CLOSEOUT** (owner rule 2026-08-26). A thread being retired because it is DONE is the last
place its own knowledge exists, so it gets one final turn first: `prompts.closeoutDocs` asks it
to bring the repo's markdown current - what it did, what is verified versus attempted, what is
outstanding, and the gotchas a future session would otherwise rediscover. It is explicitly
allowed to answer "nothing here is still worth keeping", and a 30-day-dormant thread did exactly
that rather than inventing content. A MIGRATED thread is NOT asked: it is continuing, not ending.

**THE ARCHIVE LADDER.** The rungs are not interchangeable - the difference between them is
whether the chat actually leaves the sidebar:

1. **In the reviewer's own instance** -> the app's own archive tool. Instant and genuinely gone
   (measured again 2026-08-27: the flag was written AND it stuck, where the same archive done
   through the HTTP endpoint was silently reverted by the running app minutes later).
   **It asks its user to confirm, though, and that is load-bearing.** It went through without
   a prompt only because that reviewer ran in BYPASS; from a normal-permissions session this
   rung raises a dialog, which under the zero-click law is a dead end. Same shape as the relay
   rung below, and the same warning: a ladder validated only from a bypass session looks
   universal and is not.
2. ~~Elsewhere, with any live chat in that instance -> relay~~ **REMOVED (owner ban,
   2026-08-28): the orchestrator never borrows a working chat as a courier, for archives or
   for anything else.** The history below is kept because it measured WHY this rung was
   already broken before it was banned.
3. **Elsewhere** -> `POST /api/sessions/:id/desktop-archive`, which writes the flag and
   returns `visibleNow: false`: the chat is still on screen until that app restarts.

**RUNG 3 IS VERIFIED; THE ARCHIVE LADDER'S RUNG 2 IS NOT, AND CANNOT BE** (measured
2026-08-27, the first time a live chat existed outside the reviewer's own instance). Relaying a
MESSAGE works exactly as documented: a live chat in `another_meh` was peer-messaged, called its
own `send_message` against a dormant target in its instance, and the target's transcript grew
and its engine booted and answered. First try, no error.

Relaying an ARCHIVE does not, and the reason is structural rather than a bug to fix. Sending a
message needs no approval; `archive_session` ALWAYS prompts its user by design. So the honest
shape of that rung is agent -> HUMAN -> agent: the relaying chat's own user is the one who
consents, and the requesting orchestrator cannot delegate that consent. What the orchestrator
can do is ASK a chat elsewhere to put the request to its user. A rubric that scores rung 2 as
"the orchestrator archived a chat elsewhere" is over-claiming.

The part that would have shipped a false rung: the relaying chat correctly refused, and it
refused because it runs on NORMAL permissions. A reviewer running in bypass would have made
the same call with no prompt at all and concluded the rung was fine. Validate a delivery rung
from a non-bypass session or you are only testing the one caller for whom every gate is open.

**A chat will not archive ITSELF on a peer's instruction, and should not.** Tried: a session
treats "a peer told me to shut down, do nothing else first" as exactly the shape it must stop on,
and flags it instead. It is right to, and a fleet trained to obey that would be worse than the
inconvenience. Note the structural consequence: the instance hosting the reviewer never reaches
zero live sessions (the reviewer is itself one), so rung 3 there is invisible indefinitely rather
than merely delayed - which is why rung 1 is mandatory, not preferred.

### The zero-click law

Owner order (2026-08-26): clicking is impossible for him, always - he operates over Remote
Desktop while traveling. Nothing in AgentHydra may wait on the owner clicking, activating,
or starting anything: no activation clicks on imported chats, no chips left as buttons, no
"click once to begin" handovers. The native delivery ladder is the universal actuator: work
gets STARTED by the machinery and streams visibly in the app. Only true blockers
(credentials, spending, publishing, deleting real data) are surfaced to him, as plain
status lines.

### The visibility sweep (no invisible chats)

Every ~10 minutes: any completed queue run from the last 48h whose session has NO desktop
entry anywhere (a chat the machinery started that the owner cannot see) is PROPOSED for
import into its owning running instance's app; on approval the reviewer imports it, and the
deaf detector proposes a revive if it has pending work. Queue runs that were in flight when
the daemon died are a separate, older recovery (`reattachRuns` at boot: replay the on-disk
log, resume tailing or finalize).

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
tools. Open a chat on a **low-usage account**, model **Sonnet**, and start the loop. It must
be able to run shell unattended (see "Turning it on": a SEEDED chat cannot, and stops dead on
its first `curl`). A plain
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

### The worklist engine (ground-up reorganization, 2026-08-28)

The reviewer no longer consumes the raw feed against a prose rubric. The owner's ruling that
forced the change: too much was left to AI interpretation - the reviewer composed every message,
picked delivery routes by hand, was trusted to remember orderings (closeout-before-archive,
rename-after-boot), did its own bookkeeping (acks, placements), and then SELF-REPORTED that it
had done all of it, which the server never verified. Every one of those drifted in practice.

`server/src/orchestrator-worklist.ts` moves all of it into code. Three endpoints:

```
GET  /api/orchestrator/worklist?reviewer=<sessionId>   typed WorkItems - one judgment question each
POST /api/orchestrator/items/:id/resolve               {reviewer, decision, note, messageOverride?}
POST /api/orchestrator/items/:id/verify                server re-checks the world, then closes the ledger
```

What the server now owns, enforced rather than described:

- **Composition.** Every message is written server-side from the prompt templates: the
  `[orchestrator]` prefix, the file-tools-only line whenever the target's recorded permission
  mode prompts, the collision warning when a second chat shares the repo, the ultracode prefix
  on new-chat openings. `messageOverride` narrows scope; it cannot strip the prefix.
- **Routing.** The old four-rung prose ladder is `computeRoute()`: live target -> direct peer
  send by registry NAME; dormant in the reviewer's instance -> `send_message` with the REAL
  `chatId` from metadata (never constructed); dormant elsewhere with a LIVE agent chat there ->
  the courier step, addressed to that instance's marker-titled orchestrator agent chat and
  nothing else; otherwise honestly `unreachable` (the relay rung was REMOVED 2026-08-28 by
  owner ban - working chats are never couriers; the agent chat is the sanctioned replacement).
  The two measured routing failures (the 0-of-4 constructed-id relay round; rung 1 booting
  another instance's chat on the wrong account) are structurally impossible for the reviewer
  to repeat, and are pinned by tests - as is the ban itself.
- **Ordering.** Closeout-before-archive is a state machine: approving an archive delivers the
  closeout, and the flag flips only after `verify` sees the transcript move. Unreachable chats
  archive immediately and are RECORDED as un-closed-out. The anchor rule refuses to retire the
  last awake chat of an instance that still has work aimed at it.
- **Bookkeeping.** No-action attention kinds (human-active, interrupted, mid-turn, see-proposal
  twins, non-cutoff usage alerts, the reviewer's own session) are auto-acked during the build and
  never reach the reviewer. Placements are recorded on verified deliveries. Commit nudges are
  suppressed in code while the repo has two live chats.
- **Verification.** "Executed" stopped being a self-report. The ledger closes when the SERVER
  observes the outcome: the target's transcript gained an event after the step was handed out, the
  archive flag is set, the app's metadata carries the title. A reviewer's DONE is a claim; the
  transcript moving is evidence.
- **Surface purity** (owner law: desktop stays desktop, console stays console). Enforced at both
  actuation points: monitor resume dispatch routes by where the thread LIVES, not by the global
  `handoffSurface` preference, and `migrate` refuses to convert a desktop thread into a terminal.

What remains with the reviewer, by physical necessity: judgment (approve/reject + the note that
is the audit trail), and at most one exact tool call per item - only a session inside a desktop
app can boot that app's dormant chats, and only a live session can receive a peer message. Those
steps arrive fully composed and are performed verbatim.

The legacy loop below (raw feed + decide/executed + hand acks) still works and the endpoints
remain for compatibility, but the worklist is the contract the shipped command file teaches.

What the loop does, per wake:

1. `GET /api/orchestrator` (one call). Decide every open PROPOSAL first (approve/reject with
   a reason, execute approved ones, report the outcome), then judge each attention item by
   the rubric in the command file, act, `ack`.
2. Delivery is NATIVE (the delivery ladder): own-instance chats via the app's
   send_message tool (works on dormant chats - it boots the engine), live chats elsewhere
   via peer `SendMessage`, dormant chats elsewhere via that instance's live ORCHESTRATOR
   AGENT CHAT (the marker-titled courier - the relay through working chats was banned by
   the owner on 2026-08-28, and instances without a courier wait honestly). New work
   (chips, handoff continuations) is seeded as a visible desktop chat
   (`POST /api/sessions/seed-desktop`) and delivered the same way - nothing of the owner's
   ever runs headless.
3. Pacing: it does not poll at a fixed 60s. `notify_when_idle` gives push notifications the
   moment a peer finishes its turn - *faster* than polling - and a long heartbeat covers
   usage/git/chips. Idle cost is a few small requests per hour.

Hard rails written into the command file: never enable or use remote control (everything
stays on this machine); never work in a worktree or branch; a real human message in a chat
pauses orchestration of that chat; never answer a session's question by picking a
destructive or regressive option - skip and surface instead; never push a public repo
without the PUBLIC warning protocol.

### The circuit breaker (loop detection, 2026-08-28)

Measured the night the worklist shipped: the same finished chat was re-archived FOUR times
(each archive executed and verified honestly; the running app then re-saved its sidebar entry
un-archived, the janitor saw a done-marked visible chat again, and the cycle restarted), and
the same idle item was re-proposed and re-rejected THREE times in ~40 minutes. Every pass was
individually correct; nothing anywhere COUNTED. `server/src/orchestrator-breaker.ts` is the
counter (pattern sources: systemd's StartLimitIntervalSec/Burst restart-storm brake,
claude_code_agent_farm's exponential backoff, CrewAI's max_iterations, Cloudzy's
hash-the-repeated-action sliding window). State lives in `orchestrator_kv` (`breaker:` prefix),
so counts survive daemon restarts - an in-memory counter would reset on exactly the restart a
storm tends to cause. Three brakes:

1. **Attempt counters at proposal creation.** `proposeAction` counts every NEW row per
   (kind, sessionId) - refreshing an open row is not a new ask. Past 4 inserts inside a 6-hour
   sliding window, the next ask is refused and becomes ONE owner-facing `loop_break` attention
   item stating the loop and its history ("proposed 5× in 6h ... the app keeps resurrecting the
   entry; it sticks only after that app restarts"). Suppressed asks keep the window sliding, so
   a persistent loop stays suppressed under a single live escalation; a full quiet window
   (the condition cleared - typically that app restarting) re-arms the pair.
2. **Exponential backoff on revive deliveries, keyed per target session.** Each unverified
   delivery doubles the wait before the next one (2min base, 30min cap - agent_farm's
   10s→5min shape, scaled to chat revives); a VERIFIED delivery (transcript moved) resets the
   ladder. A revive resolved inside its backoff parks as "approved but parked" - the ruling
   stands, execution waits for the clock, and the pending wait is visible in the item's
   constraints before the reviewer ever rules.
3. **The repeat-hash on rulings.** Every resolve is counted per (itemId, decision). The same
   item drawing the same ruling 3 times inside the window is folded into the owner escalation
   and withheld from later worklists instead of being offered a fourth time.

The law the breaker lives under: it suppresses PROPOSING and paces DELIVERY; it never overrides
a ruling - an open row still gets decided, an approved one still executes, a reject still lands.
And every stop is LOUD: the escalation item in the attention feed, plus a suppression line in
both the worklist (`suppressed[]`) and the dry run (`wouldSuppress`), read straight from kv so
they are current even between ticks. A silent brake would be the false quiet this document
warns about everywhere else.

## Turning it on

1. Daemon side: `POST /api/orchestrator {"enabled": true}` (or the `set_orchestrator` MCP
   tool). Defaults are sane; tune later.
2. Reviewer side: open a fresh chat on a quiet account and type `/orchestrate`.

## Seeing before doing: the dry run and the dossier (added 2026-08-28)

Two read-only views exist because the owner asked to SEE the plan before anything runs, and
because diagnosing "what happened to chat X" once took an hour of hand-joins:

- **`GET /api/orchestrator/dryrun`** (`?format=text` for the rendered layout; MCP
  `orchestrator_dryrun`; `/orc-dryrun` from any chat) - what the orchestrator WOULD do with
  every chat and every open window: the same item builders as the live worklist, computed with
  ZERO writes - no acks, no cooldowns, and deliberately no reviewer stamp (a probe that
  stamped `lastReviewerAt` once masked a dead reviewer loop for an hour). Safe to run any
  time, any number of times. The header states whether a reviewer has polled recently - the
  loop being silently dead is the failure this view makes visible.
- **`GET /api/chats/dossier?q=<title fragment or any id>`** (MCP `chat_dossier`) - everything
  known about one chat in one query: which instance holds it, its archive flag as it sits on
  disk right now, its lineage ids across auto-compact rolls, its done-mark, the live process
  hosting it, and every ledger row that ever touched it. The archive flag is read fresh off
  disk on purpose: the running app's memory and the disk can disagree in both directions, and
  the disagreement is usually the answer being looked for.

**A REVIEWER CANNOT BE SEEDED, and this was learned the hard way (2026-08-27).** The obvious
move, seeding a desktop chat and delivering `/orchestrate` natively, produces a reviewer that
boots, loads the rubric, issues its first `curl` and STOPS: seeded chats are imports, imports
land on a mode that prompts for shell, and the whole rubric is shell. Watched live: the
transcript froze at two tool calls with no results, and the app showed "Allow Claude to run
the command... This command requires approval". The reviewer is the one component that cannot
tolerate that, because it is the half that acts.

So a reviewer must be either:

- **a chat the APP creates** (censused at 100% unattended, so it just works), or
- **a terminal launch that asks for the mode**:
  `POST /api/sessions/launch-terminal {"cwd", "prompt": "/orchestrate", "instance_ref",
  "model": "sonnet", "permission_mode": "bypassPermissions"}`. Without `permission_mode`
  the window opens and stops on the first shell approval, exactly like the seeded one.

**And the launch had a second gate, which IS now solved.** The CLI asks whether the folder is
one you trust and blocks on a keypress, while the endpoint has already returned `ok: true` - a
hang that reports success, which is worse than a refusal. The owner's rule is the reason this
had to be closed rather than documented: a keypress he must supply today is one he must supply
forever.

**The mechanism, and it is a slash.** Trust is recorded per project path as a LITERAL KEY in
the CLI config. Read the whole config at once and the pattern is unmistakable: every
FORWARD-slash key is `false` and every BACKSLASH key is `true`. The CLI resolves cwd to forward
slashes and reads trust under THAT key; something else, the app or an older CLI, wrote the
backslash form. So a folder trusted long ago is asked about again every single time, and 61 of
this machine's 114 projects read as untrusted for exactly that reason.

`ensureProjectTrusted` mirrors an existing YES onto **both** spellings before launching. The
first cut of it wrote only the keys that already existed, which for a backslash-only folder
means it wrote nothing that mattered and the dialog kept appearing; that near-miss is pinned by
a test named for it. Proven end to end: a launch that had hung three times registered in seven
seconds once the forward-slash key carried the same YES, and the reviewer then ran its loop
with shell commands returning results.

It still REFUSES, loudly and with a reason, when the folder is not trusted in any spelling. It
will not answer the security question on the owner's behalf: copying a decision he already made
onto a second spelling of the same folder is normalization, inventing one is not.

**So a reviewer now starts with no human action at all**: one call to `launch-terminal` with
`permission_mode: "bypassPermissions"`, into any folder the owner has ever trusted.

Turning it off is the reverse in either order; each half degrades safely without the other
(the feed just accumulates; the reviewer just finds an empty feed).

**But losing the reviewer by ACCIDENT used to be invisible, and that is the failure this whole
feature keeps having.** The watcher cannot detect its own uselessness: it keeps ticking, keeps
writing proposals, and the feed keeps looking healthy whether or not anything is reading it.
This document's own maintenance session opened with the owner discovering 19 proposals queued
and nobody deciding them, and it recurred the same night - a reviewer worked one full shift,
its window went away, and everything still looked fine for five hours. The half that reports
is the half that cannot fail, so the other half failing reads as calm.

So `meta.reviewer` answers it directly: `lastSeenAt`, `quietMins`, `stalled`, and `why` in
words. Liveness is measured by WORK DONE - every ruling, execution report and ack stamps it -
and never by a process existing, because the failure most worth catching is a reviewer that
booted and then froze at an approval prompt, which is alive and useless. `stalled` fires only
when there is a BACKLOG: a reviewer with an empty queue is quiet because there is nothing to
do, and a signal that cries wolf on healthy input stops being read.

**And when it fires, the fix is a SUCCESSOR, never a resurrection.** The reviewer is a ROLE,
not a chat (survey tier 1, 2026-08-28; measured twice that day: a phantom archive and a
process kill each took the reviewer's host chat down and the fleet halted until a human typed
`/orchestrate`). Everything a dead reviewer "knew" already lives in the server - the rulings
with their notes in the proposals ledger, mid-delivery items with their exact verbatim steps in
the `wl:` kv state, the standing mode in settings - so `GET /api/orchestrator/reviewer-journal`
serves it as a compact view, and `GET /api/orchestrator/reviewer-seed` composes it into a
ready-to-paste opening prompt that briefs ANY fresh chat as the replacement. While `stalled`,
`meta.reviewer.fix` names that endpoint. The seed is delivered by whoever boots the new chat
(never relayed through working chats), the booter verifies the hosting chat's
`bypassPermissions` stamp first, and the journal records without ever deciding - the action
gate is untouched.

## Settings (all `POST /api/orchestrator`)

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | master switch for the watcher |
| `tickSecs` | 60 | pass interval (30–600) |
| `idleQuietSecs` | 150 | quiet time before a live chat counts as pending. A chat with a TOOL IN FLIGHT gets four of these (floor 10 min) before it counts, because quiet time measures the transcript and a gate that prints nothing looks exactly like a chat waiting for input |
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
| `handoffSurface` | `desktop` | where handoff continuations land: `desktop` (seeded as a visible desktop chat, prompt delivered natively) or `terminal` (watchable live window). `queue` is still accepted and now behaves as `terminal`: since the no-headless law it can no longer mean an invisible run, so it resolves to the nearest thing you can actually watch rather than to a refusal. A `desktop` preference over a thread with no `desktop:` instance ref also takes the terminal, because it cannot be delivered natively; that case used to fall through to headless. The decision is `resumeSurfaceFor()` in monitor.ts, whose return type has no invisible member |
| `newChatModel` | `opus` | model for every orchestrator-started chat (handoffs, chips, launches) |
| `newChatEffort` | `max` | reasoning effort for those chats (`low`/`medium`/`high`/`xhigh`/`max`) |
| `newChatUltracode` | `true` | prepend the `ultracode` opt-in keyword to every orchestrator-started chat's prompt. Unlike its two siblings there is no CLI flag for this and no settings key, so the only way to ask for it is the literal word in the prompt text: the daemon applies it in `launchTerminalSession` (never on a `--resume`), and serves it to the reviewer as the feed's `newChatPrefix` for the native deliveries no server code can reach. See `server/src/new-chat-opening.ts` |
| `migrateOnLimit` | `false` | 5-hour-limited runs (weekly fine) resume immediately on another running account instead of waiting for the reset; needs the auto-resume monitor on |
| `loadBalance` | `true` | spread work across the open accounts instead of stacking one. Adds the 5-HOUR reset exemption (a window about to wipe is capacity) and orders equally-loaded accounts by which was given work least recently. Only ever breaks ties: having headroom always outranks fairness. Off restores the previous ranking exactly |
| `balanceWindowMins` | 90 | how long a placement keeps counting against an account. Must outlast the usage cache's refresh, which is the blind spot the ledger covers |
| `watchCodex` | `true` | watch Codex threads too, so one feed covers both agents this machine runs. Observe-only: Codex has no live-process registry and no message channel, so those items are marked `deliverable: false` rather than inviting a nudge that would go nowhere |
| `maxActiveChats` | 0 (unlimited) | caps how many chats may actively WORK at once, fleet-wide. Past the cap the watcher marks overflow idle chats `waitingForSlot` and the reviewer skips them without acking; the rotation is round-robin by construction: longest-idle gets the next free slot, a nudged chat re-enters at the back. Only resume nudges and new work are gated; answers, handoff continuations (replacements), and orphan revives never wait |
| `workMode` | `react` | `react` watches only the chats that exist; `full` also sweeps the repositories for outstanding work (see Full mode, below). Persisted server-side because the reviewer reschedules itself with the bare literal `/orchestrate`, so an argument would not survive its next wake |
| `backlogRoots` | `''` | where full mode looks, one path per line. A path that is itself a repo is swept as-is; one that is not expands ONE level to the repos directly inside it. Empty means "the repos this machine has actually worked in", derived from the session index |
| `backlogScanMins` | 30 | minutes between sweeps (5–1440). Turning full mode on always sweeps immediately rather than waiting for the first interval |
| `backlogMaxOpen` | 3 | ceiling on `work` proposals open at once (1–20). The backlog is always discovered in full and ranked; this caps how much is offered at a time so a first sweep of a large fleet cannot bury the feed the fleet's own chats depend on |
| `backlogIncludeTodoMarkers` | `false` | report bare `TODO:` comments as markers too. Off because FIXME/HACK/XXX/BUG are the author saying something is wrong, while TODO is usually a note |

## Full mode: work nobody has started

Everything above is REACTIVE. The watcher asks questions about chats that already exist (is this
one dead, has that one finished, is anyone reviewing) and it is entirely blind to the other
question: **is there work outstanding that nobody is doing right now?** A fleet whose every chat is
healthy therefore reads as a fleet with nothing left to do, while the repositories themselves carry
unticked task boxes, FIXMEs added last week, and gates that have not been run since the code
changed.

`/orchestrate full` (or the toggle in Settings, or `POST /api/orchestrator {"workMode":"full"}`)
adds that question. `/orchestrate off` takes it away again. The word is stored on the server, not
in the reviewer's chat, because the reviewer reschedules itself with the bare literal
`/orchestrate` and an argument would be gone by its next wake.

**The split is the same one the rest of this feature lives by.** `server/src/backlog.ts` DISCOVERS,
read-only. The reviewer DECIDES and starts a visible chat. Nothing new acts on its own, and full
mode changes what is FOUND, never who rules on it.

### What it looks for

| detector | severity | what it is |
|---|---|---|
| `gate` | `breaking` | the repo declares a quality gate (package.json `check`/`typecheck`/`lint`/`test`, `.arkitect`, `Cargo.toml`, `.github/workflows`) and HEAD has not been recorded green since the code moved. The item carries the ordered command list a work chat should run |
| `marker` | `warning` | `FIXME` / `HACK` / `BUG` / `XXX` comments in tracked source that were NOT there at the previous sweep (`TODO:` too, opt-in) |
| `todo` | `chore` | unticked `- [ ]` boxes in that repo's task files (`TODO.md`, `PROGRESS.md`, `ROADMAP.md`, `PLAN.md`, `BURNDOWN*.md`, `docs/todo/*.md`, …). ONE item per repo, never one per box |

**It never runs the repository's own scripts.** Not `bun run check`, not `cargo clippy`, not
`localci`. A daemon that executes arbitrary repo scripts on a timer reinstalls dependencies under
a chat that is mid-edit, burns a core forever on a sixty-repo fleet, and runs whatever a freshly
pulled `package.json` happens to say. Running a gate is real work with real judgment attached, so
it belongs to the seeded chat, which is visible, supervised, and can tell a genuine failure from
a missing local secret. All the sweep does is notice that a gate exists and that HEAD has moved.

**Nothing old is ever "new".** The obvious way to kill the marker detector would be to report every
`HACK:` in a mature codebase every thirty minutes. So markers are BASELINED per repository on first
sight (the first sweep records what is already there and says nothing) and only ever reported
afterwards, keyed by (file, token, text-hash) rather than by line, so moving code does not fake a
new one.

**Secret hygiene.** `.env*`, `*secret*`, `*credential*`, `*token*`, `*.pem`, `*.key` and friends are
excluded at the git-pathspec level, so they are never opened. What does come back is redacted of
anything value-shaped (`token = …`, long opaque strings) before it reaches the feed.

### The rails on the work itself

The generated chat is a chat like any other, visible, on an account with headroom, running the
owner's own model settings, and `prompts.workStart` fences it: one item, path-scoped commits only,
no dependency installs or clean/reset commands (they destroy a neighbour's work), no public-repo
push, nothing irreversible, and an explicit licence to answer "this is not worth doing" and stop.

Four more limits, all enforced in code rather than left to the reviewer to remember:

- **Never a repo someone is standing in.** Repos with a live chat are skipped at scan time and
  flagged `busy` in the feed if one arrives afterwards.
- **`backlogMaxOpen` in flight**, fleet-wide. The whole backlog is still discovered and ranked;
  only the offer is capped.
- **A settling period.** A `gate` item waits until HEAD has been still for 30 minutes. A commit
  from a minute ago belongs to whoever is still typing.
- **A retry budget.** An item reported failed three times stops being offered and becomes a line
  for the owner. An item nothing can fix (a flaky test, a missing local credential) would
  otherwise be re-proposed forever, which looks like diligence and is a loop.

There is deliberately **no expiry on the mode itself**. It stays on until it is turned off, because
every individual item still passes the action gate, lands in a visible chat, and is capped, and a
mode that silently stopped working after a while would be worse than one that is simply on.

### What it deliberately does not do

**No "you have unpushed commits" detector.** Deliberately unpushed work is ordinary (not scrubbed
yet, not ready, held back on purpose) and nothing mechanical can tell that from forgotten. It is
also the one detector that would brush against the public-repo push rule, which is a readiness
judgment that must not be made on a timer.

**No integration with the owner's own fleet tools.** `localci`, `odin` and friends live on one
person's machine; AgentHydra ships to anyone. The sweep reads only what a repository itself
declares. The work CHAT is welcome to use those tools; that is what the `gate` item's command
list is for.

### Prompts (editable, defaults shipped)

Every message the machinery sends into a chat is a named template: `resumeNudge`,
`handoffRequest`, `staleTaskNudge`, `hardCutoff`, `overloadNudge`, `commitNudge`,
`branchNudge`, `orphanRevive`, `closeoutDocs`, `workStart`, `migrationNotice`. The shipped texts are the defaults; the
owner edits any of them under Settings -> Automation -> Orchestrator -> Prompts (or
`POST /api/orchestrator {"prompts": {...}}`), and a blank edit (or saving the default text
verbatim) restores the default so future shipped improvements still land. `GET
/api/orchestrator` serves the resolved set as `prompts` plus `promptDefaults`; the reviewer
always sends `prompts.<name>` from the feed, and the daemon uses `migrationNotice` itself for
migrate flows. Placeholders in `<angle brackets>` are substituted at send time.

### Collision awareness (who is already in that repo)

Placement answers "which ACCOUNT has room" and nothing else. It has never known whether anyone is
already WORKING where the new thread is about to land, which is how two chats came to edit one
repository and overwrite each other, reported by the owner's own chats: *work was overridden by
other chats* (2026-08-25).

The feed's `collisions` array closes the gap cheaply. Each entry is a repository root plus every
LIVE chat currently inside it (`sessionId`, peer `name`, `cwd`, owning `instance`). A linked
worktree is folded onto its parent repo, since `repo` and `repo/.claude/worktrees/x` are one
history reached by two paths, and a group of one is never reported: an empty array is the normal
case, and a watcher that cried collision over every solo chat would be ignored exactly when it was
right.

It is repository-level on purpose. Same repo means two chats CAN clobber, which is all the reviewer
needs to route around it; a file-level dependency graph would be more precise, would go stale
between ticks, and would not change the decision being made. Cost is one cached directory walk per
live chat per tick.

The reviewer is required to use it when placing work, when sending commit or branch nudges (never
into a repo that appears here - "commit your files" to a tree someone else is mid-edit in is an
instruction to sweep up unfinished work), and when reviving a thread whose repo is contested. See
[orchestrate-command.md](orchestrate-command.md).

### Load balancing (5-hour windows)

The `instances` routing table arrives pre-sorted for placement: running first, then weekly
band (reset-soon counts as healthy, the dump-target exemption), then LOWEST 5-hour session
%, then lowest weekly %. With several accounts open, consecutive placements spread across the
top rows instead of stacking one account's 5-hour window (owner rule 2026-08-25).

**That last sentence was a request, not a mechanism, and for a year nothing could carry it
out.** The sort is a pure function of the usage cache and that cache refreshes about once a
minute, so every placement decided inside one refresh window saw byte-identical readings and
therefore chose the identical top row. Round-robin is not something a stateless sort can do:
nothing in the system remembered that it had just placed work somewhere. Land four handoffs in
one wake and all four went to one account, which is exactly the stacking the rule forbids.

`loadBalance` (ON by default, owner instruction 2026-08-27) closes it with three changes:

- **A placement is written down.** `orchestrator_placements` records every placement at the
  PRIMITIVE that makes it (seed a desktop chat, launch a terminal, migrate a chat), not at the
  callers, so a placement counts whether the monitor made it, the reviewer made it, or the
  owner made it by clicking Migrate in the app. A ledger only the polite callers wrote to
  would be balancing against a fiction. `POST /api/orchestrator/placement` records the one
  case the primitives cannot see: the reviewer delivering a turn NATIVELY into a chat that
  already exists, which is real load and, since the zero-click law, the common path.
- **The 5-hour window is read the way the weekly one always was.** `sessionResetsAt` and
  `sessionResetsSoon` are now on every row. An account whose 5-hour window resets within
  `resetSoonMins` ranks as a dump target, because whatever it reads now is about to be wiped.
  The row still reports the TRUE `sessionPct`: the exemption changes ranking, never the
  measurement, so the feed can never restate a number it did not take.
- **The ledger breaks ties, and ONLY ties.** Load is bucketed into coarse 20-point tiers and
  the ledger reorders inside a tier and nowhere else. An account at 12% and one at 25% are not
  peers, so the colder one wins outright however recently it was used; 12% and 19% are peers,
  and there the one that has not just been handed work goes first. The narrowness is the whole
  safety argument: if spreading work could outrank having headroom, a balancer would cheerfully
  feed an account toward its own wall in the name of fairness. There is a test named for this
  that fails if it ever stops being true.

Turning `loadBalance` off restores the previous ranking exactly, reset exemption included.

**One decision, one place.** `pickPlacement()` is now the only definition of "an account that
may take work": running, fresh reading, weekly not critical, 5-hour under the high band. The
auto-resume monitor's migration target used to carry its own inline copy of that filter while
the reviewer carried a prose description of it in its rubric, which is one policy living in
three places and free to drift in all of them. Both now call it. The feed serves the result as
`placement`: the recommendation, the reason in words, the eligible refs, every blocked account
with WHY it was passed over, and the recent ledger, so a placement can be argued with instead
of merely trusted.

### Removing it

`POST /api/orchestrator/uninstall-command` (Settings: "Remove & disable", or the
`orchestrator_uninstall_command` MCP tool) turns the watcher off and deletes the three
shipped command files from `~/.claude/commands`, edited copies included. Reinstalling is one
enable (or the install endpoint) away.

## Where new sessions show up (and where they cannot)

- A **desktop import** (`POST /api/sessions/:id/import-desktop`) lands a FINISHED session as
  a real chat in the target instance's desktop app - the app's own `claude://resume` one-way
  import, aimed at one instance via its profile dir. Verified live: the chat appears in the
  sidebar, fully rendered, on the right account. One hard rule: never import a session that
  is still running (the import rewrites the transcript under an active writer). An imported
  chat is dormant; PEER messages queue into its passive process forever (never SendMessage
  one), but the app's own send_message channel boots it and runs the turn visibly - that is
  the steering channel (proven 2026-08-26).
- A **terminal launch** appears as a real window on your screen, joins the live registry, and
  is orchestratable while it works - the surface for watching a continuation live.
- A **queue run** is headless: it exists only in AgentHydra's Sessions/Queue tabs (live-tail
  there). It never appears in the desktop app and the orchestrator cannot nudge it mid-run.
- **A title written from outside a RUNNING app does not stick.** The import writes the chat's
  real name into its metadata file and that is genuinely correct on disk, but the running app
  holds the chat in memory and re-saves the file when the chat next boots, dropping the name;
  the sidebar then shows "General coding session". Measured 2026-08-26: five chats imported
  with correct titles, all five wiped seconds after they were first messaged. The import now
  reports `titleDurable: false` in that case, the reviewer renames through the app's own
  rename tool (which the app cannot overwrite), and the title janitor remains the slow
  fallback for instances that are closed or later restart. Same shape as the archive caveat
  below, and the same cause: while an app is running, its metadata files are its own.

  **The janitor now says WHICH chats it renamed into a running app**, instead of only how
  many, and those are served in the feed as `renames` for the reviewer to rename natively.
  Restarting the owner's app to make a NAME appear is a heavy way to do something the app
  does instantly on request; the restart stays as the fallback, so a fleet with no reviewer
  running is no worse off than before. The list is PERSISTED rather than recomputed each
  pass, and that detail is load-bearing: the sweep only reports what it CHANGED, so once the
  title is on disk the next sweep correctly skips that chat and a recomputed list would
  empty itself within one cycle, with the reviewer never seeing the work. An entry leaves
  when the reviewer reports it done (`POST /api/orchestrator/renamed`), when the owning
  instance stops running (its app will read the disk title at its next start), or after a
  week.
- **Desktop archiving works, with one honest caveat, and the caveat is not hypothetical.** The
  desktop keeps a per-chat metadata flag, and `POST /api/sessions/:id/desktop-archive` flips it
  in every profile that carries the chat. For an instance whose app is RUNNING, the sidebar
  reflects it only after that app next restarts; for closed instances it is reliable.
  Handed-off chats get AgentHydra's done-mark as the immediate signal plus the archive flag for
  the desktop's next start.

  This used to read "the running app ... may even re-save the old state". OBSERVED 2026-08-27:
  a chat archived through this endpoint returned `ok: true`, and minutes later its metadata read
  `isArchived: false` again. The running app had re-asserted its own copy. So the endpoint's
  honest promise for a running instance is weaker than "archived, pending a restart": the flag
  can simply be erased before that restart ever happens, and the response cannot tell you which
  it will be.

  That completes a pattern worth naming, because all three were found separately and are one
  behaviour: **while an app is running, its metadata files are its own, and it re-asserts them
  on every boot.** Titles, permission modes and archive flags are all written successfully and
  all three can be silently reverted. Anything that must STICK in a running instance has to go
  through the app's own tools, which is why rung 1 of both ladders is mandatory rather than
  merely preferred, and why a disk write is a fallback for CLOSED instances rather than the
  primary mechanism anywhere.

## Limitations, stated out loud

- The reviewer must be an interactive session; a scheduled task or headless run cannot carry
  the loop (no peer tools there - measured, not guessed).
- **Full mode's "never a repo someone is in" rule is enforced everywhere except the very last
  step.** The sweep skips busy repos, the offer re-checks at proposal time, and the feed marks
  every item `busy` from a live reading. But the act that actually starts the chat is
  `POST /api/sessions/seed-desktop`, which is shared with handoffs and chips and does not take a
  view on collisions - a handoff continuation deliberately lands in the repo it came from, so a
  blanket refusal there would be wrong. That leaves a window of seconds between the reviewer
  reading the feed and seeding, and closing it is the rubric's job rather than the code's. It is
  the one place in this feature where the guarantee is prose.
- Headless continuation of a DESKTOP chat is not merely avoided, it is refused in code
  (dispatch.ts, at the one chokepoint every run passes through). The transcript would advance
  under a renderer that may not show it, and the owner's report was blunter than that: those
  threads became "a headless thing I couldn't see". Desktop chats are driven through the app.
- **A revived chat can wake and still do nothing, and the stamp meant to prevent it mostly
  does not hold.** A prompt nobody can click is a silent deadlock: alive, idle, no error
  anywhere. Imports request the unattended mode (`applyDesktopChatAutomation`), the watcher
  diagnoses the stall by name (`detail.approvalStall`) instead of blaming dead background
  tasks, and the reliable workaround is to revive with file tools only.

  **Censused on the owner's real fleet 2026-08-27** (`bun scripts/permission-mode-census.mjs`,
  1,362 chats), because this had been reasoned about from anecdotes and the anecdotes had the
  shape BACKWARDS. The split is clean, and it is not about which folder a chat is in:

  | | n | unattended |
  |---|---|---|
  | Chats the app CREATES | 1332 | **100%** (one July exception) |
  | Chats we IMPORT | 30 | **13%** (4 of 30) |

  So chats the app makes for itself are fine, and every deadlock candidate is an IMPORT, which
  is to say one of ours. The stamp is written and then LOST: the app re-saves that metadata
  when the chat first boots and re-asserts its own import default, exactly as it does with
  titles, and for the same reason (while an app is running, its metadata files are its own).
  Do not read "imports request the unattended mode" as "imports get it": it held 4 times in 30.

  A per-folder preference in the app's own config (`epitaxy-folder-permission-mode`) looked
  like the durable lever and was RULED OUT by the same census: chats in folders carrying that
  preference are 100% unattended and chats in folders without it are 99%, which is the same
  answer twice, not a difference. The folder map explains nothing here.

  **The whole mechanism was then run as an experiment (2026-08-27) and it is worse than
  mitigated: per-chat stamping cannot work at all for a chat the orchestrator wakes.** A
  throwaway chat was seeded, and the states measured at every step:

  1. Seeded, not yet booted: `bypassPermissions`. The stamp DOES land.
  2. One message delivered, engine boots: `acceptEdits` within 9 seconds. Clobbered.
  3. Re-stamped `bypassPermissions` by hand on the already-booted chat: holds while idle.
  4. A second message delivered: `acceptEdits` again.

  So the clobber is not a one-time import behaviour that a later stamp could get ahead of. The
  app re-asserts its own mode on EVERY boot, and a delivery is a boot. That also explains the
  4 survivors in the census without needing a second mechanism: they are simply chats nobody
  has woken yet. A stamped import is unattended exactly until the moment it first does
  anything, which is the moment it stops being useful.

  The per-folder preference does not rescue it either, tested against the population it could
  plausibly have applied to: imported chats whose cwd IS in their instance's map are 1 of 3
  unattended, the same rate as everything else.

  **Therefore file-tools-only is not a workaround for an unreliable stamp, it is the standing
  posture for reviving an imported chat**, and the rubric says so. Closing this properly needs
  something the app owns: a setting, a launch flag, or an import that lands as an app-created
  chat rather than an import. Run the census before believing any future change fixed it.

  **Partially closed 2026-08-28, and the boundary of the fix stated exactly.** The deadlock hit
  live again (2026-08-29 01:58 UTC: a seeded reviewer-bootstrap chat booted ~15s after seeding
  froze at its first PowerShell prompt), and two convergence mechanisms now run. Every import
  starts a bounded watch (`reassertChatAutomation`) that rewrites the stamp each time the
  running app's re-save flips it back, so the FILE stays true even though the app's memory does
  not read it yet. And the archive-visibility restart re-stamps every import-shape chat in the
  store (`reassertAutomationStamps`) in its quit-then-reopen window, the same
  proven-can't-lose window the archive flags use; after that reopen the stamp IS the app's
  in-memory record and the app re-saves `bypassPermissions` itself from then on, permanently.
  App-created chats are never touched (an `acceptEdits` there can be the owner's own UI
  choice). What this does NOT fix, per everything above: a chat woken before any app restart
  still runs that first turn on `acceptEdits`, because no external write reaches the app's
  memory sooner. The import URL takes only a session id and `send_message` takes only a message
  body (both checked 2026-08-28), so there is still no surface to hand the mode to the app
  directly, and the engine runs inside the app's own Node service (no argv to inspect or set).
  The census remains the arbiter of "fixed".

  **Made fleet-wide and standing 2026-08-28** (owner, verbatim: "All chats. Should always
  have. Bypass permissions."), as a third convergence mechanism: the automation janitor
  (`runAutomationJanitor` / `sweepAutomationDrift`, orchestrator.ts, shipped in 24a7d26). Every
  tick it reads the tick's own cached metadata scan and re-stamps `bypassPermissions` onto
  every NON-archived desktop chat in ANY instance whose metadata says otherwise, one log line
  per corrected chat, running before the title janitor so a visibility restart in the same tick
  reads the corrected mode. Two boundaries moved and one did not. Moved: unlike
  `reassertAutomationStamps` it covers app-created chats too: the owner's rule retired "an
  `acceptEdits` there can be the owner's own UI choice" for every VISIBLE chat. Moved: it is
  standing (every tick, forever), not a bounded watch or a restart-window pass. Unmoved:
  archived chats are never written (pointless churn on retired entries), CLI sessions never
  appear in the scan, writes happen only on drift (the already-in-state short-circuit, pinned
  by server/tests/orchestrator-automation-janitor.test.ts with the archived/no-write cases), and
  the unfixable window is unchanged: a chat woken before any app restart still runs that first
  turn on `acceptEdits`, and while an app is RUNNING it may re-save the old mode over the stamp
  once a minute until its next boot makes the stamp permanent. Verified by regression test and
  both localci legs on 2026-08-28; NOT yet observed correcting drift on the live fleet, so the
  census stays the arbiter there.
- Context-size numbers come from the last assistant event's token usage - accurate enough for
  a handoff threshold, not an accounting tool.
- **Synthetic UI input is a dead end, not an unbuilt fallback.** A pre-v0.36 revive path drove
  the desktop app's own window (focus it, type into it). It was deleted with zero callers, and
  it must not be reintroduced as the answer to "no native route exists into this instance",
  because it cannot work in either state Remote Desktop leaves the owner in: while he is
  CONNECTED his own input keeps the app's idle gate shut, so the injected turn never starts;
  while he is DISCONNECTED the console session locks and synthetic input is dropped outright.
  The native delivery ladder is the only actuator, and when it has no route the action waits
  visibly instead.
- Windows-verified. The registry/transcript formats are the CLI's own and could shift with a
  CLI release; every parser here fails soft (a session it cannot read is reported as
  unreadable, never guessed at).
