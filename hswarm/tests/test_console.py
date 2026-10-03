"""The console's two locks, and the client registrations `hswarm install` writes."""
from __future__ import annotations

import tomllib

from starlette.testclient import TestClient

from hswarm import console, install


def _app():
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("console-test")
    console.mount(server, 7793)
    return server.streamable_http_app()


def test_the_api_answers_only_this_machine_with_the_token(monkeypatch):
    client = TestClient(_app(), base_url="http://127.0.0.1:7793")
    assert console.token() in client.get("/ui").text  # no sign-in by default: the page opens straight away
    monkeypatch.setenv("HSWARM_UI_SIGN_IN", "1")
    client = TestClient(_app(), base_url="http://127.0.0.1:7793")
    assert client.get("/api/state").status_code == 401
    assert client.get("/api/state", headers={"X-Hswarm-Token": "wrong"}).status_code == 401
    token = {"X-Hswarm-Token": console.token()}
    assert client.get("/api/state", headers={**token, "Host": "evil.example:7793"}).status_code == 403  # DNS rebinding
    assert client.get("/ui", headers={"Host": "evil.example:7793"}).status_code == 403
    ok = client.get("/api/state", headers=token)
    assert ok.status_code == 200 and "providers" in ok.json()
    bare = client.get("/ui")  # with sign-in on, a bare request gets no token until a browser signs in
    assert bare.status_code == 401 and console.token() not in bare.text
    icon = client.get("/ui/icon.svg")  # the tab icon: fetched with no token, shipped in the package, never a script
    assert icon.status_code == 200 and icon.headers["content-type"].startswith("image/svg+xml")
    assert "sandbox" in icon.headers["content-security-policy"] and "<svg" in icon.text
    assert client.get("/ui?t=wrong").status_code == 401
    page = client.get(f"/ui?t={console.token()}")  # the link `hswarm ui` opens: a session cookie, then the bare /ui
    assert page.status_code == 200 and str(page.url).endswith("/ui")
    assert console.token() in page.text and "__HSWARM_TOKEN__" not in page.text
    assert console.token() in client.get("/ui").text  # the cookie keeps it signed in
    assert console.token() not in client.get("/ui/core.js").text  # a script another origin can include holds no token
    assert client.post("/api/keys/add", headers=token, json={"provider": "nope", "key": "sk-x-12345678"}).status_code == 400
    # A key never travels in a URL (the access log writes URLs): a POST with a query string is refused.
    assert client.post("/api/keys/add?provider=groq&key=sk-x-12345678", headers=token).status_code == 400
    assert client.get("/api/state", headers={"X-Hswarm-Token": b"\xe9" * 43}).status_code == 401  # a non-ASCII byte: 401, not a 500


def test_codex_registration_keeps_the_rest_of_config_toml(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    cfg = tmp_path / "config.toml"
    cfg.write_text('model = "gpt-6"\n\n[mcp_servers.hswarm]\ncommand = "old"\n\n[mcp_servers.hswarm.env]\nX = "1"\n\n'
                   '[mcp_servers.other]\ncommand = "keep-me"\n', encoding="utf-8")
    install.install_client("codex")
    install.install_client("codex")  # idempotent
    doc = tomllib.loads(cfg.read_text(encoding="utf-8"))
    assert doc["model"] == "gpt-6" and doc["mcp_servers"]["other"]["command"] == "keep-me"
    entry = doc["mcp_servers"]["hswarm"]
    assert entry["args"][-1] == "mcp" and entry["tool_timeout_sec"] >= 600 and "env" not in entry
    assert install.clients()[2] == {"client": "codex", "config": str(cfg), "exists": True, "registered": True}

    install.install_client("codex", remove=True)
    doc = tomllib.loads(cfg.read_text(encoding="utf-8"))
    assert "hswarm" not in doc["mcp_servers"] and doc["mcp_servers"]["other"]["command"] == "keep-me"


def test_daily_spend_counts_each_ledger_line_once_and_waits_for_a_whole_line():
    import datetime as dt
    import json

    from hswarm import config, ledger

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    row = lambda status, cost: json.dumps({"ts": now, "status": status, "cost_usd": cost, "provider": "groq"}) + "\n"  # noqa: E731
    config.LEDGER.parent.mkdir(parents=True, exist_ok=True)
    config.LEDGER.write_text(row("ok", 0.5) + row("error", 0.25), encoding="utf-8")
    today = ledger.daily(2)[-1]
    assert (today["tasks"], today["ok"], today["error"], today["cost_usd"]) == (2, 1, 1, 0.75)

    with config.LEDGER.open("a", encoding="utf-8") as f:  # one whole line, then one still being written
        f.write(row("ok", 1.0) + row("ok", 2.0)[:20])
    assert ledger.daily(2)[-1]["tasks"] == 3  # the partial line is not counted yet, the earlier two not twice
    with config.LEDGER.open("a", encoding="utf-8") as f:
        f.write(row("ok", 2.0)[20:])
    today = ledger.daily(2)[-1]
    assert (today["tasks"], today["cost_usd"], today["providers"]) == (4, 3.75, {"groq": 3.75})
