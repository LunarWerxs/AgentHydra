"""Spending ceilings that hold BEFORE a call instead of after it, and the budget line a worker reads each turn.

WHY: the per-worker `max_cost_usd` and the per-job `budget_usd` were both checked after the turn (or the whole task)
that crossed them, so one turn could overshoot a worker's cap and a job with 64 workers in flight could overshoot its
budget by up to 64 turns. Here every api turn first RESERVES its worst case (the estimated prompt at the leg's highest
input rate, less what the previous reply reported as cached, which is held at the cache-hit rate, plus the output it
may write at the output rate) against every ceiling it answers to, and SETTLES the hold
to the exact ledger cost when the reply lands. A turn whose worst case does not fit gets a smaller output allowance,
and one that cannot fit even a small answer is never sent. Adapted from the reserve/settle idea in openai/openai-cookbook
articles/per_run_spending_controller_responses_api.md (MIT); written fresh for hswarm.

The live budget line and the one-time wrap-up checkpoint follow the budget-signal idea in Significant-Gravitas/AutoGPT
(MIT, ideas only): the worker is told what it has left every turn, and at `checkpoint_at` of its cap (or sooner, once
the turn after this one may not fit) it is asked to finish, so a worker that would have died at the cap hands back a
partial result instead of nothing.
"""
from __future__ import annotations

import asyncio
import json

from . import config

CHARS_PER_TOKEN = 3  # conservative: English runs ~4 chars a token, and json.dumps escapes non-ASCII to 6 chars each
MIN_TURN_TOKENS = 1024  # a turn that cannot afford this much output is not worth sending: it would come back empty
HELD_EPSILON_USD = 1e-9  # holds below this are rounding left by settle(), not a turn in flight
# An image part is billed per image (about 1,100 to 1,600 tokens on OpenAI, Anthropic and Gemini), not per base64
# character: counted as text, one 3 MB screenshot read as a million prompt tokens, and 228 tasks of one image job were
# refused at turn 0 with $0 spent (7 days to 2026-10-02).
IMAGE_TOKENS = 2000
# How long after a reply its reported cache tokens still discount the next reservation: Anthropic's prompt cache lives
# 5 minutes from its last read, and a turn planned later than this is priced as a full miss again.
CACHE_LIVE_S = 270.0

CHECKPOINT = ("Budget checkpoint: you have used {pct:.0f}% of your {what}. Finish the step you are on and start "
              "nothing new. Give your final answer now from what you have gathered{how}; if work remains, end it with up "
              "to 3 lines 'REMAINING: <item>' so the orchestrator can pick it up.")


class Budget:
    """One ceiling (a worker's max_cost_usd, or a job's budget_usd): money settled plus money held never exceeds it.

    No lock is needed: reserve() and settle() never await, so on the one asyncio loop each runs to completion
    before any other task can touch the same ceiling. A turn that fits what is SPENT but not what siblings still
    HOLD waits on freed() for one of them to settle, rather than being refused or shrunk for money not yet gone."""

    def __init__(self, limit_usd: float, name: str):
        self.limit_usd, self.name = float(limit_usd), name
        self.settled = 0.0
        self.held = 0.0
        self._waiters: list[asyncio.Future] = []

    def left(self) -> float:
        return self.limit_usd - self.settled - self.held

    def unspent(self) -> float:
        """What is left once every turn in flight is settled at nothing: the only room a refusal may be judged on."""
        return self.limit_usd - self.settled

    def reserve(self, usd: float) -> None:
        self.held += usd

    def settle(self, held: float, actual: float) -> None:
        """Replace a hold with what the turn really cost (the hold itself when the cost could not be measured)."""
        self.held = max(0.0, self.held - held)
        self.settled += actual
        waiters, self._waiters = self._waiters, []
        for f in waiters:
            if not f.done():
                f.set_result(None)

    def refund(self, usd: float) -> None:
        """Take back money settled at its hold for a turn cut off mid-call (settle_turn with no cost): the answer turn at
        a task's time wall (agent._answer_at_wall) is given back the cut turn's worst case. At most that one short turn
        lands over the cap, if the cut call was billed after all."""
        self.settled = max(0.0, self.settled - usd)

    async def freed(self) -> None:
        """Wait until some hold on this ceiling is settled or released."""
        f = asyncio.get_running_loop().create_future()
        self._waiters.append(f)
        await f


