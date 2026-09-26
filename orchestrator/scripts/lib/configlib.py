"""configlib - THE POLICY FILE: every knob the orchestrator has, in one place, with a default.

THE COMPLAINT THIS EXISTS FOR (owner, 2026-09-17): "most of the orchestrator should probably
be configurable. Like, it should ask which variants or whatever, which toggles, triggers,
options the user wants on. And then when we decide that, it orchestrates." Measured the same
day: 138 user-facing policy knobs were spread across 18 files as module constants and
`always-on` behaviours with no switch, and the toolbox had NO config file, no env var and no
per-fleet policy at all - archive_chat.py's own audit line was "the complete set of
user-facing knobs; there is no config file". Changing how the fleet behaves meant editing
Python, which means the owner cannot steer his own orchestrator without a code change.

HOW IT WORKS, and the two rules that keep it honest:

  1. EVERY DEFAULT HERE EQUALS TODAY'S HARDCODED VALUE. Installing this file changes no
     behaviour whatsoever - `orch.py policy --diff` prints nothing on a fresh machine. The
     one deliberate exception is archive.ai_decision_uses_force, which is called out in its
     own help text and in the CHANGELOG, because it was the forced-archive bug the owner
     reported in the same breath.
  2. PRECEDENCE IS ALWAYS: explicit CLI flag > config.json > default here. A flag a person
     typed always wins; config is what happens when nobody typed anything. Never the reverse -
     a config file that overrules a person's own command is a trap.

WHAT IS DELIBERATELY *NOT* A KNOB (the rails - see RAILS below): the live-writer rule, the
hold rail, post-act verification, the T-0 re-check, the DENY list, and the tray-icon switch.
Those are the reasons the toolbox is allowed to act unattended at all; a config that could
switch them off would be a config that can lose work. They are listed in RAILS so the menu
can SHOW them as non-negotiable rather than leaving the owner to wonder why they are missing.

Usage from a script:
    from lib import configlib
    ARCHIVE_PER_RUN = configlib.get("groundskeeper.archive_per_run")   # at import time

Module constants stay module constants (tests monkeypatch them, and a per-process read means
a config edit lands on the next 5-minute tick, never mid-run).
"""

from __future__ import annotations

import json
import contextlib
import os
from pathlib import Path
from typing import Any

STATE = Path(__file__).resolve().parent.parent.parent / "state"
CONFIG_PATH = Path(os.environ.get("ORCH_CONFIG") or (STATE / "config.json"))


class ConfigError(ValueError):
    """A config value that cannot be honoured. Raised loudly at load - a policy file the
    toolbox silently ignored would be worse than no policy file at all."""


def _k(key: str, default: Any, kind: str, group: str, help: str, **extra) -> dict:
    return {"key": key, "default": default, "kind": kind, "group": group, "help": help, **extra}


