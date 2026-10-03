"""Offline: the key vault (hswarm/vault.py). Two "machines" are two throwaway HSWARM_HOMEs and secrets/ folders over one dir: backend.
The ZSwarm home `adopt` reads is a throwaway folder too (ZSWARM_HOME), never the real ~/.zswarm."""
from __future__ import annotations

import base64
import contextlib
import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import cli, config, vault  # noqa: E402

KEY = bytes(range(32))


class Fleet:
    """Machines that share one backend folder. `on(name)` makes that machine the current one: its HSWARM_HOME and its secrets/."""

    def __init__(self, tmp_path, monkeypatch):
        self.tmp, self.mp = tmp_path, monkeypatch
        self.url = f"dir:{tmp_path / 'server'}"
        self.clock = 1_000_000
        monkeypatch.setattr(vault, "_now_ms", lambda: self.clock)
        monkeypatch.setenv("ZSWARM_HOME", str(tmp_path / "no-zswarm"))  # status() and adopt() never see this machine's own ZSwarm

    def on(self, name: str) -> Path:
        home, secrets = self.tmp / name / "home", self.tmp / name / "secrets"
        secrets.mkdir(parents=True, exist_ok=True)
        self.mp.setattr(config, "HOME", home)
        self.mp.setattr(config, "SECRETS_DIR", secrets)
        self.mp.setattr(vault.socket, "gethostname", lambda: name)
        return secrets

    def tick(self, ms: int = 1000) -> None:
        self.clock += ms

    def write(self, name: str, *keys: str, secrets: Path | None = None) -> None:
        (secrets or config.SECRETS_DIR).joinpath(name).write_text("".join(f"{k}\n" for k in keys), encoding="utf-8")


@pytest.fixture
def fleet(tmp_path, monkeypatch):
    return Fleet(tmp_path, monkeypatch)


def keys_of(name: str) -> list[str]:
    return vault._keys_in(config.SECRETS_DIR / name)


def test_sealed_state_opens_only_with_its_key_and_unaltered():
    state = {"rev": 3, "lists": {"groq_api_keys": {"a" * 16: {"k": "gsk-secret-1234", "t": 5, "by": "a"}}}}
    blob = vault.seal(KEY, state)
    assert b"gsk-secret-1234" not in blob
    assert vault.unseal(KEY, blob) == state
    with pytest.raises(vault.VaultError, match="does not open"):
        vault.unseal(bytes(32), blob)
    with pytest.raises(vault.VaultError, match="does not open"):
        vault.unseal(KEY, blob[:-1] + bytes([blob[-1] ^ 1]))
    with pytest.raises(vault.VaultError, match="not a ZSwarm/HSwarm vault"):
        vault.unseal(KEY, b"hello")


def test_merge_keeps_the_newer_entry_and_a_removal_wins_a_tie_in_either_order():
    put = {"k": "sk-test-0001", "t": 10, "by": "a"}
    gone = {"k": None, "t": 10, "by": "b"}
    later = {"k": "sk-test-0001", "t": 11, "by": "a"}
    a, b = {"rev": 1, "lists": {"x_api_keys": {"id": put}}}, {"rev": 2, "lists": {"x_api_keys": {"id": gone}}}
    assert vault.merge(a, b) == vault.merge(b, a)
    assert vault.merge(a, b)["lists"]["x_api_keys"]["id"] == gone
    assert vault.merge(a, {"rev": 0, "lists": {"x_api_keys": {"id": later}}})["lists"]["x_api_keys"]["id"] == later
    assert vault.merge(b, {"rev": 0, "lists": {"x_api_keys": {"id": later}}})["lists"]["x_api_keys"]["id"] == later


