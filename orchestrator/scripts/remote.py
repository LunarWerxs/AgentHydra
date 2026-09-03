#!/usr/bin/env python3
"""remote.py - act (machine config): THE REMOTE FRONT-END - start, stop or report the gateway
that serves the web dashboard (web/) over a Cloudflare tunnel, behind Sign in with Connections.

The gateway is server/src/main.ts (Bun + Hono; RepoYeti's remote-access stack, vendored). It
fronts scripts/dashboard.py's READ-ONLY answers, gates every tunnel request behind the owner's
Connections sign-in, and opens a cloudflared tunnel. The one thing it can change is THE SWITCH
(python orch.py arm / disarm) - every other act stays in the toolbox's own rails. Loopback
stays open, exactly like the Python dashboard.

TWO KINDS OF ADDRESS. With a NAMED tunnel configured (scripts/remote_tunnel.py --provision) the
gateway serves one hostname on our own zone that never changes and completes sign-in on its own
/oauth/callback - that is the setup here. With none, it falls back to a rotating Quick Tunnel
and announces itself to app.repoyeti.com, whose /r/<id> is then the permanent address.

⛔ THE TRAY ICON OWNS THIS PROCESS, and there is deliberately no scheduled keepalive. A
keepalive lane briefly existed and was a false kill switch: it was ungated, so closing the icon
stopped the lanes and a task restored remote access five minutes later - and this gateway can
throw the arm switch from a phone. scripts/tray.ps1 starts it, watchdogs it every 15 seconds
and stops it on Exit; `orch.py disarm` closes it too.

⛔ AND EVERY GATEWAY SUPERVISES ITSELF, however it was started. It reads the tray's heartbeat
and exits once that goes stale, so a hard kill of the icon closes the door as surely as an
orderly Exit does. That includes a copy started by hand from this script: --start with no icon
on screen will come up and then stop itself within ~90 seconds, which is the rule working, not
a fault. A developer who genuinely wants an unsupervised one sets ORCH_NO_TRAY_SUPERVISION=1
and gets a loud warning in the log.

Usage: python scripts/remote.py                 # status: serving? where? tunnel up? owner claimed?
       python scripts/remote.py --start         # start it if the port is dead (detached, no window)
       python scripts/remote.py --stop          # stop the gateway recorded in state/remote/status.json
       python scripts/remote.py --open          # open the dashboard (the permanent address when known)
       python scripts/remote.py --extract-tree  # regenerate web/src/components/LogicTree.vue from dashboard.html
       python scripts/remote.py --json          # status as JSON
       python scripts/remote.py --quiet         # (with --start) print nothing unless something changed
Exit:  0 ok / already serving - 1 the gateway did not come up - 2 bun or the built web app is
       missing (run: bun install && bun run remote:build) - 3 nothing to stop.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from lib import clilib

REPO = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 7790
START_WAIT_SECS = 20


def _state_dir() -> Path:
    env = os.environ.get("ORCHESTRATOR_STATE_DIR")
    return Path(env) if env else REPO / "state"


def _status_path() -> Path:
    return _state_dir() / "remote" / "status.json"


def _log_path() -> Path:
    return _state_dir() / "logs" / "remote-gateway.log"


def _port() -> int:
    try:
        return int(os.environ.get("ORCH_REMOTE_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def _bun() -> str | None:
    """The REAL bun executable, never a .CMD/.BAT shim.

    ⛔ shutil.which("bun") on this machine returns C:\\...\\npm\\bun.CMD - an npm shim - and
    launching that instead of bun.exe puts cmd.exe between us and the gateway, which breaks the
    daemon in three quiet ways: the child becomes a BATCH JOB, so a Ctrl+C anywhere in the
    console tree makes it stop and ask "Terminate batch job (Y/N)?" (measured 2026-09-02 - the
    gateway died mid-session and left that prompt sitting in its own log); cmd.exe wants a
    console, which is exactly what a tray-launched daemon must never own; and the pid we record
    is the shim's, so --stop can kill the wrapper and leave the real process serving. Prefer the
    native binary and accept a shim only as a last resort.
    """
    home = Path.home() / ".bun" / "bin" / ("bun.exe" if os.name == "nt" else "bun")
    if home.exists():
        return str(home)
    found = shutil.which("bun")
    if found and os.name == "nt" and Path(found).suffix.lower() in (".cmd", ".bat"):
        # A shim was all PATH had. Look for the real executable beside it before settling.
        native = Path(found).with_suffix(".exe")
        if native.exists():
            return str(native)
    return found


def _get_json(url: str, timeout: float = 3.0) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            return json.loads(res.read())
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None


def health(port: int | None = None) -> dict | None:
    """The gateway's own /api/health, or None when nothing answers on the port."""
    return _get_json(f"http://127.0.0.1:{port or _port()}/api/health")


