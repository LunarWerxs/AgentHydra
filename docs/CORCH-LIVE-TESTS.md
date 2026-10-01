# Corch live tests

`scripts/corch-live.ts` runs Corch against the owner's real CLI accounts through the running
daemon's HTTP API. The unit tests (`server/tests/corch.test.ts`) pin the decisions with a fake CLI;
this script is the proof that the real CLI, the real accounts and a real daemon restart behave the
same way. Each turn is a one-line reply, but it spends real quota: moving a session to another
account costs one uncached prompt (about $0.50).

```bash
bun scripts/corch-live.ts handoff
```

```bash
bun scripts/corch-live.ts restart
```

```bash
bun scripts/corch-live.ts burst 10
```

`restart` restarts the daemon (other sessions see a short blip). Accounts are found, not named:
"live" accounts have a credential file, no signed-out wall and a working `claude auth status`.

## What each scenario proves

| Scenario | What it does | What must hold |
| --- | --- | --- |
| move-and-back | Turn 1 on account A; A kept busy, so turn 2 runs on B; B kept busy, so turn 3 runs on A again | Turn 3 knows the codeword given in turn 2 (only B's newer transcript had it, so A's stale copy was overwritten); the file it edits has all three lines. "Kept busy" is a worker of the SAME group: `per_account` caps a group's own workers, so another group's worker does not make the account full |
| queued follow-ups | Two messages sent while the worker runs a command | Both arrive in order in the same session (`STEP3 STEP2 STEP1-…`) |
| cancel-and-revive | Stop during a command, then send a message | The CLI process is gone; the next turn resumes the session and still knows the codeword |
| follow-up on a dead login | A turn lands on an account whose login is dead | It fails `auth`, and the session finishes on the live account with the follow-up answered |
| daemon restart mid-run | Two workers in a command; restart unforced, then forced | Unforced is refused (409, names the Corch workers); forced, each worker is `interrupted`, resumes on the same account and finishes |
| burst | More tasks than the fleet runs at once | Every task finishes with its own output |

## Results, 2026-09-30 (#83, #84, #88, #90 signed in; #68, #69 expired)

- Every scenario passed. Burst: 10 of 10 in 16 s, spread over the four live accounts, none sent to
  the dead ones.
- Found and fixed (commit `0e87421`):
  - A daemon restart killed every running worker and each ended `failed` with its turn lost. On
    Windows the workers sit in the daemon's kill-on-close job. They are now resumed as
    `interrupted`, and a restart under running workers needs `force: true`. (Superseded in round
    six: workers now run under runners outside the daemon and a restart leaves them running.)
  - The expired #68/#69 were handed a worker's attempt every 30 minutes. A signed-out wall now
    lifts only when `claude auth status` says the login works.
  - A usage reading from a window that had already reset still counted.
- Learned: the CLI writes a follow-up into the transcript before a dead login fails it, so the
  handoff prompt finds it. The CLI refuses a bare `sleep N` in its Bash tool, so the script waits
  with python's `time.sleep`.
- Not yet seen live: a real usage-limit (`quota`) handoff. The same move and resume path is proven
  by the dead-login and busy-account moves above, and the limit notice is pinned by the unit tests.

## Round two, 2026-09-30: Corch reviewed and fixed by Corch

