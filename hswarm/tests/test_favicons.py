"""Offline: a provider's icon comes from its website, and a site with none leaves the console on its initials."""
from __future__ import annotations

import asyncio

import httpx

from hswarm import config, favicons

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


# Contract: the icon a home page declares wins (its largest), a site with no declaration falls back to /favicon.ico,
# and an answer that is not an image (a web app's HTML at /favicon.ico) is never kept: the provider reads "missing"
# and the console keeps its initials. Regression: an HTML page stored and served as a provider's icon.
def test_a_website_gives_its_declared_icon_else_favicon_ico_and_never_a_page(monkeypatch, user_toml):
    pages = {
        "https://a.test/": (200, "text/html", b'<link rel="icon" href="/s.png" sizes="16x16"><link rel="icon" href="/big.png" sizes="192x192">'),
        "https://a.test/big.png": (200, "image/png", PNG),
        "https://b.test/": (200, "text/html", b"<title>no icon declared</title>"),
        "https://b.test/favicon.ico": (200, "application/octet-stream", b"\x00\x00\x01\x00" + b"\x00" * 30),
        "https://c.test/": (200, "text/html", b"<p>an app</p>"),
        "https://c.test/favicon.ico": (200, "text/html", b"<!doctype html><p>an app</p>"),
    }

    def handler(req: httpx.Request):
        status, kind, body = pages.get(str(req.url), (404, "text/plain", b"no"))
        return httpx.Response(status, headers={"content-type": kind}, content=body)

    for name, site in (("aco", "https://a.test/"), ("bco", "https://b.test/"), ("cco", "https://c.test/")):
        user_toml(name, f'base_url = "https://api.{name}.test/v1"\nwebsite = "{site}"\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: real(*a, **{**kw, "transport": httpx.MockTransport(handler)}))
    assert asyncio.run(favicons.fetch_all(["aco", "bco", "cco"])) == {"aco": "ok", "bco": "ok", "cco": "missing"}
    assert favicons.image("aco") == (PNG, "image/png") and favicons.image("bco")[1] == "image/x-icon"
    assert favicons.state("aco")[0] == "ok" and favicons.state("cco") == ("missing", "") and favicons.image("cco") is None
    user_toml("aco", 'base_url = "https://api.aco.test/v1"\nwebsite = "https://elsewhere.test/"\n')
    assert favicons.state("aco") == ("unknown", "")  # a new website is fetched again
    assert config.PROVIDERS["aco"]["website"] == "https://elsewhere.test/"
