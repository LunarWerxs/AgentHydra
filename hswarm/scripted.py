"""Scripted-diff: a mechanical change that carries the script which made it, proved by replaying the script.

WHY: a rename or sweep diff is long and a reviewer has to read all of it to trust it. When the change
ships with the few lines of shell that produced it, and a machine replays those lines on the starting
tree and gets the identical tree, the reviewer reads the script and the replay vouches for the diff.
Idea from bitcoin/bitcoin test/lint/commit-script-check.sh (MIT); written fresh for hswarm.

Two entry points share one replay:
- the `scripted` task mode (spec.Task.scripted): the worker edits its cwd AND submits the script; JobManager
  snapshots the cwd before the worker starts and `settle` accepts the result only when the replay, run on a
  throwaway worktree holding that snapshot, reproduces the worker's working tree exactly;
- `hswarm scripted check [RANGE]`: every commit titled `scripted-diff:` must carry its script between the
  marker lines and replay to its own tree from its parent; marker lines under any other title fail too.

Trees are compared as git tree hashes (untracked files included, ignored files excluded), written through a
temporary index so the caller's real index is never touched.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import shutil
import tempfile
from pathlib import Path

from . import tools
from .procs import find_bash, run_hidden

TITLE = "scripted-diff:"
BEGIN = "-BEGIN VERIFY SCRIPT-"
END = "-END VERIFY SCRIPT-"
REPLAY_TIMEOUT_S = 300
GIT_TIMEOUT_S = 120

# What a scripted worker must submit. The spec forces it as the task's schema, so the script comes back as data.
SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "script": {"type": "string", "description": "The bash script that makes the whole change when run from the working directory's starting state."},
        "summary": {"type": "string", "description": "One line: what the script changes."},
    },
    "required": ["script"],
}

SCRIPTED_CLAUSE = (
    "Scripted mode: make the change with a bash script, not by hand. Run the script once from the working directory "
    "with the bash tool, passing it inline (bash -euo pipefail -c '...'), check the result, then submit its exact text "
    "as `script`. The orchestrator replays that script under `set -euo pipefail` on a clean copy of the starting tree "
    "and rejects your result unless the replay reproduces your working tree byte for byte: make no other edit, and "
    "leave no script or scratch file behind in the working directory. Use relative paths only: a script that names "
    "the checkout's absolute path is refused, and it runs no git command that writes (add, mv, stash, commit, ...)."
)

# WHY: the replay worktree shares refs, stash, config and hooks with the caller's repository, so a git write in a
# replayed script lands in the real repo. These subcommands reach that shared state and are refused on every replay
# (worker script or commit script), whatever HSWARM_ALLOW_GIT_WRITES says.
_SHARED_GIT_WRITES = (
    "branch|config|fetch|filter-branch|gc|notes|prune|pull|push|reflog|remote|replace|stash|submodule|"
    "symbolic-ref|tag|update-ref|worktree"
)
_SHARED_GIT_WRITE_RE = re.compile(
    r"(?:^|[;&|(`\n]|\$\()\s*(?:\w+=\S*\s+)*git(?:\.exe)?\s+(?:-[Cc]\s+\S+\s+|--\S+\s+)*(" + _SHARED_GIT_WRITES + r")\b"
)


class ScriptedError(RuntimeError):
    """A git or bash step of the replay could not run (as opposed to a replay that ran and did not match)."""


async def _git(repo: Path | str, *args: str, env: dict | None = None) -> str:
    code, out, err = await run_hidden(["git", *args], repo, GIT_TIMEOUT_S, env=env)
    if code != 0:
        raise ScriptedError(f"git {args[0]} failed (exit {code}): {(err or out).strip()[:400]}")
    return out.strip()


async def snapshot(repo: Path | str) -> str:
    """The tree hash of the working state as it stands (untracked included, ignored excluded), via a throwaway index."""
    with tempfile.TemporaryDirectory(prefix="hswarm-index-") as d:
        tmp_index = Path(d) / "index"
        real_index = Path(repo) / await _git(repo, "rev-parse", "--git-path", "index")
        env = {**os.environ, "GIT_INDEX_FILE": str(tmp_index)}
        if real_index.is_file():
            # A copy keeps git's stat cache, so only changed files are re-hashed. copy2, never copyfile: it keeps the
            # index's own mtime, which git's racy-clean check needs; a fresh mtime made a same-size edit inside the
            # index's second read as unchanged: the replay kept the OLD file and a correct script failed (2026-09-25,
            # six parallel stress loops: copyfile 5 failures in 108, copy2 0 in 90).
            shutil.copy2(real_index, tmp_index)
        else:
            await _git(repo, "read-tree", "HEAD", env=env)
        await _git(repo, "add", "-A", env=env)
        return await _git(repo, "write-tree", env=env)


async def replay(repo: Path | str, base: str, script: str, prefix: str = "") -> str:
    """Run `script` on a throwaway worktree of `repo` holding tree-ish `base`; return the tree it leaves.
    `prefix` is the subfolder the script runs from, as it did in the worker's cwd (`git rev-parse --show-prefix`)."""
    shared = _SHARED_GIT_WRITE_RE.search(script or "")
    if shared:
        raise ScriptedError(f"refused to replay `git {shared.group(1)}`: the replay worktree shares refs, stash and config with the real repository")
    bash = find_bash()
    if not bash:
        raise ScriptedError("no working bash found to replay the script (Git Bash expected on Windows)")
    scratch = Path(tempfile.mkdtemp(prefix="hswarm-replay-"))
    wt = scratch / "tree"
    script_file = scratch / "verify-script.sh"
    # A script that came through JSON on Windows may carry CRLF, and bash reads the CR as part of each command.
    script_file.write_text("set -euo pipefail\n" + script.replace("\r\n", "\n") + "\n", encoding="utf-8", newline="\n")
    added = False
    try:
        await _git(repo, "worktree", "add", "--detach", "--no-checkout", "--quiet", str(wt), "HEAD")
        added = True
        await _git(wt, "read-tree", "--reset", "-u", base)
        run_dir = wt / prefix if prefix else wt
        run_dir.mkdir(parents=True, exist_ok=True)
        code, out, err = await run_hidden([bash, script_file.as_posix()], run_dir, REPLAY_TIMEOUT_S)
        if code != 0:
            raise ScriptedError(f"the script failed on replay (exit {code}): {(err or out).strip()[-400:]}")
        return await snapshot(wt)
    finally:
        if added:
            try:
                await _git(repo, "worktree", "remove", "--force", str(wt))
            except ScriptedError:
                await run_hidden(["git", "worktree", "prune"], repo, GIT_TIMEOUT_S)
        shutil.rmtree(scratch, ignore_errors=True)


