"""ONE MCP server per machine instead of one per chat (owner ask, 2026-09-24).

A stdio server is a child of each Claude chat: 59-73 MB apiece, about 2.6 GB at 40 chats. `python -m hswarm mcp --http`
serves FastMCP's streamable-http transport on 127.0.0.1 only, and every chat connects to it with
{"type": "http", "url": "http://127.0.0.1:7793/mcp"}. `python -m hswarm serve-ensure` keeps it up with nobody watching:
it returns at once when the port answers, else starts the server detached and hidden, behind a lock file so two
callers cannot start two.

⛔ ONE PROCESS SERVES EVERY CHAT, so nothing a tool does may read the server's own environment or working folder:
both belong to whoever started the server. The caller stamp (caller.detect) and a task's default cwd
(spec.Task._validate) read the calling request instead: REQUEST holds the X-Hswarm-* headers of the MCP request
being handled, set by `_request_headers` for the duration of that request. A header the chat did not send stays
"" - the stamp never falls back to the server's identity.
"""
from __future__ import annotations

import contextvars
import http.client
import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote, unquote

from . import __version__, config, livecode
from .procgate import PROCESS_QUERY_LIMITED_INFORMATION, pid_alive

HOST = "127.0.0.1"  # loopback only: the server runs workers with file and shell tools, it must never face a network
LOCAL_HOSTS = ("127.0.0.1", "localhost", "[::1]")
PORT = int(os.environ.get("HSWARM_PORT") or 7793)  # HSWARM_PORT overrides; --port overrides both
REPLACE_TRIES = 5  # os.replace attempts: Windows refuses it while another process has the target open
LOCK_STALE_S = 60.0  # a lock older than this belongs to a caller that died mid-start
IDLE_SESSION_S = 86_400.0  # a chat idle overnight keeps its session; the SDK default (30 min) would drop it
LOG_ROTATE_BYTES = 20 * 1024 * 1024  # the server log reached 113 MB in 6.4 days (about 17 MiB a day, 2026-10-02)
# The shared server restarts itself onto the clone's newest commit (_watch). pid 43908 ran 2026-09-30 code for 48 h
# while five fixes sat on disk: 2,063 tasks for $319.04, 1,015 of them served by a model the owner had barred ($117.30),
# 32 killed by a cap already raised. It runs a committed copy (livecode.py), never the working tree, so a restart only
# waits on what is committed. A restart is not free: the successor re-runs every task that was in flight (adopt_orphans
# keeps only finished answers) and every chat's MCP session reconnects. So it waits for a commit that is quiet and
# imports, for a moment with no running job (that moment may never come, so not for long), and never twice in half an hour.
WATCH_EVERY_S = 60.0
SETTLE_S = 300.0  # the clone's last hswarm commit is at least this old: a commit can be followed by its own fix-up
MIN_UP_S = 1800.0  # no self-restart in a server's first half hour, so a restart can never loop, whatever the disk does
BUSY_HOLD_S = 900.0  # how long a restart that is otherwise due waits for a moment with no running job

ACTIVE = False  # True inside the shared HTTP server; stdio servers and the CLI keep reading their own environment
SERVING_PORT: int | None = None  # the port this process serves on, when it is the shared server
REQUEST: contextvars.ContextVar[dict | None] = contextvars.ContextVar("hswarm_request", default=None)
HEADERS = {"session": "x-hswarm-session", "chat": "x-hswarm-chat", "instance": "x-hswarm-instance", "cwd": "x-hswarm-cwd",
           "mcp_session": "mcp-session-id",
           "climayte_worker": "x-hswarm-climayte-worker",  # "1" when the calling chat is a CliMayte worker (climayte_route.eligible)
           "envelope": "x-hswarm-envelope"}  # the spawn envelope a cc worker's hswarm runs under (envelope.inherited)
SHARED_NOTE = " This one server is shared by every chat on this machine and cannot see your folder: hence the ABSOLUTE cwd."
PACKAGE = Path(__file__).resolve().parent


def _sources() -> dict[str, int]:
    """Every hswarm source file in the package: relative name -> mtime in ns."""
    out = {}
    for p in PACKAGE.rglob("*.py"):
        if "tests" in p.relative_to(PACKAGE).parts:  # relative: a checkout under a folder named tests is still a package
            continue
        try:
            out[p.relative_to(PACKAGE).as_posix()] = p.stat().st_mtime_ns
        except FileNotFoundError:  # a file gone between the listing and the stat (mid-checkout) is not a source
            continue
    return out


