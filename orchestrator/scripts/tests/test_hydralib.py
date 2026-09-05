"""hydralib: transport honesty and chat resolution refusals."""

import json
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

from lib import hydralib  # noqa: E402


class HydralibTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url

    def tearDown(self):
        self.stub.close()

    def test_http_error_raises_daemon_error_with_status(self):
        self.stub.routes["/api/health"] = (500, {"error": "boom"})
        with self.assertRaises(hydralib.DaemonError) as ctx:
            hydralib.health()
        self.assertEqual(ctx.exception.status, 500)

    def test_unreachable_daemon_raises_not_returns_empty(self):
        hydralib.BASE = "http://127.0.0.1:9"  # discard port - nothing listens
        old = hydralib.TIMEOUT_SECS
        hydralib.TIMEOUT_SECS = 0.3
        try:
            with self.assertRaises(hydralib.DaemonError):
                hydralib.sessions()
        finally:
            hydralib.TIMEOUT_SECS = old

    def test_non_json_response_is_a_daemon_error(self):
        self.stub.routes["/api/health"] = b"<html>a proxy error page</html>"
        with self.assertRaises(hydralib.DaemonError) as ctx:
            hydralib.health()
        self.assertIn("non-JSON", ctx.exception.detail)

    def test_a_registered_stub_answers_in_process_and_opens_no_socket(self):
        # The suite must not spend one ephemeral port per call (2026-09-05: the pool ran dry under
        # load and a random test read the daemon as down). With the stub registered, the wire
        # transport is never reached - here it would fail loudly if it were.
        self.stub.routes["/api/health"] = {"ok": True, "via": "inproc"}
        with mock.patch.object(hydralib.urllib.request, "urlopen",
                               side_effect=AssertionError("a socket was opened")):
            self.assertEqual(hydralib.health(), {"ok": True, "via": "inproc"})
            self.stub.routes["/api/nothing"] = (404, {"error": "nope"})
            with self.assertRaises(hydralib.DaemonError) as ctx:
                hydralib.api_get("/api/nothing?x=1")
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn(("/api/health", ""), self.stub.gets)
        self.assertIn(("/api/nothing", "x=1"), self.stub.gets)

    def test_a_base_with_no_stub_registered_takes_the_wire(self):
        # A test that points BASE at a dead port must still get a real connection failure, not
        # some other stub's answer.
        self.stub.routes["/api/health"] = {"ok": True}
        hydralib.BASE = "http://127.0.0.1:9"
        old = hydralib.TIMEOUT_SECS
        hydralib.TIMEOUT_SECS = 0.3
        try:
            with self.assertRaises(hydralib.DaemonError) as ctx:
                hydralib.health()
        finally:
            hydralib.TIMEOUT_SECS = old
        self.assertIsNone(ctx.exception.status)
        self.assertEqual(self.stub.gets, [])

    def test_the_stub_still_speaks_http_for_a_caller_that_is_not_hydralib(self):
        # a subprocess handed AGENTHYDRA_URL, or a test using urllib itself, gets the same answers
        import urllib.error
        import urllib.request

        self.stub.routes["/api/health"] = {"ok": True, "via": "http"}
        with urllib.request.urlopen(f"{self.stub.url}/api/health", timeout=5) as r:
            self.assertEqual(json.loads(r.read()), {"ok": True, "via": "http"})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(f"{self.stub.url}/api/missing", timeout=5)
        self.assertEqual(ctx.exception.code, 404)
        self.assertEqual(self.stub.gets, [("/api/health", ""), ("/api/missing", "")])

    def test_a_stub_route_that_raises_reads_as_the_daemon_hanging_up(self):
        def route(method, path, query, body):
            raise RuntimeError("route bug")

        self.stub.routes["/api/health"] = route
        with self.assertRaises(hydralib.DaemonError) as ctx:
            hydralib.health()
        self.assertIsNone(ctx.exception.status)
        self.assertIn("route bug", ctx.exception.detail)

    def test_closing_the_stub_unregisters_it(self):
        url = self.stub.url
        self.assertIn(url, hydralib.INPROC)
        self.stub.close()
        self.assertNotIn(url, hydralib.INPROC)
        self.stub = StubDaemon()  # tearDown closes this one

    def test_running_count_prefers_the_live_endpoint(self):
        self.stub.routes["/api/sessions/live"] = {"count": 7, "sessions": []}
        self.assertEqual(hydralib.running_count(), 7)

    def test_running_count_falls_back_to_the_walk_on_an_older_daemon(self):
        # no /api/sessions/live route -> 404 -> the one-dossier-per-chat walk
        self.stub.routes["/api/sessions"] = [
            {"session_id": "a1", "archived": False},
            {"session_id": "b2", "archived": False},
            {"session_id": "c3", "archived": True},  # archived rows are not walked
        ]

        def dossier_route(method, path, query, body):
            q = dossier_query(query)
            live = {"pid": 1} if q == "a1" else None
            return {"matches": [{"cliSessionId": q, "lineageIds": [q], "live": live}]}

        self.stub.routes["/api/chats/dossier"] = dossier_route
        self.assertEqual(hydralib.running_count(), 1)

    def test_running_count_never_swallows_a_real_failure(self):
        self.stub.routes["/api/sessions/live"] = (500, {"error": "down"})
        with self.assertRaises(hydralib.DaemonError):
            hydralib.running_count()

    def test_resolve_prefers_the_sole_unarchived_match_over_an_archived_twin(self):
        # A retired ARCHIVED twin (migration leftover) must not make the live chat
        # unreachable; two VISIBLE copies stay a refusal (real ambiguity).
        self.stub.routes["/api/chats/dossier"] = {"matches": [
            {"instance": "new", "cliSessionId": "x", "title": "T", "archived": False},
            {"instance": "old", "cliSessionId": "x", "title": "T", "archived": True},
        ]}
        self.assertEqual(hydralib.resolve_one("x")["instance"], "new")
        # ONE lineage in two visible records = the zombie-twin shape: the newest answers.
        self.stub.routes["/api/chats/dossier"] = {"matches": [
            {"instance": "a", "cliSessionId": "x", "title": "T", "archived": False,
             "lastActivityAt": "2026-09-01T05:00:00Z"},
            {"instance": "b", "cliSessionId": "x", "title": "T", "archived": False,
             "lastActivityAt": "2026-09-01T04:00:00Z"},
        ]}
        self.assertEqual(hydralib.resolve_one("x")["instance"], "a")
        # TWO different chats (distinct lineages) stay a genuine refusal.
        self.stub.routes["/api/chats/dossier"] = {"matches": [
            {"instance": "a", "cliSessionId": "x", "title": "T", "archived": False},
            {"instance": "b", "cliSessionId": "y", "title": "T", "archived": False},
        ]}
        with self.assertRaises(hydralib.AmbiguousChat):
            hydralib.resolve_one("T")

    def test_sessions_normalizes_both_shapes(self):
        self.stub.routes["/api/sessions"] = {"sessions": [{"session_id": "a"}]}
        self.assertEqual(hydralib.sessions(), [{"session_id": "a"}])
        self.stub.routes["/api/sessions"] = [{"session_id": "b"}]
        self.assertEqual(hydralib.sessions(), [{"session_id": "b"}])

    def test_resolve_one_zero_matches_is_chat_not_found(self):
        self.stub.routes["/api/chats/dossier"] = {"matches": []}
        with self.assertRaises(hydralib.ChatNotFound):
            hydralib.resolve_one("ghost")

    def test_resolve_one_many_matches_is_ambiguous_and_names_them(self):
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [
                {"instance": "a", "title": "Same", "cliSessionId": "s1"},
                {"instance": "b", "title": "Same", "cliSessionId": "s2"},
            ]
        }
        with self.assertRaises(hydralib.AmbiguousChat) as ctx:
            hydralib.resolve_one("Same")
        self.assertIn("[a] Same", str(ctx.exception))
        self.assertEqual(len(ctx.exception.matches), 2)

    def test_resolve_one_single_match_returns_it(self):
        self.stub.routes["/api/chats/dossier"] = {"matches": [{"title": "One", "cliSessionId": "s1"}]}
        self.assertEqual(hydralib.resolve_one("One")["title"], "One")

    def test_dossier_unexpected_shape_raises_never_empty(self):
        self.stub.routes["/api/chats/dossier"] = ["weird"]
        with self.assertRaises(hydralib.DaemonError):
            hydralib.dossier("x")
        self.stub.routes["/api/chats/dossier"] = {"error": "db locked"}
        with self.assertRaises(hydralib.DaemonError):
            hydralib.dossier("x")

    def test_sessions_degraded_payload_raises_never_empty_fleet(self):
        # A 200 with valid JSON but no sessions list is a degraded daemon, not a quiet day.
        self.stub.routes["/api/sessions"] = {"error": "db locked"}
        with self.assertRaises(hydralib.DaemonError):
            hydralib.sessions()

    def test_session_row_finds_by_id(self):
        self.stub.routes["/api/sessions"] = [{"session_id": "a"}, {"session_id": "b", "title": "B"}]
        self.assertEqual(hydralib.session_row("b")["title"], "B")
        self.assertIsNone(hydralib.session_row("zz"))

    def test_query_is_url_encoded(self):
        captured = {}

        def route(method, path, query, body):
            captured["q"] = query
            return {"matches": []}

        self.stub.routes["/api/chats/dossier"] = route
        hydralib.dossier("has space & symbol?")
        self.assertEqual(captured["q"], "q=has%20space%20%26%20symbol%3F")


