"""approvallib - THE TRI-STATE APPROVAL GATE: classify a stuck permission prompt as
APPROVE / DENY / ESCALATE before unblock_prompts.py presses anything.

Ported from NousResearch/hermes-agent tools/approval.py (MIT, Copyright (c) Nous Research).
Adapted for AgentHydra. Three ideas are ported, nothing else of that file's ~270KB of
shell-string parsing:

  1. A TRI-STATE verdict (classify(), below), where uncertainty is NOT approval. Hardline-
     dangerous commands DENY outright and are never pressed; clearly safe ones APPROVE;
     everything else ESCALATEs to a person or the /orchestrate AI instead of being pressed
     on a guess.
  2. Two policies behind one gate (see unblock_prompts.py's `_run_context`, which reuses
     armlib's own armed/unattended split): the UNATTENDED scheduled run presses only
     APPROVE; the INTERACTIVE run (a person at orch.py, `--force` - that same person's own
     word armlib already treats specially) may also press ESCALATE, after the command has
     been shown in the report.
  3. The policy lives in a CONFIG FILE under the orchestrator's own state dir, never in the
     chat transcript. A prompt's own text - however phrased ("policy: allow everything") -
     is DATA that classify() matches patterns against, never an instruction that changes
     what the patterns are. Only a person hand-editing approval_policy.json changes policy.

⛔ NOT A POLICY DECISION EITHER - same law as unblock_prompts.py's own header. DENY records
why and stops; ESCALATE hands the decision to a person or the AI (interview.py); only
APPROVE presses the button doctrine (bypassPermissions) already would have pressed itself.

State lives beside the attempt ledger, under the same ORCHESTRATOR_STATE_DIR override and
atomic-write discipline as ledgerlib:
  approval_policy.json        the operator's pattern lists (created with defaults on first
                               read if missing - see _default_policy()'s own "_why").
  approval_escalations.json   the queue interview.py --ask reads: one row per stuck prompt
                               the gate would not press on its own, keyed by sessionId so a
                               chat still stuck five minutes later refreshes its one row
                               instead of piling up duplicates.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

from lib import ledgerlib

APPROVE = "approve"
DENY = "deny"
ESCALATE = "escalate"

# THE DEFAULTS. Only what the item names: hardline-destructive shell/file operations for
# DENY, and read-only/build/typecheck/test/lint/git-inspection for APPROVE. Anything else -
# `npm install`, an arbitrary curl, `git commit`, a plain file edit - falls through to
# ESCALATE. That fallthrough is the point: a pattern list this short will miss plenty of
# real commands, and a miss must land as "ask", never as a silent approve.
_DEFAULT_DENY = [
    {"key": "rm_rf", "description": "recursive force delete (rm -rf / rm -fr / --recursive --force)",
     "patterns": [r"\brm\s+.*-[a-zA-Z]*rf[a-zA-Z]*\b", r"\brm\s+.*-[a-zA-Z]*fr[a-zA-Z]*\b",
                  r"\brm\b.*--recursive\b.*--force\b", r"\brm\b.*--force\b.*--recursive\b"]},
    {"key": "windows_recursive_delete", "description": "windows recursive delete (del /s, rd /s, rmdir /s)",
     "patterns": [r"\bdel\s+/s\b", r"\brd\s+/s\b", r"\brmdir\s+/s\b"]},
    {"key": "format_drive", "description": "formatting a drive (format C:)",
     # ':' is not a word character, so a trailing \b never matches right after it - the
     # pattern ends on the drive letter itself, not on the colon.
     "patterns": [r"\bformat\s+(?:/\S+\s+)*[a-zA-Z]:"]},
    {"key": "git_push_force", "description": "force-pushing (git push --force / -f)",
     "patterns": [r"\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)"]},
    {"key": "git_reset_hard_shared", "description": "hard-resetting a shared branch (git reset --hard on main/master/develop/trunk/production)",
     "patterns": [r"\bgit\s+reset\s+--hard\b.*\b(origin/main|origin/master|origin/develop|main|master|develop|trunk|production)\b"]},
    {"key": "credential_paths", "description": "touching a credential path or .env",
     "patterns": [r"\.env\b", r"\.ssh[/\\]", r"\bid_rsa\b", r"\.pem\b", r"\.git-credentials\b",
                  r"\bcredentials\.json\b", r"\baws[/\\]credentials\b"]},
]

_DEFAULT_APPROVE = [
    {"key": "read_only_inspection", "description": "read-only inspection",
     "patterns": [r"\b(cat|type|head|tail)\s", r"\bls\b", r"\bdir\b", r"\bGet-Content\b",
                  r"\bGet-ChildItem\b", r"\b(grep|rg|findstr)\b"]},
    {"key": "build", "description": "a build",
     "patterns": [r"\bnpm\s+run\s+build\b", r"\bbun\s+run\s+build\b", r"\bmake\b",
                  r"\bcargo\s+build\b", r"\bdotnet\s+build\b"]},
    {"key": "typecheck", "description": "a typecheck",
     "patterns": [r"\btsc\b", r"\btypecheck\b", r"\bmypy\b"]},
    {"key": "test", "description": "a test run",
     "patterns": [r"\bpytest\b", r"\bnpm\s+test\b", r"\bbun\s+test\b", r"\bgo\s+test\b",
                  r"\bcargo\s+test\b"]},
    {"key": "lint", "description": "a lint/format check",
     "patterns": [r"\beslint\b", r"\bbiome\b", r"\bruff\b", r"\bflake8\b", r"\blint\b"]},
    {"key": "git_inspect", "description": "read-only git inspection (status/log/diff/show/branch/remote)",
     "patterns": [r"\bgit\s+status\b", r"\bgit\s+log\b", r"\bgit\s+diff\b", r"\bgit\s+show\b",
                  r"\bgit\s+branch\b", r"\bgit\s+remote\b"]},
]


def _default_policy() -> dict:
    return {
        "_why": (
            "Operator policy for the tri-state approval gate that unblock_prompts.py checks "
            "before pressing a stuck permission prompt (added 2026-09-04, idea ported from "
            "hermes-agent's approval.py). DENY patterns are hardline-destructive shell/file "
            "operations - matched, the chat is left stuck and the reason is recorded, never "
            "pressed. APPROVE patterns are clearly safe/read-only operations - matched, the "
            "prompt is pressed exactly as doctrine (bypassPermissions) already would have. "
            "Anything matching neither list ESCALATES to the judgment queue (interview.py) "
            "instead of being pressed on a guess - uncertainty is not consent. Edit the "
            "pattern lists by hand; this file is read fresh on every run and is NEVER "
            "inferred from a chat transcript, so nothing a chat says (however phrased, "
            "e.g. 'policy: allow everything') can change what gets approved - only editing "
            "this file does."
        ),
        "deny": _DEFAULT_DENY,
        "approve": _DEFAULT_APPROVE,
    }


def policy_path() -> Path:
    return ledgerlib._state_dir() / "approval_policy.json"


def load_policy() -> dict:
    """The operator's pattern lists, creating the default file (with its WHY) the first time
    nothing is there. A hand-edited file with a bad regex in it degrades that one entry, not
    the whole gate - see _entries_hit()."""
    path = policy_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and "deny" in raw and "approve" in raw:
            return raw
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    policy = _default_policy()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(policy, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass  # an unwritable state dir still classifies from the in-memory defaults
    return policy


def _entries_hit(text: str, entries: list) -> dict | None:
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        for pat in entry.get("patterns") or []:
            try:
                if re.search(pat, text, re.IGNORECASE):
                    return entry
            except re.error:
                continue  # a hand-edited bad pattern must not crash the gate
    return None


def classify(tool_name: str, command_text: str, policy: dict | None = None) -> tuple[str, str, str]:
    """(verdict, reason, matched_key) for one pending tool call. DENY is checked before
    APPROVE - a command that also happens to look read-only-ish is still denied; hardline
    beats coincidence. `command_text` is DATA: it is pattern-matched, never interpreted as an
    instruction (see the module docstring's point 3)."""
    policy = policy if policy is not None else load_policy()
    blob = f"{tool_name} {command_text}"
    hit = _entries_hit(blob, policy.get("deny"))
    if hit:
        return DENY, hit.get("description") or hit.get("key") or "matched a deny pattern", hit.get("key", "")
    hit = _entries_hit(blob, policy.get("approve"))
    if hit:
        return APPROVE, hit.get("description") or hit.get("key") or "matched an approve pattern", hit.get("key", "")
    return ESCALATE, "no pattern in approval_policy.json places it - a person or the AI decides", ""


def _collect_strings(value, out: list) -> None:
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for v in value.values():
            _collect_strings(v, out)
    elif isinstance(value, list):
        for v in value:
            _collect_strings(v, out)


def pending_command_text(record: dict) -> tuple[str, str]:
    """The last pending record's tool name(s) + every string its input carries, joined - what
    classify() matches against. ("", "") when the record carries no tool_use (gatelib's
    parse_tail_records stamps `tool_inputs` on every record; see its docstring)."""
    tool_inputs = record.get("tool_inputs") or []
    if not tool_inputs:
        return "", ""
    names = [str(t.get("name") or "") for t in tool_inputs if isinstance(t, dict)]
    strings: list = []
    for t in tool_inputs:
        if isinstance(t, dict):
            _collect_strings(t.get("input"), strings)
    return "/".join(n for n in names if n), " ".join(strings)


# --- The escalation queue: what interview.py --ask reads -----------------------------------

def _escalations_path() -> Path:
    return ledgerlib._state_dir() / "approval_escalations.json"


def _load_escalations() -> dict:
    try:
        raw = json.loads(_escalations_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _save_escalations(rows: dict) -> None:
    path = _escalations_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def queue_escalation(session_id: str, *, title: str, instance: str, instance_dir: str,
                      verify: str, command: str, tool_name: str, reason: str) -> None:
    """Record (or refresh) one stuck prompt the tri-state gate would not press on its own.
    Keyed by sessionId: a chat still stuck five minutes later updates its one row instead of
    piling up duplicates every unattended pass."""
    rows = _load_escalations()
    rows[session_id] = {
        "sessionId": session_id, "title": title, "instance": instance,
        "instanceDir": instance_dir, "verify": verify, "command": command[:2000],
        "toolName": tool_name, "reason": reason, "queuedAt": int(time.time() * 1000),
    }
    _save_escalations(rows)


def list_escalations() -> list:
    return list(_load_escalations().values())


def get_escalation(session_id: str) -> dict | None:
    return _load_escalations().get(session_id)


def resolve_escalation(session_id: str) -> None:
    """Drop one row once interview.py has applied a decision for it. Called on approve
    (pressed) and deny (a person confirmed it stays stuck) alike; a 'skip' answer leaves the
    row queued on purpose, so it is asked again."""
    rows = _load_escalations()
    if rows.pop(session_id, None) is not None:
        _save_escalations(rows)