# ---------------------------------------------------------------------------------------
# THE SPEC. One row per knob: key, default (== today's hardcoded value), kind, group, help.
# `kind`: bool | int | secs | pct | str | enum | int_or_null | str_or_null (null = unset).  `secs` is an int in seconds
# rendered as minutes in the menu.  Ranges are advisory guardrails, not opinions: they stop
# a typo (a 5-second archive quiet window) from reaching the fleet, nothing more.
# ---------------------------------------------------------------------------------------
SPEC: list[dict] = [
    # ---- THE GATE: how a chat's state and lane are decided --------------------------
    _k("gate.idle_after_secs", 180, "secs", "gate",
       "How long a live chat must be quiet after a completed turn before it counts as IDLE "
       "(wakeable) rather than thinking.", min=30, max=3600),
    _k("gate.stall_quiet_secs", 1800, "secs", "gate",
       "How long an unanswered shell call must sit before the chat is called STUCK rather "
       "than 'a long command is running'.", min=300, max=21600),
    _k("gate.evidence_cap", 2000, "int", "gate",
       "Trailing characters of a chat's last words kept as the evidence every judgment "
       "decision is made from.", min=200, max=20000),

    # ---- THE FOUR ARCHIVE SIGNALS: the owner's own guard, now switchable ------------
    # ⛔ ALL FOUR DEFAULT ON. They are the guard the owner asked for on 2026-09-01 ("I
    # strongly feel chats are being archived when they are not completely done"). Turning
    # one OFF makes archiving MORE eager, never less - the menu says so in those words.
    _k("gate.signal_done_claim", True, "bool", "gate.archive_signals",
       "Require the chat's own recap to claim it is done before it can be archived. "
       "OFF = archive chats that never said they finished. (Signal 1 of 4.)"),
    _k("gate.signal_no_question", True, "bool", "gate.archive_signals",
       "Require the chat to not end on a question. OFF = archive chats that asked you "
       "something and never got an answer. (Signal 2 of 4.)"),
    _k("gate.signal_no_offer_to_continue", True, "bool", "gate.archive_signals",
       "Require the chat to not be offering to carry on ('say the word', 'want me to...'). "
       "OFF = archive chats that were waiting for your go-ahead. (Signal 3 of 4.)"),
    _k("gate.signal_no_open_recommendations", True, "bool", "gate.archive_signals",
       "Require the recap's 'Do I recommend anything else?' to be empty. OFF = archive chats "
       "that still recommend work - the owner's most productive input channel. (Signal 4/4.)"),

    # ---- ARCHIVING -------------------------------------------------------------------
    _k("archive.enabled", True, "bool", "archive",
       "The archive lane as a whole. OFF = candidates are listed and never filed; nothing "
       "in the toolbox archives anything."),
    _k("archive.quiet_secs", 2700, "secs", "archive",
       "How long a done-looking chat must be untouched before an UNATTENDED archive may "
       "file it. Your hand-run archives ignore this.", min=300, max=86400),
    _k("archive.per_run", 3, "int", "archive",
       "Most chats one groundskeeper pass may archive. A batch, not a purge: a bad reading "
       "can only ever cost this many chats before you see it.", min=1, max=50),
    _k("archive.preserve_knowledge", True, "bool", "archive",
       "Before filing a chat, ask it to write anything worth keeping into real docs, and "
       "wait for that turn. OFF = archive immediately, losing whatever it never wrote down."),
    _k("archive.preserve_grace_min", 20, "int", "archive",
       "Minutes to wait for that preservation turn before deciding the chat is dormant.",
       min=1, max=1440),
    _k("archive.archive_anyway_after_grace", True, "bool", "archive",
       "When the grace window elapses and the chat never ran its preservation turn, archive "
       "it anyway (a dead chat cannot write docs). OFF = it is NEVER archived unattended and "
       "waits for you - safer, but done chats pile up in the sidebar."),
    # ⛔ THE ONE DEFAULT THAT IS NOT TODAY'S BEHAVIOUR (owner, 2026-09-17: "the orchestrator
    # itself seems to have issues where it, like, forcibly archives or whatever"). interview.py
    # ran EVERY AI 'archive' answer as `archive_chat --force`, and --force is the one flag that
    # lifts the owner's own HOLD rail - so a hold he placed by hand could be overruled by a
    # model's answer in the judgment queue. That is the forced archive he is describing. The
    # default is now False: an AI decision goes through the same rails a person's does, and a
    # held chat comes back as refused-by-hold instead of being filed.
    _k("archive.ai_decision_uses_force", False, "bool", "archive",
       "Let an AI's 'archive' answer in the judgment queue run with --force, which overrules "
       "a HOLD you placed by hand. Default OFF (this was ON, unswitchable, before 2026-09-17: "
       "the 'it forcibly archives' bug). ON restores the old behaviour."),

    # ---- THE SWEEP'S LANES -----------------------------------------------------------
    _k("lanes.archive", True, "bool", "lanes",
       "Sweep lane: file the chats the gate calls done."),
    _k("lanes.moves", True, "bool", "lanes",
       "Sweep lane: move chats off accounts that are out of usage onto ones that can run them."),
    _k("lanes.land_console", True, "bool", "lanes",
       "Sweep lane: pull console-only chats into the desktop app so they are manageable."),
    _k("lanes.deliver", True, "bool", "lanes",
       "Sweep lane: send replies an AI already staged into their chats."),
    _k("lanes.max_per_lane", 5, "int", "lanes",
       "Most acts one lane may perform per sweep. The safety valve on every batch.",
       min=1, max=100),
    _k("lanes.breaker_threshold", 3, "int", "lanes",
       "Consecutive same-cause failures that halt a lane for the rest of the pass, instead "
       "of burning every remaining chat on a cause that will not clear.", min=2, max=20),
    _k("lanes.naming_pass", True, "bool", "lanes",
       "After landing chats, give them real names (fresh imports land nameless)."),
    _k("lanes.doctrine_pass", True, "bool", "lanes",
       "After every acting sweep, re-stamp the automation doctrine across the whole fleet."),

    # ---- THE DOCTRINE STAMP ----------------------------------------------------------
    _k("doctrine.stamp_bypass_permissions", True, "bool", "doctrine",
       "Force every chat to bypassPermissions so it never stops on a prompt nobody will click."),
    _k("doctrine.stamp_ultracode", True, "bool", "doctrine",
       "Force ultracode on for every chat, so a chat you did not start by hand still works "
       "at the depth the fleet expects."),
    _k("doctrine.stamp_effort", "xhigh", "enum", "doctrine",
       "Reasoning effort stamped alongside ultracode.",
       choices=["low", "medium", "high", "xhigh", "max"]),
    # THE AUTOMATION PROFILE (owner, 2026-09-24: "I run chats on ultra, you run them on whatever
    # you know is efficient"). Chats the toolbox launches itself - spawn_chat and everything built
    # on it (fan_out, chips, the overlord), the console fleet - carry a launch marker
    # (stamplib.mark_automation) and are stamped with these instead of the two above. Shipped
    # defaults are today's doctrine exactly; the owner's own measurement (high passed the same
    # 10/10 real fixes as xhigh on 2.3x fewer output tokens) is why his machine sets them lower.
    _k("doctrine.automation_ultracode", True, "bool", "doctrine",
       "Chats the toolbox launches itself (fan-outs, chips, the manager chat): ON stamps them "
       "exactly like every other chat, by the two settings above. OFF runs them at the "
       "automation effort below with ultracode off; your own chats keep the settings above."),
    _k("doctrine.automation_effort", "xhigh", "enum", "doctrine",
       "Reasoning effort stamped on chats the toolbox launches itself. Ultracode needs xhigh, so "
       "anything lower only means something with automation ultracode OFF.",
       choices=["low", "medium", "high", "xhigh", "max"]),
    _k("doctrine.console_effort", "high", "enum", "doctrine",
       "The --effort flag every console chat the console fleet starts or wakes is launched with "
       "(it is set at launch and cannot drift). Ships at high (ruling 2026-09-24): every console "
       "chat is one the fleet started or woke, so it runs at the efficient effort, not the owner's.",
       choices=["low", "medium", "high", "xhigh", "max"]),
    _k("doctrine.stamp_held_chats", True, "bool", "doctrine",
       "Stamp chats you have put on HOLD too. ON is today's behaviour (the stamp is config, "
       "not work); OFF leaves a held chat completely untouched by every lane."),
    _k("doctrine.ensure_allow_all", True, "bool", "doctrine",
       "Also rewrite your global Claude settings' permission allow-list and default mode on "
       "every enforcement run. This is the one lane that edits files outside the fleet."),

    # ---- THE GROUNDSKEEPER'S FIVE DUTIES ---------------------------------------------
    _k("groundskeeper.duty_evacuate", True, "bool", "groundskeeper",
       "DUTY 1: move stopped chats off an account that has run out of usage."),
    _k("groundskeeper.duty_archive", True, "bool", "groundskeeper",
       "DUTY 2: archive dormant chats whose own recap says done."),
    _k("groundskeeper.duty_name_stuck", True, "bool", "groundskeeper",
       "DUTY 3: report live chats stuck on a permission prompt nobody answered."),
    _k("groundskeeper.duty_rebalance", True, "bool", "groundskeeper",
       "DUTY 4: even out chat counts between open accounts."),
    _k("groundskeeper.duty_reap", True, "bool", "groundskeeper",
       "DUTY 5: stop engines that are idle and over the running cap, so other chats can run."),
    _k("groundskeeper.evacuate_per_run", None, "int_or_null", "groundskeeper",
       "Cap on evacuations per pass. null = uncapped (the owner's order: a chat on a burnt "
       "account can do nothing at all until the window resets).", min=1, max=200),
    _k("groundskeeper.rebalance_gap", 2, "int", "groundskeeper",
       "How many more chats the fullest account must hold than the thinnest before "
       "rebalancing starts.", min=1, max=50),
    _k("groundskeeper.rebalance_per_run", 5, "int", "groundskeeper",
       "Most chats one pass may move purely to even out the accounts. Each move re-imports "
       "the chat and boots an engine, so this is not free.", min=1, max=50),
    _k("groundskeeper.rebalance_cooldown_secs", 21600, "secs", "groundskeeper",
       "How long a chat that was just moved is left alone before it may be moved again.",
       min=300, max=604800),
    _k("groundskeeper.open_per_run", 1, "int", "groundskeeper",
       "Most closed accounts one pass may open, and only when every open one is past its "
       "target.", min=0, max=10),
    _k("groundskeeper.prompt_stall_secs", 600, "secs", "groundskeeper",
       "Shorter stall window for a chat whose mode is NOT bypassPermissions - its stall is "
       "the missing stamp, so it is named sooner.", min=60, max=7200),
    _k("groundskeeper.reap_idle_secs", 600, "secs", "groundskeeper",
       "How long an engine must be idle before the reaper may stop it.", min=120, max=86400),
    _k("groundskeeper.stale_hours", 12, "int", "groundskeeper",
       "How long a visible chat no lane can act on sits before it is named as stale.",
       min=1, max=336),

    # ---- USAGE BANDS -----------------------------------------------------------------
    _k("bands.soft_target_pct", 85, "pct", "bands",
       "Usage percentage at which an account stops taking NEW work. The courier refuses to "
       "deliver past it.", min=10, max=100),
    _k("bands.hard_gate_pct", 90, "pct", "bands",
       "Usage percentage at which an account takes nothing at all and its chats must leave.",
       min=10, max=100),
    _k("bands.fresh_hours", 48, "int", "bands",
       "How old a usage reading may be before the account is treated as unreadable rather "
       "than healthy.", min=1, max=336),
    _k("bands.max_running_chats", 18, "int", "bands",
       "How many chats the whole machine may have running at once. The floor saturate fills "
       "to and the ceiling the courier respects.", min=1, max=100),
    _k("bands.per_account_min", 2, "int", "bands",
       "Floor on one account's share of running chats, however many accounts are open.",
       min=1, max=50),
    _k("bands.per_account_max", 5, "int", "bands",
       "Ceiling on one account's share of running chats - the anti-hogging rule.",
       min=1, max=50),

    # ---- WAKING DORMANT CHATS --------------------------------------------------------
    _k("saturate.enabled", True, "bool", "saturate",
       "Wake dormant chats to keep the machine at its running floor."),
    _k("saturate.wake_prompt",
       "Proceed with your recommendations - continue the work you proposed at the end of your "
       "last turn. If something in it genuinely needs the owner (spend, live customers, public "
       "exposure, another person's lane), do the rest and name that one thing in your recap.",
       "str", "saturate",
       "The exact words sent to a chat being woken. The same for every chat, and never "
       "invented work - it tells the chat to continue what IT proposed."),
    _k("saturate.max_wakes", None, "int_or_null", "saturate",
       "Cap on wakes per pass. null = fill the whole deficit.", min=1, max=100),
    _k("saturate.recent_delivery_secs", 180, "secs", "saturate",
       "How long after a message a chat is left alone before another wake may be sent.",
       min=30, max=3600),

    # ---- PERMISSION PROMPTS ----------------------------------------------------------
    _k("unblock.enabled", True, "bool", "unblock",
       "Answer permission prompts that stopped a bypassPermissions chat that should never "
       "have seen one."),
    _k("unblock.max_presses", 6, "int", "unblock",
       "Most permission prompts one pass may answer. Each press flips the visible pane for a "
       "moment, so a big number is felt, not just spent.", min=1, max=50),
    _k("unblock.min_wait_secs", 240, "secs", "unblock",
       "How long a pending tool call must sit before it counts as a prompt rather than a "
       "command that is simply still running.", min=30, max=7200),
    _k("unblock.select_after_secs", 900, "secs", "unblock",
       "How long a chat waits before the sidebar row-selection retry is allowed (it flips "
       "the visible pane, so it is not free).", min=60, max=21600),
    _k("unblock.surface_after_failures", 3, "int", "unblock",
       "Consecutive failed presses on one chat before it is filed as an incident you see.",
       min=1, max=20),

    # ---- STALLED BACKGROUND WORK -----------------------------------------------------
    # stall_watch.py (owner, 2026-09-24: "just says to the chat, Hey, you've been stuck a while.
    # Are you stuck?"). New lane, so its defaults are its first values, not a moved constant.
    _k("stallwatch.enabled", True, "bool", "stallwatch",
       "Ask a chat whose turn has ended about background work it started that has gone silent "
       "(a sub-agent, workflow or command that never finished keeps the chat showing as busy)."),
    _k("stallwatch.silent_secs", 1200, "secs", "stallwatch",
       "How long a background sub-agent or workflow may write nothing before its chat is asked. "
       "Measured 2026-09-24 over 10,132 agents: healthy ones went quiet 0.6 min at the median, "
       "18.9 min at p99.", min=300, max=86400),
    _k("stallwatch.shell_secs", 3600, "secs", "stallwatch",
       "How long a background COMMAND may run before its chat is asked (a command's silence says "
       "nothing - it may write to its own log - so it is judged on age).", min=600, max=172800),
    _k("stallwatch.renudge_secs", 1800, "secs", "stallwatch",
       "Minimum gap before the same stalled task is asked about again.", min=300, max=86400),
    _k("stallwatch.max_nudges", 3, "int", "stallwatch",
       "Times one stalled task is asked about before it is filed as an incident for you and the "
       "chat is left alone.", min=1, max=20),
    _k("stallwatch.max_per_run", 5, "int", "stallwatch",
       "Most chats one pass may ask (each ask wakes a chat, which spends its account).",
       min=1, max=50),

    # ---- STANDING GOALS --------------------------------------------------------------
    # goal_watch.py: continue a chat whose tmp/handoff/GOAL.md is still IN PROGRESS, audit that
    # it moves, and wrap it up before its account's limit cuts it off. New lane, first values.
    _k("goalwatch.enabled", True, "bool", "goalwatch",
       "Re-prompt a chat whose turn has ended while its standing goal file still reads STATUS: "
       "IN PROGRESS, with the progress and completion audit rules."),
    _k("goalwatch.quiet_secs", 900, "secs", "goalwatch",
       "How long a chat's turn must have been over before its goal is continued, so a person "
       "reading or replying is not talked over.", min=120, max=86400),
    _k("goalwatch.renudge_secs", 1800, "secs", "goalwatch",
       "Minimum gap between two continuations of the same chat's goal.", min=300, max=86400),
    _k("goalwatch.max_unchanged", 3, "int", "goalwatch",
       "Continuations in a row that may leave the goal file byte-identical before the goal is "
       "filed as an incident for you and the chat is left alone.", min=1, max=20),
    _k("goalwatch.wrapup_pct", 80, "pct", "goalwatch",
       "Account usage at which a chat with an open goal is told to wrap up and leave the file "
       "resumable instead of being continued. Keep it below bands.soft_target_pct: past that "
       "the courier delivers nothing, so the wrap-up could never arrive.", min=10, max=100),
    _k("goalwatch.max_per_run", 3, "int", "goalwatch",
       "Most chats one pass may prompt (each prompt wakes a chat, which spends its account).",
       min=1, max=50),

    # ---- DELIVERING REPLIES ----------------------------------------------------------
    _k("courier.max_deliveries", 5, "int", "courier",
       "Most staged replies one pass may deliver.", min=1, max=50),
    _k("courier.confirm_secs", 150, "secs", "courier",
       "How long to watch for proof a delivered reply actually landed.", min=10, max=900),
    _k("courier.row_budget_secs", 420, "secs", "courier",
       "Most wall-clock time ONE staged reply may spend before the run gives up on it and moves "
       "to the next. Every step is bounded already; this bounds their sum, so one slow chat "
       "cannot eat a whole run's deadline and leave the other rows untried.",
       min=60, max=1800),

    # ---- THE JUDGMENT QUEUE ----------------------------------------------------------
    _k("interview.max_questions", 20, "int", "interview",
       "Most questions one judgment pass puts to the AI. The rest are counted and reported.",
       min=1, max=200),
    _k("interview.brain", None, "str_or_null", "interview",
       "A command that answers the judgment queue in place of the chat running the pass: a "
       "person's own trained brain, built from their own record. null (the default) keeps "
       "today's behaviour - the chat answers on the doctrine. When set, `interview --ask` names "
       "it on its first line and in its JSON, and the pass runs `<brain> ask` for the brief and "
       "`<brain> apply <file>`, which applies through `interview --apply` itself, so every rail "
       "still runs. A brain treats a pass as unattended unless `--by-hand` says its owner typed it."),
    _k("interview.evidence_chars", 900, "int", "interview",
       "Trailing characters of a chat's last words handed over with each question.",
       min=100, max=20000),

    # ---- THE STANDING MANAGER --------------------------------------------------------
    _k("overlord.enabled", True, "bool", "overlord",
       "The watchdog that wakes the standing manager chat when it goes quiet with work "
       "waiting, and relocates it off a cooked account."),
    _k("overlord.nudge_quiet_secs", 300, "secs", "overlord",
       "How long the manager chat may be idle before the watchdog wakes it.",
       min=60, max=7200),
    _k("overlord.long_run_secs", 1800, "secs", "overlord",
       "A turn still in flight past this is reported as a long-runner needing review.",
       min=300, max=86400),
    _k("overlord.rebirth_cooldown_secs", 1800, "secs", "overlord",
       "Minimum gap between manager rebirths, so a flapping session cannot spawn a crowd.",
       min=300, max=86400),

    # ---- SPEED -----------------------------------------------------------------------
    _k("perf.bulk_liveness", True, "bool", "perf",
       "Read which chats have a running engine in ONE call instead of one call per chat. "
       "This is 90% of every plan's time (measured 2026-09-17: 668ms per chat x 128 chats = "
       "86 of the dry loop's 132 seconds). OFF goes back to the slow per-chat read, which is "
       "the automatic fallback anyway whenever liveness cannot be established in full."),

    # ---- THE SCHEDULED LANES ---------------------------------------------------------
    # Every Windows scheduled task, on/off and how often. `jobs.*.every_minutes` writes the
    # /MO value the task is registered with; changing it needs a re-register
    # (`orch.py schedule_jobs --apply`), which the policy menu says out loud.
    # (generated below from JOB_LANES - one enabled/every_minutes pair per scheduled lane)
]

