"""aa_index: the payload-to-component mapping, and the refusal of a model AA does not score in full. The page is an invented
payload of example models, never a saved copy of Artificial Analysis's page."""
from __future__ import annotations

import json

import pytest

from hswarm import aa_index


def _model(slug: str, *, hle=0.2) -> dict:
    return {
        "slug": slug, "name": "Example Model", "shortName": "Example", "creator": {"name": "Example Lab"},
        "releaseDate": "2026-01-01", "intelligenceIndex": 40.5,
        "intelligenceIndexCostPerTask": {"cost": {"total": 1.25}},
        "price1mInputTokens": 2, "price1mOutputTokens": 8,
        "briefcaseBreakdown": {"overall": {"elo": 1500.5}}, "gdpval": 1400.25,
        "automationBenchPartialScore": 0.5, "terminalBench40": 0.4, "scicode": 0.3, "hle": hle,
        "gdpPdfAllPass": 0.1, "critpt": 0.05, "omniscience": 12.5, "lcr": 0.75,
    }


def _page(*models: dict) -> str:
    body = json.dumps({"models": list(models)})
    chunk = json.dumps(body)[1:-1]
    return f'<script>self.__next_f.push([1,"{chunk}"])</script>'


def test_parse_maps_each_payload_field_to_its_index_component_and_drops_a_partly_scored_model():
    html = _page(_model("example-model-a"), _model("example-model-b", hle=None))
    found = aa_index.parse(html)
    assert list(found) == ["example-model-a"]
    point = found["example-model-a"]
    assert point["scores"] == {
        "aa-briefcase": 1500.5, "gdpval-aa": 1400.25, "automationbench-aa": 0.5, "terminalbench-4-0": 0.4,
        "scicode": 0.3, "humanitys-last-exam": 0.2, "gdp-pdf": 0.1, "critpt": 0.05, "omniscience": 12.5, "long-context": 0.75,
    }
    assert (point["score"], point["cost"], point["input"], point["output"]) == (40.5, 1.25, 2, 8)
    assert point["creator"] == "Example Lab"
    assert set(point["score_sources"].values()) == {"https://artificialanalysis.ai/models/example-model-a"}


def test_point_reads_the_models_own_page_and_refuses_a_partly_scored_model(tmp_path, monkeypatch):
    pages = {
        "example-model-a": _page(_model("example-model-a")),
        "example-model-b": _page(_model("example-model-b", hle=None)),
    }

    class FakeResponse:
        def __init__(self, text: str) -> None:
            self.status_code, self.text = 200, text

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc) -> bool:
            return False

        def get(self, url: str) -> FakeResponse:
            return FakeResponse(pages[url.rsplit("/", 1)[-1]])

    monkeypatch.setattr(aa_index, "cache_path", lambda: tmp_path / "aa-cache.json")
    monkeypatch.setattr(aa_index.httpx, "Client", FakeClient)
    assert aa_index.point("example-model-a")["source"] == "https://artificialanalysis.ai/models/example-model-a"
    assert aa_index.point("example-model-b") is None