# The sources as this process found them when it loaded: a long-running server runs this code whatever lands on disk
# after it. Job 20260925-210332-1928 (21:03Z) lost all four read-only tool tasks with zero turns to "task timeout
# exhausted across Swarm routes", a message 80de4e9 had deleted 2.5 hours earlier together with the bug behind it (gate
# queue time spent from the task's timeout), because the shared server had not restarted since; the failure was then
# filed as open against code that no longer had it. behind() says so in hswarm_run's first response and in doctor, and
# code_stamp() is on every job's runner record.
LOADED = _sources()


def _iso(ns: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ns / 1e9))


def code_stamp() -> dict:
    """The code this process runs: its version, when the newest source file it loaded was written, and the commit when
    it runs a committed copy (livecode.py)."""
    mine = livecode.running()
    return {"version": __version__, "code_at": _iso(max(LOADED.values())) if LOADED else None,
            **({"commit": mine["commit"][:12]} if mine else {})}


def behind() -> str | None:
    """A sentence when hswarm changed after this process loaded, else None: a fix that landed since is not running
    here, and a result from this process is from the older code. A committed copy is behind the clone's newer commits;
    a process run from the clone is behind any source file changed on disk."""
    mine = livecode.running()
    if mine:
        head = livecode.head(Path(mine["source"]))
        if not head or head["tree"] == mine["tree"]:
            return None
        return (f"this hswarm server (pid {os.getpid()}) runs hswarm as commit {mine['commit'][:12]} has it, and "
                f"{mine['source']} has committed hswarm changes since (commit {head['commit'][:12]}): a fix in them is "
                f"not running here; it moves onto them by itself once they are {SETTLE_S / 60:.0f} min old (the next "
                f"server on port {SERVING_PORT} carries its running jobs on)")
    now = _sources()
    changed = sorted(n for n in LOADED.keys() | now.keys() if LOADED.get(n) != now.get(n))
    if not changed:
        return None
    names = ", ".join(changed[:6]) + (f" and {len(changed) - 6} more" if len(changed) > 6 else "")
    how = (f"this shared server moves onto the clone's last commit by itself once that commit is {SETTLE_S / 60:.0f} min "
           f"old (the next server on port {SERVING_PORT} carries its running jobs on), and an edit nobody committed never "
           "runs there" if SERVING_PORT and livecode.source() else "restart this hswarm process to load them")
    return (f"this hswarm process (pid {os.getpid()}, {__version__}, code from {code_stamp()['code_at']}) runs the code it "
            f"loaded, and {len(changed)} source file(s) changed on disk since ({names}): a fix in them is not running "
            f"here; {how}")


def process_started(pid: int) -> int | None:
    """When a live process was created, as a number that only compares equal to itself (a Windows FILETIME, Linux
    clock ticks since boot); None when the process is gone or this platform cannot say. A pid alone does not name a
    process: the system hands a dead one's pid to the next process started."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        k = ctypes.windll.kernel32
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not h:
            return None
        try:
            created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
            if not k.GetProcessTimes(h, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
                return None
            return (created.dwHighDateTime << 32) | created.dwLowDateTime
        finally:
            k.CloseHandle(h)
    try:  # /proc/<pid>/stat: the command (field 2) may hold spaces and brackets, so count from its closing one; starttime is field 22
        return int(Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def local_host(host: str, port: int) -> bool:
    """True when a request's Host header names this machine. A page on another origin that rebinds its DNS name to
    127.0.0.1 still sends its own name, so every custom route refuses anything else."""
    return host in {f"{h}:{port}" for h in LOCAL_HOSTS}


def atomic_write(path: Path, text: str | bytes, private: bool = False) -> None:
    """Swap `text` (or bytes, written as they are) in as the whole of `path`: a reader sees the old file or the new one,
    never half of either. private=True makes it owner-only (0600 on POSIX) from the moment the temp file exists, never
    after the write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")  # one per process: two writers never share a temp file
    tmp.unlink(missing_ok=True)  # a leftover from a crash could carry a wider mode than asked for
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if private else 0o666)
    with os.fdopen(fd, "wb") if isinstance(text, bytes) else os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    for attempt in range(REPLACE_TRIES):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: a server is reading the target right now (config.refresh)
            if attempt == REPLACE_TRIES - 1:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05 * (attempt + 1))


