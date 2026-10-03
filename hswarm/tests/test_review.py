"""hswarm_review / hswarm_doubt (hswarm/review.py): the evidence bar is enforced mechanically, not only asked for.

Pinned: a finding whose quote is not in the file it cites never reaches the shown list (cheap reviewers'
confident "field does not exist" false positives); each finding is anchored in_diff / off_diff against the
diff; the refute pass drops only on cited evidence, holds off_diff findings to a confirmation, and a pass that
fails keeps everything; the doubt cycle's precedence and doubt-theater stop; a review role carries its
contract into the task. No model is called: the job manager is a fake.
"""
import asyncio

from hswarm import review
from hswarm.spec import Result, Task

DIFF = """diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def ratio(total, count):
-    return total / max(count, 1)
+    return total / count
"""


def _repo(tmp_path):
    (tmp_path / "calc.py").write_text("def ratio(total, count):\n    return total / count\n", encoding="utf-8")
    (tmp_path / "settings.py").write_text("TIMEOUT_S = 5\n", encoding="utf-8")
    return tmp_path


def _finding(**kw):
    base = {"path": "calc.py", "line": 2, "quote": "return total / count", "severity": "important",
            "claim": "divides by zero", "failure_mode": "count=0 raises ZeroDivisionError", "confidence": 8}
    return base | kw


def test_a_quote_not_in_the_cited_file_never_reaches_the_shown_list(tmp_path):
    root = _repo(tmp_path)
    real = _finding()
    invented = _finding(quote="self.count_cache = {}", confidence=9)  # confident, and not in calc.py
    numbered = _finding(quote="2\t    return total / count")  # copied from read_file with its line prefix
    no_failure = _finding(failure_mode="")
    nits = [_finding(severity="nit", confidence=6) for _ in range(7)]
    out = review.gate([real, invented, numbered, no_failure, *nits], root, DIFF, nit_cap=5)

    shown = {f["index"]: f for f in out["findings"]}
    assert 0 in shown and shown[0]["severity"] == "important" and shown[0]["verified"]
    assert 1 not in shown and out["appendix"][0]["index"] == 1
    assert out["appendix"][0]["severity"] == "question" and out["appendix"][0]["confidence"] == 4
    assert shown[2]["verified"]
    assert shown[3]["severity"] == "question"  # important without a failure mode is only a question
    assert sum(f["severity"] == "nit" for f in out["findings"]) == 5 and out["nits_omitted"] == 2
    assert out["unverified"] == 1


def test_a_path_outside_the_root_is_unverifiable(tmp_path):
    (tmp_path / "repo").mkdir()
    root = _repo(tmp_path / "repo")
    (tmp_path / "outside.py").write_text("SECRET = 1\n", encoding="utf-8")
    assert not review.quote_found(root, "../outside.py", "SECRET = 1")
    assert review.quote_found(root, str(root / "settings.py"), "TIMEOUT_S = 5")


def test_findings_are_anchored_to_the_diff():
    changed = review.changed_lines(DIFF)
    assert review.anchor(_finding(), changed) == "in_diff"
    assert review.anchor(_finding(path="settings.py", quote="TIMEOUT_S = 5"), changed) == "off_diff"
    # the same code quoted against a file the diff never touched is off_diff too
    assert review.anchor(_finding(path="other.py"), changed) == "off_diff"


def test_refute_drops_only_on_cited_evidence_and_off_diff_needs_confirming():
    fs = [{"index": 0, "anchor": "in_diff"}, {"index": 1, "anchor": "in_diff"}, {"index": 2, "anchor": "in_diff"},
          {"index": 3, "anchor": "off_diff"}, {"index": 4, "anchor": "off_diff"}]
    data = {"survived": [0, 4], "refuted": [{"index": 1, "evidence": "guarded at calc.py:14"},
                                            {"index": 2, "evidence": "probably fine"}]}
    out = review.apply_refute(fs, "ok", data)
    assert [f["index"] for f in out["kept"]] == [0, 2, 4]
    assert [f["index"] for f in out["refuted"]] == [1, 3]
    # a refute pass that fails keeps every finding
    for status, bad in (("error", None), ("ok", {"survived": "all"}), ("timeout", data)):
        assert review.apply_refute(fs, status, bad)["kept"] == fs


def test_doubt_precedence_and_theater_stop():
    issues = review.reconcile([{"kind": "noise", "issue": "a"}, {"kind": "tradeoff", "issue": "b"},
                               {"kind": "made-up", "issue": "c"}, {"kind": "contract_misread", "issue": "d"},
                               {"kind": "actionable", "issue": "e"}])
    assert [i["issue"] for i in issues] == ["d", "e", "b", "a", "c"]
    tradeoff_only = [{"kind": "tradeoff"}]
    assert not review.doubt_verdict([tradeoff_only])["stop"]
    v = review.doubt_verdict([tradeoff_only, tradeoff_only])
    assert v["stop"] and v["doubt_theater"]
    assert not review.doubt_verdict([[{"kind": "actionable"}], [{"kind": "actionable"}]])["stop"]
    assert review.doubt_verdict([[{"kind": "actionable"}]] * 3)["stop"]
    assert "claim" not in review.doubt_prompt("the artifact", "the contract").lower()


def test_a_review_role_carries_its_contract(tmp_path):
    t = Task.from_dict({"prompt": "grade it", "cwd": str(tmp_path), "tools": "none", "role": "judge", "system": "mine"})
    assert t.system.startswith(review.JUDGE_CONTRACT) and t.system.endswith("mine")
    assert Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "role": "search"}).system is None


class _Job:
    def __init__(self, id, results):
        self.id, self.results = id, results


class _FakeManager:
    """Answers each single-task job from a script keyed by task id; records what it was handed."""

    def __init__(self, script):
        self.script, self.tasks, self.jobs = script, [], {}

    def submit(self, tasks, label="", budget_usd=None):
        t = tasks[0]
        self.tasks.append(t)
        status, data = self.script[t.id]
        job = _Job(f"j{len(self.tasks)}", {t.id: Result(id=t.id, status=status, data=data)})
        self.jobs[job.id] = job
        return job

    async def wait(self, job_id, timeout_s):
        return self.jobs[job_id]


def test_run_review_investigates_gates_and_refutes(tmp_path):
    root = _repo(tmp_path)
    found = [_finding(), _finding(quote="self.count_cache = {}", confidence=9),
             _finding(path="settings.py", line=1, quote="TIMEOUT_S = 5", claim="too short", confidence=7)]
    mgr = _FakeManager({"investigate": ("ok", {"read": ["calc.py"], "findings": found}),
                        "refute": ("ok", {"survived": [0], "refuted": []})})
    out = asyncio.run(review.run_review(mgr, str(root), DIFF))

    investigate, refute = mgr.tasks
    assert investigate.system.startswith(review.JUDGE_CONTRACT) and investigate.schema == review.FINDINGS_SCHEMA
    assert refute.role == "refute" and review.REFUTE_CONTRACT in refute.system
    assert '"anchor": "off_diff"' in refute.prompt and "self.count_cache" not in refute.prompt
    assert [f["index"] for f in out["findings"]] == [0]
    assert [f["index"] for f in out["refuted"]] == [2]
    assert [f["index"] for f in out["appendix"]] == [1]
    assert out["jobs"] == ["j1", "j2"] and out["refute"] == "done"
