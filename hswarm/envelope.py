"""The spawn envelope: what a whole spawn TREE may do, narrowed at every hop, and the per-tree ledger that admits it.

WHY: max_cost_usd caps one worker and budget_usd caps one job, but a cc worker runs full Claude Code and can start
a job of its own (through a project's hswarm MCP entry or `hswarm.py run`), whose workers can do the same. Nothing
capped that TREE, and nothing stopped a worker from handing its children wider tools or a bigger budget than it was
given. Idea adapted from AutoGPT's copilot spawn tree (autogpt_platform/backend/backend/copilot/tree.py, ideas only).

- An envelope is set at a root job (hswarm_run `envelope`, `hswarm.py run --envelope`) and every task of that job
  carries it. A cc worker gets it in HSWARM_ENVELOPE (claude_env.cc_env), so any hswarm the worker starts inherits
  it; the shared HTTP server reads the X-Hswarm-Envelope header instead, never its own environment.
- A child envelope is derived from its parent ONLY by narrowing: depth + 1 toward max_depth, tools intersected,
  spend ceiling / node cap / deadline each the min of parent and request. A request cannot widen anything, and a
  task asking for tools outside its envelope is refused by name, not silently cut down.
- The tree ledger (~/.hswarm/trees/<root>.json, shared by every hswarm process on the machine) admits a job only
  while the tree's metered spend is under spend_usd and its node count stays within max_nodes.

HONEST BOUND: spend is METERED when a task finishes, not reserved when it starts, so admission cannot see what
in-flight tasks will cost. A tree can therefore end above spend_usd by what its in-flight tasks spend: at most
max_nodes tasks, each clamped at admission to max_cost_usd <= the ceiling's remainder. The node cap is what makes
that overshoot finite. It is a guard against a model widening its own delegation, not a sandbox: a worker with the
`all` preset has a shell and can unset its own environment.
"""
from __future__ import annotations

import contextlib
import dataclasses
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import config, shared
from .toolspecs import PRESETS, names_of

ENV_VAR = "HSWARM_ENVELOPE"
TREES_DIR = config.HOME / "trees"
DEFAULT_MAX_DEPTH = 2    # the root's tasks are depth 0; their children 1; grandchildren 2, and no further
DEFAULT_MAX_NODES = 32   # every task ever admitted in the tree, finished or not
LOCK_STALE_S = 10.0      # a ledger lock older than this belongs to a process that died holding it
LOCK_WAIT_S = 5.0
REQUEST_KEYS = ("max_depth", "tools", "spend_usd", "max_nodes", "deadline_s")
_ROOT_RX = re.compile(r"^[0-9a-f]{8,32}$")  # the root names a file, so it is never taken on trust


def _least(a, b):
    """The narrower of two limits, where None means unlimited."""
    return b if a is None else a if b is None else min(a, b)


def _request(req: dict | None) -> dict:
    """A caller's envelope request, checked: known keys, positive numbers, real tool names."""
    req = dict(req or {})
    unknown = sorted(set(req) - set(REQUEST_KEYS))
    if unknown:
        raise ValueError(f"envelope: unknown keys {unknown}; known: {list(REQUEST_KEYS)}")
    out: dict[str, Any] = {}
    # Every refusal says "envelope:" so the MCP tool answers it as an {error} instead of raising a bare int()/names_of error.
    try:
        for k in ("max_depth", "max_nodes"):
            if req.get(k) is not None:
                out[k] = int(req[k])
        for k in ("spend_usd", "deadline_s"):
            if req.get(k) is not None:
                out[k] = float(req[k])
        if req.get("tools") is not None:
            out["tools"] = names_of(req["tools"])
    except (ValueError, TypeError) as e:
        raise ValueError(f"envelope: {e}") from e
    for k in ("max_depth", "max_nodes"):
        if k in out and out[k] < (0 if k == "max_depth" else 1):
            raise ValueError(f"envelope: {k} must be {'>= 0' if k == 'max_depth' else '>= 1'}")
    for k in ("spend_usd", "deadline_s"):
        if k in out and out[k] <= 0:
            raise ValueError(f"envelope: {k} must be > 0")
    return out


