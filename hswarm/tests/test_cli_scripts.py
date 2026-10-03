"""The CLI's end-to-end regressions as script files: tests/testdata/script/*.txtar, one per behaviour.

WHY: a flag or an output line of `hswarm ask` / `hswarm run` changing is caught by reading fifteen lines of text,
not a page of harness code, and never by a provider call. Each script runs `hswarm ...` in-process in its own
temp directory against the stubbed api backend below. The engine and its syntax are in tests/scripttest.py;
tests/testdata/script/README.md says how to write one.
"""
from __future__ import annotations

import io
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripttest  # noqa: E402
from hswarm import agent, cli, config, jobs, selection  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, now_iso  # noqa: E402

SCRIPTS = sorted((Path(__file__).resolve().parent / "testdata" / "script").glob("*.txtar"))


class StubApi:
    """The api backend a script talks to: every ask and every api task is answered here, never by a provider.

    api echo            answer `echo: <prompt>` (the default)
    api reply TEXT...   answer TEXT
    api fail MESSAGE... end the call in status error with MESSAGE
    api calls N         assert exactly N calls reached the backend so far (`! api calls 0`: at least one did)
    """

    def __init__(self) -> None:
        self.mode, self.text, self.calls = "echo", "", 0

    def result(self, rid: str, model: str, prompt: str) -> Result:
        self.calls += 1
        if self.mode == "fail":
            return Result(id=rid, backend="api", model=model, status="error", error=self.text, turns=1, finished=now_iso())
        answer = self.text if self.mode == "reply" else f"echo: {prompt}"
        return Result(id=rid, backend="api", model=model, status="ok", answer=answer, turns=1, finished=now_iso())

    def command(self, st: scripttest.State, args: list[str]) -> None:
        if not args or args[0] not in ("echo", "reply", "fail", "calls"):
            raise scripttest.UsageError("usage: api echo | reply TEXT | fail MESSAGE | calls N")
        if args[0] == "calls":
            if len(args) != 2 or not args[1].isdigit():
                raise scripttest.UsageError("usage: api calls N")
            if self.calls != int(args[1]):
                raise scripttest.ScriptError(f"{self.calls} api calls, want {args[1]}")
            return
        self.mode, self.text = args[0], " ".join(args[1:])


def hswarm_command(st: scripttest.State, args: list[str]) -> None:
    """`hswarm ARGS...`: cli.main in-process, its stdout and stderr kept for the next `stdout` / `stderr` / `cmp`.
    A SystemExit is an exit status like a real process's: argparse's 2, or a message on stderr and 1; an uncaught
    exception is a traceback on stderr and 1, as `python hswarm.py` would end."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            code = cli.main(list(args))
        except SystemExit as e:
            if e.code is None or isinstance(e.code, int):
                code = e.code or 0
            else:
                print(e.code, file=sys.stderr)
                code = 1
        except Exception:  # noqa: BLE001 - the script asserts on the traceback text like on any stderr
            traceback.print_exc()
            code = 1
    st.stdout, st.stderr = out.getvalue(), err.getvalue()
    if code:
        raise scripttest.ScriptError(f"exit status {code}")


@pytest.fixture
def stub_api(monkeypatch) -> StubApi:
    """Stub the api backend at its seams, so no line of a script can reach a provider.

    AUTO (the default model of `ask` and of every task that names none) goes through profile dispatch: the task's
    model is picked by selection.plan when it is built (spec.Task._normalised) and again by dispatch.run_selected /
    ask_selected, which import agent.run_api_task / agent.ask at call time. So the plan is one leg, the default
    model as resolved, whatever the keys on this machine (conftest points SECRETS_DIR at none); the runners are
    agent's (dispatch) and jobs' (the pinned-model path); the client lookup, the balance probe and the price
    route are JobManager's.

    The client is a bare object(): it has no key pool, so JobManager._gate_for returns None (no gate) and
    dispatch._dead reads it as alive. If either ever starts using a client with no pool, this fixture must
    stub it too, or a script run starts calling a provider."""
    api = StubApi()
    leg = config.resolve_model(config.DEFAULT_MODEL)

    async def fake_ask(client, prompt, model=None, **kw):
        return api.result("ask", model, prompt)

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        if warm is not None and is_pilot:
            warm.set()
        return api.result(task.id, task.model, task.prompt), [{"role": "user", "content": task.prompt}]

    async def no_probe(self, client):
        return None

    def one_leg(profile, **kw):
        return {"profile": profile, "candidates": [{"model": leg, "reasoning_effort": None, "thinking": None,
                                                    "benchmark_slug": leg}]}

    monkeypatch.setattr(selection, "plan", one_leg)
    monkeypatch.setattr(agent, "ask", fake_ask)
    monkeypatch.setattr(agent, "run_api_task", fake_run)
    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    monkeypatch.setattr(JobManager, "client_for", lambda self, model: object())
    monkeypatch.setattr(JobManager, "route_plan", lambda self, model, backend="api": [config.resolve_model(model)])
    monkeypatch.setattr(JobManager, "_park_broke_keys", no_probe)
    return api


@pytest.mark.parametrize("script", SCRIPTS, ids=[p.stem for p in SCRIPTS])
def test_cli_script(script, tmp_path, stub_api):
    try:
        scripttest.run(script, tmp_path / "work", commands={"hswarm": hswarm_command, "api": stub_api.command})
    except scripttest.Skip as e:
        pytest.skip(str(e))


# The engine's own contract: a script whose assertion does not hold must FAIL. An engine that swallowed errors
# would turn every script above green whatever the CLI printed, so each prefix is pinned both ways here.
@pytest.mark.parametrize("body,passes", [
    ("exists a.txt\n! exists b.txt\n? exists b.txt\ngrep '^hello world$' a.txt\n-- a.txt --\nhello world\n", True),
    ("exists b.txt\n-- a.txt --\nx\n", False),
    ("! exists a.txt\n-- a.txt --\nx\n", False),
    ("grep -count=2 x a.txt\n-- a.txt --\nx\n", False),
    ("cmp a.txt b.txt\n-- a.txt --\nx\n-- b.txt --\ny\n", False),
    ("[windows] [unix] exists nothing\nenv K='a b'\ngrep $K a.txt\n-- a.txt --\na b\n", True),
])
def test_engine_fails_what_does_not_hold(tmp_path, body, passes):
    script = tmp_path / "t.txtar"
    script.write_text(body, encoding="utf-8")
    if passes:
        scripttest.run(script, tmp_path / "work")
    else:
        with pytest.raises(AssertionError):
            scripttest.run(script, tmp_path / "work")