# ---- THE SCHEDULED LANES, generated ------------------------------------------------------
# One (enabled, every_minutes) pair per Windows scheduled task, with the cadence each was
# hardcoded with. Generated rather than typed out twice: eleven lanes x two knobs is twenty-two
# near-identical rows, and the one that gets a stale help string by hand is the one nobody
# reads carefully. `ungated` lanes ignore the tray switch by design - the help says so, because
# "why is this still running after I disarmed" is the question it otherwise produces.
JOB_LANES: list[tuple[str, int, bool, str]] = [
    ("dashboard", 5, True, "keep the read-only decision dashboard serving on 127.0.0.1:7799"),
    ("reconcile", 5, False, "re-check that past archives actually settled (it never retries one)"),
    ("chat_journal", 5, True, "journal every chat archived, moved or renamed - by ANY hand, "
                              "including yours, which is why it is not gated"),
    ("todo_sweep", 5, False, "sweep this machine's chats for to-do items and consolidate them"),
    ("saturate", 5, False, "wake dormant chats round-robin to hold the machine's running floor"),
    ("unblock", 5, False, "restart bypassPermissions chats stopped on a prompt they should "
                          "never have seen"),
    ("stall_watch", 5, False, "ask chats about background work they left hanging - the busy "
                              "dot that never clears"),
    ("goal_watch", 5, False, "continue chats whose standing goal is still IN PROGRESS, and tell "
                             "them to wrap up as their account nears its limit"),
    ("twins", 5, False, "find and settle duplicate chat records before one becomes unmanageable"),
    ("chips", 5, False, "start the desktop's Suggested-task chips locally through the app menu"),
    ("groundskeeper", 5, False, "the five duties: evacuate, archive, name the stuck, rebalance, "
                                "reap idle engines"),
    ("overlord", 5, False, "the standing-manager watchdog: wake it when it goes quiet with work "
                           "waiting, relocate it off a cooked account"),
    ("doctrine", 2, True, "re-stamp bypassPermissions + ultracode across every chat, because "
                          "conformance decays on its own under a running app"),
]