@dataclass(frozen=True)
class Envelope:
    root: str
    depth: int = 0
    max_depth: int = DEFAULT_MAX_DEPTH
    tools: tuple[str, ...] = tuple(sorted(PRESETS["all"]))
    spend_usd: float | None = None
    max_nodes: int = DEFAULT_MAX_NODES
    deadline: float | None = None  # epoch seconds

    @staticmethod
    def new_root(req: dict | None) -> "Envelope":
        r = _request(req)
        return Envelope(root=uuid.uuid4().hex[:12], max_depth=r.get("max_depth", DEFAULT_MAX_DEPTH),
                        tools=tuple(sorted(r.get("tools", PRESETS["all"]))), spend_usd=r.get("spend_usd"),
                        max_nodes=r.get("max_nodes", DEFAULT_MAX_NODES),
                        deadline=time.time() + r["deadline_s"] if "deadline_s" in r else None)

    def narrow(self, req: dict | None) -> "Envelope":
        """The child's envelope: every field the parent's or narrower, whatever the request asks for."""
        r = _request(req)
        return Envelope(root=self.root, depth=self.depth + 1, max_depth=_least(self.max_depth, r.get("max_depth")),
                        tools=tuple(sorted(set(self.tools) & r["tools"])) if "tools" in r else self.tools,
                        spend_usd=_least(self.spend_usd, r.get("spend_usd")),
                        max_nodes=_least(self.max_nodes, r.get("max_nodes")),
                        deadline=_least(self.deadline, time.time() + r["deadline_s"] if "deadline_s" in r else None))

    def as_dict(self) -> dict:
        return {**dataclasses.asdict(self), "tools": list(self.tools)}

    @staticmethod
    def from_dict(d: dict) -> "Envelope":
        root = str(d.get("root") or "")
        if not _ROOT_RX.match(root):
            raise ValueError(f"envelope: root {root!r} is not a tree id")
        spend, deadline = d.get("spend_usd"), d.get("deadline")
        return Envelope(root=root, depth=int(d.get("depth", 0)), max_depth=int(d.get("max_depth", DEFAULT_MAX_DEPTH)),
                        tools=tuple(sorted(names_of(list(d.get("tools") or [])))),
                        spend_usd=None if spend is None else float(spend), max_nodes=int(d.get("max_nodes", DEFAULT_MAX_NODES)),
                        deadline=None if deadline is None else float(deadline))


def inherited() -> Envelope | None:
    """The envelope this process was spawned under, if any. Fails CLOSED: an envelope that is present but does not
    parse refuses the job, since dropping it would hand the caller an unbounded tree."""
    raw = ((shared.REQUEST.get() or {}).get("envelope") if shared.ACTIVE else os.environ.get(ENV_VAR)) or ""
    if not raw.strip():
        return None
    try:
        return Envelope.from_dict(json.loads(raw))
    except (ValueError, TypeError, AttributeError) as e:
        raise ValueError(f"spawn refused: the inherited {ENV_VAR} is unreadable ({e})") from e


# ---- the tree ledger --------------------------------------------------------------------------------------

def _path(root: str) -> Path:
    return TREES_DIR / f"{root}.json"


@contextlib.contextmanager
def _locked(root: str):
    """One writer per tree across every hswarm process on the machine: an O_EXCL lock file, broken when stale."""
    TREES_DIR.mkdir(parents=True, exist_ok=True)
    lock = TREES_DIR / f"{root}.lock"
    give_up = time.monotonic() + LOCK_WAIT_S
    while True:
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except (FileExistsError, PermissionError):  # Windows says PermissionError for a lock being deleted
            with contextlib.suppress(OSError):
                if time.time() - lock.stat().st_mtime > LOCK_STALE_S:
                    lock.unlink()
                    continue
            if time.monotonic() > give_up:
                raise TimeoutError(f"spawn tree {root}: its ledger stayed locked for {LOCK_WAIT_S:.0f}s")
            time.sleep(0.02)
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            lock.unlink()


