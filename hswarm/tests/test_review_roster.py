"""Offline: the review roster's rules (routing, fingerprint merge, dismissals, verdict floor) and the scope echo.
No network, no model call: every rule the review gate promises is enforced in code, so it is tested as code."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import roster  # noqa: E402
from hswarm.cli import main as cli_main  # noqa: E402
from hswarm.reviewverb import review  # noqa: E402
from hswarm.spec import Result, Task, mis_scoped, scope_mark  # noqa: E402

DIFF = """diff --git a/app/auth.py b/app/auth.py
--- a/app/auth.py
+++ b/app/auth.py
@@ -1,3 +1,3 @@
-if not user.is_admin: raise Forbidden()
+pass
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
+hello
"""


def _rv(name, axis="code"):
    return roster.Reviewer(name=name, body="", axis=axis)


def _f(**kw):
    return {"file": "app/auth.py", "line": 2, "severity": "minor", "category": "bug", "title": "t", "confidence": 5, **kw}


def test_merge_by_fingerprint_keeps_best_copy_worst_severity_and_boosts_agreement():
    merged = roster.merge([(_rv("correctness"), [_f(confidence=6, title="a")]), (_rv("security"), [_f(confidence=8, severity="important", title="b")])])
    assert len(merged) == 1
    f = merged[0]
    assert f["title"] == "b" and f["confidence"] == 9 and f["severity"] == "important"
    assert sorted(f["agreed_by"]) == ["correctness", "security"] and f["security"] is True


def test_code_and_spec_axes_are_never_merged():
    merged = roster.merge([(_rv("correctness"), [_f()]), (_rv("spec", "spec"), [_f()])])
    assert sorted(f["axis"] for f in merged) == ["code", "spec"]
    axes = roster.by_axis(merged, ["code", "spec"])
    assert len(axes["code"]["findings"]) == 1 and len(axes["spec"]["findings"]) == 1


def test_ignore_marker_and_dismissals_never_touch_a_protected_finding(tmp_path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "auth.py").write_text("x = 1\ny = 2  # hswarm-review-ignore: legacy path, removed next week\nz = 3\n", encoding="utf-8")
    # the critical finding sits on line 3, so its line-above check reaches the marker on line 2 and must be refused
    minor, crit = roster.merge([(_rv("correctness"), [_f(), _f(line=3, severity="critical", title="c")])])[::-1]
    kept, suppressed = roster.apply_rules([minor, crit], tmp_path, {})
    assert [f["id"] for f in suppressed] == [minor["id"]] and "legacy path" in suppressed[0]["suppressed"]
    assert kept == [crit] and "legacy path" in crit["ignore_refused"]
    kept, suppressed = roster.apply_rules([crit], tmp_path, {crit["id"]: "not a bug"}, drop_dismissed=True)
    assert kept == [crit] and crit["dismissed"] == "not a bug" and not suppressed
    other = roster.merge([(_rv("tests"), [_f(file="app/other.py")])])[0]
    assert roster.apply_rules([other], tmp_path, {other["id"]: "fine"})[0][0]["dismissed"] == "fine"  # annotates by default
    assert roster.apply_rules([other], tmp_path, {other["id"]: "fine"}, drop_dismissed=True)[0] == []


def test_ignore_marker_path_outside_the_root_is_never_read(tmp_path):
    (tmp_path / "secret.py").write_text("a  # hswarm-review-ignore: sneaky\n", encoding="utf-8")
    root = tmp_path / "repo"
    root.mkdir()
    assert roster.ignore_reason(root, {"file": "../secret.py", "line": 1}) == ""


def test_coordinator_cannot_lower_critical_merge_across_axes_or_beat_the_floor():
    crit = roster.merge([(_rv("correctness"), [_f(severity="critical")])])[0]
    spec = roster.merge([(_rv("spec", "spec"), [_f(line=9)])])[0]
    coord = {"verdict": "approve", "rerank": [{"id": crit["id"], "severity": "minor", "reason": "meh"}, {"id": "nope1234", "severity": "critical"}],
             "duplicates": [{"id": spec["id"], "same_as": crit["id"]}]}
    kept = roster.apply_coordinator([crit, spec], coord)
    assert len(kept) == 2 and crit["severity"] == "critical" and "rerank_refused" in crit
    assert roster.final_verdict(kept, coord["verdict"]) == "request_changes"
    assert roster.final_verdict([], "approve") == "approve"
    assert roster.final_verdict([spec], "request_changes") == "request_changes"  # the coordinator may raise, never lower


def test_routing_by_paths_needs_and_depth_cap():
    reviewers, prompts = roster.load_roster([roster.BUILTIN])
    assert {"shared", "coordinator"} <= set(prompts) and all(r.axis in roster.AXES for r in reviewers.values())
    files = roster.changed_files(DIFF)
    assert files == ["app/auth.py", "README.md"] and roster.has_deletions(DIFF)
    chosen, capped = roster.select(reviewers, files, True, False, "max")
    names = [r.name for r in chosen]
    assert {"correctness", "standards", "security", "removed-behavior"} <= set(names) and "spec" not in names and not capped
    assert names[:2] == ["correctness", "standards"]  # always-run first
    low, left = roster.select(reviewers, files, True, True, "low")
    assert [r.name for r in low] == ["correctness"] and "spec" in left


def test_scope_block_is_prepended_and_an_unechoed_result_is_mis_scoped(tmp_path):
    t = Task.from_dict({"prompt": "review it", "cwd": str(tmp_path), "tools": "none", "scope": "read root: X"}, {}, 0)
    mark = scope_mark("read root: X")
    assert t.prompt.startswith('<scope id="' + mark) and t.prompt.endswith("review it")
    assert mis_scoped(t, Result(id="t1", status="ok", answer="looked at some other repo"))
    assert not mis_scoped(t, Result(id="t1", status="ok", data={"scope": mark, "findings": []}))
    plain = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none"}, {}, 0)
    assert not mis_scoped(plain, Result(id="t1", status="ok", answer="anything"))


def test_scope_with_a_schema_gets_a_required_scope_slot_or_is_refused(tmp_path):
    # a strict caller schema with no `scope` property would make every correct schema worker read mis_scoped
    strict = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"], "additionalProperties": False}
    t = Task.from_dict({"prompt": "count", "cwd": str(tmp_path), "tools": "none", "scope": "S", "schema": strict}, {}, 0)
    assert t.schema["properties"]["scope"] == {"type": "string", "description": "the scope mark from the <scope> block"}
    assert t.schema["required"] == ["n", "scope"] and "scope" not in strict["properties"]  # the caller's dict is not mutated
    try:
        Task.from_dict({"prompt": "list", "cwd": str(tmp_path), "tools": "none", "scope": "S", "schema": {"type": "array"}}, {}, 0)
        raise AssertionError("an array schema cannot carry the scope mark and must be refused")
    except ValueError as e:
        assert "schema root must be type 'object'" in str(e)  # refused for every api task now, scope or not


def test_a_discarded_reviewer_makes_the_verdict_incomplete_not_approve(tmp_path, monkeypatch):
    # the gate must not fail open: one clean reviewer plus two that errored is not an approval
    import hswarm.reviewverb as rv_mod

    class _NoJobs:
        async def aclose(self):
            pass

    async def fake_batch(m, tasks, concurrency, budget, jobs):
        out = {}
        for t in tasks:
            ok = t.id == "correctness"
            out[t.id] = Result(id=t.id, status="ok" if ok else "error", data={"scope": scope_mark(t.scope), "findings": []} if ok else None,
                               error=None if ok else "429 rate limited")
        return out

    monkeypatch.setattr(rv_mod, "JobManager", _NoJobs)
    monkeypatch.setattr(rv_mod, "_batch", fake_batch)
    out = asyncio.run(review(tmp_path, DIFF, "test diff", depth="medium"))
    assert out["incomplete"] and out["verdict"] == "approve_with_comments"
    assert sorted(d["reviewer"] for d in out["discarded"]) == ["removed-behavior", "standards"]


def test_review_dry_run_plans_without_a_model_call(tmp_path, capsys):
    out = asyncio.run(review(tmp_path, DIFF, "test diff", depth="medium", dry_run=True))
    assert out["dry_run"] and out["reviewers"] == ["correctness", "standards", "removed-behavior"] and out["left_out_by_depth"]
    patch = tmp_path / "change.patch"
    patch.write_text(DIFF, encoding="utf-8")
    assert cli_main(["review", "--cwd", str(tmp_path), "--diff", str(patch), "--dry-run"]) == 0
    assert '"reviewers"' in capsys.readouterr().out
