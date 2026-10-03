"""Tool-loop guard for the `api` worker loop: tells a worker it is repeating itself, and stops it once the
outcomes prove the repetition is going nowhere.

Why: cheap free models burn their whole max_turns re-reading the same file or re-running the same grep, and
before this the only exits were max_turns, cost and timeout - each of which fails the task after the budget
is already spent. A model-visible nudge at a repeat threshold recovers many of those runs; the ones it does
not recover end early as status `loop`, naming the detector, instead of timing out.

Every tool call is keyed on its name plus its arguments as canonical JSON (keys sorted at every depth, so
{"a":1,"b":2} and {"b":2,"a":1} are one call) and on a hash of what it returned. Detectors over that history:

- repeat: the same call N times in a row. Advisory only - a reminder is appended to that call's own tool
  result at REPEAT_WARN (gentle first, then detailed). The result may differ each time (a file being
  edited, a test being re-run), so this detector never ends a task.
- no_progress: the same call returning the same result every time. Warns like repeat and ends the task at
  NO_PROGRESS_STOP in a row.
- ping_pong: two calls alternating A, B, A, B with each returning what it returned last time. Warns at
  PING_PONG_WARN, ends the task at PING_PONG_STOP.
- global: one (call, result) pair seen GLOBAL_STOP times anywhere in the task, however interleaved - the
  circuit breaker for a longer cycle the other detectors do not see.

submit_result is transparent: it is the way out of the loop, never part of one.

Ideas from deepseek-ai/deepseek-harness (packages/guard/repeat-tool-reminder, MIT) and openclaw/openclaw
(src/agents/tool-loop-detection.ts, MIT); written fresh for hswarm, no code copied.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

REPEAT_WARN = (3, 5, 8)  # consecutive identical calls that earn a reminder: the first gentle, the rest detailed
NO_PROGRESS_STOP = 10  # consecutive identical calls with identical results that end the task
PING_PONG_WARN = (6, 9)  # calls in an A-B-A-B cycle with unchanged results that earn a reminder
PING_PONG_STOP = 12
GLOBAL_STOP = 15  # sightings of one (call, result) pair anywhere in the task
TRANSPARENT = frozenset({"submit_result"})
ARGS_SHOWN = 200  # chars of the canonical arguments quoted back to the model


@dataclass
class Stop:
    """A detector's proof of no progress: the task ends with status `loop` and this error."""
    detector: str
    error: str


def canonical_args(arguments: str | dict | None) -> str:
    """The arguments as JSON with keys sorted at every depth; text that is not JSON is keyed as it came."""
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments or "{}")
        except ValueError:
            return arguments
    return json.dumps(arguments if arguments is not None else {}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


# The receipt label every sandbox output is headed by (receipts.stamp: "[r7 read_file]") counts up on every call, so
# a digest over it would call every re-read new; what the tool RETURNED is the rest.
_RECEIPT_LABEL = re.compile(r"^\[r\d+ [\w.-]+\]\n", re.M)


def _digest(text: str) -> str:
    return hashlib.sha1(_RECEIPT_LABEL.sub("", text, count=1).encode("utf-8", "replace")).hexdigest()


class LoopGuard:
    """One per task. review() is fed each turn's tool calls and outputs in order."""

    def __init__(self) -> None:
        self.history: list[tuple[str, str]] = []  # (call key, result digest), oldest first
        self.seen: dict[tuple[str, str], int] = {}
        self.warnings = 0  # reminders appended so far; recorded on the result and the ledger line

    def review(self, tool_calls: list[dict], outputs: list[str]) -> tuple[list[str], Stop | None]:
        """The outputs with any reminder appended, plus the first Stop a call earned (None: carry on)."""
        stop: Stop | None = None
        reviewed = []
        for tc, out in zip(tool_calls, outputs):
            fn = tc.get("function") or {}
            note, halt = self.observe(fn.get("name") or "", fn.get("arguments"), out)
            reviewed.append(out + "\n\n" + note if note else out)
            stop = stop or halt
        return reviewed, stop

    def observe(self, name: str, arguments: str | dict | None, output: str) -> tuple[str, Stop | None]:
        """Record one call; returns (reminder text or "", Stop or None)."""
        if name in TRANSPARENT:
            return "", None
        args = canonical_args(arguments)
        entry = (f"{name}\x00{args}", _digest(str(output)))
        self.history.append(entry)
        self.seen[entry] = self.seen.get(entry, 0) + 1
        run, same = self._trailing_run()
        shown = args if len(args) <= ARGS_SHOWN else args[:ARGS_SHOWN] + "..."
        if same >= NO_PROGRESS_STOP:
            return "", Stop("no_progress", f"loop: no_progress - {name}({shown}) returned the same result {same} times in a row")
        cycle = self._ping_pong_length()
        if cycle >= PING_PONG_STOP:
            return "", Stop("ping_pong", f"loop: ping_pong - {self._pair_names()} alternated {cycle} calls with unchanged results")
        if self.seen[entry] >= GLOBAL_STOP:
            return "", Stop("global", f"loop: global - {name}({shown}) returned the same result {self.seen[entry]} times in this task")
        if cycle in PING_PONG_WARN:
            return self._warn(f"[loop guard] You are alternating between {self._pair_names()} and each keeps returning what it "
                              f"returned before ({cycle} calls). Break the cycle: try a different approach, or give your final "
                              f"answer now from what you have. The task is stopped at {PING_PONG_STOP} calls of this cycle."), None
        if run in REPEAT_WARN:
            if run == REPEAT_WARN[0]:
                return self._warn(f"[loop guard] You have called {name} with these same arguments {run} times in a row. If it is "
                                  "not giving you what you need, try something different or answer with what you have."), None
            outcome = " and got the identical result every time" if same == run else ""
            tail = f" The task is stopped after {NO_PROGRESS_STOP} identical results in a row." if same == run else ""
            return self._warn(f"[loop guard] {name} has now been called {run} times in a row with identical arguments {shown}"
                              f"{outcome}. Repeating it will not change the outcome. Use a different tool or different "
                              f"arguments, or give your final answer now from what you have gathered.{tail}"), None
        return "", None

    def _warn(self, text: str) -> str:
        self.warnings += 1
        return text

    def _trailing_run(self) -> tuple[int, int]:
        """(calls in a row with the last call's key, calls in a row with its key AND result)."""
        key, digest = self.history[-1]
        run = same = 0
        still_same = True
        for k, d in reversed(self.history):
            if k != key:
                break
            run += 1
            still_same = still_same and d == digest
            same += still_same
        return run, same

    def _ping_pong_length(self) -> int:
        """Length of the trailing A-B-A-B stretch where every entry equals the one two back (key and result)."""
        h = self.history
        if len(h) < 4 or h[-1][0] == h[-2][0]:
            return 0
        n = 2
        while n < len(h) and h[-1 - n] == h[-1 - n + 2]:
            n += 1
        return n

    def _pair_names(self) -> str:
        return " and ".join(k.split("\x00", 1)[0] + "(" + k.split("\x00", 1)[1][:80] + ")" for k, _ in self.history[-2:])