async def _diffstat(repo: Path | str, a: str, b: str) -> str:
    code, out, _ = await run_hidden(["git", "diff", "--stat", a, b], repo, GIT_TIMEOUT_S)
    return out.strip()[-1500:] if code == 0 else ""


async def verify(repo: Path | str, base: str, expected_tree: str, script: str, prefix: str = "") -> dict:
    """Replay `script` from `base` and compare with `expected_tree`. Never raises: a failure is a verdict."""
    out: dict = {"verified": False, "base": base, "tree": expected_tree}
    try:
        got = await replay(repo, base, script, prefix)
        out["changed"] = got != await _git(repo, "rev-parse", f"{base}^{{tree}}")
    except (ScriptedError, OSError) as e:
        out["error"] = str(e)
        return out
    out["replay_tree"] = got
    if got == expected_tree:
        out["verified"] = True
    else:
        # What the change has that the replay did not make (and the reverse), so the mismatch is readable.
        out["error"] = "replay does not reproduce the change"
        out["mismatch"] = await _diffstat(repo, got, expected_tree)
    return out


def _path_forms(path: str) -> set[str]:
    """`path` as a script may spell it: forward slashes, backslashes, and Git Bash's /d/... for a drive path."""
    p = path.replace("\\", "/").rstrip("/")
    forms = {p, p.replace("/", "\\")}
    if re.match(r"^[A-Za-z]:/", p):
        forms.add(f"/{p[0]}{p[2:]}")
    return {f.lower() for f in forms if f.strip("/\\")}


def _absolute_path_refusal(script: str, *paths: str) -> str | None:
    """WHY: the replay runs in a throwaway worktree, but a script that names the checkout by its absolute path edits the
    REAL checkout a second time (a non-idempotent sed or >> corrupts the user's tree), so such a script is refused."""
    lowered = script.lower()
    for path in paths:
        hit = next((f for f in _path_forms(path) if f in lowered), None)
        if hit:
            return f"the script names the absolute path {hit}; a scripted script must use paths relative to its working directory"
    return None


