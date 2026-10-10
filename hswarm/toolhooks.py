"""Claude Code hooks for the `api` backend's tool loop.

The operator's guard hooks (agent_shield, the git-write and secret guards) live in a Claude Code
settings.json and so only ever protected real Claude Code sessions: an `api` worker dispatches its
tools straight from Sandbox.run and ran with none of them. With HSWARM_API_HOOKS set, every tool
call is put through the same hooks with the Claude Code JSON payload, so one policy file covers
every agent on the machine. Semantics follow Claude Code's hook contract:

- PreToolUse: exit 2 (stderr is the reason), permissionDecision deny/ask, or the legacy decision
  "block" refuses the call; the worker reads the refusal as the tool's ERROR output. "ask" is a
  deny here: a headless worker has nobody to ask.
- PostToolUse: exit 2 or decision "block" hands the reason back beside the tool output, and
  additionalContext rides along the same way (the tool has already run).
- Stop: exit 2 or decision "block" on a final answer sends the reason back as a user turn and the
  worker keeps going, at most STOP_BLOCK_LIMIT times.

`command` hooks run through bash with the payload on stdin; `http` hooks get it POSTed, loopback
URLs only (a worker never calls out to a host the operator did not run on this machine). Any other
exit code, a non-2xx answer or a hook that cannot start is a non-blocking hook error, as in Claude
Code. HSWARM_API_HOOKS is unset or "off" by default; "claude" (or "on") means
~/.claude/settings.json; anything else is one or more settings.json / hooks.json paths joined with
os.pathsep.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from .procs import find_bash, run_hidden, scrubbed_env

ENV = "HSWARM_API_HOOKS"
EVENTS = ("PreToolUse", "PostToolUse", "Stop")
HOOK_TYPES = ("command", "http")
DEFAULT_TIMEOUT_S = 60  # Claude Code's own default for a hook
STOP_BLOCK_LIMIT = 3  # a Stop hook that never lets go must not eat the whole turn budget
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

# Our tool names -> the Claude Code names a hook's matcher is written against. A tool with no Claude Code
# twin (propose, fetch_output, job_*) keeps its own name, so only a "*" or explicit matcher sees it.
CC_NAMES = {"read_file": "Read", "write_file": "Write", "edit_file": "Edit", "list_dir": "LS", "glob": "Glob", "grep": "Grep",
            "bash": "Bash", "bash_start": "Bash", "read_url": "WebFetch", "web_search": "WebSearch"}

_CACHE: dict[tuple[str, float], dict] = {}
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def settings_paths(value: str | None = None) -> list[Path]:
    """The files HSWARM_API_HOOKS names; empty when hooks are off."""
    value = (os.environ.get(ENV, "") if value is None else value).strip()
    if value.lower() in ("", "0", "off", "false", "no"):
        return []
    if value.lower() in ("1", "on", "true", "yes", "claude"):
        return [Path.home() / ".claude" / "settings.json"]
    return [Path(p).expanduser() for p in value.split(os.pathsep) if p.strip()]


def plugin_root(path: Path) -> str | None:
    """The plugin directory a plugin's hooks.json lives under (<plugin>/hooks/hooks.json), else None.
    WHY: plugin hook commands are written as ${CLAUDE_PLUGIN_ROOT}/..., which Claude Code sets per plugin."""
    if path.name != "hooks.json":
        return None
    return str((path.parent.parent if path.parent.name == "hooks" else path.parent).resolve())


def _runnable(h: object) -> bool:
    if not isinstance(h, dict) or h.get("type", "command") not in HOOK_TYPES:
        return False
    return bool(h.get("url") if h.get("type") == "http" else h.get("command"))


def load_table(path: Path) -> dict[str, list[dict]]:
    """The command and http hooks of one settings.json (or a plugin hooks.json: the same shape, or bare events at the top).
    A named file that is missing, unreadable or malformed raises: a guard that silently is not there is worse than an error."""
    key = (str(path), path.stat().st_mtime)
    if key not in _CACHE:
        data = json.loads(path.read_text(encoding="utf-8"))
        hooks = data.get("hooks", data) if isinstance(data, dict) else {}
        if not isinstance(hooks, dict):
            raise ValueError(f"{path}: \"hooks\" is not an object")
        root = plugin_root(path)
        table: dict[str, list[dict]] = {}
        for event in EVENTS:
            groups = hooks.get(event) or []
            if not isinstance(groups, list) or not all(isinstance(g, dict) and isinstance(g.get("hooks") or [], list) for g in groups):
                raise ValueError(f"{path}: {event} is not a list of {{matcher, hooks: [...]}} groups")
            for group in groups:
                runs = [{**h, "plugin_root": root} if root else h for h in (group.get("hooks") or []) if _runnable(h)]
                if runs:
                    table.setdefault(event, []).append({"matcher": str(group.get("matcher") or ""), "hooks": runs})
        _CACHE[key] = table
    return _CACHE[key]


def matches(matcher: str, tool_name: str) -> bool:
    """Claude Code's matcher: empty or "*" is every tool, otherwise a regex over the whole tool name."""
    if matcher in ("", "*"):
        return True
    try:
        return re.fullmatch(matcher, tool_name) is not None
    except re.error:
        return matcher == tool_name