def test_two_machines_converge_on_adds_rolls_and_removals(fleet):
    fleet.on("alpha")
    fleet.write("openrouter_api_keys", "sk-or-aaaa1111", "sk-or-bbbb2222")
    fleet.write("cohere_api_keys.dead", "co-dead-0001")
    first = vault.init(fleet.url)
    assert first["keys"] == 3 and first["pushed"] and first["added_here"] == 0
    code = vault.pair_code()

    fleet.on("beta")
    fleet.write("openrouter_api_keys", "sk-or-cccc3333")
    joined = vault.join(code)
    assert joined["added_here"] == 3 and joined["to_vault"] == 1
    assert set(keys_of("openrouter_api_keys")) == {"sk-or-aaaa1111", "sk-or-bbbb2222", "sk-or-cccc3333"}
    assert keys_of("cohere_api_keys.dead") == ["co-dead-0001"]

    fleet.on("alpha")
    fleet.tick()
    vault.sync()
    assert "sk-or-cccc3333" in keys_of("openrouter_api_keys")

    fleet.tick()
    fleet.write("openrouter_api_keys", "sk-or-aaaa1111", "sk-or-cccc3333", "sk-or-dddd4444")  # bbbb rolled out, dddd rolled in
    rolled = vault.sync()
    assert rolled["to_vault"] == 1 and rolled["from_vault"] == 1 and rolled["pushed"]

    fleet.on("beta")
    fleet.tick()
    got = vault.sync()
    assert got["added_here"] == 1 and got["removed_here"] == 1
    assert set(keys_of("openrouter_api_keys")) == {"sk-or-aaaa1111", "sk-or-cccc3333", "sk-or-dddd4444"}


