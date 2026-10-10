"""Offline: a task is credited the SMALLER of the median Claude sub-agent and its own tokens priced at the caller's
list rates, so a tiny one-call ask no longer counts as a whole sub-agent (the running total was inflated by them)."""
from __future__ import annotations

from hswarm import claude_usage, utilization

PROFILE = {"id": "p1", "basis": "Sonnet", "sample": 9, "pool_days": 14, "input": 1000, "cache_read": 200_000, "cache_5m": 20_000, "cache_1h": 0, "output": 4000, "requests": 6}
MODEL = "claude-opus-5-5"


def _row(tasks_tokens: list, orchestrator_model: str = MODEL, worker_usd: float = 0.0) -> dict:
    """A finished job row: one ok task per entry of `tasks_tokens`, each with its own usage buckets (None = no counts)."""
    results = [{"status": "ok", "usage": None if t is None else {"in_hit": t[0], "in_miss": t[1], "out": t[2]}} for t in tasks_tokens]
    return {"id": "j", "kind": "run", "machine": "m", "orchestrator_model": orchestrator_model, "tasks": len(results), "ok": len(results),
            "worker_usd": worker_usd, "task_tokens": utilization._answered_tokens(results)}


def test_a_small_ask_is_credited_its_own_tokens_at_the_callers_model_not_the_median():
    # One 2,400-token ask (2,000 cache hits, 400 misses, 100 output), as the ledger records it.
    row = _row([[2000, 400, 100]], worker_usd=0.00003)
    own = claude_usage.price_tokens(MODEL, {"input": 400, "cache_read": 2000, "output": 100}, prompt_tokens=2400)
    median = claude_usage.price_tokens(MODEL, PROFILE)

    est = utilization.estimate(row, PROFILE)

    assert own < median / 10  # the premise: the task is a small fraction of a sub-agent
    assert est["est_usd"] == round(own, 6)
    assert est["est_usd"] < median
    assert est["per_agent_usd"] == round(median, 6)  # the median is still reported beside it
    assert est["saved_usd"] == round(own - 0.00003, 6)
    assert est["est_low_usd"] <= est["est_usd"]  # the low estimate never claims more than the job's own tasks
    assert "capped at its own tokens" in est["basis"]


def test_a_large_task_is_still_capped_at_the_median_sub_agent():
    # 2M input tokens on one task: its own cost is far above one median sub-agent, so the median stands.
    row = _row([[0, 2_000_000, 1000]])
    median = claude_usage.price_tokens(MODEL, PROFILE)
    own = claude_usage.price_tokens(MODEL, {"input": 2_000_000, "cache_read": 0, "output": 1000}, prompt_tokens=2_000_000)
    assert own > median

    est = utilization.estimate(row, PROFILE)

    assert est["est_usd"] == round(median, 6)


def test_a_task_with_no_token_counts_keeps_the_median():
    row = _row([None, [2000, 400, 100]])
    median = claude_usage.price_tokens(MODEL, PROFILE)
    own = claude_usage.price_tokens(MODEL, {"input": 400, "cache_read": 2000, "output": 100}, prompt_tokens=2400)

    est = utilization.estimate(row, PROFILE)

    assert est["est_usd"] == round(median + own, 6)  # the uncounted task is a whole median; the counted one is its own size
