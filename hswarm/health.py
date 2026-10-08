"""Doctor and cost: the two read-only reports the MCP server and the CLI both expose."""
from __future__ import annotations

import asyncio
import os
from shutil import which

from . import breaker, config, faults, keys, model_watch, shared, shellpolicy, verdict
from . import web
from .broker import BROKER_ENV
from .claude_env import claude_bin
from .jobs import JobManager, route_health
from .ledger import ledger_summary
from .procs import find_bash


async def doctor(m: JobManager, verbose: bool = False) -> dict:
    """Key present (never the value), models reachable, balance, claude/rg/bash binaries, home dir, rate window.
    verbose=True adds the per-key rows (the pools' keys needing attention, and every DeepSeek key's balance)."""
    from . import procgate

    out: dict = {"home": str(config.HOME), "key": config.key_status(), "rate_now": "peak" if config.is_peak() else "off-peak", "procs": procgate.status(),
                 "providers": config.providers_status(), "roles": dict(config.ROLES),
                 "config": f"{config.PROVIDERS_DIR} ({len(list(config.PROVIDERS_DIR.glob('*.toml')))} provider file(s) of your own; docs/PROVIDERS.md)"}
    await _reachable(m, out["providers"])
    try:
        out["claude_bin"] = claude_bin()
    except RuntimeError as e:
        out["claude_bin"] = f"MISSING: {e}"
    out["rg"] = which("rg") or "MISSING (grep tool falls back to Python)"
    # find_bash(), not which("bash"): the bash TOOL probes Git's install dir and rejects the WSL stub,
    # so a bare PATH lookup answers MISSING for a bash the workers would have used. Measured 2026-09-16:
    # the MCP server (launched by Claude Code with a slimmer PATH) reported bash MISSING while the CLI in
    # the same checkout reported it found. A doctor that disagrees with the runtime is worse than no doctor.
    out["bash"] = find_bash() or "MISSING (bash tool unavailable)"
    # A rules overlay whose own examples fail refuses every bash call; say so here, not in a worker's transcript.
    out["shell_policy"] = shellpolicy.status()
    # Whether bash/write_file/edit_file answer to an out-of-process policy (broker.py); the command, never probed.
    out["permission_broker"] = os.environ.get(BROKER_ENV, "").strip() or "off (bash and writes run unchecked inside the sandbox roots)"
    # read_url's standing host policy and which backend serves each channel now, offline: a missing yt-dlp or a
    # backend that just failed is said here, the way agent-reach's doctor names the backend per platform.
    out["web"] = web.report()
    # The stored model-watch scan (model_watch.py), one line, offline: how old it is and what it has not routed yet.
    out["model_watch"] = model_watch.summary()
    # Every provider's pool, offline and in one place: which keys are ready, resting, or in the disabled slot.
    # `hswarm keys probe` (or hswarm_keys action="probe") is the one that spends a GET and heals a topped-up key.
    # BOUNDED, like hswarm_keys' default list: the verbose report is one row per key, and with 1,700+ keys
    # that made the doctor a 989k-character answer (measured 2026-09-20) that no MCP client will show.
    # `hswarm_keys verbose=true` is the spelling for every row. Even bounded, the rows were 74,801 of the doctor's
    # 82,669 characters on one line (2026-10-06, mostly keys in the disabled slot), so by default it is counts only.
    out["key_pools"] = keys.report(verbose=False, counts_only=not verbose)
    # The egress receipts' hash chain (egress.py): a tampered or truncated ledger shows up here, not only on request.
    from . import egress

    # Incremental and off the loop: only the receipts appended since this process last looked are read again.
    out["egress_ledger"] = {**await asyncio.to_thread(egress.verify, incremental=True), "receipts_not_written_this_process": egress.FAILURES}
    # What AUTO can serve right now, per route, from the same offline state hswarm_run refuses a job on: a spent
    # free pool and a fallback with no credit are said HERE, not ten minutes into a job (2026-09-24). The routes are
    # AUTO's first picks for tool work and tool-free work on THIS machine's keys (dispatch.first_choice).
    out["routes_now"] = {m: route_health(m) for m in dict.fromkeys((config.default_model_for("read"), config.default_model_for("none")))}
    dead = [m for m, h in out["routes_now"].items() if not h["serves"]]
    if dead:
        out["routes_warning"] = (f"no leg can serve {', '.join(dead)} now: hswarm_run refuses those jobs until a key rests out or "
                                 "is topped up, or a key is added for a provider whose models have published scores (hswarm ui)")
    # The one-line answer to "can this swarm take work at all", cached for the agent_routing_gate hook (verdict.py).
    # `key` above is the DeepSeek key alone; a machine without one can still serve every auto route.
    out["verdict"] = verdict.write()
    # Legs this process saw failing at the host, tried last until a probe finds them back (breaker.py).
    out["breakers_open"] = breaker.report()
    # The code this process runs, and whether a source file changed on disk since it loaded (shared.behind).
    out["code"] = {**shared.code_stamp(), **({"behind": behind} if (behind := shared.behind()) else {})}
    # An armed fault spec (faults.py) fails real calls on purpose: one left in the environment must show here.
    try:
        if armed := faults.armed():
            out["faults_armed"] = armed
    except ValueError as e:
        out["faults_armed"] = f"UNREADABLE: {e}"
    if out["key"]["present"]:
        await _default_pool(m, out, verbose)
    return out


async def _reachable(m: JobManager, providers: dict) -> None:
    """Each keyed provider other than the default answers its model list into its row of `providers`."""
    for name, st in providers.items():
        if name != config.DEFAULT_PROVIDER and st["keys"] and config.PROVIDERS[name].get("models_path"):
            try:
                c = m.client_for(st["models"][0]) if st["models"] else None
                st["reachable"] = (await c.models())[:20] if c else f"no model registered; add one under [models.<name>] in {config.user_file(name)}"
            except Exception as e:  # noqa: BLE001 - one provider down must not hide the rest
                st["reachable"] = f"ERROR {type(e).__name__}: {e}"[:200]


async def _default_pool(m: JobManager, out: dict, verbose: bool) -> None:
    """The default provider's models, balance and per-key balances, added to `out`."""
    try:
        out["models"] = await m.client.models()
        out["balance"] = await m.client.balance()
        rows = await m.client.balances()  # one row per key in the pool: fingerprint + balance, never the key
        if verbose:
            out["keys"] = rows
            out["key_pool"] = m.client.pool.status()
        off = [r["fingerprint"] for r in rows if r.get("usable") is False]
        out["keys_out_of_balance"] = off  # both consoles colour the key check by whether this is empty
        out["keys_note"] = (f"{len(off)} of {len(rows)} keys are out of credit and DISABLED - never retried with a real "
                            "request until a probe sees a top-up or `hswarm keys enable` says so"
                            if off else f"every one of the {len(rows)} keys has balance")
    except Exception as e:  # noqa: BLE001 - the report must come back even when the API is down
        out["api_error"] = f"{type(e).__name__}: {e}"


async def cost(m: JobManager, days: float = 1.0, balance: bool = True) -> dict:
    """Spend from the local ledger over the last N days, current rate, next rate change, and the account balance."""
    out = await asyncio.to_thread(ledger_summary, days)  # a file read: off the loop every chat's calls share
    if balance:
        try:
            out["balance"] = await m.client.balance()
        except Exception as e:  # noqa: BLE001
            out["balance_error"] = f"{type(e).__name__}: {e}"
    return out