class SameTaskChatsTest(unittest.TestCase):
    """same_task_chats: the double-check every spawner runs before starting a chat (owner,
    2026-09-01: two identical 'SageThumbs codebase review' chats, 30 minutes apart, both
    running - "it can't do it blind; it must always double check, confirm")."""

    TASK = "Review the SageThumbs codebase end to end for correctness bugs"

    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self.stub.routes["/api/fleet"] = {"instances": []}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}

    def tearDown(self):
        self.stub.close()
        self._tmp.cleanup()

    def _transcript(self, name, prompt):
        p = Path(self._tmp.name) / f"{name}.jsonl"
        p.write_text(json.dumps({"type": "user", "message": {"content": prompt}}) + "\n",
                     encoding="utf-8")
        return str(p)

    def test_finds_a_visible_chat_carrying_the_same_task(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s1", "title": "Existing", "instance": "one", "archived": False,
             "transcript_path": self._transcript("s1", self.TASK)}]
        got = hydralib.same_task_chats(self.TASK)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["session_id"], "s1")
        self.assertEqual(got[0]["title"], "Existing")
        self.assertEqual(got[0]["instance"], "one")
        self.assertFalse(got[0]["live"])
        self.assertIn("Review the SageThumbs", got[0]["firstPrompt"])

    def test_a_live_chat_is_reported_as_live(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s1", "title": "Existing", "instance": "one", "archived": False,
             "transcript_path": self._transcript("s1", self.TASK)}]
        self.stub.routes["/api/sessions/live"] = {"count": 1, "sessions": [{"sessionId": "s1"}]}
        got = hydralib.same_task_chats(self.TASK)
        self.assertTrue(got[0]["live"])

    def test_an_excluded_session_is_never_returned(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s1", "title": "Existing", "instance": "one", "archived": False,
             "transcript_path": self._transcript("s1", self.TASK)}]
        self.assertEqual(hydralib.same_task_chats(self.TASK, exclude={"s1"}), [])

    def test_an_archived_chat_is_never_returned(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s1", "title": "Existing", "instance": "one", "archived": True,
             "transcript_path": self._transcript("s1", self.TASK)}]
        self.assertEqual(hydralib.same_task_chats(self.TASK), [])

    def test_a_different_task_does_not_match(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s1", "title": "Existing", "instance": "one", "archived": False,
             "transcript_path": self._transcript("s1", self.TASK)}]
        got = hydralib.same_task_chats("Fix the login bug in the auth module completely")
        self.assertEqual(got, [])

    def test_finds_a_manager_chat_recorded_as_a_slash_command(self):
        # 2026-09-04, live: four visible managers, same_task_chats(MANAGER_PROMPT) == [] - the
        # watchdog's claim-never-duplicate branch had never once fired in production.
        import overlord

        recorded = ("<command-message>orchestrate</command-message>\n<command-name>/orchestrate"
            "</command-name>\n<command-args>"
            + overlord.MANAGER_PROMPT.split(" ", 1)[1] + "</command-args>")
        self.stub.routes["/api/sessions"] = [
            {"session_id": "m1", "title": "Standing manager chat orchestration", "instance": "one",
             "archived": False, "transcript_path": self._transcript("m1", recorded)}]
        got = hydralib.same_task_chats(overlord.MANAGER_PROMPT)
        self.assertEqual([g["session_id"] for g in got], ["m1"])

    def test_an_empty_prompt_never_scans_the_fleet(self):
        self.assertEqual(hydralib.same_task_chats(""), [])
        self.assertEqual(self.stub.gets, [])

    def test_a_failed_live_lookup_does_not_raise(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s1", "title": "Existing", "instance": "one", "archived": False,
             "transcript_path": self._transcript("s1", self.TASK)}]
        del self.stub.routes["/api/sessions/live"]
        got = hydralib.same_task_chats(self.TASK)
        self.assertEqual(len(got), 1)
        self.assertFalse(got[0]["live"])


if __name__ == "__main__":
    unittest.main()
