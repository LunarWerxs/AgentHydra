"""Offline: what a cc worker is started with (its tools, its settings, its config dir) and the cost cap
that stops it mid-run. The cap tests cross the real process boundary through the replay mock."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import anthropic_facade as af  # noqa: E402
from hswarm import cc, claude_env, config  # noqa: E402
from hswarm.spec import Task  # noqa: E402

KEY = "sk-mock-not-a-real-key"


def _task(tmp_path, **kw) -> Task:
    return Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "cc", **kw}, {}, 0)


def _flag(argv: list[str], name: str) -> str | None:
    return argv[argv.index(name) + 1] if name in argv else None


def _handed(tmp_path, **kw) -> set[str]:
    return set(_flag(cc._command(_task(tmp_path, **kw)), "--tools").split(","))


def test_each_tier_is_handed_only_the_built_in_tools_it_works_with(tmp_path):
    # The permission flags only deny a call: Claude Code still sent every built-in schema on each request
    # (2026-10-02: a read worker's first request was 65,757 chars, 19,465 with --tools Read,Grep,Glob).
    assert _handed(tmp_path, tools="read") == {"Read", "Grep", "Glob"}
    assert _handed(tmp_path, tools="read", result_file="out.json") == {"Read", "Grep", "Glob", "Write"}
    edit = _handed(tmp_path, tools="edit", confirm_write=True)
    full = _handed(tmp_path, tools="all", confirm_write=True)
    assert {"Read", "Edit", "Write"} <= edit and not edit & {"Bash", "PowerShell"}
    assert full == edit | {"Bash", "PowerShell"}
    assert not full & {"Agent", "Task", "Workflow", "WebFetch", "WebSearch", "Skill"}


def test_a_none_task_skips_the_task_folders_instructions_and_a_read_task_keeps_them(tmp_path):
    # A reviewer (read) judges code against the folder's house rules, so lean stays its caller's choice.
    none = cc._command(_task(tmp_path, tools="none"))
    assert _flag(none, "--setting-sources") == "user" and "--strict-mcp-config" not in none
    assert "--setting-sources" not in cc._command(_task(tmp_path, tools="read"))


def _repo_task(tmp_path, **kw) -> Task:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    return _task(repo, model=config.DEFAULT_MODEL, tools="all", confirm_write=True, timeout_s=60, **kw)


def test_a_worker_that_reaches_its_cost_cap_is_stopped_before_its_next_model_call(tmp_path, mock_claude):
    # 30 days to 2026-10-02: 23 cc tasks overran their caps by $11.04, the worst $1.99 on a $0.25 cap, because
    # nothing compared a cc run's spend with max_cost_usd while it ran.
    mock_claude("edit-session")
    task = _repo_task(tmp_path, max_cost_usd=0.0001)
    res, transcript = asyncio.run(cc.run_cc_task(task, KEY))

    assert res.status == "error" and res.error.startswith("cost budget exceeded"), res.error
    # Stopped at the first call's Read: the second call, with the Edit, was never read from the stream.
    assert res.turns == 1 and res.tool_calls == 1 and res.files_changed == []
    assert [c["tool"] for c in transcript["tool_trace"]] == ["Read"]
    # The first call's prompt as the stream reported it; its output is never priced below what it wrote.
    assert res.usage["in_miss"] == 520 and res.usage["in_write"] == 100 and res.usage["out"] >= 30
    assert res.cost_usd >= task.max_cost_usd


def test_a_final_answer_that_crosses_the_cap_is_kept(tmp_path, mock_claude):
    # The cap prevents the NEXT request. An answer that is already paid for is not thrown away.
    mock_claude("answer-over-cap")
    task = _repo_task(tmp_path, max_cost_usd=0.0001)
    res, _ = asyncio.run(cc.run_cc_task(task, KEY))
    assert res.status == "ok" and res.answer == "notes.md has no status line", res.error
    assert res.cost_usd > task.max_cost_usd


def _read_call(usage: dict, path: str = "notes.md") -> dict:
    return {"type": "assistant", "message": {"id": "msg_1", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": path}}], "usage": usage}}


def test_a_worker_at_its_cost_checkpoint_is_resumed_once_to_wrap_up_and_its_answer_is_kept(tmp_path, monkeypatch):
    # An unnamed cap is $0.25, so every cc task has one: a hard stop there ended a task that used to finish as an
    # error with no answer. At checkpoint_at (0.8) of the cap the session is resumed with a few turns to answer in.
    usage = {"input_tokens": 1000, "output_tokens": 500}
    call_cost = config.cost_usd(config.DEFAULT_MODEL, 0, 1000, 500)
    task = _repo_task(tmp_path, max_cost_usd=call_cost / 0.9)  # the first call lands between the checkpoint and the cap
    runs, stopped = [], []

    async def fake_claude(cmd, cwd, timeout_s, env=None, stdin_text=None, on_line=None):
        runs.append((cmd, stdin_text))
        if len(runs) == 1:
            # Claude Code keeps the conversation under the id it was started with, which is what --resume continues.
            saved = config.CC_CONFIG_DIR / "projects" / "repo" / f"{_flag(cmd, '--session-id')}.jsonl"
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_text("{}\n", encoding="utf-8")
            line = json.dumps(_read_call(usage))
            stopped.append(on_line(line))
            return 1, line + "\n", ""
        answer = "notes.md read\nREMAINING: set the status line"
        return 0, "\n".join(json.dumps(e) for e in (
            {"type": "assistant", "message": {"id": "msg_2", "content": [{"type": "text", "text": answer}], "usage": usage}},
            {"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "result": answer, "usage": usage})) + "\n", ""

    monkeypatch.setattr(cc, "run_hidden", fake_claude)
    res, transcript = asyncio.run(cc.run_cc_task(task, KEY))

    assert stopped == [True] and len(runs) == 2
    first, (wrap_up, said) = runs[0][0], runs[1]
    assert _flag(wrap_up, "--resume") == _flag(first, "--session-id") and _flag(wrap_up, "--max-turns") == str(cc.WRAP_UP_TURNS)
    assert said == cc.WRAP_UP_PROMPT and _flag(wrap_up, "--tools") == _flag(first, "--tools")
    assert res.status == "ok" and res.answer.endswith("REMAINING: set the status line"), res.error
    # Both runs are the task's spend and work: the stopped run's call and Read are not lost with its process.
    assert abs(res.cost_usd - 2 * call_cost) < 1e-12 and res.turns == 2 and res.tool_calls == 1
    assert [c["tool"] for c in transcript["tool_trace"]] == ["Read"]


def test_a_call_whose_stream_usage_is_zero_is_still_priced_by_what_it_wrote(tmp_path):
    # Claude Code reports the usage a call OPENED with, and a facade-served call (gemini, groq, cerebras) opened
    # with zeros: every call totalled $0 and the cap never tripped.
    watch = cc._SpendWatch(_repo_task(tmp_path, max_cost_usd=0.0001, checkpoint_at=0))
    assert watch(json.dumps(_read_call({"input_tokens": 0, "output_tokens": 0}, path="a/" * 2000))) is True
    assert watch.spent()[0]["out"] >= 1000


async def test_a_facade_served_call_opens_with_an_estimated_prompt_size():
    # The upstream's own token count arrives with the last chunk, after Claude Code has built the event the cost
    # cap reads, so message_start carries the same chars/4 estimate count_tokens answers with.
    stream = "data: " + json.dumps({"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]}) + "\n\ndata: [DONE]\n\n"

    def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=stream, headers={"content-type": "text/event-stream"})

    async with af.Facade("groq", transport=httpx.MockTransport(upstream)) as f:
        async with httpx.AsyncClient(base_url=f.url) as client:
            r = await client.post("/v1/messages", headers={"x-api-key": "gsk-test"},
                                  json={"model": "openai/gpt-oss-120b", "max_tokens": 10, "stream": True, "messages": [{"role": "user", "content": "x" * 400}]})
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert events[0]["type"] == "message_start" and events[0]["message"]["usage"]["input_tokens"] >= 100


def test_a_worker_config_seeded_before_the_retention_setting_gets_it(tmp_path, monkeypatch):
    # Claude Code deletes session transcripts after 30 days by default; they are history the owner keeps (2026-10-02),
    # so a config seeded before the setting must get it too. No shield here: the setting must not ride on the hook.
    cfg = config.CC_CONFIG_DIR
    cfg.mkdir(parents=True)
    monkeypatch.setattr(claude_env, "SHIELD", tmp_path / "missing.py")
    (cfg / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}), encoding="utf-8")

    claude_env.ensure_cc_config()
    settings = json.loads((cfg / "settings.json").read_text(encoding="utf-8"))
    assert settings["cleanupPeriodDays"] >= 36500  # Claude Code never deletes a worker transcript; maintain packs them
    assert settings["permissions"]["defaultMode"] == "bypassPermissions"  # the seed survives


# Pin that a tool-free task is handed no built-in tools unless it has files or a result file.
def test_a_tool_free_task_is_handed_no_built_in_tools(tmp_path):
    bare = cc._command(_task(tmp_path, tools="none"))
    assert _flag(bare, "--tools") == "" and _flag(bare, "--permission-mode") == "dontAsk"
    assert "--dangerously-skip-permissions" not in bare and "--allowedTools" not in bare
    assert set(_flag(bare, "--disallowedTools").split(",")) >= {"Edit", "Write", "Bash", "NotebookEdit"}  # the belt stays
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    assert _flag(cc._command(_task(tmp_path, tools="none", files=[str(tmp_path / "notes.txt")])), "--tools") == "Read"
    assert _handed(tmp_path, tools="none", result_file="out.json") == {"Read", "Grep", "Glob", "Write"}