Two review workers ran through Corch itself on #84 and #90, one on context loss and one on
scheduling and process lifecycle. A forced daemon restart hit both mid-review; both resumed and
wrote their reports. Every finding was checked against the code before a fix. Two more Corch workers
wrote the fixes (the reset-time parser on #84, the 17 Corch items on #90), which were reviewed,
tested (server suite 1974 pass, 0 fail) and landed as `c638e59` and `41fb0ff`:

- **Stuck forever:** the account a worker last failed on was excluded for good, even after its wall
  lifted. A reused PID after a restart kept a dead worker `running`, which also blocked every
  restart behind the 409.
- **Lost work:** a long turn cut by a restart re-sent its whole task, because `system/init` had
  fallen out of the 400-event window. A 529 retry re-sent its message. A handoff with no transcript
  dropped the follow-up. A message to a stopped worker re-ran the stopped work first. A failed spawn
  lost the follow-up. A stderr warning turned a restart kill into a lost `error`.
- **Wrong numbers:** `parseResetTime` could not read any real limit notice ("resets 4am", "9:10am
  (America/Chicago)"), so every wall was a blind 60 minutes. Corch read the usage field only a
  manual check writes. A killed or stopped attempt's spend counted $0. Opus 5.5, Sonnet 5.5,
  Fable 5.1 and Mythos 5.1 had no prices at all.
- **Daemon health:** any fs error in the tick exited the daemon. A side-run daemon shared (and
  overwrote) the primary's store. Finished logs stayed parsed in memory.
- **Also fixed on the way:** `corch_status` waits at most 50 s (the desktop MCP client drops a call
  at about 60 s: 55 s answered, 110 s and 300 s timed out). "Restart needed" no longer fires for a
  commit of server edits the daemon already runs (`0c21768`).

Live on the new code: move-and-back #90 → #84 → #90 with both codewords, restart (both workers
`interrupted`, then done on their own accounts), burst 8 of 8 in 10 s, cancel-and-revive, queued
follow-ups; a stopped attempt now shows its spend ($0.25 for one cut mid-command).

## Round three, 2026-09-30: a real limit, paid overage, and the cost ledger

- **A real limit-driven move.** #90 was driven to 100% of its 5-hour window by real work (a
  max-effort review). Its next turn went to #88 (`#90:done > #88:done`, one move). The session
  still knew the codeword from its first message, how many findings its report had (10), and the
  title of the worst one.
- **Paid extra usage (overage).** #90 never hit a wall: with extra usage switched on, the CLI
  streamed `rate_limit_event {status: "rejected", isUsingOverage: true}` 36 s into the turn and went
  on, billing credits. $3.82 of that $4.67 turn, plus a $0.24 probe, ran on #90's overage. Corch
  now walls such an account until its window resets the moment the event appears, and stops the
  turn, and the session moves to an account with free quota (commit `0dcffa0`). The script skips
  accounts at 98% or more of an open window.
- **The cost ledger double-counted.** On a resumed session the CLI's `total_cost_usd` is the whole
  session's cost so far ($4.67, then $6.44 for a one-turn follow-up that cost $1.77). Adding it per
  attempt counted every earlier turn again on each follow-up, handoff and resume. Each attempt is
  now priced from its own transcript turns, which matches the CLI to the cent (`1e7c871`).
  Move-and-back now costs $0.78, where the same scenario showed $1.69 before.
- **Limit detection, checked against 6,283 real CLI error lines** (`0dcffa0`):
  - A clean result is `done` first.
  - "Not your usage limit" throttles are transient.
  - "Reached your Fable limit" and "out of usage credits" are quota.
  - A dropped connection is transient.
  - The CLI's own `resetsAt` ends the wall, 60 s after the reset.
- **Also:** the `corch_*` MCP tools now reach Corch only over HTTP (`a63ab65`). The 409 restart
  gate held for real when another session tried to restart the daemon under a running worker.

## Round four, 2026-09-30: never spend overage, faster starts, what a move carries

The owner's rule is to never go into paid extra usage. It is now a setting, **Settings >
Providers > Allow paid extra usage** (since `d3010f9` it covers all of AgentHydra, not only Corch), off by default and never synced to another machine
(`350a078`). With it off:

- On an account that CAN bill (usage events say `overageStatus: "allowed"`; of the four, only #90
  does), a turn is stopped at 98% of the 5-hour window or 99% of the week, before any request
  bills. It then moves to an account with free quota (`4f17474`).
- If overage starts anyway, the turn is stopped within about a second: while a worker runs, the
  tick is 1 s.

Other changes this round:

