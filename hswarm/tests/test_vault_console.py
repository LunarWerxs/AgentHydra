"""Offline: the console's vault routes (console.py /api/vault/*). Two "machines" are two throwaway HSWARM_HOMEs and secrets/ folders
over one dir: backend in tmp_path; nothing here touches a real HSWARM_HOME, ~/.zswarm or a server."""
from __future__ import annotations

from starlette.testclient import TestClient

from hswarm import config, console, vault

FAKE_KEY = "sk-fake-console-key-0001"


class Machines:
    """`on(name)` makes that machine current (its home, its secrets/, its host name); the console reads them on every call."""

    def __init__(self, tmp_path, monkeypatch):
        self.tmp, self.mp = tmp_path, monkeypatch
        self.url = f"dir:{tmp_path / 'server'}"
        monkeypatch.setenv("ZSWARM_HOME", str(tmp_path / "no-zswarm"))
        from mcp.server.mcpserver import MCPServer

        server = MCPServer("vault-console-test")
        console.mount(server, 7793)
        self.client = TestClient(server.streamable_http_app(), base_url="http://127.0.0.1:7793")
        self.on("alpha")

    def on(self, name: str):
        home, secrets = self.tmp / name / "home", self.tmp / name / "secrets"
        secrets.mkdir(parents=True, exist_ok=True)
        self.mp.setattr(config, "HOME", home)
        self.mp.setattr(config, "SECRETS_DIR", secrets)
        self.mp.setattr(vault.socket, "gethostname", lambda: name)
        return secrets

    def get(self, route: str, /):
        return self.client.get(f"/api/{route}", headers={"X-Hswarm-Token": console.token()})

    def post(self, route: str, /, **body):
        return self.client.post(f"/api/{route}", headers={"X-Hswarm-Token": console.token()}, json=body)


def machines(tmp_path, monkeypatch) -> Machines:
    m = Machines(tmp_path, monkeypatch)
    (config.SECRETS_DIR / "groq_api_keys").write_text(FAKE_KEY + "\n", encoding="utf-8")
    return m


def test_vault_status_says_folder_by_default_and_vault_once_set_up(tmp_path, monkeypatch):
    m = machines(tmp_path, monkeypatch)
    folder = m.get("vault/status").json()
    assert folder["mode"] == "folder" and folder["folder"] == {"path": str(config.SECRETS_DIR), "lists": {"groq_api_keys": 1}, "keys": 1}
    assert "backend" not in folder and "vault" not in folder

    made = m.post("vault/init", kind="dir", path=str(tmp_path / "server"))
    assert made.status_code == 200 and made.json()["set_up"]
    s = m.get("vault/status").json()
    assert s["mode"] == "vault" and s["machine"] == "alpha" and s["backend"] and s["last_sync"]
    assert s["vault"]["keys"] == 1 and s["pending_requests"] == 0 and not s.get("vault_error")
    assert s["folder"]["keys"] == 1  # the folder stays the working copy
    assert FAKE_KEY not in m.get("vault/status").text


def test_vault_grant_through_the_console_needs_the_full_fingerprint(tmp_path, monkeypatch):
    m = machines(tmp_path, monkeypatch)
    assert m.post("vault/init", kind="dir", path=str(tmp_path / "server")).status_code == 200
    m.on("beta")
    asked = m.post("vault/request", kind="dir", path=str(tmp_path / "server")).json()
    fp = asked["fingerprint"]
    m.on("alpha")
    waiting = m.get("vault/requests").json()["requests"]
    assert [(r["machine"], r["fingerprint"], r["granted"]) for r in waiting] == [("beta", fp, False)] and "pub" not in waiting[0]
    assert m.get("vault/status").json()["pending_requests"] == 1

    for wrong in (fp[:4], fp[:4].lower(), "0000-0000-0000-0000", fp[:-1], ""):
        refused = m.post("vault/grant", machine="beta", fingerprint=wrong)
        assert refused.status_code == 400 and refused.json()["error"]
    assert not (tmp_path / "server" / "requests" / "beta.sealed").exists()

    ok = m.post("vault/grant", machine="beta", fingerprint=fp.replace("-", "").lower())  # case and dashes do not matter
    assert ok.status_code == 200 and ok.json() == {"granted": "beta", "fingerprint": fp}
    assert (tmp_path / "server" / "requests" / "beta.sealed").exists()
    assert vault.pair_code() not in ok.text


def test_vault_join_through_the_console_never_returns_the_code(tmp_path, monkeypatch):
    m = machines(tmp_path, monkeypatch)
    assert m.post("vault/init", kind="dir", path=str(tmp_path / "server")).status_code == 200
    code = vault.pair_code()
    m.on("beta")
    (config.SECRETS_DIR / "groq_api_keys").write_text("sk-fake-beta-key-0002\n", encoding="utf-8")

    bad = m.post("vault/join", code=code[:-6] + "AAAAAA")
    assert bad.status_code == 400 and code not in bad.text and not vault.configured()

    joined = m.post("vault/join", code=code)
    assert joined.status_code == 200 and vault.configured()
    assert code not in joined.text and code[len(vault.CODE_PREFIX):] not in joined.text
    assert code not in m.get("vault/status").text
    assert sorted((config.SECRETS_DIR / "groq_api_keys").read_text(encoding="utf-8").split()) == sorted([FAKE_KEY, "sk-fake-beta-key-0002"])


def test_vault_accept_says_not_granted_yet_then_joins(tmp_path, monkeypatch):
    m = machines(tmp_path, monkeypatch)
    assert m.post("vault/init", kind="dir", path=str(tmp_path / "server")).status_code == 200
    m.on("beta")
    fp = m.post("vault/request", kind="dir", path=str(tmp_path / "server")).json()["fingerprint"]
    assert m.get("vault/status").json()["request"]["fingerprint"] == fp
    waiting = m.post("vault/accept")
    assert waiting.status_code == 200 and waiting.json()["granted"] is False and not vault.configured()
    m.on("alpha")
    assert m.post("vault/grant", machine="beta", fingerprint=fp).status_code == 200
    m.on("beta")
    done = m.post("vault/accept")
    assert done.status_code == 200 and done.json()["granted"] is True and vault.configured()


def test_vault_leave_keeps_the_folders_keys_and_the_backend(tmp_path, monkeypatch):
    m = machines(tmp_path, monkeypatch)
    assert m.post("vault/init", kind="dir", path=str(tmp_path / "server")).status_code == 200
    assert m.post("vault/leave").status_code == 400 and vault.configured()  # no confirm, no leave

    left = m.post("vault/leave", confirm=True)
    assert left.status_code == 200 and left.json()["kept_in_folder"] == 1
    assert not vault.configured()
    assert not any((config.HOME / n).exists() for n in ("vault.key", "vault.json", "vault-base.json"))
    assert (config.SECRETS_DIR / "groq_api_keys").read_text(encoding="utf-8").strip() == FAKE_KEY
    assert (tmp_path / "server" / "vault.bin").exists()
    assert m.get("vault/status").json()["mode"] == "folder"
    assert m.post("vault/leave", confirm=True).status_code == 400  # nothing left to leave
