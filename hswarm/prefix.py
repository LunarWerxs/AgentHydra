"""`hswarm prefix`: what one `cc` worker spawn ships before it has done any work, measured locally.

Every headless Claude Code worker re-sends its system prompt, the context it injects (CLAUDE.md,
reminders) and one JSON schema per tool, MCP servers included, on its first request. Nobody knew
what that prefix weighs, so this launches the worker exactly as the cc backend would (cc._command,
cc_env) but with ANTHROPIC_BASE_URL pointed at a loopback sink that records each request and
answers "DONE". No provider is called, no key is used and nothing is spent. The capture carrying
the most tool schemas is the prefix; it is split into system, context and per-tool characters, and
the tools are grouped by MCP server so the heaviest one is named.

Idea from JuliusBrussee/caveman packages/subagent-tax (lib/harnesses.mjs, lib/analyze.mjs; MIT),
written fresh for hswarm: only the anthropic-messages protocol is spoken, because Claude Code is the
one harness hswarm launches.
"""
from __future__ import annotations

import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import config
from .claude_env import cc_env
from .procs import TIMEOUT_EXIT, run_hidden
from .spec import Task

# A placeholder the child sends as its key. The sink ignores it; a real key never enters this path.
SINK_KEY = "sk-hswarm-prefix-sink"
PROMPT = "Reply with the single word DONE."
CHARS_PER_TOKEN = 4  # a rough English/JSON average; the report labels every token figure as an estimate
_PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")


def _sse(model: str) -> bytes:
    """One streamed assistant turn that says DONE and ends, in the Anthropic Messages event order."""
    events = [
        ("message_start", {"type": "message_start", "message": {"id": "msg_hswarm_sink", "type": "message", "role": "assistant", "model": model,
                                                                  "content": [], "stop_reason": None, "stop_sequence": None,
                                                                  "usage": {"input_tokens": 0, "output_tokens": 0}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "DONE"}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(f"event: {name}\ndata: {json.dumps(body)}\n\n" for name, body in events).encode("utf-8")


def _message(model: str) -> dict:
    return {"id": "msg_hswarm_sink", "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": "DONE"}],
            "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 0, "output_tokens": 1}}


class Sink:
    """A loopback Anthropic Messages endpoint that records every POST body and answers DONE.
    Use as a context manager; `url` is the base URL to hand the child, `captures` what it sent."""

    def __init__(self) -> None:
        self.captures: list[dict] = []
        lock = threading.Lock()
        captures = self.captures

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args) -> None:  # the CLI's stdout is the report; no access log on stderr
                pass

            def _send(self, code: int, body: bytes, ctype: str) -> None:
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802 - http.server's naming
                self._send(404, b'{"type":"error","error":{"type":"not_found_error","message":"hswarm prefix sink"}}', "application/json")

            def do_POST(self) -> None:  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    body = json.loads(raw.decode("utf-8") or "{}")
                except ValueError:
                    body = {}
                path = self.path.split("?", 1)[0]
                with lock:
                    captures.append({"path": path, "body": body})
                model = str(body.get("model") or "sink")
                if path.endswith("/messages/count_tokens"):
                    self._send(200, b'{"input_tokens":0}', "application/json")
                elif path.endswith("/messages"):
                    if body.get("stream"):
                        self._send(200, _sse(model), "text/event-stream")
                    else:
                        self._send(200, json.dumps(_message(model)).encode("utf-8"), "application/json")
                else:
                    self._send(404, b'{"type":"error","error":{"type":"not_found_error","message":"hswarm prefix sink"}}', "application/json")

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, name="hswarm-prefix-sink", daemon=True)

    def __enter__(self) -> "Sink":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._server.shutdown()
        self._server.server_close()


def _chars(v) -> int:
    """Characters of a value as it travels: strings as-is, anything else as compact JSON."""
    if v is None:
        return 0
    if isinstance(v, str):
        return len(v)
    return len(json.dumps(v, separators=(",", ":"), ensure_ascii=False))


def _system_chars(system) -> int:
    if isinstance(system, list):
        return sum(len(b.get("text") or "") if isinstance(b, dict) else _chars(b) for b in system)
    return _chars(system)


def server_of(tool_name: str) -> str:
    """Claude Code names an MCP tool mcp__<server>__<tool>; everything else is built in."""
    parts = tool_name.split("__", 2)
    return parts[1] if len(parts) == 3 and parts[0] == "mcp" and parts[1] else "builtin"


def pick_prefix(captures: list[dict]) -> dict | None:
    """The capture that is the worker's real first turn: the one with the most tool schemas (Claude Code
    also sends small tool-less side calls), the largest body breaking a tie."""
    msgs = [c for c in captures if c.get("path", "").endswith("/messages") and isinstance(c.get("body"), dict)]
    if not msgs:
        return None
    return max(msgs, key=lambda c: (len(c["body"].get("tools") or []), _chars(c["body"])))


