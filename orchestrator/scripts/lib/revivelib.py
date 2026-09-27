"""revivelib.py - rebuild a Claude Code transcript that `--resume` will accept.

WHY THIS EXISTS: Claude Code deletes a transcript once it is older than `cleanupPeriodDays`
(30 days by default), and after that `claude --resume <id>` fails: the chat is gone even though
a copy of it may still sit somewhere else (an undo copy delete_chat took, another account's
store the chat was moved out of, a file the owner saved by hand). Copying that file back
verbatim is not enough. A transcript carries records the API refuses to take back:

  - THINKING BLOCKS are signed by the model that wrote them. A replayed block whose signature no
    longer verifies (another account, a later model, a block cut short) fails the next turn, and
    nothing can re-sign one. So every thinking and redacted_thinking block is dropped.
  - A tool_use with NO tool_result after it is a hard 400 on the next request ("tool_use ids
    were found without tool_result blocks"). A session killed mid-tool, or a copy taken while a
    tool ran, ends in exactly that. So every tool_use must be answered later in the chain, or it
    is dropped; and a tool_result whose tool_use was dropped goes with it.
  - Anything that is not conversation (summaries, snapshots, progress, attachments, system
    notes, sidechain records) is bookkeeping the CLI regenerates; replaying it only adds shapes
    the loader has to understand.

The rules follow the replay-safe subset LobeHub uses when it rewrites a Claude Code JSONL from
its own store (lobehub/lobehub packages/heterogeneous-agents/src/transcript/rebuildClaudeCode.ts,
ideas only - nothing copied): user text, assistant text with tool_use, and tool_result.

Only the ACTIVE branch is kept: the chain is walked back from the newest conversation record
by parentUuid, exactly as the CLI does on resume, so an edited-away branch is not spliced in,
and the walk stops at a compaction boundary (which starts a fresh chain), so a rebuilt chat
never replays the history it had already compacted away. Surviving records are relinked into
one straight chain, because dropping a record would otherwise leave its child pointing at
nothing and the CLI would silently load only the tail.

Stdlib only, no daemon: pure functions over parsed records, plus two small file helpers.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# What a replayed request may carry, by role. Everything else in a content list is dropped.
_ASSISTANT_KEEP = {"text", "tool_use"}
_USER_KEEP = {"text", "image", "tool_result"}
_CONVERSATION = {"user", "assistant"}


def parse_jsonl(text: str) -> list[dict]:
    """Every JSON object line of a transcript; a torn or blank line is skipped, not fatal
    (a copy taken while the CLI was mid-write ends in half a line)."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def active_chain(records: list[dict]) -> list[dict]:
    """The branch `--resume` would load: from the newest non-sidechain user/assistant record
    back through parentUuid, oldest first. A missing parent or a compaction boundary (a record
    whose parentUuid is null) ends the walk; a cycle cannot loop forever."""
    by_uuid = {r["uuid"]: r for r in records if isinstance(r.get("uuid"), str)}
    leaf = None
    for r in reversed(records):
        if r.get("type") in _CONVERSATION and not r.get("isSidechain"):
            leaf = r
            break
    if leaf is None:
        return []
    chain, seen = [], set()
    cur = leaf
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        chain.append(cur)
        parent = cur.get("parentUuid")
        cur = by_uuid.get(parent) if isinstance(parent, str) else None
    chain.reverse()
    return chain


def _blocks(rec: dict) -> list | str | None:
    msg = rec.get("message")
    return msg.get("content") if isinstance(msg, dict) else None


def rebuild_records(records: list[dict], session_id: str | None = None) -> tuple[list[dict], dict]:
    """Apply the replay-safe rules to a parsed transcript. Returns (records to write, stats).

    stats counts what was dropped and why, so a caller can report it rather than hide it:
    chain (records on the active branch), kept, thinking, unansweredToolUse, orphanToolResult,
    nonConversation, emptied."""
    chain = active_chain(records)
    stats = {"chain": len(chain), "kept": 0, "thinking": 0, "unansweredToolUse": 0,
             "orphanToolResult": 0, "nonConversation": 0, "emptied": 0}
    answered_after = _answered_after(chain)

    kept: list[dict] = []
    issued: set = set()  # tool_use ids a kept assistant record already carries
    for i, rec in enumerate(chain):
        kind = rec.get("type")
        if kind not in _CONVERSATION or rec.get("isSidechain"):
            stats["nonConversation"] += 1
            continue
        new_content = _rebuilt_content(_blocks(rec), kind, answered_after[i], issued, stats)
        if new_content is None:
            stats["emptied"] += 1
            continue
        out = dict(rec)
        out["message"] = dict(rec["message"], content=new_content)
        if session_id:
            out["sessionId"] = session_id
        kept.append(out)

    _relink(kept)
    stats["kept"] = len(kept)
    return kept, stats


