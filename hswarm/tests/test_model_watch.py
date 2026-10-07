"""model_watch: id normalization, each model's standing, the strengths and weaknesses rule, and a scan in which one
provider fails while the others still record."""
from __future__ import annotations

import asyncio

import pytest

from hswarm import client, model_watch


@pytest.mark.parametrize("raw, want", [
    ("GLM-5.3", "glm-5-3"),
    ("GLM-5.3-Flash", "glm-5-3-flash"),
    ("DeepSeek-V4.1-Flash", "deepseek-v4-1-flash"),
    ("DeepSeek-V4-Pro-0813", "deepseek-v4-pro"),
    ("Qwen3.8-27B-TEE", "qwen3-8-27b"),
    ("MiMo-V2.6-Pro-RL", "mimo-v2-6-pro"),
    ("Kimi-K3-TEE", "kimi-k3"),
    ("MiniMax-M3", "minimax-m3"),
    ("gpt-oss-120b", "gpt-oss-120b"),
    ("openai/gpt-6-astra", "gpt-6-astra"),
    ("gpt-6-astra-high", "gpt-6-astra-high"),
    ("  Example-Model-5.5  ", "example-model-5-5"),
])
def test_normalize_matches_the_provider_and_index_forms(raw, want):
    assert model_watch.normalize(raw) == want


def test_ids_of_takes_a_bare_list_or_a_data_object_and_drops_repeats():
    assert model_watch.ids_of(["example-a", {"id": "example-b"}, "example-a"]) == ["example-a", "example-b"]
    assert model_watch.ids_of({"data": [{"id": "example-c"}]}) == ["example-c"]
    assert model_watch.ids_of({"error": "nope"}) == []


ROUTES = {
    "example-route": {"provider": "example-a", "api_id": "Example-Alpha-1"},
    "rank:example-beta:example-b": {"provider": "example-b", "api_id": "example-beta-x", "benchmark_slug": "example-beta"},
}
POINTS = [{"slug": "example-alpha"}, {"slug": "example-beta"}]


def test_standing_follows_the_route_and_the_index():
    slugs = model_watch.index_slugs(POINTS)
    routed = model_watch.routed_for("example-a", ROUTES)
    assert model_watch.classify("example-alpha-1-TEE", routed, slugs) == "routed"
    assert model_watch.classify("example-alpha", routed, slugs) == "benchmarked_unrouted"
    assert model_watch.classify("example-gamma", routed, slugs) == "unbenchmarked"
    assert model_watch.classify("example-beta-x", model_watch.routed_for("example-b", ROUTES), slugs) == "routed"
    # a route on another provider serves nothing on this one
    assert model_watch.classify("example-alpha-1", model_watch.routed_for("example-c", ROUTES), slugs) == "unbenchmarked"


def test_merge_keeps_first_seen_and_marks_what_stopped_being_listed_gone():
    before = {"a": {"first_seen": "t1", "last_seen": "t1", "standing": "unbenchmarked"},
              "b": {"first_seen": "t1", "last_seen": "t1", "standing": "routed"}}
    out = model_watch.merge(before, {"a": "routed", "c": "unbenchmarked"}, "t2")
    assert out["a"] == {"first_seen": "t1", "last_seen": "t2", "standing": "routed"}
    assert out["c"] == {"first_seen": "t2", "last_seen": "t2", "standing": "unbenchmarked"}
    assert out["b"] == {"first_seen": "t1", "last_seen": "t1", "standing": "gone"}


def test_strengths_and_weaknesses_use_the_index_quartiles():
    # bench-x runs 1..5 over the index: its 25th percentile is 2 and its 75th is 4. critpt is under review and must not
    # count, though counted it would make p5 a weakness. bench-y has three scores, so it ranks nothing.
    points = [{"slug": f"p{i}", "scores": {"bench-x": float(i), "critpt": float(6 - i)}} for i in range(1, 6)]
    points[0]["scores"]["bench-y"] = 0.0
    points[1]["scores"]["bench-y"] = 50.0
    points[4]["scores"]["bench-y"] = 100.0
    points[4].update(input=8.0, output=4.0)
    out = model_watch.profile(points)
    assert out["p5"] == {"strengths": ["bench-x"], "weaknesses": [], "blended_usd_per_1m": 7.0}
    assert out["p1"] == {"strengths": [], "weaknesses": ["bench-x"], "blended_usd_per_1m": None}
    assert out["p3"] == {"strengths": [], "weaknesses": [], "blended_usd_per_1m": None}


class FakeClient:
    answers: dict = {}

    def __init__(self, provider: str):
        self.provider = provider
        self.spec = {"models_path": "/models"}

    async def get_json(self, path: str):
        answer = FakeClient.answers[self.provider]
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def aclose(self) -> None:
        return None


def test_a_failing_provider_is_recorded_and_hides_none_of_the_others(monkeypatch):
    monkeypatch.setattr(client, "DeepSeekClient", FakeClient)
    FakeClient.answers = {"example-a": RuntimeError("HTTP 503"), "example-b": [{"id": "example-gamma"}, "Example-Delta-TEE"]}
    first = asyncio.run(model_watch.scan(["example-a", "example-b"]))
    assert first["providers"]["example-a"]["error"] == "RuntimeError: HTTP 503"
    assert first["providers"]["example-b"]["error"] is None
    assert first["providers"]["example-b"]["new"] == ["Example-Delta-TEE", "example-gamma"]
    assert "example-gamma" in first["providers"]["example-b"]["unbenchmarked"]

    # A failed scan keeps the table it had (a provider down is not a provider that stopped serving), and a model
    # that is no longer listed is gone.
    FakeClient.answers = {"example-a": RuntimeError("HTTP 503 again"), "example-b": []}
    asyncio.run(model_watch.scan(["example-a", "example-b"]))
    stored = model_watch.load()
    assert stored["providers"]["example-b"]["models"]["example-gamma"]["standing"] == "gone"
    assert stored["providers"]["example-a"]["error"] == "RuntimeError: HTTP 503 again"
    assert "Example-Delta-TEE" in stored["providers"]["example-b"]["models"]
    assert "failing: example-a" in model_watch.summary()
