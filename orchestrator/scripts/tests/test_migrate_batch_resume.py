"""migrate_batch --resume and --terminate-live: the two flags that turn a move into a drain.

WHY THESE EXIST (2026-09-06). Moving seven chats off two accounts that were about to hit
their limits took ~25 round trips, and the moves themselves were four of them. The rest was:
finding that landed chats sit DORMANT until someone types into them, discovering the
stage_reply -> courier path, staging six replies by shell loop, parsing delivery ids out of
JSON, and running the courier six times; then, for the two chats that were still working,
reading their pids out of a dry run, verifying them by hand, taskkill, and moving again.

Both are now phases of the batch. What is pinned here is the CONTRACT, not the mechanics
(migrate_chat and courier own those, and their own tests pin them):

  - --resume stages exactly one reply per LANDED chat, none for a refused one, delivers them
    through the courier's hand-run path, and each chat's result says whether its reply
    landed - a moved chat that was not told to carry on must never read as "done".
  - --terminate-live kills the engine ONLY for an engine refusal (code 4), never for a hold
    or the breaker, and never without confirmation; an unconfirmed kill leaves the refusal.
  - Neither flag reaches a per-chat move's argv.

Scaffolding mirrors test_migrate_batch's (a self-undoing patcher over move_only and the
finishing phases) rather than importing it, so this file does not couple to edits in flight
there.
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

import courier  # noqa: E402
import migrate_batch  # noqa: E402
import migrate_chat  # noqa: E402
import stage_reply  # noqa: E402


def _landed(chat: str, **extra) -> dict:
    return {"landed": True, "title": chat, "sessionId": f"sid-{chat}", "to": "blaarrrggghhh",
            "report": f"landed:{chat}", **extra}


def _refused(chat: str, report: str) -> dict:
    return {"landed": False, "title": chat, "sessionId": f"sid-{chat}", "report": report}


class _StubLanding:
    def __init__(self, payload: dict) -> None:
        self.payload = payload


def _run(argv: list[str]) -> tuple[int, dict]:
    buf: list[str] = []

    class _Cap:
        def write(self, s):
            buf.append(s)

        def flush(self):
            pass

    with contextlib.redirect_stdout(_Cap()):
        code = migrate_batch.main([*argv, "--json"])
    return code, json.loads("".join(buf))


class _BatchTest(unittest.TestCase):
    def patch(self, obj, name: str, value) -> None:
        patcher = mock.patch.object(obj, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def stub_phases(self, script: dict[str, list[tuple[dict, int]]]) -> list[list[str]]:
        """`script` maps a chat to the outcomes of its SUCCESSIVE move_only calls, so a
        chat can be refused first and land second (the terminate-then-retry shape)."""
        calls: list[list[str]] = []
        remaining = {k: list(v) for k, v in script.items()}

        def fake_move_only(argv: list[str]):
            calls.append(list(argv))
            queue = remaining.get(argv[0])
            payload, code = queue.pop(0) if queue else (_landed(argv[0]), 0)
            if code == 0 and payload.get("landed"):
                return migrate_chat._MoveOutcome(landing=_StubLanding(dict(payload)))
            return migrate_chat._MoveOutcome(payload=dict(payload), code=code)

        self.patch(migrate_chat, "move_only", fake_move_only)
        self.patch(migrate_chat, "phase_settle", lambda land: None)
        self.patch(migrate_chat, "phase_stamp", lambda land, watched=None: None)
        self.patch(migrate_chat, "landed_meta_path", lambda land: "")
        self.patch(migrate_chat, "watch_bypass_many", lambda paths, **k: {})
        self.patch(migrate_chat, "landing_payload", lambda land: dict(land.payload))
        return calls


class ResumeTest(_BatchTest):
    def stub_resume(self, courier_results: dict[str, tuple[bool, str]]):
        """Stage records what was staged; courier.run records how it was called and answers
        per delivery id: (ok, why) - ok False with a why is a SKIP (the row stays staged)."""
        staged: list[dict] = []
        courier_calls: list[dict] = []

        def fake_stage(sid, text, **kw):
            entry = {"id": f"d-{sid}", "session": sid, "text": text, **kw}
            staged.append(entry)
            return entry

        def fake_run(max_deliveries, only, act, running_now=None, cap_exempt=False,
                     hand_run=False):
            courier_calls.append({"max": max_deliveries, "only": set(only), "act": act,
                                  "hand_run": hand_run})
            results, skipped = [], []
            for did in sorted(only):
                ok, why = courier_results.get(did, (True, "delivered"))
                if ok:
                    results.append({"id": did, "ok": True, "outcome": why, "detail": ""})
                else:
                    skipped.append({"id": did, "title": did, "why": why})
            return {"planned": [], "skipped": skipped, "results": results, "staged": len(only)}

        self.patch(migrate_batch.hydralib, "resolve_one",
                   lambda q: {"cliSessionId": q, "title": q, "instance": "blaarrrggghhh"})
        self.patch(stage_reply, "gather_evidence", lambda match, sid: "the chat's own last words")
        self.patch(migrate_batch.deliverylib, "stage", fake_stage)
        self.patch(courier, "run", fake_run)
        return staged, courier_calls

    def test_one_reply_per_landed_chat_delivered_by_hand_and_each_result_says_so(self):
        calls = self.stub_phases({"three": [(_refused("three", "REFUSED: live engine"), 4)]})
        staged, courier_calls = self.stub_resume({"d-sid-two": (False, "its turn is IN FLIGHT")})
        code, out = _run(["--chat", "one", "--chat", "two", "--chat", "three", "--to", "55",
                          "--resume", "carry on where you left off"])

        # Staged for the two that landed, with the batch's own author tag; never for the refusal.
        self.assertEqual([s["session"] for s in staged], ["sid-one", "sid-two"])
        self.assertTrue(all(s["by"] == "migrate-resume" for s in staged))
        self.assertTrue(all(s["text"] == "carry on where you left off" for s in staged))
        # ONE courier run, by hand, naming exactly those rows - not the whole queue.
        self.assertEqual(len(courier_calls), 1)
        self.assertEqual(courier_calls[0]["only"], {"d-sid-one", "d-sid-two"})
        self.assertTrue(courier_calls[0]["act"] and courier_calls[0]["hand_run"])
        self.assertGreaterEqual(courier_calls[0]["max"], 2)

        by_chat = {r["chat"]: r for r in out["results"]}
        self.assertTrue(by_chat["one"]["resume"]["delivered"])
        two = by_chat["two"]["resume"]
        self.assertFalse(two["delivered"])
        self.assertIn("IN FLIGHT", two["why"])
        self.assertIn("courier --yes --only d-sid-two", two["retry"],
                      "a staged-not-delivered reply must name its own retry")
        self.assertNotIn("resume", by_chat["three"], "a refused chat has nothing to resume")
        self.assertEqual(out["resume"], {"asked": 2, "delivered": 1, "staged": 1})
        self.assertIn("RESUME", out["report"])
        # The move verdict is unchanged by the resume phase: partial because three refused.
        self.assertEqual(code, migrate_batch.EXIT_PARTIAL)
        for argv in calls:
            self.assertNotIn("--resume", argv, "--resume is the batch's flag, not the move's")

    def test_no_resume_flag_means_no_staging_and_no_courier(self):
        self.stub_phases({})
        staged, courier_calls = self.stub_resume({})
        _, out = _run(["--chat", "one", "--to", "55"])
        self.assertEqual(staged, [])
        self.assertEqual(courier_calls, [])
        self.assertNotIn("resume", out)

    def test_a_staging_failure_is_named_on_that_chat_and_the_others_still_go(self):
        self.stub_phases({})
        staged, courier_calls = self.stub_resume({})

        def flaky_resolve(q):
            if q == "sid-one":
                raise migrate_batch.hydralib.ChatNotFound("gone")
            return {"cliSessionId": q, "title": q, "instance": "blaarrrggghhh"}

        self.patch(migrate_batch.hydralib, "resolve_one", flaky_resolve)
        _, out = _run(["--chat", "one", "--chat", "two", "--to", "55", "--resume", "go"])
        by_chat = {r["chat"]: r for r in out["results"]}
        self.assertFalse(by_chat["one"]["resume"]["staged"])
        self.assertIn("ChatNotFound", by_chat["one"]["resume"]["why"])
        self.assertTrue(by_chat["two"]["resume"]["delivered"])
        self.assertEqual(courier_calls[0]["only"], {"d-sid-two"})


class TerminateLiveTest(_BatchTest):
    def stub_engine(self, live_pid: int | None, stopped: bool):
        terminated: list[dict] = []
        notes: list[str] = []

        def fake_terminate(match):
            terminated.append(match)
            return {"stopped": stopped, "pid": live_pid,
                    "why": "terminated" if stopped else "taskkill was issued but still live"}

        self.patch(migrate_batch.hydralib, "resolve_one",
                   lambda q: {"cliSessionId": q, "title": q, "instance": "another_meh",
                              "live": ({"pid": live_pid, "name": "x"} if live_pid else None)})
        self.patch(migrate_batch.enginelib, "terminate_engine", fake_terminate)
        def fake_note(kind, sid, **kw):
            # Validate the kind exactly as the real note() does. A stub that accepted any
            # string is why --terminate-live shipped writing an UNREGISTERED kind: this test
            # was green for the whole life of a feature that raised on its first real call.
            if kind not in migrate_batch.ledgerlib.VALID_KINDS:
                raise ValueError(f"unknown breaker kind {kind!r} - new acts must opt in deliberately")
            notes.append(f"{kind}:{sid}:{kw.get('note', '')}")

        self.patch(migrate_batch.ledgerlib, "note", fake_note)
        return terminated, notes

    def test_an_engine_refusal_is_killed_confirmed_and_moved_on_the_second_try(self):
        calls = self.stub_phases({"two": [(_refused("two", "REFUSED: live engine, working"), 4),
                                          (_landed("two"), 0)]})
        terminated, notes = self.stub_engine(live_pid=4242, stopped=True)
        code, out = _run(["--chat", "one", "--chat", "two", "--to", "55", "--terminate-live"])

        self.assertEqual([c[0] for c in calls], ["one", "two", "two"], "kill, then move again")
        self.assertEqual([t["live"]["pid"] for t in terminated], [4242])
        two = next(r for r in out["results"] if r["chat"] == "two")
        self.assertTrue(two["landed"])
        self.assertEqual(two["terminated"]["pid"], 4242)
        self.assertTrue(two["terminated"]["stopped"])
        self.assertTrue(any(n.startswith("terminate:two") for n in notes), "the kill is on the ledger")
        self.assertIn("TERMINATED", out["report"])
        self.assertEqual(code, migrate_batch.EXIT_OK)
        for argv in calls:
            self.assertNotIn("--terminate-live", argv)

    def test_a_hold_or_breaker_refusal_is_never_killed(self):
        for code_, what in ((6, "REFUSED: HELD by a person"), (5, "SUPPRESSED by the breaker")):
            with self.subTest(code=code_):
                calls = self.stub_phases({"two": [(_refused("two", what), code_)]})
                terminated, _ = self.stub_engine(live_pid=4242, stopped=True)
                _, out = _run(["--chat", "two", "--to", "55", "--terminate-live"])
                self.assertEqual(terminated, [], f"a code-{code_} refusal is not an engine refusal")
                self.assertEqual(len(calls), 1)
                self.assertFalse(out["results"][0]["landed"])

    def test_an_unconfirmed_kill_leaves_the_refusal_and_says_why(self):
        calls = self.stub_phases({"two": [(_refused("two", "REFUSED: live engine"), 4)]})
        terminated, _ = self.stub_engine(live_pid=4242, stopped=False)
        _, out = _run(["--chat", "two", "--to", "55", "--terminate-live"])
        self.assertEqual(len(terminated), 1)
        self.assertEqual(len(calls), 1, "no second move on an unconfirmed stop")
        row = out["results"][0]
        self.assertFalse(row["landed"])
        self.assertFalse(row["terminated"]["stopped"])
        self.assertIn("still live", row["terminated"]["why"])

    def test_without_the_flag_an_engine_refusal_is_left_alone(self):
        calls = self.stub_phases({"two": [(_refused("two", "REFUSED: live engine"), 4)]})
        terminated, _ = self.stub_engine(live_pid=4242, stopped=True)
        _, out = _run(["--chat", "two", "--to", "55"])
        self.assertEqual(terminated, [])
        self.assertEqual(len(calls), 1)
        self.assertNotIn("terminated", out["results"][0])

    def test_no_live_engine_on_re_read_means_nothing_to_kill(self):
        """The refusal was about an engine that has since gone: re-read, find nothing, and
        the honest answer is the original refusal plus 'no live engine to terminate'."""
        calls = self.stub_phases({"two": [(_refused("two", "REFUSED: live engine"), 4)]})
        terminated, _ = self.stub_engine(live_pid=None, stopped=True)
        _, out = _run(["--chat", "two", "--to", "55", "--terminate-live"])
        self.assertEqual(terminated, [])
        self.assertEqual(len(calls), 1)
        self.assertIn("no live engine", out["results"][0]["terminated"]["why"])


if __name__ == "__main__":
    unittest.main()