class _NoQuery(logging.Filter):
    """uvicorn's access log writes each request line to the server log; a query string can carry a key, a prompt or
    the console's sign-in token, so the line keeps the path only."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and "?" in args[2]:
            record.args = (*args[:2], args[2].split("?", 1)[0], *args[3:])
        return True


async def _request_headers(ctx, call_next):
    """Server middleware: every MCP request runs with REQUEST set from its own HTTP headers."""
    headers = getattr(getattr(ctx, "request", None), "headers", None) or {}
    token = REQUEST.set({k: unquote(headers.get(h) or "") for k, h in HEADERS.items()})  # connect() percent-encodes
    try:
        return await call_next(ctx)
    finally:
        REQUEST.reset(token)


# A client that drops while Windows is still accepting it (a probe that gave up, a chat closing) fails that ONE
# accept with WinError 64, and CPython's proactor serving loop answers ANY accept error by closing the LISTENING
# socket (asyncio/proactor_events.py _start_serving, 3.14.2): the server lives on, running its jobs, but deaf. The next
# chat then finds nothing on the port and starts another server, which adopts the deaf one's running jobs while the
# deaf one keeps running them. This incident happened on ZSwarm's port 7790 on 2026-09-27, each start preceded by that WinError 64.
_DROPPED_MID_ACCEPT = {64, 1236}  # ERROR_NETNAME_DELETED, ERROR_CONNECTION_ABORTED


def keep_listening_through_dropped_clients() -> None:
    """On Windows, retry an accept whose client vanished instead of letting it close the listener."""
    if os.name != "nt":
        return
    import asyncio
    from asyncio import windows_events

    accept = windows_events.IocpProactor.accept
    if getattr(accept, "hswarm_retrying", False):
        return

    def retrying(self, listener):
        async def next_client():
            while True:
                try:
                    return await accept(self, listener)
                except OSError as e:
                    if not isinstance(e, ConnectionResetError) and getattr(e, "winerror", None) not in _DROPPED_MID_ACCEPT:
                        raise

        return asyncio.ensure_future(next_client(), loop=self._loop)

    retrying.hswarm_retrying = True
    windows_events.IocpProactor.accept = retrying


def serve(port: int = PORT) -> None:
    """Run the shared server in this process (blocks). `python -m hswarm mcp --http [--port N]`."""
    global ACTIVE, SERVING_PORT
    from starlette.responses import JSONResponse

    from .mcp_server import mcp

    keep_listening_through_dropped_clients()
    ACTIVE, SERVING_PORT = True, port
    config.ensure_dirs()
    from . import verdict

    verdict.write()  # offline; the routing gate reads it (verdict.py)
    started = time.time()
    # Only this server has no folder of the caller's own; a stdio server's chats never need the sentence.
    mcp._lowlevel_server.instructions = (mcp._lowlevel_server.instructions or "") + SHARED_NOTE

    # `package` is the folder this server serves: the clone a committed copy came from, which is the folder the
    # AgentHydra daemon checks before it adopts a server (hswarm.ts runsFrom); `code_dir` is where its code runs.
    mine = livecode.running()
    where = {"package": mine["source"] if mine else str(PACKAGE.parent), "code_dir": str(PACKAGE.parent),
             **({"tree": mine["tree"]} if mine else {})}

    @mcp.custom_route("/health", methods=["GET"])
    async def health(request):
        if not local_host(request.headers.get("host", ""), port):  # a rebound page must not learn hswarm runs here
            return JSONResponse({"error": "answers only on 127.0.0.1 / localhost"}, status_code=403)
        return JSONResponse({"hswarm": True, "pid": os.getpid(), "port": port, **where, "up_s": round(time.time() - started), **code_stamp()})

    from . import console

    console.mount(mcp, port)  # the web console and the HTTP API: /ui, /api/* (console.py)
    mcp._lowlevel_server.middleware.append(_request_headers)  # the SDK's documented seam: Server.middleware
    logging.getLogger("uvicorn.access").addFilter(_NoQuery())
    for name in ("httpx", "httpcore"):  # one INFO entry per provider call: 318k of them were 90% of the 113 MB log
        logging.getLogger(name).setLevel(logging.WARNING)
    threading.Thread(target=_watch, args=(port, started), name="hswarm-code-watch", daemon=True).start()
    if mine:
        threading.Thread(target=livecode.prune, name="hswarm-code-prune", daemon=True).start()
    from . import vault

    threading.Thread(target=vault.autosync_loop, name="hswarm-vault-sync", daemon=True).start()  # idle until `hswarm vault init|join|adopt`
    mcp.run(transport="streamable-http", host=HOST, port=port, session_idle_timeout=IDLE_SESSION_S)


def probe(port: int = PORT, timeout: float = 0.5) -> dict | None:
    """None when nothing listens; the /health body when hswarm does; {"hswarm": False} when something else does."""
    conn = http.client.HTTPConnection(HOST, port, timeout=timeout)
    try:
        try:  # Windows answers a closed loopback port with a connect TIMEOUT (it retries the SYN), not a refusal
            conn.connect()
        except OSError:
            return None
        conn.sock.settimeout(max(timeout, 3.0))  # a busy hswarm is still hswarm: give the answer longer than the connect
        conn.request("GET", "/health")
        resp = conn.getresponse()
        body = resp.read(4096)
    except OSError:
        return {"hswarm": False}
    finally:
        conn.close()
    try:
        data = json.loads(body)
    except ValueError:
        return {"hswarm": False}
    return data if resp.status == 200 and isinstance(data, dict) and data.get("hswarm") is True else {"hswarm": False}


def lock_path(port: int) -> Path:
    return config.HOME / f"mcp-http-{port}.lock"


def log_path(port: int) -> Path:
    return config.HOME / "logs" / f"mcp-http-{port}.log"


def _take(lock: Path) -> bool:
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        if time.time() - lock.stat().st_mtime > LOCK_STALE_S:
            lock.unlink(missing_ok=True)
    except FileNotFoundError:
        pass
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    return True


def _detached(argv: list[str], out, package: Path = PACKAGE.parent) -> int:
    """Start argv detached from the caller, with no window, output to `out`. Returns its pid."""
    env = dict(os.environ)  # cwd is HSWARM_HOME, so the package's folder must be put on the path for `-m hswarm`
    env["PYTHONPATH"] = os.pathsep.join(p for p in (str(package), env.get("PYTHONPATH", "")) if p)
    kw: dict = {"env": env, "cwd": str(config.HOME), "stdin": subprocess.DEVNULL, "stdout": out, "stderr": subprocess.STDOUT, "close_fds": True}
    if os.name != "nt":
        return subprocess.Popen(argv, start_new_session=True, **kw).pid
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:  # out of the starting chat's job object, so closing that chat does not take the server with it
        return subprocess.Popen(argv, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kw).pid
    except OSError:  # the job forbids breakaway: still detached, but tied to the job's lifetime
        return subprocess.Popen(argv, creationflags=flags, **kw).pid


def _spawn(port: int) -> int:
    """Start `python -m hswarm mcp --http` detached from the caller, with no window, output to the log. Returns its pid.
    It runs the clone's committed hswarm (livecode.target): this caller may be a chat's connect in a working tree that
    another session is half-way through editing, or a restart helper running the copy being replaced."""
    exe = Path(sys.executable)
    if os.name == "nt" and exe.with_name("pythonw.exe").exists():
        exe = exe.with_name("pythonw.exe")
    package = livecode.target() or PACKAGE.parent
    argv = [str(exe), "-c", config._BOOTSTRAP, str(package), "mcp", "--http", "--port", str(port)]
    log = log_path(port)
    log.parent.mkdir(parents=True, exist_ok=True)
    try:  # one earlier log is kept
        if log.stat().st_size > LOG_ROTATE_BYTES:
            os.replace(log, log.with_name(log.name + ".1"))
    except OSError:  # no log yet, or Windows refusing the rename while a busy or deaf server still holds it open: append
        pass
    with open(log, "ab") as out:
        return _detached(argv, out, package)


def _wait(port: int, wait_s: float) -> dict | None:
    deadline = time.time() + wait_s
    while True:
        h = probe(port)
        if h or time.time() >= deadline:
            return h
        time.sleep(0.2)


def _running_jobs() -> int:
    from . import mcp_server

    m = mcp_server._manager
    return sum(1 for j in list(m.jobs.values()) if j.state == "running") if m else 0


def _restart_due(state: dict, now: float) -> bool:
    """One look by the shared server's watcher: True when it should hand over to a successor now. The successor runs
    the clone's newest commit (livecode.target), so every chat's server ends up on committed code: a copy moves onto a
    newer commit, and a server on a clone's working tree (started by hand, or by a chat whose connect predates the
    copies) moves onto that clone's commit. An install with no clone beside it has nothing to follow. `state` is the
    watcher's memory between looks: when the server started, the tree it refused, the one it found ready."""
    mine = livecode.running()
    src = Path(mine["source"]) if mine else livecode.source()
    if src is None or now - state["started"] < MIN_UP_S:
        return False
    head = livecode.head(src)
    if not head or head["tree"] in ((mine or {}).get("tree"), state.get("refused")) or now - head["at"] < SETTLE_S:
        return False
    if state.get("ready") != head["tree"]:
        if livecode.ready(src, head) is None:
            state["refused"] = head["tree"]  # said once per tree: the next commit is looked at afresh
            print(f"[hswarm] commit {head['commit'][:12]} cannot be imported, so this server keeps running "
                  f"{'commit ' + mine['commit'][:12] if mine else 'the code it loaded'}", file=sys.stderr, flush=True)
            return False
        state["ready"] = head["tree"]
        state.setdefault("ready_at", now)  # the hold counts from the first commit found ready, or a busy day's next one resets it
    return not _running_jobs() or now - state["ready_at"] >= BUSY_HOLD_S


