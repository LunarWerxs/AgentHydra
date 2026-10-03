"""The worker shell policy: every command a bash line would run, checked against prefix rules before it runs.

WHY: a worker's shell runs in the caller's working tree, and a worker that is refused and retries is exactly the
one that finds a wrapper around a one-regex gate. So the line is split into the commands it really runs
(shellparse), each is canonicalized (shellcanon), and each is matched against declarative prefix rules:
hswarm/shell_rules.toml, then ~/.hswarm/shell_rules.toml on top. A rule carries its own match / not_match
examples and they are run when the file loads, so a broken rule fails loudly instead of silently passing
everything. The longest matching prefix decides (ties go to forbidden), a forbidden rule's justification says
what to do instead, and a run-time word ($VAR, $(...)) where a forbidden rule looks counts as a match.
A task can hold prefix grants (`shell_grants: ["git add"]`) that lift non-hard rules for that command
prefix; nothing lifts a hard rule or the fixed rm -r deny below.
"""
from __future__ import annotations

import os
import posixpath
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from . import config
from .shellcanon import expand, program
from .shellparse import Command, split

RULES_FILE = Path(__file__).with_name("shell_rules.toml")
DECISIONS = ("allow", "forbidden")
_RM_JUSTIFICATION = ("rm -r of /, a drive root, ~, $HOME, ., .., * or a path that is only a variable deletes a whole tree (the "
                     "caller's checkout, the home folder, the disk); delete the paths your task created, by name. "
                     "No grant or setting lifts this.")


@dataclass(frozen=True)
class Rule:
    pattern: tuple[frozenset[str], ...]
    decision: str
    justification: str = ""
    unless_env: str = ""  # the rule is off while this environment variable is "1"
    hard: bool = False  # no task grant lifts it
    source: str = ""

    def matches(self, cmd: Command) -> str:
        """'yes', 'no', or 'maybe' when only a run-time word ($VAR, $(...)) stands between the command and the rule.

        A run-time word may expand to several words (`C='git stash'; $C`), so a command that ends before the pattern
        does is still a 'maybe' once a run-time word has been reached: it is refused, not guessed."""
        verdict = "yes"
        for i, allowed in enumerate(self.pattern):
            if i >= len(cmd.argv):
                return verdict if verdict == "maybe" else "no"
            if cmd.dynamic[i]:
                verdict = "maybe"
            elif cmd.argv[i] not in allowed:
                return "no"
        return verdict


def overlay_file() -> Path:
    return config.HOME / "shell_rules.toml"


def load_rules(path: Path) -> list[Rule]:
    """One rules file, its every example checked; ValueError naming the rule when an example disagrees with it."""
    rules = []
    for n, raw in enumerate(tomllib.loads(path.read_text(encoding="utf-8")).get("rule", []), 1):
        where = f"{path} rule {n}"
        pattern = tuple(frozenset([p] if isinstance(p, str) else p) for p in raw.get("pattern", []))
        if not pattern or raw.get("decision") not in DECISIONS:
            raise ValueError(f"{where}: needs a non-empty pattern and decision {' | '.join(DECISIONS)}")
        if raw["decision"] == "forbidden" and not raw.get("justification"):
            raise ValueError(f"{where}: a forbidden rule must say what to do instead (justification)")
        rule = Rule(pattern, raw["decision"], raw.get("justification", ""), raw.get("unless_env", ""), bool(raw.get("hard")), where)
        for example, want in [(e, True) for e in raw.get("match", [])] + [(e, False) for e in raw.get("not_match", [])]:
            if any(rule.matches(c) == "yes" for c in expand(example)) != want:
                raise ValueError(f"{where}: example {example!r} should {'' if want else 'not '}match it")
        rules.append(rule)
    return rules


_cache: dict[tuple, list[Rule]] = {}


def rules() -> list[Rule]:
    """The shipped rules plus this machine's overlay, reloaded when either file changes."""
    paths = [p for p in (RULES_FILE, overlay_file()) if p.exists()]
    key = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in paths)
    if key not in _cache:
        _cache.clear()
        _cache[key] = [rule for p in paths for rule in load_rules(p)]
    return _cache[key]


def status() -> str:
    """One doctor line: how many rules are live, from where, or why every bash call is being refused."""
    try:
        count = len(rules())
    except ValueError as e:
        return f"BROKEN, every bash call is refused until it is fixed: {e}"
    overlay = overlay_file()
    return f"{count} rules ({RULES_FILE.name}{' + ' + str(overlay) if overlay.exists() else ''})"


def parse_grant(text: str) -> list[str]:
    """A grant is a plain command prefix (`git add`, `git commit -m`): its words, or ValueError for one that may not be granted."""
    cmds = split(str(text or ""))
    if len(cmds) != 1 or any(cmds[0].dynamic):
        raise ValueError(f"shell grant {text!r} must be one plain command prefix, with no $VAR, $(...), ; or |")
    words = cmds[0].argv
    if "/" in words[0] or "\\" in words[0]:
        raise ValueError(f"shell grant {text!r}: a ./ or absolute-path program cannot be granted by prefix, its bytes can change under the grant")
    return [program(words[0])] + words[1:]


