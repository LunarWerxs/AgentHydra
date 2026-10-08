"""The shared server runs committed code only (owner, 2026-10-07: decide how the server picks up new code, and do it).

Several sessions edit this clone at once, and until 2026-10-07 the one shared server ran its working tree: a restart
loaded whatever was on disk, so the watcher waited for a tree with no uncommitted .py file that had been quiet for
SETTLE_S. On a busy day that moment never comes: pid 68140 ran code from 22:38Z for hours while 11 hswarm commits
landed, the 400 failover and the schema routing fix among them, because some session always had an edit open.

Now a production start runs a copy of what the clone COMMITTED: each hswarm tree the clone's HEAD reaches is exported
once (`git archive`) into HOME/code/<tree>, a folder no session edits and no server rewrites, and `current.json` names
the newest copy that imports. An unfinished edit in the clone is never loaded and never holds a restart back; a commit
that cannot be imported is never served (the last one that could be keeps serving). The two production starts use it:
the AgentHydra daemon's `python -m hswarm mcp --http` (serve_committed, from __main__) and shared._spawn, the start a
chat's connect or a restart hand-over makes. A server started by hand from the clone runs the clone, as before.

Standard library only, and no other hswarm module: the daemon's start runs this from the clone's working tree before
anything else is imported, so another session's half-saved config.py cannot stop the server from starting.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
MARKER = ".hswarm-code.json"  # written last into a copy: a folder without it is an export that never finished
KEEP = 3  # copies kept besides the current one and the running one (prune)
# Every module a server loads before it binds its port (the same list a copy is checked against before it is served):
# `hswarm mcp --http` goes through cli (clihelp, commands, install), fleetstats, then serve()'s mcp_server, verdict and
# console (settings, ledger).
START_IMPORTS = "import hswarm.cli, hswarm.fleetstats, hswarm.mcp_server, hswarm.verdict, hswarm.console"
# config._BOOTSTRAP's command, spelled here because this module imports no other: run the hswarm package found in
# argv[1] as `python -m hswarm`, whatever the working folder.
BOOTSTRAP = ("import sys,runpy;sys.path.insert(0,sys.argv[1]);sys.argv[1:2]=[];"
             "runpy.run_module('hswarm',run_name='__main__',alter_sys=True)")
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
HEAD_FRESH_S = 10.0  # how long one read of the clone's HEAD answers again (behind() asks on every hswarm_run)
TRIES = 5  # rename attempts: Windows refuses one while another process (a reader, a virus scan) has the file open
_heads: dict[str, tuple[float, dict | None]] = {}


def home() -> Path:
    """HSWARM_HOME, as config.HOME reads it. Once config is loaded its HOME is the one (a test points it elsewhere);
    the daemon's start reads it here, before config is imported."""
    cfg = sys.modules.get("hswarm.config")
    return cfg.HOME if cfg is not None else Path(os.environ.get("HSWARM_HOME") or (Path.home() / ".hswarm"))


def code_root() -> Path:
    return home() / "code"


