"""Offline: read_url's per-host gate (allow / deny / suspend) and its host-routed backends. No network: every
fetch goes through an httpx.MockTransport that records what was asked of it."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import web  # noqa: E402
from hswarm.spec import Task  # noqa: E402


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _fresh_backends(monkeypatch):
    # Demotions are process-wide; one test's failed backend must not reorder the next test's channel.
    monkeypatch.setattr(web, "_demoted", {})
    monkeypatch.delenv("HSWARM_WEB_BLOCK", raising=False)
    monkeypatch.delenv("HSWARM_WEB_WEB", raising=False)


def session(allowed, routes, dns=None):
    """A WebSession whose transport serves `routes` ({url: httpx.Response}) and logs every URL it was asked for.
    Names resolve through `dns` ({host: [addresses]}), else to one public address: no real lookup is made."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return routes.get(str(request.url), httpx.Response(404))

    async def resolve(host: str) -> list[str]:
        return (dns or {}).get(host, ["93.184.216.34"])

    return web.WebSession(list(allowed), transport=httpx.MockTransport(handler), resolve=resolve), seen


def test_unknown_host_suspends_without_fetching():
    s, seen = session(["docs.example.com"], {"https://docs.example.com/a": httpx.Response(200, html="<h1>Hi</h1><p>there</p>")})
    out = run(s.read("https://evil.test/x?q=1"))
    run(s.read("https://evil.test/other"))  # the same host asked twice is one approval, not two
    assert out.startswith("APPROVAL NEEDED") and seen == []
    assert [(a["host"], a["kind"], a["severity"]) for a in s.approvals] == [("evil.test", "domain_access", "medium")]
    ok = run(s.read("https://docs.example.com/a"))
    assert "# Hi" in ok and "there" in ok and seen == ["https://docs.example.com/a"]


def test_block_list_beats_every_allow_and_star_never_opens_loopback():
    web.save_policy(block=["bad.example"])
    assert web.gate("https://cdn.bad.example/x", ["*", "bad.example"]).action == "deny"
    assert web.gate("http://127.0.0.1:8080/", ["*"]).action == "deny"
    assert web.gate("http://localhost/", ["localhost"]).action == "allow"  # listed by its exact name
    assert web.gate("file:///etc/passwd", ["*"]).action == "deny"


def test_star_never_opens_loopback_by_numeric_form_or_by_a_name_that_resolves_to_it():
    # Contract: under `*` no spelling of this machine is fetched. Regression: is_private parsed only dotted
    # quads, so 127.1 / 2130706433 / 0x7f000001 and a public name pointing at 127.0.0.1 all got through.
    for url in ("http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://[::ffff:127.0.0.1]/"):
        assert web.gate(url, ["*"]).action == "deny", url
    s, seen = session(["*"], {"http://rebind.example/": httpx.Response(200, text="secret")}, dns={"rebind.example": ["127.0.0.1"]})
    out = run(s.read("http://rebind.example/"))
    assert out.startswith("ERROR: read_url refused") and "127.0.0.1" in out and seen == []
    s2, seen2 = session(["rebind.example"], {"http://rebind.example/": httpx.Response(200, text="mine")}, dns={"rebind.example": ["127.0.0.1"]})
    assert "mine" in run(s2.read("http://rebind.example/")) and seen2 == ["http://rebind.example/"]  # its exact name opens it


def test_allow_always_is_the_standing_policy_and_forget_undoes_it():
    assert web.gate("https://news.example.org/", []).action == "suspend"
    web.save_policy(allow=["example.org"])
    assert web.gate("https://news.example.org/", []).action == "allow"
    web.save_policy(forget=["example.org"])
    assert web.gate("https://news.example.org/", []).action == "suspend"


def test_redirect_to_an_unknown_host_is_gated_not_followed():
    s, seen = session(["ok.example"], {"https://ok.example/go": httpx.Response(302, headers={"location": "https://exfil.test/steal"})})
    out = run(s.read("https://ok.example/go"))
    assert out.startswith("APPROVAL NEEDED") and s.approvals[0]["host"] == "exfil.test"
    assert seen == ["https://ok.example/go"]


