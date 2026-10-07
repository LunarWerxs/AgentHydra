"""What a free account pays around a task's own prompt: the characters hswarm/free_route.py adds, in characters.

The measure behind `free.route.wrapper_chars` in .rsi/rsi.yaml. A tool-free task with a schema is the common shape
sent to a free account; the wrapper is len(shape(task)) minus len(the prompt). Prints one JSON line.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hswarm.free_route import shape  # noqa: E402
from hswarm.spec import Task  # noqa: E402

prompt = "Classify the three items below."
task = Task(prompt=prompt, cwd="D:/w", tools="none", schema={"type": "object", "properties": {"a": {"type": "string"}}})
print(json.dumps({"chars": len(shape(task)) - len(prompt)}))
