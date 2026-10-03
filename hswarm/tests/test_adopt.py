"""Offline: a restarted shared server carries on the jobs the server before it on the same port left unfinished."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys

from hswarm.client import ChatResult, Usage
from hswarm.job import Job, new_job_id
from hswarm.jobs import JobManager
from hswarm.shared import code_stamp, process_started
from hswarm.spec import Result, Task


class _FakeClient:
    def __init__(self):
        self.calls = 0

    async def chat(self, messages, **kw):
        self.calls += 1
        return ChatResult(message={"role": "assistant", "content": "OK"}, finish_reason="stop", usage=Usage(), model="deepseek-flash",
                          seconds=0.01, cost_usd=0.0, peak=False)

    async def aclose(self):
        pass


# Contract: a job the previous server on this port was running carries on under its own id, as it was submitted: the
# answer it already had is kept (not paid for again), a task the shutdown stopped mid-call runs again, each task routes
# from the model it was submitted with and keeps its prompt, and a cancel asked while no server ran is honoured. A job
# some other process started (a CLI run: no port on its stamp) is not touched. Regression: a restart that drops every
# running job, re-runs finished tasks, hands back shutdown-cancelled tasks, re-normalises a task (its receipt clause
# twice) or starts from the failover leg a checkpoint saved (audit, 2026-09-26).
def test_a_restarted_server_carries_on_its_ports_unfinished_jobs(tmp_path):
    tasks = [Task.from_dict({"id": i, "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, n)
             for n, i in enumerate("abc")]
    tasks.append(Task.from_dict({"id": "d", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash",
                                 "inventory": ["a.py"]}, {}, 3))
    prompt_d = tasks[3].prompt
    before = Job(id=new_job_id(), tasks=tasks, task_models={t.id: t.model for t in tasks}, runner={"pid": -1, "port": 7793})
    tasks[1].model = "deepseek-v4-pro"  # b was on a failover leg when the checkpoint was written
    before.results["a"] = Result(id="a", status="ok", answer="done before the restart", cost_usd=0.1)
    before.save()
    stopped = Result(id="c", status="cancelled", error="cancelled")  # the shutdown cancelled c mid-call
    (before.dir / "results.jsonl").write_text("".join(json.dumps(r.as_dict()) + "\n" for r in (before.results["a"], stopped)), encoding="utf-8")
    cli = Job(id=new_job_id(), tasks=tasks, runner={"pid": -1})
    cli.save()
    asked = Job(id=new_job_id(), tasks=tasks[:1], runner={"pid": -1, "port": 7793})
    asked.save()
    (asked.dir / "cancel").write_text("the user stopped it", encoding="utf-8")

    fake = _FakeClient()

    async def go():
        m = JobManager(client=fake)
        m.port = 7793
        assert sorted(m.adopt_orphans()) == sorted([before.id, asked.id])
        carried = m.jobs[before.id].tasks
        assert [t.model for t in carried] == ["deepseek-flash"] * 4 and carried[3].prompt == prompt_d
        return await m.wait(before.id, None), m.jobs[asked.id]

    job, cancelled = asyncio.run(go())
    assert job.state == "done" and job.results["b"].status == "ok" and job.results["c"].status == "ok"
    assert job.results["a"].answer == "done before the restart" and job.cost() == 0.1
    runner = json.loads((before.dir / "job.json").read_text(encoding="utf-8"))["runner"]
    # the adopting server (its pid and when that process was created), and the code it runs
    assert runner == {"pid": os.getpid(), "started": process_started(os.getpid()), "port": 7793, **code_stamp()}
    assert json.loads((cli.dir / "job.json").read_text(encoding="utf-8"))["state"] == "running"
    assert cancelled.state == "cancelled" and cancelled.results["a"].error == "the user stopped it"


# Contract: a job is adopted only when its runner is proven dead. A server that lost its listening socket lives on,
# running and checkpointing its jobs (three such on 7793, 2026-09-27); the next server on the port must leave them to it,
# or every unfinished task is paid for twice by two processes writing one folder. A pid alone is not the runner: the
# same pid created at another time is a later process, so that record's runner is dead and the job is carried on.
# Regression: adoption that trusts the port stamp (the code before 2026-10-02 adopted both records).
def test_a_job_whose_runner_is_still_alive_is_left_to_it(tmp_path):
    task = Task.from_dict({"id": "a", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, 0)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        born = process_started(child.pid)
        alive = Job(id=new_job_id(), tasks=[task], task_models={"a": task.model}, runner={"pid": child.pid, "started": born, "port": 7793})
        alive.save()
        reused = Job(id=new_job_id(), tasks=[task], task_models={"a": task.model}, runner={"pid": child.pid, "started": (born or 0) + 1, "port": 7793})
        reused.save()

        async def go():
            m = JobManager(client=_FakeClient())
            m.port = 7793
            adopted = m.adopt_orphans()
            for job_id in adopted:
                await m.wait(job_id, None)
            return adopted

        adopted = asyncio.run(go())
    finally:
        child.kill()
        child.wait(10)
    assert alive.id not in adopted
    if born is not None:  # a platform that cannot date a process trusts the live pid
        assert adopted == [reused.id]
