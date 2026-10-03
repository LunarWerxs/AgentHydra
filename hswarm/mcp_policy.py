"""The least-authority table for hswarm's own MCP tools: one class per tool, and everything else derived from it.

WHY: an MCP client decides what to auto-approve from a tool's annotations (readOnlyHint, destructiveHint, ...), and
hswarm advertised none, so every client had to guess. Written by hand beside each tool, a hint drifts from what the
body does: hswarm_doctor LOOKS read-only, yet its per-key balance probe parks and clears keys (client.balances). So
each tool names one class here, its hints are derived from the class, the server registers a tool only through this
table (a tool with no entry fails at import), and HSWARM_MCP_CLASSES narrows which classes a server will run: the same
table that advertises a tool as read-only is the one that gates it.

The shape follows RuView's TOOL_POLICY and mcpAnnotations (ruvnet/RuView harness/ruview/src/policy.js, MIT; idea
only, written fresh for hswarm).
"""
from __future__ import annotations

import os
from types import MappingProxyType

from mcp.types import ToolAnnotations

# class -> (read_only, destructive, idempotent, open_world). open_world: it reaches a provider or a git remote.
CLASSES = MappingProxyType({
    "read": (True, False, True, False),             # reads ~/.hswarm and the repo, changes nothing
    "external-read": (True, False, True, True),     # a free GET at a provider; nothing local changes
    "local-write": (False, False, True, False),     # writes hswarm's own state on this machine (the savings DB)
    "cache-refresh": (False, False, True, True),    # pulls a provider's catalogue into a local cache file
    "control": (False, True, True, False),          # stops work already paid for
    "execute": (False, False, False, True),         # runs workers or asks at a provider: spends money every call
    "credential-write": (False, True, True, True),  # parks, clears or disables API keys in the shared pool
    "external-write": (False, False, False, True),  # commits and pushes to this repo's sync branch
})

# Worst case per tool: a tool whose arguments can make it write is classed by that write, never by its default.
TOOL_POLICY = MappingProxyType({
    "hswarm_run": "execute",
    "hswarm_ask": "execute",
    "hswarm_decide": "execute",
    "hswarm_panel": "execute",
    "hswarm_apply_proposals": "execute",   # one judge call per task, then writes what passed into the task's folders
    "hswarm_select": "read",
    "hswarm_loop": "execute",
    "hswarm_review": "execute",
    "hswarm_doubt": "execute",
    "hswarm_web": "local-write",           # allow/block edits the machine's saved host lists
    "hswarm_status": "read",
    "hswarm_results": "read",
    "hswarm_jobs": "read",
    "hswarm_usage": "read",
    "hswarm_bench": "read",
    "hswarm_cancel": "control",
    "hswarm_cost": "external-read",         # balance=true reads the provider's /user/balance
    "hswarm_savings": "local-write",        # include_today records today's partial figure
    "hswarm_models": "cache-refresh",       # refresh= pulls a live catalogue into ~/.hswarm
    "hswarm_doctor": "credential-write",    # the per-key balance probe parks and clears keys
    "hswarm_keys": "credential-write",      # enable / disable, and probe clears a topped-up key
    "hswarm_sync": "external-write",
})

ENV = "HSWARM_MCP_CLASSES"


def policy_for(tool: str) -> str:
    if tool not in TOOL_POLICY:
        raise KeyError(f"MCP tool {tool} has no entry in mcp_policy.TOOL_POLICY; give it a class before it can be served")
    return TOOL_POLICY[tool]


def annotations_for(tool: str) -> ToolAnnotations:
    read_only, destructive, idempotent, open_world = CLASSES[policy_for(tool)]
    # The wire names, not the attribute names: mcp 1.x spells the fields camelCase, 2.x snake_case with these aliases.
    return ToolAnnotations.model_validate({"readOnlyHint": read_only, "destructiveHint": destructive,
                                           "idempotentHint": idempotent, "openWorldHint": open_world})


def allowed_classes() -> set[str] | None:
    """The classes this server may run (HSWARM_MCP_CLASSES, comma-separated), or None for all of them."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return None
    wanted = {c.strip() for c in raw.split(",") if c.strip()}
    unknown = wanted - set(CLASSES)
    if unknown:
        # A typo must not widen the grant or silently shut everything; refuse every tool and name it.
        raise ValueError(f"{ENV} names unknown classes {sorted(unknown)}; known: {sorted(CLASSES)}")
    return wanted


def refusal(tool: str) -> str | None:
    """Why this server will not run `tool` right now, or None when its class is granted."""
    try:
        allowed = allowed_classes()
    except ValueError as e:
        return str(e)
    cls = policy_for(tool)
    if allowed is None or cls in allowed:
        return None
    return f"{tool} is class {cls!r}, which this hswarm server does not grant ({ENV}={','.join(sorted(allowed))})"
