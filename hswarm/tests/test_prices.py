"""The shared price file (data/prices.json) read through hswarm/prices.py, and the parity fixture that
server/tests/pricing-parity.test.ts prices with the TypeScript reader."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hswarm import claude_usage, config, prices

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "price_parity.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["model"] + (f"-prompt-{c['prompt_tokens']}" if "prompt_tokens" in c else ""))
def test_parity_fixture_prices_to_the_cent(case):
    got = prices.cost(case["model"], case["tokens"], prompt_tokens=case.get("prompt_tokens", 0))
    if case["usd"] is None:
        assert got is None
    else:
        assert round(got * 100) == round(case["usd"] * 100)


def test_opus_5_5_is_its_own_row_not_opus_5():
    # Prefix matching priced it as claude-opus-5 ($5/$25, $0.50 cache read), 81% too high.
    p = prices.price_for("claude-opus-5-5")
    assert (p["input"], p["output"], p["cache_read"]) == (4, 20, 0.2)
    assert claude_usage.price_request("claude-opus-5-5", {"cache_read_input_tokens": 1_000_000}) == pytest.approx(0.2)
    assert prices.price_for("claude-opus-5")["cache_read"] == pytest.approx(0.5)


def test_an_unlisted_id_is_unpriced_never_a_prefix_guess():
    assert prices.price_for("claude-opus-5-9") is None
    assert prices.price_for("opus") is None
    assert claude_usage.price_request("claude-opus-5-9", {"input_tokens": 10}) is None


def test_one_transcript_request_prices_haiku_5_5_by_its_own_prompt():
    # The savings scan prices request by request: a 150k-token prompt pays the over-100k tier, a 50k one the first.
    long = {"cache_read_input_tokens": 150_000, "output_tokens": 1_000}
    assert claude_usage.price_request("claude-haiku-5-5", long) == pytest.approx((150_000 * 0.05 + 1_000 * 2.5) / 1e6)
    short = {"cache_read_input_tokens": 50_000, "output_tokens": 1_000}
    assert claude_usage.price_request("claude-haiku-5-5", short) == pytest.approx((50_000 * 0.01 + 1_000 * 0.5) / 1e6)


def test_a_zero_cache_write_is_a_real_rate():
    assert prices.price_for("gpt-5.5")["cache_write_5m"] == 0


def test_provider_files_resolve_price_ref_from_the_shared_file():
    config.reload()
    assert config.price("rank:claude-opus-5-5:direct") == {"hit": 0.2, "miss": 4.0, "out": 20.0, "write": 5.0}
    assert config.price("rank:claude-sonnet-5-5-low:direct") == {"hit": 0.1, "miss": 2.0, "out": 10.0, "write": 2.5}
    # Haiku 5.5's long-prompt tier reaches the registry, and one call's own prompt picks it (an effort variant too).
    haiku = "rank:claude-haiku-5-5-low:direct"
    assert config.price(haiku) == {"hit": 0.01, "miss": 0.1, "out": 0.5, "write": 0.125}
    assert config.price(haiku, prompt_tokens=100_000) == config.price(haiku)
    assert config.price(haiku, prompt_tokens=100_001) == {"hit": 0.05, "miss": 0.5, "out": 2.5, "write": 0.625}
    assert config.cost_usd(haiku, 150_000, 0, 1_000, prompt_tokens=150_000) == pytest.approx((150_000 * 0.05 + 1_000 * 2.5) / 1e6)
    peak = config.MODELS["deepseek-flash"]["peak"]
    assert peak == {"hit": 0.006, "miss": 0.3, "out": 1.2}
    assert config.PEAK_WINDOWS == ((1, 4), (6, 10))
