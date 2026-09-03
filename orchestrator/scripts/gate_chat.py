#!/usr/bin/env python3
"""gate_chat.py - OBSERVE ONLY: gate ONE chat and print the verdict with its evidence.

This is the same gate every act script runs before touching anything; running it by hand shows
exactly what automation would decide and why, without acting on it.

Usage: python gate_chat.py <title fragment | session id> [--json]
Exit:  0 gated - 3 chat not resolvable / no transcript (deterministic) - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys

from lib import clilib, gatelib
from lib import hydralib


def gate_resolved(match: dict) -> dict | None:
    """Gate a dossier match. The join itself lives in gatelib (shared judgment); this stays
    as the CLI's own readable call site."""
    return gatelib.gate_match(match, hydralib.session_row)


def render(v: dict) -> str:
    L = [
        f"state    {v['state'].upper()}",
        f"cause    {v['cause']}",
        f"quiet    {v['quiet_secs']}s",
    ]
    if v.get("stalled"):
        L.append(f"stalled  {v['stalled']['why']}")
    if v.get("idle"):
        i = v["idle"]
        L.append(
            f"idle     done_claim={i['done_claim']} ends_with_question={i['ends_with_question']} "
            f"recap_present={i['recap_present']}"
        )
    f = v.get("finished")
    if f:
        L.append(
            f"lane     {f['lane']}  (done={f['done_claim']} question={f['ends_with_question']} "
            f"offers_to_continue={f['offers_to_continue']} interrupted={f['interrupted']})"
        )
        tail = f["last_assistant_text"].strip()
        if tail:
            L.append("last assistant text (evidence):")
            for line in tail.splitlines()[-12:]:
                L.append(f"  | {line}")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        match = hydralib.resolve_one(args[0])
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        print(f"cannot gate: {err}", file=sys.stderr)
        return 3
    except hydralib.DaemonError as err:
        print(f"gate FAILED: {err}", file=sys.stderr)
        return 1
    verdict = gate_resolved(match)
    if verdict is None:
        print(
            "cannot gate: no transcript found for this chat - a thing that cannot be gated "
            "cannot be acted on.",
            file=sys.stderr,
        )
        return 3
    print(json.dumps(verdict, indent=2) if as_json else render(verdict))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