def status_file() -> dict:
    try:
        return json.loads(_status_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _pid_alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
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


def status() -> dict:
    port = _port()
    h = health(port)
    rec = status_file()
    gateway = _get_json(f"http://127.0.0.1:{port}/api/status", timeout=8.0) if h else None
    out = {
        "serving": bool(h),
        "port": port,
        "local": f"http://127.0.0.1:{port}",
        "version": (h or {}).get("version"),
        "pid": rec.get("pid"),
        "tunnel": rec.get("tunnel"),
        "tunnelUrl": rec.get("tunnelUrl"),
        "tunnelError": rec.get("tunnelError"),
        "stableUrl": rec.get("stableUrl"),
        "relayError": rec.get("relayError"),
        "oauthCallback": rec.get("oauthCallback"),
        "statusAgeSecs": (int(time.time() * 1000 - int(rec.get("at") or 0)) // 1000) if rec.get("at") else None,
    }
    if gateway:
        out["ownerClaimed"] = bool(((gateway.get("config") or {}).get("oauth") or {}).get("ownerClaimed"))
        out["switch"] = gateway.get("switch")
        out["daemon"] = gateway.get("daemon")
        out["dashboard"] = gateway.get("dashboard")
    return out


def render(s: dict) -> str:
    lines = []
    if s["serving"]:
        lines.append(f"remote gateway v{s.get('version') or '?'} serving {s['local']} (pid {s.get('pid') or '?'})")
    else:
        lines.append(f"remote gateway NOT serving on :{s['port']}  -  start it: python scripts/remote.py --start")
    if s.get("stableUrl"):
        lines.append(f"  permanent address: {s['stableUrl']}")
    if s.get("tunnelUrl"):
        lines.append(f"  tunnel ({s.get('tunnel')}): {s['tunnelUrl']}")
    elif s.get("tunnelError"):
        lines.append(f"  tunnel: {s['tunnelError']}")
    if s.get("relayError"):
        lines.append(f"  relay: {s['relayError']}")
    if s.get("oauthCallback") and s.get("oauthCallback") != "ready":
        lines.append(f"  sign-in return route: {s['oauthCallback']}")
    if "ownerClaimed" in s:
        lines.append("  owner: " + ("claimed" if s["ownerClaimed"] else "NOT claimed yet - the first verified sign-in claims it"))
    if s.get("switch") is not None:
        sw = s["switch"]
        lines.append("  switch: " + ("ARMED" if sw.get("up") and not sw.get("paused") else "PAUSED" if sw.get("up") else "OFF")
                     + (f" ({sw.get('why')})" if sw.get("why") else ""))
    if s.get("daemon") is not None:
        lines.append(f"  daemon: {'up ' + str(s['daemon'].get('version') or '') if s['daemon'].get('ok') else 'UNREACHABLE'}"
                     f"  ·  data layer: {'up' if (s.get('dashboard') or {}).get('ok') else 'down'}")
    return "\n".join(lines)


def start(quiet: bool = False) -> int:
    port = _port()
    if health(port):
        if not quiet:
            print(f"already serving http://127.0.0.1:{port}")
        return 0
    bun = _bun()
    if not bun:
        print("bun is not installed (https://bun.sh) - the gateway cannot start", file=sys.stderr)
        return 2
    if not (REPO / "web" / "dist" / "index.html").exists():
        print("web/dist is not built - run: bun install && bun run remote:build", file=sys.stderr)
        return 2
    if not (REPO / "node_modules").exists():
        print("node_modules is missing - run: bun install", file=sys.stderr)
        return 2
    log = _log_path()
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists() and log.stat().st_size > 2_000_000:
        log.replace(log.with_suffix(".log.1"))
    kwargs: dict = {}
    if os.name == "nt":
        # A console-less, session-independent child: it must outlive the hidden shim (or the
        # terminal) that started it, and never own a window. CREATE_NEW_PROCESS_GROUP keeps a
        # Ctrl+C in the parent's console away from it.
        kwargs["creationflags"] = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                                   | getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        kwargs["start_new_session"] = True
    with log.open("ab") as fh:
        fh.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] remote.py --start\n".encode())
        proc = subprocess.Popen([bun, "run", str(REPO / "server" / "src" / "main.ts")],
                                cwd=str(REPO), stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
                                close_fds=True, **kwargs)
    deadline = time.time() + START_WAIT_SECS
    while time.time() < deadline:
        if health(port):
            if not quiet:
                print(f"started the remote gateway (pid {proc.pid}) at http://127.0.0.1:{port}")
                print(f"  log: {log}")
            return 0
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    print(f"the gateway did not answer on :{port} within {START_WAIT_SECS}s - see {log}", file=sys.stderr)
    return 1


def stop() -> int:
    rec = status_file()
    pid = rec.get("pid")
    if not pid or not _pid_alive(pid):
        print("nothing to stop - no live gateway is recorded in state/remote/status.json")
        return 3
    if os.name == "nt":
        # /T takes the cloudflared child with it.
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True, timeout=30)
    else:
        try:
            os.killpg(int(pid), 15)
        except OSError:
            os.kill(int(pid), 15)
    for _ in range(20):
        if not _pid_alive(pid):
            print(f"stopped the remote gateway (pid {pid})")
            return 0
        time.sleep(0.25)
    print(f"pid {pid} is still alive after taskkill", file=sys.stderr)
    return 1