def test_github_blob_reads_the_raw_file_and_a_failed_backend_drops_behind():
    raw = "https://raw.githubusercontent.com/o/r/main/x.py"
    s, seen = session(["github.com"], {raw: httpx.Response(200, text="print(1)\n")})
    out = run(s.read("https://github.com/o/r/blob/main/x.py"))
    assert out.startswith("[read_url github/github-raw]") and "print(1)" in out
    # A page github-raw cannot map falls through to the plain fetch without demoting github-raw: the next blob
    # read must still get the raw file. A 404 on one raw path does not demote it either; a 429 does.
    github = web.channel_for("github.com")
    s2, _ = session(["github.com"], {"https://github.com/o/r/issues/1": httpx.Response(200, html="<p>issue</p>")})
    assert run(s2.read("https://github.com/o/r/issues/1")).startswith("[read_url github/direct]")
    assert [b for b, *_ in web.order(github)] == ["github-raw", "direct"]
    s3, _ = session(["github.com"], {"https://github.com/o/r/blob/main/typo.py": httpx.Response(200, html="<p>404 page</p>")})
    run(s3.read("https://github.com/o/r/blob/main/typo.py"))  # raw answers 404 (the mock's default)
    assert [b for b, *_ in web.order(github)] == ["github-raw", "direct"]
    s4, _ = session(["github.com"], {raw: httpx.Response(429), "https://github.com/o/r/blob/main/x.py": httpx.Response(200, text="page")})
    assert run(s4.read("https://github.com/o/r/blob/main/x.py")).startswith("[read_url github/direct]")
    assert [b for b, *_ in web.order(github)] == ["direct", "github-raw"]


def test_a_redirect_without_location_or_a_malformed_one_is_an_error_string_not_a_read():
    s, _ = session(["ok.example"], {"https://ok.example/a": httpx.Response(302, text="moved"),
                                    "https://ok.example/b": httpx.Response(302, headers={"location": "http://[bad/"})})
    assert run(s.read("https://ok.example/a")).startswith("ERROR: read_url could not read it")
    assert run(s.read("https://ok.example/b")).startswith("ERROR")


def test_env_promotes_a_backend(monkeypatch):
    github = web.channel_for("github.com")
    assert web.order(github)[0][0] == "github-raw"
    monkeypatch.setenv("HSWARM_WEB_GITHUB", "direct")
    assert [b for b, *_ in web.order(github)] == ["direct", "github-raw"]


def test_approvals_ride_out_once_per_host_with_their_tasks():
    req = {"request_id": "web-1", "kind": "domain_access", "host": "a.test", "url": "https://a.test/", "severity": "medium"}
    results = [SimpleNamespace(id="t1", web_approvals=[req]), SimpleNamespace(id="t2", web_approvals=[req]), SimpleNamespace(id="t3", web_approvals=[])]
    assert [(a["host"], a["tasks"]) for a in web.collect_approvals(results)] == [("a.test", ["t1", "t2"])]


def test_web_preset_is_api_only_and_web_hosts_takes_a_comma_list(tmp_path):
    t = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "web", "web_hosts": "a.test, b.test"})
    assert t.web_hosts == ["a.test", "b.test"]
    with pytest.raises(ValueError, match="api backend"):
        Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "web", "backend": "cc", "model": "deepseek-flash"})


class _FakeInner(web.httpcore.AsyncNetworkBackend):
    """Records the hosts connect_tcp was asked for; refuses every connection."""

    def __init__(self):
        self.calls: list[str] = []

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.calls.append(host)
        raise web.httpcore.ConnectError("fake: refused")

    async def sleep(self, seconds):
        pass


def test_pinned_backend_connects_the_checked_address_and_refuses_an_unpinned_host():
    # Pins: the name's socket goes to the checked address (next one if the first refuses); an unchecked host never connects.
    inner = _FakeInner()
    backend = web.PinnedBackend(inner)
    backend.pins = {"docs.example.com": ["93.184.216.34", "93.184.216.35"]}
    with pytest.raises(web.httpcore.ConnectError):
        run(backend.connect_tcp("docs.example.com", 443))
    assert inner.calls == ["93.184.216.34", "93.184.216.35"]
    with pytest.raises(web.httpcore.ConnectError):
        run(backend.connect_tcp("other.example.com", 443))
    assert inner.calls == ["93.184.216.34", "93.184.216.35"]


