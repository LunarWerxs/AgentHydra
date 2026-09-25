"""revivelib + migrate_chat --revive: a rebuilt transcript carries only what a replayed request
accepts. Pins the fidelity rules (thinking dropped, every tool_use answered, orphan results
dropped, active branch since the last compaction, one relinked chain) and that --revive writes
the result under the same session id without clobbering an existing file unasked. A verbatim
copy would keep the signed thinking and the dangling call, and the next turn would be a 400."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import migrate_chat  # noqa: E402
from lib import revivelib  # noqa: E402

SID = "aaaa1111-2222-3333-4444-555566667777"
CWD = "D:\\Work\\demo app"


def rec(uuid, parent, kind, content, **extra):
    return {"uuid": uuid, "parentUuid": parent, "type": kind, "sessionId": "old", "cwd": CWD,
            "message": {"role": kind, "content": content}, **extra}


def transcript():
    return [
        # Pre-compaction history: must not be replayed.
        rec("o1", None, "user", "old question"),
        rec("o2", "o1", "assistant", [{"type": "text", "text": "old answer"}]),
        {"uuid": "cb", "parentUuid": None, "type": "system", "subtype": "compact_boundary",
         "logicalParentUuid": "o2"},
        rec("u1", "cb", "user", "summarised, continue"),
        rec("a1", "u1", "assistant", [{"type": "thinking", "thinking": "hm", "signature": "sig"}]),
        rec("a2", "a1", "assistant", [{"type": "text", "text": "reading"},
                                      {"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]),
        {"uuid": "p1", "parentUuid": "a2", "type": "progress"},
        rec("r1", "p1", "user", [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]),
        # An edited-away branch off r1: must not be spliced in.
        rec("x1", "r1", "user", "abandoned edit"),
        rec("a3", "r1", "assistant", [{"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}]),
        # Sidechain noise and a trailing unanswered call (the session was killed mid-tool).
        rec("s1", "a3", "user", "sub-agent prompt", isSidechain=True),
        rec("a4", "a3", "assistant", [{"type": "text", "text": "done"},
                                      {"type": "tool_use", "id": "t3", "name": "Bash", "input": {}}]),
    ]


class RebuildRecordsTest(unittest.TestCase):
    def test_keeps_only_replay_safe_records_on_the_active_branch(self):
        kept, stats = revivelib.rebuild_records(transcript(), SID)
        self.assertEqual([r["uuid"] for r in kept], ["u1", "a2", "r1", "a4"])
        blocks = [b for r in kept if isinstance(r["message"]["content"], list)
                  for b in r["message"]["content"]]
        self.assertFalse(any(b.get("type") == "thinking" for b in blocks))
        ids = {b.get("id") for b in blocks if b.get("type") == "tool_use"}
        self.assertEqual(ids, {"t1"})  # t2 (result never came) and t3 (tail) are gone
        self.assertEqual(stats["thinking"], 1)
        self.assertEqual(stats["unansweredToolUse"], 2)

    def test_chain_is_relinked_and_renamed(self):
        kept, _ = revivelib.rebuild_records(transcript(), SID)
        self.assertIsNone(kept[0]["parentUuid"])
        for prev, cur in zip(kept, kept[1:]):
            self.assertEqual(cur["parentUuid"], prev["uuid"])
        self.assertTrue(all(r["sessionId"] == SID for r in kept))

    def test_result_without_its_call_is_dropped(self):
        recs = [rec("u1", None, "user", "go"),
                rec("r1", "u1", "user", [{"type": "tool_result", "tool_use_id": "zz", "content": "x"},
                                         {"type": "text", "text": "and this"}])]
        kept, stats = revivelib.rebuild_records(recs)
        self.assertEqual(kept[1]["message"]["content"], [{"type": "text", "text": "and this"}])
        self.assertEqual(stats["orphanToolResult"], 1)


class ReviveCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "saved.jsonl"
        self.source.write_text("".join(json.dumps(r) + "\n" for r in transcript()), encoding="utf-8")
        self.into = self.root / "projects"

    def tearDown(self):
        self.tmp.cleanup()

    def run_revive(self, *extra):
        return migrate_chat.main(["--revive", SID, "--source", str(self.source),
                                  "--into", str(self.into), "--json", *extra])

    def test_writes_rebuilt_transcript_under_the_project_folder(self):
        self.assertEqual(self.run_revive(), 0)
        dest = self.into / revivelib.project_folder(CWD) / f"{SID}.jsonl"
        written = revivelib.parse_jsonl(dest.read_text(encoding="utf-8"))
        self.assertEqual([r["uuid"] for r in written], ["u1", "a2", "r1", "a4"])

    def test_existing_transcript_needs_force(self):
        dest = self.into / "folder" / f"{SID}.jsonl"
        dest.parent.mkdir(parents=True)
        dest.write_text("original\n", encoding="utf-8")
        self.assertEqual(self.run_revive(), 3)
        self.assertEqual(dest.read_text(encoding="utf-8"), "original\n")

    def test_dry_run_writes_nothing(self):
        self.assertEqual(self.run_revive("--dry-run"), 0)
        self.assertFalse(self.into.exists())


if __name__ == "__main__":
    unittest.main()