for _job, _every, _ungated, _what in JOB_LANES:
    _tail = (" This lane is UNGATED: it keeps running with the tray icon down, on purpose - it "
             "only observes or records." if _ungated else "")
    SPEC.append(_k(f"jobs.{_job}.enabled", True, "bool", "jobs",
                   f"Run the scheduled lane that will {_what}. OFF unregisters its Windows task "
                   f"on the next `orch.py schedule_jobs --apply`.{_tail}"))
    SPEC.append(_k(f"jobs.{_job}.every_minutes", _every, "int", "jobs",
                   f"How many minutes between runs of the lane that will {_what}. Changing this "
                   "needs one `orch.py schedule_jobs --apply` to re-register the task.",
                   min=1, max=1440))

BY_KEY = {row["key"]: row for row in SPEC}

GROUPS: list[tuple[str, str]] = [
    ("gate", "THE GATE - how the toolbox decides what state a chat is in"),
    ("gate.archive_signals", "THE FOUR ARCHIVE SIGNALS - all must agree before anything is filed"),
    ("archive", "ARCHIVING - filing finished chats away"),
    ("lanes", "THE SWEEP'S LANES - what one acting pass is allowed to do"),
    ("doctrine", "THE DOCTRINE STAMP - settings forced onto every chat"),
    ("groundskeeper", "THE GROUNDSKEEPER - the five duties that run every 5 minutes"),
    ("bands", "USAGE BANDS - when an account is too burnt to take work"),
    ("saturate", "WAKING - keeping the machine full"),
    ("unblock", "PERMISSION PROMPTS - answering the ones nobody is there to click"),
    ("stallwatch", "STALLED BACKGROUND WORK - asking a chat whether what it left running is stuck"),
    ("goalwatch", "STANDING GOALS - continuing a chat's GOAL.md, and auditing that it moves"),
    ("courier", "DELIVERY - sending staged replies"),
    ("interview", "THE JUDGMENT QUEUE - the part an AI answers"),
    ("overlord", "THE STANDING MANAGER - the watchdog that keeps the orchestrator alive"),
    ("perf", "SPEED - how the toolbox reads the fleet"),
    ("jobs", "THE SCHEDULED LANES - which background jobs run, and how often"),
]

