"""Can this machine's swarm take work at all? One offline answer, cached where the routing gate reads it.

~/.hswarm/verdict.json is read by the agent_routing_gate hook (claude-memory home/hooks/agent_routing_gate.py):
a FRESH `usable: false` makes the gate stop recommending the swarm and accept a Claude fan-out that names its
model. Found 2026-09-21 on Jacob's PC: every hswarm_run errored "No deepseek API key found" in 0.0 s while the
gate kept sending every session there, because nothing it could read said so.

It judges the AUTO routes a plain hswarm_run takes (tool-using, tool-free, and cc's own), from the shared key
state and the keys' recorded input-tokens-per-minute limits (a cc leg no worker can start on is not usable) only - no network call, so the server can write it at start and a job can rewrite it when it ends in
NoUsableKey. A leg counts when its provider has a key that is not disabled; a resting (429) key still counts,
because a rate limit passes and a missing key does not. Fingerprint-free: no key, and no fingerprint, is written.
"""
from __future__ import annotations

import json
import os

from . import config, input_limit, keys
from .spec import now_iso

def path():
    return config.HOME / "verdict.json"  # read HOME at call time: tests redirect it


def _live_keys(provider: str) -> int:
    pool = keys.pool_for(provider)
    if pool is None:
        return 0
    return len(pool) - len(pool.disabled())


def compute() -> dict:
    from .selection import plan

    chains: dict[str, dict] = {}
    for chain, profile, backend, tools in (("tools", "code", "api", "read"), ("tool_free", "general", "api", "none"), ("cc", "code", "cc", "read")):
        legs = [c["model"] for c in plan(profile, tools=tools, backend=backend)["candidates"]]
        live = {leg: _live_keys(config.provider_of(leg)) for leg in legs}
        # A cc leg whose every live key's input-tokens-per-minute limit is under a worker's first turn cannot start one
        # task (input_limit.py): it is not usable, and the gate reads why, so it stops sending code work to cc.
        short = {leg: why for leg in legs if backend == "cc" and live[leg] > 0 and (why := input_limit.cc_short(leg))}
        chains[chain] = {"legs": legs, "usable_legs": [leg for leg in legs if live[leg] > 0 and leg not in short],
                         "live_keys": {config.provider_of(leg): n for leg, n in live.items()}}
        if short:
            chains[chain]["input_limit"] = short
    usable = any(chain["usable_legs"] for chain in chains.values())
    why = "" if usable else (
        "no key with credit on any leg of the auto routes (tools: " + ", ".join(chains["tools"]["legs"])
        + "; tool-free: " + ", ".join(chains["tool_free"]["legs"]) + "). Put a key where the runner looks "
        f"({config.SECRETS_DIR / '<provider>_api_keys'}, or the provider's env var), then `python -m hswarm doctor`")
    return {"ts": now_iso(), "usable": usable, "why": why, "chains": chains, "selection_policy": "published-benchmarks"}


def write(v: dict | None = None) -> dict:
    """Compute (unless given) and write atomically. Never raises: a verdict that cannot be written is simply absent,
    and the hook treats absent as "no news", never as dead."""
    v = v or compute()
    try:
        p = path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(v, indent=1), encoding="utf-8")
        os.replace(tmp, p)
    except OSError:
        pass
    return v
