"""Response extraction and opt-in exports. No network or browser dependencies."""

from copy import deepcopy
import json
from pathlib import Path
import re
import sys
from typing import Any
from .errors import ClaudeError


def message_text(message: dict[str, Any]) -> str:
    # Rich blocks are authoritative when the older aggregate text field is empty.
    content = message.get("content")
    if isinstance(content, list):
        texts = [
            block["text"]
            for block in content
            if isinstance(block, dict)
            and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        ]
        if texts:
            return "".join(texts)
    # Preserve the legacy shape without stringifying unrelated data into an answer.
    return message.get("text", "") if isinstance(message.get("text"), str) else ""


def code_blocks(text: str) -> list[dict[str, str]]:
    """Extract closed Markdown fences without evaluating their contents."""
    result = []
    fence = None
    language = ""
    lines: list[str] = []
    for line in text.splitlines(keepends=True):
        if fence is None:
            match = re.match(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)", line)
            if match and not (match[1][0] == "`" and "`" in match[2]):
                # A backtick in backtick-fence metadata invalidates that opening fence.
                fence = match[1]
                info = match[2].strip().split()
                language = info[0].lower() if info else ""
                lines = []
        elif re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*", line):
            # Longer closing fences are legal; a shorter inner fence is literal code.
            result.append({"language": language, "code": "".join(lines)})
            fence = None
        else:
            lines.append(line)
    # Unclosed fences may be truncated generation, so do not export them as complete code.
    return result


def message_details(message: dict[str, Any]) -> dict[str, Any]:
    """Preserve exposed content, including citations and tool results.

    Text is convenient for pipes; copied raw blocks retain evidence and tool
    payloads for richer clients without letting callers mutate the source data.
    """
    content = message.get("content", [])
    content = content if isinstance(content, list) else []
    citations = []
    seen = set()
    for block in content:
        if not isinstance(block, dict):
            continue
        for citation in block.get("citations", []) or []:
            if isinstance(citation, dict):
                key = json.dumps(citation, sort_keys=True)
                # Compare complete citations: equal URLs at different offsets are distinct.
                if key not in seen:
                    citations.append(deepcopy(citation))
                    seen.add(key)
    text = message_text(message)
    return {
        "id": str(message.get("uuid", message.get("id", ""))),
        "role": str(message.get("sender", message.get("role", "unknown"))),
        "stop_reason": message.get("stop_reason"),
        "truncated": bool(message.get("truncated", False)),
        "text": text,
        "content": deepcopy(content),
        # Copies let a consumer annotate its result without changing another view.
        "citations": citations,
        "tool_calls": [
            deepcopy(b)
            for b in content
            if isinstance(b, dict) and b.get("type") in {"tool_use", "server_tool_use"}
        ],
        "tool_results": [
            deepcopy(b)
            for b in content
            if isinstance(b, dict)
            and (b.get("type") == "tool_result" or str(b.get("type", "")).endswith("_tool_result"))
        ],
        "code_blocks": code_blocks(text),
        "attachments": deepcopy(message.get("attachments", [])),
        "files": deepcopy(message.get("files", [])),
        "sync_sources": deepcopy(message.get("sync_sources", [])),
    }


def transcript(conversation: dict[str, Any]) -> list[dict[str, Any]]:
    # Both field names have appeared in stored conversation responses.
    messages = conversation.get("chat_messages", conversation.get("messages", []))
    if not isinstance(messages, list):
        raise ClaudeError("Claude returned an unexpected conversation format.")
    return [message_details(m) for m in messages if isinstance(m, dict)]


def cited_text(text: str, citations: list[dict[str, Any]]) -> str:
    """Keep source URLs visible in text mode as well as structured JSON."""
    sources = []
    seen = set()
    for citation in citations:
        # Text-mode readers need each source once; raw output keeps citation positions.
        url = citation.get("url")
        if isinstance(url, str) and url.startswith(("https://", "http://")) and url not in seen:
            title = str(citation.get("title") or url).replace("\n", " ")
            sources.append(f"- {title}: {url}")
            seen.add(url)
    return text + ("\n\nSources:\n" + "\n".join(sources) if sources else "")


