"""Offline: the LM Studio provider is keyless, free, and never picked by AUTO."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402


def test_lmstudio_needs_no_key_is_free_and_is_never_auto_picked():
    assert config.load_api_keys("lmstudio") == ["keyless"]
    assert config.billed_of("lmstudio-qwen3-30b-a3b") is False
    assert config.price("lmstudio-qwen3-30b-a3b") == {"hit": 0.0, "miss": 0.0, "out": 0.0}
    assert config.MODELS["lmstudio-qwen3-30b-a3b"].get("benchmark_slug") is None