# ⛔ THE RAILS - deliberately NOT configurable, and shown in the menu as such so their absence
# reads as a decision rather than an oversight. Each one is a reason the toolbox is allowed to
# act unattended at all; a switch for it would be a switch for losing work.
RAILS: list[tuple[str, str]] = [
    ("the live-writer rule",
     "a chat with a running engine is never archived or moved, by anything, ever"),
    ("the hold rail",
     "a chat you put on HOLD is skipped by every lane (the ONE flag that lifted it, on an "
     "AI's archive answer, is now the archive.ai_decision_uses_force knob above)"),
    ("the T-0 re-check",
     "every act re-reads the chat immediately before touching it and aborts if it moved"),
    ("post-act verification",
     "every act is re-read afterwards and reported as verified, or reported as failed"),
    ("the DENY list",
     "destructive pending commands (rm -rf, hard reset, credential paths) are never approved"),
    ("the tray-icon switch",
     "nothing unattended acts unless the icon is up - that is your kill switch"),
    ("the shared-cause breaker",
     "a lane stops after N same-cause failures (N is lanes.breaker_threshold; that it stops "
     "at all is not optional)"),
]

# Presets: a starting point, not a straitjacket. Each is a small overlay on the defaults.
PRESETS: dict[str, dict[str, Any]] = {
    "default": {},
    "observe-only": {
        # Everything still SEES and REPORTS; nothing acts on a chat. For a week of watching
        # what it would have done before letting it do any of it.
        "archive.enabled": False,
        "lanes.archive": False, "lanes.moves": False, "lanes.land_console": False,
        "lanes.deliver": False, "lanes.doctrine_pass": False, "lanes.naming_pass": False,
        "groundskeeper.duty_evacuate": False, "groundskeeper.duty_archive": False,
        "groundskeeper.duty_rebalance": False, "groundskeeper.duty_reap": False,
        "saturate.enabled": False, "unblock.enabled": False, "stallwatch.enabled": False,
        "goalwatch.enabled": False, "doctrine.ensure_allow_all": False,
    },
    "conservative": {
        # Acts, but slowly, and never files a chat it is not sure about.
        "archive.quiet_secs": 7200, "archive.per_run": 1,
        "archive.archive_anyway_after_grace": False,
        "lanes.max_per_lane": 2, "groundskeeper.rebalance_per_run": 2,
        "groundskeeper.duty_reap": False, "saturate.max_wakes": 3,
        "unblock.max_presses": 2, "doctrine.ensure_allow_all": False,
        "doctrine.stamp_held_chats": False,
    },
    "aggressive": {
        # The fleet kept full and tidy with the fewest human touches.
        "archive.quiet_secs": 1200, "archive.per_run": 8,
        "lanes.max_per_lane": 12, "groundskeeper.rebalance_per_run": 10,
        "unblock.max_presses": 12, "courier.max_deliveries": 10,
        "interview.max_questions": 40,
    },
}


