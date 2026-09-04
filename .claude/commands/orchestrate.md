---
description: RUN THE ORCHESTRATOR - the v3 Python toolbox inside AgentHydra; one dry loop, one acting sweep, then answer only what the code hands you
---

<!-- CANONICAL COPY: AgentHydra repo .claude/commands/orchestrate.md - edit there, then re-copy to
     ~/.claude/commands (and claude-memory/home/commands) so the command works from ANY directory. -->

THIS DRIVES THE ORCHESTRATOR - `orchestrator/` inside the AgentHydra repo (owner order,
2026-09-03: it moved back in "so I don't have to explain that you have to use both"): the v3
rewrite, individual Python scripts (stdlib-only) talking to the AgentHydra daemon over HTTP,
now driven through the AgentHydra MCP server's own tools - `orchestrator_menu`,
`orchestrator_run {script, args}`, `orchestrator_loop`, `orchestrator_switch`. Every tool call
below has a shell twin (`python orch.py <script> ...` from `orchestrator/`); use the tools, they
are the same code. The v1/v2 MCP-tool flow (`prestart`, `chat_sweep`, courier tools) is GONE; if
you find yourself reaching for those, you are reading old habits, not this command. The division
of labor is owner law: THE CODE decides state and executes batches; YOU answer only the precise
callouts it hands back. Never re-implement any of it, never bypass a rails refusal with raw
daemon calls. `orchestrator/README.md` explains anything that surprises you.
Extra instructions, if any: $ARGUMENTS

⛔ A TARGETED MOVE IS NOT A PASS - DO NOT ARM FOR IT (learned 2026-09-03, moving four chats
off one account took ~20 minutes that should have been ~1). `migrate_chat` and `chats
--move-to` are HAND-RUN acts: they do not read the tray icon at all (the icon gates the
UNATTENDED lanes, which is the whole point of it), so arming buys a move nothing. What arming
DOES do is resume `saturate`, whose job is to WAKE dormant chats - and a chat with a live
engine cannot move until it has been quiet 300 seconds. So when the extra instructions say
"move the chats from X" or anything else that is one deliberate act on named chats:
  1. `orchestrator_switch {action:"armed"}` - if the icon is DOWN, leave it down.
  2. `orchestrator_run {script:"chats", args:["--instance","<from>","--move-to","<to>"]}`
     to PLAN, then the same with `"--yes","--idle-wait","330"` to do it. `--idle-wait`
     sleeps out the ONE refusal time cures (turn finished, five minutes not yet up) inside the
     command, instead of you re-running it on a guess; a working or stuck engine still refuses
     in a second. The headline counts what LANDED - "N of M attempted" is a partial, read it.
  3. A chat HELD as a duplicate still moves - `migrate_chat <id> --to <to> --force
     --stop-idle --idle-wait 330`, one chat per command, because --force is a person's word
     for ONE act and `chats` deliberately has no batch form of it. The hold survives the move.
  4. Pick a destination WITHOUT a chat of the same title already on it (audit_twins names the
     collisions) - identical titles on one account are what the sidebar cannot tell apart.
  5. THEN, if the owner also wants the pass, arm. Never the other way round.
Verify with `chats --account <from> --all`: the answer you want is "holds NO chats".

THE PASS, in order:

1. **`orchestrator_loop {}`** - DRY: census, gate, accounts and usage bands, the four lanes,
   naming, reconcile, and the judgment queue; touches nothing. STOP AND INVESTIGATE if the
   census sanity rail fails (0-1 open instances means detection is broken, not a quiet
   fleet) or the plan reports INCOMPLETE (a read failed; every lane is a lower bound).

2. **`orchestrator_run {script:"sweep", args:["--all","--yes"]}`** - THE ACTING PASS, within
   caps: archives, console landings (naming pass included), balance moves, staged deliveries -
   each through its own act script's rails (hold, live-writer, breaker, T-0 recheck, verified
   outcome). Read the per-row outcomes. A refusal names its reason and is not yours to force; a
   breaker or hold is information, not an obstacle.

