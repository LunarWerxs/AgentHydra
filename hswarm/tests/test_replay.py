"""Session record / replay / minimize (hswarm/replay.py), against a tiny fake stdio server - never the real one,
so no test here can reach a provider. The fake answers every request, crashes with KeyError on a tool named
`boom`, and crashes on hswarm_ask so a replay that sent a spending call would show it."""
from __future__ import annotations

import io
import json
import sys

from hswarm import replay

FAKE = r'''
import json, sys
while True:
    line = sys.stdin.readline()
    if not line:
        break
    m = json.loads(line)
    name = (m.get("params") or {}).get("name")
    if name == "boom":
        raise KeyError("boom")
    if name == "hswarm_ask":
        raise RuntimeError("a replay spent money")
    if "id" in m:
        text = json.dumps({"cwd": ((m.get("params") or {}).get("arguments") or {}).get("cwd")})
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text", "text": text}]}}), flush=True)
'''


def _fake(tmp_path):
    p = tmp_path / "fake_server.py"
    p.write_text(FAKE, encoding="utf-8")
    return [sys.executable, str(p)]


def _call(i, name, **args):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}}


HANDSHAKE = [{"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}, {"jsonrpc": "2.0", "method": "notifications/initialized"}]


def test_ddmin_is_one_minimal():
    """The minimizer's core: two interacting items buried in twenty are found, nothing else kept."""
    assert replay.ddmin(list(range(20)), lambda s: {3, 11} <= set(s)) == [3, 11]


def test_minimize_reduces_a_long_session_to_the_crashing_call(tmp_path):
    msgs = HANDSHAKE + [_call(i, "hswarm_status", job_id=f"j{i}") for i in range(1, 12)]
    msgs.insert(9, _call(99, "boom"))
    out = replay.minimize(msgs, cmd=_fake(tmp_path), root=str(tmp_path), timeout=20, allow_spend=True)
    assert out["signature"] == "crash:exit=1:KeyError"
    assert [m.get("params", {}).get("name") for m in out["messages"] if m.get("method") == "tools/call"] == ["boom"]
    assert out["from"] == 12 and out["kept"] == 1


def test_replay_never_sends_a_spending_call_by_default(tmp_path):
    msgs = HANDSHAKE + [_call(1, "hswarm_ask", prompt="hi"), _call(2, "hswarm_jobs")]
    out = replay.replay(msgs, cmd=_fake(tmp_path), root=str(tmp_path), timeout=20)
    assert out["failures"] == [] and out["exit_code"] == 0
    assert [s["index"] for s in out["skipped"]] == [2]


def test_recording_uses_placeholders_that_replay_restores(tmp_path):
    """A transcript recorded in one folder must replay in another: the root never lands in the file."""
    root = tmp_path / "proj"
    lines = HANDSHAKE + [_call(1, "hswarm_status", cwd=str(root / "sub"))]
    stdin = io.BytesIO("".join(json.dumps(m) + "\n" for m in lines).encode("utf-8"))
    rec, stdout = tmp_path / "session.ndjson", io.BytesIO()
    assert replay.record(_fake(tmp_path), rec, root=root, stdin=stdin, stdout=stdout) == 0
    # Check the DECODED entries, not the file text: the file escapes every string once more, which would hide a
    # root left JSON-escaped (backslash-doubled) inside the s2c tool result's text.
    entries = [json.loads(line) for line in rec.read_text(encoding="utf-8").splitlines() if line.strip()]
    strings: list[str] = []
    replay._walk(entries, lambda s: strings.append(s) or s)
    forms = {str(root), str(root).replace("\\", "/"), json.dumps(str(root))[1:-1]}
    assert not [s for s in strings for f in forms if f.lower() in s.lower()]
    s2c = [e["msg"]["result"]["content"][0]["text"] for e in entries if e["dir"] == "s2c" and e["msg"].get("id") == 1]
    assert s2c and "@PROJECT_ROOT@" in s2c[0]
    assert b'"id": 1' in stdout.getvalue()  # the relay handed the server's answer back to the client
    msgs = replay.load(rec)
    assert len(msgs) == 3
    other = tmp_path / "elsewhere"
    assert replay.restore(msgs[-1], other)["params"]["arguments"]["cwd"].replace("\\", "/") == f"{other}/sub".replace("\\", "/")
