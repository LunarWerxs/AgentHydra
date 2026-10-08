"""aa_index: the payload-to-component mapping, and the refusal of a model AA does not score in full. The page is an invented
payload of example models, never a saved copy of Artificial Analysis's page."""
from __future__ import annotations

import json

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


def test_refresh_replaces_a_vendor_estimate_once_aa_scores_the_model_and_keeps_one_aa_does_not(tmp_path, monkeypatch):
    vendor = {"slug": "example-model-a", "name": "Example (vendor)", "source": "https://example.com/launch", "score": None,
              "scores": {"humanitys-last-exam": 0.9}, "evidence": "vendor", "evidence_note": "launch post",
              "cost_estimated": "guessed", "cached_input": 0.01}
    unscored = {**vendor, "slug": "example-model-b"}
    index = tmp_path / "published-models.json"
    index.write_text(json.dumps({"scope": "2 selected exact configurations; not an exhaustive catalogue. All 20 component "
                                          "scores sourced.", "points": [vendor, unscored]}), encoding="utf-8")
    monkeypatch.setattr(aa_index, "INDEX", index)
    found = aa_index.parse(_page(_model("example-model-a")))
    monkeypatch.setattr(aa_index, "pool", lambda: found)
    monkeypatch.setattr(aa_index, "point", lambda slug: None)

    out = aa_index.refresh()

    assert (out["upgraded"], out["kept"]) == (["example-model-a"], ["example-model-b"])
    a, b = json.loads(index.read_text(encoding="utf-8"))["points"]
    assert a["source"] == "https://artificialanalysis.ai/models/example-model-a"
    assert (a["score"], a["scores"]["humanitys-last-exam"], a["cached_input"]) == (40.5, 0.2, 0.01)
    assert not {"evidence", "evidence_note", "cost_estimated"} & a.keys()
    assert b == unscored
