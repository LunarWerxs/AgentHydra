#!/usr/bin/env python3
"""cli_accounts.py - OBSERVE (+`--create`): the accounts the CONSOLE fleet can run on.

THE MODEL, and it is the one AgentHydra already uses, not a new one: a DESKTOP account is an
Electron profile (`--user-data-dir`); a CONSOLE account is a `CLAUDE_CONFIG_DIR` directory with
its own OAuth login. They are separate logins even for the same person, so a desktop account
being signed in tells you nothing about the console side.

⛔ THE ONE THING AUTOMATION CANNOT DO IS LOG IN. That is an OAuth flow and it is the owner's
step, always. This creates the directory, reports which ones are ready, and prints the exact
command to finish each - it never touches a credential.

WHY "OPEN" DOES NOT EXIST HERE (owner, 2026-09-01: "I'll likely switch to having you load
balance across ALL available accounts, regardless of if they're open"). A console account has
no window to open: it is a directory. Every logged-in account is available every moment, which
removes the whole open/closed dance the desktop lanes have to negotiate - and with it the rule
that an app may only be opened as a last resort.

Usage: python cli_accounts.py [--json]              # the roster, and what each one needs
       python cli_accounts.py --create <name>       # make a config dir, print the login command
Exit:  0 fine - 2 some accounts are not logged in yet (each named) - 1 read failure.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from lib import clilib, hydralib

# Where the console accounts live. AgentHydra keeps its own under ~/.agenthydra/cli-instances;
# ours default to the same root so the two views agree, and the env var moves them wholesale
# for the other machine.
ROOT = Path(os.environ.get("ORCH_CLI_ACCOUNTS")
            or (Path.home() / ".agenthydra" / "cli-instances"))
# The default account is simply the CLI's own config dir - it is a real account and pretending
# otherwise would hide the one that is always ready.
DEFAULT_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def login_state(config_dir: Path) -> tuple[bool, str]:
    """(ready, why) for one console account - WITHOUT a token ever reaching this process.

    ⛔ THE FILE'S EXISTENCE IS NOT A LOGIN, and assuming it was cost a spawn that reported
    success and produced nothing (measured 2026-09-01: the default account's credentials file
    was present, its tokens were EMPTY strings and its refresh token had expired weeks ago, so
    every terminal opened and died on "OAuth session expired"). Presence, length and expiry are
    read; the values are never read into a variable, never printed, never returned.
    """
    p = config_dir / ".credentials.json"
    if not p.exists():
        return False, "never logged in"
    try:
        oauth = (json.loads(p.read_text(encoding="utf-8")) or {}).get("claudeAiOauth") or {}
        has_access = bool(len(str(oauth.get("accessToken") or "")))
        has_refresh = bool(len(str(oauth.get("refreshToken") or "")))
        now_ms = time.time() * 1000
        access_live = has_access and float(oauth.get("expiresAt") or 0) > now_ms
        refresh_live = has_refresh and float(oauth.get("refreshTokenExpiresAt") or 0) > now_ms
    # Covers a torn JSON read, a non-dict claudeAiOauth, and a non-numeric expiry - any one
    # malformed credentials file must report as unreadable, never crash the whole roster.
    except (OSError, ValueError, TypeError, AttributeError):
        return False, "its credentials file is unreadable"
    if access_live or refresh_live:
        return True, "signed in"
    if not has_access and not has_refresh:
        return False, "signed out - the credentials file is empty"
    return False, "its session expired and cannot refresh"


def _logged_in(config_dir: Path) -> bool:
    return login_state(config_dir)[0]


def accounts() -> list[dict]:
    """Every console account this machine has, ready or not."""
    ready, why = login_state(DEFAULT_DIR)
    rows: list[dict] = [{
        "name": "default", "configDir": str(DEFAULT_DIR),
        "loggedIn": ready, "why": why, "source": "the CLI's own config dir",
    }]
    if ROOT.exists():
        for d in sorted(p for p in ROOT.iterdir() if p.is_dir()):
            ok, why = login_state(d)
            rows.append({"name": d.name, "configDir": str(d),
                         "loggedIn": ok, "why": why, "source": "cli-instances"})
    # The daemon knows about its own CLI instances too; merge anything it has that we missed
    # rather than presenting a second, disagreeing roster.
    try:
        for inst in hydralib.api_get("/api/cli-instances") or []:
            cd = str(inst.get("configDir") or "")
            if cd and not any(r["configDir"] == cd for r in rows):
                ok, why = login_state(Path(cd))
                rows.append({"name": inst.get("name") or inst.get("id"), "configDir": cd,
                             "loggedIn": ok, "why": why, "source": "agenthydra"})
    except (hydralib.DaemonError, TypeError):
        pass  # the daemon is optional for the console fleet; that is the point of it
    return rows


def create(name: str) -> dict:
    ROOT.mkdir(parents=True, exist_ok=True)
    d = ROOT / name
    existed = d.exists()
    d.mkdir(exist_ok=True)
    return {"name": name, "configDir": str(d), "existed": existed,
            "loggedIn": _logged_in(d)}


def login_command(config_dir: str) -> str:
    """The exact line the OWNER runs once per account. Deliberately a visible terminal."""
    return (f'$env:CLAUDE_CONFIG_DIR="{config_dir}"; claude   '
            "# then /login, once, and close it")


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv

    if "--create" in argv:
        i = argv.index("--create")
        if i + 1 >= len(argv):
            print("--create needs a name", file=sys.stderr)
            return 1
        got = create(argv[i + 1])
        if as_json:
            print(json.dumps(got, indent=2))
        else:
            state = "already existed" if got["existed"] else "created"
            print(f"{state}: {got['configDir']}")
            if not got["loggedIn"]:
                print("\nIt needs ONE login, and only you can do that:\n  "
                      + login_command(got["configDir"]))
        return 0

    rows = accounts()
    if as_json:
        print(json.dumps(rows, indent=2))
        return 2 if [r for r in rows if not r["loggedIn"]] else 0
    ready = [r for r in rows if r["loggedIn"]]
    print(f"{len(ready)} of {len(rows)} console account(s) ready to run chats:")
    for r in rows:
        print(f"  {'OK ' if r['loggedIn'] else 'NO '}{r['name']:<18} "
              f"{r['configDir']:<44} {r.get('why', '')}")
    missing = [r for r in rows if not r["loggedIn"]]
    if missing:
        print(f"\n{len(missing)} need ONE login each - only you can do that:")
        for r in missing:
            print("  " + login_command(r["configDir"]))
    return 2 if missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
