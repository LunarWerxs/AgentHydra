#!/usr/bin/env python3
"""name_chats.py - ACT: THE NAMING PASS - give every no-name chat in an instance a real name.

The naming law (owner, standing): no chat sits in his sidebar with a generic name. Fresh
imports land NAMELESS (meta title null) and render as 'General coding session' / 'Untitled';
N of them are indistinguishable on screen, so the stock renamer refuses. This pass names them
LIVE, no restart, via the probe technique proven 11/11 on 2026-08-31:

  1. actuator/rename_first.ps1 renames the FIRST reachable no-name row to a unique PROBE name
     (safe precisely because the rows are indistinguishable - we don't care which one it hits),
  2. the running app re-saves that chat's meta within seconds, revealing WHICH cliSessionId
     took the probe,
  3. the daemon's own rename endpoint then sets that chat's REAL name (the probe name is
     unique on screen, so the stock actuator is unambiguous),
  4. repeat until no no-name row is reachable.

WHERE REAL NAMES COME FROM (division of labor): the intended-title map - the caller's word
(sweep passes each landed chat's session title) or the daemon's sessions table. A chat whose
only known title is itself generic gets a quarantine name ('Recovered chat <id> (needs a
name)') and is reported under needsJudgment: writing a GOOD name from content is the AI's
job, and this script never invents one.

Usage: python name_chats.py <instance> [--json]        # names every reachable no-name chat
Exit:  0 nothing nameless, or every reachable one named - 2 some rows unreachable/flaked or
       left with quarantine names - 1 daemon/actuator failure.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from lib import clilib, hydralib, windowlib

PS1 = Path(__file__).resolve().parent / "actuator" / "rename_first.ps1"
# The same actuator rename_chat.py drives, used here ONLY for its passive -List (what the app
# is rendering right now). See rendered_titles().
LIST_PS1 = Path(__file__).resolve().parent / "actuator" / "manage_desktop_chat.ps1"
MAX_PASSES = 20
PROBE_PREFIX = "naming pass probe"

# ONE DRIVER PER WINDOW, and it is windowlib's lock, not a private one. This module used to
# keep its own `naming-<instance>.lock`, which excluded a second NAMING PASS and nothing else:
# the courier's composer send, archive_chat's sidebar control, migrate_chat's settle and
# spawn_chat's deeplink all take windowlib.instance_lock, so a naming pass could drive the same
# Electron window at the same time as any of them - the exact interleaved sidebar click both
# locks exist to prevent, missed because there were two of them. The private copy also carried
# the two defects windowlib's has since had fixed (AH-16): it reclaimed on AGE alone, so a
# legitimately long pass was stolen from mid-probe, and it unlinked its lock file
# unconditionally on exit, deleting whatever successor had replaced it.
#
# wait_secs=0 keeps this lane's posture unchanged: a naming pass never queues behind another
# driver, it steps back and says so, and the scheduler brings it round again.

# The naming law's deny-list, mirroring the daemon's chat-title.ts patterns plus this
# toolbox's own probe/quarantine names. A None/empty title is generic by definition.
_GENERIC = re.compile(
    r"^(untitled|general coding session|new (chat|session)|\[plumbing\].*"
    r"|landing fix probe.*|naming pass probe.*|recovered chat .*)$",
    re.IGNORECASE,
)
# What the probe LOOP goes after: the app-made no-names. Quarantine names stay OUT - they are
# generic by law (so a later, better-informed pass can still rename them via extra_titles),
# but re-probing one this pass would loop forever re-quarantining the same chat.
_PROBE_TARGETS = re.compile(
    r"^(untitled|general coding session|new (chat|session)"
    r"|landing fix probe.*|naming pass probe.*)$",
    re.IGNORECASE,
)


def is_generic_title(title: object) -> bool:
    t = str(title or "").strip()
    return not t or bool(_GENERIC.match(t))


def needs_a_real_name(title: object) -> bool:
    """Is this stored title absent or one of the app's generic fallbacks? A row wearing one of
    those cannot be aimed at by name: several land identical, and every actuator that takes a
    -Title then refuses to guess. Public because callers OUTSIDE the pass need the same test to
    verify their own landings (migrate_batch reads it back per chat rather than trusting any
    pass's self-report)."""
    t = str(title or "").strip()
    return not t or bool(_PROBE_TARGETS.match(t))


# The pass's own long-standing internal name for it.
_needs_probe = needs_a_real_name


def store_dir_for(instance: str) -> Path | None:
    for i in hydralib.fleet().get("instances", []):
        if str(i.get("name", "")).lower() == instance.lower():
            d = i.get("dir")
            return Path(str(d)) / "claude-code-sessions" if d else None
    return None


def scan_metas(store: Path, cache: dict | None = None) -> list[dict]:
    """Every meta record in the store, parsed - THROUGH an mtime-keyed cache when the caller
    passes one. The pass polls the store every second waiting for the app to re-save ONE
    file, and used to re-read and re-parse every meta on every tick (~K*21*M parses per pass;
    efficiency pass, 2026-08-31). The cache lives for one name_pass() call only, in memory -
    an mtime that has not advanced is the same bytes; a file that changed is always re-read."""
    out = []
    for p in store.glob("*/*/local_*.json"):
        try:
            st = p.stat()
        except OSError:
            continue
        # (mtime_ns, size) - mtime alone let two writes inside one filesystem timestamp
        # tick serve STALE bytes (probe-then-real-title back to back; caught by the suite's
        # own order-flake, 2026-09-01). Same-instant AND same-length is the residual hole,
        # and a title change virtually never preserves byte length.
        key = (st.st_mtime_ns, st.st_size)
        hit = cache.get(p) if cache is not None else None
        if hit is not None and hit[0] == key:
            meta = hit[1]
        else:
            try:
                meta = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue  # mid-write or corrupt: skip WITHOUT caching, so it is re-tried
            if cache is not None:
                cache[p] = (key, meta)
        out.append(meta)
    return out


def nameless_rows(store: Path, cache: dict | None = None) -> list[dict]:
    out = []
    for meta in scan_metas(store, cache):
        if meta.get("isArchived"):
            continue
        if _needs_probe(meta.get("title")):
            out.append({"sid": str(meta.get("cliSessionId") or ""), "title": meta.get("title")})
    return out


def sid_holding_title(store: Path, title: str, cache: dict | None = None) -> str | None:
    for meta in scan_metas(store, cache):
        if meta.get("title") == title:
            return str(meta.get("cliSessionId") or "")
    return None


def intended_titles(extra: dict[str, str] | None = None) -> dict[str, str]:
    """sid -> real title. The caller's word (extra) wins; the sessions table fills the rest -
    but only with titles that pass the naming law themselves."""
    out: dict[str, str] = {}
    for row in hydralib.sessions():
        sid = str(row.get("session_id") or "")
        title = str(row.get("title") or "")
        if sid and not is_generic_title(title):
            out[sid] = title
    for k, v in (extra or {}).items():
        if not is_generic_title(v):
            out[k] = v
    return out


def _run_probe(instance: str, probe: str) -> tuple[int, str]:
    from lib import windowlib

    # The probe drives the app's sidebar; put the window back if that moved it (the naming
    # pass had its own lock and no placement courtesy - owner, 2026-09-01: "something full
    # screened one of the accounts again").
    with windowlib.keep_placement(instance):
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(PS1),
             "-Instance", instance, "-NewTitle", probe],
            timeout=240,
        )
    return r.returncode, (r.stdout or "").strip()


