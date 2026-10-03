"""Offline: a finished task is labelled by whether it moved the work, not just whether it replied.

A worker `ok` whose answer is "I'll inspect..." or "blocked on credentials" reads as done to an orchestrator
skimming statuses; classify_liveness turns those into planning_only / blocked_external / approval_required so
the caller continues or escalates them. Pinned here because the failure is silent: a no-op counted as a result.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.job import Job  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402
from hswarm.worker import classify_liveness  # noqa: E402

REPORT = ("hswarm/config.py:61 defines PROVIDERS with twelve entries; hswarm/config.py:144 resolves a role to a model "
          "and raises when none is wired. " * 6)


def _ok(answer: str, **kw) -> Result:
    return Result(id="t", status="ok", answer=answer, **kw)


def test_plan_without_work_is_planning_only_with_its_next_action():
    state, nxt = classify_liveness(_ok("I'll inspect hswarm/config.py and then report the price table."))
    assert state == "planning_only"
    assert nxt == "I'll inspect hswarm/config.py and then report the price table."


def test_next_steps_list_without_work_is_planning_only():
    state, nxt = classify_liveness(_ok("Next steps:\n- read hswarm/jobs.py\n- patch the router"))
    assert (state, nxt) == ("planning_only", "read hswarm/jobs.py")


def test_blocked_on_credentials_is_external_even_as_a_failed_line():
    state, nxt = classify_liveness(Result(id="t", status="error", answer="FAILED: blocked on credentials - the OPENAI_API_KEY is not set here."))
    assert state == "blocked_external" and "OPENAI_API_KEY" in nxt
    assert classify_liveness(_ok("I don't have access to the staging database, so the migration was not run.", tool_calls=2))[0] == "blocked_external"


def test_asking_to_proceed_is_approval_required():
    state, nxt = classify_liveness(_ok("The migration is written. Should I proceed with applying it to production?", tool_calls=3, files_changed=["m.sql"]))
    assert (state, nxt) == ("approval_required", "Should I proceed with applying it to production?")


def test_a_real_report_is_advanced_even_when_it_opens_like_a_plan():
    assert classify_liveness(_ok(REPORT, tool_calls=5)) == ("advanced", "")
    # After real tool work, a long answer that opens "Let me summarise" is a report, not a plan.
    assert classify_liveness(_ok("Let me summarise. " + REPORT, tool_calls=8)) == ("advanced", "")


def test_a_long_tool_free_answer_with_a_plan_opener_is_advanced():
    # tools="none" reviews and judgments make no tool calls by design; their full analysis is the result.
    assert classify_liveness(_ok("Let me walk through the two designs. " + REPORT)) == ("advanced", "")
    assert classify_liveness(_ok("I should note first that " + REPORT)) == ("advanced", "")


def test_a_blocker_named_as_a_finding_is_not_the_worker_blocked():
    # hswarm reviews code that handles keys: a review that ends on a missing-key crash reports it, it is not stopped by it.
    review = REPORT + "Last, hswarm/config.py:88 crashes with no API key set, and the request is blocked by CORS."
    assert classify_liveness(_ok(review, tool_calls=5)) == ("advanced", "")
    assert classify_liveness(_ok("Blocked: no API key for the staging provider."))[0] == "blocked_external"


def test_evidence_and_status_override_text():
    assert classify_liveness(_ok("I'll check later", data={"summary": "I'll check later"})) == ("advanced", "")
    partial = "PARTIAL - the task hit its wall before answering; ...\nsaid: I'll look\n--- tool result ---\npermission denied"
    assert classify_liveness(Result(id="t", status="timeout", answer=partial, tool_calls=4)) == ("failed", "")
    assert classify_liveness(Result(id="t", status="error", answer="FAILED: the file does not exist")) == ("failed", "")


def test_job_summary_lists_not_advanced_ids_by_label():
    job = Job(id="j", tasks=[Task(prompt="p", id=i) for i in ("a", "b", "c", "d")])
    for tid, label in (("a", "advanced"), ("b", "planning_only"), ("c", "blocked_external"), ("d", "planning_only")):
        job.results[tid] = Result(id=tid, status="ok", liveness=label)
    assert job.not_advanced() == {"planning_only": ["b", "d"], "blocked_external": ["c"]}


class _PlanOnlyClient:
    """Stands in for DeepSeekClient: every chat() replies with a plan and makes no tool call."""

    async def chat(self, messages, **kw):
        return ChatResult(message={"role": "assistant", "content": "I'll inspect hswarm/config.py and report back."},
                          finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.0, peak=False)

    async def aclose(self):
        pass


def test_run_one_labels_every_result_and_the_summary_and_ledger_carry_it(tmp_path, monkeypatch):
    # The label is set in JobManager._run_one; dropping that call in a merge would leave every result unlabelled.
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")

    async def go():
        m = JobManager(client=_PlanOnlyClient())
        task = Task.from_dict({"id": "plan", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, 0)
        return await m.run_batch([task], concurrency=1)

    job = asyncio.run(go())
    res = job.results["plan"]
    assert (res.status, res.liveness) == ("ok", "planning_only")
    assert res.next_action.startswith("I'll inspect hswarm/config.py")
    assert job.summary()["not_advanced"] == {"planning_only": ["plan"]}
    rows = [json.loads(ln) for ln in (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()]
    assert rows[-1]["liveness"] == "planning_only"
