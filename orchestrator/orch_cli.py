#!/usr/bin/env python3
"""orch_cli.py - the CONSOLE orchestrator: one entry point, same shape as orch.py.

WHY THERE ARE TWO (owner, 2026-09-01: "please build me a CLI/console version of this as well,
then I'll have you do some test runs to see if I prefer it"). This is a parallel fleet, not a
replacement: the desktop lanes keep running untouched while this one is tried. They share every
piece of JUDGMENT - the gate that reads a chat's state, the hold switch, the attempt ledger,
the usage bands - and differ only in transport and lifecycle, which is exactly where the
desktop side's defects lived.

WHAT THE CONSOLE SIDE SIMPLY DOES NOT HAVE, each one a class of bug from the desktop work:
  - no window to full-screen, and no accessibility automation to mis-click;
  - no permission mode that drifts: it is a launch flag, so no chat can stop to ask;
  - no second copy of a conversation: a chat IS its transcript file;
  - no index that disagrees with what is on screen;
  - no open/closed accounts: an account is a directory, so all of them are always available.
What it keeps: every chat runs in a REAL terminal you can read and type into (the owner's
standing law), and every judgment call is made by the same code as before.

  python orch_cli.py            this menu
  python orch_cli.py loop       DRY: accounts, chats, and what the floor lane would do
  python orch_cli.py <script>   run one console script (its own --help explains it)
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
SCRIPTS = REPO / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _summary(path: Path) -> str:
    try:
        head = path.read_text(encoding="utf-8")[:1200]
    except OSError:
        return ""
    if '"""' not in head:
        return ""
    body = head.split('"""', 2)[1].strip().splitlines()
    first = body[0] if body else ""
    return first.split(" - ", 1)[1] if " - " in first else first


def menu() -> int:
    print(__doc__.strip())
    print("\nCONSOLE SCRIPTS")
    for p in sorted(SCRIPTS.glob("cli_*.py")):
        print(f"    {p.stem:<16} {_summary(p)[:96]}")
    print("\nSHARED WITH THE DESKTOP FLEET (same judgment, either side)")
    for name in ("gate_chat", "hold_chat", "stage_reply", "audit_done_bar"):
        p = SCRIPTS / f"{name}.py"
        if p.exists():
            print(f"    {name:<16} {_summary(p)[:96]}")
    return 0


def loop() -> int:
    """Everything the console fleet can see, and what it would do. Touches nothing."""
    import cli_accounts
    import cli_saturate
    import cli_sessions

    print("=== ACCOUNTS " + "=" * 54)
    rows = cli_accounts.accounts()
    ready = [r for r in rows if r["loggedIn"]]
    for r in rows:
        print(f"  {'OK ' if r['loggedIn'] else 'NO '}{r['name']:<18} {r['configDir']}")
    if len(ready) < len(rows):
        print(f"  -> {len(rows) - len(ready)} need one login each (only you can): "
              "python scripts/cli_accounts.py")

    print("\n=== CHATS " + "=" * 57)
    chats = cli_sessions.chats()
    running = [c for c in chats if c["running"]]
    print(f"  {len(chats)} chat(s) touched in the last week, {len(running)} running")
    for c in running[:12]:
        print(f"    RUN [{c['account']:<10}] {(c['name'] or c['sessionId'][:8])[:32]:<32} "
              f"{c['state']}")

    print("\n=== THE FLOOR " + "=" * 53)
    plan = cli_saturate.build_plan()
    print(f"  {plan['running']} running of {plan['floor']}; would start {len(plan['planned'])}"
          f" across {len(plan['usableAccounts'])} account(s)")
    for p in plan["planned"]:
        print(f"    [{p['onAccount']}] {(p.get('name') or p['sessionId'][:8])[:32]:<32} {p['why']}")
    if plan["shortfall"]:
        print(f"  {plan['shortfall']} slot(s) have no honest candidate.")
    print("\nDRY - nothing was touched. cli_saturate needs --yes to act; "
          "other scripts (cli_send, cli_spawn, ...) act on their own args, no --yes gate.")
    return 0


def main(argv: list[str]) -> int:
    from lib import clilib
    clilib.use_utf8_console()
    if not argv or argv[0] in ("--help", "-h"):
        return menu()
    if argv[0] == "loop":
        return loop()
    target = SCRIPTS / f"{argv[0]}.py"
    if not target.exists():
        print(f"no such script: {argv[0]}", file=sys.stderr)
        return 3
    return subprocess.call([sys.executable, str(target), *argv[1:]])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
