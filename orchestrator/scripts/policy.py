#!/usr/bin/env python3
"""policy.py - OBSERVE (and write your own policy file): every knob the orchestrator has,
what it does in plain English, what it is set to, and the three ways to change it.

THE ASK (owner, 2026-09-17): "most of the orchestrator should probably be configurable. Like,
it should ask which variants or whatever, which toggles, triggers, options the user wants on.
And then when we decide that, it orchestrates." Before this, 138 policy knobs lived as module
constants across 18 files and steering the fleet meant editing Python. Now they live in
lib/configlib.py with defaults, and your decisions live in state/config.json.

THREE WAYS TO SET IT, because three different things ask:

  A PERSON at a terminal:   python orch.py policy --wizard
                            walks every group, shows each knob with its plain-English
                            meaning, takes Enter for 'leave it'. Nothing is written until
                            the end, and it shows the diff before writing.

  AN AI (or a script):      python orch.py policy --ask  > questions.json
                            python orch.py policy --apply answers.json
                            the same shape interview.py uses - a self-contained question per
                            knob, then one file of decisions applied atomically.

  ONE KNOB, RIGHT NOW:      python orch.py policy --set archive.per_run=5 lanes.deliver=off

Usage: python orch.py policy                      # the status page: what is not at default
       python orch.py policy --list [group]       # every knob, its value, its meaning
       python orch.py policy --explain <key>      # one knob in full
       python orch.py policy --set k=v [k=v ...]  # change some (validated, then written)
       python orch.py policy --unset k [k ...]    # back to the default
       python orch.py policy --preset <name>      # default | observe-only | conservative | aggressive
       python orch.py policy --wizard             # interactive, group by group
       python orch.py policy --ask [--group G]    # the questionnaire, as JSON, for an AI
       python orch.py policy --apply <file.json>  # apply that AI's answers
       python orch.py policy --doctor             # is the file on disk valid
       (--json on the status/list/explain views)
Exit:  0 fine - 2 the config on disk has problems (named) - 3 a bad argument.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from lib import clilib
from lib import configlib


def _wrap(text: str, width: int) -> list[str]:
    """textwrap, without the import - help strings are short and this keeps the module's
    dependency surface to clilib and configlib."""
    words, lines, cur = str(text).split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines or [""]


_UNSET = object()


def _fmt(row: dict, value=_UNSET) -> str:
    """One value, rendered the way a person reads it: seconds as minutes, null as 'uncapped'.

    The sentinel is load-bearing: `None` is a REAL value here (an uncapped knob), so a
    default of None silently re-read row['value'] and blew up on a raw spec row that has
    none - caught by the preset test, 2026-09-17."""
    v = row["value"] if value is _UNSET else value
    if v is None:
        return "uncapped"
    if row["kind"] == "bool":
        return "ON" if v else "OFF"
    if row["kind"] == "secs":
        return f"{v}s ({v // 60}m)" if v >= 120 else f"{v}s"
    if row["kind"] == "pct":
        return f"{v}%"
    if row["kind"] == "str":
        return f'"{v}"' if len(str(v)) <= 60 else f'"{str(v)[:57]}..."'
    return str(v)


def _group_title(group: str) -> str:
    return dict(configlib.GROUPS).get(group, group)


def show_status(as_json: bool) -> int:
    changed = configlib.diff()
    problems = configlib.problems()
    if as_json:
        print(json.dumps({"configPath": str(configlib.CONFIG_PATH),
                          "exists": configlib.CONFIG_PATH.exists(),
                          "knobs": len(configlib.SPEC),
                          "changed": {k: {"default": d, "value": v} for k, (d, v) in changed.items()},
                          "problems": problems,
                          "rails": [{"name": n, "why": w} for n, w in configlib.RAILS]},
                         indent=2, default=str))
        return 2 if problems else 0

    print("ORCHESTRATOR POLICY")
    print(f"  file      {configlib.CONFIG_PATH}"
          + ("" if configlib.CONFIG_PATH.exists() else "   (does not exist yet - all defaults)"))
    print(f"  knobs     {len(configlib.SPEC)} across {len(configlib.GROUPS)} groups")
    if changed:
        print(f"  changed   {len(changed)} knob(s) are NOT at their default:")
        for key, (dflt, val) in sorted(changed.items()):
            row = configlib.BY_KEY[key]
            print(f"              {key:<42} {_fmt(row, val):<14} (default {_fmt(row, dflt)})")
    else:
        print("  changed   nothing - every knob is at its default, so the toolbox behaves")
        print("            exactly as it did before there was a policy file.")
    if problems:
        print("\n  ⚠ PROBLEMS IN THE FILE ON DISK (these values are being IGNORED):")
        for p in problems:
            print(f"      - {p}")
        print("  ⛔ Until these are fixed, NOTHING acts unattended - a lane running on a "
              "default could undo a switch you turned off.")

    print("\nWHAT IS DELIBERATELY NOT A KNOB (the rails - they are why unattended acting is")
    print("allowed at all; a switch for one of these is a switch for losing work):")
    for name, why in configlib.RAILS:
        print(f"  · {name} - {why}")

    print("\nPICK YOUR TOGGLES:")
    print("  python orch.py policy --wizard              a person, group by group")
    print("  python orch.py policy --ask                 the questionnaire, for an AI to answer")
    print("  python orch.py policy --preset conservative a starting point you then adjust")
    print("  python orch.py policy --list gate           every knob in one group, explained")
    return 2 if problems else 0


def show_list(group: str | None, as_json: bool) -> int:
    if group and group not in {g for g, _ in configlib.GROUPS}:
        print(f"unknown group {group!r}. Groups: "
              + ", ".join(g for g, _ in configlib.GROUPS), file=sys.stderr)
        return 3
    rows = configlib.rows(group)
    if as_json:
        print(json.dumps(rows, indent=2, default=str))
        return 0
    dflt = configlib.defaults()
    cur = None
    for row in rows:
        if row["group"] != cur:
            cur = row["group"]
            print(f"\n{_group_title(cur)}")
            print("-" * min(88, len(_group_title(cur))))
        mark = " " if row["value"] == dflt[row["key"]] else "*"
        print(f" {mark}{row['key']:<44} {_fmt(row):<16}")
        for line in _wrap(row["help"], 84):
            print(f"     {line}")
    print("\n  * = changed from the default")
    return 0


def show_explain(key: str, as_json: bool) -> int:
    row = configlib.BY_KEY.get(key)
    if not row:
        near = [k for k in configlib.BY_KEY if key.lower() in k.lower()]
        print(f"no knob called {key!r}." + (f" Did you mean: {', '.join(near[:6])}" if near else
              " Run `orch.py policy --list` for all of them."), file=sys.stderr)
        return 3
    live = configlib.get(key)
    if as_json:
        print(json.dumps({**row, "value": live}, indent=2, default=str))
        return 0
    print(f"{key}")
    print(f"  group      {_group_title(row['group'])}")
    print(f"  now        {_fmt({**row, 'value': live})}"
          + ("  (default)" if live == row["default"] else
             f"   ** CHANGED - the default is {_fmt(row, row['default'])} **"))
    print(f"  kind       {row['kind']}"
          + (f", one of {row['choices']}" if row.get("choices") else "")
          + (f", between {row.get('min')} and {row.get('max')}" if row.get("min") is not None else ""))
    print(f"  what it does")
    print(f"    {row['help']}")
    print(f"\n  change it: python orch.py policy --set {key}=<value>")
    return 0


def _parse_value(row: dict, raw: str):
    """A string off the command line, turned into the knob's own type. Deliberately generous
    about how a person spells a boolean (on/off/yes/no/true/false) - configlib validates."""
    if row["kind"] == "int_or_null" and raw.lower() in ("null", "none", "uncapped", ""):
        return None
    return raw


def do_set(pairs: list[str]) -> int:
    changes = {}
    for pair in pairs:
        if "=" not in pair:
            print(f"bad argument {pair!r} - use key=value", file=sys.stderr)
            return 3
        key, raw = pair.split("=", 1)
        key = key.strip()
        row = configlib.BY_KEY.get(key)
        if not row:
            print(f"no knob called {key!r} - `orch.py policy --list` shows them all", file=sys.stderr)
            return 3
        changes[key] = _parse_value(row, raw.strip())
    try:
        configlib.set_many(changes)
    except configlib.ConfigError as err:
        print(f"refused: {err}", file=sys.stderr)
        return 3
    configlib.load(force=True)
    for key in changes:
        row = configlib.BY_KEY[key]
        print(f"set {key} = {_fmt(row, configlib.get(key))}"
              + ("  (back at the default)" if configlib.get(key) == row["default"] else ""))
    print(f"\nwritten to {configlib.CONFIG_PATH}. Lanes pick it up on their next run "
          "(≤5 minutes for the scheduled ones).")
    return 0


def do_unset(keys: list[str]) -> int:
    try:
        gone = configlib.unset_many(keys)
    except configlib.ConfigError as err:
        print(f"refused: {err}", file=sys.stderr)
        return 3
    configlib.load(force=True)
    print(f"back to default: {', '.join(gone) if gone else 'nothing was overridden'}")
    return 0


def do_preset(name: str, yes: bool) -> int:
    overlay = configlib.PRESETS.get(name)
    if overlay is None:
        print(f"unknown preset {name!r}. Presets: {', '.join(configlib.PRESETS)}", file=sys.stderr)
        return 3
    print(f"PRESET '{name}' would set {len(overlay)} knob(s):")
    for key, val in sorted(overlay.items()):
        row = configlib.BY_KEY[key]
        print(f"  {key:<44} {_fmt(row, val):<14} (now {_fmt(row, configlib.get(key))})")
    if name == "default":
        print("  (and clear every other override)")
    if not yes:
        print("\nPLAN ONLY - nothing written. Add --yes to apply.")
        return 0
    try:
        configlib.write(dict(overlay)) if name == "default" else configlib.set_many(dict(overlay))
    except configlib.ConfigError as err:
        print(f"refused: {err}", file=sys.stderr)
        return 3
    configlib.load(force=True)
    print(f"\napplied. {configlib.CONFIG_PATH}")
    return 0


# ---------------------------------------------------------------------------------------
# THE QUESTIONNAIRE - the same ask/apply shape interview.py uses, so an AI can set policy
# without a terminal and without this script guessing what it wants.
# ---------------------------------------------------------------------------------------
def build_questions(group: str | None) -> list[dict]:
    out = []
    for row in configlib.rows(group):
        q = {
            "key": row["key"],
            "group": row["group"],
            "groupTitle": _group_title(row["group"]),
            "question": row["help"],
            "kind": row["kind"],
            "current": row["value"],
            "default": row["default"],
            "atDefault": row["value"] == row["default"],
            "answerFormat": ("true | false" if row["kind"] == "bool" else
                             " | ".join(row["choices"]) if row["kind"] == "enum" else
                             f"a whole number between {row.get('min')} and {row.get('max')}"
                             + (" , or null for uncapped" if row["kind"] == "int_or_null" else "")
                             if row.get("min") is not None else "a string"),
        }
        out.append(q)
    return out


def do_ask(group: str | None, as_json: bool) -> int:
    qs = build_questions(group)
    if as_json:
        print(json.dumps({
            "configPath": str(configlib.CONFIG_PATH),
            "howToAnswer": ('write {"answers":[{"key":"<key>","value":<value>}, ...]} and run '
                            '`orch.py policy --apply <file>`; omit a knob to leave it alone'),
            "rails": [{"name": n, "why": w} for n, w in configlib.RAILS],
            "questions": qs}, indent=2, default=str))
        return 0
    print("POLICY QUESTIONNAIRE - answer only the ones you want to change.\n"
          'Write {"answers":[{"key":"...","value":...}]} and run '
          "`orch.py policy --apply <file>`.\n")
    cur = None
    for q in qs:
        if q["group"] != cur:
            cur = q["group"]
            print(f"\n== {q['groupTitle']}")
        print(f"  {q['key']}  [now {q['current']}, default {q['default']}]  -> {q['answerFormat']}")
        print(f"     {q['question']}")
    return 0


def do_apply(path: str) -> int:
    p = Path(path)
    if not p.is_absolute():
        p = Path(__file__).resolve().parent.parent / path
    try:
        payload = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        print(f"could not read {p}: {err}", file=sys.stderr)
        return 3
    answers = payload.get("answers") if isinstance(payload, dict) else payload
    if not isinstance(answers, list):
        print('expected {"answers":[{"key":...,"value":...}, ...]}', file=sys.stderr)
        return 3
    changes = {}
    for a in answers:
        if not isinstance(a, dict):
            print(f"  ignored: {a!r} is not a {{key, value}} answer", file=sys.stderr)
            continue
        key = a.get("key")
        if key not in configlib.BY_KEY:
            print(f"  ignored: {key!r} is not a knob", file=sys.stderr)
            continue
        changes[key] = a.get("value")
    if not changes:
        print("no applicable answers - nothing written.")
        return 0
    before = {k: configlib.get(k) for k in changes}
    try:
        configlib.set_many(changes)
    except configlib.ConfigError as err:
        print(f"refused, NOTHING written: {err}", file=sys.stderr)
        return 3
    configlib.load(force=True)
    for key in sorted(changes):
        row = configlib.BY_KEY[key]
        now = configlib.get(key)
        print(f"  {key:<44} {_fmt(row, before[key])} -> {_fmt(row, now)}"
              + ("" if now != before[key] else "   (unchanged)"))
    print(f"\napplied {len(changes)} answer(s) to {configlib.CONFIG_PATH}.")
    return 0


# ---------------------------------------------------------------------------------------
# THE WIZARD - for a person at a terminal. Nothing is written until the end, and the diff is
# shown first: a policy pass that wrote as it went would leave a half-configured fleet if the
# person walked away in the middle.
# ---------------------------------------------------------------------------------------
def _ask_one(row: dict):
    """Returns the new value, or the sentinel KEEP when the person just pressed Enter."""
    label = _fmt(row)
    if row["kind"] == "bool":
        hint = "[Y/n]" if row["value"] else "[y/N]"
        raw = input(f"    {row['key']} is {label} {hint} ").strip().lower()
        if not raw:
            return KEEP
        if raw in ("y", "yes", "on", "true", "1"):
            return True
        if raw in ("n", "no", "off", "false", "0"):
            return False
        # Anything else is KEPT, never read as "no": a typed "yse" on one of the four archive
        # signals would otherwise have switched a guard off.
        print(f"    (did not understand {raw!r} - kept {label})")
        return KEEP
    if row["kind"] == "enum":
        raw = input(f"    {row['key']} is {label} ({'/'.join(row['choices'])}) ").strip()
        return raw or KEEP
    if row["kind"] in ("int", "secs", "pct", "int_or_null"):
        extra = ", or 'null' for uncapped" if row["kind"] == "int_or_null" else ""
        raw = input(f"    {row['key']} is {label} "
                    f"({row.get('min')}-{row.get('max')}{extra}) ").strip()
        if not raw:
            return KEEP
        return None if raw.lower() in ("null", "none", "uncapped") else raw
    raw = input(f"    {row['key']} is {label} (text) ").strip()
    return raw or KEEP


KEEP = object()


def do_wizard() -> int:
    if not sys.stdin.isatty():
        print("--wizard needs a real terminal (it asks questions and waits).\n"
              "From a script or an AI, use the same questions without a terminal:\n"
              "  python orch.py policy --ask > questions.json\n"
              "  python orch.py policy --apply answers.json", file=sys.stderr)
        return 3
    print("ORCHESTRATOR POLICY WIZARD")
    print("Enter keeps the current value. Nothing is written until you confirm at the end.")
    print("Ctrl-C at any point leaves your policy exactly as it is.\n")
    print("These are NOT questions, because they are never optional:")
    for name, why in configlib.RAILS:
        print(f"  · {name} - {why}")
    changes: dict = {}
    try:
        for group, title in configlib.GROUPS:
            rows = configlib.rows(group)
            if not rows:
                continue
            print(f"\n== {title}")
            raw = input(f"   configure these {len(rows)} knob(s)? [y/N/q] ").strip().lower()
            if raw in ("q", "quit"):
                break
            if raw not in ("y", "yes"):
                continue
            for row in rows:
                print(f"\n     {row['help']}")
                got = _ask_one(row)
                if got is not KEEP:
                    changes[row["key"]] = got
    except KeyboardInterrupt:
        print("\n\nstopped - nothing was written.")
        return 0
    except EOFError:
        # No one is there to answer. `isatty()` is not enough on Windows, where a piped or
        # tool-driven shell can still report a tty and then hand input() an immediate EOF -
        # so the useful pointer lives here too, not only behind the isatty check above.
        print("\n\nno answer came back - nothing was written. If you are running this from a "
              "script or an AI rather than a terminal, use the same questions without one:\n"
              "  python orch.py policy --ask > questions.json\n"
              "  python orch.py policy --apply answers.json")
        return 0
    if not changes:
        print("\nno changes - your policy is unchanged.")
        return 0
    print(f"\n{len(changes)} change(s):")
    try:
        clean, problems = configlib.validate(changes)
    except configlib.ConfigError as err:
        print(f"refused: {err}", file=sys.stderr)
        return 3
    for p in problems:
        print(f"  ⚠ {p}")
    for key, val in sorted(clean.items()):
        row = configlib.BY_KEY[key]
        print(f"  {key:<44} {_fmt(row, configlib.get(key))} -> {_fmt(row, val)}")
    try:
        confirmed = input("\nwrite this policy? [y/N] ").strip().lower() in ("y", "yes")
    except (KeyboardInterrupt, EOFError):
        confirmed = False
    if not confirmed:
        print("nothing written.")
        return 0
    try:
        configlib.set_many(clean)
    except configlib.ConfigError as err:
        print(f"refused, NOTHING written: {err}", file=sys.stderr)
        return 3
    configlib.load(force=True)
    print(f"written to {configlib.CONFIG_PATH}. The lanes read it on their next run.")
    return 0


def do_doctor(as_json: bool) -> int:
    problems = configlib.problems()
    try:
        raw = configlib.read_file()
    except configlib.ConfigError:
        raw = {}  # unreadable: already named in `problems`, which is this command's whole job
    payload = {"configPath": str(configlib.CONFIG_PATH), "exists": configlib.CONFIG_PATH.exists(),
               "overrides": len(raw), "problems": problems, "ok": not problems}
    if as_json:
        print(json.dumps(payload, indent=2, default=str))
    elif not configlib.CONFIG_PATH.exists():
        print("no policy file - running on defaults. That is a valid state, not a fault.")
    elif problems:
        print(f"{len(problems)} problem(s) - these values are IGNORED and the default is used:")
        for p in problems:
            print(f"  - {p}")
    else:
        print(f"OK - {len(raw)} override(s), every one valid.")
    return 2 if problems else 0


def _arg(argv: list[str], flag: str) -> str | None:
    return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else None


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    group = _arg(argv, "--group")

    if "--wizard" in argv:
        return do_wizard()
    if "--ask" in argv:
        return do_ask(group, as_json)
    if "--apply" in argv:
        target = _arg(argv, "--apply")
        return do_apply(target) if target else (print("--apply needs a file", file=sys.stderr) or 3)
    if "--doctor" in argv:
        return do_doctor(as_json)
    if "--preset" in argv:
        name = _arg(argv, "--preset")
        return do_preset(name, "--yes" in argv) if name else (
            print(f"--preset needs a name: {', '.join(configlib.PRESETS)}", file=sys.stderr) or 3)
    if "--unset" in argv:
        keys = [a for a in argv[argv.index("--unset") + 1:] if not a.startswith("--")]
        return do_unset(keys) if keys else (print("--unset needs a key", file=sys.stderr) or 3)
    if "--set" in argv:
        pairs = [a for a in argv[argv.index("--set") + 1:] if not a.startswith("--")]
        return do_set(pairs) if pairs else (print("--set needs key=value", file=sys.stderr) or 3)
    if "--list" in argv:
        after = [a for a in argv[argv.index("--list") + 1:] if not a.startswith("--")]
        return show_list(after[0] if after else group, as_json)
    if "--explain" in argv:
        key = _arg(argv, "--explain")
        return show_explain(key, as_json) if key else (
            print("--explain needs a key", file=sys.stderr) or 3)
    return show_status(as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
