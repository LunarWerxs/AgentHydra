"""Offline: the `cc` backend's reading of Claude Code's output - no process is spawned."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import cc  # noqa: E402
import pytest  # noqa: E402

from hswarm.spec import Result, Task  # noqa: E402


def _stream(*events: dict) -> str:
    return "\n".join(json.dumps(e) for e in events) + "\n"


def _task(tmp_path, **kw) -> Task:
    return Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "cc", "tools": "all", "confirm_write": True, **kw}, {}, 0)


def test_an_edit_task_with_no_system_gets_the_ladder_brief_on_both_backends(tmp_path, monkeypatch):
    # Pins the code_brief default: the edit preset gets the ladder on cc and api, a caller's system wins,
    # "" opts out, and a read task is left alone.
    from hswarm.code_brief import CODE_BRIEF
    from hswarm.worker import build_messages

    def cc_system(**kw):
        cmd = cc._command(_task(tmp_path, **kw))
        return cmd[cmd.index("--append-system-prompt") + 1] if "--append-system-prompt" in cmd else None

    assert cc_system(tools="edit") == CODE_BRIEF
    assert cc_system(tools="edit", system="mine") == "mine"
    assert cc_system(tools="edit", system="") is None
    assert cc_system(tools="read") is None
    def api(**kw):
        return build_messages(Task.from_dict({"prompt": "x", "cwd": str(tmp_path), **kw}, {}, 0))[0]["content"]

    assert CODE_BRIEF in api(tools="edit")
    assert CODE_BRIEF not in api(tools="edit", system="mine") and CODE_BRIEF not in api(tools="read")


def _tool_use(name: str, **inp) -> dict:
    return {"type": "tool_use", "id": f"tu-{name}", "name": name, "input": inp}


def test_edited_files_come_from_the_workers_own_tool_calls_not_the_shared_tree(tmp_path):
    # On a checkout twenty sessions share, a git-status diff attributed every peer's edit to the
    # worker (measured 2026-09-15: a worker that touched 2 files was credited with 36).
    target = tmp_path / "src" / "a.ts"
    out = _stream(
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"content": [_tool_use("Read", file_path=str(target)), _tool_use("Edit", file_path=str(target))]}},
        {"type": "assistant", "message": {"content": [_tool_use("Write", file_path=str(tmp_path / "b.md")), _tool_use("Bash", command="bun test")]}},
        {"type": "result", "subtype": "success", "is_error": False, "num_turns": 3, "result": "done", "usage": {"input_tokens": 10, "output_tokens": 5}},
    )
    final, tool_calls, edited = cc._parse_stream(out)
    assert final["result"] == "done" and tool_calls == 4
    assert cc._relative_paths(edited, str(tmp_path)) == ["b.md", "src/a.ts"]


def test_the_tool_trace_keeps_every_call_in_order_with_its_input_cut_short(tmp_path):
    # `hswarm comply` grades a rule by the ORDER of what the worker did (test before commit), which the
    # call count and the edited-paths list cannot tell.
    out = _stream(
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "plan"}, _tool_use("Bash", command="git commit -m x")]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
        {"type": "assistant", "message": {"content": [_tool_use("Bash", command="pytest -q"), _tool_use("Write", file_path="a.md", content="y" * 5000)]}},
        {"type": "result", "subtype": "success", "is_error": False, "num_turns": 2, "result": "done", "usage": {}},
    )
    trace = cc.tool_trace(out)
    assert [(c["tool"], json.loads(c["input"]).get("command")) for c in trace[:2]] == [("Bash", "git commit -m x"), ("Bash", "pytest -q")]
    assert trace[2]["tool"] == "Write" and len(trace[2]["input"]) == cc.TRACE_INPUT_CHARS


async def test_a_finished_run_journals_its_tool_trace_in_the_transcript(tmp_path, monkeypatch):
    # `hswarm comply` reads the trace from the journaled transcript, not from tool_trace() itself: without
    # this wiring every scenario grades as "did nothing" while the parser tests still pass.
    out = _stream(
        {"type": "assistant", "message": {"content": [_tool_use("Bash", command="pytest -q"), _tool_use("Bash", command="git commit -m x")]}},
        {"type": "result", "subtype": "success", "is_error": False, "num_turns": 2, "result": "done", "usage": {}},
    )

    async def fake_run_hidden(cmd, cwd, timeout_s, env=None, stdin_text=None, on_line=None):
        return 0, out, ""

    monkeypatch.setattr(cc, "run_hidden", fake_run_hidden)
    monkeypatch.setattr(cc, "_command", lambda task, *a: ["claude"])
    monkeypatch.setattr(cc, "cc_env", lambda api_key, model, **kw: {})
    monkeypatch.setattr(cc.config, "CC_CONFIG_DIR", tmp_path / "claude-config")

    res, transcript = await cc.run_cc_task(_task(tmp_path), "sk-test")
    assert res.status == "ok" and res.tool_calls == 2
    assert [json.loads(c["input"])["command"] for c in transcript["tool_trace"]] == ["pytest -q", "git commit -m x"]


def test_a_turn_cap_stop_says_so_instead_of_printing_stderr_noise(tmp_path):
    # Three of seven tasks in one batch ended this way and each read as a trust-dialog warning.
    task = _task(tmp_path, max_turns=60)
    res = Result(id="t", backend="cc")
    final = {"type": "result", "subtype": "error_max_turns", "is_error": True, "num_turns": 61, "result": "", "usage": {}}
    noise = (
        "Ignoring 80 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.\n"
        '[claude-code:unrecognized_model] {"model":"deepseek-flash","query_source":"sdk"}\n'
    )
    cc._read_reply(res, task, final, 1, noise)
    assert res.status == "error" and res.turns == 61
    assert "max_turns" in res.error and "60" in res.error, res.error
    assert "permissions.allow" not in res.error and "unrecognized_model" not in res.error, res.error


def test_a_genuine_crash_still_shows_the_real_stderr(tmp_path):
    res = Result(id="t", backend="cc")
    noise_and_real = "Ignoring 80 permissions.allow entries from .claude/settings.json\nError: ENOENT spawn bun\n"
    cc._read_reply(res, _task(tmp_path), {"is_error": True, "result": ""}, 1, noise_and_real)
    assert res.status == "error" and "ENOENT spawn bun" in res.error and "permissions.allow" not in res.error


def test_a_worker_inherits_the_prompt_injection_shield_even_if_its_config_predates_it(tmp_path, monkeypatch):
    # A cc worker can WebFetch; without this it reads the web with no screen, and the config dir is
    # seeded once, so "only when the file is absent" would never reach an existing worker config.
    from hswarm import claude_env

    cfg = tmp_path / "claude-config"
    shield = tmp_path / "agent_shield.py"
    shield.write_text("# stand-in", encoding="utf-8")
    monkeypatch.setattr(claude_env.config, "CC_CONFIG_DIR", cfg)
    monkeypatch.setattr(claude_env, "SHIELD", shield)
    cfg.mkdir(parents=True)
    (cfg / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}), encoding="utf-8")

    claude_env.ensure_cc_config()
    settings = json.loads((cfg / "settings.json").read_text(encoding="utf-8"))
    hook = settings["hooks"]["PostToolUse"][0]
    assert "WebFetch" in hook["matcher"]
    # Exec form, no shell: the worker's Claude Code ran the old shell-form string through PowerShell,
    # which cannot parse a quoted exe followed by arguments, so the shield never ran (2026-09-25).
    entry = hook["hooks"][0]
    assert entry["command"] == sys.executable.replace("\\", "/")
    assert entry["args"] == [str(shield).replace("\\", "/"), "--hook"]
    assert settings["permissions"]["defaultMode"] == "bypassPermissions"  # the seed survives

    monkeypatch.setattr(claude_env, "SHIELD", tmp_path / "missing.py")  # a machine without the home layer
    (cfg / "settings.json").write_text(json.dumps({"permissions": {}}), encoding="utf-8")
    claude_env.ensure_cc_config()
    assert "hooks" not in json.loads((cfg / "settings.json").read_text(encoding="utf-8"))


def test_a_worker_is_marked_as_one_so_a_repos_person_only_stop_hooks_stay_silent(tmp_path, monkeypatch):
    # Connections' Stop hooks key on this exact value (.claude/hooks/hook-optout.mjs isSwarmWorker):
    # session-commit-gate told every worker to commit files its brief forbids it to commit, and on
    # 2026-09-17 three of seven coding workers hit max_turns with no final report. Renaming it here
    # re-arms that nag, and arkitect-watch's re-wake, in every cc worker, silently.
    from hswarm import claude_env

    monkeypatch.setattr(claude_env.config, "CC_CONFIG_DIR", tmp_path / "claude-config")
    monkeypatch.setenv("AGENT_SHIELD_CALLER", "an-operators-own-session")
    assert claude_env.cc_env("sk-ds")["AGENT_SHIELD_CALLER"] == "hswarm-cc"


def test_the_task_folder_is_trusted_in_the_workers_own_config(tmp_path, monkeypatch):
    cfg = tmp_path / "claude-config"
    monkeypatch.setattr(cc.config, "CC_CONFIG_DIR", cfg)
    repo = tmp_path / "repo"
    repo.mkdir()
    cc.trust_project(str(repo))
    cc.trust_project(str(repo))  # idempotent
    data = json.loads((cfg / ".claude.json").read_text(encoding="utf-8"))
    key = str(repo).replace("\\", "/")
    assert data["projects"][key]["hasTrustDialogAccepted"] is True
    assert data.get("hasCompletedOnboarding") is True  # the seed survives the merge


def test_a_cc_task_defaults_to_a_turn_budget_above_a_big_repos_orientation_cost(tmp_path):
    # 2026-09-19, Connections: 18 of 18 cc workers died at max_turns 24 (or 18) with correct edits on disk and no
    # report; the orientation floor for a one-file edit was ~19 turns. An api task keeps its own, smaller default.
    from hswarm import config

    assert _task(tmp_path).max_turns == config.DEFAULT_MAX_TURNS["cc"] == 40
    api = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "api", "tools": "none"}, {}, 0)
    assert api.max_turns == config.DEFAULT_MAX_TURNS["api"] == 24
    assert _task(tmp_path, max_turns=7).max_turns == 7  # a named budget still wins


def test_a_lean_cc_worker_skips_the_projects_own_settings_and_memory(tmp_path, monkeypatch):
    # Measured 2026-09-24 against a local probe endpoint from the Connections checkout: the first request was
    # 138.7k chars with AGENTS.md in it; with --setting-sources user it was 84.6k, AGENTS.md gone, the worker's
    # own CLAUDE.md and the user-level shield hook kept. --bare (6.5k) was rejected: it drops both of those.
    lean = cc._command(_task(tmp_path, lean=True))
    assert lean[lean.index("--setting-sources") + 1] == "user" and "--bare" not in lean
    assert "--setting-sources" not in cc._command(_task(tmp_path))


def test_a_cc_worker_is_not_handed_a_budget_claude_code_prices_at_anthropic_rates(tmp_path, monkeypatch):
    # 2026-09-25, job 20260925-053205-45c1: Claude Code billed a DeepSeek turn at ~63x its real cost, so a
    # --max-budget-usd of the task's 0.25 stopped 4 of 4 full-context Connections workers after 2 turns.
    assert "--max-budget-usd" not in cc._command(_task(tmp_path, max_cost_usd=0.25))


def test_a_tool_name_nothing_knows_is_refused_before_claude_code_starts(tmp_path):
    # It used to reach the allowlist below and run a paid read-only session that could not write (cc-tool-typo,
    # 2026-10-02); the allowlist case for it is gone with the input.
    with pytest.raises(ValueError, match="unknown tools"):
        _argv(tmp_path, tools="no_such_tool")


def _argv(tmp_path, **kw) -> list[str]:
    return cc._command(Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "cc", **kw}, {}, 0))


def _flag(argv: list[str], name: str) -> str | None:
    return argv[argv.index(name) + 1] if name in argv else None


@pytest.mark.parametrize("tools", ["read", ["read_file", "grep"], "read_file,glob"])  # `none` is narrower: test_cc_lean
def test_a_read_only_worker_runs_on_an_allowlist_that_denies_what_it_does_not_name(tmp_path, tools):
    # A denylist let through whatever it forgot (WebFetch, Agent, a new MCP tool), and a tools LIST matched no
    # preset at all, so ["read_file", "grep"] ran with every permission bypassed.
    argv = _argv(tmp_path, tools=tools)
    assert "--dangerously-skip-permissions" not in argv
    assert _flag(argv, "--permission-mode") == "dontAsk"
    assert _flag(argv, "--allowedTools") == "Read,Grep,Glob"
    assert set(_flag(argv, "--disallowedTools").split(",")) >= {"Edit", "Write", "Bash", "NotebookEdit"}  # the belt stays


@pytest.mark.parametrize("tools", ["edit", "all", ["read_file", "write_file"], "bash"])
def test_widening_a_cc_worker_takes_the_write_preset_and_confirm_write(tmp_path, tools):
    with pytest.raises(ValueError, match="confirm_write"):
        _argv(tmp_path, tools=tools)
    argv = _argv(tmp_path, tools=tools, confirm_write=True)
    assert "--dangerously-skip-permissions" in argv and "--allowedTools" not in argv
    assert (_flag(argv, "--disallowedTools") == "Bash,PowerShell") == (tools in ("edit", ["read_file", "write_file"]))


def test_a_write_task_built_around_the_validator_still_gets_the_read_only_argv(tmp_path):
    t = _task(tmp_path, tools="read")
    t.tools = "all"  # widened after validation, confirm_write never set
    t.confirm_write = False
    assert "--dangerously-skip-permissions" not in cc._command(t)
    assert _flag(cc._command(t), "--permission-mode") == "dontAsk"


def test_an_isolated_worker_loads_no_mcp_server_and_none_of_the_task_folders_settings(tmp_path):
    argv = _argv(tmp_path, tools="read", isolated=True)
    assert _flag(argv, "--setting-sources") == "user" and "--strict-mcp-config" in argv
    plain = _argv(tmp_path, tools="read")
    assert "--setting-sources" not in plain and "--strict-mcp-config" not in plain
    # isolated is lean plus --strict-mcp-config: asking for both emits one --setting-sources, never two.
    both = _argv(tmp_path, tools="read", isolated=True, lean=True)
    assert both.count("--setting-sources") == 1 and _flag(both, "--setting-sources") == "user" and "--strict-mcp-config" in both
    lean = _argv(tmp_path, tools="read", lean=True)
    assert _flag(lean, "--setting-sources") == "user" and "--strict-mcp-config" not in lean


