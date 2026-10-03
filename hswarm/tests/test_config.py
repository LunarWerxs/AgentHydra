"""Offline: pricing windows, model aliases, usage parsing, key handling. No network."""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.client import Usage, _body  # noqa: E402

UTC = dt.timezone.utc


def test_peak_windows_weekday():
    mon_0130 = dt.datetime(2026, 9, 14, 1, 30, tzinfo=UTC)  # Monday
    assert config.is_peak(mon_0130) is True
    assert config.is_peak(dt.datetime(2026, 9, 14, 5, 0, tzinfo=UTC)) is False
    assert config.is_peak(dt.datetime(2026, 9, 14, 7, 0, tzinfo=UTC)) is True
    assert config.is_peak(dt.datetime(2026, 9, 14, 12, 0, tzinfo=UTC)) is False


def test_weekend_is_never_peak():
    assert config.is_peak(dt.datetime(2026, 9, 12, 2, 0, tzinfo=UTC)) is False


def test_cost_off_peak_is_half():
    peak = dt.datetime(2026, 9, 14, 2, 0, tzinfo=UTC)
    off = dt.datetime(2026, 9, 14, 12, 0, tzinfo=UTC)
    a = config.cost_usd("deepseek-flash", 1_000_000, 1_000_000, 1_000_000, peak)
    b = config.cost_usd("deepseek-flash", 1_000_000, 1_000_000, 1_000_000, off)
    assert a == pytest.approx(0.006 + 0.30 + 1.20)
    assert b == pytest.approx(a / 2)


def test_next_rate_change():
    when, state = config.next_rate_change(dt.datetime(2026, 9, 14, 5, 0, tzinfo=UTC))
    assert when == dt.datetime(2026, 9, 14, 6, 0, tzinfo=UTC) and state == "peak"
    when, state = config.next_rate_change(dt.datetime(2026, 9, 18, 9, 0, tzinfo=UTC))
    assert when == dt.datetime(2026, 9, 18, 10, 0, tzinfo=UTC) and state == "off-peak"


def test_model_aliases():
    assert config.resolve_model("flash") == "deepseek-flash"
    assert config.resolve_model("deepseek-v4-flash") == "deepseek-flash"
    assert config.resolve_model("pro") == "deepseek-v4-pro"
    with pytest.raises(ValueError):
        config.resolve_model("gpt-9")


def test_usage_from_api_shapes():
    u = Usage.from_api({"prompt_tokens": 300, "completion_tokens": 20, "prompt_cache_hit_tokens": 256, "prompt_cache_miss_tokens": 44, "completion_tokens_details": {"reasoning_tokens": 5}})
    assert (u.hit, u.miss, u.out, u.reasoning) == (256, 44, 20, 5)
    u2 = Usage.from_api({"prompt_tokens": 300, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 100}})
    assert (u2.hit, u2.miss) == (100, 200)


def test_chat_body_keeps_only_given_options():
    b = _body("deepseek-flash", [{"role": "user", "content": "x"}], tools=None, tool_choice=None, max_tokens=16000, thinking=False, reasoning_effort="low", response_format=None, user="", stop=None)
    assert b == {"model": "deepseek-flash", "messages": [{"role": "user", "content": "x"}], "thinking": {"type": "disabled"}, "max_tokens": 16000, "reasoning_effort": "low"}
    assert "thinking" not in _body("m", [], thinking=None) and "max_tokens" not in _body("m", [], max_tokens=None)


def test_key_status_never_leaks(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-unit-test-secret-value")
    st = config.key_status()
    assert st["present"] and st["length"] == len("sk-unit-test-secret-value")
    assert "unit-test-secret-value" not in json.dumps(st)  # fingerprints, counts and source names only, never the value


def test_the_home_key_file_is_the_last_source(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SECRETS_DIR", tmp_path)
    (tmp_path / "deepseek_api_key").write_text("sk-test-not-a-real-key-0000000000\n", encoding="utf-8")
    assert config.key_sources("deepseek")[-1][0] == "<home>/secrets/deepseek_api_key"
    assert config.all_keys("deepseek") == ["sk-test-not-a-real-key-0000000000"]
