"""The settings the console writes (settings.py) are the settings routing obeys: key order, switches, priority."""
from __future__ import annotations

import json
import os

import pytest

from hswarm import config, keys, selection, settings, vault
from hswarm.client import KeyPool


def _fp(k):
    return config.fingerprint(k)


def test_the_key_store_is_the_pool(monkeypatch):
    a, b, c = "sk-store-aaaa-0001", "sk-store-bbbb-0002", "sk-store-cccc-0003"
    for k in (a, b, c):
        assert settings.add_key("groq", k)["added"]
    assert settings.add_key("groq", b)["added"] is False  # the same key twice is one key
    assert config.load_api_keys("groq") == [a, b, c]

    settings.remove_key("groq", _fp(b))
    assert config.load_api_keys("groq") == [a, c]
    rows = settings.key_rows("groq")
    assert [r["fingerprint"] for r in rows] == [_fp(a), _fp(c)] and all(r["editable"] for r in rows)
    assert all(k not in json.dumps(rows) for k in (a, c))  # rows never carry the key itself

    monkeypatch.setenv("GROQ_API_KEY", "sk-env-dddd-0004")
    with pytest.raises(settings.SettingsError, match="env:GROQ_API_KEY"):
        settings.remove_key("groq", _fp("sk-env-dddd-0004"))  # a key from the environment is changed there


def test_console_provider_cards_expose_service_transport_capabilities_and_operations():
    provider = next(row for row in settings.snapshot()["providers"] if row["name"] == "elevenlabs")
    assert provider["transport"] == "service"
    assert "text-to-speech" in provider["capabilities"] and "synthesize" in provider["operations"]


def test_console_keys_live_in_the_encrypted_vault_and_survive_a_second_machine(tmp_path, monkeypatch):
    a, b = "sk-shared-aaaa-0001", "sk-shared-bbbb-0002"
    backend = tmp_path / "remote"
    vault.init(f"dir:{backend}")
    code = vault.pair_code()
    added = settings.add_key("groq", a)
    settings.add_key("groq", b)
    assert added["sync"]["to_vault"] == 1
    assert not config.user_file("groq").exists()
    assert a.encode() not in (backend / "vault.bin").read_bytes()
    settings.remove_key("groq", _fp(a))
    state = vault.fetch_state()["lists"]["groq_api_keys"]
    assert state[vault.key_id(a)]["k"] is None
    assert state[vault.key_id(b)]["k"] == b

    other = tmp_path / "other-home"
    monkeypatch.setattr(config, "HOME", other)
    monkeypatch.setattr(config, "PROVIDERS_DIR", other / "providers")
    monkeypatch.setattr(config, "SECRETS_DIR", other / "secrets")
    config.reload()
    vault.join(code)
    assert config.load_api_keys("groq") == [b]
    assert settings.key_rows("groq")[0]["editable"]


def test_key_edit_moves_legacy_toml_keys_without_erasing_provider_settings(user_toml):
    a, b, c = "sk-legacy-aaaa-0001", "sk-legacy-bbbb-0002", "sk-legacy-cccc-0003"
    path = user_toml("groq", f'# custom endpoint\nbase_url = "https://api.example.test/v1"\nkeys = ["{a}", "{b}"]\n'
                              f'key_priority = {{"{_fp(a)}" = 2}}\n\n# keep this model\n[models.example-model]\nctx = 8192\n')
    settings.add_key("groq", c)
    text = path.read_text(encoding="utf-8")
    assert "# custom endpoint" in text and "# keep this model" in text
    assert 'base_url = "https://api.example.test/v1"' in text and "ctx = 8192" in text
    assert a not in text and b not in text and c not in text
    assert config.load_api_keys("groq") == [a, b, c]
    assert config.PROVIDERS["groq"]["key_priority"][_fp(a)] == 2


def test_remove_drops_every_managed_duplicate_and_its_stale_priority(user_toml):
    a, b = "sk-duplicate-aaaa-0001", "sk-duplicate-bbbb-0002"
    path = user_toml("groq", f'keys = ["{a}", "{b}"]\nkey_priority = {{"{_fp(a)}" = 1}}\n')
    config.SECRETS_DIR.mkdir(parents=True)
    keyfile = config.SECRETS_DIR / "groq_api_keys"
    keyfile.write_text(f"# retained list comment\n{a}\n{b}\n", encoding="utf-8")
    settings.remove_key("groq", _fp(a))
    assert config.load_api_keys("groq") == [b]
    assert a not in path.read_text(encoding="utf-8") and _fp(a) not in path.read_text(encoding="utf-8")
    assert keyfile.read_text(encoding="utf-8") == f"# retained list comment\n{b}\n"


