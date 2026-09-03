#!/usr/bin/env python3
"""smoke.py - READ-ONLY smoke test against the LIVE daemon: proves the whole observe chain.

Runs every read this toolbox depends on, asserts the shapes it needs, and touches nothing -
no POST anywhere in this file, ever. Safe to run at any time, including while the fleet works.

Usage: python smoke.py [--json]
Exit:  0 every check passed - 1 any check failed (each failure named, loudly).
"""

from __future__ import annotations

import json
import sys

from lib import clilib, gatelib
from lib import hydralib
from lib import ledgerlib


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    checks: list[dict] = []

    def check(name: str, fn):
        try:
            detail = fn()
            checks.append({"name": name, "ok": True, "detail": detail})
        except Exception as e:  # a smoke test reports, it never crashes half-way
            checks.append({"name": name, "ok": False, "detail": f"{type(e).__name__}: {e}"})

    def c_health():
        h = hydralib.health()
        assert h.get("ok") is True, f"health.ok is {h.get('ok')}"
        return f"daemon {h.get('version')} ({h.get('distribution')})"

    def c_fleet():
        f = hydralib.fleet()
        inst = f.get("instances")
        assert isinstance(inst, list) and inst, "fleet.instances missing or empty"
        for field in ("num", "name", "dir", "isRunning"):
            assert field in inst[0], f"instance rows lack '{field}'"
        return f"{len(inst)} instances, {sum(1 for i in inst if i.get('isRunning'))} open"

    def c_sessions():
        rows = hydralib.sessions()
        assert isinstance(rows, list) and rows, "no session rows"
        for field in ("session_id", "archived", "title", "instance", "transcript_path", "last_activity_at"):
            assert field in rows[0], f"session rows lack '{field}'"
        return f"{len(rows)} rows, {sum(1 for r in rows if not r.get('archived'))} visible"

    def c_dossier_roundtrip():
        rows = sorted(hydralib.sessions(), key=lambda r: r.get("last_activity_at") or 0)
        newest = rows[-1]
        matches = hydralib.dossier(newest["session_id"])
        assert matches, f"dossier found nothing for the newest session ({newest.get('title')!r})"
        m = matches[0]
        for field in ("instance", "chatId", "cliSessionId", "archived", "lineageIds"):
            assert field in m, f"dossier matches lack '{field}'"
        return f"newest chat resolves: [{m.get('instance')}] {m.get('title')}"

    def c_gate_end_to_end():
        rows = [r for r in hydralib.sessions() if r.get("transcript_path")]
        assert rows, "no session with a transcript_path"
        newest = sorted(rows, key=lambda r: r.get("last_activity_at") or 0)[-1]
        live = None
        for m in hydralib.dossier(newest["session_id"]):
            if m.get("cliSessionId") == newest["session_id"]:
                live = m.get("live")
        v = gatelib.gate(newest["session_id"], newest["transcript_path"], live)
        assert v is not None, "gate returned None for a session that has a transcript_path"
        assert v["state"] in ("running", "crashed", "finished"), f"unknown state {v['state']}"
        return f"gated the newest chat: {v['state']} - {v['cause'][:80]}"

    def c_ledger():
        ledgerlib.check("archive", "smoke-test-never-acted-on")
        return f"ledger readable at cap {ledgerlib.ATTEMPT_CAP} / window {ledgerlib.ATTEMPT_WINDOW_MS // 3600_000}h"

    check("health", c_health)
    check("fleet shape", c_fleet)
    check("sessions shape", c_sessions)
    check("dossier round-trip", c_dossier_roundtrip)
    check("gate end-to-end (read-only)", c_gate_end_to_end)
    check("attempt ledger", c_ledger)

    failed = [c for c in checks if not c["ok"]]
    if as_json:
        print(json.dumps({"ok": not failed, "checks": checks}, indent=2))
    else:
        for c in checks:
            print(f"{'PASS' if c['ok'] else 'FAIL'}  {c['name']:<28} {c['detail']}")
        print()
        print(
            f"{len(checks) - len(failed)}/{len(checks)} passed"
            + ("" if not failed else " - the observe chain is NOT trustworthy until these are fixed")
        )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
