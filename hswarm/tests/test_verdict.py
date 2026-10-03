"""Offline: the cached verdict the agent_routing_gate hook reads - can this machine's swarm take work at all?

2026-09-21, Jacob's PC: every hswarm_run errored "No deepseek API key found" in 0.0 s, and the routing gate kept
sending every session there, because nothing it could read said the swarm was dead. The verdict is that thing:
~/.hswarm/verdict.json, written by `doctor`, the server's start, and a job that ends in NoUsableKey. It judges the
AUTO routes (what a plain hswarm_run uses), not the DeepSeek key alone: a machine with no DeepSeek key but a free
Gemini pool CAN take work, and a doctor that said otherwise would push sessions off a working swarm.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, verdict  # noqa: E402


def _keys(monkeypatch, tmp_path, **per_provider: int) -> None:
    secrets = tmp_path / "secrets"
    secrets.mkdir(exist_ok=True)
    monkeypatch.setattr(config, "SECRETS_DIR", secrets)
    for env in ("DEEPSEEK_API_KEYS", "DEEPSEEK_API_KEY", "GEMINI_API_KEYS", "GEMINI_API_KEY", "OPENROUTER_API_KEYS", "OPENROUTER_API_KEY",
                "GROQ_API_KEYS", "GROQ_API_KEY", "CEREBRAS_API_KEYS", "CEREBRAS_API_KEY", "HF_TOKENS", "HF_TOKEN", "HUGGINGFACE_API_KEY"):
        monkeypatch.delenv(env, raising=False)
    for provider, n in per_provider.items():
        (secrets / config.PROVIDERS[provider]["key_files"][0]).write_text("\n".join(f"SECRETKEY{provider}{i}" for i in range(n)), encoding="utf-8")


def test_no_key_anywhere_is_unusable_and_says_where_to_put_one(monkeypatch, tmp_path):
    _keys(monkeypatch, tmp_path)
    v = verdict.compute()
    assert v["usable"] is False and "no key" in v["why"]
    assert v["chains"]["tools"]["usable_legs"] == [] and v["chains"]["tool_free"]["usable_legs"] == []


def test_no_deepseek_key_but_a_gemini_pool_is_usable(monkeypatch, tmp_path):
    _keys(monkeypatch, tmp_path, gemini=2)
    v = verdict.compute()
    assert v["usable"] is True and v["chains"]["tool_free"]["usable_legs"] == ["rank:gemini-3-8-flash:direct", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
    assert v["chains"]["cc"]["usable_legs"] == []  # cc needs an Anthropic endpoint: DeepSeek, Hugging Face or OpenRouter


def test_a_pool_whose_every_key_is_disabled_does_not_count(monkeypatch, tmp_path):
    _keys(monkeypatch, tmp_path, groq=1)
    from hswarm import keys

    pool = keys.pool_for("groq")
    pool.disable(pool.keys[0])
    v = verdict.compute()
    assert v["usable"] is False and v["chains"]["tool_free"]["usable_legs"] == []


def test_write_puts_it_where_the_hook_reads_it(monkeypatch, tmp_path):
    _keys(monkeypatch, tmp_path)
    v = verdict.write()
    on_disk = json.loads((config.HOME / "verdict.json").read_text(encoding="utf-8"))
    assert on_disk["usable"] is False and on_disk["ts"] == v["ts"] and "SECRETKEY" not in json.dumps(on_disk)  # never a key