def open_browser() -> int:
    s = status()
    url = s.get("stableUrl") or s.get("tunnelUrl") or s["local"]
    print(f"opening {url}")
    webbrowser.open(url)
    return 0


def extract_tree() -> int:
    """Rewrite web/src/components/LogicTree.vue from the SVG in scripts/dashboard.html, so the
    two dashboards can never draw two different trees."""
    src = (REPO / "scripts" / "dashboard.html").read_text(encoding="utf-8").splitlines()
    start_i = next(i for i, l in enumerate(src) if 'id="treeBox"' in l)
    body = next(i for i in range(start_i, len(src)) if 'class="diagram-body"' in src[i])
    end = next(i for i in range(body, len(src)) if "</details>" in src[i])
    inner = src[body + 1:end]
    while inner and inner[-1].strip() in ("</div>", ""):
        inner.pop()
    out = ['<script setup lang="ts">',
           "// THE LOGIC TREE, verbatim from scripts/dashboard.html (the Python dashboard's own drawing).",
           "// Regenerate rather than edit: `python scripts/remote.py --extract-tree` rewrites this file",
           "// from that source, so the two dashboards can never show two different trees.",
           "</script>",
           "",
           "<template>",
           '  <div class="logic-tree space-y-2 overflow-x-auto">']
    out += ["  " + l for l in inner]
    out += ["  </div>", "</template>", ""]
    target = REPO / "web" / "src" / "components" / "LogicTree.vue"
    target.write_text("\n".join(out), encoding="utf-8")
    print(f"wrote {target.relative_to(REPO)}: {len(inner)} lines of diagram")
    return 0


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    quiet = "--quiet" in argv
    if "--extract-tree" in argv:
        return extract_tree()
    if "--start" in argv:
        return start(quiet)
    if "--stop" in argv:
        return stop()
    if "--open" in argv:
        return open_browser()
    s = status()
    if "--json" in argv:
        print(json.dumps(s, indent=2))
    else:
        print(render(s))
    return 0 if s["serving"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
