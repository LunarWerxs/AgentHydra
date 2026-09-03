#!/usr/bin/env python3
"""chats.py - OBSERVE (+`--move-to`): every chat, which ACCOUNT it lives in, and move them.

The one place to answer "what have I got, and where is it?" - every chat with its instance,
the account (email + plan) behind that instance, whether its app is open, whether it is
archived, and how long since it moved. Then move any of them to another account without
looking up ids by hand.

Moving goes through migrate_chat.py's own rails, one chat at a time: holds, the live-writer
refusal, the naming door, the breaker, and the verified landing all still apply. A move is
never silent and never bulk-forced.

Usage:
  python chats.py                                  # every visible chat, grouped by account
  python chats.py --all                            # include archived
  python chats.py --account someone@example.com    # only that account's chats
  python chats.py --instance temp2                 # only that instance
  python chats.py --search "rolodexter"            # title contains
  python chats.py --console                        # only console-only (no desktop home)
  python chats.py --json

  python chats.py --search "rolodexter" --move-to 5claude          # PLAN the move
  python chats.py --search "rolodexter" --move-to 5claude --yes    # do it
  python chats.py --instance temp2 --move-to work --yes --max 3    # move a few at a time

Exit:  0 listed, or every attempted move landed - 2 some moves were refused or did not land
       - 3 bad usage / unknown target - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import clilib
from lib import hydralib


def account_names() -> dict[str, str]:
    """instance dir name -> the account's DISPLAY name ("Michael"), for matching by hand.

    The fleet's account block carries only an email, but people say "the Michael account", so
    `--account Michael` has to work. The names live in the usage survey, which this reads FROM
    ITS CACHE ON DISK - never a fresh survey. A listing must not fire off account checks to
    render, and a missing or stale cache degrades to matching on email alone rather than
    failing: this is a convenience for the filter, never a fact anything else depends on.
    """
    out: dict[str, str] = {}
    try:
        import json as _json
        from pathlib import Path as _Path
        raw = _json.loads((_Path(__file__).resolve().parent.parent / "state"
                           / "usage-survey.json").read_text(encoding="utf-8"))
        for row in (raw.get("survey") or {}).get("rows") or []:
            label = str(((row.get("result") or {}).get("snapshot") or {}).get("account") or "")
            name = label.split("<")[0].strip()
            key = str(row.get("id") or "").rstrip("\\/").split("\\")[-1].split("/")[-1].lower()
            if key and name:
                out[key] = name
    except Exception:  # noqa: BLE001 - the cache is an optional convenience, never a dependency
        pass
    return out


def collect(include_archived: bool, account: str | None, instance: str | None,
            search: str | None, console_only: bool) -> list[dict]:
    by_inst = hydralib.instances_by_name()
    names = account_names()
    rows = []
    for r in hydralib.sessions():
        if r.get("archived") and not include_archived:
            continue
        inst_name = r.get("instance")
        acct = by_inst.get(str(inst_name or "").lower(), {})
        row = {
            "sessionId": r.get("session_id"),
            "title": r.get("title"),
            "instance": inst_name,
            "origin": "desktop" if inst_name else "console",
            "email": acct.get("email"),
            "accountName": names.get(str(inst_name or "").lower()),
            "plan": acct.get("plan"),
            "appRunning": acct.get("isRunning", False),
            "archived": bool(r.get("archived")),
            "lastActivityAt": r.get("last_activity_at"),
            "cwd": r.get("cwd"),
        }
        if console_only and row["origin"] != "console":
            continue
        # SUBSTRING, NOT EXACT (2026-09-02). `--account` used to demand the whole email, so
        # `--account Michael` - the name a person actually uses - returned "no chats match",
        # which is the SAME output as an account that genuinely has none. A filter typo and a
        # clean account were indistinguishable, and the false "that account is empty" is the
        # dangerous half. Matching the display name too costs nothing and removes the trap;
        # main() then says outright when a filter matched no account at all.
        if account and account.lower() not in (f"{row['email'] or ''} {row['accountName'] or ''}").lower():
            continue
        if instance and instance.lower() not in str(row["instance"] or "").lower():
            continue
        if search and search.lower() not in str(row["title"] or "").lower():
            continue
        rows.append(row)
    rows.sort(key=lambda r: (str(r["email"] or "~console"), -(r["lastActivityAt"] or 0)))
    return rows


def _ago(ms: int | None) -> str:
    if not ms:
        return "-"
    s = max(0, time.time() - ms / 1000)
    if s < 3600:
        return f"{int(s // 60)}m"
    if s < 86400:
        return f"{s / 3600:.1f}h"
    return f"{int(s // 86400)}d"


def render(rows: list[dict]) -> str:
    if not rows:
        return "no chats match."
    L = []
    groups: dict[str, list[dict]] = {}
    for r in rows:
        key = f"{r['email'] or '(console-only - no desktop home)'}"
        groups.setdefault(key, []).append(r)
    for email, chats in groups.items():
        inst = chats[0]["instance"]
        plan = chats[0]["plan"]
        running = " 🟢 open" if chats[0]["appRunning"] else (" ◦ closed" if inst else "")
        head = f"{email}" + (f"  [{inst}, {plan}{running}]" if inst else "")
        L.append(f"\n{head}   ({len(chats)} chat(s))")
        for c in chats:
            mark = "🗄" if c["archived"] else "  "
            L.append(f"  {mark} {_ago(c['lastActivityAt']):>5}  {str(c['title'] or '(untitled)')[:64]}")
            L.append(f"          {c['sessionId']}")
    L.append(f"\n{len(rows)} chat(s) across {len(groups)} account(s)/lane(s)")
    return "\n".join(L)


def move(rows: list[dict], target: str, act: bool, cap: int) -> dict:
    import migrate_chat

    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        return {"error": str(err), "results": []}
    tgt = hydralib.resolve_instance(fleet, target)
    if tgt is None:
        known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
        return {"error": f"unknown target {target!r}. Known: {known}", "results": []}

    movable = [r for r in rows
               if str(r["instance"] or "").lower() != str(tgt.get("name") or "").lower()]
    planned = movable[:cap]
    results = []
    if act:
        for r in planned:
            # --stop-idle, like the sweep's move and land lanes (migrate_chat's own manual says
            # they pass it, and this path did not - so moving any desktop chat by hand was
            # refused for "live engine" on an engine that had plainly finished, and the caller
            # had to drop down to migrate_chat.py to do the very thing this flag is for. It
            # only ever stops an engine the gate calls SAFELY IDLE; a working or stuck one
            # still refuses, and a live writer is never overridden.)
            code, out = clilib.capture(migrate_chat.main,
                                       [r["sessionId"], "--to", str(tgt.get("name")), "--stop-idle"])
            results.append({
                "sessionId": r["sessionId"], "title": r["title"], "exit": code, "ok": code == 0,
                "outcome": ("landed and verified" if code == 0 else
                            "deterministic refusal" if code == 3 else
                            "live writer - never moved" if code == 4 else
                            "breaker" if code == 5 else
                            "HELD by a person" if code == 6 else f"failed (exit {code})"),
                "detail": out.splitlines()[0][:160] if out else "",
            })
    return {
        "target": {"instance": tgt.get("name"), "num": tgt.get("num"),
                   "isRunning": bool(tgt.get("isRunning")),
                   "email": (tgt.get("account") or {}).get("email")},
        "planned": [{"sessionId": r["sessionId"], "title": r["title"], "from": r["instance"]}
                    for r in planned],
        "alreadyThere": len(rows) - len(movable),
        "overCap": max(0, len(movable) - len(planned)),
        "results": results,
    }


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    act = "--yes" in argv
    include_archived = "--all" in argv
    console_only = "--console" in argv
    account = instance = search = move_to = None
    cap = 10
    i = 0
    while i < len(argv):
        a = argv[i]
        for flag, setter in (("--account", "account"), ("--instance", "instance"),
                             ("--search", "search"), ("--move-to", "move_to")):
            if a == flag:
                if i + 1 >= len(argv):
                    print(__doc__.strip(), file=sys.stderr)
                    return 3
                val = argv[i + 1]
                if setter == "account":
                    account = val
                elif setter == "instance":
                    instance = val
                elif setter == "search":
                    search = val
                else:
                    move_to = val
                i += 1
                break
        if a == "--max" and i + 1 < len(argv):
            cap = int(argv[i + 1])
            i += 1
        i += 1

    try:
        rows = collect(include_archived, account, instance, search, console_only)
    except hydralib.DaemonError as err:
        print(f"chats read FAILED: {err}", file=sys.stderr)
        return 1

    # A FILTER THAT MATCHED NOTHING IS NOT AN EMPTY ACCOUNT. Both used to print the same bare
    # "no chats match.", so a mistyped account read exactly like a clean one - and "that account
    # has nothing on it" is a conclusion someone acts on. Say which it was.
    if not rows and account:
        # Built from the FLEET, not from the rows: an account with zero chats is absent from the
        # rows, so checking against those would report a real, currently-empty account as
        # "unknown" - swapping one wrong answer for another. Three outcomes, kept distinct.
        names = account_names()
        known = {}
        try:
            for iname, acct in hydralib.instances_by_name().items():
                known[iname] = f"{names.get(iname) or ''} {acct.get('email') or ''}".strip()
        except hydralib.DaemonError:
            known = {}
        hit = [v for v in known.values() if v and account.lower() in v.lower()]
        if known and not hit:
            print(f"no ACCOUNT matches {account!r} - nothing matched the filter, which is NOT the "
                  "same as an account with no chats. Known: "
                  + ", ".join(sorted({v for v in known.values() if v})), file=sys.stderr)
            return 3
        if hit:
            print(f"{', '.join(sorted(set(hit)))} - matched, and it holds NO chats"
                  + ("" if include_archived else " (archived ones are hidden; --all includes them)")
                  + ".")
            return 0

    if not move_to:
        print(json.dumps({"chats": rows}, indent=2) if as_json else render(rows))
        return 0

    plan = move(rows, move_to, act, cap)
    if plan.get("error"):
        print(f"REFUSED: {plan['error']}", file=sys.stderr)
        return 3
    if as_json:
        print(json.dumps(plan, indent=2))
    else:
        t = plan["target"]
        state = "OPEN" if t["isRunning"] else "CLOSED - it would need opening first"
        print(f"target: {t['instance']} ({t['email']}) - {state}")
        print(f"{len(plan['planned'])} chat(s) {'moved' if act else 'would move'}"
              + (f", {plan['alreadyThere']} already there" if plan["alreadyThere"] else "")
              + (f" (+{plan['overCap']} over --max)" if plan["overCap"] else ""))
        for p in plan["planned"]:
            print(f"  {p['from'] or 'console'} -> {t['instance']}   {str(p['title'])[:60]}")
        for r in plan["results"]:
            print(f"  {'✓' if r['ok'] else '✗'} {r['outcome']}: {str(r['title'])[:56]}")
            if not r["ok"] and r["detail"]:
                print(f"      {r['detail']}")
        if not act:
            print("\nPLAN ONLY - nothing moved. Add --yes to do it.")
    if not act:
        return 0
    return 0 if all(r["ok"] for r in plan["results"]) else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
