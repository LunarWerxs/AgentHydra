#!/usr/bin/env python3
"""orch.py - THE DRIVER: one entry point for the whole toolbox, and the dry full loop.

Two jobs:

  1. A MENU. `python orch.py` lists every script with what it does, grouped by kind, read from
     each script's own docstring - so the toolbox explains itself without a second document to
     drift. `python orch.py <name> [args...]` runs one, passing the arguments straight through.

  2. THE DRY LOOP. `python orch.py loop` walks the ENTIRE orchestration end to end and prints
     what it WOULD do at every stage, touching nothing: census, waiting scan, accounts and
     balancing, the sweep's four lanes, the naming pass, reconcile, and the judgment queue.
     Nothing in it can act - it calls the plan-only paths, and the one lane that has no
     plan-only path (naming) is reported as a count rather than run.

     `python orch.py loop --live` is the same walk with the acting lanes armed. It is the same
     thing as `sweep.py --all --yes`, spelled out; there is no third behaviour hiding here.

Usage: python orch.py                       # the menu
       python orch.py <script> [args...]    # run one script (its own --help still works)
       python orch.py loop [--json]         # DRY: the whole loop, acting on nothing
       python orch.py loop --live           # the acting version (same as sweep --all --yes)
       python orch.py arm                   # register missing lanes, start the icon PAUSED (nothing acts)
       python orch.py arm --now             # ...and start the lanes immediately (the old behaviour)
       python orch.py resume                # THE ON SWITCH: the lanes fire again on the next boundary
       python orch.py pause                 # stop the lanes, icon and dashboard stay up
       python orch.py disarm                # THE OFF SWITCH: close the icon, pause the eyes
       python orch.py armed [--quiet]       # is the icon up (--quiet: exit 0 armed / 3 not)
Exit:  0 ok - 2 the loop found something that failed - 3 unknown script / not armed -
       1 daemon failure.

⛔ NOTHING ACTS WITHOUT THE TRAY ICON (owner, 2026-09-01: "it should never just do whatever
it wants without at least some occasional instruction... it can't be running without the
status bar icon, so I can terminate it if I want"). The icon (scripts/tray.ps1) beats into
state/tray.json while it is up; every acting script asks lib/armlib for that beat before it
moves, wakes, archives, presses or writes - observing is never gated. Exit the icon, or kill
it, and everything stops. The default, on any machine, is off.
"""

from __future__ import annotations

import ast
import importlib
import json
import subprocess
import sys
import time
from pathlib import Path

# How long `arm` waits for the tray icon's first heartbeat before calling the start failed.
ARM_WAIT_SECS = 25

REPO = Path(__file__).resolve().parent
SCRIPTS = REPO / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _find_running_tray(repo: Path) -> "int | None":
    """A tray.ps1 that is RUNNING but never beat - the failure a plain timeout cannot tell
    apart from "nothing started" (found on review, 2026-09-01: `arm` printed the same generic
    "did not start" whether the launch failed outright or a second tray.ps1 was already up
    and silently not writing a heartbeat, and the fix for the two is different - a person
    needs `disarm` first, not another `arm`). Looked up the same way tray.ps1 itself finds
    its own kind (Get-OrchProcesses): a Win32_Process whose CommandLine names tray.ps1 and
    points inside this repo. Returns its pid, or None when no such process exists."""
    ps = ("(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and "
          "$_.CommandLine -match 'tray\\.ps1' -and "
          f"$_.CommandLine -match [regex]::Escape('{repo}') }} | "
          "Select-Object -First 1 -ExpandProperty ProcessId)")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=20)
    except Exception:
        return None
    text = str(out.stdout or "").strip()
    return int(text) if text.isdigit() else None


def _catalog() -> list[dict]:
    """Every runnable script with its headline, from its own docstring."""
    out = []
    for path in sorted(SCRIPTS.glob("*.py")):
        try:
            doc = ast.get_docstring(ast.parse(path.read_text(encoding="utf-8"))) or ""
        except (OSError, SyntaxError):
            continue
        head = doc.splitlines()[0] if doc else ""
        summary = head.split(" - ", 1)[1] if " - " in head else head
        low = summary.lower()
        kind = ("act" if low.startswith("act") or "act (" in low[:24]
                else "observe" if low.startswith("observe") else "other")
        out.append({"name": path.stem, "kind": kind, "summary": summary})
    order = {"observe": 0, "act": 1, "other": 2}
    out.sort(key=lambda r: (order[r["kind"]], r["name"]))
    return out