def refusal(line: str, grants: list[list[str]] | None = None, active: list[Rule] | None = None) -> str | None:
    """The refusal text for a bash line the policy forbids, or None when every command in it may run."""
    try:
        commands = expand(line or "")
        active = rules() if active is None else active
    except ValueError as e:
        return f"ERROR: refused - {e}"
    active = [r for r in active if not (r.unless_env and os.environ.get(r.unless_env) == "1")]
    for cmd in commands:
        why = _rm_whole_tree(cmd) or _secrets_access(cmd) or _decide(cmd, active, grants or [])
        if why:
            return why
    return None


def _decide(cmd: Command, active: list[Rule], grants: list[list[str]]) -> str | None:
    hits = [(r, m) for r in active if (m := r.matches(cmd)) != "no" and (m == "yes" or r.decision == "forbidden")]
    hard = next(((r, m) for r, m in hits if r.hard and r.decision == "forbidden"), None)
    if hard:
        return _refuse(cmd, *hard)
    if not hits or any(_granted(cmd, g) for g in grants):
        return None
    longest = max(len(r.pattern) for r, _ in hits)
    forbidden = next(((r, m) for r, m in hits if len(r.pattern) == longest and r.decision == "forbidden"), None)
    return _refuse(cmd, *forbidden) if forbidden else None


def _granted(cmd: Command, words: list[str]) -> bool:
    return (not cmd.path_program and len(cmd.argv) >= len(words)
            and all(not d and a == w for a, d, w in zip(cmd.argv, cmd.dynamic, words)))


def _refuse(cmd: Command, rule: Rule, how: str) -> str:
    unknown = (" (part of it is only known at run time - $VAR, $(...) or backticks - so it cannot be checked; spell it out)"
               if how == "maybe" else "")
    return f"ERROR: refused `{' '.join(cmd.argv[:len(rule.pattern)])}` - {rule.justification}{unknown}"


def _rm_whole_tree(cmd: Command) -> str | None:
    """The fixed deny: `rm -r` of a whole tree. Checked on the normalized path, so `/usr/..` and `./` count too."""
    if cmd.argv[0] != "rm" or cmd.dynamic[0]:
        return None
    args = list(zip(cmd.argv[1:], cmd.dynamic[1:]))
    cut = next((i for i, (a, _) in enumerate(args) if a == "--"), len(args))
    flags = [a for a, _ in args[:cut] if a.startswith("-")]
    targets = [(a, d) for a, d in args[:cut] if not a.startswith("-")] + args[cut + 1:]
    if not any(f == "--recursive" or (not f.startswith("--") and ("r" in f or "R" in f)) for f in flags):
        return None
    for target, dynamic in targets:
        if _whole_tree(target, dynamic):
            return f"ERROR: refused `rm -r {target}` - {_RM_JUSTIFICATION}"
    return None


# A worker in a checkout could read and send the live keys (idea from CopilotKit/OpenBot .github/workflows/ci.yml:556-570
# and CopilotKit/OpenTag agent/coding/sandbox.py:114, MIT, 2026-10-03). Prefix rules cannot match an argument anywhere in
# the line, so this is a function check, hard like the rm -r deny: no grant lifts it. A spelling the words cannot see
# (`cat .secr*/*`) is caught by redaction.scrub_keys on the output instead.
_KEY_FILES_JUSTIFICATION = ("key files are never readable by a worker: a path under .secrets, a *_api_keys or *_api_key file, "
                            "~/.hswarm/secrets and ~/.hswarm/providers hold live provider keys. No grant or setting lifts this.")
_KEY_FILE_WORD = re.compile(r"_api_keys?(?:\.[^/]*)?$")


def _secrets_access(cmd: Command) -> str | None:
    for word in cmd.argv:
        path = word.replace("\\", "/").casefold()
        parts = [p for p in path.split("/") if p]
        if (".secrets" in parts or any(_KEY_FILE_WORD.search(p) for p in parts)
                or ".hswarm/providers" in path or ".hswarm/secrets" in path):
            return f"ERROR: refused `{word}` - {_KEY_FILES_JUSTIFICATION}"
    return None


def _whole_tree(target: str, dynamic: bool) -> bool:
    p = target.replace("\\", "/")
    if dynamic:  # $HOME is a whole tree; any other bare variable is `/` the day it is empty
        p = re.sub(r"^\$(\{HOME\}|HOME\b)", "~", p)
        p = re.sub(r"^\$(\{\w+\}|\w+|\(.*\))", "", p)
    rooted = p.startswith("/")
    p = re.sub(r"(/+\*?|/+\.)+$", "", p)  # `x/`, `x/*` and `x/.` all mean x's whole tree
    norm = posixpath.normpath(p) if p else ("/" if rooted else "")
    # `C:` and Git Bash's `/c` are a whole Windows drive
    return norm in ("", "/", "//", ".", "~", "*") or bool(re.fullmatch(r"[A-Za-z]:|/[A-Za-z]|\.\.(/\.\.)*|~/\.\.(/\.\.)*", norm))