async def settle(res, cwd: str, base: str) -> None:
    """Accept a finished scripted task only when its script replays to the worker's working tree."""
    script = res.data.get("script") if isinstance(res.data, dict) else None
    if not isinstance(script, str) or not script.strip():
        res.status, res.error = "error", "ScriptedDiff: the worker returned no script"
        return
    # The worker's own bash refuses git writes; a script it could not have run in its sandbox is not replayed either.
    refusal = tools.git_write_refusal(script)
    if refusal:
        res.status, res.error = "error", f"ScriptedDiff: {refusal}"
        return
    try:
        top = await _git(cwd, "rev-parse", "--show-toplevel")
        refusal = _absolute_path_refusal(script, top, str(Path(cwd).resolve()), cwd)
        if refusal:
            res.status, res.error = "error", f"ScriptedDiff: {refusal}"
            return
        worker_tree = await snapshot(cwd)
        prefix = await _git(cwd, "rev-parse", "--show-prefix")  # the worker ran its script from here, so the replay does too
    except (ScriptedError, OSError) as e:
        res.status, res.error = "error", f"ScriptedDiff: {e}"
        return
    verdict = await verify(cwd, base, worker_tree, script, prefix)
    res.data = {**res.data, "replay": verdict}
    if not verdict["verified"]:
        res.status, res.error = "error", f"ScriptMismatch: {verdict.get('error')}"


def extract_script(message: str) -> str | None:
    """The lines strictly between the BEGIN and END marker lines, or None when there is no complete block."""
    lines = message.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == BEGIN)
        stop = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == END)
    except StopIteration:
        return None
    return "\n".join(lines[start + 1:stop])


async def check_commit(repo: Path | str, commit: str) -> dict:
    """One commit's verdict: skipped (ordinary), ok (script replays), or failed with the reason."""
    message = await _git(repo, "log", "-1", "--format=%B", commit)
    title = message.splitlines()[0] if message else ""
    row: dict = {"commit": commit[:12], "title": title}
    if not title.startswith(TITLE):
        if BEGIN in message or END in message:
            row.update(status="failed", error=f"script markers in a commit not titled '{TITLE}'")
        else:
            row["status"] = "skipped"
        return row
    script = extract_script(message)
    if script is None:
        row.update(status="failed", error=f"no script between '{BEGIN}' and '{END}' lines")
        return row
    verdict = await verify(repo, f"{commit}^", await _git(repo, "rev-parse", f"{commit}^{{tree}}"), script)
    row["status"] = "ok" if verdict["verified"] else "failed"
    if not verdict["verified"]:
        row["error"] = verdict.get("error")
        row["mismatch"] = verdict.get("mismatch", "")
    return row


async def check_range(repo: Path | str, rev_range: str) -> list[dict]:
    commits = (await _git(repo, "rev-list", "--reverse", "--no-merges", rev_range)).split()
    return [await check_commit(repo, c) for c in commits]


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="hswarm scripted", description="verify scripted-diff commits by replaying the script each one carries")
    sub = p.add_subparsers(dest="action", required=True)
    c = sub.add_parser("check", help=f"replay every '{TITLE}' commit in RANGE; exit 1 on any mismatch or stray marker")
    c.add_argument("range", nargs="?", default="HEAD^..HEAD", help="git revision range (default HEAD^..HEAD)")
    c.add_argument("--repo", default=".", help="the repository (default: the current directory)")
    a = p.parse_args(argv)
    try:
        rows = asyncio.run(check_range(Path(a.repo).resolve(), a.range))
    except ScriptedError as e:
        print(f"FAILED: {e}")
        return 2
    for r in rows:
        print(f"{r['status']:7} {r['commit']} {r['title']}" + (f"\n        {r['error']}" if r.get("error") else ""))
        if r.get("mismatch"):
            print("        " + r["mismatch"].replace("\n", "\n        "))
    failed = sum(r["status"] == "failed" for r in rows)
    print(f"{len(rows)} commit(s): {sum(r['status'] == 'ok' for r in rows)} verified, {failed} failed")
    return 1 if failed else 0
