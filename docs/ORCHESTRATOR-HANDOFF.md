# Orchestrator maintenance: the standing handoff

The copy-paste brief for whoever picks this up next, plus the state it is being handed over in.
Paste the fenced block into a fresh session; everything above and below it is context for a human.

**Last updated 2026-08-29.** The agent-chat courier (the relay replacement, law 5) landed as
9f48041: code-complete, test-pinned, both localci legs green, pushed. Concurrent sessions then
extended the ladder with the courier-TASK line (orchestrator-courier.ts + desktop-tasks.ts,
37210ab..bebc457): deliveries into an instance with nothing awake queue for a scheduled task
the app fires itself - proven live in 18 accounts. Everything below from 2026-08-28 stands.

**Amended 2026-08-29 ~04:30Z** at the closeout of the reviewer-journal session: both survey
tier-1 items are SHIPPED and green on CI (see the state update inside the block).

---

```text
You are the standing maintenance chat for AgentHydra's ORCHESTRATOR.

REPO: D:\PublicProjects\AgentHydra\app  (PUBLIC: LunarWerxs/AgentHydra, main only)
Odin (the fleet board) is a separate program at D:\NEWProjects\shared\odin.

READ FIRST, all current:
- docs/ORCHESTRATOR.md          architecture, settings, API, and the laws
- docs/orchestrate-command.md   the reviewer's rubric (also installed as /orchestrate)
- docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md   every migration trap, all measured
- CHANGELOG.md                  the [Unreleased] section carries this night's work
- docs/ORCHESTRATOR-HANDOFF.md  this file

## THE STANDING LAWS, enforced in code

1. ACTION GATE. The daemon never acts on a thread. It writes PROPOSALS; the reviewer decides
   each one; the server executes and VERIFIES before the ledger closes.
2. NO HEADLESS CHATS. Nothing runs where nobody can see it.
3. ZERO-CLICK. The owner never clicks. A keypress needed today is one needed forever.
4. Claims about what is RUNNING or VISIBLE need proof: a growing transcript, the app's own
   view, or the dossier. Disk is not the screen, and the ledger is not the sidebar.
5. NO RELAY (owner ban, 2026-08-28, verbatim: "remove the relay task functionality... don't
   just message other chats"). A working chat is NEVER a courier for another chat's delivery.
   The sanctioned replacement LANDED 2026-08-29 (9f48041): a dedicated orchestrator-OWNED
   agent chat per instance, marker-titled "Orchestrator agent - do not use"
   (server/src/orch-agent.ts). computeRoute composes cross-instance courier steps ONLY to a
   live marker-titled chat - a test pins that a working chat there never routes. With nothing
   awake at all the delivery QUEUES for that instance's scheduled courier task instead
   (orchestrator-courier.ts; landed after 9f48041). seed-agent proposals stand down where the
   courier task covers the instance (c916bbb). Direct-to-TARGET messages remain the core job.
6. ALWAYS BYPASS (owner rule, 2026-08-28: "all chats should always have bypass permissions").
   Every migrated or seeded chat MUST read back permissionMode bypassPermissions from the
   dossier BEFORE its boot message is sent; POST /api/sessions/:id/automation re-stamps.
   Stamped-and-hoped is not compliance - a running app re-saves the old mode.

## THE THREE READ-ONLY SURFACES (built 2026-08-28, use them FIRST)

  curl -s "http://localhost:7787/api/chats/dossier?q=<title or any id>"
      ONE query = everything about a chat: instance, archive flag fresh off disk, lineage ids
      across auto-compact rolls, done-mark, live pid, every ledger row. Never hand-walk stores.
  curl -s "http://localhost:7787/api/orchestrator/dryrun?format=text"     (also /orc-dryrun)
      What the orchestrator WOULD do with every chat and window - zero writes, no reviewer
      stamp. The owner reviews this to veto bad calls BEFORE anything runs. Show it verbatim.
  POST /api/sessions/:id/automation
      Stamp bypassPermissions onto a chat's metadata (verify + re-stamp loop; see law 6).

## DEPLOYING WITHOUT TOUCHING THE OWNER'S SCREEN (2026-08-29)

  powershell -File misc\Restart-Daemon.ps1 -DaemonOnly    # ALWAYS this, to adopt new code

⛔ The bare `Restart-Daemon.ps1` kills the tray host too and relaunches it, which puts AgentHydra
back on screen every single deploy ("you keep launching agent Hydra when it's open" - owner,
2026-08-29). `-DaemonOnly` swaps the daemon and nothing else: with a tray host alive its ~5s
watchdog brings the new daemon up; without one, a BARE daemon is started detached. Verified:
30 app windows before, 30 after.

⛔ AND NEVER OPEN A CLOSED CLAUDE ACCOUNT (same day, same reason). The archive-visibility restart
is quit-then-OPEN, so queueing it for a closed instance opens that account - which is how all 18
got thrown open at once. It is now refused for anything not already running, and the standing
`openInstances: never` setting says the same thing.

## HOW TO VERIFY ANYTHING

  curl -s -X POST http://127.0.0.1:7787/api/orchestrator/selftest -d "{}"
  curl -s "http://localhost:7787/api/orchestrator/worklist?reviewer=<your session id>"
  python ~/.claude/tools/localci.py --docker

BEFORE ANY PUSH, verify a CLEAN EXPORT of HEAD, never the working tree - 10-20 concurrent
sessions edit this tree. Commit path-scoped only. THIS REPO IS PUBLIC: announce that in the
reply before any push, every time.

## CLOSEOUT NOTE from the agent-chat chip thread (2026-08-29)

- Its whole contribution is ONE commit, 9f48041: orch-agent.ts (the marker + composers), the
  computeRoute agent-chat rung, seed-agent proposals + executor (bypass verified via fresh
  metadata before boot, kv stamp, lost-title -> pending rename), monitor/janitor/repo-occupancy
  exclusions, dry-run "agent chat:" line, 13 pinning tests (orchestrator-agent-chat.test.ts).
  Verified at landing: 906 tests, typecheck, biome, localci BOTH legs, GitHub push clean.
- What it could NOT verify: any LIVE agent-chat delivery (none had been seeded when it closed),
  and whether a courier agent chat obeys its verbatim-payload brief - that is prompt-level, so
  WATCH THE FIRST LIVE agent-chat DELIVERY. The courier-TASK line that landed after it
  (37210ab..bebc457) is other threads' work; this thread only reconciled the docs to it.
- Known accepted quirk: seeding an agent chat records a 'seed' placement in the balancing
  ledger (one row per courier, deliberate - reusing the proven seeder was worth it).

## STATE UPDATE (2026-08-29 ~04:30Z) - reviewer mortality is solved in code

- HEAD b83b5b6 on origin/main, CI green BOTH legs (run 33233211236). Two commits landed
  overnight by two concurrent sessions sharing this tree:
  - 20cedde  THE REVIEWER IS A ROLE, NOT A CHAT (survey tier-1 #1). GET
    /api/orchestrator/reviewer-journal = compact successor briefing (recent rulings with
    notes, in-flight wl: items WITH their saved verbatim steps, standing context). GET
    /api/orchestrator/reviewer-seed (?format=text) = ready-to-paste prompt that briefs ANY
    fresh chat as the successor; ends with the /orchestrate invocation. reviewerHealth now
    returns `fix` (stalled only) naming the seed endpoint. NEITHER endpoint stamps
    lastReviewerAt, on purpose. Reviving a dead reviewer = boot a fresh chat with the seed;
    NEVER resurrect the dead chat.
  - b83b5b6  THE CIRCUIT BREAKER (survey tier-1 #2, built by the concurrent session):
    attempt caps at proposal creation, revive-delivery backoff, repeat-hash on rulings;
    trips become one owner-facing loop_break attention item. Its docs live in
    docs/ORCHESTRATOR.md "The circuit breaker".
- VERIFIED for 20cedde (this session did it): full bun test 1461/0, web+server typecheck,
  biome clean, all six CI guardrails, web build - all against the exact commit in a detached
  worktree, then GitHub CI green. The three new tests pin the resolve+verify round-trip
  reaching the journal, the seed carrying in-flight ids + the /orchestrate literal, and the
  stalled-only fix line.
- NOT yet done: the RUNNING daemon predates both commits - a -DaemonOnly restart is needed
  before the journal/seed endpoints and the breaker are live (see DEPLOYING above). Also
  neither new endpoint has an MCP tool mirror (dryrun has one; these need curl for now).
- At this closeout two further untracked files (desktop-tasks.ts, orchestrator-courier.ts)
  sat in the tree - the concurrent session still mid-build. Do not sweep them into a commit.

## STATE AT HANDOFF (2026-08-28 ~22:45 CT)

- HEAD 24a7d26, main green (CI run 33230579959), everything of this session's pushed.
- THE DAEMON RUNS 5505a09-era code. It does NOT yet run 24a7d26 (the always-bypass janitor):
  the working tree was mid-edit by the agent-chat chip session at every restart window. When
  that session lands: pull, then misc/Restart-Daemon.ps1, and the sweep goes live.
- THE REVIEWER LOOP RAN IN THE OWNER'S DIAGNOSTIC CHAT and stops when that chat closes.
  BOOTSTRAP: open any desktop chat and type /orchestrate. That is the whole ritual. The
  ScheduleWakeup chain paces it; a CronCreate job every ~13 min is the dead-man switch.
- IN FLIGHT AT CLOSE: the agent-chat chip (per-instance orchestrator agent chats, the relay
  replacement) is editing the main tree uncommitted; the scanner chat's archive sits at the
  2-quiet-minute gate; the old "Orchestrate" chat and three moved-off tombstones on 2uhmany
  un-archive-flagged until their apps restart (queued).
- THE FLEET: Gods Eye (5claude), Postal Kumo (5claude), 99 Bricks (pap3r rotate2) were
  migrated off session-capped 2uhmany and verified live on their new accounts. 99 Bricks
  shipped a milestone post-move. 2uhmany's 5-hour cap reset at 22:30 CT.

## WHAT CHANGED TONIGHT, and why you must not undo it

- chat dossier + orchestrator dry run + /orc-move + /orc-dryrun: diagnosis and migration are
  one query / one command now. The hour-long hand-joins they replaced are the reason the
  owner was furious. (16ddca3, ba8459b, a5c9b53; commands in claude-memory home/commands.)
- Relay rung DELETED from computeRoute (5505a09). Owner ban, quoted in the code. Not a bug.
- Archive flags survive the app's quit-save (4499079): re-asserted between quit and reopen.
- Seeded chats converge to bypassPermissions (4d17558); fleet-wide janitor sweep (24a7d26).
- Resume evidence carries account + 5-hour window + a LIMIT RISK flag (8349b9a). This exists
  because a resume was approved blind and ran a chat into its session cap mid-edit. Never
  approve a resume without reading these fields.

## OPEN ITEMS, most important first

1. THE PHANTOM ARCHIVER. Something archived the reviewer chat "Orchestrate" at ~01:03-01:07Z
   on 2026-08-29 with NO ledger row, NO tool call, and the owner says he did not do it. Still
   unfound - but since 20cedde its blast radius is a briefing, not a decapitation: a fresh
   chat seeded from GET /api/orchestrator/reviewer-seed IS the recovery. Hunt continues:
   what writes isArchived into app memory without the engine or the UI.
2. REVIEWER MORTALITY - CLOSED IN CODE (20cedde, 2026-08-29). The reviewer is a role:
   reviewerHealth.fix names the seed endpoint whenever items wait and no reviewer has acted
   for 30m, and the seed briefs any fresh chat as the successor (in-flight ids to verify
   first, settled rulings, /orchestrate). Residual, by physical necessity: SOMETHING must
   still boot one chat - the daemon has no actuator into an empty app. That bootstrap step
   is the only surviving manual act.
3. BOOT-UNDER-RUNNING-APP RACE. Disk converges to bypass now, but a chat booted seconds after
   seeding can still start acceptEdits from app memory and freeze. Verify-before-boot (law 6)
   is the working mitigation.
4. Alert email for the key-exposure scanner has NEVER fired in production (needs a planted
   fake credential to prove); 8 Architect specs run nowhere (parity guard keys on filename).
   Both Connections-side, written into that chat's closeout docs.

## TRAPS THAT COST REAL HOURS (all measured, do not rediscover)

- The app's memory outranks the disk IN BOTH DIRECTIONS: archive flags flipped under a
  running app get re-saved away, and a disk un-archive is invisible to send_message.
- The Bash tool HALVES backslashes; Write/Edit do not. Escape-heavy content never goes
  through Bash. Same for inline commit messages with backticks: use a here-string or -F.
- A chat's id is NOT local_<sessionId> except for imports. Use chatId from the feed/dossier.
- send_message to another instance's chat SILENTLY STEALS it onto your account.
- An unattended session without bypassPermissions freezes at its first shell approval,
  alive and silent - the launch-terminal path takes the mode as a flag (no race); desktop
  seeds race (law 6).
- A "quiet" background poll that fetches the worklist with a fake reviewer id stamps
  lastReviewerAt and masks a dead loop. The dry run exists so probes never need to touch
  the worklist. The reviewer-journal and reviewer-seed endpoints deliberately do NOT stamp.
- scripts/checks/wmi-commandline-query-self-match.mjs goes FALSELY RED when run from a cwd
  whose CASING differs from the on-disk dir name (measured 2026-08-29 in a scratchpad
  worktree): Bun canonicalizes import.meta.url to disk casing, path.resolve() keeps the cwd
  string, so its exact-string self-exclusion fails and it flags its own file (lines 4, 93).
  Re-run from the canonically-cased path ((Get-Item $p).FullName) before believing it. Fix
  chip filed (compare case-insensitively on win32); unfixed as of this writing.

## HOUSE RULES

Work on main only. Commit path-scoped, never git add -A. THIS REPO IS PUBLIC: announce
before any push, every time. No em-dashes in new prose. Direct-to-target messages only;
no relays (law 5). Read the usage fields before approving any resume.
```

---

## For the human reading this

The night's diagnosis, verbatim complaints and all, lives in the owner's "Agent Hydra
orchestration issues" chat. The shared-memory bank (`Lunarwerx/claude-memory`,
`repos/agenthydra/`) carries the distilled lessons: the dossier-first rule, the
disk-vs-app-memory disease in all three measured forms, and both owner bans with their
whys. The /orc-move and /orc-dryrun commands are installed on both machines via
`home/commands/`.