def show_menu() -> int:
    rows = _catalog()
    print("orchestrator - one entry point. `orch.py <script> --help` for any of them.\n")
    labels = {"observe": "OBSERVE  (reads only, touches nothing)",
              "act": "ACT      (changes something, behind the rails)",
              "other": "OTHER"}
    for kind in ("observe", "act", "other"):
        group = [r for r in rows if r["kind"] == kind]
        if not group:
            continue
        print(f"  {labels[kind]}")
        for r in group:
            print(f"    {r['name']:<18} {r['summary'][:88]}")
        print()
    print("  THE LOOP")
    print("    loop               walk the whole orchestration and print what it WOULD do (dry)")
    print("    loop --live        the same walk, acting (identical to sweep.py --all --yes)")
    print()
    print("  THE SWITCH (nothing acts without the tray icon - owner order, 2026-09-01)")
    print("    arm                put the icon on screen, PAUSED - registered, silent, nothing acts")
    print("    arm --now          arm and start the lanes in one step (the old one-keystroke form)")
    print("    resume             THROW THE SWITCH: the lanes fire again on the next boundary")
    print("    pause              stop the lanes, keep the icon up and the dashboard reachable")
    print("    disarm             close the icon: the lanes pause, nothing acts")
    print("    armed              is the icon up (the default on any machine is OFF)")
    return 0


def dry_loop(as_json: bool) -> tuple[int, dict]:
    """The whole loop, acting on nothing. Every stage calls a plan-only path."""
    import balance
    import courier
    import dashboard
    import name_chats
    import reconcile as reconcile_mod
    import sweep
    from lib import holdlib, hydralib

    started = time.time()
    stages: dict = {}

    # 1. Is the fleet readable at all? Everything below is worthless if not.
    health = hydralib.health()
    fleet = hydralib.fleet()
    open_instances = [i for i in fleet.get("instances", []) if i.get("isRunning")]
    stages["census"] = {
        "daemon": health.get("version"),
        "instancesOpen": len(open_instances),
        "instancesTotal": len(fleet.get("instances", [])),
        # The owner's sanity rail: 0-1 open means detection is broken, not that it is quiet.
        "plausible": len(open_instances) >= 2,
    }

    # 2. Every chat, gated, decided.
    plan = dashboard.build_plan()
    counts: dict[str, int] = {}
    for ch in plan["chats"]:
        k = ch["decision"]["kind"]
        counts[k] = counts.get(k, 0) + 1
    stages["gate"] = {"scanned": plan["scanned"], "complete": plan["complete"], "byDecision": counts}

    # 3. Accounts and balancing. (The plan from stage 2 is handed in - rebuilding it here
    # was one of FOUR identical build_plan passes per loop; efficiency pass, 2026-08-31.)
    bal = balance.build(plan=plan)
    # 'blind' mirrors render_loop's own threshold (below) so --json carries the same
    # blind-usage-survey signal the text renderer prints, instead of only the human view.
    # It is exposed as a plain count, not folded into `problems`/exit code: 'usable' also
    # excludes exhausted/closed accounts (balance.py), so a normal end-of-window quota
    # drain would otherwise flip the loop red on every healthy day.
    blind = (bal["totalLogins"] - bal["activeAccounts"]
             if bal["totalLogins"] and bal["activeAccounts"] * 2 < bal["totalLogins"] else 0)
    stages["accounts"] = {
        "usable": bal["activeAccounts"], "logins": bal["totalLogins"],
        "usageSource": bal.get("usageSource"),
        "handOffNext": bal["useNext"][:3],
        "balancing": bal["likelihood"],
        "consoleStrays": len(bal["consoleStrays"]),
        "blind": blind,
    }

    # 4. The sweep's lanes - built plan-only, reusing the plan and balance already in hand.
    batch = sweep.build_batch(allow_pending=False, max_per_lane=sweep.DEFAULT_MAX_PER_LANE,
                              plan=plan, bal=bal)
    stages["lanes"] = {
        lane: {"would": len(v["rows"]), "overCap": v["overCap"],
               "rows": [r.get("title") for r in v["rows"]]}
        for lane, v in batch["lanes"].items()
    }
    stages["lanes"]["deliverySkipped"] = [s["why"] for s in batch.get("deliverySkipped", [])]

    # 5. The naming pass has no plan-only path (its probe IS the act), so COUNT instead of run.
    nameless: dict[str, int] = {}
    for inst in {str(i.get("name")) for i in open_instances}:
        store = name_chats.store_dir_for(inst)
        if store and store.exists():
            n = len(name_chats.nameless_rows(store))
            if n:
                nameless[inst] = n
    stages["naming"] = {"namelessByInstance": nameless,
                        "note": "counted, never probed - the probe is itself the act"}

    # 6. Reconcile: did earlier archives land? (Observe-only by design.)
    rec = reconcile_mod.reconcile()
    stages["reconcile"] = {"checked": rec["checked"],
                           "reverted": len(rec["reverted"]),
                           "states": {s: sum(1 for r in rec["rows"] if r["state"] == s)
                                      for s in {r["state"] for r in rec["rows"]}}}

    # 7. What is left for a person or an AI.
    stages["judgmentQueue"] = [
        {"title": j["title"], "instance": j["instance"], "action": j["action"]}
        for j in batch["judgmentQueue"]
    ]
    stages["onHold"] = [h["title"] for h in batch["onHold"]]
    stages["holds"] = [h["session"] for h in holdlib.held()]
    stages["elapsedSecs"] = round(time.time() - started, 1)

    problems = (not stages["census"]["plausible"]) or (not plan["complete"]) or rec["reverted"]
    return (2 if problems else 0), stages


