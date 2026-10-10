"""The worker tool catalogue: presets and JSON schemas. Data only; the implementations are in tools.py."""
from __future__ import annotations

# outline + unfold sit in every preset that explores a repo (read, edit, all, jobs, the same place in each): a
# symbol map or one symbol's source costs a fraction of the whole-file read_file a cheap worker would otherwise pay.
PRESETS = {
    "read": ["read_file", "list_dir", "glob", "grep", "outline", "unfold"],
    "edit": ["read_file", "list_dir", "glob", "grep", "outline", "unfold", "write_file", "edit_file"],
    "all": ["read_file", "list_dir", "glob", "grep", "outline", "unfold", "write_file", "edit_file", "bash"],
    # Privilege split: the worker reads, and its only way to change anything is to queue a proposal that a
    # judge screens and the orchestrator applies (proposals.py). For work over untrusted input.
    "propose": ["read_file", "list_dir", "glob", "grep", "propose"],
    # "all" plus background shell jobs, for a task that runs a build, a test watcher or a dev server.
    # Its own preset so the measured "all" arm keeps the tool list it was benchmarked with.
    "jobs": ["read_file", "list_dir", "glob", "grep", "outline", "unfold", "write_file", "edit_file", "bash", "bash_start", "job_wait", "job_tail", "job_input", "job_kill"],
    # read plus a GET-only web read: no write tool and no shell, so the only way out is read_url, whose
    # every host is gated by the batch's web_hosts (web.py).
    "web": ["read_file", "list_dir", "glob", "grep", "read_url"],
    "none": [],
}

# Tools whose reach goes past the sandbox roots; web.py gates them per host.
WEB_TOOLS = {"read_url"}

