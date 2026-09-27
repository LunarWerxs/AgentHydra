"""Run a SIDE AgentHydra daemon from this checkout and probe it the way the tray watchdog does.

    python scripts/stall-hunt/sidebench.py <workdir> [--prof] [--fresh] [--boot 45] [--load 60]
                                           [--tail 15] [--chats-instance NAME]

Never touches the live daemon: port 7811, its own AGENTHYDRA_HOME and CLAUDE_CONFIG_DIR under
<workdir>, seeded with a VACUUM INTO copy of the live database (~/.agenthydra/data/agenthydra.db)
unless --fresh. /api/health is probed every 1 s with the tray's 400 ms budget from launch; after
--boot seconds idle, two threads replay the reads that preceded the 2026-09-27 freeze (the session
list, the live-chat lineage index, one account's chat list) for --load seconds; then POST
/api/shutdown with the token, which is also what makes --prof write its profile. Prints a summary per
phase; feed <workdir>/prof/*.cpuprofile to stretches.py.
"""

import json
import os
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BUN = os.path.expanduser(os.path.join("~", ".bun", "bin", "bun.exe" if os.name == "nt" else "bun"))
PORT = 7811
BASE = f"http://127.0.0.1:{PORT}"
LIVE_DB = os.path.expanduser(os.path.join("~", ".agenthydra", "data", "agenthydra.db"))
HIDDEN = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW: never a console on the desktop

args = sys.argv[1:]
root = os.path.abspath(args.pop(0))


def opt(name, default):
    return args[args.index(name) + 1] if name in args else default


BOOT, LOAD, TAIL = float(opt("--boot", 45)), float(opt("--load", 60)), float(opt("--tail", 15))
chats_instance = opt("--chats-instance", "")
home, cfg, profdir = (os.path.join(root, d) for d in ("hydra-home", "claude-cfg", "prof"))
for d in (os.path.join(home, "data"), cfg, profdir):
    os.makedirs(d, exist_ok=True)

db = os.path.join(home, "data", "agenthydra.db")
if "--fresh" not in args and not os.path.exists(db):
    code = (
        "const {Database}=require('bun:sqlite');"
        f"const d=new Database({json.dumps(LIVE_DB)},{{readonly:true}});"
        f"d.run(\"VACUUM INTO '{db.replace(os.sep, '/')}'\");d.close()"
    )
    subprocess.run([BUN, "-e", code], check=True, creationflags=HIDDEN)

token = secrets.token_hex(16)
env = dict(os.environ, AGENTHYDRA_PORT_FIXED="1", PORT=str(PORT), AGENTHYDRA_NO_OPEN="1",
           AGENTHYDRA_NO_PING="1", AGENTHYDRA_HOME=home, CLAUDE_CONFIG_DIR=cfg,
           AGENTHYDRA_SHUTDOWN_TOKEN=token)
cmd = [BUN] + (["--cpu-prof", "--cpu-prof-md", f"--cpu-prof-dir={profdir}"] if "--prof" in args else [])
cmd.append("server/src/index.ts")
t0 = time.time()
proc = subprocess.Popen(cmd, cwd=APP, env=env, creationflags=HIDDEN,
                        stdout=open(os.path.join(root, "daemon.out.log"), "w"),
                        stderr=open(os.path.join(root, "daemon.err.log"), "w"))
log = open(os.path.join(root, "probe.log"), "w")
state = {"phase": "boot", "stop": False}
probes = []  # (seconds since launch, phase, ms or None for a miss)


def w(line):
    log.write(line + "\n")
    log.flush()


def health_loop():
    up = False
    while not state["stop"]:
        s = time.time()
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=0.4) as r:
                r.read()
            ms = (time.time() - s) * 1000
            if up:
                probes.append((s - t0, state["phase"], ms))
            up = True
            if ms > 150:
                w(f"+{s - t0:7.2f}s {state['phase']:5} health SLOW {ms:.0f}ms")
        except Exception as e:  # noqa: BLE001 - a miss is the measurement
            if up:
                probes.append((s - t0, state["phase"], None))
                w(f"+{s - t0:7.2f}s {state['phase']:5} health MISS {(time.time() - s) * 1000:.0f}ms {type(e).__name__}")
        time.sleep(max(0.0, 1.0 - (time.time() - s)))


chats = "/api/chats?archived=include&limit=1000&offset=0"
if chats_instance:
    chats += "&instance=" + urllib.parse.quote(chats_instance)
LOAD_PATHS = ["/api/sessions?period=all&limit=500&offset=0&archived=include",
              "/api/sessions/live?lineage=1", chats]


def load_loop():
    while state["phase"] == "load":
        for path in LOAD_PATHS:
            s = time.time()
            try:
                with urllib.request.urlopen(BASE + path, timeout=120) as r:
                    n = len(r.read())
                w(f"+{s - t0:7.2f}s load  {path.split('?')[0]} {n}B {(time.time() - s) * 1000:.0f}ms")
            except Exception as e:  # noqa: BLE001
                w(f"+{s - t0:7.2f}s load  {path.split('?')[0]} FAILED {e}")


threading.Thread(target=health_loop, daemon=True).start()
while time.time() - t0 < 120 and not probes:
    time.sleep(0.2)
w(f"+{time.time() - t0:7.2f}s up")
time.sleep(BOOT)
state["phase"] = "load"
for _ in range(2):
    threading.Thread(target=load_loop, daemon=True).start()
time.sleep(LOAD)
state["phase"] = "tail"
time.sleep(TAIL)
state["stop"] = True
try:
    req = urllib.request.Request(BASE + "/api/shutdown", data=b"{}", method="POST",
                                 headers={"x-agenthydra-shutdown-token": token,
                                          "content-type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()
    proc.wait(90)
except Exception as e:  # noqa: BLE001
    w(f"shutdown failed ({e}); killing")
    proc.kill()

for ph in ("boot", "load", "tail", "all"):
    rows = [x for x in probes if ph == "all" or x[1] == ph]
    if not rows:
        continue
    oks = sorted(x[2] for x in rows if x[2] is not None)
    streak = best = 0
    for x in rows:
        streak = streak + 1 if x[2] is None else 0
        best = max(best, streak)
    w(f"SUMMARY {ph:5} probes={len(rows)} miss={len(rows) - len(oks)} longest_miss_streak={best} "
      f"max_ok={oks[-1] if oks else 0:.0f}ms")
log.close()
print(open(os.path.join(root, "probe.log")).read()[-2500:])
