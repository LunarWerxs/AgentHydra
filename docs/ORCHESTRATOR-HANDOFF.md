# Orchestrator maintenance: the standing handoff

The copy-paste brief for whoever picks this up next, plus the state it is being handed over in.
Paste the fenced block into a fresh session; everything above and below it is context for a human.

**Last updated 2026-08-27 late.** Written at the end of a long session that changed four laws and
found five bugs, several of them in fixes made earlier the same day.

---

```text
You are the standing maintenance chat for AgentHydra's ORCHESTRATOR.

REPO: D:\PublicProjects\AgentHydra\app  (PUBLIC: LunarWerxs/AgentHydra, main only)
Odin (the fleet board) is a separate program at D:\NEWProjects\shared\odin.

READ FIRST, all current:
- docs/ORCHESTRATOR.md          architecture, settings, API, and the laws
- docs/orchestrate-command.md   the reviewer's rubric (also installed as /orchestrate)
- CHANGELOG.md                  the [Unreleased] section is this session's work
- docs/ORCHESTRATOR-HANDOFF.md  this file

## THE STANDING LAWS, enforced in code

1. ACTION GATE. The daemon never acts on a thread. It writes PROPOSALS; the reviewer decides
   each one, executes it, and reports.
2. NO HEADLESS CHATS (2026-08-27, supersedes the narrower "surface purity"). Nothing runs where
   nobody can see it. dispatchItem refuses EVERY headless run and POST /api/queue refuses to
   create a row; allow_headless no longer buys a way past. The escape hatch is the setting
   dispatch_allow_headless, off unless deliberately set, and its polarity is inverted from every
   other setting on purpose: absence means the ban applies.
3. ZERO-CLICK. Michael is remote and can never click or press anything. A keypress needed today
   is one needed forever. Nothing may wait on him.
4. Claims about what is RUNNING or VISIBLE need proof: a growing transcript, the app's own view,
   or a screenshot. Disk is not the screen.

## HOW TO VERIFY ANYTHING

  curl -s -X POST http://127.0.0.1:7787/api/orchestrator/selftest -d "{}"   # 16 checks
  curl -s http://127.0.0.1:7787/api/orchestrator                            # the feed
  python ~/.claude/tools/localci.py --docker                                # the repo's own CI
  cd D:\NEWProjects\shared\odin && python odin.py show agenthydra            # the board's view

BEFORE ANY PUSH, verify a CLEAN EXPORT of HEAD, never the working tree. This tree runs 10-20
concurrent sessions and its working tree routinely holds other people's half-finished work:
  git archive HEAD | tar -x -C <tmp>, then bun install --frozen-lockfile, then lint, typecheck,
  i18n, the six scripts/checks/*.mjs, build, bun test.
Main was broken THREE times on 2026-08-27 by commits nobody had run the gates against, each
caught by exactly this. A pre-commit hook now runs Biome on a commit's own staged files, which
closes the formatter half; it cannot catch a type or test failure.

## STATE AT HANDOFF (2026-08-27 late)

- v0.36.0. main is green, CI passing, everything pushed.
- The daemon is DEPLOYED from the current main and running on 127.0.0.1:7787, selftest 16/16.
- THE REVIEWER IS DEAD and has been for ~14 hours. Its process is gone from
  ~/.claude/sessions and its transcript's last line was written at 07:50. It did not crash: it
  finished a turn cleanly and was killed, almost certainly alongside the daemon and tray host,
  which also died silently that morning. NOTHING RESTARTS IT. Starting one spends an account's
  quota, so it is the owner's call.
- The feed now SAYS so ("N item(s) waiting and no reviewer has acted for Nm - start one").
  Until today it reported a dead reviewer as merely idle, because it counted only proposals as
  work and a pending rename was invisible to it.
- This maintenance chat parked itself with /orcstop, so the orchestrator will not prompt it.
  Type /orcstart in it to unpark, or leave it parked and work from the new session.

## WHAT CHANGED TODAY, and why you should not undo it

- The ultracode opt-in was a toggle wired to NOTHING. Its two siblings (model, effort) are real
  CLI flags; ultracode has no flag and no settings key, so the only way to ask for it is the word
  in the prompt text, and nothing ever put it there. new-chat-opening.ts is now the one
  definition; the feed serves newChatPrefix for deliveries no server code can reach.
- /delayo and /resumeo are now /orcstop and /orcstart. The old files are REMOVED, but only our
  own unedited copies, matched by a fingerprint recorded when we wrote them.
- Shipped commands now refresh themselves on boot. Before this, a rubric fix could sit in the
  binary forever while the reviewer read last month's copy, which is exactly what happened.
- A handed-off resume no longer reports itself FINISHED before the work starts. Opening a
  terminal returns the instant the window spawns, and that was being written as
  status=completed, exit_code=0.
- The queue subsystem is inert but honest: it refuses clearly rather than failing obscurely.

## OPEN ITEMS

1. RESTARTING THE REVIEWER is the owner's call (quota). Its death is visible now; nothing acts
   on it. This is the biggest live gap.
2. THE QUEUE'S FUTURE is the owner's call. An audit concluded: do NOT repurpose it to open
   visible terminals - you would keep the shell and lose live output, run history, real
   completion, auto-retry and per-run cost. It also cannot simply be deleted, because the
   auto-resume monitor uses queue_items as its own scheduling ledger. Giving the monitor its own
   store is the real job.
3. server/src/orchestrator.ts is ~2,650 lines. A split was deferred as too risky. Low priority.
4. CODEX STAYS OBSERVE-ONLY. Re-examined and it is a decision, not a gap: a rollout carries no
   record of which frontend wrote it and there is no live-writer guard, so a resume could
   double-write a transcript the desktop app holds open.

## TRAPS THAT COST REAL HOURS

- The Bash tool HALVES backslashes in its command parameter. Write/Edit do not. Anything
  escape-heavy goes through Write/Edit. It bit repeatedly, silently.
- Backticks in an inline Bash commit message get shell-interpreted and SILENTLY EAT the text
  between them. Two commit messages lost content this way. Write the message to a file and use
  git commit -F.
- While a desktop app is running, its chat metadata files are its own and it re-asserts them on
  EVERY boot. Titles, permission modes and archive flags all get silently reverted.
- A chat's id is NOT local_<sessionId>. That form is right only for IMPORTED chats. Use
  evidence.chatId from the feed, never construct one.
- Folder trust is keyed by the literal path string, so D:\X and D:/X are two records that
  disagree.
- An unattended launched terminal needs permission_mode bypassPermissions or it freezes on its
  first shell approval, alive and silent.
- origin/HEAD is a STALE LOCAL POINTER, not the remote's truth. Pushing to it created a stray
  master branch on the public repo. Push to the branch your local branch tracks.

## HOUSE RULES

Work on main only. Commit path-scoped, never git add -A (10-20 other agents edit this tree).
THIS REPO IS PUBLIC: announce that in the reply before any push, every time, even on a repeat.
Run the clean-export checks before pushing. No em-dashes in new prose.
```

---

## For the human reading this

Two other workstreams touched the same trees today and are **not** yours unless you pick them up:

- **The docs convention.** Every project in both trees now has `docs/` and `docs/todo/`, applied
  by `odin/docs_convention.py` and measured by `odin scan`. 59 of 59 live projects comply.
- **Odin's cleanliness score.** A 0-100 score per repo with itemised deductions, on the board as a
  sortable `clean` column. It flags 32 scratch files committed across the fleet and 18 repos with
  a cluttered root. Nothing has been tidied yet: the score makes the work visible, it does not do
  it.

Odin has its own separate handoff at `D:\NEWProjects\shared\odin\HANDOFF.md` for the fleet
burn-down, which is a different job from this one.