def _daemon_rename(sid: str, title: str) -> tuple[int, str]:
    import rename_chat

    from lib import clilib

    return clilib.capture(rename_chat.main, [sid, "--to", title])


def _run_list(instance: str) -> tuple[int, str]:
    """The actuator's passive -List: every chat name the app is RENDERING. It activates
    nothing and takes no lock of its own (the actuator exempts -List from focus), so it is
    safe to call from inside this pass's lock and from a caller's verdict alike."""
    r = clilib.run_text(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(LIST_PS1),
         "-List", "-Instance", instance],
        timeout=120,
    )
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def rendered_titles(instance: str, list_runner=None) -> list[str] | None:
    """What the app SHOWS right now, or None when the read itself failed / nothing rendered.

    ⛔ DISK IS NOT THE SURFACE THAT MATTERS, AND FOR A FRESH IMPORT IT ACTIVELY LIES (found
    2026-09-15, after a 4-chat move reported 4/4 OK and left 3 chats nameless on screen).
    The importer WRITES a title into the landed record and the daemon answers
    `titled: true, titleDurable: false` - honest, because a RUNNING app re-saves that record
    from its own memory minutes later and erases it. Everything in this pass that asked "is
    anything nameless?" read the disk copy inside that window, saw real titles, and did
    nothing; the app was rendering three identical no-name rows the whole time, so the
    permission picker then had nothing to aim at and the bypass stamp fell back to disk-only.
    A caller that KNOWS what it just landed (migrate_batch) can now say so with `require`,
    and this is the surface that answers it.

    Lines come back as '<localized more-options phrase> <title>' verbatim (RenderedKebabNames
    refuses to guess which words are the phrase), so callers match by SUFFIX - exact and
    language-independent.
    """
    code, out = (list_runner or _run_list)(instance)
    if code != 0:
        return None
    rows = [ln.strip() for ln in out.splitlines() if ln.startswith("  ") and ln.strip()]
    return rows or None