def _int(value: object) -> int | None:
    """A model-supplied number, or None when it is not one (WHY: "2m" or "abc" must not kill the task before the tool can say so)."""
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def cc_input(name: str, args: dict, cwd: Path) -> dict:
    """A tool call's arguments in the shape Claude Code hands its hooks; paths absolute, as Claude Code's are."""
    def absolute(p: object) -> str:
        raw = Path(str(p)) if p not in (None, "", ".") else cwd
        return str(raw if raw.is_absolute() else cwd / raw)

    if name == "read_file":
        out = {"file_path": absolute(args.get("path"))}
        start, end = _int(args.get("start_line")), _int(args.get("end_line"))
        if start:
            out["offset"] = start
        if end:
            out["limit"] = max(1, end - (start or 1) + 1)
        return out
    if name == "write_file":
        return {"file_path": absolute(args.get("path")), "content": args.get("content", "")}
    if name == "edit_file":
        return {"file_path": absolute(args.get("path")), "old_string": args.get("old_string", ""), "new_string": args.get("new_string", ""), "replace_all": bool(args.get("replace_all"))}
    if name == "list_dir":
        return {"path": absolute(args.get("path"))}
    if name in ("glob", "grep"):
        out = {"pattern": args.get("pattern", ""), "path": absolute(args.get("path"))}
        if args.get("glob"):
            out["glob"] = args["glob"]
        if args.get("ignore_case"):
            out["-i"] = True
        return out
    if name == "bash":
        timeout = _int(args.get("timeout_s"))
        return {"command": args.get("command", ""), **({"timeout": timeout * 1000} if timeout else {})}
    if name == "bash_start":
        return {"command": args.get("command", ""), "run_in_background": True}
    if name == "read_url":
        return {"url": args.get("url", ""), "prompt": ""}
    return dict(args)