# ---------------------------------------------------------------------------------------
# Load / validate / read
# ---------------------------------------------------------------------------------------
def defaults() -> dict[str, Any]:
    return {row["key"]: row["default"] for row in SPEC}


def _coerce(row: dict, value: Any) -> Any:
    """One value, checked against its own row. Raises ConfigError with the key named - a
    policy file is read by a person, so its errors have to be readable by one."""
    key, kind = row["key"], row["kind"]
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in ("true", "false", "on", "off", "yes", "no"):
            return value.lower() in ("true", "on", "yes")
        raise ConfigError(f"{key}: expected true/false, got {value!r}")
    if kind == "enum":
        if value in row["choices"]:
            return value
        raise ConfigError(f"{key}: expected one of {row['choices']}, got {value!r}")
    if kind == "str_or_null":
        if value is None or (isinstance(value, str) and value.strip().lower() in ("", "null", "none")):
            return None
        kind = "str"
    if kind == "str":
        if isinstance(value, str) and value.strip():
            return value
        raise ConfigError(f"{key}: expected a non-empty string, got {value!r}")
    if kind == "int_or_null":
        if value is None or (isinstance(value, str) and value.lower() in ("null", "none", "")):
            return None
        kind = "int"
    if kind in ("int", "secs", "pct"):
        # A JSON true is a bool, and int(True) is 1: without this a `true` typed into a count
        # became "1" and passed any knob whose minimum is 1. A fractional number is refused
        # too, rather than silently truncated.
        if isinstance(value, bool) or (isinstance(value, float) and not value.is_integer()):
            raise ConfigError(f"{key}: expected a whole number, got {value!r}")
        try:
            n = int(value)
        except (TypeError, ValueError):
            raise ConfigError(f"{key}: expected a whole number, got {value!r}") from None
        lo, hi = row.get("min"), row.get("max")
        if lo is not None and n < lo:
            raise ConfigError(f"{key}: {n} is below the safe minimum {lo}")
        if hi is not None and n > hi:
            raise ConfigError(f"{key}: {n} is above the safe maximum {hi}")
        return n
    raise ConfigError(f"{key}: unknown kind {kind!r} in the spec")