def export_results(result: dict[str, Any], directory: str) -> Path:
    """Write data only, with filenames controlled here rather than by the model."""
    folder = Path(directory).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    messages = result.get("messages")
    if messages is None:
        # Give single-reply exports the same code/text path as transcript exports.
        messages = [{**result, "text": result.get("response", ""), "role": "assistant"}]
    rendered = [
        (str(m.get("role", "unknown")).capitalize() + ":\n" if "messages" in result else "")
        + cited_text(m["text"], m.get("citations", []))
        for m in messages
    ]
    (folder / "result.txt").write_text("\n\n".join(rendered), encoding="utf-8")
    extensions = {
        # Model-supplied language labels select a known suffix, never a filename.
        "python": "py",
        "py": "py",
        "javascript": "js",
        "js": "js",
        "typescript": "ts",
        "json": "json",
        "html": "html",
        "css": "css",
        "sql": "sql",
        "bash": "sh",
        "sh": "sh",
        "powershell": "ps1",
        "yaml": "yaml",
        "yml": "yaml",
        "text": "txt",
    }
    index = 0
    for message in messages:
        for block in message.get("code_blocks", []):
            index += 1
            extension = extensions.get(block["language"], "txt")
            (folder / f"code-{index:03d}.{extension}").write_text(block["code"], encoding="utf-8")
    return folder


def brief_result(result: dict) -> dict:
    """Omit repeated/raw blocks while retaining answer, references and code."""
    omit = {"content", "tool_results", "attachments", "files", "sync_sources", "event_types"}
    # Recovery IDs, completion status, code, citations and warnings remain in brief mode.
    compact = {k: v for k, v in result.items() if k not in omit}
    if "messages" in compact:
        compact["messages"] = [
            {k: v for k, v in m.items() if k not in omit} for m in compact["messages"]
        ]
    return compact


def emit(args, result: dict):
    private_label = "Temporary" if result.get("provider") == "chatgpt" else "Incognito"
    if args.json_output:
        # Emit one envelope; human progress text would break pipes and MCP consumers.
        print(json.dumps(result, ensure_ascii=False, indent=None if args.brief else 2), flush=True)
        return
    if args.command == "auth":
        print(f"Authenticated via HTTP. Organization: {result['organization_id']}")
    elif args.command == "usage":
        _print_usage(result)
    elif args.command == "chats":
        _print_chats(result, private_label)
    elif args.command == "track":
        print(
            f"Tracked {result['chat_name'] or result['chat_id']}: {result['chat_id']} ({private_label}: {result['is_temporary']})"
        )
    elif args.command == "read":
        for message in result["messages"]:
            print(
                f"{message['role'].capitalize()}:\n{cited_text(message['text'], message['citations'])}\n"
            )
    else:
        _print_answer(args, result)
        print(
            f"Chat: {result['chat_id']}  name={result.get('chat_name') or '(unnamed)'}  {private_label}={result['is_temporary']}",
            file=sys.stderr,
        )
    if args.export_dir:
        print(f"Exported results: {result['export_directory']}", file=sys.stderr)
    for warning in result.get("warnings", []):
        # Keep saved answer text on stdout independent of local bookkeeping problems.
        print(f"Warning: {warning['message']}", file=sys.stderr)


def _print_answer(args, result):
    if args.stream:
        # Text callbacks already printed the answer; append only its source links.
        print(flush=True)
        if result["citations"]:
            print(cited_text("", result["citations"]).lstrip(), flush=True)
    else:
        print(cited_text(result["response"], result["citations"]), flush=True)


def _print_usage(result):
    if result["is_snapshot"]:
        print(
            f"Last chat-stream reading: {result['observed_at']} (age: {result['age_seconds']} seconds)"
        )
    elif result["available"]:
        print(f"Usage endpoint reading: {result['observed_at']}")
    for item in result["windows"]:
        used, remaining = item["used_percent"], item["remaining_percent"]
        amount = (
            f"{used:g}% used; {remaining:g}% remaining"
            if used is not None
            else "percentage unavailable"
        )
        expired = (
            " [reset has passed; this reading is historical]" if item["reset_passed"] else ""
        )
        print(f"{item['id']}: {amount}; resets {item['resets_at'] or 'unknown'}{expired}")
    print(result["note"])


def _print_chats(result, private_label):
    for entry in result["chats"]:
        mode = (
            private_label
            if entry["is_temporary"]
            else "regular"
            if entry["is_temporary"] is False
            else "unknown"
        )
        print(f"{entry['name'] or '(unnamed)'}  {entry['chat_id']}  {mode}  {entry['status']}")
    if not result["chats"]:
        print("No chats tracked locally. Use 'chat --name NAME' or 'track UUID --name NAME'.")