def top_rates(model: str, prompt: int = 0) -> dict | None:
    """The highest {hit, miss, out} USD per 1M this leg can charge: DeepSeek's peak rate whatever the clock says
    (a turn sent off-peak can land on-peak), the flat price elsewhere, a tiered model's (Haiku 5.5) tier for a
    `prompt`-token prompt. None when the model has no price on record."""
    try:
        m = config.MODELS[config.resolve_model(model)]
        return dict(m["peak"]) if m.get("peak") else config.price(model, prompt_tokens=prompt)
    except (KeyError, ValueError):
        return None


def prompt_tokens(messages: list[dict], tools: list[dict] | None) -> int:
    """An over-estimate of the next prompt: everything the provider will be sent, serialised, at CHARS_PER_TOKEN,
    with each image part counted as IMAGE_TOKENS instead of by its inlined bytes."""
    chars = len(json.dumps(messages)) + len(json.dumps(tools or []))
    images = 0
    for m in messages:
        for part in m.get("content") if isinstance(m.get("content"), list) else ():
            if isinstance(part, dict) and part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url") if isinstance(part.get("image_url"), dict) else part.get("image_url")
                images += 1
                if isinstance(url, str) and url.startswith("data:"):
                    chars -= len(url)
    return chars // CHARS_PER_TOKEN + 1 + images * IMAGE_TOKENS


def _input_usd(rates: dict, tokens: int, cached: int) -> float:
    """The next prompt's worst case in USD, `tokens` being its prompt_tokens(). `cached` tokens (what the previous
    reply on this leg reported as read from or written to the prompt cache, so the prefix the provider now holds) are
    priced at the hit rate, everything else at the leg's highest input rate.

    WHY: the whole prompt used to be held at max(miss, write), $5/M on Opus for a prefix that bills at $0.2/M. Over 7
    days to 2026-10-02 the held worst case was a median 2.26x the task's real mean turn, and of the 622 cost-cap
    kills that had spent anything, 58% were refused below the 0.8 checkpoint with a median 77% of the cap spent.
    Only REPORTED cache tokens are discounted: a leg that reports no hits (gemini-3.5-flash often does) keeps the
    full price, and the caller passes 0 wherever the next turn will not read that cache (agent._TurnBudget.cached_tokens).
    A cache that misses after all (a sticky key that rests or dies, a long 429 rest) can therefore overshoot a ceiling by
    one turn's (top rate - hit rate) x cached; worker.over_budget stops the task on that turn."""
    top = max(rates["miss"], rates["hit"], rates.get("write", 0.0))
    warm = min(max(int(cached), 0), tokens)
    return (warm * rates["hit"] + (tokens - warm) * top) / 1_000_000.0


def worst_turn_usd(model: str, messages: list[dict], tools: list[dict] | None, max_tokens: int, cached: int = 0) -> float:
    """The least the next turn can be reserved at: its prompt plus MIN_TURN_TOKENS of output. plan_turn refuses a
    turn this does not fit. 0 for an unpriced leg, which reserves nothing."""
    tokens = prompt_tokens(messages, tools)
    rates = top_rates(model, tokens)
    if rates is None:
        return 0.0
    return _input_usd(rates, tokens, cached) + min(MIN_TURN_TOKENS, max_tokens) * rates["out"] / 1_000_000.0


