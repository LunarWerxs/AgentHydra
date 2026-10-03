"""Where the Claude Code binary is and how a worker copy of it is configured to talk to DeepSeek.

The `cc` backend runs Anthropic's CLI headless with its base URL pointed at DeepSeek's
Anthropic-compatible endpoint, or at Hugging Face's or OpenRouter's when the route fails over to
them (config.PROVIDERS `anthropic_url`), or at a loopback facade for an OpenAI-only provider
(anthropic_facade.py). It gets its OWN config dir (~/.hswarm/claude-config): the
operator's ~/.claude login, hooks and settings must never leak into a worker, and a worker
must never write into them.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from . import config
from .procs import scrubbed_env

WORKER_CLAUDE_MD = """# hswarm worker

You are one autonomous worker in a swarm. An orchestrator reads your final message as data.
- Do exactly the task given. Never ask questions; state an assumption and continue.
- Final message = the answer only: concrete, file:line references, no preamble, no offers of help.
- If the task cannot be done, reply with one line starting with FAILED: and the reason.
"""


def claude_bin() -> str:
    env = os.environ.get("HSWARM_CLAUDE_BIN")
    if env and Path(env).exists():
        return env
    if sys.platform == "win32":
        # The npm global install is the usual home; `claude` on PATH is a .cmd shim that breaks stdin piping.
        c = Path(os.environ.get("APPDATA", "")) / "npm" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
        if c.exists():
            return str(c)
    w = shutil.which("claude")
    if w:
        return w
    raise RuntimeError("claude CLI not found; install @anthropic-ai/claude-code or set HSWARM_CLAUDE_BIN")


def claude_argv() -> list[str]:
    """The argv prefix that starts Claude Code. A `.py` HSWARM_CLAUDE_BIN (the offline replay mock,
    tests/mocks/bin/claude.py) runs under this interpreter, because Windows cannot exec a script by
    its shebang; anything else is the binary itself."""
    b = claude_bin()
    return [sys.executable, b] if b.lower().endswith(".py") else [b]


SHIELD = Path.home() / ".claude" / "tools" / "agent_shield.py"


def _shield_hook() -> dict:
    """The ONE hook a worker inherits. It screens what a worker writes and any page an MCP tool reads to it
    (cc._command hands a worker no web tool of Claude Code's own), which would otherwise pass with no
    prompt-injection screen at all - the operator's own sessions have had one since 2026-09-14. Absent on a machine with no shared
    home layer, in which case the worker simply has no hooks, as before.

    Exec form (`command` + `args`), never one shell string: on Jacob's PC the worker's Claude Code ran
    the old `"python.exe" "agent_shield.py" --hook` through PowerShell, which cannot parse a quoted exe
    followed by arguments, so every call was a hook_non_blocking_error and the shield never ran
    (job 20260925-102241-d995). Exec form reaches no shell at all."""
    if not SHIELD.exists():
        return {}
    return {"PostToolUse": [{
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|get_page_text|read_page",
        "hooks": [{"type": "command", "command": sys.executable.replace("\\", "/"),
                   "args": [str(SHIELD).replace("\\", "/"), "--hook"], "timeout": 10}],
    }]}


# How long Claude Code keeps a worker's own session transcripts (settings.json `cleanupPeriodDays`). Its default is
# 30 days. They are history to learn from, so Claude Code never deletes one (owner, Michael, 2026-10-02: "Ideally, we
# would keep all of it, and you would just figure out a way to properly compress"); `hswarm maintain` packs the ones
# past a day into the history store instead (history.py). hswarm itself reads them only to --resume a run on the
# next key inside ONE task (cc.saved_session).
CC_TRANSCRIPT_DAYS = 36500


def ensure_cc_config() -> Path:
    """Seed the worker config dir once: onboarding done, bypass permissions, the worker CLAUDE.md.
    The shield hook and the transcript retention are re-asserted every run, so a config seeded before
    either existed picks it up."""
    d = config.CC_CONFIG_DIR
    d.mkdir(parents=True, exist_ok=True)
    seeds = {
        ".claude.json": json.dumps({"hasCompletedOnboarding": True}),
        "settings.json": json.dumps({"permissions": {"defaultMode": "bypassPermissions"}, "includeCoAuthoredBy": False}, indent=2),
        "CLAUDE.md": WORKER_CLAUDE_MD,
    }
    for name, body in seeds.items():
        if not (d / name).exists():
            (d / name).write_text(body, encoding="utf-8")
    hooks = _shield_hook()
    wanted = {"cleanupPeriodDays": CC_TRANSCRIPT_DAYS, **({"hooks": hooks} if hooks else {})}
    settings_path = d / "settings.json"
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        settings = {"permissions": {"defaultMode": "bypassPermissions"}, "includeCoAuthoredBy": False}
    if any(settings.get(k) != v for k, v in wanted.items()):
        settings.update(wanted)
        settings_path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    return d


def cc_model_id(model: str | None) -> str:
    """The id Claude Code sends for `model`: DeepSeek's endpoint takes the registry name as it always has; any
    other provider gets its own id (`deepseek-ai/DeepSeek-V4.1-Flash:deepinfra` on Hugging Face)."""
    model = model or config.DEFAULT_MODEL
    return config.api_model_id(model)


def cc_env(api_key: str, model: str | None = None, envelope: dict | None = None, anthropic_url: str | None = None) -> dict:
    """The child's environment: the operator's scrubbed down to procs.scrubbed_env() (no provider keys, no cloud
    credentials, no Claude/Anthropic variables), the serving provider's put in. `model` picks the provider (DeepSeek when omitted); a provider with no `anthropic_url` cannot run cc.
    `anthropic_url` is the live endpoint when the provider's is the facade marker (anthropic_facade.anthropic_endpoint).
    `envelope` is the task's spawn envelope, handed on so a hswarm the worker starts inherits it narrowed; this
    process's own HSWARM_ENVELOPE never leaks through in its place (the shared server's belongs to nobody)."""
    model = model or config.DEFAULT_MODEL
    provider = config.provider_of(model)
    spec = config.PROVIDERS[provider]
    if not spec.get("anthropic_url"):
        raise RuntimeError(f"{provider} has no Anthropic-compatible endpoint, so it cannot run cc tasks")
    url = anthropic_url or spec["anthropic_url"]
    if url == config.ANTHROPIC_FACADE:
        raise RuntimeError(f"{provider} reaches cc through the loopback Anthropic facade, which runs only inside a cc run (cc.run_cc_task)")
    # Every model tier Claude Code might pick maps to the one model; there is no cheaper or dearer one to route to.
    tier = cc_model_id(model)
    if spec.get("anthropic_auth") == "bearer":
        auth = {"ANTHROPIC_AUTH_TOKEN": api_key}
    else:
        auth = {"ANTHROPIC_API_KEY": api_key}
    # scrubbed_env() already drops every name outside its allowlist (these included); the strip below still
    # holds when the operator widens that allowlist, so the operator's own Claude login never rides along.
    env = {k: v for k, v in scrubbed_env().items() if not (k.upper().startswith(("CLAUDE_CODE_", "ANTHROPIC_")) or k.upper() in ("CLAUDECODE", "CLAUDE_CONFIG_DIR"))}
    env.pop("HSWARM_ENVELOPE", None)
    if envelope:
        env["HSWARM_ENVELOPE"] = json.dumps(envelope, separators=(",", ":"))
    env.update(
        {
            "ANTHROPIC_BASE_URL": url,
            **auth,
            "ANTHROPIC_MODEL": tier,
            "ANTHROPIC_SMALL_FAST_MODEL": tier,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": tier,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": tier,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": tier,
            "CLAUDE_CONFIG_DIR": str(ensure_cc_config()),
            "AGENT_SHIELD_CALLER": "hswarm-cc",  # the shield ledger, and Connections' person-only Stop hooks, key on it
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            # A worker does one task and its answer is what carries over. With auto-memory on, its instructions
            # rode every request (system prompt 6,004 chars, 3,704 with this set) and workers left unreviewed
            # notes under projects/<cwd>/memory that later workers in that folder loaded (7 files by 2026-10-02).
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        }
    )
    if url.startswith("http://127.0.0.1:"):
        # WHY: the loopback facade must never be sent through an operator's HTTP(S)_PROXY, which cannot reach it.
        bypass = ",".join(filter(None, [env.get("NO_PROXY") or env.get("no_proxy"), "127.0.0.1", "localhost"]))
        env["NO_PROXY"] = env["no_proxy"] = bypass
    return env