def test_rebinding_name_is_connected_to_the_checked_public_address_not_a_second_lookup():
    # Pins DNS rebinding: a second answer of 127.0.0.1 is never consulted, the socket goes to the checked public address.
    answers = [["93.184.216.34"], ["127.0.0.1"]]
    inner = _FakeInner()

    async def resolve(host):
        return answers.pop(0)

    s = web.WebSession(["rebind.example"], resolve=resolve, network_backend=inner)
    with pytest.raises(httpx.ConnectError):
        run(s.get("https://rebind.example/x"))
    assert inner.calls == ["93.184.216.34"] and len(answers) == 1


def search_session(allowed, replies, monkeypatch):
    """A WebSession whose search providers answer from `replies` ({host: httpx.Response}); every provider holds one
    unit-test key, and each request is logged as (host, JSON body)."""
    import json as _json

    from hswarm import config

    monkeypatch.setattr(config, "load_api_keys", lambda p="": ["unit-test-key"] if p in ("tavily", "jina") else [])
    seen: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, _json.loads(request.content or b"{}")))
        return replies.get(request.url.host, httpx.Response(404))

    return web.WebSession(list(allowed), transport=httpx.MockTransport(handler)), seen


def test_search_is_capped_and_held_to_the_web_policy(monkeypatch):
    # Contract: web_search asks for at most SEARCH_MAX results, drops results the web policy denies (block list,
    # private address) and marks the ones read_url would suspend. Regression: a flood of results or a blocked host
    # reaching the worker's context.
    web.save_policy(block=["bad.example"])
    hits = [{"title": "Docs", "url": "https://docs.example.com/a", "content": "x " * 400},
            {"title": "Blocked", "url": "https://cdn.bad.example/b", "content": "no"},
            {"title": "Local", "url": "http://127.0.0.1/admin", "content": "no"},
            {"title": "Other", "url": "https://other.example.org/c", "content": "elsewhere"}]
    s, seen = search_session(["docs.example.com"], {"api.tavily.com": httpx.Response(200, json={"results": hits})}, monkeypatch)
    out = run(s.search("  example\n topic  ", max_results=99))
    assert seen == [("api.tavily.com", {"query": "example topic", "max_results": web.SEARCH_MAX, "search_depth": "basic"})]
    assert "bad.example" not in out and "127.0.0.1" not in out and "2 dropped by the web policy" in out
    docs, other = (line for line in out.splitlines() if line.strip().startswith("http"))
    assert "outside web_hosts" not in docs and other.endswith("[outside web_hosts]")
    assert max(len(line) for line in out.splitlines()) <= web.SNIPPET_CHARS + 3


def test_search_falls_back_to_jina_and_a_blocked_or_keyless_provider_is_never_asked(monkeypatch):
    # Contract: a provider that fails drops behind the next one for a while, one on the admin block list gets no
    # query at all, and with no key anywhere the worker gets an ERROR string, not an exception.
    jina = httpx.Response(200, json={"data": [{"title": "J", "url": "https://docs.example.com/j", "description": "from jina"}]})
    s, seen = search_session(["*"], {"api.tavily.com": httpx.Response(503), "s.jina.ai": jina}, monkeypatch)
    out = run(s.search("example topic"))
    assert "[web_search jina]" in out and "from jina" in out
    assert [h for h, _ in seen] == ["api.tavily.com", "s.jina.ai"]
    seen.clear()
    run(s.search("example topic"))
    assert [h for h, _ in seen] == ["s.jina.ai"]  # tavily is demoted: jina is asked first and answers
    web.save_policy(block=["s.jina.ai"])
    monkeypatch.setattr(web, "_demoted", {})
    seen.clear()
    out = run(s.search("example topic"))
    assert [h for h, _ in seen] == ["api.tavily.com"] and out.startswith("ERROR: web_search could not search")
    assert "admin block list" in out
    from hswarm import config

    monkeypatch.setattr(config, "load_api_keys", lambda p="": [])
    seen.clear()
    assert run(s.search("example topic")).startswith("ERROR: web_search could not search") and seen == []
