"""Record, replay and minimize MCP sessions: turn "it broke somewhere in a two-hour chat" into a few messages.

Our MCP server crashes or misbehaves only inside long agent sessions, where nobody can say which call did it.
So the stdio stream can be RECORDED (opt-in: `hswarm mcp --record PATH`, or HSWARM_RECORD in the server's
environment) as newline-delimited JSON, one entry per JSON-RPC line in either direction, with the project root
and the home folder replaced by @PROJECT_ROOT@ / @HOME@ so a transcript replays on another machine or folder.
`hswarm replay FILE` feeds the client side back into a fresh server and reports the failures it sees, as
stable signatures (crash:exit=1:KeyError, tool-error:tools/call:hswarm_status:KeyError, hang:...), and
`--minimize` runs delta debugging (ddmin) over the transcript under a same-signature predicate - N runs and a
hit-rate threshold for a flaky one - down to the few messages that still fail. That file becomes the test.

The idea is from microsoft/TypeScript's LSP replay minimizer (.github/agents/replay-minimizer.md, Apache-2.0);
the code is written fresh for hswarm.

A replay never spends: every tools/call that could reach a provider, spend money or push (hswarm_run, _ask,
_decide, _sync, _doctor, a keys probe, a models refresh, a cost with balance) is skipped and reported unless
--allow-spend says otherwise. The minimizer replays a transcript dozens of times.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from . import config

REPO = Path(__file__).resolve().parent.parent
ROOT_TOKEN, HOME_TOKEN = "@PROJECT_ROOT@", "@HOME@"
HANDSHAKE = {"initialize", "notifications/initialized"}
# Tools that only read this machine's own files: safe to replay any number of times.
OFFLINE_TOOLS = {"hswarm_status", "hswarm_results", "hswarm_jobs", "hswarm_usage", "hswarm_bench", "hswarm_cancel"}
_EOF = object()
_EXC = re.compile(r"^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Timeout|Refused))\b")


# ---- path placeholders ---------------------------------------------------------------------------------------

def _variants(path: str | os.PathLike) -> list[str]:
    p = str(path).rstrip("\\/")
    back = p.replace("/", "\\")
    # A tool result is a JSON string inside content[0].text, so there a Windows path travels backslash-doubled.
    # A root shorter than "C:\x" would replace far more than a path; leave it alone.
    return [v for v in dict.fromkeys((p, p.replace("\\", "/"), back, back.replace("\\", "\\\\"))) if len(v) > 3]


def _walk(obj: Any, fn: Callable[[str], str]) -> Any:
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [_walk(x, fn) for x in obj]
    if isinstance(obj, dict):
        return {k: _walk(v, fn) for k, v in obj.items()}
    return obj


def redact(obj: Any, root: str | os.PathLike, home: str | os.PathLike | None = None) -> Any:
    """Every occurrence of the project root, then the home folder, becomes its placeholder (either slash style;
    case-blind on Windows, where D:\\X and d:\\x are the same folder). Longest first: the root sits under home."""
    pairs = [(v, ROOT_TOKEN) for v in _variants(root)] + [(v, HOME_TOKEN) for v in _variants(home or Path.home())]
    pairs.sort(key=lambda kv: -len(kv[0]))
    flags = re.IGNORECASE if os.name == "nt" else 0
    pats = [(re.compile(re.escape(v), flags), tok) for v, tok in pairs]

    def one(s: str) -> str:
        for pat, tok in pats:
            s = pat.sub(tok, s)
        return s

    return _walk(obj, one)


def restore(obj: Any, root: str | os.PathLike, home: str | os.PathLike | None = None) -> Any:
    """The inverse of redact, for THIS machine: placeholders become the replay's root and home."""
    r, h = str(root).rstrip("\\/"), str(home or Path.home()).rstrip("\\/")
    return _walk(obj, lambda s: s.replace(ROOT_TOKEN, r).replace(HOME_TOKEN, h))


# ---- recording -----------------------------------------------------------------------------------------------

def server_command() -> list[str]:
    return [sys.executable, str(REPO / "hswarm.py"), "mcp"]


