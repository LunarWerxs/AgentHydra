#!/usr/bin/env python3
"""A stand-in `claude` CLI that replays a recorded headless session, so the cc backend's whole
spawn -> stdin -> stream-json -> parse path runs offline, deterministically and for free.

Point HSWARM_CLAUDE_BIN at this file (claude_env.claude_argv runs a .py under Python). Not a PATH
overlay: on Windows claude_bin() prefers the npm install over PATH, so a `claude` on PATH would be
skipped and the real CLI spawned. The idea comes from nexu-io/open-design's mocks/mock-agent.mjs.

Which recording plays:
  1. HSWARM_MOCK_RECORDING=<name>        -> recordings/<name>.jsonl
  2. else the prompt's sha256, first 12  -> recordings/<hash12>.jsonl (the miss message names it)
A recording is Claude Code's own stream-json, one event per line, written to stdout as is, with
`${CWD}` replaced by the working directory (forward slashes, so it stays valid JSON). An optional
first line {"_mock": {"exit": N, "stderr": "..."}} sets the exit code and stderr and is not printed.
`--output-format json` prints only the final result event, the one-envelope shape.

HSWARM_MOCK_CAPTURE=<path> writes what the mock was given (argv, stdin, cwd, and which ANTHROPIC_*
variables were set - names only, never a value) so a test can pin the spawn side too.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

RECORDINGS = Path(__file__).resolve().parent.parent / "recordings"


def _flag(argv: list[str], name: str) -> str | None:
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None


def main() -> int:
    argv = sys.argv[1:]
    prompt = sys.stdin.buffer.read().decode("utf-8", "replace") if not sys.stdin.isatty() else ""
    cwd = os.getcwd().replace("\\", "/")
    capture = os.environ.get("HSWARM_MOCK_CAPTURE")
    if capture:
        seen = {
            "argv": argv,
            "stdin": prompt,
            "cwd": cwd,
            "anthropic_env": sorted(k for k in os.environ if k.startswith("ANTHROPIC_")),
            "base_url": os.environ.get("ANTHROPIC_BASE_URL"),
            "config_dir": os.environ.get("CLAUDE_CONFIG_DIR"),
        }
        Path(capture).write_text(json.dumps(seen, indent=1), encoding="utf-8")

    name = os.environ.get("HSWARM_MOCK_RECORDING") or hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
    path = RECORDINGS / f"{name}.jsonl"
    if not path.exists():
        sys.stderr.write(f"mock claude: no recording {path.name} (set HSWARM_MOCK_RECORDING or add {name}.jsonl)\n")
        return 2

    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    meta: dict = {}
    if lines and json.loads(lines[0]).get("_mock") is not None:
        meta = json.loads(lines.pop(0))["_mock"]
    lines = [line.replace("${CWD}", cwd) for line in lines]
    if _flag(argv, "--output-format") == "json":
        lines = [line for line in lines if json.loads(line).get("type") == "result"][-1:]

    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
    sys.stdout.flush()
    if meta.get("stderr"):
        sys.stderr.write(meta["stderr"])
    return int(meta.get("exit", 0))


if __name__ == "__main__":
    sys.exit(main())
