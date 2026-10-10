"""Out-of-process permission broker: the sandbox asks a separate process before it runs a shell command or writes a file.

The api backend's Sandbox keeps a worker inside its roots, but inside them `bash` and the write tools
had no policy at all. A policy that lives in the same process as the code it governs is one import
away from being patched out, so the decision is made by a broker program the operator names in
HSWARM_PERMISSION_BROKER. hswarm starts it once per process and every worker's check goes over its
stdin/stdout, one JSON line each way (the shape follows Deno's permission broker, denoland/deno
runtime/permissions/broker.rs, MIT - idea only, written fresh here):

    request  {"v": 1, "pid": <hswarm pid>, "id": <n>, "datetime": "<utc iso>", "permission": "run"|"write", "value": "<command or absolute path>", "cwd": "<worker cwd>"}
    reply    {"id": <n>, "result": "allow"|"deny", "reason": "<shown to the model on deny>"}

It fails CLOSED: a broker that cannot start, dies, answers late, answers another id or an unknown
result raises BrokerUnavailable, which the tool dispatcher does not swallow, so the worker aborts
instead of running the action unchecked. The broken process is dropped and the next check starts a
fresh one. No env var, no broker, nothing changes.
"""
from __future__ import annotations

import atexit
import json
import os
import queue
import shlex
import subprocess
import threading
from datetime import datetime, timezone

from .procgate import spawn_kwargs
from .procs import kill_tree

BROKER_ENV = "HSWARM_PERMISSION_BROKER"
TIMEOUT_ENV = "HSWARM_PERMISSION_BROKER_TIMEOUT_S"
PROTOCOL_VERSION = 1
DEFAULT_TIMEOUT_S = 10.0


class BrokerUnavailable(RuntimeError):
    """The broker could not give a valid verdict; the action must not run and the worker aborts."""


class PermissionBroker:
    """One long-lived broker child shared by every worker in this process; checks are serialised on a lock."""

    def __init__(self, command: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        self.command = command
        self.timeout_s = timeout_s
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue[str] = queue.Queue()  # the running child's stdout, one line each, "" at its end
        self._lock = threading.Lock()
        self._next_id = 0

    def _spawn(self) -> subprocess.Popen:
        # Windows hands the string to CreateProcess, which parses quoted paths itself; POSIX needs argv.
        argv = self.command if os.name == "nt" else shlex.split(self.command)
        try:
            proc = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
                bufsize=1, **spawn_kwargs(),  # its own session on POSIX: see spawn_kwargs
            )
        except OSError as e:
            raise BrokerUnavailable(f"permission broker {self.command!r} could not start: {e}") from e
        # Its own queue per child, so a late line from a dropped child can never answer the next one's request.
        self._lines = lines = queue.Queue()
        threading.Thread(target=_pump, args=(proc, lines), name="hswarm-broker-reader", daemon=True).start()
        return proc

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            kill_tree(proc.pid)  # the tree: a wrapper script's child may hold the pipe
            proc.kill()  # and the child by its own handle, which a reused pid cannot misdirect
            proc.wait(5)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def check(self, permission: str, value: str, cwd: str) -> tuple[bool, str]:
        """(allowed, reason) from the broker; BrokerUnavailable on anything but a well-formed matching answer."""
        with self._lock:
            try:
                return self._ask(permission, value, cwd)
            except BrokerUnavailable:
                self.close()
                raise

    def _ask(self, permission: str, value: str, cwd: str) -> tuple[bool, str]:
        if self._proc is None or self._proc.poll() is not None:
            self._proc = self._spawn()
        proc = self._proc
        self._next_id += 1
        request = {
            "v": PROTOCOL_VERSION, "pid": os.getpid(), "id": self._next_id,
            "datetime": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "permission": permission, "value": value, "cwd": cwd,
        }
        try:
            proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise BrokerUnavailable(f"permission broker unreachable: {e}") from e
        # The wait keeps its own clock rather than relying on a kill to end a blocking read: a kill that misses the
        # child (a reused pid, a wrapper's grandchild holding the pipe) would leave the read blocked for good.
        try:
            line = self._lines.get(timeout=self.timeout_s)
        except queue.Empty:
            line = ""
        if not line:
            raise BrokerUnavailable(f"permission broker gave no answer within {self.timeout_s:g}s (it exited or hung)")
        try:
            reply = json.loads(line)
        except ValueError as e:
            raise BrokerUnavailable(f"permission broker sent a line that is not JSON: {line.strip()[:200]!r}") from e
        if not isinstance(reply, dict) or reply.get("id") != request["id"]:
            raise BrokerUnavailable(f"permission broker answered id {reply.get('id') if isinstance(reply, dict) else None!r} to request {request['id']}")
        result = reply.get("result")
        if result not in ("allow", "deny"):
            raise BrokerUnavailable(f"permission broker sent unknown result {result!r}")
        return result == "allow", str(reply.get("reason") or "")


def _pump(proc: subprocess.Popen, lines: queue.Queue) -> None:
    """Copy a broker child's stdout into its queue, then "" once it closes or fails."""
    try:
        for line in proc.stdout:
            lines.put(line)
    except (OSError, ValueError):
        pass
    finally:
        lines.put("")


_broker: PermissionBroker | None = None
_broker_guard = threading.Lock()


def broker_from_env() -> PermissionBroker | None:
    """The process's broker for the command in HSWARM_PERMISSION_BROKER, or None when none is configured.

    Read on every check, not at import, so a changed command replaces the old broker instead of being ignored.
    """
    global _broker
    command = os.environ.get(BROKER_ENV, "").strip()
    if not command:
        return None
    try:
        timeout_s = float(os.environ.get(TIMEOUT_ENV) or DEFAULT_TIMEOUT_S)
    except ValueError:
        timeout_s = DEFAULT_TIMEOUT_S
    with _broker_guard:
        if _broker is None or _broker.command != command:
            if _broker is not None:
                _broker.close()
            _broker = PermissionBroker(command)
        _broker.timeout_s = timeout_s
        return _broker


def close_broker() -> None:
    """Stop this process's broker child, if one is running."""
    global _broker
    with _broker_guard:
        if _broker is not None:
            _broker.close()
            _broker = None


atexit.register(close_broker)