async def plan_turn(model: str, messages: list[dict], tools: list[dict] | None, max_tokens: int, ceilings: list[Budget], cached: int = 0) -> tuple[int, float] | str:
    """Reserve the next turn against every ceiling. Returns (the max_tokens to send, the USD held), or, when even
    MIN_TURN_TOKENS of output does not fit, the refusal to report. An unpriced leg reserves nothing: its cost is not
    measured, so it answers only to the after-the-fact checks. `cached` is the prompt-cache token count the previous
    reply on this leg reported, while that cache is still live (_input_usd says why it is priced apart).

    WHY refusal and shrinking look only at settled spend: at 64 workers released at once, siblings' holds alone can
    exceed a small budget_usd while almost nothing is spent. Judged against holds, most workers were refused at turn
    0 and the rest had max_tokens cut. Now a turn that fits the unspent money but not the unheld money waits for a
    sibling to settle, then re-plans (a settle may have spent more than expected)."""
    tokens = prompt_tokens(messages, tools)
    rates = top_rates(model, tokens)
    if rates is None or not ceilings:
        return max_tokens, 0.0
    input_usd = _input_usd(rates, tokens, cached)
    floor = min(MIN_TURN_TOKENS, max_tokens)
    while True:
        tightest = min(ceilings, key=lambda b: b.unspent())
        room = tightest.unspent() - input_usd
        out_tokens = max_tokens if rates["out"] <= 0 else min(max_tokens, int(room * 1_000_000.0 / rates["out"]))
        if room <= 0 or out_tokens < floor:
            worst = input_usd + floor * rates["out"] / 1_000_000.0
            return (f"{tightest.name} reached: the next turn's worst case ${worst:.4f} does not fit the ${max(tightest.unspent(), 0.0):.4f} "
                    f"left of ${tightest.limit_usd:.4f}, so it was not sent (spent ${tightest.settled:.4f})")
        hold = input_usd + out_tokens * rates["out"] / 1_000_000.0
        # Only a ceiling with a real hold on it can free room; float dust left by settle() must not park a turn forever.
        blocked = next((b for b in ceilings if b.left() < hold and b.held > HELD_EPSILON_USD), None)
        if blocked is None:
            for b in ceilings:
                b.reserve(hold)
            return out_tokens, hold
        await blocked.freed()  # it fits once siblings' holds settle; unspent() >= hold means someone holds the gap


def settle_turn(ceilings: list[Budget], hold: float, cost_usd: float | None) -> None:
    for b in ceilings:
        b.settle(hold, hold if cost_usd is None else cost_usd)


def release(ceilings: list[Budget], hold: float) -> None:
    """A turn the provider refused outright (an API error status) billed nothing: its hold is freed, not spent."""
    for b in ceilings:
        b.settle(hold, 0.0)


def status_line(worker: Budget | None, turn: int, max_turns: int, job: Budget | None) -> str:
    """The one line a worker reads at the tail of each turn. It goes in a trailing user message, never the system
    prompt, so the cached prefix stays byte-identical."""
    parts = []
    if worker is not None:
        parts.append(f"spent ${worker.settled:.4f} of ${worker.limit_usd:.4f} ({worker.settled / worker.limit_usd * 100:.0f}%)")
    parts.append(f"turn {turn + 1} of {max_turns}")
    if job is not None:
        parts.append(f"job budget left ${max(job.left(), 0.0):.4f}")
    return "<budget_status>" + "; ".join(parts) + "</budget_status>"


def checkpoint_due(worker: Budget | None, job: Budget | None, at: float, worst_usd: float = 0.0) -> float | None:
    """The share of the tighter ceiling spent, once it reaches `at` or once a ceiling has less than two turns of
    `worst_usd` (worst_turn_usd) unspent, whichever comes first (0 turns the checkpoint off); else None.

    WHY the second rule: a fixed 0.8 often came after the last turn that fit. The median refused turn's worst case
    was 38% of the cap, so 107 of 272 pre-turn refusals (tasks created since 2026-09-30T18:00Z) came before the
    checkpoint was ever given and 126 after it with no room left to answer. Under two turns of room means this
    turn fits and the next may not, which is the last moment the worker can still be asked."""
    if not at:
        return None
    ceilings = [b for b in (worker, job) if b is not None and b.limit_usd > 0]
    share = max((b.settled / b.limit_usd for b in ceilings), default=0.0)
    return share if share >= at or any(b.unspent() < 2 * worst_usd for b in ceilings) else None


def checkpoint_text(share: float, has_schema: bool, what: str = "spending budget") -> str:
    return CHECKPOINT.format(pct=share * 100, what=what, how=" by calling submit_result" if has_schema else "")
