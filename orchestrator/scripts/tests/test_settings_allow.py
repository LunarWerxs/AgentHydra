"""stamplib.ensure_allow_all - the engine-side half of the doctrine (owner, 2026-09-02:
"regarding the manual mode - no, I am quite certain you can figure it out").

The desktop launches every engine with an explicit --permission-mode from its in-memory
record, so only the app's picker (a window) changes the MODE - but the engine reads the user
settings, and allow rules there pre-approve tools in every mode. These pin: every built-in
tool and every MCP server lands in permissions.allow; existing rules are kept; the write is
idempotent; a broken file is left alone; a backup is taken once."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import stamplib  # noqa: E402


class EnsureAllowAllTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "settings.json"

    def test_a_fresh_file_gets_every_tool_and_server_and_bypass_default(self):
        got = stamplib.ensure_allow_all(self.path, servers={"agenthydra", "connections"})
        self.assertTrue(got["changed"])
        data = json.loads(self.path.read_text(encoding="utf-8"))
        allow = data["permissions"]["allow"]
        for tool in stamplib.ALLOW_ALL_TOOLS:
            self.assertIn(tool, allow)
        self.assertIn("mcp__agenthydra", allow)
        self.assertIn("mcp__connections", allow)
        self.assertEqual(data["permissions"]["defaultMode"], "bypassPermissions")

    def test_existing_rules_and_other_settings_survive(self):
        self.path.write_text(json.dumps({"theme": "dark", "hooks": {"x": 1},
                                         "permissions": {"allow": ["mcp__codegraph__codegraph_explore"],
                                                         "deny": ["Bash(rm -rf *)"], "defaultMode": "acceptEdits"}}),
                             encoding="utf-8")
        got = stamplib.ensure_allow_all(self.path, servers=set())
        self.assertTrue(got["changed"])
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data["theme"], "dark")
        self.assertEqual(data["hooks"], {"x": 1})
        self.assertIn("mcp__codegraph__codegraph_explore", data["permissions"]["allow"])
        self.assertEqual(data["permissions"]["deny"], ["Bash(rm -rf *)"])
        # an explicit defaultMode is respected (setdefault), the allow list is what does the work
        self.assertEqual(data["permissions"]["defaultMode"], "acceptEdits")
        self.assertTrue(self.path.with_name("settings.json.bak-doctrine").exists())

    def test_second_run_changes_nothing(self):
        stamplib.ensure_allow_all(self.path, servers={"agenthydra"})
        before = self.path.read_text(encoding="utf-8")
        got = stamplib.ensure_allow_all(self.path, servers={"agenthydra"})
        self.assertFalse(got["changed"])
        self.assertEqual(got["added"], [])
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_a_broken_file_is_left_alone(self):
        self.path.write_text("{not json", encoding="utf-8")
        got = stamplib.ensure_allow_all(self.path, servers=set())
        self.assertFalse(got["changed"])
        self.assertIn("unreadable", got["error"])
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{not json")

    def test_configured_servers_are_read_from_claude_json(self):
        cj = Path(self._tmp.name) / ".claude.json"
        cj.write_text(json.dumps({"mcpServers": {"a": {}}, "projects": {"p": {"mcpServers": {"b": {}}}}}),
                      encoding="utf-8")
        self.assertEqual(stamplib.configured_mcp_servers(cj), {"a", "b"})


if __name__ == "__main__":
    unittest.main()
