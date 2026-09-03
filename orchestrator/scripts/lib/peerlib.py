"""peerlib - the NATIVE message channel between Claude Code sessions, with no UI in the way.

THE WHOLE POINT OF THE CLI ORCHESTRATOR (owner, 2026-09-01, after a day of GUI-automation
defects: "would all of these things I've been complaining about be completely avoided if we
switched to using CLI/console?"). Most of them would, and this module is why: a running session
publishes a small record of itself, and any other process holding its token can put a message
straight into its input queue. No window, no accessibility tree, no clicking, no verify-snippet
- the session id addresses and the token authenticates.

THE REGISTRY, measured 2026-09-01. Every live session writes two files into
`<CLAUDE_CONFIG_DIR>/sessions/`:

    <pid>.json          {pid, sessionId, cwd, startedAt, procStart, messagingSocketPath, ...}
    <pid>.<hash>.key    {peerToken, procStartFt, pidDomain}

`messagingSocketPath` on Windows is a named pipe (`\\\\.\\pipe\\LOCAL\\cc-msg-<hash>`); on
POSIX it is a unix socket path. The protocol is newline-delimited JSON: an `auth` frame
carrying the token, then a `user` frame carrying the message. That is the same channel one
session's SendMessage uses to reach another, which is why it is safe mid-turn - the message
enqueues and the session drains it when its current turn ends.

⛔ THE ACCOUNT IS THE CONFIG DIR. A CLI account is isolated by `CLAUDE_CONFIG_DIR`, so its
sessions register under THAT directory, not under ~/.claude. Every function here takes the
config dir explicitly - there is no ambient "the" registry once there is more than one account.
"""

from __future__ import annotations

import glob
import json
import os
import time
from pathlib import Path


def registry_dir(config_dir: str | Path) -> Path:
    return Path(config_dir) / "sessions"


def _pid_alive(pid: int) -> bool:
    """Is that process still running? A stale record outlives its session by design - the
    registry is written on start, not cleaned on crash - so liveness is checked, never assumed."""
    if os.name == "nt":
        import subprocess

        try:
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                                 capture_output=True, text=True, timeout=20)
            return str(pid) in (out.stdout or "")
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def live_sessions(config_dir: str | Path, check_alive: bool = True) -> list[dict]:
    """Every session registered under one account's config dir, newest first.

    Each row carries the record plus `configDir`, `tokenPath` and `token` when the key file is
    readable - a record without its key cannot be messaged, and saying so is more useful than
    a delivery that fails later for a reason nobody can see.
    """
    out: list[dict] = []
    root = registry_dir(config_dir)
    if not root.exists():
        return out
    for meta in sorted(root.glob("*.json")):
        try:
            rec = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        try:
            pid = int(rec.get("pid") or 0)
        except (TypeError, ValueError):
            pid = 0
        if not pid:
            continue
        if check_alive and not _pid_alive(pid):
            continue
        token = None
        token_path = None
        for k in glob.glob(str(meta.with_suffix("")) + ".*.key"):
            try:
                token = json.loads(Path(k).read_text(encoding="utf-8")).get("peerToken")
                token_path = k
                break
            except (OSError, ValueError):
                continue
        out.append({**rec, "pid": pid, "configDir": str(config_dir),
                    "token": token, "tokenPath": token_path,
                    "startedAtMs": int(rec.get("startedAt") or 0)})
    out.sort(key=lambda r: -r["startedAtMs"])
    return out


def find(config_dirs, session_id: str) -> dict | None:
    """The live record for one session id, across several accounts."""
    for d in config_dirs:
        for rec in live_sessions(d):
            if str(rec.get("sessionId")) == str(session_id):
                return rec
    return None


def send(record: dict, text: str, timeout: float = 20.0) -> tuple[bool, str]:
    """Put a message into that session's input queue. (ok, detail).

    Two frames, newline-delimited: auth then the user message. The socket is closed straight
    after - this channel acknowledges by ENQUEUEING, not by replying, so waiting for a response
    would just hang. Whether the session then MOVED is the caller's business to verify from the
    transcript, exactly as the desktop courier does.
    """
    path = record.get("messagingSocketPath")
    token = record.get("token")
    if not path:
        return False, "that session published no messaging socket"
    if not token:
        return False, "no peer token beside that session's record - cannot authenticate"
    frames = (
        json.dumps({"type": "auth", "token": token}) + "\n"
        + json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"
    ).encode("utf-8")
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            if os.name == "nt":
                with open(path, "r+b", buffering=0) as pipe:
                    pipe.write(frames)
                    pipe.flush()
            else:
                import socket

                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                    sock.connect(path)
                    sock.sendall(frames)
            return True, "enqueued through the session's own peer channel"
        except (FileNotFoundError, BrokenPipeError) as err:
            # TWO causes raise this identically on a Windows named pipe (verified 2026-09-01):
            # the session EXITED between enumeration and send (permanent - its pipe is torn
            # down with it), and the single-instance pipe server's recycle window between one
            # client disconnecting and its next CreateNamedPipe (transient: ERROR_FILE_NOT_FOUND,
            # not PIPE_BUSY, and a second message into the same session hits it routinely).
            # The PROCESS tells them apart: a dead pid fails fast instead of burning the whole
            # timeout on a target that can never succeed; a live one keeps retrying.
            pid = record.get("pid")
            if pid and not _pid_alive(pid):
                return False, (f"session's messaging channel is gone - its process {pid} has "
                               f"exited: {err}")
            last = str(err)[:160]
            time.sleep(0.4)
        except OSError as err:
            # A pipe instance can be momentarily busy; that is not a failure, it is a queue.
            last = str(err)[:160]
            time.sleep(0.4)
    return False, f"could not write to {path}: {last}"