def _answered_after(chain: list[dict]) -> list[set]:
    """Which tool_use ids are answered LATER in the chain, per record. Built back to front so
    "later" is exact: a result that appears before its call does not count."""
    answered_after: list[set] = [set()] * len(chain)
    seen_results: set = set()
    for i in range(len(chain) - 1, -1, -1):
        answered_after[i] = set(seen_results)
        content = _blocks(chain[i])
        if chain[i].get("type") == "user" and isinstance(content, list):
            seen_results.update(_tool_result_ids(content))
    return answered_after


def _tool_result_ids(content: list) -> list:
    """The tool_use_id of every tool_result block in one content list, in order."""
    return [b.get("tool_use_id") for b in content
            if isinstance(b, dict) and b.get("type") == "tool_result"]


def _rebuilt_content(content, kind: str, answered: set, issued: set,
                     stats: dict) -> list | str | None:
    """One record's replay-safe content, or None when nothing replayable is left (the caller
    counts it as emptied). Drops and tool_use ids issued are recorded in `stats` / `issued`."""
    if isinstance(content, str):
        return content if content.strip() else None
    if not isinstance(content, list):
        return None
    new_content = []
    for b in content:
        if _keep_block(b, kind, answered, issued, stats):
            new_content.append(b)
    return new_content or None


def _keep_block(b, kind: str, answered: set, issued: set, stats: dict) -> bool:
    """Whether one content block survives the replay-safe rules for a record of `kind`."""
    btype = b.get("type") if isinstance(b, dict) else None
    if btype in ("thinking", "redacted_thinking"):
        stats["thinking"] += 1
        return False
    if kind == "assistant":
        return _keep_assistant_block(b, btype, answered, issued, stats)
    return _keep_user_block(b, btype, issued, stats)


def _keep_assistant_block(b, btype: str | None, answered: set, issued: set, stats: dict) -> bool:
    if btype not in _ASSISTANT_KEEP:
        return False
    if btype == "tool_use" and b.get("id") not in answered:
        stats["unansweredToolUse"] += 1
        return False
    if btype == "text" and not str(b.get("text") or "").strip():
        return False
    if btype == "tool_use":
        issued.add(b.get("id"))
    return True


def _keep_user_block(b, btype: str | None, issued: set, stats: dict) -> bool:
    if btype not in _USER_KEEP:
        return False
    if btype == "tool_result" and b.get("tool_use_id") not in issued:
        stats["orphanToolResult"] += 1
        return False
    return True


def _relink(kept: list[dict]) -> None:
    """One straight chain: each record's parent is the record kept before it."""
    parent = None
    for rec in kept:
        rec["parentUuid"] = parent
        rec.pop("logicalParentUuid", None)
        parent = rec.get("uuid")


def project_folder(cwd: str) -> str:
    """Claude Code's project folder name for a working directory: every character that is not
    a letter or digit becomes '-' (D:\\Work\\my app -> D--Work-my-app)."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def first_cwd(records: list[dict]) -> str:
    """The working directory the chat ran in, from the newest record that names one."""
    for r in reversed(records):
        cwd = r.get("cwd")
        if isinstance(cwd, str) and cwd:
            return cwd
    return ""


def render_jsonl(records: list[dict]) -> str:
    """Compact JSON lines with a trailing newline, the shape the CLI itself writes."""
    return "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in records)


def candidate_sources(session_id: str, stores: list[Path], trash_root: Path | None) -> list[Path]:
    """Every copy of this chat's transcript that exists: `<store>/*/<id>.jsonl` in each store
    (another account's projects folder a moved chat came from), then delete_chat's undo copy
    (`<trash_root>/<id>/transcript-*.jsonl`), in that order, largest first within each."""
    found: list[Path] = []
    for store in stores:
        try:
            hits = sorted(store.glob(f"*/{session_id}.jsonl"), key=lambda p: -p.stat().st_size)
        except OSError:
            continue
        found.extend(h for h in hits if h not in found)
    if trash_root is not None:
        try:
            found.extend(sorted((trash_root / session_id).glob("transcript-*.jsonl"),
                                key=lambda p: -p.stat().st_size))
        except OSError:
            pass
    return found
