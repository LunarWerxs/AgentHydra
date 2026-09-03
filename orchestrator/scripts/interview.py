#!/usr/bin/env python3
"""interview.py - THE CALLOUT PROTOCOL: the orchestrator asks, an AI answers, code executes.

THE OPERATING MODEL (owner, 2026-08-31): maximum automation, SDK-shaped. Scripts and
heuristics do everything mechanical on their own; the AI is consulted like a subroutine -
handed exactly the question and the evidence, asked for exactly a decision, and nothing
more. No fleet context, no giant don't-lists, no bespoke coding: the AI reads the actual
last words of each waiting chat and answers; this script executes the answers through the
existing rails.

THE LOOP
  1. `python interview.py --ask`            the orchestrator emits QUESTIONS: one
                                            self-contained block per judgment-queue chat
                                            (its last words + the exact answer format).
  2. (the AI reads each block and writes answers.json - decisions, nothing else)
  3. `python interview.py --apply answers.json`   each decision executes through the rails:
       reply   -> staged via the delivery ledger; the next courier/sweep run sends it
       hold    -> holdlib, reason required (the chat leaves automation's reach)
       archive -> archive_chat --force (the answer IS the person-level word the gate wanted)
       skip    -> recorded with its reason; the chat stays in the queue

ANSWER FORMAT (what --ask also prints, so the AI never has to guess):
  {"answers": [
    {"sessionId": "<id>", "decision": "reply",   "text": "the message to send"},
    {"sessionId": "<id>", "decision": "hold",    "reason": "why hands-off"},
    {"sessionId": "<id>", "decision": "archive"},
    {"sessionId": "<id>", "decision": "skip",    "reason": "why not now"}
  ]}

Usage: python interview.py --ask [--json] [--max N]
       python interview.py --apply <answers.json> [--json]
Exit:  0 asked/applied cleanly - 2 some answers did not apply (each named) - 3 bad usage or
       malformed answers - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from lib import clilib
from lib import deliverylib
from lib import holdlib
from lib import hydralib

MAX_QUESTIONS = 20
EVIDENCE_CHARS = 900


def build_questions(cap: int) -> dict:
    """One self-contained block per judgment chat: everything an AI needs, nothing more."""
    import sweep

    batch = sweep.build_batch(allow_pending=False, max_per_lane=sweep.DEFAULT_MAX_PER_LANE)
    questions = []
    for j in batch["judgmentQueue"][:cap]:
        questions.append({
            "sessionId": j["sessionId"],
            "title": j["title"],
            "instance": j["instance"],
            "state": j["action"],
            "why": j["why"],
            "lastWords": (j.get("evidence") or "")[-EVIDENCE_CHARS:],
            "question": ("Decide ONE of: reply (give the exact text to send into this chat), "
                         "hold (give the reason it should be hands-off), archive (only if its "
                         "work is genuinely settled), or skip (give the reason). THE PROGRESS "
                         "DEFAULT (owner): a chat whose last words offer to continue or name a "
                         "next step gets a REPLY that says which thing to do - hold and skip "
                         "demand a reason a person would accept, and 'waiting on the owner' "
                         "only counts when the decision is genuinely his (spend, customers, "
                         "public exposure, another person's lane). A recap whose 'recommend' "
                         "section lists sensible items gets 'Proceed with your "
                         "recommendations' - the owner calls acting on those his most "
                         "productive channel."),
        })
    return {
        "questions": questions,
        "overCap": max(0, len(batch["judgmentQueue"]) - cap),
        "answerFormat": {"answers": [{"sessionId": "<id>", "decision": "reply|hold|archive|skip",
                                      "text": "(reply only)", "reason": "(hold/skip only)"}]},
    }


def apply_answers(payload: dict) -> list[dict]:
    import archive_chat
    from lib import gatelib

    results = []
    answers = payload.get("answers")
    if not isinstance(answers, list):
        raise ValueError("answers.json must be {\"answers\": [...]}")
    for a in answers:
        sid = str(a.get("sessionId") or "")
        decision = str(a.get("decision") or "")
        entry = {"sessionId": sid, "decision": decision}
        try:
            if decision == "reply":
                text = str(a.get("text") or "").strip()
                if not text:
                    raise ValueError("a reply decision needs text")
                match = hydralib.resolve_one(sid)
                verdict = gatelib.gate_match(match, hydralib.session_row)
                src = (verdict or {}).get("finished") or (verdict or {}).get("idle") or {}
                evidence = src.get("last_assistant_text") or ""
                if not evidence:
                    # THE SAME FALLBACK stage_reply.py GOT, AND THIS PATH DID NOT (2026-09-01).
                    # The gate reports last_assistant_text only for a FINISHED or IDLE chat, so
                    # a busy one stages with no evidence, no verify snippet, and the courier
                    # then refuses to type - the reply is written, queued, and undeliverable
                    # forever. Fixing it in stage_reply alone left the JUDGMENT QUEUE, which is
                    # where most replies are actually written, still producing dead ones.
                    import stage_reply
                    evidence = stage_reply.last_rendered_text(sid)
                staged = deliverylib.stage(
                    sid, text, title=match.get("title") or "",
                    instance=match.get("instance") or "",
                    evidence=evidence, by="interview",
                )
                entry.update(ok=True, outcome=f"staged {staged['id']} - the next courier/sweep run delivers it")
            elif decision == "hold":
                reason = str(a.get("reason") or "").strip()
                holdlib.hold(sid, reason)  # raises without a reason - the law
                entry.update(ok=True, outcome="held - automation leaves it alone until released")
            elif decision == "archive":
                code, said = clilib.capture(archive_chat.main, [sid, "--force"])
                # Exit 8 = DEFERRED: the chat was asked to update its docs first and archives
                # on a later pass. That IS the right thing happening, so it counts as ok.
                entry.update(ok=code in (0, 8), exit=code,
                             outcome="archived and verified" if code == 0
                             else "asked to preserve its docs first; archives on a later pass" if code == 8
                             else f"archive refused/failed (exit {code}): "
                                  f"{said.splitlines()[0][:120] if said else ''}")
            elif decision == "skip":
                entry.update(ok=True, outcome=f"skipped: {str(a.get('reason') or 'no reason given')[:120]}")
            else:
                raise ValueError(f"unknown decision {decision!r}")
        except (hydralib.ChatNotFound, hydralib.AmbiguousChat, hydralib.DaemonError, ValueError) as err:
            entry.update(ok=False, outcome=f"did not apply: {err}")
        results.append(entry)
    return results


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    cap = MAX_QUESTIONS
    if "--max" in argv:
        cap = int(argv[argv.index("--max") + 1])

    if "--ask" in argv:
        try:
            q = build_questions(cap)
        except hydralib.DaemonError as err:
            print(f"interview FAILED: {err}", file=sys.stderr)
            return 1
        if as_json:
            print(json.dumps(q, indent=2))
        else:
            if not q["questions"]:
                print("nothing to ask - the judgment queue is empty.")
                return 0
            print(f"{len(q['questions'])} question(s)"
                  + (f" (+{q['overCap']} over --max)" if q["overCap"] else "")
                  + " - answer with: python interview.py --apply answers.json\n")
            for i, x in enumerate(q["questions"], 1):
                print(f"--- {i}. [{x['instance'] or 'console'}] {x['title']}")
                print(f"    id: {x['sessionId']}")
                print(f"    state: {x['state']}")
                print(f"    its last words:")
                for line in (x["lastWords"] or "(nothing readable)").splitlines()[-8:]:
                    print(f"      | {line}")
                print(f"    -> {x['question']}\n")
            print(json.dumps(q["answerFormat"], indent=2))
        return 0

    if "--apply" in argv:
        i = argv.index("--apply")
        if i + 1 >= len(argv):
            print(__doc__.strip(), file=sys.stderr)
            return 3
        path = Path(argv[i + 1])
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            results = apply_answers(payload)
        except (OSError, json.JSONDecodeError, ValueError) as err:
            print(f"answers file rejected: {err}", file=sys.stderr)
            return 3
        if as_json:
            print(json.dumps({"results": results}, indent=2))
        else:
            for r in results:
                print(f"  {'✓' if r.get('ok') else '✗'} {r['decision']:<8} {r['sessionId'][:8]}  {r['outcome']}")
        return 0 if all(r.get("ok") for r in results) else 2

    print(__doc__.strip(), file=sys.stderr)
    return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
