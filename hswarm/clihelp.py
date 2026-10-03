"""`hswarm help` and `hswarm skill`: the CLI describes itself, so an agent discovers it instead of reading prose.

WHY: agents learned these verbs from the README, and prose drifts from the parser. Everything here is
generated from the very argparse tree `hswarm` parses with, so the sitemap cannot fall behind a new flag,
and every command carries an effect bit (read | write | spend | destructive) that gives an agent a
confirmation gate before anything that changes state, costs money or deletes. `hswarm skill --install`
writes a SKILL.md that tells agents to use this instead of guessing, stamped with a hash of the help so a
stale copy shows. The idea follows difyctl's `help -o json` and `skills install` (langgenius/dify cli/);
written fresh for hswarm, no code copied.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

READ, WRITE, SPEND, DESTRUCTIVE = "read", "write", "spend", "destructive"
EFFECTS = (READ, WRITE, SPEND, DESTRUCTIVE)
EFFECT_MEANING = {
    READ: "no side effect beyond caches and logs: run freely",
    WRITE: "changes local state, config or the shared sync branch: confirm the intent first",
    SPEND: "calls a paid model API and costs money: confirm the budget first",
    DESTRUCTIVE: "can delete data: dry run first, confirm before the flag that applies it",
}

# The effect of a command is its WORST form (e.g. `jobs` reads, but `jobs --prune-days N --apply` deletes);
# the guide says which flags cross the line. Every registered command must appear here (tests/test_clihelp.py).
META: dict[str, dict] = {
    "help": {"effect": READ, "guide": "This sitemap. `help <command> --json` gives one command's args, flags, effect and guide."},
    "skill": {"effect": WRITE, "guide": "Prints the agent SKILL.md; only --install writes it. --check exits 1 when the installed copy is missing or stale.",
              "examples": ["hswarm skill --check", "hswarm skill --install"]},
    "import-keys": {"effect": WRITE, "guide": "Copies key files from a ZSwarm clone's .secrets into HSWARM_HOME/secrets; prints only counts, never a key or prefix.",
                    "examples": ["hswarm import-keys --from <clone>"]},
    "doctor": {"effect": READ, "guide": "Free GETs only (balance, /models); prints key fingerprints, never key values. Run it first when anything fails."},
    "keys": {"effect": WRITE, "guide": "`keys` (list) is offline and read-only; `probe` makes one free GET per key and may return a topped-up key to the pool; "
             "`enable` / `disable` edit the disabled slot. Pass the 8-character fingerprint, never a key.",
             "examples": ["hswarm keys --json", "hswarm keys probe --provider deepseek"]},
    "vault": {"effect": WRITE, "guide": "The shared key vault: HSWARM_HOME/secrets lists, encrypted, in step with the other paired machines. `status`, `list` and `sync --dry-run` only read; "
              "`sync`, `add`, `remove`, `init`, `join` and `adopt` change secrets/ and the vault. `adopt` copies this machine's paired ZSwarm vault setup into HSWARM_HOME. "
              "`pair` prints the vault key's pairing code and refuses unless stdout is a terminal: never run it for a chat, the person runs it in their own terminal. "
              "Sealed pairing hands the code over through the backend instead: `request <backend>` on the new machine prints a fingerprint, "
              "`grant [machine]` on a vault machine seals the code to it once a person confirms that fingerprint (typed at a terminal, or `--yes <full fingerprint>`), "
              "`accept` on the new machine opens it and joins (exit 3: not granted yet); none of them prints the code. "
              "Keys come from stdin or a hidden prompt, never argv; every output is counts and 8-character fingerprints.",
              "examples": ["hswarm vault status", "hswarm vault sync --dry-run", "hswarm vault list openrouter"]},
    "models": {"effect": WRITE, "guide": "Listing is read-only; --refresh rewrites ~/.hswarm/openrouter-models.json from the provider's catalogue.",
               "examples": ["hswarm models --grep glm --json", "hswarm models --routes"]},
    "ask": {"effect": SPEND, "guide": "One paid, tool-free model call. Prefer the hswarm_ask MCP tool inside a Claude session; --json returns data.",
            "examples": ["hswarm ask \"Classify this: ...\" --json", "hswarm ask \"...\" --role search"]},
    "run": {"effect": SPEND, "guide": "Runs a whole tasks file of paid workers. Set --budget (USD ceiling) and check the task count before running; --check validates the file and the route without sending anything.",
            "examples": ["hswarm run tasks.json --backend api --budget 0.50 --out results.json"]},
    "status": {"effect": READ, "guide": "A job's summary from disk; no model call."},
    "cancel": {"effect": WRITE, "guide": "Stops a job: asks the process running it (it stops within ~10 s), or marks one nothing runs any more; spend already made stays spent."},
    "results": {"effect": READ, "guide": "A job's answers from disk; --id narrows to tasks."},
    "jobs": {"effect": DESTRUCTIVE, "guide": "Listing is read-only. --prune-days, --compact and --archive-hours are dry runs until --apply; "
             "--prune-days N --apply deletes job folders (the ledger keeps every number).",
             "examples": ["hswarm jobs --limit 5", "hswarm jobs --prune-days 30"]},
    "maintain": {"effect": DESTRUCTIVE, "guide": "The scheduled daily pass: archives job folders, packs jobs past a week, spill files past a day and cc transcripts past "
                 "two days into the history (one xz archive a day, never deleted; --keep-days N deletes jobs past N days), records savings, "
                 "syncs and pushes the sync branch. --no-push keeps it local."},
    "cost": {"effect": READ, "guide": "Ledger totals plus one free balance GET; --no-balance stays offline."},
    "savings": {"effect": WRITE, "guide": "Every run rewrites ~/.hswarm/hswarm.html; --record, --backfill-jobs, --remeasure and --profile write the utilization DB; "
                "--sync also pushes. --list N is the lightest read."},
    "sync": {"effect": WRITE, "guide": "Pushes this machine's shard to the repo's sync branch; --no-push stays local. --restore rebuilds a lost ledger."},
    "usage": {"effect": READ, "guide": "Who used the swarm and which Claude fan-outs the routing gate saw; --json returns data."},
    "bench": {"effect": SPEND, "guide": "Runs paid benchmark arms. Check `hswarm benchdb has` first: a measured arm is not re-spent unless --fresh."},
    "install": {"effect": WRITE, "guide": "Registers hswarm with Claude Code (~/.claude.json), Claude Desktop and/or Codex (--client); --instructions also edits the global CLAUDE.md / AGENTS.md. A one-time human setup step."},
    "setup": {"effect": WRITE, "guide": "The first run: registers hswarm with every assistant found (Claude Code, Claude Desktop, Codex; --client picks), then opens the console. What the installers run. For a human."},
    "ui": {"effect": WRITE, "guide": "Starts the shared server if needed and opens the web console in a browser (--no-open prints the address). For a human."},
    "mcp": {"effect": WRITE, "guide": "Long-running server that blocks the terminal; Claude Code launches it. An agent should not start it."},
    "serve-ensure": {"effect": WRITE, "guide": "May start the shared HTTP MCP server as a hidden process; returns JSON {ok}."},
    "distill": {"effect": SPEND, "guide": "Dry run by default; --live sends redacted transcript text to a paid model and writes staging files. Own parser: `hswarm distill --help`."},
    "triage": {"effect": SPEND, "guide": "Paid judge calls, and by default MOVES staged files into verdict folders (--no-apply reports only). Own parser: `hswarm triage --help`."},
    "indexdiet": {"effect": SPEND, "guide": "Paid recall test; --apply rewrites the index (a dated backup is kept). Own parser: `hswarm indexdiet --help`."},
    "native": {"effect": WRITE, "guide": "`native build` compiles the scanners; `native bench` writes native/winner.json. Own parser."},
    "benchdb": {"effect": WRITE, "guide": "`board` and `has` read; `import-out` appends to the committed bench/results/. Own parser: `hswarm benchdb --help`."},
    "connect": {"effect": WRITE, "guide": "Wires this machine to a provider account; read its --help before running."},
    "web": {"effect": WRITE, "guide": "--allow / --block / --forget edit the saved host lists read_url obeys; with no flag it only prints the policy."},
    "prefix": {"effect": READ, "guide": "Spawns one cc worker against a loopback sink: no provider call, no spend. --operator measures this machine's own Claude Code setup."},
    "egress": {"effect": READ, "guide": "verify / tail / find read ~/.hswarm/egress-*.jsonl; no receipt holds a payload."},
    "history": {"effect": WRITE, "guide": "The table of every finished task (history/tasks.sqlite): how each shape and model ended and what it "
                "cost over --days; --index adds the jobs not yet in it (maintain does daily). No model call.",
                "examples": ["hswarm history --days 7", "hswarm history --index"]},
    "survival": {"effect": READ, "guide": "Scores due edit checkpoints from files on disk and prints the per-model survival; no model call."},
    "panel": {"effect": SPEND, "guide": "Two paid rounds across 2-5 models; prefer the hswarm_panel MCP tool inside a Claude session."},
    "filters": {"effect": READ, "guide": "Lists the bash output filters in effect and runs their inline tests; exits 1 on a rejected filter."},
    "comply": {"effect": SPEND, "guide": "Runs cc workers on seeded scenario folders plus tool-free labelling calls; --spec re-runs saved scenarios."},
    "skillbench": {"effect": SPEND, "guide": "Prints the plan only; --run spends on workers and the grader role."},
    "review": {"effect": SPEND, "guide": "Fans a reviewer roster out over one diff; --dry-run prints the roster without a model call."},
    "loop": {"effect": SPEND, "guide": "Starts a frontier loop that sends workers each round until the probe passes or a cap stops it."},
    "optimize": {"effect": SPEND, "guide": "One worker per attempt in its own worktree and branch; commits only what improves the metric."},
    "procedures": {"effect": READ, "guide": "Mines transcripts offline; --apply stages trust: unreviewed candidate files, never overwriting one."},
    "replay": {"effect": SPEND, "guide": "Replays a recorded MCP session against a fresh server; provider-reaching calls are skipped unless --allow-spend."},
    "scripted": {"effect": READ, "guide": "check replays each scripted-diff commit in a throwaway worktree; the caller's index is never touched."},
}

SKILL_NAME = "hswarm-cli"
SKILL_PATH = Path.home() / ".claude" / "skills" / SKILL_NAME / "SKILL.md"
STAMP_MARK = "hswarm-cli-stamp:"


def _subparsers(parser: argparse.ArgumentParser) -> argparse._SubParsersAction:
    return next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))


def _jsonable(v):
    return v if v is None or isinstance(v, (str, int, float, bool, list)) else str(v)


def _describe(name: str, sp: argparse.ArgumentParser, summary: str) -> dict:
    meta = META.get(name, {})
    args, flags = [], []
    for act in sp._actions:
        if isinstance(act, argparse._HelpAction):
            continue
        entry = {"help": act.help or ""}
        if act.choices:
            entry["choices"] = list(act.choices)
        if act.option_strings:
            takes_value = act.nargs != 0
            entry = {"flags": list(act.option_strings), "takes_value": takes_value, **entry}
            if takes_value and act.default not in (None, argparse.SUPPRESS):
                entry["default"] = _jsonable(act.default)
            if act.required:
                entry["required"] = True
            flags.append(entry)
        else:
            args.append({"name": act.dest, "required": act.nargs not in ("?", "*"), **entry})
    out = {"command": name, "description": summary, "effect": meta.get("effect", "unknown"),
           "args": args, "flags": flags, "examples": meta.get("examples", []), "agent_guide": meta.get("guide", "")}
    if name in _pipeline():
        out["own_parser"] = f"hswarm {name} --help"
    return out


def _pipeline() -> set[str]:
    from .cli import PIPELINE

    return PIPELINE


def sitemap(parser: argparse.ArgumentParser, compact: bool = True) -> list[dict]:
    """Every registered command in parser order: {command, description, effect}, or the full entry."""
    sub = _subparsers(parser)
    summaries = {a.dest: a.help or "" for a in sub._choices_actions}
    out = []
    for name, sp in sub.choices.items():
        full = _describe(name, sp, summaries.get(name, ""))
        out.append({k: full[k] for k in ("command", "description", "effect")} if compact else full)
    return out


def stamp(parser: argparse.ArgumentParser) -> str:
    """A hash of the full help: it changes exactly when a command, flag, effect or guide does."""
    blob = json.dumps(sitemap(parser, compact=False), sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:12]


def skill_text(parser: argparse.ArgumentParser) -> str:
    lines = [
        "---",
        f"name: {SKILL_NAME}",
        "description: Use before running any `hswarm` / `python -m hswarm` CLI command. Discover commands and flags "
        "from the CLI's own JSON help and honour each command's effect instead of guessing from docs.",
        "---",
        f"<!-- {STAMP_MARK} {stamp(parser)} (regenerate: `hswarm skill --install`; check: `hswarm skill --check`) -->",
        "",
        "# hswarm CLI",
        "",
        "Never guess a hswarm command or flag from memory or prose. Ask the CLI:",
        "",
        "- `python -m hswarm help --json --compact` - every command with its description and effect.",
        "- `python -m hswarm help <command> --json` - its args, flags, defaults, examples, effect and agent_guide.",
        "",
        "Every command has an `effect`. Before running one, act on it:",
        "",
    ]
    lines += [f"- `{e}`: {EFFECT_MEANING[e]}." for e in EFFECTS]
    lines += [
        "",
        "The effect is the command's worst form; its agent_guide names the flags that cross into it "
        "(many write or delete only with --apply, --live or --install). Inside a Claude session, prefer the "
        "hswarm_* MCP tools for asks and runs; the CLI is for scripts, maintenance and inspection.",
        "",
        "Commands at the time this skill was written:",
        "",
    ]
    lines += [f"- `{c['command']}` ({c['effect']}): {c['description']}" for c in sitemap(parser)]
    return "\n".join(lines) + "\n"


def _installed_stamp(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if STAMP_MARK in line:
            return line.split(STAMP_MARK, 1)[1].split()[0]
    return None


def cmd_help(a, parser: argparse.ArgumentParser) -> int:
    sub = _subparsers(parser)
    if a.command:
        if a.command not in sub.choices:
            msg = f"unknown command {a.command!r}; `hswarm help` lists them"
            print(json.dumps({"error": msg}) if a.json else msg, file=sys.stderr)
            return 2
        summaries = {x.dest: x.help or "" for x in sub._choices_actions}
        entry = _describe(a.command, sub.choices[a.command], summaries.get(a.command, ""))
        if a.json:
            print(json.dumps(entry, indent=None if a.compact else 2))
            return 0
        if "own_parser" not in entry:
            print(sub.choices[a.command].format_help().rstrip())
        else:
            print(f"hswarm {a.command}: {entry['description']}\nfull flags: {entry['own_parser']}")
        print(f"\neffect: {entry['effect']} - {EFFECT_MEANING.get(entry['effect'], 'unclassified')}")
        if entry["agent_guide"]:
            print(f"guide: {entry['agent_guide']}")
        for ex in entry["examples"]:
            print(f"  e.g. {ex}")
        return 0
    rows = sitemap(parser, compact=a.compact or not a.json)
    if a.json:
        print(json.dumps({"stamp": stamp(parser), "effects": EFFECT_MEANING, "commands": rows}, indent=None if a.compact else 2))
        return 0
    width = max(len(r["command"]) for r in rows)
    for r in rows:
        print(f"{r['command']:<{width}}  {r['effect']:<11}  {r['description']}")
    print("\n`hswarm help <command>` for one command; add --json for data.")
    return 0


def cmd_skill(a, parser: argparse.ArgumentParser) -> int:
    path = Path(a.path) if a.path else SKILL_PATH
    if a.check:
        have, want = _installed_stamp(path), stamp(parser)
        state = "missing" if have is None else ("current" if have == want else "stale")
        print(json.dumps({"path": str(path), "state": state, "installed": have, "current": want}))
        return 0 if state == "current" else 1
    text = skill_text(parser)
    if not a.install:
        sys.stdout.write(text)
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path} ({STAMP_MARK} {stamp(parser)})")
    return 0
