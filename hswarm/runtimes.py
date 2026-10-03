"""Pluggable tool runtimes: WHERE an api worker's tools run, not only which paths they may touch.

Sandbox (tools.py) confines paths, but its bash is this machine's shell. A task's `runtime` field moves
every tool into an isolate instead:

- "" or "host" (the default): this machine, unchanged.
- "docker-container:<id>" / "podman-container:<id>": `exec -i` into a RUNNING container (hswarm never starts one).
- "ssh:<target>": a remote host, an ssh config alias or user@host, non-interactive (BatchMode, keys only).

This module is the transport: it parses the spec and builds the host argv that runs one POSIX sh script
in the isolate, in the task's cwd, under the isolate's own `timeout N` with a host-side guard of N + 5 s
behind it. The tools themselves (RemoteSandbox) are remote_tools.py. The idea follows llama.cpp's server
tools runtime layer (tools/server/server-tools.cpp, MIT); the code is written fresh for hswarm.
"""
from __future__ import annotations

import os
import posixpath
import re
import shlex
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import PurePosixPath

from .procs import run_hidden, scrubbed_env

HOST = "host"
GRAMMAR = "host | docker-container:<id> | podman-container:<id> | ssh:<target>"
_KINDS = {"docker-container": "docker", "podman-container": "podman", "ssh": "ssh"}
# A container id or ssh target becomes one argv element, and one starting with "-" is read as an option
# (`ssh -oProxyCommand=...` runs a local command). So the charset is closed and it cannot open with a dash.
_TARGET_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@-]*$")
# The isolate's own `timeout` answers first (exit 124, procs.TIMEOUT_EXIT); the host guard only fires when the
# transport itself (the docker CLI, an ssh session) hangs.
HOST_GRACE_S = 5
# What the docker/podman/ssh CLI needs to reach its daemon or agent. The worker child scrub (procs.py) drops
# these (SSH_AUTH_SOCK reads as a secret name), but they go to the transport client only: docker exec forwards
# no host variable into the container, and ssh forwards only what the remote sshd AcceptEnv takes.
_TRANSPORT_VARS = ("SSH_AUTH_SOCK", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH",
                   "DOCKER_TLS_VERIFY", "CONTAINER_HOST", "CONTAINER_CONNECTION")

# Runs first inside the isolate: enter the task cwd, then bound the real command with `timeout N`.
# macOS ships no `timeout` (Homebrew coreutils names it gtimeout); with neither, the host guard is the bound.
_WRAP = (
    'cd -- "$1" || exit 1; n=$2; shift 2; '
    'if command -v timeout >/dev/null 2>&1; then exec timeout "$n" "$@"; '
    'elif command -v gtimeout >/dev/null 2>&1; then exec gtimeout "$n" "$@"; '
    'else exec "$@"; fi'
)


@dataclass(frozen=True)
class Runtime:
    kind: str  # docker | podman | ssh
    target: str

    @property
    def spec(self) -> str:
        return f"ssh:{self.target}" if self.kind == "ssh" else f"{self.kind}-container:{self.target}"

    @property
    def shell_script(self) -> str:
        """The bash tool's interpreter: bash when the isolate has it, else sh. Over ssh a login shell, because a
        non-interactive ssh command skips the profile that puts Homebrew and friends on PATH."""
        flag = "-lc" if self.kind == "ssh" else "-c"
        return f'if command -v bash >/dev/null 2>&1; then exec bash {flag} "$1"; else exec sh -c "$1"; fi'

    def argv(self, script: str, args: list[str], cwd: str, timeout_s: int) -> list[str]:
        """The host command that runs `sh -c script args...` in the isolate, in `cwd`, under `timeout timeout_s`."""
        inner = ["sh", "-c", _WRAP, "sh", cwd, str(int(timeout_s)), "sh", "-c", script, "sh", *args]
        if self.kind == "ssh":
            # ssh joins its remote arguments into ONE string for the remote shell, so it is quoted here as one.
            return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", self.target, shlex.join(inner)]
        return [self.kind, "exec", "-i", self.target, *inner]

    async def run(self, script: str, args: list[str], cwd: str, timeout_s: int, stdin_text: str | None = None) -> tuple[int, str, str]:
        cmd = self.argv(script, args, cwd, timeout_s)
        if not shutil.which(cmd[0]):
            raise FileNotFoundError(f"{cmd[0]} is not on PATH; runtime {self.spec} needs it")
        env = scrubbed_env({k: os.environ[k] for k in _TRANSPORT_VARS if os.environ.get(k)})
        # The local process's cwd is irrelevant (the command runs in the isolate); a temp dir always exists.
        return await run_hidden(cmd, tempfile.gettempdir(), timeout_s + HOST_GRACE_S, env=env, stdin_text=stdin_text)


def parse_runtime(spec: str | None) -> Runtime | None:
    """None for this host, else the Runtime the spec names. A malformed spec raises ValueError naming the grammar."""
    s = str(spec or "").strip()
    if s in ("", HOST):
        return None
    kind, sep, target = s.partition(":")
    if not sep or kind not in _KINDS:
        raise ValueError(f"runtime {s!r} is not one of: {GRAMMAR}")
    if not _TARGET_RX.match(target):
        raise ValueError(f"runtime {s!r}: the target must be letters, digits and _ . @ - and cannot start with '-'")
    return Runtime(_KINDS[kind], target)


def posix_abs(p: str | PurePosixPath) -> PurePosixPath:
    """An absolute, normalised POSIX path in the isolate; a relative one is refused (there is no cwd to anchor it)."""
    s = str(p).replace("\\", "/")
    if not s.startswith("/"):
        raise ValueError(f"{str(p)!r} is not an absolute POSIX path; a runtime's cwd and roots are paths inside it")
    return PurePosixPath("/" + posixpath.normpath(s).lstrip("/"))
