"""Offline: the tool-receipt ledger and the two verdicts built on it (hswarm/receipts.py).

A worker's "done" used to be free text the orchestrator re-verified by hand. These pin that every sandbox
call is numbered and stamped for the model to cite, that a citation to a receipt no call made (or to the
wrong tool, or to a failing run for a "pass") is caught, and that a green claim without a passing command
receipt at the asked level comes back unverified with what is missing. No network, no bash.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import receipts  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402
from hswarm.worker import run_tools  # noqa: E402


def _call(name: str, args: dict) -> dict:
    return {"id": name, "function": {"name": name, "arguments": json.dumps(args)}}


def _ledger(*calls: tuple[str, dict, str]) -> list[dict]:
    ledger: list[dict] = []
    for name, args, out in calls:
        receipts.close_receipt(receipts.open_receipt(ledger, name, args), out)
    return ledger


LEDGER = _ledger(
    ("read_file", {"path": "a.py"}, "1\tx = 1"),
    ("bash", {"command": "pytest tests/test_a.py"}, "exit=1\n1 failed"),
    ("edit_file", {"path": "a.py", "old_string": "1", "new_string": "2"}, "edited a.py (1 replacement)"),
    ("bash", {"command": "pytest tests/test_a.py"}, "exit=0\n3 passed"),
    ("bash", {"command": "git rev-parse HEAD"}, "exit=0\n0123456789abcdef0123456789abcdef01234567"),
)


def test_every_sandbox_call_is_numbered_and_stamped_in_call_order(tmp_path):
    (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
    sb = Sandbox(tmp_path)
    outputs, _ = asyncio.run(run_tools(sb, [_call("read_file", {"path": "a.txt"}), _call("read_file", {"path": "missing.txt"})]))
    # Each output reaches the model inside the guard's <scan_data> frame (guard.py); the receipt header opens its body.
    assert outputs[0].startswith('<scan_data source="read_file">\n[r1 read_file]\n') and "hello" in outputs[0]
    assert '<scan_data source="read_file">\n[r2 read_file]\nERROR' in outputs[1]
    assert [(r["id"], r["status"]) for r in sb.receipts] == [("r1", "ok"), ("r2", "error")]
    assert sb.receipts[0]["out_sha"] != sb.receipts[1]["out_sha"]


def test_citations_resolve_when_every_claim_is_backed():
    v = receipts.verify_citations("Edited a.py [r3 edit_file]. Tests pass [r4 bash].\nx is set at a.py:1 [r1 read].", LEDGER)
    assert v["verdict"] == "resolved" and v["resolved"] == 3


@pytest.mark.parametrize("answer, verdict", [
    ("Tests pass [r9 bash].", "unknown"),                  # a receipt no call ever had
    ("Edited a.py [r1 edit_file].", "mismatched"),         # the id exists, but it was a read
    ("Ran the tests [r1].", "mismatched"),                 # a run claim backed only by a read
    ("Tests pass [r2 bash].", "mismatched"),               # the cited run exited 1
    ("Fixed the bug in a.py and verified it.", "uncited"),
    ("x is defined at a.py:1.", "none"),                   # a finding, not a claimed action
])
def test_citation_verdicts(answer, verdict):
    assert receipts.verify_citations(answer, LEDGER)["verdict"] == verdict


def test_green_verified_on_a_passing_command_receipt():
    g = receipts.evaluate_green("package", receipts.parse_green("done\nGREEN: level=workspace receipt=[r4 bash]"), LEDGER)
    assert g["verdict"] == "verified" and g["exit_code"] == 0 and g["command"] == "pytest tests/test_a.py"


@pytest.mark.parametrize("answer, missing", [
    ("all done, tests pass", "no GREEN line"),
    ("GREEN: level=targeted_tests receipt=r4", "level: claimed targeted_tests"),
    ("GREEN: level=package receipt=r2", "exited 1"),
    ("GREEN: level=package receipt=r1", "not a command run"),
    ("GREEN: level=package receipt=r42", "not in the ledger"),
])
def test_green_unverified_names_what_is_missing(answer, missing):
    g = receipts.evaluate_green("package", receipts.parse_green(answer), LEDGER)
    assert g["verdict"] == "unverified" and any(missing in m for m in g["missing"])


def test_merge_ready_needs_a_base_sha_a_git_receipt_printed():
    ok = receipts.evaluate_green("merge_ready", receipts.parse_green("GREEN: level=merge_ready receipt=r4 base=0123456789ab"), LEDGER)
    assert ok["verdict"] == "verified" and ok["base_sha"] == "0123456789ab"
    made_up = receipts.evaluate_green("merge_ready", receipts.parse_green("GREEN: level=merge_ready receipt=r4 base=deadbeef99"), LEDGER)
    assert made_up["verdict"] == "unverified"


def test_green_from_structured_data():
    claim = receipts.parse_green("", {"green": {"level": "package", "receipt": "r4"}})
    assert receipts.evaluate_green("package", claim, LEDGER)["verdict"] == "verified"


def test_unverified_ids_lists_only_ok_results_whose_done_is_not_backed():
    results = [
        {"id": "a", "status": "ok", "citations": {"verdict": "resolved"}, "green": {"verdict": "verified"}},
        {"id": "b", "status": "ok", "citations": {"verdict": "uncited"}},
        {"id": "c", "status": "ok", "citations": {"verdict": "resolved"}, "green": {"verdict": "unverified"}},
        {"id": "d", "status": "error", "citations": {"verdict": "unknown"}},
    ]
    assert receipts.unverified_ids(results) == ["b", "c"]


def test_a_green_task_needs_the_bash_tool(tmp_path):
    with pytest.raises(ValueError, match="bash"):
        Task.from_dict({"prompt": "fix it", "cwd": str(tmp_path), "tools": "edit", "green": "package"})
    with pytest.raises(ValueError, match="green must be one of"):
        Task.from_dict({"prompt": "fix it", "cwd": str(tmp_path), "tools": "all", "green": "shipped"})
    assert Task.from_dict({"prompt": "fix it", "cwd": str(tmp_path), "tools": "all", "green": "package"}).green == "package"


def test_green_with_a_schema_is_refused(tmp_path):
    # A schema answer is submit_result JSON, where no GREEN line can be found: the pair could never verify.
    with pytest.raises(ValueError, match="schema"):
        Task.from_dict({"prompt": "fix it", "cwd": str(tmp_path), "tools": "all", "green": "package",
                        "schema": {"type": "object", "properties": {"summary": {"type": "string"}}}})


def test_merge_ready_base_must_come_from_a_git_command():
    ledger = list(LEDGER)
    receipts.close_receipt(receipts.open_receipt(ledger, "bash", {"command": "echo feedfacecafe"}), "exit=0\nfeedfacecafe")
    g = receipts.evaluate_green("merge_ready", receipts.parse_green("GREEN: level=merge_ready receipt=r4 base=feedfacecafe"), ledger)
    assert g["verdict"] == "unverified" and any("git receipt" in m for m in g["missing"])


def test_write_verbs_describing_code_are_not_claims_for_a_read_only_task():
    answer = "This commit added a guard in a.py and changed the retry count."
    assert receipts.verify_citations(answer, LEDGER, {"read_file", "grep"})["verdict"] == "none"
    assert receipts.verify_citations(answer, LEDGER, {"read_file", "edit_file"})["verdict"] == "uncited"


def test_disk_payload_flags_unverified_and_drops_the_ledger_unless_asked(monkeypatch):
    from hswarm import results

    def record():
        return {"summary": {}, "results": {
            "a": {"id": "a", "status": "ok", "answer": "", "citations": {"verdict": "uncited"}, "receipts": [{"id": "r1"}]},
            "b": {"id": "b", "status": "ok", "answer": "", "citations": {"verdict": "resolved"}, "receipts": [{"id": "r1"}]}}}
    monkeypatch.setattr(results.Job, "load_from_disk", staticmethod(lambda job_id: record()))
    out = results.results_from_disk("j", None, None, 1000)
    assert out["unverified"] == ["a"] and all("receipts" not in r for r in out["results"])
    assert all(r["receipts"] for r in results.results_from_disk("j", None, None, 1000, include_receipts=True)["results"])
