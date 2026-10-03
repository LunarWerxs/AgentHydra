"""The goal check at the stop boundary: a task's `done_when` condition, read by a separate tool-free call.

WHY: a worker that stops calling tools declares itself done, and "tests pass" with no test run behind it
reads exactly like the real thing to an orchestrator skimming 200 answers. With `done_when` set, a second
call with no tools and a fresh context reads the transcript tail against the condition and must find the
proof there (an `exit=0` line, the file content, the count) before the answer is accepted. It answers:

- ok          the transcript proves the condition; the answer stands.
- block       not proven yet; the reason goes back to the worker as a user turn and the loop continues,
              at most `done_when_max_blocks` times in a row, after which the task ends as an error that
              says the goal was not met (the answer is kept).
- impossible  the condition cannot be met from here; the task ends as an error with the reason.

An evaluator that fails (a provider error, an unreadable verdict) hands the answer back unchanged with
`goal.verdict = "unchecked"`: the check is a brake, never a reason to lose the worker's work.
The pattern follows shareAI-lab/learn-claude-code s17_goal_loop (MIT); written fresh for hswarm.
Nothing here talks to the network: agent.py makes the call and this module builds and reads it.
"""
from __future__ import annotations

import json

VERDICTS = ("ok", "block", "impossible")
DEFAULT_MAX_BLOCKS = 3
TAIL_CHARS = 24_000  # the transcript tail the evaluator reads; the final answer is always included in full
TOOL_OUTPUT_CHARS = 1_500  # each tool result, cut: the proof is usually an exit code or a few lines

SYSTEM = """You are an independent goal checker for an autonomous worker. You have no tools and cannot run anything.

You get a GOAL (a checkable condition), the worker's task, the tail of its transcript (its messages, the tools it called and what they returned) and the answer it claims is final. Decide whether the TRANSCRIPT PROVES the goal is met.

Rules:
- Only tool results count as proof: an exit code, a file's content, a command's output. The worker's own words ("tests pass", "fixed") are claims, not evidence.
- ok: the proof is in the transcript. block: it is not, or it shows the goal unmet; the reason must name the missing proof or the next concrete step. impossible: the goal cannot be met from here (the thing does not exist, it contradicts the task, the tools cannot reach it).
- Call submit_result exactly once with verdict and reason. Keep the reason to one or two sentences."""

SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": list(VERDICTS)},
        "reason": {"type": "string", "description": "why: the proof found, the proof missing, or why it cannot be met"},
    },
    "required": ["verdict", "reason"],
}


def _render(messages: list[dict]) -> str:
    """The worker's turns after the system prompt and the task, as plain text the evaluator can read."""
    lines: list[str] = []
    for m in messages[2:]:
        role, content = m.get("role"), m.get("content")
        text = content if isinstance(content, str) else ""
        if role == "assistant":
            if text.strip():
                lines.append(f"[worker] {text.strip()}")
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                lines.append(f"[worker called] {fn.get('name')}({str(fn.get('arguments') or '')[:400]})")
        elif role == "tool":
            out = text.strip()
            lines.append("[tool result] " + (out if len(out) <= TOOL_OUTPUT_CHARS else out[:TOOL_OUTPUT_CHARS] + " ...[cut]"))
        elif role == "user" and text.strip():
            lines.append(f"[orchestrator] {text.strip()}")
    return "\n".join(lines)


def evaluator_messages(done_when: str, task_prompt: str, messages: list[dict], answer: str) -> list[dict]:
    """The evaluator's own conversation: its system prompt, then the goal, the task, the transcript tail, the answer."""
    body = _render(messages)
    if len(body) > TAIL_CHARS:
        body = "...[earlier turns cut]\n" + body[-TAIL_CHARS:]
    prompt = (f"GOAL:\n{done_when.strip()}\n\nTASK:\n{task_prompt.strip()[:4000]}\n\nTRANSCRIPT TAIL:\n{body or '(no tool calls)'}"
              f"\n\nANSWER THE WORKER CLAIMS IS FINAL:\n{answer.strip() or '(empty)'}")
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]


def read_verdict(tool_calls: list[dict], content: str) -> tuple[str, str]:
    """(verdict, reason) from the evaluator's reply: the submit_result call, or a bare JSON object in its text.
    Raises ValueError when neither carries a known verdict, so the caller records the check as unchecked."""
    raw = (tool_calls[0].get("function") or {}).get("arguments") if tool_calls else (content or "").strip()
    try:
        d = json.loads(raw or "")
    except ValueError as e:
        raise ValueError(f"unreadable verdict: {str(raw)[:200]}") from e
    verdict = str((d or {}).get("verdict") or "").strip().lower() if isinstance(d, dict) else ""
    if verdict not in VERDICTS:
        raise ValueError(f"unknown verdict {verdict!r}; expected one of {VERDICTS}")
    return verdict, str(d.get("reason") or "").strip()


def block_nudge(done_when: str, reason: str, blocks: int, max_blocks: int) -> str:
    """The user turn a block sends back: what is missing, and that the proof has to come from a tool."""
    return (f"Not done yet (goal check {blocks} of {max_blocks}): {reason or 'the transcript does not prove the goal'}\n"
            f"The goal is: {done_when.strip()}\n"
            "Keep working: produce the proof with your tools (run the command, read the file), then give your final answer.")
