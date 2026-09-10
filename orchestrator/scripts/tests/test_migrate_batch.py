"""The batch mover, and the two rails a batch made load-bearing.

WHY THESE TESTS EXIST. Three things changed on 2026-09-05 to stop 13 moves taking a quarter
of an hour, and each one is only safe because of a specific guarantee that nothing else in
the suite was checking:

  1. migrate_batch runs N moves in ONE process and ONE route-lock acquisition. The daemon's
     per-SCRIPT in-flight lock was, accidentally, the only thing stopping two moves off one
     account from driving that account's sidebar at the same time. A batch takes that lock
     once for all N, so the protection is gone unless the real per-window lock is taken where
     the window is actually driven.
  2. _settle_source now takes windowlib.instance_lock. A lock whose False is ignored is worse
     than no lock - it looks guarded and is not - so the refusal path is pinned here.
  3. The doctrine re-stamp polls instead of sleeping a flat 4s. The CEILING must not move: a
     stamp that never takes has to keep costing 4 seconds, not exit early and report success.

The batch's own contract is pinned too, and the sharpest edge is the one that reads as
success: a refused chat must never be counted as moved, and a dry run must never be reported
as a refusal.

⛔ THIS FILE IS unittest, AND NOT BY ACCIDENT (converted 2026-09-06). It was written in pytest
style - bare `test_*` functions, `monkeypatch`, `@pytest.mark.parametrize` - and the documented
runner is `python -m unittest discover`, which IMPORTS such a module and then collects zero
cases from it. So these 37 tests ran on the author's machine and nowhere else; the moment the
file became tracked, CI went red twice over - `ModuleNotFoundError: No module named 'pytest'`
on a runner that installs no python deps, and test_collection_guard naming this file as one
that yields no cases. See that guard's docstring: "there is no second runner to switch to on
purpose."

The conversion is deliberately STRUCTURAL ONLY. Every assertion below is the original one,
character for character, including the bare `assert` statements and their messages - rewriting
eighty of them into assertEqual is exactly where a conversion quietly weakens a test, and the
messages here already say what they mean. What changed is the scaffolding: `monkeypatch`
became `self.patch` (mock.patch.object plus addCleanup, so it undoes itself the same way),
fixtures became helper methods, and the one parametrize became a subTest loop that still names
the failing spelling.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import migrate_batch  # noqa: E402
import migrate_chat  # noqa: E402


# --- the batch driver ---------------------------------------------------------------------

def _payload(chat: str, landed: bool, code: int = 0, **extra) -> dict:
    return {"landed": landed, "title": chat, "to": "another_meh", "report": f"r:{chat}", **extra}


class _StubLanding:
    """Stands in for migrate_chat._Landing. The batch hands one back to the phase functions,
    and those are stubbed below - but the NAMING phase (2026-09-10) reads three real fields off
    it rather than going through a stubbed call, so the double carries them: a landing always
    knows its target account, its session id and the title the caller asked for."""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.target = {"name": payload.get("to") or "target"}
        # A real landing ALWAYS has a session id - it is what was moved - so the double must
        # too, or the naming phase silently skips every chat and the order test would pass by
        # testing nothing. Derived from the title when the fixture payload omits it.
        self.session_id = payload.get("sessionId") or f"sid-{payload.get('title') or ''}"
        self.chat_title = payload.get("title") or ""


def _run(argv: list[str]) -> tuple[int, dict]:
    buf = []

    class _Cap:
        def write(self, s): buf.append(s)
        def flush(self): pass

    with contextlib.redirect_stdout(_Cap()):
        code = migrate_batch.main([*argv, "--json"])
    return code, json.loads("".join(buf))


class _MigrateBatchTest(unittest.TestCase):
    """Shared scaffolding: a self-undoing patcher and the two former pytest fixtures.

    `self.patch` is monkeypatch.setattr's equivalent - mock.patch.object started immediately
    and stopped by addCleanup, so an attribute is restored even when the test raises, which is
    the property the fixtures relied on."""

    def patch(self, obj, name: str, value) -> None:
        patcher = mock.patch.object(obj, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def stub_phases(self, outcomes: dict | None = None,
                    raises: dict | None = None) -> list[list[str]]:
        """Replace migrate_chat's PHASE ONE with a scripted outcome, and stub the finishing
        phases.

        THE SEAM MOVED, AND THIS IS WHY. The batch used to shell every chat through
        migrate_chat.main() and read its printed JSON. It now runs the pipeline BY PHASE - move
        every chat, settle every chat, then stamp every chat (owner, 2026-09-06: "Move them all,
        archive them all, then set all the permissions") - so move_only() is what a batch test
        fakes.

        Phases two and three are stubbed to nothing on purpose. WHAT they do is migrate_chat's
        business and is pinned by migrate_chat's own tests; what belongs HERE is that the batch
        runs them for every landed chat and for no refused one.
        """
        calls: list[list[str]] = []
        outcomes = {} if outcomes is None else outcomes
        raises = raises or {}

        def fake_move_only(argv: list[str]):
            calls.append(list(argv))
            if argv[0] in raises:
                raise raises[argv[0]]
            payload, code = outcomes.get(argv[0], (_payload(argv[0], True), 0))
            if code == 0 and payload.get("landed"):
                return migrate_chat._MoveOutcome(landing=_StubLanding(dict(payload)))
            # A refusal or a dry-run plan: a finished payload with nothing left to do to it.
            return migrate_chat._MoveOutcome(payload=dict(payload), code=code)

        self.patch(migrate_chat, "move_only", fake_move_only)
        self.patch(migrate_chat, "phase_settle", lambda land: None)
        self.patch(migrate_chat, "phase_stamp", lambda land, watched=None: None)
        self.patch(migrate_chat, "landed_meta_path", lambda land: "")
        self.patch(migrate_chat, "watch_bypass_many", lambda paths, **k: {})
        self.patch(migrate_chat, "landing_payload", lambda land: dict(land.payload))
        # The naming phase drives a REAL app's rename on the owner's screen - stubbed, never
        # reached from a unit test. Its wiring is asserted in test_migrate_batch_resume.
        import name_chats
        self.patch(name_chats, "name_pass",
                   lambda instance, extra_titles=None, **k: {
                       "named": [], "needsJudgment": [], "flakes": [], "remaining": [], "why": ""})
        return calls

    def fake_move(self) -> tuple[list[list[str]], dict]:
        """Scripted per-chat outcomes for the batch, recording each chat's argv."""
        outcomes: dict[str, tuple[dict, int]] = {}
        return self.stub_phases(outcomes), outcomes


class BatchDriverTest(_MigrateBatchTest):
    def test_a_refused_chat_does_not_stop_the_batch_and_is_never_counted_as_moved(self):
        """The failure that would matter most: a partial batch reading as a success.

        Chat two is refused for a live engine. The other two must still move, the refusal must
        be named, and both `moved` and the exit code must say plainly that this was not a clean
        run.
        """
        calls, outcomes = self.fake_move()
        outcomes["two"] = (_payload("two", False, report="REFUSED: live engine"), 4)
        code, out = _run(["--chat", "one", "--chat", "two", "--chat", "three", "--to", "8"])

        assert [c[0] for c in calls] == ["one", "two", "three"], "a refusal must not abort the batch"
        assert out["moved"] == 2 and out["asked"] == 3 and out["refused"] == 1
        assert out["ok"] is False
        assert code == migrate_batch.EXIT_PARTIAL, "partial must not share an exit code with clean"
        assert "two" in out["report"] and "live engine" in out["report"]

    def test_every_chat_runs_the_real_per_chat_path_with_the_shared_flags(self):
        """Rails are per chat, not per batch: each move gets the whole single-move argv."""
        calls, _ = self.fake_move()
        _run(["--chat", "one", "--chat", "two", "--to", "8", "--now", "--stop-idle", "--force"])
        for argv in calls:
            assert "--now" in argv and "--stop-idle" in argv and "--force" in argv
            assert argv[argv.index("--to") + 1] == "8"
            # No --json: phase one HANDS BACK the payload now instead of printing one for the
            # batch to re-parse, so asking a child to serialise would be asking for nothing.
            assert "--json" not in argv

    def test_a_crash_in_one_chat_is_contained_and_reported(self):
        """One chat raising must not take the batch - and must never look like a landing."""
        calls = self.stub_phases(raises={"two": RuntimeError("actuator exploded")})
        code, out = _run(["--chat", "one", "--chat", "two", "--chat", "three", "--to", "8"])
        assert [c[0] for c in calls] == ["one", "two", "three"]
        assert out["moved"] == 2 and out["refused"] == 1
        assert code == migrate_batch.EXIT_PARTIAL
        assert any("RuntimeError" in r["report"] for r in out["results"] if not r["landed"])

    def test_a_chat_that_lands_and_then_crashes_in_a_later_phase_is_reported_landed(self):
        """THE REVIEW FINDING (2026-09-06): phases two and three only run on a chat that the
        read-back verify confirmed lives in the target account and that the ledger already
        records as moved. Reporting a later-phase crash as `landed: False` told the operator to
        "re-run" a move that had already happened, and graded a fully-landed batch as 2/3."""
        self.stub_phases()

        def boom(land, watched=None):
            if land.payload["title"] == "two":
                raise TimeoutError("picker never answered")

        self.patch(migrate_chat, "phase_stamp", boom)
        code, out = _run(["--chat", "one", "--chat", "two", "--chat", "three", "--to", "8"])
        two = next(r for r in out["results"] if r["chat"] == "two")
        assert two["landed"] is True, "it landed; a later crash cannot un-land it"
        assert two["ok"] is False and two["exitCode"] != 0
        assert "TimeoutError" in two["report"] and "NOT moved" not in two["report"]
        assert out["moved"] == 3 and out["refused"] == 0 and out["unfinished"] == 1
        assert out["ok"] is False and code == migrate_batch.EXIT_PARTIAL
        assert "LANDED but not finished" in out["report"]
        assert "was NOT moved" not in out["report"], "that trailer is for chats that did not land"

    def test_a_settle_crash_does_not_cost_that_chat_its_stamp(self):
        """The two tidy-ups are independent: a source row that would not settle is no reason to
        leave the landed chat on a prompting permission mode."""
        self.stub_phases()
        stamped: list[str] = []

        def settle(land):
            if land.payload["title"] == "two":
                raise OSError("store went away")

        self.patch(migrate_chat, "phase_settle", settle)
        self.patch(migrate_chat, "phase_stamp",
                   lambda land, watched=None: stamped.append(land.payload["title"]))
        code, out = _run(["--chat", "one", "--chat", "two", "--to", "8"])
        assert stamped == ["one", "two"], "a failed settle must not skip the mode stamp"
        two = next(r for r in out["results"] if r["chat"] == "two")
        assert two["landed"] is True and two["ok"] is False and "OSError" in two["report"]
        assert out["moved"] == 2 and code == migrate_batch.EXIT_PARTIAL

    def test_a_chat_s_secs_do_not_include_the_other_chats_stamping(self):
        """THE REVIEW'S TIMING FINDING: the batch stamps every chat and only then builds the
        payloads, so the wall clock between one chat's last phase and its payload is the OTHER
        chats' stamping. Charged to the chat, the first of thirteen looked two minutes slow with
        phases summing to eighteen seconds - and the per-chat numbers are exactly what get read
        when a migration is called slow."""
        clock = _FakeClock()
        self.patch(migrate_chat.time, "time", clock.time)
        sw = migrate_chat._Stopwatch()
        clock.now += 2.0
        sw.lap("stamp")            # this chat's own last phase: two seconds
        clock.now += 60.0          # twelve other chats being stamped
        land = migrate_chat._Landing(sw=sw, session_id="s", chat_title="t", src_instance="a",
                                     target={"name": "b", "num": 1}, result={}, notes={}, after=[])
        payload = migrate_chat.landing_payload(land)
        assert payload["timings"] == {"stamp": 2.0}
        assert payload["secs"] < 3.0, "sixty seconds of other chats' work were charged to this one"

    def test_the_phases_run_across_the_whole_batch_not_once_per_chat(self):
        """THE ORDER THE OWNER ASKED FOR (2026-09-06): "Move them all, archive them all, then set
        all the permissions." Not three chats each doing move-settle-stamp - three passes.

        The assertion that matters most is `watch:3`: ONE bypass watch for the whole batch. That
        watch is 8 seconds of waiting per chat when it is run per chat, and it is the single
        largest thing a batch used to spend its time on.
        """
        order: list[str] = []

        def fake_move_only(argv):
            order.append(f"move:{argv[0]}")
            return migrate_chat._MoveOutcome(landing=_StubLanding(_payload(argv[0], True)))

        self.patch(migrate_chat, "move_only", fake_move_only)
        self.patch(migrate_chat, "phase_settle",
                   lambda land: order.append(f"settle:{land.payload['title']}"))
        self.patch(migrate_chat, "phase_stamp",
                   lambda land, watched=None: order.append(f"stamp:{land.payload['title']}"))
        self.patch(migrate_chat, "landed_meta_path", lambda land: f"m:{land.payload['title']}")
        self.patch(migrate_chat, "watch_bypass_many",
                   lambda paths, **k: (order.append(f"watch:{len(paths)}"), {})[-1])
        self.patch(migrate_chat, "landing_payload", lambda land: dict(land.payload))
        import name_chats
        self.patch(name_chats, "name_pass",
                   lambda instance, extra_titles=None, **k: (
                       order.append(f"name:{len(extra_titles or {})}"),
                       {"named": [], "needsJudgment": [], "flakes": [], "remaining": [],
                        "why": ""})[-1])

        _run(["--chat", "one", "--chat", "two", "--chat", "three", "--to", "8"])
        # ⛔ NAMING SITS BETWEEN SETTLING AND STAMPING, ONCE FOR THE WHOLE BATCH (2026-09-10).
        # It must come BEFORE the stamp, because the permission picker aims by the chat's
        # rendered name and an import lands with none; and once, not per chat, because the pass
        # takes the target window's lock and walks that account's whole store either way.
        assert order == ["move:one", "move:two", "move:three",
                         "settle:one", "settle:two", "settle:three",
                         "name:3",
                         "watch:3",
                         "stamp:one", "stamp:two", "stamp:three"]

    def test_a_refused_chat_is_never_settled_or_stamped(self):
        """Deferring the finishing phases means they now run from a LIST, and a list is exactly
        where a refused chat gets carried along by accident. Settling the source row of a chat
        that never moved would archive it out of the account it still lives in."""
        self.stub_phases({"two": (_payload("two", False, report="REFUSED: live engine"), 4)})
        settled: list[str] = []
        stamped: list[str] = []
        # Record whatever arrives, INCLUDING a None landing: a recorder that reads land.payload
        # would raise on a refused chat and be swallowed by the batch's own crash guard, so the
        # test would pass while the phase was being called on nothing.
        name = lambda land: getattr(land, "payload", {}).get("title", "<not-a-landing>")
        self.patch(migrate_chat, "phase_settle", lambda land: settled.append(name(land)))
        self.patch(migrate_chat, "phase_stamp",
                   lambda land, watched=None: stamped.append(name(land)))
        code, out = _run(["--chat", "one", "--chat", "two", "--chat", "three", "--to", "8"])
        assert settled == ["one", "three"], "a chat that did not move must not be settled"
        assert stamped == ["one", "three"]
        assert out["moved"] == 2 and code == migrate_batch.EXIT_PARTIAL

    def test_each_chat_gets_its_own_verdict_out_of_the_shared_watch(self):
        """A SHARED watch returns a verdict PER RECORD, and handing chat two chat one's verdict
        would report a mode nobody observed on it - the precise class of unearned green the
        adjudicator exists to stop."""
        self.stub_phases()
        self.patch(migrate_chat, "landed_meta_path", lambda land: "m:" + land.payload["title"])
        self.patch(migrate_chat, "watch_bypass_many",
                   lambda paths, **k: {"m:one": {"mode": "bypassPermissions", "stable": True},
                                       "m:two": {"mode": "acceptEdits", "stable": False}})
        seen: dict = {}
        self.patch(migrate_chat, "phase_stamp",
                   lambda land, watched=None: seen.__setitem__(land.payload["title"], watched))
        _run(["--chat", "one", "--chat", "two", "--to", "8"])
        assert seen == {"one": {"mode": "bypassPermissions", "stable": True},
                        "two": {"mode": "acceptEdits", "stable": False}}

    def test_a_failed_shared_watch_falls_back_to_each_chat_watching_itself(self):
        """⛔ NEVER SILENTLY SKIP THE WATCH. If the shared watch raises, every chat must be handed
        None - which makes it watch its own record - and never a fabricated verdict."""
        self.stub_phases()

        def boom(paths, **k):
            raise OSError("store went away")

        self.patch(migrate_chat, "watch_bypass_many", boom)
        seen: dict = {}
        self.patch(migrate_chat, "phase_stamp",
                   lambda land, watched=None: seen.__setitem__(land.payload["title"], watched))
        code, out = _run(["--chat", "one", "--chat", "two", "--to", "8"])
        assert seen == {"one": None, "two": None}
        assert code == migrate_batch.EXIT_OK and out["moved"] == 2

    def test_a_dry_run_is_a_plan_not_a_refusal(self):
        """A dry run lands nothing BY DESIGN; grading it against landings reported 13 clean plans
        as 13 blocked chats, which is the same class of lie as calling a skipped step a pass."""
        _, outcomes = self.fake_move()
        for c in ("one", "two"):
            outcomes[c] = (_payload(c, False, dryRun=True, report=f"DRY RUN: would move {c}"), 0)
        code, out = _run(["--chat", "one", "--chat", "two", "--to", "8", "--dry-run"])
        assert code == migrate_batch.EXIT_OK and out["ok"] is True
        assert out["report"].startswith("DRY RUN:")
        assert "SKIP" not in out["report"]


class AllUnarchivedTest(_MigrateBatchTest):
    _FLEET = {"instances": [
        {"num": 27, "name": "anothuh1", "dir": "c:/x/anothuh1", "label": "Ada",
         "account": {"email": "holder@example.com"}},
        {"num": 15, "name": "work", "dir": "c:/x/work", "label": None,
         "account": {"email": "grace@example.com"}},
    ]}

    def two_accounts(self) -> list[list[str]]:
        self.patch(migrate_batch.hydralib, "fleet", lambda: self._FLEET)
        self.patch(
            migrate_batch.hydralib, "sessions",
            lambda period="7d", archived=None: [
                {"session_id": "aaa", "instance": "anothuh1", "archived": False,
                 "last_activity_at": 3},
                {"session_id": "ddd", "instance": "work", "archived": False,
                 "last_activity_at": 2},
            ],
        )
        return self.stub_phases()

    def test_all_unarchived_takes_only_movable_chats_and_resolves_them_by_session_id(self):
        """--all-unarchived must ask for the CENSUS (period=all, archived=include) and then
        filter locally; the windowed default hid six unarchived chats the day it was measured.
        It must also hand migrate_chat SESSION IDS, never titles: two accounts can share a
        title."""
        asked: dict = {}

        def fake_sessions(period="7d", archived=None):
            asked.update(period=period, archived=archived)
            return [
                {"session_id": "aaa", "instance": "pap3r", "archived": False,
                 "last_activity_at": 30},
                {"session_id": "bbb", "instance": "pap3r", "archived": True,
                 "last_activity_at": 40},
                {"session_id": "ccc", "instance": "", "archived": False, "last_activity_at": 50},
                {"session_id": "ddd", "instance": "anutha", "archived": False,
                 "last_activity_at": 20},
            ]

        self.patch(migrate_batch.hydralib, "sessions", fake_sessions)
        calls = self.stub_phases()
        _run(["--all-unarchived", "--to", "8"])

        assert asked == {"period": "all", "archived": "include"}, "an enumerator must ask for all"
        moved = [c[0] for c in calls]
        assert moved == ["aaa", "ddd"], "archived and non-desktop rows are not movable"
        assert "bbb" not in moved and "ccc" not in moved

    def test_from_scopes_all_unarchived_to_one_account(self):
        self.patch(
            migrate_batch.hydralib, "fleet",
            lambda: {"instances": [{"num": 1, "name": "pap3r", "dir": "c:/x/pap3r"},
                                   {"num": 2, "name": "anutha", "dir": "c:/x/anutha"}]},
        )
        self.patch(
            migrate_batch.hydralib, "sessions",
            lambda period="7d", archived=None: [
                {"session_id": "aaa", "instance": "pap3r", "archived": False,
                 "last_activity_at": 3},
                {"session_id": "ddd", "instance": "anutha", "archived": False,
                 "last_activity_at": 2},
            ],
        )
        calls = self.stub_phases()
        _run(["--all-unarchived", "--from", "pap3r", "--to", "8"])
        assert [c[0] for c in calls] == ["aaa"]

    def test_from_scopes_all_unarchived_however_the_account_is_spelled(self):
        """THE REGRESSION: --from arrives as a NUMBER from the MCP, but a session row carries
        only the instance FOLDER name, so the raw comparison matched nothing and the batch
        reported "nothing to move" over a full account. The old test only ever passed a folder
        name, which is the one spelling that happened to work, so it could not see this. Every
        spelling resolve_instance accepts must scope the same way.

        A subTest per spelling, so one bad spelling names itself and the others still run -
        which is what the parametrize this replaced was for."""
        for spelling in ["27", "#27", "anothuh1", "ANOTHUH1", "Ada", "holder@example.com"]:
            with self.subTest(spelling=spelling):
                # Each spelling gets its own stubs, since addCleanup only fires between TESTS.
                with mock.patch.object(migrate_batch.hydralib, "fleet", lambda: self._FLEET), \
                     mock.patch.object(
                         migrate_batch.hydralib, "sessions",
                         lambda period="7d", archived=None: [
                             {"session_id": "aaa", "instance": "anothuh1", "archived": False,
                              "last_activity_at": 3},
                             {"session_id": "ddd", "instance": "work", "archived": False,
                              "last_activity_at": 2},
                         ]):
                    calls = self.stub_phases()
                    _run(["--all-unarchived", "--from", spelling, "--to", "15"])
                    assert [c[0] for c in calls] == ["aaa"], \
                        f"--from {spelling!r} did not scope to anothuh1"

    def test_an_unknown_from_is_refused_rather_than_reported_as_an_empty_account(self):
        """"No such account" and "that account is clean" must never be the same answer: one of
        them leaves the chats sitting there while the caller believes the job is done."""
        calls = self.two_accounts()
        code, out = _run(["--all-unarchived", "--from", "nobody", "--to", "15"])
        assert code == migrate_batch.EXIT_REFUSED, "an unknown --from is a deterministic refusal"
        assert code != migrate_batch.EXIT_NONE
        assert "names no instance" in out["report"] and "anothuh1" in out["report"]
        assert calls == [], "nothing may move when the source could not be resolved"

    def test_the_note_names_the_resolved_account_not_the_number_typed(self):
        self.two_accounts()
        _, out = _run(["--all-unarchived", "--from", "27", "--to", "15"])
        assert "on anothuh1" in out["report"]

    def test_a_resolved_but_empty_account_says_so_instead_of_reading_as_a_usage_error(self):
        """"0 unarchived desktop chat(s) on anothuh1" is an ANSWER; "name chats with --chat" is a
        complaint that the caller did the thing it just did."""
        self.patch(migrate_batch.hydralib, "fleet", lambda: self._FLEET)
        self.patch(migrate_batch.hydralib, "sessions", lambda period="7d", archived=None: [])
        code, out = _run(["--all-unarchived", "--from", "27", "--to", "15"])
        assert code == migrate_batch.EXIT_NONE
        assert "0 unarchived desktop chat(s) on anothuh1" in out["report"]
        assert "--chat" not in out["report"]

    def test_limit_takes_the_most_recent_and_says_so(self):
        self.patch(
            migrate_batch.hydralib, "sessions",
            lambda period="7d", archived=None: [
                {"session_id": "old", "instance": "p", "archived": False, "last_activity_at": 1},
                {"session_id": "new", "instance": "p", "archived": False, "last_activity_at": 9},
            ],
        )
        calls = self.stub_phases()
        _, out = _run(["--all-unarchived", "--limit", "1", "--to", "8"])
        assert [c[0] for c in calls] == ["new"]
        assert "taking the 1 most recent" in out["report"]

    def test_naming_nothing_is_refused_rather_than_silently_moving_everything(self):
        code, out = _run(["--to", "8"])
        assert code == migrate_batch.EXIT_NONE and out["moved"] == 0

    def test_one_new_title_cannot_be_right_for_several_chats(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = migrate_batch.main(["--chat", "a", "--chat", "b", "--title", "One name"])
        assert code == 2


# --- the naming door restates the DAEMON'S title, never the record's -----------------------

class NamingDoorTest(_MigrateBatchTest):
    def test_the_door_title_is_the_daemon_s_row_title_when_the_two_differ(self):
        """'D drive cleanup' (2026-09-06): renamed in the app, but the daemon's index row still
        carried the chat's first message. The door compares confirm_title against the ROW, so
        restating the record's title was refused twice - the second time through the breaker."""
        self.patch(migrate_chat.hydralib, "session_row",
                   lambda sid: {"session_id": sid, "title": "D:\\.SystemFiles first message"})
        assert migrate_chat._untruncated_title("sid", "D drive cleanup") == "D:\\.SystemFiles first message"

    def test_the_door_title_degrades_to_the_record_when_the_row_cannot_help(self):
        self.patch(migrate_chat.hydralib, "session_row", lambda sid: None)
        assert migrate_chat._untruncated_title("sid", "Shown title") == "Shown title"
        self.patch(migrate_chat.hydralib, "session_row", lambda sid: {"title": "Long title…"})
        assert migrate_chat._untruncated_title("sid", "Long title…") == "Long title…"

        def down(sid):
            raise migrate_chat.hydralib.DaemonError("/x", None, "down")

        self.patch(migrate_chat.hydralib, "session_row", down)
        assert migrate_chat._untruncated_title("sid", "Shown title") == "Shown title"


# --- the source-app window lock (the rail the batch made load-bearing) ---------------------

class _Lock:
    """Records what was locked and yields a scripted answer."""

    def __init__(self, grant: bool):
        self.grant, self.asked = grant, []

    @contextlib.contextmanager
    def __call__(self, instance, wait_secs=90.0):
        self.asked.append(instance)
        yield self.grant


class SourceWindowLockTest(_MigrateBatchTest):
    def test_settling_the_source_row_takes_that_window_s_lock(self):
        """Every other Electron-window driver goes through instance_lock; this one did not, and
        the daemon's global route lock was silently standing in for it."""
        lock = _Lock(True)
        self.patch(migrate_chat.windowlib, "instance_lock", lock)
        self.patch(
            migrate_chat.clilib, "run_text",
            lambda *a, **k: type("R", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
        )
        code, _ = migrate_chat._settle_source("pap3r rotate", "Some chat")
        assert code == 0
        assert lock.asked == ["pap3r rotate"], "the SOURCE window is the one being driven"

    def test_a_lock_we_did_not_get_means_we_do_not_drive_the_window(self):
        """⛔ THE POINT OF THE WHOLE TEST FILE. instance_lock yields False after its wait; a
        caller that ignores that drives the window unlocked while looking locked - two moves off
        one account would both 'hold' it. The actuator must not run at all, and the caller must
        hear a code that sends it to the disk-flag fallback rather than claiming a settle."""
        lock = _Lock(False)
        self.patch(migrate_chat.windowlib, "instance_lock", lock)
        ran = []
        self.patch(migrate_chat.clilib, "run_text", lambda *a, **k: ran.append(a))
        code, out = migrate_chat._settle_source("pap3r rotate", "Some chat")
        assert ran == [], "the window must not be driven without its lock"
        assert code not in (0, 3), "0 and 3 both mean 'the screen agrees' - this one does not"
        assert "another lane" in out


# --- the doctrine re-stamp poll (same ceiling, less waiting) -------------------------------

class _FakeClock:
    """A clock the poll loop cannot outrun in real time: sleep() advances it, time() reads it.

    Patching only time.sleep leaves the deadline on the real clock, so a never-succeeding
    re-stamp would spin thousands of times over four real seconds. Both halves move together
    here, which is also the only way to assert on how long the loop WOULD have waited.
    """

    def __init__(self):
        self.now, self.slept = 1000.0, []

    def sleep(self, secs):
        self.slept.append(secs)
        self.now += secs

    def time(self):
        return self.now

    @property
    def total(self):
        return sum(self.slept)


def _run_stamp():
    """`after` must carry the landed row's INSTANCE - that is how the metaPath is found."""
    return migrate_chat._stamp_automation_doctrine(
        "sid", {"name": "t", "isRunning": True},
        [{"cliSessionId": "sid", "instance": "t", "metaPath": "m"}], {})


class DoctrineRestampTest(_MigrateBatchTest):
    def stamp_deps(self, clock, *, watched, verdict) -> None:
        self.patch(migrate_chat.time, "sleep", clock.sleep)
        self.patch(migrate_chat.time, "time", clock.time)
        self.patch(migrate_chat, "watch_bypass", lambda *a, **k: watched)
        self.patch(migrate_chat.hydralib, "api_post", lambda *a, **k: {"ok": True})
        self.patch(migrate_chat, "_adjudicate_bypass", lambda *a, **k: verdict)

    def test_the_restamp_stops_as_soon_as_both_halves_take(self):
        """The win: stop burning the ceiling when the app settled in a few hundred
        milliseconds."""
        calls = {"n": 0}

        def stamp(_path):
            calls["n"] += 1
            ok = calls["n"] >= 2
            return {"bypass": ok, "ultracode": ok, "error": ""}

        clock = _FakeClock()
        self.patch(migrate_chat.stamplib, "stamp_doctrine", stamp)
        self.stamp_deps(clock,
                        watched={"mode": "bypassPermissions", "flips": 0, "stable": True},
                        verdict=("app-confirmed", "picker agreed", ""))
        got = _run_stamp()
        assert got["ultracode"] is True
        assert clock.total <= migrate_chat.DOCTRINE_RESTAMP_SECS, "the ceiling is a ceiling"
        assert clock.total < 4.0, "and it must not still be paying the old flat sleep(4)"

    def test_a_stamp_that_never_takes_still_costs_the_full_ceiling(self):
        """The ceiling did NOT move. A re-stamp that keeps failing must keep retrying for the
        same 4 seconds it always did - an early exit here would report an unstamped chat as
        done."""
        clock = _FakeClock()
        self.patch(migrate_chat.stamplib, "stamp_doctrine",
                   lambda _p: {"bypass": False, "ultracode": False, "error": "nope"})
        self.stamp_deps(clock,
                        watched={"mode": None, "flips": 0, "stable": False},
                        verdict=("unknown", "unreadable", "fix it"))
        got = _run_stamp()
        assert got["ultracode"] is False
        assert clock.total >= migrate_chat.DOCTRINE_RESTAMP_SECS, "the 4s ceiling must still be paid"


if __name__ == "__main__":
    unittest.main()
