"""Alive exports merge, explicit dead evidence prunes, and the encrypted vault converges."""
from __future__ import annotations

import json

import pytest

from hswarm import config, key_import, keystate, vault


def put(folder, name, *values):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text("\n".join(values) + "\n", encoding="utf-8")


def test_alive_is_additive_and_only_explicit_dead_is_removed(tmp_path):
    source = tmp_path / "export"
    keep, dead, new = "sk-keep-0001", "sk-dead-0002", "sk-new-0003"
    put(config.SECRETS_DIR, "groq_api_keys", keep, dead)
    put(config.SECRETS_DIR, "groq_api_keys.dead", dead)
    put(source, "groq_alive_keys.txt", new)
    before = (config.SECRETS_DIR / "groq_api_keys").read_bytes()
    preview = key_import.run(source, dry_run=True)
    assert preview["added"] == 1 and preview["removed_dead"] == 1
    assert (config.SECRETS_DIR / "groq_api_keys").read_bytes() == before
    out = key_import.run(source)
    assert set(vault._keys_in(config.SECRETS_DIR / "groq_api_keys")) == {keep, new}
    assert keep not in json.dumps(out) and dead not in json.dumps(out) and new not in json.dumps(out)
    assert key_import.run(source)["changed_lists"] == 0


def test_new_alive_overrides_old_classifications_but_not_paid_credit(tmp_path):
    source = tmp_path / "export"
    revived, credit = "sk-revoked-0001", "sk-credit-0002"
    put(source, "groq_alive_keys.txt", revived, credit)
    put(config.SECRETS_DIR, "groq_api_keys.dead", revived)
    put(config.SECRETS_DIR, "groq_api_keys.unfunded", credit)
    with keystate.txn() as tx:
        tx.put(config.fingerprint(revived), {"disabled": True, "disabled_status": 401, "disabled_reason": "revoked (401/403)"})
        tx.put(config.fingerprint(credit), {"disabled": True, "disabled_status": 402, "disabled_reason": "out of credit"})
    out = key_import.run(source)
    assert out["restored_classifications"] == 2 and out["revoked_states_restored"] == 1
    assert set(vault._keys_in(config.SECRETS_DIR / "groq_api_keys")) == {revived, credit}
    assert vault._keys_in(config.SECRETS_DIR / "groq_api_keys.dead") == []
    assert vault._keys_in(config.SECRETS_DIR / "groq_api_keys.unfunded") == []
    assert config.fingerprint(revived) not in keystate.read_all()
    assert keystate.read_all()[config.fingerprint(credit)]["disabled"]


def test_legacy_toml_keys_join_one_list_with_settings_preserved(tmp_path):
    source = tmp_path / "export"
    old, new = "sk-old-0001", "sk-new-0002"
    put(source, "groq_alive_keys.txt", new)
    config.PROVIDERS_DIR.mkdir(parents=True)
    file = config.PROVIDERS_DIR / "groq.toml"
    file.write_text(f'# preserve this comment\nkeys = ["{old}"]\nenabled = false\n', encoding="utf-8")
    out = key_import.run(source)
    assert out["provider_files_consolidated"] == 1
    assert set(vault._keys_in(config.SECRETS_DIR / "groq_api_keys")) == {old, new}
    text = file.read_text(encoding="utf-8")
    assert "preserve this comment" in text and "enabled = false" in text and old not in text


def test_encrypted_vault_received_merge_and_dead_tombstone(tmp_path):
    source = tmp_path / "export"
    old, dead, new = "sk-old-0001", "sk-dead-0002", "sk-new-0003"
    put(config.SECRETS_DIR, "groq_api_keys", old, dead)
    put(config.SECRETS_DIR, "groq_api_keys.dead", dead)
    vault.init(f"dir:{tmp_path / 'backend'}")
    put(source, "groq_alive_keys.txt", new)
    out = key_import.run(source)
    assert out["sync"]["pushed"]
    state = vault.fetch_state()
    assert state["lists"]["groq_api_keys"][vault.key_id(dead)]["k"] is None
    assert {e["k"] for e in state["lists"]["groq_api_keys"].values() if e["k"]} == {old, new}
    blob = (tmp_path / "backend" / "vault.bin").read_bytes()
    assert all(k.encode() not in blob for k in (old, dead, new))


def test_legacy_clone_input_does_not_overwrite_existing_lists(tmp_path):
    source = tmp_path / "clone"
    put(source / ".secrets", "groq_api_keys", "sk-new-0001")
    put(config.SECRETS_DIR, "groq_api_keys", "sk-keep-0002")
    key_import.run(source)
    assert set(vault._keys_in(config.SECRETS_DIR / "groq_api_keys")) == {"sk-new-0001", "sk-keep-0002"}


def test_explicit_revoked_states_are_removed_but_credit_and_manual_disables_stay(tmp_path):
    source = tmp_path / "export"
    revoked, credit, manual, new = "sk-revoked-0001", "sk-credit-0002", "sk-manual-0003", "sk-new-0004"
    put(source, "groq_alive_keys.txt", new)
    put(config.SECRETS_DIR, "groq_api_keys", revoked, credit, manual)
    with keystate.txn() as tx:
        tx.put(config.fingerprint(revoked), {"disabled": True, "disabled_status": 401, "disabled_reason": "revoked (401/403)"})
        tx.put(config.fingerprint(credit), {"disabled": True, "disabled_status": 402, "disabled_reason": "out of credit"})
        tx.put(config.fingerprint(manual), {"disabled": True, "disabled_reason": "disabled by hand"})
    out = key_import.run(source)
    assert out["removed_dead"] == 1
    assert set(vault._keys_in(config.SECRETS_DIR / "groq_api_keys")) == {credit, manual, new}
    assert vault._keys_in(config.SECRETS_DIR / "groq_api_keys.dead") == [revoked]


def test_short_fingerprint_collision_does_not_identify_a_dead_key(tmp_path, monkeypatch):
    source = tmp_path / "export"
    put(source, "groq_alive_keys.txt", "sk-new-0001")
    put(config.SECRETS_DIR, "groq_api_keys", "sk-other-0002")
    monkeypatch.setattr(config, "fingerprint", lambda key: "a" * 8)
    with keystate.txn() as tx:
        tx.put("a" * 8, {"disabled": True, "disabled_status": 401, "disabled_reason": "revoked (401/403)"})
    assert key_import.run(source)["removed_dead"] == 0
    assert len(vault._keys_in(config.SECRETS_DIR / "groq_api_keys")) == 2
    assert keystate.read_all()["a" * 8]["disabled"]


def test_input_conflicts_and_bad_lines_fail_without_writes(tmp_path):
    source = tmp_path / "export"
    put(source, "groq_alive_keys.txt", "sk-same-0001")
    put(source, "groq_dead_keys.txt", "sk-same-0001")
    with pytest.raises(key_import.KeyImportError, match="both alive and dead"):
        key_import.run(source)
    assert not config.SECRETS_DIR.exists()
    (source / "groq_dead_keys.txt").unlink()
    put(source, "groq_alive_keys.txt", "sk-bad-0001 secret-extra")
    with pytest.raises(key_import.KeyImportError) as exc:
        key_import.run(source)
    assert "secret-extra" not in str(exc.value)
    assert not config.SECRETS_DIR.exists()
