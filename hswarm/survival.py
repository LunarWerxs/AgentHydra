"""Edit survival: did the code a worker wrote stay written?

A task that finished "ok" says the worker stopped, not that its edit was any good. The cheap, language-agnostic
signal is what happened to the edit afterwards. When an api worker first touches a file its Sandbox keeps the
text as it was (`originals`); at task end snapshot() pairs that with the text the worker left, and the job
journal stores the pair under ~/.hswarm/edits/<job>/<task>.json. score_due() later compares both with the file
on disk now, at three checkpoints (5 minutes, 1 hour, 1 day after the task), appends one line per checkpoint to
~/.hswarm/survival.jsonl and drops the snapshot after the last one. ledger.ledger_rows joins the newest score
onto the task's ledger row as `survival`, and ledger_summary averages it per model, so legs can be ranked by
whether their edits were kept and not only by whether the task finished.

Two numbers per task, each 0..1 (the idea is VS Code Copilot's edit-survival tracker, written fresh here):
  four_gram  the share of the text the worker ADDED that is still in the file (character 4-gram overlap, so a
             reformat or a small tweak keeps most of the credit and a rewrite loses it).
  no_revert  1 minus how far the file moved back toward its pre-task text: 0 when someone restored the old
             file (or deleted a file the worker created), 1 when the edit stands or was changed into something new.
"""
from __future__ import annotations

import datetime as dt
import json
from collections import Counter
from pathlib import Path

from . import config

N = 4
MAX_BYTES = 256 * 1024  # a file bigger than this is not snapshotted: the pair is kept twice on disk per task
CHECKPOINTS = (("5m", 300), ("1h", 3600), ("1d", 86400))


def edits_dir() -> Path:
    return config.HOME / "edits"


def log_path() -> Path:
    return config.HOME / "survival.jsonl"


def grams(text: str) -> Counter:
    return Counter(text[i:i + N] for i in range(len(text) - N + 1))


def similarity(a: str, b: str) -> float:
    """4-gram overlap of two texts: 1.0 for identical, 0.0 for nothing shared."""
    ga, gb = grams(a), grams(b)
    ta, tb = sum(ga.values()), sum(gb.values())
    if not ta or not tb:
        return 1.0 if a == b else 0.0  # shorter than one gram: only equality says anything
    return sum((ga & gb).values()) / max(ta, tb)


def read_text(path: str | Path) -> str | None:
    """The file as text, or None when it is gone, too big or not text: all three mean "not scoreable as it was"."""
    p = Path(path)
    try:
        if not p.is_file() or p.stat().st_size > MAX_BYTES:
            return None
        with p.open(encoding="utf-8", newline="") as f:  # Path.read_text(newline=) needs Python 3.13
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def snapshot(originals: dict[str, str | None | bool]) -> list[dict]:
    """The before/after pair of every file the worker changed. `originals` maps a path to its text before the
    worker's first write (None for a file it created, False for one that could not be read as text)."""
    out = []
    for path, before in originals.items():
        after = read_text(path)
        if before is False or after is None or before == after:
            continue
        out.append({"path": path, "before": before, "after": after})
    return out


def save(job: str, task: str, model: str, finished: str, files: list[dict]) -> None:
    """Keep one task's snapshot until its last checkpoint. Disk errors never fail the task that produced it."""
    try:
        d = edits_dir() / job
        d.mkdir(parents=True, exist_ok=True)
        rec = {"job": job, "task": task, "model": model, "finished": finished, "scored": [], "files": files}
        (d / f"{task}.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def file_score(before: str | None, after: str, now: str | None) -> dict | None:
    """One file's survival; None when the worker's edit changed nothing measurable."""
    before, now = before or "", now or ""
    gb, ga, gn = grams(before), grams(after), grams(now)
    added = ga - gb  # what the worker introduced, without the text that was there anyway
    changed = sum(added.values()) + sum((gb - ga).values())
    s_ai = similarity(before, after)
    if s_ai >= 1.0:
        return None
    kept = sum((added & (gn - gb)).values()) / sum(added.values()) if added else None
    back = max(0.0, similarity(before, now) - s_ai) / (1.0 - s_ai)
    return {"four_gram": kept, "no_revert": 1.0 - back, "added": sum(added.values()), "changed": max(changed, 1)}


def score_task(files: list[dict]) -> dict:
    """A task's score over its files: four_gram weighted by the text each file gained, no_revert by how much it changed."""
    scores = [s for f in files if (s := file_score(f.get("before"), f["after"], read_text(f["path"]))) is not None]
    fg = [(s["four_gram"], s["added"]) for s in scores if s["four_gram"] is not None]
    fg_w = sum(w for _, w in fg)
    nr_w = sum(s["changed"] for s in scores)
    return {
        "files": len(scores),
        "four_gram": round(sum(v * w for v, w in fg) / fg_w, 4) if fg_w else None,
        "no_revert": round(sum(s["no_revert"] * s["changed"] for s in scores) / nr_w, 4) if nr_w else None,
    }


def score_due(now: dt.datetime | None = None) -> dict:
    """Score every snapshot that has reached a checkpoint it was not scored at. A pass that runs late scores only the
    latest checkpoint reached, labelled as that one, so a nightly pass never files a day-old reading under "5m"."""
    now = now or dt.datetime.now(dt.timezone.utc)
    scored = dropped = 0
    root = edits_dir()
    for p in sorted(root.glob("*/*.json")) if root.is_dir() else []:
        try:
            snap = json.loads(p.read_text(encoding="utf-8"))
            age = (now - dt.datetime.fromisoformat(snap["finished"])).total_seconds()
        except (OSError, ValueError, KeyError, TypeError):
            continue
        reached = [label for label, secs in CHECKPOINTS if age >= secs]
        if not reached or reached[-1] in snap.get("scored", []):
            continue
        row = {"ts": now.isoformat(timespec="seconds"), "job": snap["job"], "task": snap["task"], "model": snap.get("model", ""),
               "checkpoint": reached[-1], "age_s": round(age), **score_task(snap.get("files") or [])}
        try:
            with log_path().open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            scored += 1
            if reached[-1] == CHECKPOINTS[-1][0]:
                p.unlink()
                dropped += 1
                if not any(p.parent.iterdir()):
                    p.parent.rmdir()
            else:
                p.write_text(json.dumps({**snap, "scored": reached}, ensure_ascii=False), encoding="utf-8")
        except OSError:
            continue
    return {"scored": scored, "finished": dropped}


def latest() -> dict[tuple[str, str], dict]:
    """The newest checkpoint score per (job, task): the one ledger rows carry."""
    out: dict[tuple[str, str], dict] = {}
    p = log_path()
    if not p.exists():
        return out
    with p.open(encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
                k = (r["job"], r["task"])
            except (ValueError, KeyError, TypeError):
                continue
            if k not in out or r.get("age_s", 0) >= out[k].get("age_s", 0):
                out[k] = {x: r.get(x) for x in ("checkpoint", "age_s", "files", "four_gram", "no_revert")}
    return out


def mean(scores: list[dict]) -> dict:
    """Per-model roll-up: how many tasks were scored and the plain mean of each number over those that have it."""
    out: dict = {"scored": len(scores)}
    for k in ("four_gram", "no_revert"):
        vals = [s[k] for s in scores if s.get(k) is not None]
        out[k] = round(sum(vals) / len(vals), 4) if vals else None
    return out