def _hand_over(port: int) -> bool:
    """Take the start lock and leave a helper behind that starts the next server once this process is gone (succeed).
    The lock is what keeps a chat connecting during the switch from starting a server of its own; False, and nothing
    started, when a chat holds it right now."""
    lock = lock_path(port)
    if not _take(lock):
        return False
    code = "import sys; sys.path.insert(0, sys.argv[1]); from hswarm import shared; shared.succeed(int(sys.argv[2]), int(sys.argv[3]))"
    try:  # no output file: a helper holding the server log open would stop _spawn rotating it
        _detached([sys.executable, "-c", code, str(PACKAGE.parent), str(port), str(os.getpid())], subprocess.DEVNULL)
    except OSError as e:
        lock.unlink(missing_ok=True)
        print(f"[hswarm] could not start the restart helper: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return False
    return True


def succeed(port: int, old_pid: int, wait_s: float = 30.0) -> None:
    """The helper's whole job (_hand_over): when the old server is gone, start the next one on its port, then release
    the start lock the old one took. Only one process can hold the port, so nothing is started while the old one
    lives; with no successor the next chat to connect starts one (ensure)."""
    lock, log = lock_path(port), log_path(port)
    try:
        deadline = time.time() + wait_s
        while pid_alive(old_pid) and time.time() < deadline:
            time.sleep(0.2)
        if pid_alive(old_pid):
            said = f"server pid {old_pid} did not exit in {wait_s:.0f}s, so no successor was started"
        else:
            pid = _spawn(port)
            said = "" if _wait(port, wait_s) else f"started pid {pid} but port {port} did not answer in {wait_s:.0f}s"
        if said:
            log.parent.mkdir(parents=True, exist_ok=True)
            with open(log, "a", encoding="utf-8") as f:
                f.write(f"[hswarm restart] {said}\n")
    finally:
        lock.unlink(missing_ok=True)


def _watch(port: int, started: float) -> None:
    """The shared server's watcher thread: when a restart is due (_restart_due), hand over and end this process. It
    ends at once, as the proven restart does (taskkill /F): the successor's adopt_orphans carries the running jobs
    on, and a contained child dies with its job object (procs.contain). Under a supervisor (HSWARM_SUPERVISED, read at
    each decision; the daemon sets it) there is no successor and no start lock: the supervisor starts the next server
    when this one exits, so a daemon-run server loads new code too."""
    state = {"started": started}
    while True:
        time.sleep(WATCH_EVERY_S)
        try:
            if _restart_due(state, time.time()):
                supervised = bool(os.environ.get("HSWARM_SUPERVISED"))
                if supervised or _hand_over(port):
                    print(f"[hswarm] pid {os.getpid()} (commit {code_stamp().get('commit')}) ends to load the clone's newest "
                          f"commit; the next server on port {port} carries its running jobs on", file=sys.stderr, flush=True)
                    os._exit(0)
        except Exception as e:  # noqa: BLE001 - a watcher that died would leave this server on old code for good
            print(f"[hswarm] code watch: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


def _answer(h: dict, port: int, state: str) -> dict:
    if not h.get("hswarm"):
        return {"ok": False, "error": f"port {port} answers but it is not hswarm; pick another with --port"}
    out = {"ok": True, "state": state, "pid": h.get("pid"), "url": f"http://{HOST}:{port}/mcp",
           "version": h.get("version"), "code_at": h.get("code_at")}
    if h.get("tree"):  # a committed copy follows the clone it names (package), not this caller's checkout or worktree
        head = livecode.head(Path(h["package"])) if h.get("package") else None
        if head and head["tree"] != h["tree"]:
            out["behind"] = (f"the running server runs hswarm as commit {h.get('commit')} has it, and {h['package']} has "
                             f"committed hswarm changes since (commit {head['commit'][:12]}): it moves onto them by itself once "
                             f"they are {SETTLE_S / 60:.0f} min old, and the next server on this port carries its running jobs on")
        return out
    mine = code_stamp()  # this caller just loaded the code on disk
    if (h.get("version"), h.get("code_at")) != (mine["version"], mine["code_at"]):
        out["behind"] = (f"the running server runs {h.get('version') or 'code from before code stamps'} (code from "
                         f"{h.get('code_at') or '?'}), the code on disk is {mine['version']} (code from {mine['code_at']}): "
                         "the shared server moves onto the clone's last commit by itself once that commit is "
                         f"{SETTLE_S / 60:.0f} min old, and the next server on this port carries its running jobs on")
    return out


def ensure(port: int = PORT, wait_s: float = 30.0) -> dict:
    """The keeper: running -> return at once; down -> start it once (lock-guarded) and wait until it answers."""
    h = probe(port)
    if h:
        return _answer(h, port, "running")
    lock = lock_path(port)
    if not _take(lock):  # another caller is starting it right now
        h = _wait(port, wait_s)
        if h:
            return _answer(h, port, "running")
        return {"ok": False, "error": f"another caller holds {lock} (starting the server) and it has not answered in {wait_s:.0f}s"}
    try:
        h = probe(port)
        if h:
            return _answer(h, port, "running")
        pid = _spawn(port)
        h = _wait(port, wait_s)
        if not h:
            return {"ok": False, "error": f"started pid {pid} but port {port} did not answer in {wait_s:.0f}s; see {log_path(port)}"}
        return _answer(h, port, "started")
    finally:
        lock.unlink(missing_ok=True)


def connect(port: int = PORT) -> int:
    """The chat's headersHelper (`python -m hswarm connect`): make sure the shared server is up, then print the chat's
    X-Hswarm-* headers as JSON. Claude Code runs it with the chat's folder and environment each time it connects the
    entry, so a chat never reaches the server without its own cwd and caller stamp, and a server that cannot come up
    fails that chat's connection with the reason. Register it once per machine with `python -m hswarm install`, which
    writes the entry's headersHelper from config.launcher(), a command that starts from any folder (a bare
    `python -m hswarm connect` only works from the AgentHydra root).
    """
    from .caller import _instance_of, desktop_chat

    out = ensure(port, wait_s=8.0)  # Claude Code gives a headersHelper 10 s
    if not out["ok"]:
        print(f"[hswarm connect] {out['error']}", file=sys.stderr)
        return 1
    env = os.environ
    values = {"cwd": env.get("CLAUDE_PROJECT_DIR") or os.getcwd(), "session": env.get("CLAUDE_CODE_SESSION_ID") or "",
              "chat": env.get("CLAUDE_CODE_HOST_SESSION_ID") or "",
              "instance": _instance_of(env.get("CLAUDE_CODE_EXECPATH") or env.get("CLAUDE_CONFIG_DIR") or "")}
    if values["chat"] and not values["session"]:  # Desktop ran this outside the chat's engine: its record says who and where
        rec = desktop_chat(values["chat"])
        if rec:
            values.update(instance=values["instance"] or rec["instance"], session=rec["session"],
                          cwd=env.get("CLAUDE_PROJECT_DIR") or rec["cwd"] or values["cwd"])
    if env.get("AGENTHYDRA_CLIMAYTE_WORKER"):
        values["climayte_worker"] = "1"
    print(json.dumps({HEADERS[k]: quote(v, safe="") for k, v in values.items() if v}))
    return 0
