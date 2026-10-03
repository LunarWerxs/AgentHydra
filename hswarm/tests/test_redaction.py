"""Offline: redaction of worker tool output before it reaches a provider (hswarm/redaction.py). No network."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.redaction import Redactor, for_task, from_spec  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402

# Built at runtime so no key-shaped literal sits in the repo for a secret scanner to trip on.
FAKE_KEY = "sk-" + "a1b2c3d4" * 3


def run(coro):
    return asyncio.run(coro)


def test_hash_redacts_tool_output_with_stable_tags(tmp_path):
    (tmp_path / "cfg.txt").write_text(f"owner: ann@example.com\nkey: {FAKE_KEY}\ncc: ann@example.com\nother: bob@example.com\n", encoding="utf-8")
    sb = Sandbox(tmp_path, redactor=Redactor("hash"))
    out = run(sb.run("read_file", {"path": "cfg.txt"}))
    assert "ann@example.com" not in out and FAKE_KEY not in out and "bob@example.com" not in out
    lines = out.splitlines()
    ann1, ann2, bob = lines[0].split(": ", 1)[1], lines[2].split(": ", 1)[1], lines[3].split(": ", 1)[1]
    assert ann1 == ann2 and ann1.startswith("<email:") and bob != ann1  # same value, same tag; different value, different tag
    assert sb.redactor.counts == {"email": 3, "secret": 1}


def test_hash_tag_written_back_restores_the_real_value(tmp_path):
    # A worker that rewrites a file it read redacted must not persist the tag in place of the address.
    (tmp_path / "a.txt").write_text("contact ann@example.com\n", encoding="utf-8")
    sb = Sandbox(tmp_path, redactor=Redactor("hash"))
    tag = run(sb.run("read_file", {"path": "a.txt"})).split()[-1]
    assert tag.startswith("<email:")
    run(sb.run("write_file", {"path": "b.txt", "content": f"CONTACT {tag}\n"}))
    assert (tmp_path / "b.txt").read_text(encoding="utf-8") == "CONTACT ann@example.com\n"


def test_unrestorable_placeholder_write_is_refused(tmp_path):
    (tmp_path / "a.txt").write_text("contact ann@example.com\n", encoding="utf-8")
    sb = Sandbox(tmp_path, redactor=Redactor("redact"))
    seen = run(sb.run("read_file", {"path": "a.txt"}))
    assert "[REDACTED_EMAIL]" in seen
    out = run(sb.run("write_file", {"path": "a.txt", "content": "contact [REDACTED_EMAIL]\n"}))
    assert out.startswith("ERROR: refused write_file")
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "contact ann@example.com\n"


def test_block_withholds_the_output(tmp_path):
    (tmp_path / "a.txt").write_text(f"key={FAKE_KEY}\n", encoding="utf-8")
    out = run(Sandbox(tmp_path, redactor=Redactor("block")).run("read_file", {"path": "a.txt"}))
    assert out.startswith("ERROR: output of read_file withheld") and FAKE_KEY not in out


def test_card_needs_luhn_and_mask_keeps_last_four():
    r = Redactor("mask", detectors=["credit_card"])
    assert r.apply("pay 4111 1111 1111 1111 now").endswith("1111 now") and "4111 1111" not in r.apply("pay 4111 1111 1111 1111 now")
    assert r.apply("order 4111111111111112") == "order 4111111111111112"  # fails Luhn: an id, not a card


def test_source_code_identifiers_are_not_secrets():
    r = Redactor("redact")
    code = "token = get_token_from_environment()\npassword: str = field(default_factory=str)\n"
    assert r.apply(code) == code


def test_a_subscripted_secret_is_caught_like_a_plain_one():
    # Regression (a hswarm review of this file, 2026-09-26): conf["password"] = "..." leaked, password = "..." did not.
    value = "0123" + "45678901"
    text = f'conf["password"] = "{value}"\nsettings[\'api_key\']: {value}\n'
    assert value not in Redactor("redact").apply(text)


def test_a_pattern_named_like_a_built_in_is_refused():
    # Regression: it was stored under the built-in's key and REPLACED it, so real keys went out unredacted.
    with pytest.raises(ValueError, match="built-in"):
        Redactor(patterns={"secret": r"MYCO-\d+"})


def test_env_and_config_style_secret_names_are_caught():
    # `\b` before the name missed these: `_` is a word character, so DB_PASSWORD= never matched.
    r = Redactor("redact", detectors=["secret"])
    for line in ("DB_PASSWORD=S3cretPassw0rd99", "client_secret: ab12cd34ef56gh78", "GITHUB_TOKEN=abc123def456ghi789",
                 "SECRET_KEY='x9y8z7w6v5u4t3s2'", "csk-" + "a1b2c3d4" * 3, "hf_" + "a1b2c3d4" * 4):
        assert "[REDACTED_SECRET]" in r.apply(line), line


def test_run_api_task_redacts_a_free_tier_leg_and_restores_the_answer(monkeypatch, tmp_path):
    # The seam: agent.run_api_task picks the redactor per leg from the provider's free_tier flag, the
    # provider sees only the tag, the counts land on Result.redactions, and the local caller gets the real value.
    import hswarm.agent as agent
    from hswarm.usage import ChatResult, Usage

    monkeypatch.setenv("HSWARM_REDACT_FREE_TIER", "hash")
    (tmp_path / "cfg.txt").write_text("owner: ann@example.com\n", encoding="utf-8")

    class Provider:
        seen: list[str] = []

        async def chat(self, messages, **kw):
            tool_out = [m["content"] for m in messages if m.get("role") == "tool"]
            if not tool_out:
                call = {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "cfg.txt"}'}}
                return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason="tool_calls",
                                  usage=Usage(), model="m", seconds=0.01, cost_usd=0.0, peak=False)
            self.seen.extend(tool_out)
            tag = tool_out[-1].split("owner: ", 1)[1].split()[0]
            return ChatResult(message={"role": "assistant", "content": f"the owner is {tag}"}, finish_reason="stop",
                              usage=Usage(), model="m", seconds=0.01, cost_usd=0.0, peak=False)

    provider = Provider()
    task = Task.from_dict({"prompt": "who owns it", "cwd": str(tmp_path), "tools": "read", "model": "groq-gpt-oss-120b"})
    res, _ = run(agent.run_api_task(provider, task))
    assert provider.seen and not any("ann@example.com" in s for s in provider.seen)
    assert res.redactions == {"email": 1}
    assert res.answer == "the owner is ann@example.com"


def test_failover_onto_a_free_tier_redacts_the_resumed_transcript(monkeypatch, tmp_path):
    # Regression: a paid leg's unredacted tool output rode resume_messages straight to the free-tier leg.
    import hswarm.agent as agent
    from hswarm.usage import ChatResult, Usage

    monkeypatch.setenv("HSWARM_REDACT_FREE_TIER", "hash")
    call = {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "cfg.txt"}'}}
    resumed = [{"role": "system", "content": "s"}, {"role": "user", "content": "who owns it"},
               {"role": "assistant", "content": "", "tool_calls": [call]},
               {"role": "tool", "tool_call_id": "c1", "content": "owner: ann@example.com"}]

    class Provider:
        sent: list[str] = []

        async def chat(self, messages, **kw):
            self.sent.extend(str(m.get("content")) for m in messages)
            tag = messages[3]["content"].split("owner: ", 1)[1]
            return ChatResult(message={"role": "assistant", "content": f"the owner is {tag}"}, finish_reason="stop",
                              usage=Usage(), model="m", seconds=0.01, cost_usd=0.0, peak=False)

    provider = Provider()
    task = Task.from_dict({"prompt": "who owns it", "cwd": str(tmp_path), "tools": "read", "model": "groq-gpt-oss-120b"})
    res, _ = run(agent.run_api_task(provider, task, resume_messages=resumed))
    assert provider.sent and not any("ann@example.com" in s for s in provider.sent)
    assert res.answer == "the owner is ann@example.com"


def test_tags_from_an_earlier_leg_restore_in_writes_only(tmp_path):
    # Each leg builds its own Redactor; a tag the first leg emitted must still map back in the next leg's write,
    # and must NOT map back in read_url, where the real value would leave the machine.
    tag = Redactor("hash").apply("ann@example.com")
    sb = Sandbox(tmp_path, redactor=Redactor("hash"))
    run(sb.run("write_file", {"path": "b.txt", "content": f"CONTACT {tag}\n"}))
    assert (tmp_path / "b.txt").read_text(encoding="utf-8") == "CONTACT ann@example.com\n"
    assert sb.unredact("read_url", {"url": f"https://h.example/?k={tag}"})[0]["url"].endswith(tag)


def test_task_level_switches(monkeypatch, tmp_path):
    monkeypatch.delenv("HSWARM_REDACT_FREE_TIER", raising=False)
    assert for_task(None, free_tier=True) is None  # off unless the machine opts in
    monkeypatch.setenv("HSWARM_REDACT_FREE_TIER", "on")
    assert for_task(None, free_tier=True).strategy == "hash"
    assert for_task(None, free_tier=False) is None
    assert for_task("off", free_tier=True) is None  # an explicit task setting wins over the machine switch
    assert from_spec({"detectors": "ip", "patterns": {"ticket": r"TKT-\d{6}"}}).apply("TKT-123456 at 10.0.0.1").count("<") == 2
    with pytest.raises(ValueError, match="redact strategy"):
        Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "tools": "none", "redact": "scramble"})
    monkeypatch.setenv("HSWARM_REDACT_FREE_TIER", "hashh")  # a typo on the machine switch names the variable
    with pytest.raises(ValueError, match="HSWARM_REDACT_FREE_TIER"):
        for_task(None, free_tier=True)