def test_a_sync_with_nothing_new_pushes_nothing(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    fleet.tick()
    again = vault.sync()
    assert not again["pushed"] and again["rev"] == 1 and again["added_here"] == again["removed_here"] == 0


def test_a_joining_machines_old_copy_of_a_removed_key_does_not_bring_it_back(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001", "gsk-test-0002")
    vault.init(fleet.url)
    code = vault.pair_code()
    fleet.tick()
    fleet.write("groq_api_keys", "gsk-test-0002")
    vault.sync()

    fleet.on("late")
    fleet.write("groq_api_keys", "gsk-test-0001", "gsk-test-0003")  # a stale clone that still holds the rolled key
    out = vault.join(code)
    assert out["removed_here"] == 1
    assert set(keys_of("groq_api_keys")) == {"gsk-test-0002", "gsk-test-0003"}
    fleet.on("alpha")
    fleet.tick()
    vault.sync()
    assert set(keys_of("groq_api_keys")) == {"gsk-test-0002", "gsk-test-0003"}


def test_a_wiped_secrets_folder_does_not_erase_the_vault_and_rebase_restores_it(fleet):
    secrets = fleet.on("alpha")
    fleet.write("groq_api_keys", *[f"gsk-test-{i:04d}" for i in range(8)])
    vault.init(fleet.url)
    for f in secrets.iterdir():
        f.unlink()
    fleet.tick()
    with pytest.raises(vault.VaultError, match="--allow-removals"):
        vault.sync()
    assert vault.status()["vault"]["keys"] == 8
    restored = vault.sync(rebase=True)
    assert restored["added_here"] == 8 and len(keys_of("groq_api_keys")) == 8


def test_a_repeat_sync_of_a_big_vault_takes_seconds_not_hours(fleet):
    """62,029 keys made a repeat sync spin for 10+ minutes when its counting re-built the vault's key map per key; the
    size here costs the quadratic version several seconds and this one a few milliseconds."""
    fleet.on("alpha")
    n = 6_000
    fleet.write("openrouter_api_keys", *[f"sk-or-big-{i:07d}" for i in range(n)])
    vault.init(fleet.url)
    fleet.tick()
    fleet.write("openrouter_api_keys", *[f"sk-or-big-{i:07d}" for i in range(1, n + 1)])
    t0 = time.monotonic()
    out = vault.sync()
    plan = vault.sync(dry_run=True)
    assert time.monotonic() - t0 < 2.0
    assert (out["to_vault"], out["from_vault"], plan["keys"]) == (1, 1, n)


def test_a_few_removals_are_a_roll_not_a_wipe(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", *[f"gsk-test-{i:04d}" for i in range(30)])
    vault.init(fleet.url)
    fleet.tick()
    fleet.write("groq_api_keys", *[f"gsk-test-{i:04d}" for i in range(2, 30)])
    assert vault.sync()["to_vault"] == 0 and vault.status()["vault"]["keys"] == 28


def test_dry_run_changes_nothing(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    code = vault.pair_code()
    fleet.on("beta")
    fleet.write("groq_api_keys", "gsk-test-0002")
    vault.join(code)
    fleet.on("alpha")
    fleet.tick()
    fleet.write("groq_api_keys", "gsk-test-0001", "gsk-test-0009")
    before = vault.status()["vault"]
    plan = vault.sync(dry_run=True)
    assert plan["dry_run"] and plan["to_vault"] == 1 and plan["to_here"] == 1
    assert vault.status()["vault"] == before and keys_of("groq_api_keys") == ["gsk-test-0001", "gsk-test-0009"]


def test_rewrite_keeps_comments_and_order_and_leaves_an_untouched_file_alone(fleet):
    fleet.on("alpha")
    path = config.SECRETS_DIR / "groq_api_keys"
    path.write_text("# harvested 2026-09-30\nsk-keep-0001\nsk-drop-0002\n\nsk-keep-0003\n", encoding="utf-8")
    assert vault._rewrite(path, {vault.key_id("sk-drop-0002")}, ["sk-new-0004", "sk-keep-0001"])
    assert path.read_text(encoding="utf-8").splitlines() == ["# harvested 2026-09-30", "sk-keep-0001", "", "sk-keep-0003", "sk-new-0004"]
    stamp = path.stat().st_mtime_ns
    assert not vault._rewrite(path, set(), ["sk-new-0004"]) and path.stat().st_mtime_ns == stamp


def test_a_list_name_from_the_vault_is_never_a_path(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    be = vault.open_backend(fleet.url)
    blob, etag = be.get()
    state = vault.unseal(vault._load_key(), blob)
    evil = {"k": "sk-evil-0001", "t": 5, "by": "x"}
    state["lists"]["../escape_api_keys"] = {"1" * 16: evil}
    state["lists"]["notes.txt"] = {"2" * 16: evil}
    state["rev"] += 1
    be.put(vault.seal(vault._load_key(), state), etag)
    fleet.tick()
    vault.sync()
    assert not (config.SECRETS_DIR.parent / "escape_api_keys").exists() and not (config.SECRETS_DIR / "notes.txt").exists()


def test_a_server_that_went_back_to_an_older_vault_is_refused(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    fleet.tick()
    fleet.write("groq_api_keys", "gsk-test-0001", "gsk-test-0002")
    vault.sync()
    hist = sorted((Path(fleet.url[4:]) / "history").iterdir())[0]
    (Path(fleet.url[4:]) / "vault.bin").write_bytes(hist.read_bytes())
    fleet.tick()
    with pytest.raises(vault.VaultError, match="older vault"):
        vault.sync()


def test_a_lost_race_rereads_merges_and_retries_without_losing_the_other_write(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    code = vault.pair_code()
    fleet.on("beta")
    vault.join(code)

    class Racy(vault.DirBackend):
        raced = False

        def put(self, blob, expect):
            if not self.raced:
                Racy.raced = True
                fleet.on("alpha")  # alpha's write lands between beta's read and beta's write
                fleet.write("groq_api_keys", "gsk-test-0001", "gsk-test-alpha")
                vault.sync()
                fleet.on("beta")
            return super().put(blob, expect)

    fleet.tick()
    fleet.write("groq_api_keys", "gsk-test-0001", "gsk-test-beta")
    out = vault.sync(backend=Racy(Path(fleet.url[4:])))
    assert out["pushed"] and out["added_here"] == 1
    assert set(keys_of("groq_api_keys")) == {"gsk-test-0001", "gsk-test-alpha", "gsk-test-beta"}


def test_a_backend_that_always_loses_the_race_gives_up_with_a_message(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    fleet.tick()
    fleet.write("groq_api_keys", "gsk-test-0001", "gsk-test-0002")

    class Never(vault.DirBackend):
        def put(self, blob, expect):
            raise vault.Conflict()

    with pytest.raises(vault.VaultError, match="kept changing"):
        vault.sync(backend=Never(Path(fleet.url[4:])))


def test_the_pairing_code_round_trips_and_a_wrong_code_is_refused_before_anything_is_saved(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    code = vault.pair_code()
    assert code.startswith("zsv1-") and "gsk-test" not in code
    assert vault.parse_code(code) == (vault._load_key(), fleet.url)
    with pytest.raises(vault.VaultError, match="pairing code"):
        vault.parse_code("zsv1-not-a-code")
    fleet.on("stranger")
    with pytest.raises(vault.VaultError, match="does not open"):
        vault.join(_code_with_key(bytes(32), fleet.url))
    assert not vault.configured()


def _code_with_key(key: bytes, url: str) -> str:
    import base64

    payload = {"v": 1, "key": base64.b64encode(key).decode(), "backend": url}
    return vault.CODE_PREFIX + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def test_init_refuses_a_backend_that_already_holds_a_vault_and_a_second_init(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    with pytest.raises(vault.VaultError, match="already has a vault"):
        vault.init(fleet.url)
    fleet.on("other")
    with pytest.raises(vault.VaultError, match="already holds a vault"):
        vault.init(fleet.url)


def test_add_and_remove_by_provider_name_sync_at_once_and_never_echo_a_key(fleet):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    fleet.tick()
    out = vault.add_keys("groq", ["gsk-test-0002", "gsk-test-0001"])
    assert out["added"] == 1 and out["already_there"] == 1 and out["sync"]["pushed"]
    assert "gsk-test-0002" not in json.dumps(out)
    for bad in (["short"], ["has space inside"], []):
        with pytest.raises(vault.VaultError):
            vault.add_keys("groq", bad)
    listed = vault.rows("groq")
    assert {r["fingerprint"] for r in listed} == {config.fingerprint("gsk-test-0001"), config.fingerprint("gsk-test-0002")}
    assert all("gsk-test-0002" not in json.dumps(r) and r["by"] == "alpha" for r in listed)
    fleet.tick()
    gone = vault.remove_key("groq", config.fingerprint("gsk-test-0001"))
    assert gone["sync"]["from_vault"] == 1 and keys_of("groq_api_keys") == ["gsk-test-0002"]
    with pytest.raises(vault.VaultError, match="no key in"):
        vault.remove_key("groq", "deadbeef")
    with pytest.raises(vault.VaultError, match="not a list"):
        vault.list_file("../../etc/passwd")


def test_ssh_backend_only_accepts_plain_addresses_and_directories():
    ok = vault.SshBackend("ssh://user@vault.example.invalid/hswarm-vault")
    assert (ok.dest, ok.dir, ok.port) == ("user@vault.example.invalid", "hswarm-vault", None)
    assert vault.SshBackend("ssh://vault-host:2222//srv/hswarm/vault").dir == "/srv/hswarm/vault"
    for bad in ("ssh://-oProxyCommand=x/v", "ssh://host/../etc", "ssh://host/a b", "ssh://host/", "ssh://host/v;rm", "http://host/v", "ssh://us er@host/v"):
        with pytest.raises(vault.VaultError):
            vault.SshBackend(bad)
    with pytest.raises(vault.VaultError, match="unknown backend"):
        vault.open_backend("s3://bucket/x")


def test_ssh_backend_maps_the_remote_exit_codes_and_sends_a_quote_free_command():
    calls = []

    def runner(rc, out=b"", err=""):
        def run(script, stdin):
            calls.append((script, stdin))
            return rc, out, err
        return run

    be = vault.SshBackend("ssh://user@host/hswarm-vault", run=runner(3))
    assert be.get() == (None, None)
    assert vault.SshBackend("ssh://host/v", run=runner(0, b"blob")).get() == (b"blob", vault._etag(b"blob"))
    with pytest.raises(vault.VaultError, match="Permission denied"):
        vault.SshBackend("ssh://host/v", run=runner(255, err="Permission denied (publickey)")).get()
    blob = b"ZSV1-ciphertext"
    ok = vault.SshBackend("ssh://host/v", run=runner(0))
    assert ok.put(blob, None) == vault._etag(blob)
    script, stdin = calls[-1]
    assert stdin == blob and "test $cur = none" in script and f"= {vault._etag(blob)}" in script and '"' not in script
    for rc in (5, 7):
        with pytest.raises(vault.Conflict):
            vault.SshBackend("ssh://host/v", run=runner(rc)).put(blob, "0" * 64)
    with pytest.raises(vault.VaultError, match="locked"):
        vault.SshBackend("ssh://host/v", run=runner(4)).put(blob, None)


def test_pair_prints_only_to_a_terminal(fleet, capsys):
    fleet.on("alpha")
    fleet.write("groq_api_keys", "gsk-test-0001")
    vault.init(fleet.url)
    assert cli.main(["vault", "pair"]) == 2
    captured = capsys.readouterr()
    assert captured.out == "" and "terminal" in captured.err


def test_status_and_sync_work_through_the_cli_and_print_no_key(fleet, capsys):
    fleet.on("alpha")
    assert cli.main(["vault", "status", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["configured"] is False
    fleet.write("groq_api_keys", "gsk-test-secret-0001")
    assert cli.main(["vault", "init", fleet.url, "--json"]) == 0
    assert cli.main(["vault", "sync"]) == 0
    assert cli.main(["vault", "list", "groq"]) == 0
    assert cli.main(["vault", "status"]) == 0
    out = capsys.readouterr().out
    assert "gsk-test-secret-0001" not in out and config.fingerprint("gsk-test-secret-0001") in out
    assert cli.main(["vault", "sync"]) == 0 and cli.main(["vault", "remove", "groq"]) == 2


def test_unconfigured_machine_says_what_to_do(fleet):
    fleet.on("alpha")
    with pytest.raises(vault.VaultError, match="vault init"):
        vault.sync()


def test_the_servers_loop_syncs_when_a_vault_exists_and_reports_each_failure_once(fleet, monkeypatch, capsys):
    fleet.on("alpha")
    steps = iter(["fail", "fail", "ok"])
    sleeps = {"n": 0}

    def fake_sync():
        if next(steps) == "fail":
            raise vault.VaultError("could not read the vault over ssh (host): refused")
        return {"pushed": True, "added_here": 0, "removed_here": 0, "rev": 4, "to_vault": 2, "keys": 9}

    class Stop(BaseException):
        pass

    def fake_sleep(_s):  # the first sleep is the start-up delay; stop after the loop has run its three rounds
        sleeps["n"] += 1
        if sleeps["n"] >= 4:
            raise Stop()

    monkeypatch.setattr(vault, "configured", lambda: True)
    monkeypatch.setattr(vault, "sync", fake_sync)
    monkeypatch.setattr(vault.time, "sleep", fake_sleep)
    with contextlib.suppress(Stop):
        vault.autosync_loop()
    err = capsys.readouterr().err
    assert err.count("sync failed") == 1 and "rev 4: 2 keys to the vault" in err


def _zswarm_paired(fleet, monkeypatch, *keys: str) -> Path:
    """A ZSwarm on this machine that made a vault (its own throwaway home, pointed at by ZSWARM_HOME): returns that home."""
    fleet.on("zs")
    fleet.write("groq_api_keys", *keys)
    vault.init(fleet.url)
    zs_home = config.HOME
    monkeypatch.setenv("ZSWARM_HOME", str(zs_home))
    return zs_home


def test_adopt_copies_the_zswarm_vault_setup_owner_only_and_its_first_sync_only_adds(fleet, monkeypatch):
    zs_home = _zswarm_paired(fleet, monkeypatch, "gsk-test-0001", "gsk-test-0002")
    fleet.on("hs")
    fleet.write("groq_api_keys", "gsk-test-0003")
    assert "adopt" in vault.status()
    out = vault.adopt()
    assert vault.key_file().read_bytes() == (zs_home / "vault.key").read_bytes()
    assert json.loads(vault.config_file().read_text(encoding="utf-8")) == json.loads((zs_home / "vault.json").read_text(encoding="utf-8"))
    if os.name != "nt":
        assert stat.S_IMODE(vault.key_file().stat().st_mode) == 0o600 and stat.S_IMODE(vault.config_file().stat().st_mode) == 0o600
    assert out["added_here"] == 2 and out["removed_here"] == 0 and out["to_vault"] == 1 and out["keys"] == 3
    assert set(keys_of("groq_api_keys")) == {"gsk-test-0001", "gsk-test-0002", "gsk-test-0003"}
    assert "adopt" not in vault.status()


def test_adopt_refuses_when_hswarm_home_already_has_a_vault_or_zswarm_has_none(fleet, monkeypatch):
    fleet.on("hs")
    with pytest.raises(vault.VaultError, match="no ZSwarm vault"):
        vault.adopt()
    assert not vault.configured()
    fleet.write("groq_api_keys", "gsk-test-0009")
    vault.init(f"dir:{fleet.tmp / 'own-server'}")
    mine = vault.key_file().read_bytes()
    _zswarm_paired(fleet, monkeypatch, "gsk-test-0001")
    fleet.on("hs")
    with pytest.raises(vault.VaultError, match="already has a vault"):
        vault.adopt()
    assert vault.key_file().read_bytes() == mine


def test_adopt_copies_nothing_when_the_zswarm_key_does_not_open_the_vault(fleet, monkeypatch):
    zs_home = _zswarm_paired(fleet, monkeypatch, "gsk-test-0001")
    (zs_home / "vault.key").write_text(base64.b64encode(bytes(32)).decode() + "\n", encoding="utf-8")
    fleet.on("hs")
    with pytest.raises(vault.VaultError, match="does not open"):
        vault.adopt()
    assert not vault.key_file().exists() and not vault.config_file().exists()


def test_adopt_and_status_through_the_cli_never_print_the_vault_key(fleet, monkeypatch, capsys):
    zs_home = _zswarm_paired(fleet, monkeypatch, "gsk-test-secret-0001")
    key_text = (zs_home / "vault.key").read_text(encoding="utf-8").strip()
    fleet.on("hs")
    assert cli.main(["vault", "status"]) == 0
    assert "hswarm vault adopt" in capsys.readouterr().out
    assert cli.main(["vault", "adopt"]) == 0
    assert cli.main(["vault", "adopt", "--json"]) == 2
    assert cli.main(["vault", "status", "--json"]) == 0
    seen = capsys.readouterr()
    text = seen.out + seen.err
    raw = base64.b64decode(key_text)
    assert key_text not in text and raw.hex() not in text and "gsk-test-secret-0001" not in text
    assert "adopted_from" in text and "keys: 1" in text and "already has a vault" in text


def test_the_servers_sync_tick_does_nothing_without_a_vault(fleet, monkeypatch, capsys):
    fleet.on("hs")

    def must_not_run(**_kw):
        raise AssertionError("sync ran without a vault")

    monkeypatch.setattr(vault, "sync", must_not_run)
    assert vault.autosync_tick() is None and vault.autosync_tick("earlier failure") is None
    assert capsys.readouterr().err == ""


# Sealed pairing (wire format v1, shared with ZSwarm): request on the new machine, grant on a vault machine, accept.

def _server(fleet) -> Path:
    return Path(fleet.url[4:])


def _request_files(fleet) -> list[str]:
    folder = _server(fleet) / "requests"
    return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


def _alias(fleet) -> str:
    """The same server under another spelling: what box-b reaches it as (an ssh alias, in real life)."""
    return f"{fleet.url}/."


def _vault_and_request(fleet, capsys) -> str:
    """box-a holds a vault, box-b asked to join it through its own alias; returns box-b's fingerprint (box-b is current)."""
    fleet.on("box-a")
    fleet.write("groq_api_keys", "gsk-test-from-a-0001")
    vault.init(fleet.url)
    fleet.on("box-b")
    assert cli.main(["vault", "request", _alias(fleet), "--json"]) == 0
    return json.loads(capsys.readouterr().out)["fingerprint"]


def test_sealed_pairing_round_trip_joins_b_without_the_code_ever_printing(fleet, capsys):
    fp = _vault_and_request(fleet, capsys)
    assert vault.request(_alias(fleet))["fingerprint"] == fp  # a repeat re-uses the saved key
    assert _request_files(fleet) == ["box-b.json"]
    fleet.write("groq_api_keys", "gsk-test-from-b-0002")
    assert vault.status()["request"] == {"machine": "box-b", "fingerprint": fp, "granted": "no"}

    fleet.on("box-a")
    assert vault.status()["pending_requests"] == 1
    a_key = vault.key_file().read_bytes()
    code = vault.pair_code()
    assert cli.main(["vault", "grant", "--yes", fp]) == 0
    granted = capsys.readouterr().out
    assert granted.splitlines()[-1] == f"granted box-b ({fp})"
    sealed = (_server(fleet) / "requests" / "box-b.sealed").read_text(encoding="utf-8")
    assert code not in sealed and code not in granted
    assert vault.status()["pending_requests"] == 0

    fleet.on("box-b")
    assert vault.status()["request"]["granted"] == "yes"
    assert cli.main(["vault", "accept"]) == 0
    seen = capsys.readouterr()
    assert code not in seen.out + seen.err and a_key.decode().strip() not in seen.out + seen.err
    assert "joined:" in seen.out and "added_here: 1" in seen.out
    assert vault.key_file().read_bytes() == a_key
    assert json.loads(vault.config_file().read_text(encoding="utf-8"))["backend"] == _alias(fleet)  # the URL box-b asked on
    assert set(keys_of("groq_api_keys")) == {"gsk-test-from-a-0001", "gsk-test-from-b-0002"}
    assert _request_files(fleet) == []
    assert not vault.request_key_file().exists() and not vault.request_file().exists()
    st = vault.status()
    assert "request" not in st and "adopt` has nothing to do" in st["paired_by"]

    fleet.on("box-a")
    fleet.tick()
    vault.sync()
    assert set(keys_of("groq_api_keys")) == {"gsk-test-from-a-0001", "gsk-test-from-b-0002"}


def test_grant_refuses_without_a_person_or_with_a_wrong_fingerprint_and_writes_nothing(fleet, capsys, monkeypatch):
    fp = _vault_and_request(fleet, capsys)
    fleet.on("box-a")
    before = (_server(fleet) / "vault.bin").read_bytes()
    for argv in (["vault", "grant"], ["vault", "grant", "box-b", "--yes", fp[:4]], ["vault", "grant", "--yes", "0000-0000-0000-0000"],
                 ["vault", "grant", "--yes", fp.lower()]):
        assert cli.main(argv) == 2, argv
    assert "nothing was granted" in capsys.readouterr().err

    class Tty:
        @staticmethod
        def isatty():
            return True

    monkeypatch.setattr(sys, "stdin", Tty())
    monkeypatch.setattr("builtins.input", lambda _prompt: "1111" if fp[:4] == "0000" else "0000")
    assert cli.main(["vault", "grant"]) == 2
    with pytest.raises(vault.VaultError, match="does not match"):
        vault.grant(ask=lambda row: fp[:3])
    assert _request_files(fleet) == ["box-b.json"] and (_server(fleet) / "vault.bin").read_bytes() == before

    monkeypatch.setattr("builtins.input", lambda _prompt: fp[:4].lower())  # the person typed it at the terminal
    assert cli.main(["vault", "grant"]) == 0
    assert _request_files(fleet) == ["box-b.json", "box-b.sealed"]


def test_accept_before_a_grant_says_not_granted_yet_and_changes_nothing(fleet, capsys):
    _vault_and_request(fleet, capsys)
    local = (vault.request_key_file().read_bytes(), vault.request_file().read_bytes())
    assert cli.main(["vault", "accept"]) == 3
    assert "not granted yet" in capsys.readouterr().err
    assert not vault.configured() and _request_files(fleet) == ["box-b.json"]
    assert (vault.request_key_file().read_bytes(), vault.request_file().read_bytes()) == local


def test_a_tampered_or_foreign_grant_does_not_open_and_nothing_is_saved(fleet, capsys):
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    fp = _vault_and_request(fleet, capsys)
    fleet.on("box-a")
    vault.grant("box-b", yes=fp)
    code = vault.pair_code()
    path = _server(fleet) / "requests" / "box-b.sealed"
    good = json.loads(path.read_text(encoding="utf-8"))
    ct = bytearray(base64.b64decode(good["ct"]))
    ct[0] ^= 1
    stranger = vault._raw_pub(X25519PrivateKey.generate())
    bad = [{**good, "ct": base64.b64encode(bytes(ct)).decode()},     # one flipped bit
           {**good, "machine": "box-c"},                             # someone else's grant renamed
           vault.seal_grant(code, stranger, "box-b"),                # sealed to another request's key
           {**good, "nonce": base64.b64encode(bytes(12)).decode()}]  # another nonce
    fleet.on("box-b")
    for doc in bad:
        path.write_text(json.dumps(doc), encoding="utf-8")
        with pytest.raises(vault.VaultError, match="does not open") as err:
            vault.accept()
        assert code not in str(err.value)
        assert not vault.configured() and vault.request_key_file().exists()
        assert _request_files(fleet) == ["box-b.json", "box-b.sealed"]
    path.write_text(json.dumps(good), encoding="utf-8")
    assert vault.accept()["joined"] == f"dir:{_server(fleet)}"


def test_a_bad_request_name_is_refused_before_any_file_access(fleet):
    fleet.on("box-a")
    server = _server(fleet)
    (server / "requests").mkdir(parents=True)
    (server / "vault.bin").write_bytes(b"ZSV1-not-a-request")
    bad = ["../vault.bin", "Box.json", "-box.json", "box.txt", "a/b.json", "box.json\n", "x" * 64 + ".json", ""]
    calls = []
    backends = (vault.DirBackend(server),
                vault.SshBackend("ssh://host.example.invalid/hswarm-vault", run=lambda script, stdin: calls.append(script) or (0, b"", "")))
    for name in bad:
        for be in backends:
            for op in (lambda: be.read_request(name), lambda: be.write_request(name, b"{}"), lambda: be.delete_request(name)):
                with pytest.raises(vault.VaultError, match="not a pairing request name"):
                    op()
    assert calls == [] and (server / "vault.bin").read_bytes() == b"ZSV1-not-a-request"
    assert sorted(p.name for p in server.iterdir()) == ["requests", "vault.bin"] and not any((server / "requests").iterdir())
    backends[1].write_request("box-b.json", b"{}")
    assert calls[-1].endswith("mv -f $d/.box-b.json.tmp $d/box-b.json") and "chmod 700 $d" in calls[-1]


def test_golden_vector_matches_the_spec_shared_with_zswarm():
    """Fixed inputs from the wire-format v1 spec; ZSwarm's tests hold the same literals, so a drift fails on one side."""
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    req_pub = vault._raw_pub(X25519PrivateKey.from_private_bytes(bytes(range(32))))
    assert vault.request_fingerprint(req_pub) == "EEDD-883D-A0A9-4515"
    doc = vault.seal_grant("zsv1-test", req_pub, "box-b", eph_priv=bytes(range(32, 64)), nonce=bytes(12))
    assert doc == {"v": 1, "machine": "box-b", "eph": "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=",
                   "nonce": "AAAAAAAAAAAAAAAA", "ct": "ISQHMsZigh6EfC1+EgXfB4lseEmuazCE8g=="}
    assert vault.open_grant(doc, bytes(range(32)), "box-b") == "zsv1-test"
