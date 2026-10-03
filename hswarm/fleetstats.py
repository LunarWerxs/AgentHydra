"""Anonymous usage events for the LunarWerx dashboard (st2k.lunarwerx.com/stats, project HydraSwarm).

Sent to Connections analytics (ARGUS) under the HydraSwarm website's public ingest key, the same instrument the
site's pixel feeds, so the dashboard counts the program and the page side by side. What leaves the machine: which
command started (`mcp`, `run`, `ui`...), how many tasks a finished job had and how many came back ok, the version,
the OS and the Python version, and a random install id kept in ~/.hswarm/usage-id. Never a prompt, a file, a
path, a model answer, a provider or a key. (Not to be confused with usage.py, the token-usage shapes.)

It never blocks and never fails anything: every send runs on a daemon thread with a short timeout and every error
is dropped. Off under pytest and in CI, and HSWARM_NO_PING=1 turns it off.
"""
from __future__ import annotations

import json
import os
import platform
import secrets
import sys
import threading
import urllib.request
from pathlib import Path

from . import __version__, config

INGEST = os.environ.get("HSWARM_PING_URL", "")  # usage pings are off unless an ingest URL and key are configured`nKEY = os.environ.get("HSWARM_PING_KEY", "")`nURL = "https://hydraswarm.invalid/app"`n_session = secrets.token_hex(16)
_lock = threading.Lock()
_id: tuple[str, bool] | None = None
_threads: list[threading.Thread] = []


def enabled() -> bool:
    if os.environ.get("HSWARM_NO_PING", "").strip().lower() not in ("", "0", "false", "off", "no"):
        return False
    if "pytest" in sys.modules or os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    # A source checkout is a developer's copy (ours run hundreds of jobs a day and would drown the real numbers);
    # an installed wheel has no .git beside the package.
    if (Path(__file__).resolve().parent.parent / ".git").exists():
        return False
    return not any(os.environ.get(v) for v in ("CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI"))


def _install_id() -> tuple[str, bool]:
    """The install's id and whether this call created it; a home it cannot write gets a fresh id each run."""
    global _id
    with _lock:
        if _id is None:
            path = config.HOME / "usage-id"
            try:
                text = path.read_text(encoding="utf-8").strip()
                if len(text) == 32 and all(c in "0123456789abcdef" for c in text):
                    _id = (text, False)
            except OSError:
                pass
            if _id is None:
                new = secrets.token_hex(16)
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(new, encoding="utf-8")
                    _id = (new, True)
                except OSError:
                    _id = (new, False)
        return _id


def _user_agent() -> str:
    osname = {"Windows": "Windows NT 10.0", "Darwin": "Macintosh; Mac OS X", "Linux": "X11; Linux"}.get(platform.system(), platform.system())
    return f"HydraSwarm/{__version__} ({osname}; {platform.machine()}) Py/{platform.python_version()}"


def _post(names: list[str], props: dict) -> None:
    try:
        iid, _ = _install_id()
        base = {"v": __version__, "os": platform.system().lower(), "py": platform.python_version(), **props}
        body = {
            "ingestKey": KEY,
            "anonymousId": iid,
            "sessionId": _session,
            "url": URL,
            # Not a browser, so the "service" evidence: the one ARGUS accepts from a program.
            "tracking": {"version": 1, "source": "service", "purposes": {"analytics": "granted"}},
            "events": [{"type": "custom", "name": n, "url": URL, "props": base} for n in names],
        }
        req = urllib.request.Request(
            INGEST,
            data=json.dumps(body).encode("utf-8"),
            headers={"content-type": "text/plain;charset=UTF-8", "user-agent": _user_agent()},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception:  # noqa: BLE001 - usage counting must never surface
        pass


def send(name: str, **props) -> None:
    """Queue one event; a brand-new install also reports `app_install` with its first event."""
    if not enabled():
        return
    try:
        _, first = _install_id()
        names = ["app_install", name] if first else [name]
        clean = {k: str(v)[:60] for k, v in props.items() if v is not None}
        t = threading.Thread(target=_post, args=(names, clean), daemon=True)
        t.start()
        _threads.append(t)
    except Exception:  # noqa: BLE001
        pass


def flush(timeout: float = 1.5) -> None:
    """Give a short-lived CLI run's events a moment to leave before the process exits."""
    for t in list(_threads):
        t.join(timeout)