def read_tree(root: str) -> dict:
    try:
        return json.loads(_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"root": root, "nodes": 0, "spent_usd": 0.0, "deepest": 0}


def _write_tree(root: str, state: dict) -> None:
    tmp = _path(root).with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    os.replace(tmp, _path(root))


def admit(tasks: list, request: dict | None = None) -> Envelope | None:
    """Admit a job's tasks into their spawn tree, or raise ValueError saying which limit refused them. No inherited
    envelope and no request: no tree, nothing changes. On admission every task carries its envelope, with its
    timeout and max_cost_usd clamped to the tree's deadline and remaining spend."""
    parent = inherited()
    if parent is None and request is None:
        for t in tasks:
            t.envelope = None
        return None
    env = parent.narrow(request) if parent else Envelope.new_root(request)
    now = time.time()
    if env.depth > env.max_depth:
        raise ValueError(f"spawn refused: depth {env.depth} is past this tree's max_depth {env.max_depth}; do the work yourself")
    if env.deadline is not None and env.deadline - now < 5:
        raise ValueError(f"spawn refused: tree {env.root} is past its deadline")
    allowed = set(env.tools)
    for t in tasks:
        try:
            wider = sorted(names_of(t.tools) - allowed)
        except ValueError as e:  # an unknown tool name: refused as an answer, like every other spawn refusal
            raise ValueError(f"spawn refused: task {t.id}: {e}") from e
        if wider:
            raise ValueError(f"spawn refused: task {t.id} asks for tools {wider} outside its envelope {sorted(allowed)}; "
                             "a spawned task may only narrow what it was given")
    try:
        with _locked(env.root):
            state = read_tree(env.root)
            if env.spend_usd is not None and state["spent_usd"] >= env.spend_usd:
                raise ValueError(f"spawn refused: tree {env.root} has spent ${state['spent_usd']:.4f} of its ${env.spend_usd:.4f} ceiling")
            if state["nodes"] + len(tasks) > env.max_nodes:
                raise ValueError(f"spawn refused: tree {env.root} has {state['nodes']} of {env.max_nodes} nodes; {len(tasks)} more do not fit")
            state["nodes"] += len(tasks)
            state["deepest"] = max(int(state.get("deepest", 0)), env.depth)
            state["updated"] = now
            _write_tree(env.root, state)
    except TimeoutError as e:
        raise ValueError(f"spawn refused: {e}") from e
    remaining = None if env.spend_usd is None else env.spend_usd - state["spent_usd"]
    for t in tasks:
        if env.deadline is not None:
            t.timeout_s = max(5, min(int(t.timeout_s), int(env.deadline - now)))
        if remaining is not None:
            t.max_cost_usd = min(float(t.max_cost_usd), remaining)
        t.envelope = env.as_dict()
    return env


def record_spend(task, cost_usd: float | None) -> None:
    """Meter a finished task into its tree. A cost nobody could price is charged at the task's own cap, so an
    unknown never reads as free. Ledger trouble never fails a task."""
    env = getattr(task, "envelope", None)
    if not env or not _ROOT_RX.match(str(env.get("root") or "")):
        return
    charge = float(task.max_cost_usd) if cost_usd is None else float(cost_usd)
    with contextlib.suppress(OSError):
        with _locked(env["root"]):
            state = read_tree(env["root"])
            state["spent_usd"] = round(float(state.get("spent_usd", 0.0)) + charge, 6)
            state["updated"] = time.time()
            _write_tree(env["root"], state)