def analyze(body: dict, model: str | None = None, top: int = 10) -> dict:
    """Split one Anthropic Messages request into its prefix parts, per tool and per MCP server.
    `model` is the hswarm registry model the worker runs, used only to price the prefix."""
    tools = [t for t in body.get("tools") or [] if isinstance(t, dict)]
    rows = [{"name": str(t.get("name") or "?"), "server": server_of(str(t.get("name") or "")), "chars": _chars(t)} for t in tools]
    system_chars = _system_chars(body.get("system"))
    context_chars = _chars(body.get("messages"))
    tool_chars = sum(r["chars"] for r in rows)
    total = system_chars + context_chars + tool_chars
    servers: dict[str, dict] = {}
    for r in rows:
        s = servers.setdefault(r["server"], {"server": r["server"], "tools": 0, "chars": 0})
        s["tools"] += 1
        s["chars"] += r["chars"]
    by_server = sorted(servers.values(), key=lambda s: -s["chars"])
    for s in by_server:
        s["share_pct"] = round(100 * s["chars"] / total, 1) if total else 0.0
    mcp = [s for s in by_server if s["server"] != "builtin"]
    est_tokens = math.ceil(total / CHARS_PER_TOKEN)
    out = {
        "request_model": body.get("model"),
        "system_chars": system_chars,
        "context_chars": context_chars,
        "tool_chars": tool_chars,
        "total_chars": total,
        "est_tokens": est_tokens,
        "tools": len(rows),
        "builtin": {"tools": servers.get("builtin", {}).get("tools", 0), "chars": servers.get("builtin", {}).get("chars", 0)},
        "mcp": {"tools": sum(s["tools"] for s in mcp), "chars": sum(s["chars"] for s in mcp), "servers": len(mcp)},
        "servers": by_server,
        "dominant_mcp": mcp[0]["server"] if mcp else None,
        "heaviest": sorted(rows, key=lambda r: -r["chars"])[:top],
    }
    if model:
        cold = config.cost_usd(model, 0, est_tokens, 0, prompt_tokens=est_tokens)
        warm = config.cost_usd(model, est_tokens, 0, 0, prompt_tokens=est_tokens)
        out["price"] = {"model": model, "cold_usd": cold, "cached_usd": warm}  # None = unpriced, never 0
    return out


def _operator_env(url: str) -> dict:
    """The operator's own Claude Code setup (their config dir, MCP servers, hooks) with only the endpoint
    and key swapped for the sink's: what a Claude sub-agent spawned on this machine would carry."""
    env = {k: v for k, v in os.environ.items() if not (k.startswith(("CLAUDE_CODE_", "ANTHROPIC_")) or k == "CLAUDECODE")}
    env.update({"ANTHROPIC_BASE_URL": url, "ANTHROPIC_API_KEY": SINK_KEY, "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1",
                "DISABLE_ERROR_REPORTING": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
    return env


def _to_sink(env: dict, url: str) -> dict:
    """Point the child at the sink and nowhere else: a corporate proxy would otherwise swallow a loopback call."""
    for k in _PROXY_VARS:
        env.pop(k, None)
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
    env["ANTHROPIC_BASE_URL"] = url
    return env


async def measure(cwd: str, model: str | None = None, tools: str = "read", operator: bool = False, timeout_s: int = 120, top: int = 10) -> dict:
    """Spawn one worker against the sink and report its prefix. `operator` measures this machine's own
    Claude Code setup instead of the isolated worker config (it starts the operator's MCP servers and hooks once)."""
    from . import cc  # the worker's own command line, so the measurement is of exactly what a job spawns

    task = Task.from_dict({"prompt": PROMPT, "cwd": cwd, "backend": "cc", "tools": tools, "model": model, "max_turns": 1}, {}, 0)
    with Sink() as sink:
        env = _operator_env(sink.url) if operator else cc_env(SINK_KEY, task.model)
        env = _to_sink(env, sink.url)
        cmd = cc._command(task)
        if not operator:
            cc.trust_project(task.cwd)  # as run_cc_task does; writes only the worker's own config dir
        code, _out, err = await run_hidden(cmd, task.cwd, timeout_s, env=env, stdin_text=PROMPT)
        captures = list(sink.captures)
    head = {"mode": "operator" if operator else "worker", "cwd": str(Path(task.cwd)), "tools_preset": tools, "model": task.model,
            "exit": code, "requests": len(captures)}
    chosen = pick_prefix(captures)
    if chosen is None:
        why = "timed out" if code == TIMEOUT_EXIT else f"exit {code}"
        return {**head, "error": f"no Messages request reached the sink ({why}); a settings.json env block that sets ANTHROPIC_BASE_URL "
                                 f"overrides the sink", "stderr": err.replace(SINK_KEY, "sk-***")[-800:]}
    return {**head, **analyze(chosen["body"], None if operator else task.model, top)}


def render(r: dict) -> str:
    """The human report: the prefix total, its split, the servers by weight and the heaviest schemas."""
    lines = [f"prefix of one {r['mode']} spawn ({r['tools_preset']} preset, model {r['model']}) in {r['cwd']}"]
    if r.get("error"):
        return "\n".join(lines + [f"  {r['error']}", f"  stderr: {r.get('stderr') or '-'}"])
    lines.append(f"  total {r['total_chars']:,} chars ~ {r['est_tokens']:,} tokens (est, {CHARS_PER_TOKEN} chars/token) across {r['requests']} request(s)")
    lines.append(f"  system {r['system_chars']:,} | context {r['context_chars']:,} | tool schemas {r['tool_chars']:,} ({r['tools']} tools)")
    lines.append(f"  builtin {r['builtin']['tools']} tools {r['builtin']['chars']:,} chars | MCP {r['mcp']['tools']} tools {r['mcp']['chars']:,} chars "
                 f"from {r['mcp']['servers']} server(s)")
    p = r.get("price")
    if p:
        fmt = lambda v: "-" if v is None else f"${v:.6f}"  # noqa: E731
        lines.append(f"  per spawn at {p['model']} rates: {fmt(p['cold_usd'])} cold, {fmt(p['cached_usd'])} cached")
    lines.append("  by server:")
    lines += [f"    {s['server']:28} {s['tools']:4} tools {s['chars']:>9,} chars {s['share_pct']:5.1f}%" for s in r["servers"]]
    lines.append(f"  dominant MCP server: {r['dominant_mcp'] or 'none (no MCP tools in the prefix)'}")
    lines.append("  heaviest schemas:")
    lines += [f"    {h['chars']:>7,}  {h['name']}" for h in r["heaviest"]]
    return "\n".join(lines)
