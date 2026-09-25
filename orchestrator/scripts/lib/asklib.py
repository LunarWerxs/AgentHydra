"""asklib - THE ASK_USER CARD: a supervised chat asks the human a bounded, typed question
instead of free text, and the answer goes back into the chat as data.

WHY (harvest, 2026-09-25): a chat that needs a person used to say so in prose ("NEED: ...",
"Shall I use A or B?"), and whoever answered it - a person on a phone, or the AI working the
judgment queue - had to read the prose, guess what was being asked, and write free text back
that the chat then had to parse in turn. A question with an id and two or three labelled
options can be shown as a card, answered by picking one, and fed back without guesswork.
The idea comes from Open WebUI's ask_user tool (BSD-3-Clause plus a branding clause - ideas
only, nothing copied); this is written fresh for the orchestrator's transcript-driven shape.

THE CONVENTION a chat follows: END the turn with one fenced block whose info string is
`ask_user` and whose body is JSON:

    ```ask_user
    {"questions": [
      {"id": "db", "question": "Which store should the cache use?",
       "options": [{"label": "SQLite", "description": "one file, already a dependency"},
                   {"label": "JSON file", "description": "simplest, no locking"}],
       "allow_other": true}
    ]}
    ```

  - 1 to 3 questions, each with a unique id (letters, digits, - and _; at most 40 chars)
    and question text of at most 300 characters.
  - 2 to 3 options per question: label at most 80 characters, description at most 240.
  - allow_other (default false) lets the answer be free text instead of an option.

A block that breaks these limits is reported as MALFORMED with the reason, never silently
ignored and never trimmed to fit: a card that shows something the chat did not ask is worse
than no card.

THE STATE MACHINE is pending -> answered, and answered is final. Each ask is keyed by a hash
of its canonical JSON, and asks_answered.json (under the orchestrator's state dir, the same
atomic-write and lock discipline as every other ledger here) records which (chat, key) pairs
were answered and by which staged delivery. A second answer to the same ask is refused as
already answered - the orchestrator's equivalent of a 409 - so two people (or a person and
the AI) answering one card cannot put two contradicting replies into the chat. An answer
stands only while its delivery is staged or delivered: one that expired, failed or was
cancelled never reached the chat, so the card is pending again.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

from lib import deliverylib, ledgerlib

MAX_QUESTIONS = 3
MIN_OPTIONS = 2
MAX_OPTIONS = 3
MAX_ID = 40
MAX_QUESTION = 300
MAX_LABEL = 80
MAX_DESCRIPTION = 240
MAX_OTHER = 1000

_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# The LAST ask_user fence in the text wins: a chat that asked, got corrected and asked again
# means its newest question.
_FENCE_RE = re.compile(r"```ask_user[ \t]*\r?\n(.*?)\r?\n[ \t]*```", re.DOTALL)


class AskError(ValueError):
    """A malformed ask block, or an answer that does not fit the ask it answers."""


def _validate(raw) -> list[dict]:
    """Normalize a parsed ask body into its canonical question list, or raise AskError."""
    if isinstance(raw, dict):
        raw = raw.get("questions")
    if not isinstance(raw, list) or not (1 <= len(raw) <= MAX_QUESTIONS):
        raise AskError(f"an ask needs 1 to {MAX_QUESTIONS} questions")
    seen: set[str] = set()
    out: list[dict] = []
    for i, q in enumerate(raw, 1):
        if not isinstance(q, dict):
            raise AskError(f"question {i} is not an object")
        qid = str(q.get("id") or "").strip()
        if not qid or len(qid) > MAX_ID or not _ID_RE.match(qid):
            raise AskError(f"question {i} needs an id of letters, digits, - or _ (at most {MAX_ID})")
        if qid in seen:
            raise AskError(f"question id {qid!r} is used twice")
        seen.add(qid)
        text = str(q.get("question") or "").strip()
        if not text or len(text) > MAX_QUESTION:
            raise AskError(f"question {qid!r} needs question text of at most {MAX_QUESTION} characters")
        opts = q.get("options")
        if not isinstance(opts, list) or not (MIN_OPTIONS <= len(opts) <= MAX_OPTIONS):
            raise AskError(f"question {qid!r} needs {MIN_OPTIONS} to {MAX_OPTIONS} options")
        options: list[dict] = []
        labels: set[str] = set()
        for j, o in enumerate(opts, 1):
            if isinstance(o, str):
                o = {"label": o}
            if not isinstance(o, dict):
                raise AskError(f"question {qid!r} option {j} is not an object")
            label = str(o.get("label") or "").strip()
            desc = str(o.get("description") or "").strip()
            if not label or len(label) > MAX_LABEL:
                raise AskError(f"question {qid!r} option {j} needs a label of at most {MAX_LABEL} characters")
            if len(desc) > MAX_DESCRIPTION:
                raise AskError(f"question {qid!r} option {j} description is over {MAX_DESCRIPTION} characters")
            if label.casefold() in labels:
                raise AskError(f"question {qid!r} has two options labelled {label!r}")
            labels.add(label.casefold())
            options.append({"label": label, "description": desc})
        out.append({"id": qid, "question": text, "options": options,
                    "allow_other": bool(q.get("allow_other"))})
    return out


def find(text: str) -> dict | None:
    """The ask_user card at the end of a chat's last words, or None when it asked nothing.

    Returns {"key", "questions"} for a valid block, or {"key": None, "error"} for a malformed
    one - the caller shows the error instead of a card, so the chat can be told to fix it."""
    matches = _FENCE_RE.findall(text or "")
    if not matches:
        return None
    try:
        questions = _validate(json.loads(matches[-1]))
    except json.JSONDecodeError as err:
        return {"key": None, "error": f"the ask_user block is not valid JSON: {err.msg}"}
    except AskError as err:
        return {"key": None, "error": str(err)}
    canon = json.dumps(questions, sort_keys=True, separators=(",", ":"))
    return {"key": hashlib.sha256(canon.encode("utf-8")).hexdigest()[:16], "questions": questions}


def ends_on_card(text: str) -> bool:
    """Whether a chat's last words END on an ask_user block, valid or not.

    WHY: the archive gate read "ends on '?'" as its question signal, and a card always ends
    on a closing fence, so asking through the card took away the '?' that used to keep a
    waiting chat out of the archive lane. A malformed card still counts: the chat is waiting
    on a person either way."""
    t = (text or "").rstrip()
    if not t.endswith("```"):
        return False
    start = t.rfind("```ask_user")
    if start < 0:
        return False
    # The closing fence must be the one that closes THIS block, not a later block's.
    return "```" not in t[start + len("```ask_user"):-3]


def _pick(q: dict, choice) -> dict:
    """Resolve one answer against its question: an option label, a 1-based option number, or
    {"other": "..."} when the question allows free text."""
    if isinstance(choice, dict) and "other" in choice:
        if not q["allow_other"]:
            raise AskError(f"question {q['id']!r} does not allow a free-text answer")
        other = str(choice.get("other") or "").strip()
        if not other or len(other) > MAX_OTHER:
            raise AskError(f"question {q['id']!r} free-text answer must be 1 to {MAX_OTHER} characters")
        return {"id": q["id"], "other": other}
    if isinstance(choice, int) and not isinstance(choice, bool):
        if 1 <= choice <= len(q["options"]):
            return {"id": q["id"], "choice": q["options"][choice - 1]["label"]}
        raise AskError(f"question {q['id']!r} has no option {choice}")
    wanted = str(choice or "").strip().casefold()
    for o in q["options"]:
        if o["label"].casefold() == wanted:
            return {"id": q["id"], "choice": o["label"]}
    raise AskError(f"question {q['id']!r} has no option labelled {choice!r}")


def compose_reply(ask: dict, choices: dict) -> str:
    """The message that answers an ask: one readable line per question, then the same answers
    as an `ask_user_answer` JSON block the chat can read without parsing prose. Every question
    must be answered; an unknown question id is refused rather than dropped."""
    if not isinstance(choices, dict) or not choices:
        raise AskError("an answer needs choices: {\"<question id>\": \"<option label>\" | "
                       "<option number> | {\"other\": \"text\"}}")
    by_id = {q["id"]: q for q in ask["questions"]}
    unknown = sorted(set(choices) - set(by_id))
    if unknown:
        raise AskError(f"no such question id(s): {', '.join(unknown)}")
    missing = [qid for qid in by_id if qid not in choices]
    if missing:
        raise AskError(f"unanswered question id(s): {', '.join(missing)}")
    picked = [_pick(by_id[qid], choices[qid]) for qid in by_id]
    lines = ["Answers to your ask_user questions:"]
    for q, p in zip(by_id.values(), picked):
        said = p["choice"] if "choice" in p else f"(other) {p['other']}"
        lines.append(f"- {q['question']} -> {said}")
    body = json.dumps({"key": ask["key"], "answers": picked}, ensure_ascii=False)
    return "\n".join(lines) + f"\n\n```ask_user_answer\n{body}\n```"


# --- pending -> answered: the once-only record ----------------------------------------------

def _answered_path() -> Path:
    return ledgerlib._state_dir() / "asks_answered.json"


def _load() -> dict:
    try:
        raw = json.loads(_answered_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _save(rows: dict) -> None:
    path = _answered_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _row_key(session_id: str, key: str) -> str:
    return f"{session_id}:{key}"


def _still_answers(prior: dict) -> bool:
    """Whether an earlier answer still stands: its delivery is staged (and inside its shelf
    life) or delivered. WHY: an answer whose delivery expired, failed or was cancelled never
    reached the chat, so the card is still pending and a fresh answer must be accepted. A row
    the delivery ledger has pruned is kept as answered - a second send is the worse mistake."""
    did = prior.get("deliveryId")
    row = deliverylib.get(did) if did else None
    if row is None:
        return True
    state = row.get("state")
    if state == "staged":
        floor = int(time.time() * 1000) - deliverylib.STAGED_TTL_SECS * 1000
        return int(row.get("stagedAt") or 0) >= floor
    return state == "delivered"


def answered(session_id: str, key: str) -> dict | None:
    """The record of an earlier answer to this chat's ask, or None while it is pending."""
    prior = _load().get(_row_key(session_id, key))
    return prior if prior and _still_answers(prior) else None


def resolve(session_id: str, key: str, stage) -> dict:
    """Mark one ask answered, running `stage()` (which stages the reply and returns its row)
    under the same lock as the check, so two answerers racing on one card get exactly one
    staged reply. Raises AskError when the ask was already answered and that answer's
    delivery still stands; an answer that never got through is replaced."""
    with ledgerlib.locked("asks"):
        rows = _load()
        prior = rows.get(_row_key(session_id, key))
        if prior and _still_answers(prior):
            raise AskError(f"already answered (delivery {prior.get('deliveryId') or '?'}) - "
                           "an ask is answered once")
        staged = stage()
        rows[_row_key(session_id, key)] = {
            "sessionId": session_id, "key": key, "deliveryId": staged.get("id"),
            "answeredAt": int(time.time() * 1000),
        }
        _save(rows)
    return staged