SPECS: dict[str, dict] = {
    "read_file": {
        "description": "Read a UTF-8 text file. Returns numbered lines. Use start_line/end_line for a slice of a large file. "
        "To read several files, pass them ALL in one call as paths (a list; each entry a path string, or an object with path "
        "and optional start_line/end_line): reading several files is one call, not one call per file.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "one file; omit when you pass paths"},
                "start_line": {"type": "integer", "description": "1-based, inclusive"},
                "end_line": {"type": "integer", "description": "1-based, inclusive"},
                "paths": {
                    "type": "array",
                    "description": "several files in one call, each under its own header; use this instead of repeated read_file calls",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "start_line": {"type": "integer", "description": "1-based, inclusive"},
                            "end_line": {"type": "integer", "description": "1-based, inclusive"},
                        },
                        "required": ["path"],
                    },
                },
            },
        },
    },
    "write_file": {
        "description": "Create or overwrite a text file with the given content. Creates parent directories. "
        "Overwriting an existing file requires having read it with read_file first, and fails if it changed since.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    "edit_file": {
        "description": "Replace a substring in a file. old_string must occur exactly once unless replace_all is true. "
        "In a file you have read, an old_string with indentation/whitespace drift is matched to its block line by line "
        "and new_string is reindented to it. Fails if the file changed since you read it.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean", "default": False},
                "near_line": {"type": "integer", "description": "1-based line old_string is near; picks between several matches"},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    "list_dir": {
        "description": "List entries of a directory (directories end with /). depth 1 by default, max 3.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "default": "."}, "depth": {"type": "integer", "default": 1}},
        },
    },
    "glob": {
        "description": "Find files by glob pattern (e.g. '**/*.py'). Returns relative paths, newest first, max 500.",
        "parameters": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "default": "."}},
            "required": ["pattern"],
        },
    },
    "grep": {
        "description": "Regex search file contents (ripgrep). Returns 'path:line:text' lines, max 200.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string", "default": "."},
                "glob": {"type": "string", "description": "only files matching this glob, e.g. '*.ts'"},
                "ignore_case": {"type": "boolean", "default": False},
                "max_results": {"type": "integer", "default": 200},
            },
            "required": ["pattern"],
        },
    },
    # outline + unfold: symbol-level reads, so a worker never pays for a whole file to find one function.
    "outline": {
        "description": (
            # No language list: a file it cannot outline gets an error naming the languages it can, and the fallback.
            "Folded map of one code file: every class, function and method, or Markdown heading, with its line range, "
            "nested by indentation, plus what reading the whole file would cost in tokens. Use it before read_file on "
            "any file you do not need whole, then unfold the symbol you want or read_file that line range."
        ),
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
    "unfold": {
        "description": (
            "The full source of one named symbol from a code file, as numbered lines with its doc comment and "
            "decorators. symbol is a bare name ('parse') or dotted when nested ('Parser.parse'); the first match is "
            "returned and any other matches are listed."
        ),
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "symbol": {"type": "string"}},
            "required": ["path", "symbol"],
        },
    },
    "bash": {
        "description": "Run a shell command (POSIX sh via Git Bash on Windows) in the task directory. Known-noisy commands (installs, test runs, builds) have their noise filtered out, keeping errors and summaries; prefix the command with HSWARM_RAW=1 for the unfiltered output. Output is capped; long-running or interactive commands will be killed at the timeout, and anything the command leaves running in the background ends with the call (a server or watcher belongs in bash_start).",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}, "timeout_s": {"type": "integer", "default": 120}},
            "required": ["command"],
        },
    },
    "propose": {
        "description": "Queue a file change for review instead of making it. Nothing is written now: a separate screen later decides "
                       "what is applied. kind write_file needs content; kind edit_file needs old_string (exact, unique unless "
                       "replace_all) and new_string. Say why in reason.",
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["write_file", "edit_file"]},
                "path": {"type": "string"},
                "reason": {"type": "string", "description": "why the task needs this change, one line"},
                "content": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean", "default": False},
            },
            "required": ["kind", "path", "reason"],
        },
    },
    "bash_start": {
        "description": "Start a shell command in the background and return a job id at once. For builds, test runs and servers that take longer than a turn. Output is cleaned of colour codes and progress-bar redraws. The job is killed when the task ends.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "stdin": {"type": "boolean", "default": False, "description": "keep stdin open so job_input can write to it"},
            },
            "required": ["command"],
        },
    },
    "job_wait": {
        "description": "Wait up to timeout_s (max 600) for a job to finish, then return its status and the output it produced since the last job_wait.",
        "parameters": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}, "timeout_s": {"type": "integer", "default": 30}},
            "required": ["job_id"],
        },
    },
    "job_tail": {
        "description": "Read a job's output without waiting: the last `lines` lines, or a window from a character `offset`. stream is all (stdout and stderr interleaved), stdout or stderr.",
        "parameters": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string"},
                "lines": {"type": "integer", "default": 50},
                "offset": {"type": "integer", "description": "character offset to read from; the reply names the next one"},
                "stream": {"type": "string", "enum": ["all", "stdout", "stderr"], "default": "all"},
            },
            "required": ["job_id"],
        },
    },
    "job_input": {
        "description": "Send text to a job's stdin (the job must have been started with stdin=true). Include the newline a prompt expects; close=true sends end-of-file after it.",
        "parameters": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}, "text": {"type": "string"}, "close": {"type": "boolean", "default": False}},
            "required": ["job_id", "text"],
        },
    },
    "job_kill": {
        "description": "Stop a job and everything it started; returns its final status.",
        "parameters": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
    "read_url": {
        "description": "Read a web page with one GET: HTML comes back as markdown, a feed as one line per entry, a YouTube "
                       "video as its subtitles, a GitHub file or repo as the raw file or README. Only hosts this batch "
                       "allows are fetched; any other host returns APPROVAL NEEDED instead - carry on without it and "
                       "name the host you needed in your answer.",
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "an absolute http(s) URL"}},
            "required": ["url"],
        },
    },
    # Not in any preset: agent.run_api_task adds it to every worker that has a sandbox tool, since only those
    # produce output that can be capped or cleared (tools.spill, context.py).
    "fetch_output": {
        "description": "Return a char range of an output that was cut short or cleared to save context. "
                       "Use the id, start and end printed in the '[omitted ...]' or '[... cleared ...]' marker.",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "the 16-hex-char id from the marker"},
                "start": {"type": "integer", "default": 0, "description": "0-based char offset, inclusive"},
                "end": {"type": "integer", "description": "char offset, exclusive; omit for the rest"},
            },
            "required": ["id"],
        },
    },
}
SPILL_TOOL = "fetch_output"

IGNORED_DIRS = {".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".claude", ".next", ".turbo"}


def names_of(tools: list[str] | str | None) -> frozenset[str]:
    """The tool NAMES a preset or comma list stands for. The spawn envelope and the cc backend both compare tool
    sets, and a preset name ("read") and its spelled-out list must compare as the same thing."""
    if tools is None:
        tools = "read"
    names = PRESETS.get(tools, [n.strip() for n in tools.split(",") if n.strip()]) if isinstance(tools, str) else [str(n) for n in tools]
    unknown = sorted(set(names) - set(SPECS))
    if unknown:
        raise ValueError(f"unknown tools {unknown}; known: {sorted(SPECS)} or presets {sorted(PRESETS)}")
    return frozenset(names)


def tool_names(names: list[str] | str | None) -> list[str]:
    """A preset name, a comma list or a list, as the tool names it stands for."""
    if names is None:
        names = "read"
    if isinstance(names, str):
        names = PRESETS.get(names, [n.strip() for n in names.split(",") if n.strip()])
    return list(names)


def specs_for(names: list[str] | str | None, extra: list[dict] | None = None) -> list[dict]:
    names = tool_names(names)
    out = []
    for n in names:
        if n not in SPECS:
            raise ValueError(f"unknown tool {n!r}; known: {sorted(SPECS)} or presets {sorted(PRESETS)}")
        out.append({"type": "function", "function": {"name": n, **SPECS[n]}})
    return out + list(extra or [])
