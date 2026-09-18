"""No toolbox script may hand a LONG-LIVED child this process's stdout/stderr (2026-09-18).

THE INCIDENT. A `move_chats` polled `status: "running"` for 65 minutes and had to be killed by
hand; so did a `courier` past its 300s deadline. The operation records, once a cancel finally
populated them, said the children had EXITED after 79s and 15s. Nothing was hung - the daemon
simply could not tell the run was over.

WHY. Under the daemon these scripts run as `Bun.spawn(..., stdout: 'pipe', stderr: 'pipe')`, and
the daemon's read of the run ended when the PIPE closed, not when the process died. A child
started here with no stdio redirection inherits those pipe handles, so a terminal, an app or any
other process meant to outlive this script keeps them open for as long as IT lives - and the run
reads as still going, for a script that finished long ago.

The daemon side is fixed (server/src/orchestrator.ts reaps on the child's own exit and bounds the
whole run), but a leaked pipe is still a leak: it costs a handle, it can still hold up a hand-run
`python orch.py ...` in a terminal, and it is trivially avoidable. This check is the mechanical
half - stating the rule precisely enough to encode it, and then encoding it.

THE RULE. Every `subprocess.Popen(...)` under scripts/ (tests excluded) passes `stdout=` and
`stderr=` explicitly. DEVNULL, a file handle and a pipe are all fine - each one means the author
decided where the output goes. Silence is the only thing refused.

`subprocess.run` / `check_output` / `clilib.run_text` are NOT covered and do not need to be: they
wait for the child, so it cannot outlive this process, and run_text captures both streams anyway.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]


def _is_popen(node: ast.Call) -> bool:
    fn = node.func
    if isinstance(fn, ast.Attribute):
        return fn.attr == "Popen"
    return isinstance(fn, ast.Name) and fn.id == "Popen"


def _python_files() -> list[Path]:
    return [
        p
        for p in sorted(SCRIPTS.rglob("*.py"))
        if "tests" not in p.relative_to(SCRIPTS).parts
    ]


class PopenRedirectsItsStdioTest(unittest.TestCase):
    def test_every_popen_says_where_its_output_goes(self):
        offenders: list[str] = []
        for path in _python_files():
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except SyntaxError as err:  # a file that will not parse is its own failure
                self.fail(f"{path.name} does not parse: {err}")
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or not _is_popen(node):
                    continue
                named = {kw.arg for kw in node.keywords if kw.arg}
                # **kwargs forwarding (remote.py builds its creationflags that way) still has to
                # name the two streams at the call site; a dict could hide anything.
                missing = [s for s in ("stdout", "stderr") if s not in named]
                if missing:
                    offenders.append(
                        f"{path.relative_to(SCRIPTS)}:{node.lineno} Popen(...) does not set "
                        f"{' or '.join(missing)}"
                    )
        self.assertEqual(
            offenders,
            [],
            "a Popen with no stdout/stderr INHERITS the daemon's pipes, and a child that "
            "outlives this script then holds them open - which is how a finished run polled "
            "`running` for 65 minutes. Pass subprocess.DEVNULL (or a log file, or a pipe you "
            "read): " + "; ".join(offenders),
        )

    def test_the_check_can_actually_see_a_bare_popen(self):
        """The guard's own guard: a rule that cannot fail is not a rule."""
        tree = ast.parse("import subprocess\nsubprocess.Popen(['x'])\n")
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and _is_popen(n)]
        self.assertEqual(len(calls), 1)
        self.assertEqual({kw.arg for kw in calls[0].keywords if kw.arg}, set())


if __name__ == "__main__":
    unittest.main()