def _read(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write(path: Path, data: dict) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    try:
        for attempt in range(TRIES):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:  # Windows: another start is reading current.json or the marker right now
                if attempt == TRIES - 1:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        tmp.unlink(missing_ok=True)


def _age(p: Path) -> float:
    try:
        return time.time() - p.stat().st_mtime
    except OSError:  # gone already (an export renamed into place, or pruned): age 0 keeps it off the stale lists
        return 0.0


def running() -> dict | None:
    """The copy this process runs ({tree, commit, source, ...}), or None when it runs a clone or an install."""
    return _read(PACKAGE.parent / MARKER)


def source() -> Path | None:
    """The clone this process's code follows: the one its copy was exported from, or the clone it runs in. None for an
    install with no git beside it, which has nothing to follow."""
    mine = running()
    if mine:
        return Path(mine["source"])
    return PACKAGE.parent if (PACKAGE.parent / ".git").exists() else None


def _git(src: Path, *args: str, text: bool = True) -> str | bytes:
    # --no-optional-locks: a read that refreshed the index would take index.lock under another session's commit
    r = subprocess.run(["git", "--no-optional-locks", "-C", str(src), *args], capture_output=True, text=text,
                       timeout=60, creationflags=CREATE_NO_WINDOW)
    if r.returncode:
        err = r.stderr if text else r.stderr.decode("utf-8", "replace")
        raise RuntimeError(f"git {args[0]} in {src}: {err.strip()[:300]}")
    return r.stdout.strip() if text else r.stdout


def head(src: Path) -> dict | None:
    """What the clone has committed: {commit, tree (of hswarm/), at (when hswarm/ last changed, epoch s)}; None when
    git cannot say. A working-tree edit, committed or not by its session yet, changes none of it."""
    key = str(src)
    seen = _heads.get(key)
    if seen and time.monotonic() - seen[0] < HEAD_FRESH_S:
        return seen[1]
    try:
        commit = _git(src, "rev-parse", "HEAD")
        tree = _git(src, "rev-parse", f"{commit}:{PACKAGE.name}")
        at = int(_git(src, "log", "-1", "--format=%ct", commit, "--", PACKAGE.name) or 0)
        out = {"commit": commit, "tree": tree, "at": at}
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError):
        out = None
    _heads[key] = (time.monotonic(), out)
    return out


