"""The one-file result loop for a `cc` worker: three Claude Code hooks that turn "write exactly one
result file and make it valid" from prose a worker can ignore into a contract it cannot.

An api worker gets this from submit_result: one call carries the answer and a missing required key
comes back as a tool error while the worker still has a turn. A cc worker is headless Claude Code,
which has no submit_result, so a task that names a `result_file` gets these instead:

- PreToolUse on the edit tools: every write that is not the result file is DENIED, and anything the
  hook cannot read (bad JSON, no path) is denied too - it fails closed. Every attempt is logged, one
  sanitised line each, so the orchestrator can see what a worker tried to touch.
- PostToolUse on the same tools: after a write to the result file the file is validated and any
  error goes back to the model as additionalContext; a valid file says nothing.
- Stop: a missing or invalid file blocks the stop ONCE (exit 2, the errors on stderr), so the worker
  fixes it while it still has a turn; `stop_hook_active` lets the second stop through, no loop.

The same `validate` reads the file after the run (cc.read_result_file), so a file that passed the
hook is exactly a file that publishes. The idea is from pytorch/pytorch's PR-review hooks
(.claude/hooks/pr_review/, BSD-3-Clause); this is written fresh for hswarm.

Stdlib only and runnable as a script: Claude Code runs it in the worker's own folder, where the
hswarm package is not importable. Usage: python result_hooks.py pre|post|stop <spec.json>
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

EDIT_TOOLS = {"Write": "file_path", "Edit": "file_path", "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}
MATCHER = "|".join(EDIT_TOOLS)
_JSON_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}
_UNSAFE = re.compile(r"[\x00-\x1f\x7f]")  # a path is model output: no control character reaches the log line
LOG_FIELD_CHARS = 300


def _type_ok(value, want) -> bool:
    kinds = want if isinstance(want, list) else [want]
    for k in kinds:
        if k == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return True
        if k == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if k in _JSON_TYPES and isinstance(value, _JSON_TYPES[k]):
            return True
    return not any(k in _JSON_TYPES or k in ("integer", "number") for k in kinds)  # an unknown type is not ours to refuse


def file_stamp(path: str | Path) -> int | None:
    """The result file's mtime in ns before launch, None when it did not exist. WHY: a valid file left by an
    earlier job, retry or key-rotation rerun would otherwise let the worker stop without writing and publish
    old data as this run's answer; a file whose stamp is unchanged was not written by this run."""
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def validate(path: str | Path, schema: dict | None, stale_stamp: int | None = None) -> tuple[object, list[str]]:
    """(parsed value, errors). No schema: the file must exist and say something. A schema: the file must be
    one JSON value of the schema's type with every required key, each top-level property of its declared type
    and inside its enum - the checks submit_result makes on the api backend, plus the types. `stale_stamp` is
    file_stamp() taken before launch: a file still carrying it is a leftover and counts as missing."""
    p = Path(path)
    if stale_stamp is not None and file_stamp(p) == stale_stamp:
        return None, [f"result file {p.as_posix()} was not written during this run (it is left from an earlier one); "
                      "write it fresh with the Write tool"]
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        return None, [f"result file {p.as_posix()} is missing or unreadable ({type(e).__name__}); write it with the Write tool"]
    if not text.strip():
        return None, [f"result file {p.as_posix()} is empty"]
    if not schema:
        return text, []
    try:
        value = json.loads(text)
    except ValueError as e:
        return None, [f"result file is not valid JSON: {e}; it must be ONE JSON value and nothing else (no fences, no prose)"]
    want = schema.get("type", "object")
    if not _type_ok(value, want):
        return value, [f"result file holds a {type(value).__name__}; the schema wants {want}"]
    errors: list[str] = []
    if isinstance(value, dict):
        missing = [k for k in schema.get("required") or [] if k not in value]
        if missing:
            errors.append("missing required keys: " + ", ".join(missing))
        for key, prop in (schema.get("properties") or {}).items():
            if key not in value or not isinstance(prop, dict):
                continue
            if "type" in prop and not _type_ok(value[key], prop["type"]):
                errors.append(f"{key}: expected {prop['type']}, got {type(value[key]).__name__}")
            elif "enum" in prop and value[key] not in prop["enum"]:
                errors.append(f"{key}: {value[key]!r} is not one of {prop['enum']}")
    return value, errors


