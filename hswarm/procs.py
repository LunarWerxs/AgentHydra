"""Hidden subprocesses: the one runner every tool and backend shares, plus the bash probe.

Three rules live here so nothing else has to remember them. (1) On Windows every child is
created with CREATE_NO_WINDOW: a visible console that the operator closes kills the worker
silently with no traceback (owner rule, 2026-09-05). (2) A timeout kills the WHOLE process
tree, because `timeout` on Windows is a separate guard process that dies without its child.
(3) A child never inherits the operator's environment whole: it gets scrubbed_env(), so a
worker that runs `env` sees PATH and HOME, not the provider keys this process holds.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

from .procgate import CREATE_NO_WINDOW, ProcSlot, spawn_kwargs  # noqa: F401 - CREATE_NO_WINDOW re-exported

# The exit code a timed-out child is reported with (GNU `timeout` uses the same number).
TIMEOUT_EXIT = 124

# ---- the child environment ---------------------------------------------------
# A worker is an autonomous model with a shell (api t_bash, or a whole headless Claude Code on cc),
# and until 2026-09-24 it inherited every variable this process holds: every provider key, any
# GITHUB_TOKEN or AWS key in the operator's shell, one `printenv` away from a third-party model.
# Three layers, strictest first, so a gap in one is caught by the next:
#   1. a NAME ALLOWLIST (the idea behind Hugo's security.exec.osEnv): only what a shell, a toolchain
#      or Claude Code needs to start on Windows, Linux or macOS passes; everything else is dropped.
#   2. a SECRET SCREEN over what the allowlist let in: a secret-shaped name, or a value that looks
#      like a PEM key, a URL with a password, or a GitHub/Google/AWS/Stripe/Slack/JWT token.
#   3. CODE-INJECTION names that run code inside the child before it does anything (LD_PRELOAD,
#      NODE_OPTIONS, BASH_ENV...) are dropped even when the operator's extra allowlist names them.
# The operator widens layer 1 with HSWARM_CHILD_ENV_ALLOW (a regex of extra names); layers 2 and 3
# still apply. Whatever a caller passes as `extra` is deliberate and merged after the scrub.
CHILD_ENV_ALLOW_VAR = "HSWARM_CHILD_ENV_ALLOW"
_CHILD_ENV_ALLOW = re.compile(
    r"(?i)^("
    r"PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|USERDOMAIN|COMPUTERNAME|HOSTNAME|"
    r"TE?MP|TMPDIR|SHELL|TERM|COLORTERM|TZ|LANG|LANGUAGE|LC_\w+|PWD|SHLVL|DISPLAY|XDG_\w+|"
    r"SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|OS|PROCESSOR_\w+|NUMBER_OF_PROCESSORS|PSMODULEPATH|"
    r"APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES(\(X86\))?|"
    r"COMMONPROGRAMW6432|PUBLIC|ALLUSERSPROFILE|DRIVERDATA|"
    r"MSYSTEM\w*|MSYS|MSYS2_\w+|CHERE_INVOKING|ORIGINAL_PATH|MINGW_\w+|"
    r"(HTTPS?|NO|ALL)_PROXY|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NODE_EXTRA_CA_CERTS|"
    r"GO\w+|CARGO_HOME|RUSTUP_HOME|JAVA_HOME|DOTNET_ROOT|NVM_\w+|VOLTA_HOME|PNPM_HOME|BUN_INSTALL|"
    r"VIRTUAL_ENV|CONDA_\w+|PYTHONIOENCODING|PYTHONUTF8|RIPGREP_CONFIG_PATH|"
    r"NO_COLOR|FORCE_COLOR|CI|"
    r"HSWARM_ALLOW_GIT_WRITES"  # the one HSWARM_* name a worker's shell is meant to see (tools.py)
    r")$"
)
_SECRET_NAME = re.compile(r"(?i)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|CREDS|PRIVATE|COOKIE)")
# A name the secret screen would misread: GOPRIVATE holds module path patterns, not a secret.
_NOT_SECRET_NAMES = frozenset({"GOPRIVATE"})
_SECRET_VALUE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----"                    # PEM private key
    r"|\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@"            # URL with user:password
    r"|\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}"  # GitHub
    r"|\bAIza[0-9A-Za-z_-]{30,}"                             # Google API key
    r"|\b(AKIA|ASIA)[0-9A-Z]{16}\b"                          # AWS access key id
    r"|\b(sk|rk)_(live|test)_[0-9A-Za-z]{16,}"               # Stripe
    r"|\bxox[abposr]-[0-9A-Za-z-]{10,}"                      # Slack
    r"|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"  # JWT
    r"|\bsk-[A-Za-z0-9_-]{20,}"                              # OpenAI/DeepSeek/Anthropic-style key
)
_CODE_INJECTION = frozenset({
    "LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONINSPECT",
    "BASH_ENV", "ENV", "PROMPT_COMMAND", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB",
    "DOTNET_STARTUP_HOOKS", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "GIT_CONFIG_PARAMETERS",
})


def scrubbed_env(extra: dict | None = None, source: dict | None = None) -> dict:
    """The environment a worker child gets: `source` (os.environ) through the three layers above, then `extra`."""
    source = os.environ if source is None else source
    widen = source.get(CHILD_ENV_ALLOW_VAR) or ""
    try:
        extra_allow = re.compile(f"(?i)^({widen})$") if widen else None
    except re.error:
        extra_allow = None  # a malformed widening regex widens nothing rather than breaking every child
    env = {}
    for name, value in source.items():
        upper = name.upper()
        if not (_CHILD_ENV_ALLOW.match(name) or (extra_allow and extra_allow.match(name))):
            continue
        if upper in _CODE_INJECTION:
            continue
        if upper not in _NOT_SECRET_NAMES and _SECRET_NAME.search(name):
            continue
        if _SECRET_VALUE.search(value or ""):
            continue
        env[name] = value
    env.update(extra or {})
    return env


async def _communicate_lines(proc, stdin: bytes | None, on_line: Callable[[str], bool]) -> tuple[bytes, bytes]:
    """proc.communicate(), with each complete stdout line handed to `on_line` as it arrives. When `on_line`
    returns True the whole process tree is killed and stdout ends at that line."""
    async def feed() -> None:
        if stdin is None:
            return
        try:
            proc.stdin.write(stdin)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the child stopped reading; communicate() ignores the same
        finally:
            proc.stdin.close()

    async def read_out() -> bytes:
        seen: list[bytes] = []
        tail = b""
        # Chunks split here, not readline(): one stream-json line (a tool result) can pass the reader's 64 KiB line limit.
        while chunk := await proc.stdout.read(65536):
            *lines, tail = (tail + chunk).split(b"\n")
            for line in lines:
                seen.append(line + b"\n")
                if on_line(line.decode("utf-8", "replace")):
                    kill_tree(proc.pid)
                    return b"".join(seen)
        return b"".join(seen) + tail

    out, err, _ = await asyncio.gather(read_out(), proc.stderr.read(), feed())
    await proc.wait()
    return out, err


async def run_hidden(cmd: list[str], cwd: Path | str, timeout: float, env: dict | None = None, stdin_text: str | None = None,
                     on_line: Callable[[str], bool] | None = None) -> tuple[int, str, str]:
    """Run a hidden subprocess with a timeout; returns (exit, stdout, stderr). Timeout -> TIMEOUT_EXIT.

    Every child passes the process gate (procgate.py): a per-process cap, a machine-wide cap, and
    below-normal priority, so a 200-worker swarm never becomes 200 ripgreps. With no `env` the
    child gets scrubbed_env(); a caller that passes one built it from scrubbed_env() itself.
    `on_line` sees each stdout line as it arrives and stops the child by returning True (the cc cost cap).
    """
    kwargs: dict = contained_spawn_kwargs()
    kwargs["env"] = scrubbed_env() if env is None else env
    async with ProcSlot(max_wait_s=timeout):
        # stdin is only opened when there is text to feed; an open-but-empty pipe makes some CLIs wait forever.
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=str(cwd), stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **kwargs,
        )
        contain(proc.pid)
        stdin = stdin_text.encode("utf-8") if stdin_text is not None else None
        try:
            out, err = await asyncio.wait_for(proc.communicate(stdin) if on_line is None else _communicate_lines(proc, stdin, on_line), timeout=timeout)
        except asyncio.TimeoutError:
            kill_tree(proc.pid)
            try:
                await asyncio.wait_for(proc.wait(), 10)
            except asyncio.TimeoutError:
                pass
            return TIMEOUT_EXIT, "", f"killed after {timeout}s timeout"
        except asyncio.CancelledError:
            # A cancelled task must not leave its child running: the semaphore slot is freed but the CPU is not.
            kill_tree(proc.pid)
            raise
        finally:
            release(proc.pid)
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


# Containment, one Job Object per child on Windows. taskkill /T walks the process tree at ONE
# instant. Git Bash's bin\bash.exe is a launcher that spawns the real shell, which spawns the
# command, so a kill landing in the first moments of a child's life
# could miss a process created a moment later; that orphan kept the pipes open and a killed background
# job ran to its natural end (measured 2026-09-25: 1 in 3 immediate kills of `sleep 60` took 60 s). A
# child spawned with contained_spawn_kwargs() starts SUSPENDED and contain() puts it in its own
# kill-on-close Job Object before resuming it, so everything it ever starts is inside the job from its
# first instruction and kill_tree ends all of it at once. POSIX keeps its process-group kill.
_JOBS: dict[int, int] = {}  # pid -> job handle, for children contain() put in a job

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    CREATE_SUSPENDED = 0x00000004
    _PROCESS_TERMINATE, _PROCESS_SET_QUOTA, _PROCESS_SUSPEND_RESUME = 0x0001, 0x0100, 0x0800
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

    class _BasicLimit(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class _IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _ExtendedLimit(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _BasicLimit), ("IoInfo", _IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll")
    _k32.CreateJobObjectW.argtypes, _k32.CreateJobObjectW.restype = [wintypes.LPVOID, wintypes.LPCWSTR], wintypes.HANDLE
    _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    _k32.SetInformationJobObject.restype = wintypes.BOOL
    _k32.OpenProcess.argtypes, _k32.OpenProcess.restype = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE
    _k32.AssignProcessToJobObject.argtypes, _k32.AssignProcessToJobObject.restype = [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL
    _k32.TerminateJobObject.argtypes, _k32.TerminateJobObject.restype = [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL
    _k32.TerminateProcess.argtypes, _k32.TerminateProcess.restype = [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL
    _k32.CloseHandle.argtypes, _k32.CloseHandle.restype = [wintypes.HANDLE], wintypes.BOOL
    _ntdll.NtResumeProcess.argtypes, _ntdll.NtResumeProcess.restype = [wintypes.HANDLE], ctypes.c_long


def contained_spawn_kwargs() -> dict:
    """spawn_kwargs() for a child that contain() will take over: on Windows it starts suspended."""
    kwargs = spawn_kwargs()
    if sys.platform == "win32":
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | CREATE_SUSPENDED
    return kwargs


def contain(pid: int) -> None:
    """Put a child spawned with contained_spawn_kwargs() in its own kill-on-close Job Object, then resume it.

    It is ALWAYS resumed or killed, never left suspended: a failed job setup only means kill_tree falls
    back to taskkill for it. A child that cannot even be opened is killed and OSError raised."""
    if sys.platform != "win32":
        return
    handle = _k32.OpenProcess(_PROCESS_TERMINATE | _PROCESS_SET_QUOTA | _PROCESS_SUSPEND_RESUME, False, pid)
    if not handle:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True, creationflags=CREATE_NO_WINDOW)
        raise OSError(f"could not open child {pid} to contain it (error {ctypes.get_last_error()}); it was killed")
    status = -1
    try:
        job = _k32.CreateJobObjectW(None, None)
        if job:
            info = _ExtendedLimit()
            info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (_k32.SetInformationJobObject(job, _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info))
                    and _k32.AssignProcessToJobObject(job, handle)):
                _JOBS[pid] = job
            else:
                _k32.CloseHandle(job)
    finally:
        status = _ntdll.NtResumeProcess(handle)  # an NTSTATUS: negative is a failure
        if status < 0 and not terminate_contained(pid):  # a child that cannot run is ended, never left suspended
            _k32.TerminateProcess(handle, 1)
        _k32.CloseHandle(handle)
    if status < 0:
        raise OSError(f"could not resume child {pid} (NTSTATUS {status & 0xFFFFFFFF:#010x}); it was killed")


def release(pid: int) -> None:
    """A contained child has ended: close its job, which also ends anything it left running (nothing outlives it)."""
    job = _JOBS.pop(pid, None)
    if job:
        _k32.CloseHandle(job)


def terminate_contained(pid: int) -> bool:
    """End every process a contained child ever started, at once; False when the pid has no job.

    Instant, so it runs on the caller's thread: a pid is only looked up while its child is still
    held open, never later from a thread where the pid could already name a new child."""
    job = _JOBS.pop(pid, None)
    if not job:
        return False
    _k32.TerminateJobObject(job, 1)
    _k32.CloseHandle(job)
    return True


def kill_tree(pid: int) -> None:
    if sys.platform == "win32":
        if terminate_contained(pid):
            return
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True, creationflags=CREATE_NO_WINDOW)
        return
    try:
        group = os.getpgid(pid)
        if group == os.getpgrp():  # a child left in our own group: killing the group would kill this process too
            os.kill(pid, 9)
        else:
            os.killpg(group, 9)
    except Exception:
        try:
            os.kill(pid, 9)
        except Exception:
            pass


_BASH: str | None = None


def _bash_candidates() -> list[str]:
    """Every bash worth probing, Git for Windows first; the System32 one is excluded outright."""
    candidates: list[str] = []
    if sys.platform == "win32":
        roots = (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), os.environ.get("LOCALAPPDATA", ""))
        subs = (r"Git\bin\bash.exe", r"Git\usr\bin\bash.exe", r"Programs\Git\bin\bash.exe")
        candidates += [str(Path(root) / sub) for root in roots for sub in subs if root and (Path(root) / sub).exists()]
    for name in ("bash", "sh"):
        w = shutil.which(name)
        if w and w not in candidates:
            candidates.append(w)
    # System32\bash.exe is the WSL stub: it spawns fine and then fails, so it never counts.
    system_root = os.environ.get("SystemRoot", r"C:\Windows").lower()
    return [c for c in candidates if not (sys.platform == "win32" and c.lower().startswith(system_root))]


def find_bash() -> str | None:
    """A bash that actually runs: candidates are probed with `bash -c ':'` and must exit 0. Cached."""
    global _BASH
    if _BASH:
        return _BASH
    for c in _bash_candidates():
        try:
            if subprocess.run([c, "-c", ":"], capture_output=True, timeout=10, creationflags=CREATE_NO_WINDOW).returncode == 0:
                _BASH = c
                return c
        except (OSError, subprocess.TimeoutExpired):
            continue
    return None