def render_loop(s: dict) -> str:
    L = ["DRY LOOP - every stage below is a plan. Nothing was touched.\n"]
    c = s["census"]
    L.append(f"1. CENSUS      daemon {c['daemon']} · {c['instancesOpen']} of {c['instancesTotal']} "
             f"instances open · sanity {'OK' if c['plausible'] else '** NOT PLAUSIBLE **'}")
    g = s["gate"]
    L.append(f"2. GATE        {g['scanned']} visible chats"
             + ("" if g["complete"] else "  ⚠ INCOMPLETE - a read failed, counts are lower bounds"))
    for k, v in sorted(g["byDecision"].items(), key=lambda kv: -kv[1]):
        L.append(f"                 {v:>3}  {k}")
    a = s["accounts"]
    L.append(f"3. ACCOUNTS    {a['usable']} usable of {a['logins']} logins (usage via {a['usageSource']})")
    # ⛔ A TOTAL USAGE BLACKOUT MUST NOT READ LIKE A QUIET FLEET (seen live 2026-09-01, during
    # a window reset: this line printed "0 usable of 16 logins" and nothing else changed).
    # Zero usable with logins present does NOT mean the accounts are fine - it means every
    # band decision underneath is being made without numbers, balancing is silently off, and
    # the usage bands the owner set exist on paper only. A bare 0 among ordinary counts is the
    # quietest possible way to say "the safety is blind", so it gets said out loud instead.
    # The threshold is a FRACTION, not zero (corrected 2026-09-01, same day it was added).
    # The first version only fired at exactly 0 usable, and the very next degraded pass read
    # "1 usable of 16" - which sailed straight past it while being just as blind. One usable
    # account cannot balance a fleet or tell you which account is cooked; treating it as a
    # working survey is the same false green, one row further along.
    if a["blind"]:
        blind = a["blind"]
        L.append(f"                 ⚠ only {a['usable']} of {a['logins']} accounts have a usable "
                 f"usage reading ({blind} blind) - the bands are running on partial data and "
                 "balancing is degraded. This is a failed read, NOT a quiet fleet. Re-run "
                 "once; if it persists, fix the usage survey before trusting any lane.")
    for i, n in enumerate(a["handOffNext"], 1):
        tag = "OPEN" if n.get("open") else "closed, would need opening"
        L.append(f"                 hand off #{i}: {n['email']} ({tag}) binding {n['bindingPct']}%")
    L.append(f"                 balancing: {a['balancing']['level'].upper()} - {a['balancing']['why']}")
    L.append("4. LANES       what one `sweep --all --yes` would do:")
    for lane in ("archive", "moves", "landConsole", "deliver"):
        v = s["lanes"][lane]
        extra = f" (+{v['overCap']} over cap)" if v["overCap"] else ""
        L.append(f"                 {lane:<12} {v['would']}{extra}")
        for t in v["rows"][:4]:
            L.append(f"                      - {t}")
    for why in s["lanes"]["deliverySkipped"][:3]:
        L.append(f"                 delivery skipped: {why[:96]}")
    n = s["naming"]
    L.append(f"5. NAMING      {sum(n['namelessByInstance'].values()) or 'no'} chat(s) need a real name"
             + (f" {n['namelessByInstance']}" if n["namelessByInstance"] else ""))
    r = s["reconcile"]
    L.append(f"6. RECONCILE   {r['checked']} past archive attempt(s): "
             + ", ".join(f"{v} {k}" for k, v in r["states"].items()) if r["checked"] else
             "6. RECONCILE   nothing to re-check")
    if r["reverted"]:
        L.append(f"                 ⚠ {r['reverted']} archive(s) need settling through the app's own control")
    L.append(f"7. JUDGMENT    {len(s['judgmentQueue'])} chat(s) need a decided reply (the AI's lane)")
    for j in s["judgmentQueue"][:6]:
        L.append(f"                 [{j['instance'] or 'console'}] {str(j['title'])[:58]}")
    if len(s["judgmentQueue"]) > 6:
        L.append(f"                 ... and {len(s['judgmentQueue']) - 6} more")
    if s["onHold"]:
        L.append(f"8. ON HOLD     {len(s['onHold'])} chat(s) you put out of reach: {', '.join(str(t) for t in s['onHold'][:4])}")
    L.append(f"\nwalked in {s['elapsedSecs']}s. Nothing was changed.")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    from lib import clilib
    clilib.use_utf8_console()
    if not argv or argv[0] in ("--help", "-h"):
        if argv and argv[0] in ("--help", "-h"):
            print(__doc__.strip())
            return 0
        return show_menu()

    name, rest = argv[0], argv[1:]

    if any(a in ("--help", "-h") for a in rest):
        # A help flag after a subcommand must never ACT (2026-09-01: `arm --help` armed the
        # tray against a deliberate stop). Print the manual and stop.
        # (The local `reconfigure(errors="replace")` that used to sit here was a half fix for
        # one branch: it kept cp1252 and degraded the manual's symbols to "?", while the bare
        # `--help` branch above still crashed outright. use_utf8_console() covers both.)
        print(__doc__.strip())
        return 0

    if name in ("arm", "disarm", "armed", "resume", "pause"):
        from lib import armlib
        import schedule_jobs

        quiet = "--quiet" in rest
        tray_ps1 = Path(__file__).resolve().parent / "scripts" / "tray.ps1"
        if name == "arm":
            # THE ICON IS THE SWITCH: arming means putting it on screen. It resumes the
            # eyes itself and starts beating; nothing here opens a window behind his back.
            st = armlib.tray_status()
            if st["up"] and not st["paused"]:
                print(f"already ARMED and RUNNING - the tray icon is up (pid {st['pid']}) and the lanes are firing.")
                return 0
            if st["up"] and st["paused"]:
                # Since 2026-09-02 this is the NORMAL armed state, not a fault: the icon starts
                # paused on purpose, so "up and paused" means the switch is in reach and off.
                print(f"already ARMED but PAUSED - the tray icon is up (pid {st['pid']}) and nothing "
                      "is acting. Start the lanes with: python orch.py resume")
                return 0
            # FULLY RUNNABLE FROM ONE COMMAND (owner, 2026-09-02: "so I don't have to find
            # the script"): a lane that was never registered on this machine is registered
            # now, so the icon has lanes to resume. Idempotent - re-registering replaces.
            try:
                have = set(schedule_jobs.registered())
                want = {n for job, spec in schedule_jobs.JOBS.items() for n in schedule_jobs.task_names(job, spec)}
                missing = sorted(want - have)
            except Exception as err:  # noqa: BLE001 - a registry read must never block the switch
                missing, err_note = [], str(err)[:120]
            else:
                err_note = ""
            if missing:
                results = schedule_jobs.apply_jobs(schedule_jobs.JOBS)
                bad = [r for r in results if not r.get("ok")]
                print(f"registered {len(missing)} missing lane(s): {', '.join(missing)}"
                      + (f" - {len(bad)} did NOT register: " + "; ".join(str(r.get('detail'))[:80] for r in bad) if bad else ""))
            elif err_note:
                print(f"could not read the task registry ({err_note}) - starting the icon anyway", file=sys.stderr)
            # ARMING IS NOT STARTING (owner, 2026-09-02: "it should probably launch on pause so
            # that it doesn't just immediately start working"). The icon comes up paused; the
            # lanes stay registered and silent until `resume`. `--now` is the old one-step form,
            # for when the caller really does mean "and go".
            start_now = "--now" in rest
            cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                   "-WindowStyle", "Hidden", "-File", str(tray_ps1)]
            if start_now:
                cmd.append("-Resumed")
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             close_fds=True)
            deadline = time.time() + ARM_WAIT_SECS
            while time.time() < deadline:
                time.sleep(1)
                st = armlib.tray_status()
                if st["up"]:
                    if start_now:
                        print(f"ARMED and RUNNING - the tray icon is up (pid {st['pid']}) and the "
                              "lanes are firing. Exit the icon (or kill it) to stop everything.")
                    else:
                        print(f"ARMED but PAUSED - the tray icon is up (pid {st['pid']}) and NOTHING "
                              "IS ACTING. Start the lanes deliberately with `python orch.py resume` "
                              "(or Resume on the icon's menu); exit the icon to stop everything.")
                    return 0
            pid = _find_running_tray(REPO)
            if pid:
                print(f"a tray process (pid {pid}) is already running but not beating - run "
                      "`python orch.py disarm` first, then arm again.", file=sys.stderr)
            else:
                print("the tray icon did not start (no heartbeat within 25s) - nothing is armed. "
                      f"Start it by hand: powershell -File {tray_ps1}", file=sys.stderr)
            return 3
        if name == "disarm":
            st = armlib.tray_status(check_pid=False)
            if st.get("pid"):
                subprocess.run(["taskkill", "/PID", str(st["pid"]), "/F"],
                               capture_output=True, text=True, timeout=30)
            armlib.disarm()
            # ⛔ AND CLOSE THE DOOR. Killing the icon with /F skips tray.ps1's own Stop-Remote
            # (it sits after the message loop), and a gateway started by hand carries no
            # ORCH_TRAY_SUPERVISED, so nothing else would ever stop it: "disarmed" would leave
            # the public tunnel serving, and that gateway can arm this machine again from a
            # phone. Disarm therefore means BOTH halves - no lanes, and no door. Found by
            # audit, 2026-09-03. Exit 3 from remote.py just means there was nothing to stop.
            import remote
            rc = remote.main(["--stop"])
            print("DISARMED - the tray icon is gone, remote access is closed"
                  if rc == 0 else
                  "DISARMED - the tray icon is gone and nothing acts (remote access was not running)")
            print("Pausing the scheduled lanes:")
            return schedule_jobs.main(["--pause"])
        if name in ("resume", "pause"):
            # THE SECOND, DELIBERATE ACT. `arm` puts the switch in reach; this throws it. The
            # icon owns the heartbeat, so we ask it rather than writing the state ourselves -
            # a resume this process stamped directly would be overwritten by the next tick.
            want = name == "resume"
            st = armlib.tray_status()
            if not st["up"]:
                print("the tray icon is not up, so there is nothing to "
                      f"{name}. Start it with: python orch.py arm", file=sys.stderr)
                return 3
            if st["paused"] != want:
                print(f"already {'RUNNING' if want else 'PAUSED'} - nothing to do.")
                return 0
            req = armlib.heartbeat_path().parent / "eyes-request.json"
            req.parent.mkdir(parents=True, exist_ok=True)
            req.write_text(json.dumps({"resume": want}), encoding="utf-8")
            # The icon applies it on its next 15s tick; confirm from the heartbeat rather than
            # claiming it, so a wedged icon reports as a failure instead of a silent lie.
            deadline = time.time() + 40
            while time.time() < deadline:
                time.sleep(2)
                st = armlib.tray_status()
                if st["up"] and st["paused"] != want:
                    print(f"{'RUNNING' if want else 'PAUSED'} - the lanes are "
                          f"{'firing again on the next boundary' if want else 'silent; nothing acts'}.")
                    return 0
            req.unlink(missing_ok=True)
            print(f"the icon did not confirm the {name} within 40s - it may be wedged. "
                  "Check the tray, or `python orch.py disarm` and start again.", file=sys.stderr)
            return 3
        st = armlib.status()
        if st["armed"]:
            if not quiet:
                tray = st["tray"]
                print(f"ARMED - the tray icon is up (pid {tray['pid']}, beat {tray['ageSecs']}s ago)"
                      if st["source"] == "tray" else
                      f"ARMED - an in-process window is open ({st['remainingSecs'] // 60}m left)")
            return 0
        if not quiet:
            print(f"DISARMED - {st['why']}. Start the icon with: python orch.py arm")
        return 3

    if name == "loop":
        if "--live" in rest:
            import sweep

            return sweep.main(["--all", "--yes"] + [a for a in rest if a != "--live"])
        try:
            code, stages = dry_loop("--json" in rest)
        except Exception as err:  # noqa: BLE001 - a dry walk must report, never traceback
            print(f"dry loop FAILED: {type(err).__name__}: {err}", file=sys.stderr)
            return 1
        print(json.dumps(stages, indent=2, default=str) if "--json" in rest else render_loop(stages))
        return code

    known = {r["name"] for r in _catalog()}
    if name not in known:
        print(f"unknown script {name!r}. Run `python orch.py` for the menu.", file=sys.stderr)
        return 3
    mod = importlib.import_module(name)
    return mod.main(rest)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