def renders(rows: list[str] | None, title: str) -> bool:
    """Is that exact title on screen? Unknown rows (None) are never read as a yes."""
    t = str(title or "").strip()
    return bool(t) and bool(rows) and any(r.endswith(t) for r in rows or [])


def unrendered_requirements(instance: str, require: dict[str, str],
                            list_runner=None) -> tuple[dict[str, str], str]:
    """Which required titles the app is NOT showing, plus why the answer is what it is.

    An unreadable sidebar (app closed, UIA refused) returns {} - "cannot prove a miss" is not
    "found a miss", and probing on an unprovable requirement would loop forever against a
    closed app.
    """
    if not require:
        return {}, "nothing required"
    rows = rendered_titles(instance, list_runner)
    if rows is None:
        return {}, f"could not read what '{instance}' is rendering - requirements not judged"
    missing = {sid: t for sid, t in require.items() if not renders(rows, t)}
    return missing, ("every required title is on screen" if not missing else
                     f"{len(missing)} required title(s) not rendered")


def _empty_pass_result(why: str) -> dict:
    return {"named": [], "needsJudgment": [], "flakes": [], "remaining": None,
            "unrendered": [], "why": why}


def _rename_quarantined_chats(store: Path, meta_cache: dict, titles: dict[str, str],
                               daemon_rename) -> list[dict]:
    """Quarantined chats first: their sid is already known, so when a better-informed map
    now carries a real name, rename directly - no probe needed. (Without this, a quarantine
    name was forever: nothing ever revisited it. Review finding.)"""
    named = []
    for meta in scan_metas(store, meta_cache):
        title = str(meta.get("title") or "")
        sid = str(meta.get("cliSessionId") or "")
        if (not meta.get("isArchived") and sid and titles.get(sid)
                and re.match(r"^recovered chat ", title, re.IGNORECASE)):
            code, _out = daemon_rename(sid, titles[sid])
            if code == 0:
                named.append({"sid": sid, "title": titles[sid]})
    return named


@dataclass
class _PassState:
    """Mutable tally threaded through one probe loop (name_pass docstring). Kept as one
    object, not five loose locals, so the per-round helper below can update it without a
    fistful of return values."""

    named: list[dict] = field(default_factory=list)
    needs_judgment: list[dict] = field(default_factory=list)
    flakes: list[str] = field(default_factory=list)
    consecutive_flakes: int = 0

    def flake(self, msg: str) -> bool:
        """Record a flake and report whether the pass should give up (3 in a row)."""
        self.flakes.append(msg)
        self.consecutive_flakes += 1
        return self.consecutive_flakes >= 3


def _await_probe_sid(store: Path, probe: str, meta_cache: dict, poll_secs: float) -> str | None:
    """Poll the store until the meta holding the probe's title shows up, or poll_secs elapses."""
    deadline = time.time() + poll_secs
    sid = None
    while time.time() < deadline:
        sid = sid_holding_title(store, probe, meta_cache)
        if sid:
            break
        time.sleep(1)
    return sid


def _run_probe_round(instance: str, probe: str, store: Path, meta_cache: dict,
                      titles: dict[str, str], poll_secs: float, probe_runner, daemon_rename,
                      state: _PassState) -> bool:
    """Drive one probe/reveal/rename cycle, updating `state` in place. Returns True when the
    caller's probe loop should stop (nothing reachable, or 3 flakes in a row)."""
    code, out = probe_runner(instance, probe)
    if code == 3:
        return True  # nothing reachable (collapsed/virtualized rows are reported as remaining)
    if code != 0:
        give_up = state.flake(out.splitlines()[-1] if out else f"probe exit {code}")
        if not give_up:
            time.sleep(2)
        return give_up
    state.consecutive_flakes = 0

    sid = _await_probe_sid(store, probe, meta_cache, poll_secs)
    if not sid:
        # One raced row (e.g. the app auto-titled it mid-probe) must not starve the rest of
        # the batch - record it and keep going (review finding).
        return state.flake(f"probe '{probe}' landed on screen but no meta picked it up in {poll_secs:.0f}s")

    want = titles.get(sid)
    if not want:
        # Naming from content is the AI's job - quarantine, report, never invent.
        want = f"Recovered chat {sid[:8]} (needs a name)"
        state.needs_judgment.append({"sid": sid, "quarantineTitle": want,
                                     "why": "no non-generic title known for it - an AI should read it and name it"})
    code, out = daemon_rename(sid, want)
    if code == 0:
        state.named.append({"sid": sid, "title": want})
        return False
    return state.flake(f"{sid[:8]}: stuck at probe '{probe}' ({out.splitlines()[0][:100] if out else code})")