def _same_file(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _target(event: dict) -> Path | None:
    """The path an edit tool call points at, resolved against the worker's cwd; None when there is none."""
    key = EDIT_TOOLS.get(event.get("tool_name") or "")
    raw = (event.get("tool_input") or {}).get(key) if key else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    p = Path(raw)
    return p if p.is_absolute() else Path(event.get("cwd") or os.getcwd()) / p


def _sanitise(text: object) -> str:
    s = _UNSAFE.sub("?", str(text))
    return s if len(s) <= LOG_FIELD_CHARS else s[:LOG_FIELD_CHARS] + "..."


def _log(spec: dict, decision: str, tool: object, path: object) -> None:
    log = spec.get("log")
    if not log:
        return
    line = f"{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')} {decision} {_sanitise(tool)} {_sanitise(path)}\n"
    try:
        with open(log, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass  # a lost log line must never turn an allowed write into a denied one


def pre(event: dict, spec: dict) -> tuple[int, str, str]:
    """Allow a write to the result file, deny every other one; unreadable input is denied (fail closed)."""
    target = _target(event)
    result = Path(spec["result_file"])
    if target is not None and _same_file(target, result):
        _log(spec, "allow", event.get("tool_name"), target)
        return 0, "", ""
    _log(spec, "deny", event.get("tool_name"), target if target is not None else "<no path>")
    return 2, "", (f"Denied: this task may write exactly one file, {result.as_posix()}. "
                   "Put everything you would write elsewhere into that file instead.")


def post(event: dict, spec: dict) -> tuple[int, str, str]:
    """Validate the result file after a write to it; errors go back as additionalContext, success is silent."""
    target = _target(event)
    if target is None or not _same_file(target, Path(spec["result_file"])):
        return 0, "", ""
    _, errors = validate(spec["result_file"], spec.get("schema"), spec.get("stale_stamp"))
    if not errors:
        return 0, "", ""
    ctx = "The result file does not validate yet - fix it before you finish:\n- " + "\n- ".join(errors)
    return 0, json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": ctx}}), ""


def stop(event: dict, spec: dict) -> tuple[int, str, str]:
    """Block the first stop while the result file is missing or invalid; the second stop always goes through."""
    if event.get("stop_hook_active"):
        return 0, "", ""
    _, errors = validate(spec["result_file"], spec.get("schema"), spec.get("stale_stamp"))
    if not errors:
        return 0, "", ""
    return 2, "", (f"Not done: the result file {Path(spec['result_file']).as_posix()} is not publishable:\n- "
                   + "\n- ".join(errors) + "\nFix it with the Write tool, then finish.")


HANDLERS = {"pre": pre, "post": post, "stop": stop}


def settings(spec_path: str | Path) -> dict:
    """The --settings block that wires the three hooks for one task, pointing at its spec file."""
    def cmd(phase: str) -> str:
        return f'"{sys.executable}" "{Path(__file__).resolve()}" {phase} "{Path(spec_path).resolve()}"'.replace("\\", "/")

    def hook(phase: str) -> list:
        return [{"type": "command", "command": cmd(phase), "timeout": 30}]

    return {"hooks": {
        "PreToolUse": [{"matcher": MATCHER, "hooks": hook("pre")}],
        "PostToolUse": [{"matcher": MATCHER, "hooks": hook("post")}],
        "Stop": [{"hooks": hook("stop")}],
    }}


def main(argv: list[str]) -> int:
    phase = argv[0] if argv else ""
    spec: dict = {}
    try:
        spec = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        event = json.loads(sys.stdin.read() or "{}")
        if not isinstance(event, dict):
            raise ValueError("hook input is not an object")
        code, out, err = HANDLERS[phase](event, spec)
    except Exception as e:  # noqa: BLE001 - whatever broke, the write limit holds
        if phase != "pre":
            return 0  # a broken validator must not wedge a worker; the post-run read still judges the file
        # Every attempt is logged, refusals of unreadable input included (no log path if the spec itself broke).
        if isinstance(spec, dict):
            _log(spec, "deny", "<unreadable>", type(e).__name__)
        code, out, err = 2, "", f"Denied: the one-file write guard could not read this call ({type(e).__name__}), so it refuses it."
    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