3. **`orchestrator_run {script:"interview", args:["--ask"]}`** - THE JUDGMENT QUEUE, the only
   part that is yours, and THE PART THAT MAKES CHATS RUN - a pass that leaves it unanswered is a
   failed pass (the owner's complaint that forced this line, 2026-08-31: "all my chats are
   sitting idle and it's not making them run"). Each question is self-contained: the chat's own
   last words plus the exact answer format. Write `orchestrator/answers.json`
   (`{"answers":[{"sessionId":...,"decision":"reply|hold|archive|skip", ...}]}`).
   THE PROGRESS DEFAULT (owner doctrine): a chat that offers to continue or names its next
   step gets a REPLY saying which thing to do; hold and skip demand a reason a person would
   accept, and "waiting on the owner" only counts when the decision is genuinely his
   (spend, live customers, public exposure, another person's lane). When last words are
   not enough, open the chat in the desktop and READ it - never guess. Then
   **`orchestrator_run {script:"interview", args:["--apply","answers.json"]}`** - each decision
   executes through the rails; replies are STAGED and the sweep/courier delivers them under the
   machine-wide 18-running cap (deferred wakes stay staged; the 5-minute cycle is the round
   robin).

4. **Report what CHANGED**, one plain-English line per act, and name anything you left
   alone with its reason. A status recital is a failed run: if nothing changed, either the
   fleet was genuinely all-clear (one line) or you skipped work - assume the second and
   look again.

STANDING FACTS - do not re-derive or re-build these:
- ⛔ NOTHING ACTS WITHOUT THE TRAY ICON (owner, 2026-09-01: "it can't be running without the
  status bar icon, so I can terminate it if I want"). `scripts/tray.ps1` beats into
  `state/tray.json` while it is up, and every UNATTENDED lane asks `lib/armlib` for that beat
  before it moves, wakes, archives, presses or writes - observing is never gated, and the
  default on any machine is OFF. (A hand-run `migrate_chat` or `chats --move-to` is the
  person's own act and is NOT gated - that is why a targeted move must not arm, see the
  top of this file.) So CHECK IT FIRST with `orchestrator_switch {action:"armed"}`:
  a disarmed fleet makes step 2 return blanket refusals that look exactly like an all-clear pass.
  ⛔ WHO MAY TURN IT ON (owner, 2026-09-02: "/orchestrate should tell it to spin up the
  orchestrator service, so I don't have to find the script"): a /orchestrate THE OWNER TYPED
  is his hand on the switch - if the icon is down, run `orchestrator_switch {action:"arm"}`
  FIRST (it registers any missing lanes and starts the icon PAUSED; `resume` throws the
  switch), say so in one line, then continue. But a pass that is NOT his hand NEVER arms: the
  standing manager chat's own loop (its birth prompt says "standing manager chat"), any
  cron-fired /orchestrate, any watchdog wake-up. On those, a down icon means he switched it
  off - report that in one line and stop; re-arming a fleet he just stopped is the one thing he
  has forbidden twice.
- NINE Windows scheduled tasks already run EVERY 5 MINUTES (dashboard keepalive, reconcile
  observe-only, odin todo-sweep, the doctrine re-stamp, saturate's running floor, unblock,
  THE GROUNDSKEEPER, the TWIN AUDIT, and THE OVERLORD WATCHDOG - overlord.py, which WAKES this
  chat through the engine whenever it goes quiet >=5 min while work waits;
  `orchestrator_run {script:"schedule_jobs", args:["--status"]}`). The re-arm is MECHANICAL:
  you do not have to remember to keep yourself alive, and a watchdog wake-up message in this
  chat means "run the next pass now". Title the standing chat 'Orchestrate' (or
  `orchestrator_run {script:"overlord", args:["--claim","<chat>"]}`) so the watchdog knows
  which chat is you; a chat the toolbox itself started from its manager prompt is recognised
  without either. ⛔ THERE IS ONE OVERLORD (owner, 2026-09-04): never start another
  /orchestrate chat, in this account or any other, and never reply to or wake a spare manager
  chat - the watchdog claims the newest manager instead of spawning, and if
  `overlord --status` names SPARE manager chats, retire them with
  `orchestrator_run {script:"archive_chat", args:["<id>","--force"]}` and say so.
- AN ARCHIVE NEEDS FOUR SIGNALS AND A WAIT (owner, 2026-09-01: chats were being filed before
  they were done). The recap must claim done, ask nothing, offer nothing, AND recommend nothing
  still open - a recap that still recommends work has STOPPED, not finished, so it belongs in
  the wake lane. On top of that, an unattended archive waits until the chat has been quiet 45
  minutes. Never overrule this by eye: if you think a chat is done and the gate disagrees, the
  gate is reading its own words - go read them too before acting.
- ⛔ NEVER fire `claude://resume` at an instance to "re-render" a chat. If that profile already
  carries it, the app makes a SECOND record, and a twin makes the chat unmanageable forever
  (the sidebar actuator refuses to guess between identical titles). `audit_twins` finds and
  settles them; the daemon now refuses the duplicate import itself.
- THE DORMANT LANE IS MECHANICAL NOW - `groundskeeper`, every 5 minutes (owner, 2026-09-01:
  "multiple of my accounts have dormant chats just sitting there not running or archived").
  It EVACUATES wake-able chats off an account past its usage target onto the emptiest healthy
  one, and ARCHIVES chats whose own recap claims done, through the knowledge-preservation
  step. So a dormant chat you find still sitting is EVIDENCE, not a chore: either it is held,
  it is genuinely waiting on a person, or a lane is failing - say which.
- THE BANDS ARE A DOOR EVERY LANE GOES THROUGH (bandlib), not advice you apply by hand. The
  courier refuses to deliver into an account over 85%, and no account may hold more than its
  SHARE of the running floor (~4 of 18 across 5 open accounts). If the floor cannot be met,
  the reason is printed - usually too few OPEN apps, which is the owner's call, not yours.
- THE RECOMMENDATIONS CHANNEL (owner, 2026-09-01: acting on recap recommendations is "one
  of my most productive ways to fix things I hadn't thought of fixing"): when a chat's
  recap recommends sensible next work, the default answer is a reply saying "proceed with
  your recommendations" - do not let good recommendations die in a recap.
- The dashboard is live at http://127.0.0.1:7799 - accounts strip with the usage bands,
  every configured rule with its live value, and per-chat dry-run decisions.
- THE USAGE BANDS (owner): at or under 85% on either window; 90% is the hard gate
  (evacuation mandatory); below the ceiling, deliberate fill. `balance` encodes it and
  sweep's move lane executes it - you never eyeball percentages yourself.
- THE AUTOMATION DOCTRINE (bypassPermissions + ultracode + the chat's own model) is stamped
  MECHANICALLY by the scripts on every landing and native delivery. Never write it into a
  prompt; `orchestrator_run {script:"automation_chat", args:["--all"]}` shows fleet conformance.
- Usage numbers come only from the scripts (AgentHydra's survey underneath) - never from
  your own guesses.

ARM THE LOOP - belt AND suspenders, BUT ONLY IN THE ONE OVERLORD (owner, 2026-09-04: several
manager chats each running their own 5-minute timer in different accounts IS the "multiple
orchestrators" he saw). First `orchestrator_run {script:"overlord", args:["--status"]}`: if
the overlord it names is not THIS chat, arm nothing here, say in one line that the standing
manager is elsewhere, and stop - a spare that keeps a timer is a second orchestrator. If it is
this chat: after a clean pass, `CronList`; if this session has no
recurring `/orchestrate` job, `CronCreate { cron: "*/5 * * * *", prompt: "/orchestrate",
recurring: true }` and tell the owner in ONE line. This in-chat timer is the FAST path;
the overlord watchdog (standing fact above) is the guarantee - if the timer dies or was
never armed, the watchdog wakes you anyway (2026-09-01: a chat that armed nothing sat dead
48 minutes before the watchdog existed). SKIP arming when this run is itself
cron-fired/unattended, or when the pass failed - a broken pass must not replicate. On later
cron-fired passes: when the loop shows nothing waiting, the whole report is ONE line.

YOUR OWN QUOTA (owner-blessed pattern, 2026-09-01 - an overlord that halted itself at 81%
"was exactly right"): at or past 85% on either window of YOUR account, post a one-line
halt recap and STOP. Do not migrate yourself and do not open accounts - THE WATCHDOG
notices a halted overlord on a cooked account, relocates this chat to the open account
with the most room (the daemon's atomic migrate), and wakes you there. Quota-immortality
is mechanical; your only job is the honest halt.
