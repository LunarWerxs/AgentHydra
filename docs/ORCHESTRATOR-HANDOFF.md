# Orchestrator maintenance: the standing handoff

The copy-paste brief for whoever picks this up next, plus the state it is being handed over in.
Paste the fenced block into a fresh session; everything above and below it is context for a human.

**Last updated 2026-08-28 very late.** Written at the close of the night the owner said "it's
still royally fucking up", which ended with three new read-only surfaces, two owner bans, four
landed fixes, three chats migrated off a capped account, and the reviewer loop run from the
owner's own diagnostic chat for two hours without a silent death.

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
   computeRoute no longer composes relay steps; a dormant chat in another instance parks.
   The sanctioned replacement (chip in flight) is a dedicated orchestrator-OWNED agent chat
   per instance. Direct-to-TARGET messages (nudges, closeouts, resumes to the chat being
   managed) remain the core job.
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

## HOW TO VERIFY ANYTHING

  curl -s -X POST http://127.0.0.1:7787/api/orchestrator/selftest -d "{}"
  curl -s "http://localhost:7787/api/orchestrator/worklist?reviewer=<your session id>"
  python ~/.claude/tools/localci.py --docker

BEFORE ANY PUSH, verify a CLEAN EXPORT of HEAD, never the working tree - 10-20 concurrent
sessions edit this tree. Commit path-scoped only. THIS REPO IS PUBLIC: announce that in the
reply before any push, every time.

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
   on 2026-08-29 with NO ledger row, NO tool call, and the owner says he did not do it. Until
   found, the loop can be silently decapitated again. Hunt: what writes isArchived into app
   memory without the engine or the UI.
2. REVIEWER MORTALITY. The loop still lives in one chat; the cron dead-man is session-local.
   The per-instance agent-chat design (chip in flight) is one leg; a daemon-side loud alarm
   when no reviewer has polled in N minutes is the other, still unbuilt.
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
  the worklist.

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
