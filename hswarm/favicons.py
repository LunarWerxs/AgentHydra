"""A provider's icon, taken from its website: the icon the home page declares (a vector one, else the largest),
else the site's /favicon.ico. The local server fetches it once into <home>/favicons/ and serves it to the console
from its own origin, because the console's content policy allows no remote images. Nothing is bundled with
hswarm: a company's icon is its trademark, so each machine fetches its own copy from the company's site."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

import httpx

from . import config

MAX_PAGE = 512 * 1024
MAX_ICON = 256 * 1024
RETRY_S = 24 * 3600  # a site that gave no icon is asked again a day later, not on every page view
TYPES = {"image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml", "image/jpeg", "image/gif", "image/webp"}
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; hswarm-console; +https://github.com/LunarWerxs/AgentHydra)"}


def folder() -> Path:
    return config.HOME / "favicons"


def _website(provider: str) -> str:
    site = (config.PROVIDERS.get(provider) or {}).get("website") or ""
    return site if re.match(r"^https?://", site) else ""


def _version(website: str) -> str:
    return hashlib.sha256(website.encode()).hexdigest()[:10]


def _meta(provider: str) -> dict:
    try:
        return json.loads((folder() / f"{provider}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def state(provider: str) -> tuple[str, str]:
    """("ok", version) when an icon for the provider's current website is on disk; ("missing", "") when the last try
    found none less than a day ago; ("unknown", "") when it has not been fetched for this website; ("none", "") when
    the provider names no website."""
    website = _website(provider)
    if not website:
        return "none", ""
    m = _meta(provider)
    if m.get("version") != _version(website):
        return "unknown", ""
    if m.get("type") and (folder() / f"{provider}.img").exists():
        return "ok", m["version"]
    return ("missing", "") if time.time() - float(m.get("at") or 0) < RETRY_S else ("unknown", "")


def image(provider: str) -> tuple[bytes, str] | None:
    """The stored icon and its content type, or None."""
    m = _meta(provider)
    try:
        return (folder() / f"{provider}.img").read_bytes(), m["type"]
    except (OSError, KeyError):
        return None


class _IconLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found: list[tuple[bool, int, str]] = []

    def handle_starttag(self, tag, attrs):
        if tag != "link":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        rel = a.get("rel", "").lower().split()
        if a.get("href") and ("icon" in rel or "apple-touch-icon" in rel):
            size = max((int(n) for n in re.findall(r"(\d+)x\d+", a.get("sizes", ""))), default=180 if "apple-touch-icon" in rel else 0)
            vector = a.get("type") == "image/svg+xml" or a["href"].lower().split("?")[0].endswith(".svg")
            self.found.append((vector, size, a["href"]))


def candidates(page: str, base: str) -> list[str]:
    """The icons a page declares, best first (a vector one, then the largest), then the site's /favicon.ico."""
    links = _IconLinks()
    links.feed(page)
    ranked = sorted(links.found, key=lambda f: (not f[0], -f[1]))
    urls = [urljoin(base, href) for _v, _s, href in ranked] + [urljoin(base, "/favicon.ico")]
    return [u for u in dict.fromkeys(urls) if u.startswith(("http://", "https://"))]


def _sniff(body: bytes) -> str | None:
    """The image type by its first bytes, for servers that label an icon text/plain or octet-stream."""
    head = body[:512].lstrip().lower()
    for magic, kind in ((b"\x89png", "image/png"), (b"\x00\x00\x01\x00", "image/x-icon"), (b"gif8", "image/gif"), (b"\xff\xd8\xff", "image/jpeg")):
        if body[:len(magic)].lower() == magic:
            return kind
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head):
        return "image/svg+xml"
    return None


async def _get(client: httpx.AsyncClient, url: str, cap: int) -> tuple[int, str, bytes, str] | None:
    """Status, content type, at most `cap` bytes of body, and the final URL; None when the site cannot be reached."""
    try:
        async with client.stream("GET", url) as r:
            body = bytearray()
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > cap:
                    break
            return r.status_code, r.headers.get("content-type", "").split(";")[0].strip().lower(), bytes(body), str(r.url)
    except httpx.HTTPError:
        return None


def _save(provider: str, website: str, body: bytes | None, kind: str) -> None:
    folder().mkdir(parents=True, exist_ok=True)
    if body is not None:
        tmp = folder() / f"{provider}.img.tmp"
        tmp.write_bytes(body)
        os.replace(tmp, folder() / f"{provider}.img")
    meta = {"website": website, "version": _version(website), "type": kind if body is not None else "", "at": time.time()}
    tmp = folder() / f"{provider}.json.tmp"
    tmp.write_text(json.dumps(meta), encoding="utf-8")
    os.replace(tmp, folder() / f"{provider}.json")


async def fetch(provider: str, client: httpx.AsyncClient | None = None) -> str:
    """Fetch and keep the icon of the provider's website: "ok", "missing" (the site offered none that is an image)
    or "none" (no website)."""
    website = _website(provider)
    if not website:
        return "none"
    own = client is None
    client = client or httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=HEADERS)
    try:
        page, base = "", website
        got = await _get(client, website, MAX_PAGE)
        if got and got[0] == 200 and "html" in got[1]:
            page, base = got[2].decode("utf-8", "replace"), got[3]
        for url in candidates(page, base)[:5]:
            got = await _get(client, url, MAX_ICON + 1)
            if not got or got[0] != 200 or not got[2] or len(got[2]) > MAX_ICON:
                continue
            kind = got[1] if got[1] in TYPES else _sniff(got[2])
            if kind:
                _save(provider, website, got[2], kind)
                return "ok"
        _save(provider, website, None, "")
        return "missing"
    finally:
        if own:
            await client.aclose()


async def fetch_all(providers: list[str]) -> dict[str, str]:
    """Fetch several providers' icons, six at a time over one client."""
    gate = asyncio.Semaphore(6)
    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=HEADERS) as client:
        async def one(p):
            async with gate:
                return p, await fetch(p, client)
        return dict(await asyncio.gather(*(one(p) for p in providers)))