def export(src: Path, h: dict) -> Path:
    """The folder holding hswarm/ exactly as commit h['commit'] has it, exported once per tree. Written beside its
    final name and renamed into place, so a folder under its final name is always whole; two starts exporting the
    same tree at once both end with the one that renamed first."""
    dest = code_root() / h["tree"][:12]
    if (dest / MARKER).is_file():
        return dest
    # A folder with no marker is never a copy (the marker is renamed in with it): it is one prune could not finish
    # removing (a file held open), and left there it would refuse this tree's export for good.
    shutil.rmtree(dest, ignore_errors=True)
    tmp = code_root() / f".{h['tree'][:12]}.{os.getpid()}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        tar = _git(src, "archive", "--format=tar", h["commit"], PACKAGE.name, text=False)
        with tarfile.open(fileobj=io.BytesIO(tar)) as t:
            t.extractall(tmp, filter="data")
        _write(tmp / MARKER, {"tree": h["tree"], "commit": h["commit"], "source": str(src),
                              "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        for attempt in range(TRIES):
            if (dest / MARKER).is_file():  # another start exported this tree first
                break
            try:
                os.rename(tmp, dest)
                break
            except OSError:  # Windows: a virus scan still has a new file open, or another start's rename won
                if attempt == TRIES - 1:
                    raise
                time.sleep(0.2 * (attempt + 1))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return dest


def _imports(dest: Path) -> bool:
    """True when a fresh process starts the server's imports from `dest` (and from nothing else on the path)."""
    env = dict(os.environ, PYTHONPATH=str(dest))
    try:
        r = subprocess.run([sys.executable, "-c", START_IMPORTS], cwd=str(dest), env=env, capture_output=True,
                           timeout=120, creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def ready(src: Path, h: dict) -> Path | None:
    """Export commit h and check that it imports (once per tree: the answer is kept in its marker). The folder, now
    the current copy, when it does; None when it does not, and the current copy stays what it was."""
    dest = export(src, h)
    mark = _read(dest / MARKER) or {}
    if "imports" not in mark:
        mark["imports"] = _imports(dest)
        _write(dest / MARKER, mark)
    if not mark["imports"]:
        return None
    _write(code_root() / "current.json", {"dir": str(dest), "tree": mark["tree"], "commit": mark["commit"]})
    return dest


def current() -> Path | None:
    """The newest copy that was found to import, if its folder is still whole."""
    cur = _read(code_root() / "current.json")
    dest = Path(cur["dir"]) if cur and cur.get("dir") else None
    return dest if dest and (dest / MARKER).is_file() else None


def target() -> Path | None:
    """The folder a server started now runs from: the clone's last commit when it imports, else the last copy that
    did. None when there is no clone to follow, or nothing committed imports yet: the caller runs its own code."""
    src = source()
    if src is None:
        return None
    h = head(src)
    try:
        return (ready(src, h) if h else None) or current()
    except (OSError, RuntimeError, tarfile.TarError) as e:
        print(f"[hswarm] could not prepare the committed hswarm of {src}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return current()


def prune(keep: int = KEEP) -> None:
    """Remove the copies nobody runs: all but the current one, this process's own and the `keep` newest, any copy an
    earlier prune could not finish removing, and any export a crash left half-written (one an hour old: a younger one
    may be a start exporting right now)."""
    root = code_root()
    if not root.is_dir():
        return
    spare = {p.resolve() for p in (current(), PACKAGE.parent) if p}
    folders = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")]
    copies = sorted((p for p in folders if (p / MARKER).is_file()), key=lambda p: _age(p / MARKER))
    spare |= {p.resolve() for p in copies[:keep]}
    stale = [p for p in copies[keep:] if p.resolve() not in spare]
    stale += [p for p in folders if not (p / MARKER).is_file()]
    stale += [p for p in root.glob(".*.tmp") if _age(p) > 3600]
    for p in stale:
        shutil.rmtree(p, ignore_errors=True)


def _kill_with_me(child: subprocess.Popen) -> None:
    """Windows: put the child in a kill-on-close Job Object this process holds, so the server never outlives the
    start the daemon supervises (an orphan would keep the port, and every restart after it would fail to bind)."""
    import ctypes
    from ctypes import wintypes

    class _Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class _Extended(ctypes.Structure):
        _fields_ = [("Basic", _Basic), ("Io", ctypes.c_uint64 * 6), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    job = k32.CreateJobObjectW(None, None)
    info = _Extended()
    # KILL_ON_JOB_CLOSE, and BREAKAWAY_OK: a process started to outlive the server (shared._detached asks to break
    # away) still can; everything else the server starts already dies with it (procs.contain's own jobs)
    info.Basic.LimitFlags = 0x2000 | 0x0800
    ok = job and k32.SetInformationJobObject(wintypes.HANDLE(job), 9, ctypes.byref(info), ctypes.sizeof(info))  # 9: extended limits
    if not ok or not k32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(int(child._handle))):
        print(f"[hswarm] the server could not be tied to its start (error {ctypes.get_last_error()}); stopping the "
              "start alone would leave it running", file=sys.stderr, flush=True)
    # The handle stays open for the life of this process on purpose: closing it is what ends the server.


def serve_committed(argv: list[str]) -> int | None:
    """The daemon's start, `python -m hswarm mcp --http` run in the clone: serve the clone's committed hswarm instead
    of its working tree. On POSIX this process becomes that server (exec, same pid); on Windows it starts it as a child
    tied to this process and returns its exit code, because the daemon supervises THIS pid. None when this process
    serves its own code: not the daemon's start (HSWARM_SUPERVISED), already a committed copy, or no copy to run."""
    if argv[:1] != ["mcp"] or "--http" not in argv or not os.environ.get("HSWARM_SUPERVISED") or running():
        return None
    dest = target()
    if dest is None:
        print("[hswarm] no committed hswarm could be prepared, so this server runs the working tree it was started in",
              file=sys.stderr, flush=True)
        return None
    mark = _read(dest / MARKER) or {}
    print(f"[hswarm] serving hswarm as commit {str(mark.get('commit'))[:12]} has it, from {dest}", file=sys.stderr, flush=True)
    cmd = [sys.executable, "-c", BOOTSTRAP, str(dest), *argv]
    if os.name != "nt":
        os.execv(sys.executable, cmd)
    # No window of its own whatever console this start has, and its output into the daemon's log as before.
    child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=_handle(sys.stdout), stderr=_handle(sys.stderr),
                             creationflags=CREATE_NO_WINDOW)
    _kill_with_me(child)
    return child.wait()


def _handle(stream):
    try:
        return stream.fileno()
    except (AttributeError, OSError, ValueError):  # pythonw, or a closed stream: nowhere to write
        return subprocess.DEVNULL
