"""What every native HSwarm task pays before its own prompt: the system prompt and the tool schemas, in characters.

The measure behind `hswarm.read_task.prefix_chars` in .rsi/rsi.yaml. A read task with a schema is the common shape
(hswarm_run with tools "read"); it is built exactly as worker.build_messages builds it and sent tools as
toolspecs.specs_for gives them. Today's date line is left out: its length moves with the month name and the day, and
it is not something a change here can trim. Prints one JSON line.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hswarm.guard import current_date_line  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.toolspecs import specs_for  # noqa: E402
from hswarm.worker import build_messages  # noqa: E402

task = Task(prompt="x", cwd="D:/w", tools="read", schema={"type": "object", "properties": {"a": {"type": "string"}}})
system = build_messages(task)[0]["content"].replace(current_date_line(), "")
tools = json.dumps(specs_for(task.tools), separators=(",", ":"))
print(json.dumps({"chars": len(system) + len(tools), "system_chars": len(system), "tool_spec_chars": len(tools)}))