def _json_out(stdout: str) -> dict:
    try:
        data = json.loads(stdout.strip() or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _post(h: dict, body: str) -> tuple[int, str, str]:
    """One http hook, as (exit, stdout, stderr): a 2xx body is its stdout, anything else a non-blocking error (exit 1).
    Header values may name only the environment variables the hook lists in allowedEnvVars, as in Claude Code."""
    url = str(h["url"])
    if (urlsplit(url).hostname or "").lower() not in LOOPBACK:
        return 1, "", f"not called: a worker runs only loopback http hooks ({url[:80]})"
    allowed = set(h.get("allowedEnvVars") or [])

    def env_var(m: re.Match) -> str:
        name = m.group(1) or m.group(2)
        return os.environ.get(name, "") if name in allowed else ""

    headers = {str(k): re.sub(r"\$\{(\w+)\}|\$(\w+)", env_var, str(v)) for k, v in (h.get("headers") or {}).items()}
    req = urllib.request.Request(url, data=body.encode("utf-8"), headers={"Content-Type": "application/json", **headers}, method="POST")
    try:
        # No proxy: a loopback hook must reach this machine, never a proxy that would carry the payload elsewhere.
        with _DIRECT.open(req, timeout=float(h.get("timeout") or DEFAULT_TIMEOUT_S)) as r:
            return 0, r.read().decode("utf-8", "replace"), ""
    except urllib.error.HTTPError as e:
        return 1, "", f"HTTP {e.code}"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return 1, "", f"{type(e).__name__}: {e}"


class ToolHooks:
    """The hook tables in force for one worker, plus the session identity its payloads carry."""

    def __init__(self, tables: list[dict[str, list[dict]]], cwd: str | os.PathLike, session_id: str):
        self.tables = tables
        self.cwd = Path(cwd).resolve()
        self.session_id = session_id
        self.stop_blocks = 0
        self.errors: list[str] = []  # non-blocking hook failures, surfaced on the tool output (take_errors) so a guard that did not run shows

    def _hooks(self, event: str, tool_name: str | None) -> list[dict]:
        return [h for t in self.tables for g in t.get(event, []) if tool_name is None or matches(g["matcher"], tool_name) for h in g["hooks"]]

    async def _one(self, h: dict, body: str) -> tuple[int, str, str]:
        if h.get("type") == "http":
            return await asyncio.to_thread(_post, h, body)
        sh = find_bash()
        if not sh:
            return 1, "", "no bash to run hooks with"
        # The worker child environment (procs.scrubbed_env): the payload is worker-made, the provider keys stay out.
        env = scrubbed_env({"CLAUDE_PROJECT_DIR": str(self.cwd), **({"CLAUDE_PLUGIN_ROOT": h["plugin_root"]} if h.get("plugin_root") else {})})
        return await run_hidden([sh, "-c", h["command"]], self.cwd, float(h.get("timeout") or DEFAULT_TIMEOUT_S), env=env, stdin_text=body)

    async def _fire(self, event: str, tool_name: str | None, payload: dict) -> list[tuple[int, str, str]]:
        hooks = self._hooks(event, tool_name)
        if not hooks:
            return []
        body = json.dumps({"session_id": self.session_id, "transcript_path": "", "cwd": str(self.cwd), "permission_mode": "bypassPermissions", "hook_event_name": event, **payload})
        # Claude Code runs the matching hooks of one event in parallel; so do we. A hook that cannot even be
        # started is a non-blocking hook error, not a dead worker.
        runs = await asyncio.gather(*(self._one(h, body) for h in hooks), return_exceptions=True)
        results = [(1, "", f"{type(r).__name__}: {r}") if isinstance(r, BaseException) else r for r in runs]
        for h, (code, _out, err) in zip(hooks, results):
            if code not in (0, 2):
                self.errors.append(f"{event} hook `{str(h.get('command') or h.get('url'))[:120]}` failed (exit {code}): {(err or '').strip()[:300]}")
        return results

    def take_errors(self) -> str:
        """The hook failures since the last call, as notes for the tool output; "" when every hook ran."""
        notes, self.errors = self.errors, []
        return "".join(f"\n\n[hook error] {n}" for n in notes)

    async def pre(self, name: str, args: dict) -> str | None:
        """The refusal reason when a PreToolUse hook denies this call, else None."""
        cc_name = CC_NAMES.get(name, name)
        reasons = []
        # A batched read_file is one hook call per file, so a hook that denies one listed file still sees it.
        singles = [{"path": f} if isinstance(f, str) else f for f in args["paths"]] if name == "read_file" and args.get("paths") else [args]
        fired = [hit for single in singles for hit in await self._fire("PreToolUse", cc_name, {"tool_name": cc_name, "tool_input": cc_input(name, single, self.cwd)})]
        for code, out, err in fired:
            if code == 2:
                reasons.append(err.strip() or "denied by a PreToolUse hook (exit 2)")
                continue
            if code != 0:
                continue
            data = _json_out(out)
            spec = data.get("hookSpecificOutput") or {}
            if isinstance(spec, dict) and spec.get("permissionDecision") in ("deny", "ask"):
                reasons.append(str(spec.get("permissionDecisionReason") or f"PreToolUse hook decision: {spec['permissionDecision']}"))
            elif data.get("decision") == "block":
                reasons.append(str(data.get("reason") or "blocked by a PreToolUse hook"))
            elif data.get("continue") is False:
                reasons.append(str(data.get("stopReason") or "a PreToolUse hook asked to stop"))
        return "; ".join(reasons) or None

    async def post(self, name: str, args: dict, output: str) -> str:
        """Hook feedback to append to the tool's output: the block reasons and any added context, or ""."""
        cc_name = CC_NAMES.get(name, name)
        response = {"output": output, **({"stdout": output} if cc_name == "Bash" else {})}
        notes = []
        for code, out, err in await self._fire("PostToolUse", cc_name, {"tool_name": cc_name, "tool_input": cc_input(name, args, self.cwd), "tool_response": response}):
            if code == 2:
                notes.append(err.strip() or "flagged by a PostToolUse hook (exit 2)")
                continue
            if code != 0:
                continue
            data = _json_out(out)
            if data.get("decision") == "block":
                notes.append(str(data.get("reason") or "flagged by a PostToolUse hook"))
            spec = data.get("hookSpecificOutput") or {}
            if isinstance(spec, dict) and spec.get("additionalContext"):
                notes.append(str(spec["additionalContext"]))
        return "".join(f"\n\n[PostToolUse hook] {n}" for n in notes)

    async def stop(self, answer: str) -> str | None:
        """The reason to keep working when a Stop hook blocks the final answer, else None. Bounded by STOP_BLOCK_LIMIT."""
        if self.stop_blocks >= STOP_BLOCK_LIMIT:
            return None
        reasons = []
        for code, out, err in await self._fire("Stop", None, {"stop_hook_active": self.stop_blocks > 0, "last_assistant_message": answer}):
            if code == 2:
                reasons.append(err.strip() or "a Stop hook asked the worker to continue")
            elif code == 0 and _json_out(out).get("decision") == "block":
                reasons.append(str(_json_out(out).get("reason") or "a Stop hook asked the worker to continue"))
        if not reasons:
            return None
        self.stop_blocks += 1
        return "; ".join(reasons)


def for_task(cwd: str | os.PathLike, session_id: str) -> ToolHooks | None:
    """The hooks a worker runs under, or None when HSWARM_API_HOOKS is off or its files hold no hooks."""
    paths = settings_paths()
    if not paths:
        return None
    try:
        tables = [t for t in (load_table(p) for p in paths) if t]
    except (OSError, ValueError, AttributeError, TypeError) as e:
        raise ValueError(f"{ENV}: cannot load hooks: {e}") from e
    commands = any(h.get("type", "command") == "command" for t in tables for groups in t.values() for g in groups for h in g["hooks"])
    if commands and find_bash() is None:
        # Refuse rather than run every call unguarded: a guard that silently is not there is worse than an error.
        raise ValueError(f"{ENV}: command hooks are configured but no bash is installed to run them")
    return ToolHooks(tables, cwd, session_id) if tables else None