- **Faster starts.** Workers start without the account's claude.ai connectors. Measured on #83:
  2.0-3.0 s to the CLI's init with them and 1.2-1.3 s without, with a steady 137 tools instead of
  158-202. On a whole task this is inside the noise of the model's own time (a burst's median
  attempt stayed 7-9 s).
- **Faster resumes.** An interrupted attempt resumes on the next tick (was 3.1 s every time).
- **Fresher routing.** Routing uses each account's live usage from its workers' own streams when
  that is newer than the 15-minute snapshot.
- **What a move carries.** A session that used a subagent moves with its `subagents/` files, and
  the resumed turn still knows the subagent's output (`subagent` phase, passed #88 → #84). The
  project's auto-memory (`projects/<project>/memory/`, kept per account by the CLI) now moves too
  (`000c848`).
- **Stopping a group mid-command.** 6 of 6 cancelled, 0 CLI processes left, and the stopped
  attempts' spend recorded.

## Round five, 2026-09-30: planned handoff instead of a move

This was the owner's idea. The session that has the context writes a handoff before its account
runs out, and the task goes on in a fresh, small session elsewhere, instead of the next account
re-reading the whole conversation (`5de5bbc`, `2965507`).

- **How the worker hears it.** At 85% of the 5-hour window (95% of the week), and only when
  another account has room, Corch writes a signal that a PostToolUse hook shows the worker after its
  next tool call. The hook is installed per worker with `--settings` and costs about 65 ms a call.
  Proven live first: the CLI showed the hook's `additionalContext` mid-turn and the model acted on
  it.
- **What the continuation gets.** The task, the handoff, the old transcript's path, and any queued
  messages, all in a new session. A hard limit, a sign-out or a restart still moves the whole
  transcript, as before. `corch_handoff` (MCP) hands a running task off on request.
- **Live run: a six-step task, handed off after step 2.**
  - The first run had three handoffs. #88 (at 90%) wound down on its own after step 1, the manual
    handoff followed, and the next session was placed on #84 at 91%, which wound down at once. The
    fix: accounts past the line score last, and a handoff keeps no home.
  - The rerun had exactly one handoff (#83 → a fresh session on #83, the account with room). Steps
    1-6 ran once each, the codeword from the first message arrived through the handoff alone, and
    the run cost $0.69 against $1.34 for the run with the extra handoffs.
- **What a fresh session saves.** A fresh session starts at about 45k tokens (the CLI's own prompt
  and tools). A long session can be 219k (the #90 review), so the saving grows with the length of
  the conversation, and every later turn is smaller too.
- **Workers no longer load AgentHydra's own MCP server** (`5fceb0c`). It supplied 84 of their 138
  tools, enough for a worker to start more workers or move desktop chats.

## Round six, 2026-09-30: restarts no longer touch running workers

- **Runner launch, proven before wiring.** A runner started through the WMI hand-off outlived its
  launcher (its parent was WmiPrvSE.exe), ran its child to the end and wrote exit code 0. Gotcha: a
  launcher that exits at once takes the transient powershell with it before WMI creates the runner;
  the daemon lives on, so only a throwaway test launcher has to wait a few seconds.
- **Two live restarts with real workers running** (`509c3f7`). The first, forced, moved the 6
  running pre-runner workers onto runners (each resumed once). The second, NOT forced, was accepted
  (`activeRuns: 0`): all 7 workers kept the same attempt count, stayed `running`, and their latest
  activity kept moving. A third restart after `6c34872` did the same.
- **Test tasks archived.** 121 finished tasks that ran in scratch or temp test folders were removed
  with `POST /api/corch/remove`; their logs and transcripts are in
  `~/.agenthydra/corch/archive/2026-10-01T00-05-53-238Z/`. 23 real tasks remained.
- **Wind-down "at 85%" on an account the table showed at 34%** was right: #84's CLI streamed
  0.85-0.88 of its 5-hour window, and the usage cache read 89% fifteen minutes later. The table
  lagged (30-minute sweep); it now shows the workers' live readings (`6c34872`).