def read_file(path: Path | None = None) -> dict[str, Any]:
    """The raw overrides on disk, unmerged. Missing file = no overrides, which is the normal
    state of a fresh machine and never an error."""
    p = path or CONFIG_PATH
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ConfigError(f"{p} is not readable JSON: {err}") from None
    if not isinstance(raw, dict):
        raise ConfigError(f"{p}: expected a JSON object of key -> value")
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def validate(overrides: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Coerce every override. An unknown key is a PROBLEM, never silently dropped: it is a
    typo ("archive.enable": false reads as "archiving is off" to the person who wrote it, and
    changes nothing) or a key from a newer toolbox after a downgrade. Loading still works;
    unattended acting stops until it is removed (armlib.refuse_unless_armed)."""
    clean, problems = {}, []
    for key, value in overrides.items():
        row = BY_KEY.get(key)
        if row is None:
            problems.append(f"{key}: not a knob this toolbox has (a typo, or a newer toolbox's "
                            f"key) - `orch.py policy --unset {key}` removes it")
            continue
        try:
            clean[key] = _coerce(row, value)
        except ConfigError as err:
            problems.append(str(err))
    return clean, problems


_CACHE: dict[str, Any] | None = None
_PROBLEMS: list[str] = []


def load(force: bool = False) -> dict[str, Any]:
    """Defaults with the file's valid overrides applied. Cached per process on purpose: a
    lane that read the file twice in one pass could act on two different policies."""
    global _CACHE, _PROBLEMS
    if _CACHE is not None and not force:
        return _CACHE
    merged = defaults()
    try:
        clean, problems = validate(read_file())
    except ConfigError as err:
        clean, problems = {}, [str(err)]
    merged.update(clean)
    _CACHE, _PROBLEMS = merged, problems
    return merged


def problems() -> list[str]:
    """Everything wrong with the file on disk: unreadable JSON, a value that failed its check
    (and fell back to its default), an unknown key (and was ignored). Every one of them means
    the owner's written decision is not the one in force, so armlib.refuse_unless_armed stops
    unattended acting on ANY of them - a lane on a default could undo a switch he turned off."""
    load()
    return list(_PROBLEMS)


def get(key: str, fallback: Any = "__raise__") -> Any:
    """One value. An unknown key is a programming error and raises - the whole point of the
    spec is that every read is a declared knob."""
    conf = load()
    if key in conf:
        return conf[key]
    if fallback != "__raise__":
        return fallback
    raise ConfigError(f"{key}: not a knob in the spec (typo, or the spec is missing a row)")


def diff() -> dict[str, tuple[Any, Any]]:
    """key -> (default, current) for everything that is not at its default. Empty on a fresh
    machine, which is how you know installing the policy file changed nothing."""
    conf, dflt = load(), defaults()
    return {k: (dflt[k], conf[k]) for k in dflt if conf[k] != dflt[k]}


_GENERATED_NOTES = ("_README", "_docs")


@contextlib.contextmanager
def _policy_lock():
    """One writer at a time, across processes: two `policy --set` runs that each read the file
    and wrote it back used to drop one of the two changes and both report success (review,
    2026-09-17). ledgerlib's mutex, not a second copy of it; imported here because
    ledgerlib may one day read a knob, and configlib must stay importable from anywhere."""
    from lib import ledgerlib

    with ledgerlib.locked("policy"):
        yield


def _write_unlocked(overrides: dict[str, Any], path: Path | None) -> dict[str, Any]:
    clean, problems = validate(overrides)
    if problems:
        raise ConfigError("; ".join(problems))
    dflt = defaults()
    kept = {k: v for k, v in clean.items() if v != dflt[k]}
    p = path or CONFIG_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    # A note a person added by hand ("_why": ...) survives the rewrite; only the two generated
    # ones are regenerated. The file invites hand edits, so it must not eat them.
    notes: dict[str, Any] = {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        if isinstance(raw, dict):
            notes = {k: v for k, v in raw.items()
                     if k.startswith("_") and k not in _GENERATED_NOTES}
    except (OSError, json.JSONDecodeError):
        notes = {}
    body = {
        "_README": ("The orchestrator's policy. Every key here overrides a default in "
                    "scripts/lib/configlib.py; anything absent is at its default. Edit with "
                    "`python orch.py policy --wizard` (it explains every knob) or by hand - "
                    "a bad value is refused loudly at load, and nothing acts unattended "
                    "until the file reads clean."),
        "_docs": "python orch.py policy --list   |   python orch.py policy --explain <key>",
        **notes,
        **{k: kept[k] for k in sorted(kept)},
    }
    # ATOMIC, under a per-process temp name: a write cut off halfway leaves broken JSON, which
    # is a policy nobody can read, and a shared temp name lets two writers interleave into it
    # (stamplib learned that 2026-09-01). Write beside the file, then swap it in whole.
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, p)
    global _CACHE
    _CACHE = None
    return kept


def write(overrides: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    """Write the FULL override set, validated first. Values equal to the default are dropped,
    so the file only ever carries the owner's actual decisions and a later default change
    reaches a machine that never disagreed with it."""
    with _policy_lock():
        return _write_unlocked(overrides, path)


def set_many(pairs: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    """Apply changes ON TOP of what is already on disk (the menu edits one group at a time).
    The read and the write happen under one lock, so a concurrent change is never lost."""
    with _policy_lock():
        current = read_file(path)
        current.update(pairs)
        return _write_unlocked(current, path)


def unset_many(keys: list[str], path: Path | None = None) -> list[str]:
    """Put knobs back to their default. Returns the ones that were actually overridden."""
    with _policy_lock():
        current = read_file(path)
        gone = [k for k in keys if k in current]
        for k in keys:
            current.pop(k, None)
        _write_unlocked(current, path)
        return gone


def rows(group: str | None = None) -> list[dict]:
    """Spec rows, optionally one group, each with its live value attached."""
    conf = load()
    return [{**row, "value": conf[row["key"]]}
            for row in SPEC if group is None or row["group"] == group]
