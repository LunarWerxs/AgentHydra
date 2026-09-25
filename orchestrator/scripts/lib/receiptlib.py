"""receiptlib - THE TASK RECEIPT: proof, from the transcript, that a fan-out prompt landed and started.

WHY THIS EXISTS. fan_out spawns a chat and binds it once its FIRST user turn is our prompt
(spawn_chat.first_turn_owner). That proves the text reached the right chat; it does not prove the
chat ever RAN it. A deeplink or resume boot can leave a chat holding our prompt as an unanswered
user turn forever, and a truncated or re-wrapped prompt can land as some other task's words. Both
fail silently: the member reads "spawned" and nothing happens.

So every fan-out prompt carries a short structured receipt (a one-off token, the repo, the task id
and the expected artifact) that the agent is asked to echo before it starts. The echo, read from
the chat's own transcript, is the delivery proof. The idea is adapted (not copied) from
ultraworkers/claw-code's worker-boot prompt-misdelivery check (MIT): classify delivery from what
the worker actually shows, and re-arm ONE replay when it did not start.

The verdicts (`classify`):
  delivered      - an assistant turn shows the whole receipt: token, repo, task and artifact.
  wrong-task     - an assistant turn shows the token but not every field (it read a different or
                   mangled task).
  no-echo        - the chat answered but never echoed the receipt: it is running, unproven.
  never-started  - our prompt (with its token) is the chat's user turn and no assistant record
                   followed it. The one verdict that earns a re-delivery.
  wrong-chat     - the chat's first user turn does not carry our token: what we are watching is
                   not the chat the prompt went into. Never re-delivered into (never type into a
                   chat that is not proven ours).
  pending        - no transcript or no user turn yet; too early to say.

Deterministic code over transcript bytes, stdlib only, no daemon calls.
"""

from __future__ import annotations

import json
import os
import re
import uuid

# The words the chat sees above the receipt line; also the marker strip() keys on, so a stamped
# prompt still compares equal to the bare prompt in the fleet duplicate check.
HEADER = "[fan-out receipt] Before anything else, reply with this one line exactly as written, then do the task:"
DEFAULT_ARTIFACT = "a final report in this chat"
# How much of a transcript's head is read. A receipt is echoed in the first turn, so a long
# chat's tail never matters to it.
MAX_BYTES = 4 * 1024 * 1024
FAILED = ("wrong-chat", "wrong-task", "never-started")

_BLOCK = re.compile(r"\s*" + re.escape(HEADER) + r"\s*\n\s*RECEIPT R-[0-9a-f]{8}[^\n]*\s*$")
_FIELD_SAFE = re.compile(r"[|\r\n]+")


def _clean(value: str, cap: int = 120) -> str:
    """A field is one line with no '|' (the line's own separator), capped."""
    return " ".join(_FIELD_SAFE.sub(" ", str(value or "")).split())[:cap]


def make(task_id: str, folder: str, artifact: str | None = None) -> dict:
    """A fresh receipt for one task. The token is new every time, so a replayed or copied prompt
    from an earlier group can never satisfy a later group's check."""
    repo = os.path.basename(os.path.normpath(str(folder or ""))) or str(folder or "")
    return {"token": f"R-{uuid.uuid4().hex[:8]}", "repo": _clean(repo), "task": _clean(task_id),
            "artifact": _clean(artifact or DEFAULT_ARTIFACT, 200)}


def line(receipt: dict) -> str:
    return (f"RECEIPT {receipt['token']} | repo: {receipt['repo']} | task: {receipt['task']} "
            f"| artifact: {receipt['artifact']}")


def stamp(prompt: str, receipt: dict) -> str:
    """The prompt with its receipt appended. APPENDED, never prepended: the head of the prompt is
    what first_turn_owner and the pane verify match on, and it must stay the task's own words."""
    return f"{str(prompt or '').rstrip()}\n\n{HEADER}\n{line(receipt)}"


def strip(text: str) -> str:
    """`text` without a trailing receipt block (unchanged when it has none)."""
    return _BLOCK.sub("", str(text or ""))


def nudge(receipt: dict) -> str:
    """The one-time re-delivery for a never-started chat. The task itself is already the chat's
    user turn, so re-sending the whole prompt would only queue it twice; this asks it to start."""
    return ("The task above has not started yet. Reply with its receipt line first, then begin "
            f"it:\n{line(receipt)}")


def _norm(s: str) -> str:
    return " ".join(str(s or "").split()).lower()


def _text_of(content) -> tuple[str, bool]:
    """(text, is_tool_result) of one message content."""
    if isinstance(content, str):
        return content, False
    if not isinstance(content, list):
        return "", False
    if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return "", True
    return " ".join(str(b.get("text", "")) for b in content
                    if isinstance(b, dict) and b.get("type") == "text"), False


def turns(path: str, max_bytes: int = MAX_BYTES) -> list[tuple[str, str]]:
    """The conversation's (role, text) turns from the head of a transcript: real user prompts
    (no tool results, no meta records) and every assistant record (its text may be empty - a
    tool call is still the chat having started)."""
    try:
        with open(path, "rb") as f:
            head = f.read(max_bytes).decode("utf-8", errors="replace")
    except OSError:
        return []
    out: list[tuple[str, str]] = []
    for raw in head.split("\n"):
        t = raw.strip()
        if not t.startswith("{"):
            continue
        try:
            ev = json.loads(t)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict) or ev.get("isSidechain") is True:
            continue
        kind = ev.get("type")
        msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
        if kind == "user":
            if ev.get("isMeta"):
                continue
            text, is_result = _text_of(msg.get("content"))
            if not is_result and text.strip():
                out.append(("user", text))
        elif kind == "assistant":
            out.append(("assistant", _text_of(msg.get("content"))[0]))
    return out


def classify(path: str | None, receipt: dict) -> dict:
    """{"state": <verdict above>, "why": str} for one member's transcript."""
    token = str(receipt.get("token") or "")
    got = turns(path) if path else []
    users = [i for i, (role, _t) in enumerate(got) if role == "user"]
    if not users:
        return {"state": "pending", "why": "no user turn in the transcript yet"}
    first_user = got[users[0]][1]
    if token.lower() not in _norm(first_user):
        return {"state": "wrong-chat",
                "why": f"the chat's first user turn does not carry receipt {token}"}
    replies = [t for role, t in got[users[0] + 1:] if role == "assistant"]
    if not replies:
        return {"state": "never-started", "why": "our prompt is the chat's turn and nothing answered it"}
    fields = [token, receipt.get("repo"), receipt.get("task"), receipt.get("artifact")]
    for text in replies:
        n = _norm(text)
        if token.lower() not in n:
            continue
        missing = [f for f in fields[1:] if f and _norm(f) not in n]
        if not missing:
            return {"state": "delivered", "why": "the chat echoed its whole receipt"}
        return {"state": "wrong-task",
                "why": f"the chat echoed {token} without: {', '.join(missing)}"}
    return {"state": "no-echo", "why": "the chat answered but never echoed its receipt"}