def test_explicit_add_clears_old_dead_and_unfunded_classifications():
    key = "sk-new-proof-alive-0001"
    config.SECRETS_DIR.mkdir(parents=True)
    for suffix in (".dead", ".unfunded"):
        (config.SECRETS_DIR / ("groq_api_keys" + suffix)).write_text(key + "\n", encoding="utf-8")
    settings.add_key("groq", key)
    assert config.load_api_keys("groq") == [key]
    assert all(key not in (config.SECRETS_DIR / ("groq_api_keys" + suffix)).read_text(encoding="utf-8")
               for suffix in (".dead", ".unfunded"))


def test_invalid_legacy_provider_file_refuses_a_key_edit_before_writing():
    path = config.user_file("groq")
    path.parent.mkdir(parents=True)
    path.write_text('keys = ["unfinished"\n', encoding="utf-8")
    with pytest.raises(settings.SettingsError, match="not valid TOML"):
        settings.add_key("groq", "sk-valid-but-unsaved-0001")
    assert not (config.SECRETS_DIR / "groq_api_keys").exists()
    assert path.read_text(encoding="utf-8") == 'keys = ["unfinished"\n'


def test_failed_upload_reports_that_the_local_key_is_pending(tmp_path, monkeypatch):
    vault.init(f"dir:{tmp_path / 'remote'}")
    monkeypatch.setattr(vault, "_sync_locked", lambda **kwargs: (_ for _ in ()).throw(vault.VaultError("offline")))
    with pytest.raises(vault.VaultError, match="local key changes were saved, but vault sync failed"):
        settings.add_key("groq", "sk-pending-upload-0001")
    assert config.load_api_keys("groq") == ["sk-pending-upload-0001"]


def test_key_priority_tiers_take_turns_and_fall_through():
    k1, k2, k3, k4 = "sk-k1-aaaa-0001", "sk-k2-bbbb-0002", "sk-k3-cccc-0003", "sk-k4-dddd-0004"
    for k in (k1, k2, k3, k4):
        settings.add_key("groq", k)
    pool = KeyPool(config.load_api_keys("groq"), "groq")
    assert [pool.pick() for _ in range(4)] == [k1, k2, k3, k4]  # no numbers: plain round-robin

    settings.set_key_priority("groq", _fp(k3), 1)
    settings.set_key_priority("groq", _fp(k1), "1")
    settings.set_key_priority("groq", _fp(k2), 2)  # k4 has no number: the last tier
    assert [r["fingerprint"] for r in settings.key_rows("groq")] == [_fp(k1), _fp(k3), _fp(k2), _fp(k4)]
    assert sorted(pool.pick() for _ in range(4)) == sorted([k1, k3, k1, k3])  # tier 1 takes turns

    pool.disable(k1, reason="out of credit")
    assert {pool.pick() for _ in range(3)} == {k3}
    pool.rest(k3, 60)
    assert pool.pick() == k2  # tier 2 only while tier 1 has nothing ready
    pool.disable(k2, reason="out of credit")
    assert pool.pick() == k4

    settings.set_key_priority("groq", _fp(k3), None)
    assert settings.key_rows("groq")[-1]["priority"] is None
    with pytest.raises(settings.SettingsError, match="whole number"):
        settings.set_key_priority("groq", _fp(k4), "first")


def _usable_everywhere():
    for p in config.PROVIDERS:
        if config.PROVIDERS[p].get("key_files"):
            settings.add_key(p, f"sk-{p}-test-0001")


def test_switches_and_priority_decide_what_auto_runs():
    _usable_everywhere()
    plan = selection.plan("general", usable=keys.has_credit)["candidates"]
    first, second = plan[0], next(c for c in plan if c["provider"] != plan[0]["provider"])

    settings.set_provider(first["provider"], enabled=False)
    assert config.load_api_keys(first["provider"]) == []
    after = selection.plan("general", usable=keys.has_credit)["candidates"]
    assert first["provider"] not in {c["provider"] for c in after}

    settings.set_provider(first["provider"], enabled=True)
    settings.set_model(first["model"], False)
    assert first["model"] not in [c["model"] for c in selection.plan("general", usable=keys.has_credit)["candidates"]]
    with pytest.raises(ValueError, match="switched off"):
        config.route_plan(first["model"])

    # A hand edit of the provider files (no settings call) reaches a long-lived process through refresh().
    f1, f2 = config.user_file(first["provider"]), config.user_file(second["provider"])
    f1.write_text(f1.read_text(encoding="utf-8").replace("enabled = false", ""), encoding="utf-8")
    f2.write_text((f2.read_text(encoding="utf-8") if f2.exists() else "") +
                  f'\n[models."{second["model"]}"]\npriority = 1\n', encoding="utf-8")
    for f in (f1, f2):
        os.utime(f, ns=(1, 1))  # a new stamp even within one clock tick
    assert config.refresh() is True
    assert selection.plan("general", usable=keys.has_credit)["candidates"][0]["model"] == second["model"]


