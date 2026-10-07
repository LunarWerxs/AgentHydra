"""HTTP requests the claudfree harness makes for ONE message in a NEW claude.ai chat, counted with a fake transport.

The measure behind `free.claude.calls_per_new_chat` in .rsi/rsi.yaml. It runs the harness's own `chat` command
(service.execute, what Desk's free_chat runs: a private chat, the model chosen from the account) against a fake
session that answers each claude.ai endpoint with invented data, and counts every request it makes: the
organization lookup, the account reads, the completion POST and the persistence read. No network, no saved login;
the harness's state goes to a temporary folder. Prints one JSON line.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "desk2" / "server" / "src" / "free-instances" / "harness"))

from claudfree import cli, http, service, state  # noqa: E402

ORG = "11111111-1111-4111-8111-111111111111"
REPLY = "ok"
ACCOUNT = {
    "settings": {"default_model": None},
    "memberships": [
        {
            "organization": {
                "uuid": ORG,
                "claude_ai_bootstrap_models_config": [{"model": "claude-sonnet-9"}, {"model": "claude-haiku-9"}],
            }
        }
    ],
}
calls: list[str] = []


class Response:
    def __init__(self, body=None, content_type="application/json", lines=()):
        self.status_code, self.headers, self._body, self._lines = 200, {"content-type": content_type}, body, lines

    def json(self):
        return self._body

    def iter_lines(self, chunk_size=None):
        return iter(self._lines)

    def close(self):
        pass


class Session:
    def __init__(self):
        self.headers: dict[str, str] = {}
        self.cookies: list = []

    def request(self, method, url, **kwargs):
        path = url.split("claude.ai", 1)[-1].split("?", 1)[0]
        calls.append(f"{method} " + re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27}", "<id>", path))
        if method == "POST":
            events = [{"type": "completion", "completion": REPLY}, {"type": "message_stop"}]
            frames = [line for e in events for line in (f"data: {json.dumps(e)}".encode(), b"")]
            return Response(content_type="text/event-stream", lines=frames)
        if path == "/api/organizations":
            return Response([{"uuid": ORG, "name": "Example Owner"}])
        if path == "/api/account":
            return Response(ACCOUNT)
        if "/chat_conversations/" in path:
            reply = {"sender": "assistant", "uuid": "m1", "text": REPLY, "content": [{"type": "text", "text": REPLY}], "stop_reason": "end_turn"}
            return Response({"is_temporary": True, "model": "claude-sonnet-9", "chat_messages": [reply]})
        return Response({})

    def close(self):
        pass


class Store(state.StateStore):
    def load_session(self):
        return {"cookies": [], "origins": []}

    def save_session(self, value):
        pass


http.ClaudeHttp.__init__.__kwdefaults__["session_factory"] = Session
with tempfile.TemporaryDirectory() as folder:
    service.execute(cli.parse_args(["chat", "--prompt", "hello"]), api=Store(folder))
print(json.dumps({"requests": len(calls), "calls": calls}))