def name_pass(
    instance: str,
    extra_titles: dict[str, str] | None = None,
    probe_runner=None,
    daemon_rename=None,
    store: Path | None = None,
    poll_secs: float = 20,
    require: dict[str, str] | None = None,
    list_runner=None,
) -> dict:
    """Run the pass. Returns {named, needsJudgment, flakes, remaining, unrendered, why}.

    `require` is {cliSessionId: intended title} for chats the CALLER knows it just landed.
    Those are judged on what the app RENDERS, not on the disk record - see rendered_titles()
    for why a fresh import's disk title is a hint that the running app erases. Without it the
    pass keeps its old disk-only behaviour exactly.
    """
    probe_runner = probe_runner or _run_probe
    daemon_rename = daemon_rename or _daemon_rename
    store = store or store_dir_for(instance)
    if store is None or not store.exists():
        return _empty_pass_result(f"no chat store found for instance '{instance}'")

    titles = intended_titles(extra_titles)
    # One mtime-keyed parse cache for the WHOLE pass (scan_metas docstring) - in memory,
    # never persisted: the win is the poll loop's per-second rescans, not cross-run reuse.
    meta_cache: dict = {}

    with windowlib.instance_lock(instance, wait_secs=0) as got_lock:
        if not got_lock:
            return _empty_pass_result(
                f"another lane is already driving '{instance}' - refusing to race it")

        state = _PassState()
        state.named.extend(_rename_quarantined_chats(store, meta_cache, titles, daemon_rename))

        # Probe names must be unique ACROSS processes and passes - a 1-second stamp collided
        # between overlapping runs (review finding).
        stamp = f"{os.getpid()}-{uuid.uuid4().hex[:6]}"

        want = dict(require or {})
        unrendered, why_rendered = unrendered_requirements(instance, want, list_runner)
        for n in range(1, MAX_PASSES + 1):
            if not nameless_rows(store, meta_cache) and not unrendered:
                break
            probe = f"{PROBE_PREFIX} {stamp}-{n}"
            if _run_probe_round(instance, probe, store, meta_cache, titles, poll_secs,
                                 probe_runner, daemon_rename, state):
                break
            unrendered, why_rendered = unrendered_requirements(instance, want, list_runner)

        remaining = nameless_rows(store, meta_cache)
        unrendered, why_rendered = unrendered_requirements(instance, want, list_runner)
    clean = not remaining and not state.flakes and not unrendered
    return {
        "named": state.named,
        "needsJudgment": state.needs_judgment,
        "flakes": state.flakes,
        "remaining": remaining,
        # THE VERDICT THAT MATTERS FOR A LANDING: required titles the app still is not showing.
        # A caller reading only `remaining` reads the disk copy, which a running app is free to
        # contradict (rendered_titles docstring).
        "unrendered": sorted(unrendered.values()),
        "why": ("clean" if clean else
                (f"{why_rendered}; " if unrendered else "")
                + "some rows remain - collapsed/virtualized rows are out of UIA reach, or passes flaked; rerun, or scroll them into view"),
    }


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 1
    try:
        result = name_pass(args[0])
    except hydralib.DaemonError as err:
        print(f"naming pass FAILED: {err}", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        for r in result["named"]:
            print(f"named {r['sid'][:8]} -> '{r['title']}'")
        for r in result["needsJudgment"]:
            print(f"⚠ {r['sid'][:8]} quarantined as '{r['quarantineTitle']}' - {r['why']}")
        for f in result["flakes"]:
            print(f"flake: {f}")
        rem = result["remaining"]
        print(f"{len(result['named'])} named, {len(result['needsJudgment'])} need an AI-written name, "
              f"{len(rem) if rem is not None else '?'} still nameless ({result['why']})")
    if result["remaining"] is None:
        # No store found, or another pass already holds the lock: the pass never ran, so
        # this is NOT "nothing nameless" - exit 1 per the docstring, not a false 0 (review finding).
        return 1
    ok = (not result["flakes"] and not result["remaining"] and not result["needsJudgment"]
          and not result.get("unrendered"))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