# Contract: a provider file a person writes by hand is read as written (its keys, its models, the defaults it leaves
# out), and a console change keeps that person's comments. Regression: a writer that re-dumps the file drops them.
def test_a_hand_written_provider_file_is_read_and_keeps_its_comments_through_the_console(user_toml):
    k = "sk-hand-written-0001"
    user_toml("acme", f'# my local box\nbase_url = "http://127.0.0.1:9/v1"\nkeys = ["{k}"]  # the only key\n\n'
                      '[models.acme-7b]\napi_id = "acme/7b"\nctx = 8192\n')
    assert config.load_api_keys("acme") == [k] and config.provider_of("acme-7b") == "acme"
    assert config.PROVIDERS["acme"]["key_env"] == ("ACME_API_KEYS", "ACME_API_KEY")
    settings.set_model_priority("acme-7b", 3)
    text = config.user_file("acme").read_text(encoding="utf-8")
    assert "# my local box" in text and "# the only key" in text and config.PRIORITY["acme-7b"] == 3
    # One key written as a string, not a list, is that one key (it was split into one key per character).
    user_toml("solo", 'base_url = "http://127.0.0.1:9/v1"\nkeys = "sk-one-string-0001"\n')
    settings.add_key("solo", "sk-one-string-0002")
    assert config.load_api_keys("solo") == ["sk-one-string-0001", "sk-one-string-0002"]


# Contract: a table in a user file changes only what it names, one level down too (docs/PROVIDERS.md). Regression: a
# shallow merge priced a leg's unnamed rates at zero, so it looked nearly free and ranked first (audit, 2026-09-26).
def test_a_user_table_changes_only_the_fields_it_names(user_toml):
    before = config.price("deepseek-flash-or")
    user_toml("openrouter", "[models.deepseek-flash-or]\nprice = {out = 9.0}\n")
    assert config.price("deepseek-flash-or") == {**before, "out": 9.0}


def test_a_custom_provider_and_model_are_reachable_by_name_and_removable():
    settings.add_provider("mylocal", "http://127.0.0.1:11434/v1")
    settings.add_model("my-llama", "mylocal", "llama3.2", price={"hit": "", "miss": "0.1", "out": "0.2"})
    settings.add_key("mylocal", "local-no-key-needed")
    assert config.provider_of("my-llama") == "mylocal" and config.api_model_id("my-llama") == "llama3.2"
    assert config.load_api_keys("mylocal") == ["local-no-key-needed"]
    with pytest.raises(settings.SettingsError):
        settings.remove_provider("gemini")  # built in: switch it off instead
    with pytest.raises(settings.SettingsError):
        settings.add_model("pro", "mylocal")  # an alias of deepseek-v4-pro: the new model could never be reached
    # Removing deletes the provider's file: a name that is a path would delete another file (audit, 2026-09-26).
    settings.set_options(daily_cap_usd=9)
    for name in ("../settings", str(config.SETTINGS_FILE.with_suffix(""))):
        with pytest.raises(settings.SettingsError):
            settings.remove_provider(name)
    assert config.SETTINGS_FILE.exists()
    settings.remove_provider("mylocal")
    assert "mylocal" not in config.PROVIDERS and "my-llama" not in config.MODELS


# Contract: once today's spend reaches the daily cap in settings.toml, new work is refused with a message that says
# how to lift it. Regression: a cap that is shown in the console but never stops a job.
def test_the_daily_cap_refuses_new_work_once_today_reached_it(user_toml, tmp_path):
    import datetime as dt

    from hswarm.jobs import JobManager
    from hswarm.spec import Task

    config.LEDGER.parent.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now().astimezone().isoformat()
    config.LEDGER.write_text(json.dumps({"ts": now, "status": "ok", "cost_usd": 2.0, "provider": "groq"}) + "\n", encoding="utf-8")
    task = Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, 0)
    user_toml("settings", "daily_cap_usd = 5\n")
    assert config.DAILY_CAP_USD == 5.0
    user_toml("settings", "daily_cap_usd = 1.5\n")
    with pytest.raises(ValueError, match="DailyCapReached.*daily_cap_usd"):
        JobManager().submit([task])