def record_path(target: str) -> Path:
    """HSWARM_RECORD=1 means ~/.hswarm/sessions/; a folder gets one file per session; anything else is the file.
    The "off" values (0, false, off, no) are filtered out before this, in mcp_server.main."""
    p = config.HOME / "sessions" if target.strip().lower() in ("1", "true", "on", "yes") else Path(target).expanduser()
    if p.is_dir() or p.suffix == "" or target.endswith(("/", "\\")):
        p.mkdir(parents=True, exist_ok=True)
        p = p / f"session-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{os.getpid()}.ndjson"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def record(cmd: Sequence[str], out: str | os.PathLike, root: str | os.PathLike | None = None,
           stdin=None, stdout=None) -> int:
    """Relay stdio between the client and a child server, appending every line to `out` as
    {"t", "dir": "c2s"|"s2c", "msg"}. A relay rather than a hook inside FastMCP: it sees the bytes the client
    really sent whatever the SDK version, and it outlives the server, so a crash is on record with its exit code."""
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    root = root or os.getcwd()
    env = {k: v for k, v in os.environ.items() if k != "HSWARM_RECORD"}  # the child must not record itself
    child = subprocess.Popen(list(cmd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    lock, t0 = threading.Lock(), time.monotonic()
    f = open(out, "a", encoding="utf-8")

    def log(direction: str, msg: Any) -> None:
        line = json.dumps({"t": round(time.monotonic() - t0, 3), "dir": direction, "msg": redact(msg, root)}, ensure_ascii=False)
        with lock:
            if f.closed:  # the daemon c2s pump can outlive a crashed child; its late lines have nowhere to go
                return
            f.write(line + "\n")
            f.flush()

    def pump(src, dst, direction: str) -> None:
        for raw in iter(src.readline, b""):
            try:
                dst.write(raw)
                dst.flush()
            except OSError:
                break
            try:
                msg = json.loads(raw)
            except ValueError:
                msg = {"_raw": raw.decode("utf-8", "replace").rstrip("\r\n")}
            log(direction, msg)
        if direction == "c2s":
            try:
                child.stdin.close()  # the client hung up: let the server see EOF and exit
            except OSError:
                pass

    log("meta", {"version": 1, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "cmd": list(cmd)})
    threading.Thread(target=pump, args=(stdin, child.stdin, "c2s"), daemon=True).start()
    pump(child.stdout, stdout, "s2c")
    rc = child.wait()
    log("exit", {"code": rc})
    with lock:
        f.close()
    return rc


# ---- replay --------------------------------------------------------------------------------------------------

def load(path: str | os.PathLike) -> list[dict]:
    """The client-to-server messages of a recording, in order. A bare ndjson of JSON-RPC messages works too."""
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        if "jsonrpc" in e:
            out.append(e)
        elif e.get("dir") == "c2s" and isinstance(e.get("msg"), dict) and "_raw" not in e["msg"]:
            out.append(e["msg"])
    return out


def save(messages: list[dict], path: str | os.PathLike) -> None:
    Path(path).write_text("".join(json.dumps({"dir": "c2s", "msg": m}, ensure_ascii=False) + "\n" for m in messages), encoding="utf-8")


def spend_reason(msg: dict) -> str | None:
    """Why replaying this message could cost money or touch the outside world; None when it is local-only."""
    if msg.get("method") != "tools/call":
        return None
    p = msg.get("params") or {}
    name, args = p.get("name"), p.get("arguments") or {}
    if name in OFFLINE_TOOLS:
        return None
    if name == "hswarm_keys" and args.get("action", "list") == "list":
        return None
    if name == "hswarm_models" and not args.get("refresh"):
        return None
    if name == "hswarm_cost" and args.get("balance") is False:
        return None
    return f"{name} can call a provider, spend or push; skipped (--allow-spend replays it)"


def _label(msg: dict) -> str:
    m = msg.get("method", "?")
    return f"{m}:{(msg.get('params') or {}).get('name')}" if m == "tools/call" else m


def _exc_name(text: str) -> str | None:
    m = _EXC.match(text.strip())
    return m.group(1).rsplit(".", 1)[-1] if m else None


def failure_of(req: dict, resp: dict) -> str | None:
    """A response's failure signature, or None. Stable across runs: exception TYPE and raising frame, never the
    message (it carries ids, paths and timestamps that differ every time)."""
    if "error" in resp:
        return f"rpc-error:{_label(req)}:{(resp['error'] or {}).get('code')}"
    result = resp.get("result") or {}
    text = next((c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"), "")
    if result.get("isError"):
        return f"tool-error:{_label(req)}:{_exc_name(text) or 'isError'}"
    try:
        data = json.loads(text) if text else None
    except ValueError:
        return None
    if isinstance(data, dict) and data.get("error"):
        # hswarm's _returns_errors shape: "Type: message" plus "file:line func" frames; keep type and the raiser.
        where = [re.sub(r":\d+", "", w) for w in data.get("where") or []]
        return ":".join(["tool-error", _label(req), _exc_name(str(data["error"])) or "error"] + where[-1:])
    return None


class _Server:
    def __init__(self, cmd: Sequence[str], cwd: str, env: dict):
        self.err = tempfile.TemporaryFile()
        self.proc = subprocess.Popen(list(cmd), cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err)
        self.lines: queue.Queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for raw in iter(self.proc.stdout.readline, b""):
            try:
                self.lines.put(json.loads(raw))
            except ValueError:
                pass  # a stray print on stdout is the server's problem to show, not a response
        self.lines.put(_EOF)

    def send(self, msg: dict) -> bool:
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
            return True
        except OSError:
            return False

    def response(self, rid: Any, timeout: float):
        """The response to request `rid`, _EOF when the server died first, None on timeout."""
        deadline = time.monotonic() + timeout
        while (left := deadline - time.monotonic()) > 0:
            try:
                m = self.lines.get(timeout=left)
            except queue.Empty:
                return None
            if m is _EOF:
                return _EOF
            if "method" in m and "id" in m:  # the server asks the client something: a replay has no answers
                self.send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "replay client: not supported"}})
            elif m.get("id") == rid and "method" not in m:
                return m
        return None

    def crash(self) -> str:
        try:
            rc = self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            rc = None
        self.err.seek(0)
        tail = self.err.read()[-8000:].decode("utf-8", "replace").splitlines()
        exc = next((n for n in map(_exc_name, reversed(tail)) if n), None)
        return f"crash:exit={rc}" + (f":{exc}" if exc else "")

    def close(self, timeout: float) -> int | None:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            return None
        finally:
            self.err.close()


def replay(messages: list[dict], cmd: Sequence[str] | None = None, root: str | os.PathLike | None = None,
           timeout: float = 60.0, allow_spend: bool = False, home: str | os.PathLike | None = None) -> dict:
    """Send `messages` to a fresh server, one request at a time (each waits for its response), and report every
    failure signature seen, in order. `home` runs the server against that HSWARM_HOME instead of the real one."""
    root = str(root or os.getcwd())
    env = {k: v for k, v in os.environ.items() if k != "HSWARM_RECORD"}
    if home:
        env["HSWARM_HOME"] = str(home)
    srv = _Server(cmd or server_command(), root, env)
    failures: list[str] = []
    skipped: list[dict] = []
    sent, died = 0, False
    for i, msg in enumerate(messages):
        why = None if allow_spend else spend_reason(msg)
        if why:
            skipped.append({"index": i, "why": why})
            continue
        if not srv.send(restore(msg, root)):
            failures.append(srv.crash())
            died = True
            break
        sent += 1
        if "method" in msg and "id" in msg:
            resp = srv.response(msg["id"], timeout)
            if resp is _EOF:
                failures.append(srv.crash())
                died = True
                break
            if resp is None:
                failures.append(f"hang:{_label(msg)}")
                break
            if sig := failure_of(msg, resp):
                failures.append(sig)
    rc = srv.close(min(timeout, 15.0))
    if not died and rc is None and not any(f.startswith("hang:") for f in failures):
        failures.append("hang:shutdown")
    elif not died and rc not in (0, None):
        failures.append(f"crash:exit={rc}")
    return {"sent": sent, "skipped": skipped, "failures": failures, "signature": failures[0] if failures else None, "exit_code": rc}


# ---- minimization --------------------------------------------------------------------------------------------

def ddmin(items: list, fails: Callable[[list], bool]) -> list:
    """Zeller's delta debugging: the smallest subsequence of `items` (order kept) for which `fails` still holds,
    1-minimal - removing any single remaining item makes it pass. `fails(items)` is assumed true on entry."""
    if fails([]):
        return []
    n = 2
    while len(items) >= 2:
        size = -(-len(items) // n)
        chunks = [items[i:i + size] for i in range(0, len(items), size)]
        reduced = False
        for chunk in chunks:  # reduce to a subset
            if fails(chunk):
                items, n, reduced = chunk, 2, True
                break
        if not reduced and len(chunks) > 2:  # reduce to a complement (with two chunks it is the other subset)
            for i in range(len(chunks)):
                rest = [x for j, c in enumerate(chunks) if j != i for x in c]
                if fails(rest):
                    items, n, reduced = rest, max(len(chunks) - 1, 2), True
                    break
        if not reduced:
            if n >= len(items):
                break  # every single item was tried on its own: 1-minimal
            n = min(len(items), n * 2)
    return items


def minimize(messages: list[dict], cmd: Sequence[str] | None = None, root: str | os.PathLike | None = None,
             timeout: float = 60.0, allow_spend: bool = False, home: str | os.PathLike | None = None,
             expect: str | None = None, runs: int = 1, rate: float = 1.0, log: Callable[[str], None] = lambda s: None) -> dict:
    """ddmin the transcript down to the messages that still fail with the SAME signature (or, with `expect`, any
    signature containing it). A flaky failure: `runs` replays per candidate, kept when hits/runs >= `rate`.
    The handshake (initialize, notifications/initialized) is always kept."""
    head = [m for m in messages if m.get("method") in HANDSHAKE]
    body = [i for i, m in enumerate(messages) if m.get("method") not in HANDSHAKE]
    target = expect
    if target is None:
        first = replay(messages, cmd, root, timeout, allow_spend, home)
        if not first["signature"]:
            return {"error": "the full transcript replays clean: nothing to minimize", "replay": first}
        target = first["signature"]
    log(f"signature: {target}")
    need, tests, cache = max(1, math.ceil(runs * rate - 1e-9)), 0, {}

    def hit(sigs: list[str]) -> bool:
        return any(target in s for s in sigs) if expect else target in sigs

    def fails(idx: list[int]) -> bool:
        nonlocal tests
        key = tuple(idx)
        if key not in cache:
            hits = 0
            for k in range(runs):
                tests += 1
                hits += hit(replay(head + [messages[i] for i in idx], cmd, root, timeout, allow_spend, home)["failures"])
                if hits >= need or hits + (runs - k - 1) < need:
                    break  # decided either way; a flaky predicate is the expensive part
            cache[key] = hits >= need
            log(f"  {len(idx)} messages: {'fails' if cache[key] else 'passes'}")
        return cache[key]

    if not fails(body):
        return {"error": f"the signature {target!r} did not reproduce at {runs} run(s) and rate {rate}", "signature": target}
    kept = ddmin(body, fails)
    return {"signature": target, "kept": len(kept), "from": len(body), "replays": tests,
            "messages": head + [messages[i] for i in kept]}


# ---- CLI -----------------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    server = None
    if "--" in argv:  # everything after -- is the server command (default: this checkout's `hswarm.py mcp`)
        server, argv = argv[argv.index("--") + 1:], argv[:argv.index("--")]
    ap = argparse.ArgumentParser(prog="hswarm replay", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="hswarm replay FILE [options] [-- SERVER COMMAND ...]")
    ap.add_argument("file", help="a recording (hswarm mcp --record) or a bare ndjson of JSON-RPC messages")
    ap.add_argument("--simple", action="store_true", help="coarse replay: only the handshake and the tools/call requests")
    ap.add_argument("--minimize", action="store_true", help="ddmin the transcript to the messages that still fail the same way")
    ap.add_argument("--expect", help="with --minimize: keep any failure whose signature contains this, instead of the first one seen")
    ap.add_argument("--runs", type=int, default=1, help="with --minimize: replays per candidate, for a flaky failure")
    ap.add_argument("--rate", type=float, default=1.0, help="with --minimize: the hit rate over --runs that counts as failing")
    ap.add_argument("--out", help="with --minimize: where the minimized transcript goes (default FILE.min.ndjson)")
    ap.add_argument("--root", help="what @PROJECT_ROOT@ becomes, and the server's cwd (default: the current folder)")
    ap.add_argument("--home", help="run the server with this HSWARM_HOME (a scratch folder keeps the real one untouched)")
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds to wait for each response")
    ap.add_argument("--allow-spend", dest="allow_spend", action="store_true",
                    help="also replay calls that reach a provider or push (hswarm_run, _ask, _decide, _sync, ...): costs money")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    msgs = load(a.file)
    if a.simple:
        msgs = [m for m in msgs if m.get("method") in HANDSHAKE or m.get("method") == "tools/call"]
    common = dict(cmd=server, root=a.root, timeout=a.timeout, allow_spend=a.allow_spend, home=a.home)
    if not a.minimize:
        out = replay(msgs, **common)
        print(json.dumps(out, indent=2) if a.json else
              f"sent {out['sent']}, skipped {len(out['skipped'])}, exit {out['exit_code']}\n" + "\n".join(out["failures"] or ["no failures"]))
        return 1 if out["failures"] else 0
    out = minimize(msgs, expect=a.expect, runs=max(1, a.runs), rate=a.rate, log=(lambda s: None) if a.json else print, **common)
    if "messages" in out:
        dest = Path(a.out or Path(a.file).with_suffix(".min.ndjson"))
        save(out.pop("messages"), dest)
        out["out"] = str(dest)
    print(json.dumps(out, indent=2) if a.json else json.dumps(out))
    return 0 if "out" in out else 2
