"""The `read_url` worker tool: a GET-only web read, gated per host and routed by host to ordered backends; and
`web_search`, which finds pages for it (see the web_search section: the one call here that goes to a third party).

Two halves, one tool:

- The host gate. A worker may only fetch a host the batch listed in `web_hosts` (or one the owner approved
  for good in ~/.hswarm/web.json). An unknown host is NOT fetched: the call comes back as an approval
  request (request_id, host, url, severity) that rides out on the task's Result and the job summary, so the
  orchestrator decides - allow once by re-running with the host in `web_hosts`, allow always with
  `hswarm web --allow HOST` / hswarm_web(allow=[...]). The admin block list wins over every allow, and a
  private or loopback address is refused unless it is listed by its exact name (a `*` never reaches it):
  numeric forms (127.1, 2130706433, 0x7f000001) are read as the address they are, and a name is resolved
  before each request, so a public name that points at this machine or its LAN is refused too. (A name
  whose DNS answer changes between that check and the connect is not caught.)
  Every redirect hop is gated again, so an allowed page cannot bounce the worker to an unknown host.
- The router. Each Channel claims URLs by host and lists backends in order of preference (subtitles via
  yt-dlp for YouTube, the raw file for a GitHub blob, a plain fetch rendered to markdown for anything).
  The first backend whose status is `ok` runs ahead of any `warn`; a backend that was just blocked,
  rate-limited or unreachable (403, 429, 5xx, a transport error) drops to `warn` for a while, so the next
  read goes straight to the one that works. A backend that simply does not fit one URL (an issue page for
  github-raw, a video without subtitles, a 404) falls through without being demoted.
  HSWARM_WEB_<CHANNEL>=a,b promotes backends by hand without a code change.

Nothing in read_url calls a third-party reader service: every request goes to the host the worker asked for (or,
for a GitHub blob, GitHub's own raw-file host).
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import tempfile
import time
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx

from . import config

MAX_BYTES = 2_000_000
MAX_REDIRECTS = 5
FETCH_TIMEOUT_S = 30.0
YTDLP_TIMEOUT_S = 120
DEMOTE_S = 600  # how long a backend that just failed sits behind the others
USER_AGENT = "hswarm-read_url/1 (GET only)"
SEARCH_DEFAULT, SEARCH_MAX = 5, 8  # results; a worker that wants more searches again with a sharper query
SNIPPET_CHARS = 300
QUERY_CHARS = 400


def policy_file() -> Path:
    """Read through config.HOME at call time, so a redirected home (tests, HSWARM_HOME) is honoured."""
    return config.HOME / "web.json"


# ---- the host gate -----------------------------------------------------------------------------------


def _norm_host(host: str) -> str:
    host = (host or "").strip().lower()
    if "/" in host:
        # WHY: a pattern pasted as a URL ('https://docs.python.org/3/') never matched the host it names, so the gate
        # suspended every read of it; the scheme and path are dropped, for web_hosts and web.json alike.
        try:
            host = urlsplit(host if "://" in host else "//" + host).hostname or ""
        except ValueError:
            host = ""
    return host.rstrip(".").removeprefix("*.")


def host_matches(host: str, pattern: str) -> bool:
    """`example.com` (or `*.example.com`) covers the host and every subdomain; `*` covers any public host."""
    pattern = (pattern or "").strip().lower()
    if pattern == "*":
        return True
    p = _norm_host(pattern)
    return bool(p) and (host == p or host.endswith("." + p))


_NUMERIC_PART = re.compile(r"^(0x[0-9a-f]+|[0-9]+)$")


def _numeric_ipv4(host: str) -> ipaddress.IPv4Address | None:
    """The inet_aton forms a resolver accepts as an address (127.1, 2130706433, 0x7f000001, 0177.0.0.1).

    WHY: ip_address() only parses dotted quads, so without this `http://2130706433/` would pass the gate as
    a name while the socket layer connects to 127.0.0.1."""
    parts = host.lower().split(".")
    if not 1 <= len(parts) <= 4 or not all(_NUMERIC_PART.match(p) for p in parts):
        return None
    try:
        nums = [int(p, 16) if p.startswith("0x") else int(p, 8) if len(p) > 1 and p.startswith("0") else int(p) for p in parts]
    except ValueError:  # an octal-looking part with an 8 or 9 in it: not an address
        return None
    *head, last = nums
    if any(n > 255 for n in head) or last >= 256 ** (4 - len(head)):
        return None
    value = 0
    for n in head:
        value = value << 8 | n
    return ipaddress.IPv4Address(value << 8 * (4 - len(head)) | last)


def _ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """The address a host literal names, whatever form it is written in; None for a name."""
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return _numeric_ipv4(host)
    return ip.ipv4_mapped or ip if ip.version == 6 else ip


def is_private(host: str) -> bool:
    """Loopback, private, link-local and reserved addresses, plus the names that mean this machine or its LAN."""
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return True
    ip = _ip(host)
    if ip is None:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


async def resolve_host(host: str) -> list[str]:
    """Every address a name resolves to; empty when it does not resolve (the fetch then fails on its own)."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        return []
    return [str(info[4][0]) for info in infos]


def _listed_exactly(host: str, listed: list[str]) -> bool:
    return any(_norm_host(a) == host for a in listed if a.strip() != "*")


def load_policy() -> dict:
    """The owner's standing policy: {allow: [...], block: [...]} from web.json, plus HSWARM_WEB_BLOCK (comma list)."""
    try:
        raw = json.loads(policy_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    allow = [str(h) for h in raw.get("allow") or []]
    block = [str(h) for h in raw.get("block") or []] + [h.strip() for h in os.environ.get("HSWARM_WEB_BLOCK", "").split(",") if h.strip()]
    return {"allow": allow, "block": block}


def save_policy(allow: list[str] | None = None, block: list[str] | None = None, forget: list[str] | None = None) -> dict:
    """Add hosts to the standing allow or block list, or forget them from both. Written whole, then swapped in."""
    path = policy_file()
    try:
        cur = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cur = {}
    gone = {_norm_host(h) for h in forget or []}
    lists = {k: [h for h in cur.get(k) or [] if _norm_host(h) not in gone] for k in ("allow", "block")}
    for key, extra in (("allow", allow), ("block", block)):
        for h in extra or []:
            if h.strip() and h.strip().lower() not in (x.lower() for x in lists[key]):
                lists[key].append(h.strip().lower())
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(lists, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return lists


@dataclass
class Verdict:
    action: str  # allow | deny | suspend
    host: str
    reason: str = ""
    request: dict | None = None  # set on suspend: what the orchestrator is asked to approve


def gate(url: str, allowed: list[str], policy: dict | None = None) -> Verdict:
    """Allow, deny or suspend one URL for a batch whose allowlist is `allowed`."""
    parts = urlsplit(url or "")
    host = _norm_host(parts.hostname or "")
    if parts.scheme not in ("http", "https") or not host:
        return Verdict("deny", host, f"only http(s) URLs with a host can be read, not {url!r}")
    policy = policy if policy is not None else load_policy()
    if any(host_matches(host, b) for b in policy["block"]):
        return Verdict("deny", host, f"{host} is on the admin block list")
    listed = allowed + policy["allow"]
    if is_private(host):
        # A `*` must never open this machine or its LAN to a worker: only the exact name does.
        if _listed_exactly(host, listed):
            return Verdict("allow", host)
        return Verdict("deny", host, f"{host} is a private or loopback address; list it by its exact name in web_hosts to allow it")
    if any(host_matches(host, a) for a in listed):
        return Verdict("allow", host)
    severity = "high" if parts.scheme == "http" or _ip(host) is not None else "medium"
    request = {"request_id": "web-" + hashlib.sha1(host.encode()).hexdigest()[:10], "kind": "domain_access", "host": host, "url": url, "severity": severity}
    return Verdict("suspend", host, f"{host} is not in this batch's web_hosts", request)


def collect_approvals(results) -> list[dict]:
    """Every host a batch's workers asked for and were not given, once per host, for the job summary."""
    seen: dict[str, dict] = {}
    for r in results:
        for req in getattr(r, "web_approvals", None) or []:
            entry = seen.setdefault(req["host"], {**req, "tasks": []})
            if r.id not in entry["tasks"]:
                entry["tasks"].append(r.id)
    return list(seen.values())


def no_hosts_note(tasks) -> list[str]:
    """What a batch's first response says when read_url tasks carry no web_hosts and nothing is allowed for good:
    every read then comes back APPROVAL NEEDED and the worker answers from memory. A note, not a refusal: approving
    a host afterwards is how the gate is meant to be used. Measured 2026-10-02: 5 of 14 web tasks had no web_hosts."""
    from .toolspecs import tool_names

    n = sum(1 for t in tasks if not getattr(t, "web_hosts", None) and "read_url" in tool_names(getattr(t, "tools", None) or "none"))
    if not n or load_policy()["allow"]:
        return []
    return [f"web: {n} task(s) hold read_url with no web_hosts and no host is allowed for good, so every read comes back "
            "APPROVAL NEEDED and the worker answers from memory; list the hosts in web_hosts, or `hswarm web --allow HOST`"]


# ---- rendering ---------------------------------------------------------------------------------------


class _Markdown(HTMLParser):
    """HTML to a markdown-ish text: headings, paragraphs, list items, links and code blocks kept; chrome dropped."""

    SKIP = {"script", "style", "noscript", "svg", "template", "nav", "footer", "iframe", "form", "button", "select"}
    BLOCK = {"p", "div", "section", "article", "main", "header", "aside", "table", "tr", "ul", "ol", "blockquote", "figure", "dl", "dt", "dd"}
    HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base, self.out, self.links = base, [], []
        self.skip = self.pre = 0
        self.title, self.in_title = "", False

    def _nl(self, n: int) -> None:
        tail = "".join(self.out[-3:])
        have = len(tail) - len(tail.rstrip("\n"))
        if self.out and have < n:
            self.out.append("\n" * (n - have))

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif self.skip:
            return
        elif tag == "title":
            self.in_title = True
        elif tag in self.HEADINGS:
            self._nl(2)
            self.out.append("#" * int(tag[1]) + " ")
        elif tag == "li":
            self._nl(1)
            self.out.append("- ")
        elif tag == "br":
            self.out.append("\n")
        elif tag == "pre":
            self._nl(2)
            self.out.append("```\n")
            self.pre += 1
        elif tag == "a":
            self.links.append((dict(attrs).get("href") or "", len(self.out)))
        elif tag in ("td", "th"):
            self.out.append(" | ")
        elif tag in self.BLOCK:
            self._nl(2)

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif self.skip:
            return
        elif tag == "title":
            self.in_title = False
        elif tag == "a" and self.links:
            href, start = self.links.pop()
            text = "".join(self.out[start:]).strip()
            if href and text and not href.startswith(("#", "javascript:")):
                del self.out[start:]
                self.out.append(f"[{text}]({urljoin(self.base, href)})")
        elif tag == "pre":
            self.out.append("\n```")
            self._nl(2)
            self.pre = max(0, self.pre - 1)
        elif tag in self.HEADINGS or tag in self.BLOCK:
            self._nl(2)
        elif tag == "li":
            self._nl(1)

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skip:
            self.out.append(data if self.pre else re.sub(r"\s+", " ", data))

    def text(self) -> str:
        # Strip every line except inside ``` fences, where indentation is the content.
        parts = "".join(self.out).split("```")
        for i in range(0, len(parts), 2):
            parts[i] = re.sub(r"\n{3,}", "\n\n", "\n".join(line.strip() for line in parts[i].split("\n")))
        body = "```".join(parts).strip()
        title = self.title.strip()
        return f"# {title}\n\n{body}" if title and not body.startswith("# ") else body


def html_to_markdown(html: str, base: str = "") -> str:
    p = _Markdown(base)
    p.feed(html)
    p.close()
    return p.text()


def feed_to_text(xml: str) -> str | None:
    """An RSS or Atom feed as one line per entry (date, title, link); None when it is not a feed."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    lines = []
    for item in root.iter():
        name = item.tag.rsplit("}", 1)[-1]
        if name not in ("item", "entry"):
            continue
        fields = {c.tag.rsplit("}", 1)[-1]: c for c in item}
        link = fields.get("link")
        href = (link.get("href") or link.text or "").strip() if link is not None else ""
        when = next(((fields[k].text or "").strip() for k in ("pubDate", "published", "updated", "date") if k in fields), "")
        title = (fields["title"].text or "").strip() if "title" in fields else ""
        lines.append(" - ".join(x for x in (when, title, href) if x))
    return "\n".join(lines) if lines else None


def vtt_to_text(vtt: str) -> str:
    """WebVTT subtitles as plain text: cue timings, numbers and inline tags dropped, rolled-over repeats merged."""
    out: list[str] = []
    for line in vtt.splitlines():
        line = re.sub(r"<[^>]+>", "", line).strip()
        if not line or line == "WEBVTT" or "-->" in line or line.isdigit() or line.startswith(("Kind:", "Language:", "NOTE")):
            continue
        if not out or out[-1] != line:
            out.append(line)
    return "\n".join(out)


# ---- backends ----------------------------------------------------------------------------------------


class BackendFailed(RuntimeError):
    """This backend could not serve this URL; the next one in the channel's order is tried.

    `demote` is True only when the backend itself looks blocked or down (403, 429, 5xx, a transport error),
    so one missing page or one video without subtitles does not push it behind the others for everyone."""

    def __init__(self, message: str, demote: bool = True):
        super().__init__(message)
        self.demote = demote


class Skip(RuntimeError):
    """This backend does not apply to this URL (an issue page for github-raw): fall through, demote nothing."""


def _worth_demoting(status: int) -> bool:
    return status in (403, 429) or status >= 500


class Suspended(RuntimeError):
    """A redirect led to a host the gate would not allow; the read stops and the verdict goes back to the worker."""

    def __init__(self, verdict: Verdict):
        super().__init__(verdict.reason)
        self.verdict = verdict


@dataclass
class Channel:
    name: str
    hosts: tuple[str, ...]  # hosts it claims; empty = the catch-all
    backends: tuple[str, ...]

    def can_handle(self, host: str) -> bool:
        return not self.hosts or any(host_matches(host, h) for h in self.hosts)


CHANNELS = (
    Channel("youtube", ("youtube.com", "youtu.be"), ("yt-dlp", "direct")),
    Channel("github", ("github.com",), ("github-raw", "direct")),
    Channel("web", (), ("direct",)),
)

_demoted: dict[tuple[str, str], float] = {}


def channel_for(host: str) -> Channel:
    return next(c for c in CHANNELS if c.can_handle(host))


def backend_status(channel: str, backend: str) -> tuple[str, str]:
    """(ok | warn | missing, why). `warn` = it failed moments ago; `missing` = it cannot run on this machine."""
    if backend == "yt-dlp" and not shutil.which("yt-dlp"):
        return "missing", "yt-dlp is not on PATH"
    until = _demoted.get((channel, backend), 0.0)
    if until > time.time():
        return "warn", f"failed within the last {DEMOTE_S // 60} min"
    return "ok", ""


def order(channel: Channel) -> list[tuple[str, str, str]]:
    """The backends to try, best first: a hand-set promotion (HSWARM_WEB_<CHANNEL>), then every `ok` ahead of any `warn`."""
    promoted = [b.strip() for b in os.environ.get(f"HSWARM_WEB_{channel.name.upper()}", "").split(",") if b.strip() in channel.backends]
    names = list(dict.fromkeys(promoted + list(channel.backends)))
    rows = [(b, *backend_status(channel.name, b)) for b in names]
    return [r for r in rows if r[1] == "ok"] + [r for r in rows if r[1] == "warn"]


def demote(channel: str, backend: str) -> None:
    _demoted[(channel, backend)] = time.time() + DEMOTE_S


class PinnedBackend(httpcore.AsyncNetworkBackend):
    """Connects a host only to the addresses guard() checked for it. DNS can answer differently between the check
    and the connect (rebinding), so the socket target is the pinned address while the URL, Host header, TLS SNI and
    certificate verification stay on the name. A host with no pin is refused. Idea from CopilotKit/OpenBot
    agent-computer/src/egress.ts (MIT), 2026-10-03."""

    def __init__(self, inner: httpcore.AsyncNetworkBackend | None = None) -> None:
        self.inner = inner or httpcore.AnyIOBackend()
        self.pins: dict[str, list[str]] = {}

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        addrs = self.pins.get(host)
        if not addrs:
            raise httpcore.ConnectError(f"{host} was not checked by guard(), so it is not connected")
        error: Exception | None = None
        for addr in addrs:  # the checked addresses in order, as a lookup would have offered them
            try:
                return await self.inner.connect_tcp(addr, port, timeout=timeout, local_address=local_address,
                                                    socket_options=socket_options)
            except httpcore.ConnectError as e:
                error = e
        raise error  # type: ignore[misc]

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise httpcore.ConnectError("unix sockets are not fetched")

    async def sleep(self, seconds: float) -> None:
        await self.inner.sleep(seconds)


class _PinnedTransport(httpx.AsyncHTTPTransport):
    """httpx's own transport with its connection pool built on a PinnedBackend. httpx exposes no constructor
    argument for a network backend, so the pool is replaced right after construction (nothing is open yet)."""

    def __init__(self, backend: PinnedBackend) -> None:
        super().__init__()
        self._pool = httpcore.AsyncConnectionPool(ssl_context=httpx.create_ssl_context(), network_backend=backend)


@dataclass
class WebSession:
    """One worker's web access: its batch allowlist, the approvals it asked for, and the HTTP transport (tests swap it)."""

    allowed: list[str] = field(default_factory=list)
    approvals: list[dict] = field(default_factory=list)
    transport: httpx.AsyncBaseTransport | None = None
    resolve: Callable[[str], Awaitable[list[str]]] = resolve_host
    network_backend: httpcore.AsyncNetworkBackend | None = None  # the socket layer under the pin (tests swap it)

    def note(self, verdict: Verdict) -> None:
        if verdict.request and all(a["host"] != verdict.host for a in self.approvals):
            self.approvals.append(verdict.request)

    async def read(self, url: str) -> str:
        verdict = gate(url, self.allowed)
        if verdict.action == "deny":
            return f"ERROR: read_url refused: {verdict.reason}"
        if verdict.action == "suspend":
            return self._suspended(verdict)
        channel = channel_for(verdict.host)
        failures = []
        for backend, _status, _why in order(channel):
            try:
                body, final = await _BACKENDS[backend](self, url)
            except Suspended as s:
                return self._suspended(s.verdict) if s.verdict.action == "suspend" else f"ERROR: read_url refused: {s.verdict.reason}"
            except Skip as e:
                failures.append(f"{backend}: {e}")
                continue
            except BackendFailed as e:
                if e.demote:
                    demote(channel.name, backend)
                failures.append(f"{backend}: {e}")
                continue
            except (httpx.InvalidURL, httpx.StreamError, ValueError, UnicodeError, OSError) as e:
                # A malformed URL or Location (a bad IDNA host under `*`) is this URL's fault, not the backend's,
                # and it must come back as an ERROR string, never escape and fail the whole task.
                failures.append(f"{backend}: {type(e).__name__}: {e}")
                continue
            return f"[read_url {channel.name}/{backend}] {final}\n\n{body}"
        return "ERROR: read_url could not read it - " + ("; ".join(failures) or f"no backend of {channel.name} can run here")

    async def search(self, query: str, max_results: int = SEARCH_DEFAULT) -> str:
        return await _search(self, query, max_results)

    def _suspended(self, verdict: Verdict) -> str:
        self.note(verdict)
        return (f"APPROVAL NEEDED ({verdict.request['request_id']}): {verdict.reason}, so it was not fetched. The orchestrator "
                "sees this request; carry on without that page, and say in your answer which host you needed and why.")

    async def guard(self, url: str) -> list[str]:
        """Gate one request URL, then resolve its name: a public name pointing at this machine or its LAN is
        refused like the address itself, unless the host is listed by its exact name. Returns the addresses it
        checked, which get() connects to (empty for a literal address or a local name)."""
        verdict = gate(url, self.allowed)
        if verdict.action != "allow":
            raise Suspended(verdict)
        host = verdict.host
        if is_private(host) or _ip(host) is not None:
            return []  # a literal address or a local name: gate() already judged it
        addrs = await self.resolve(host)
        bad = next((a for a in addrs if is_private(a)), None)
        if bad and not _listed_exactly(host, self.allowed + load_policy()["allow"]):
            raise Suspended(Verdict("deny", host, f"{host} resolves to the private or loopback address {bad}; "
                                                  "list it by its exact name in web_hosts to allow it"))
        return addrs

    async def get(self, url: str) -> tuple[httpx.Response, bytes, str]:
        """GET with every hop, the first included, gated and resolved. Returns (response, body capped at MAX_BYTES, final URL)."""
        # On the real network every hop connects to the address guard() checked, never to a second lookup.
        backend = None if self.transport else PinnedBackend(self.network_backend)
        transport = self.transport or _PinnedTransport(backend)
        async with httpx.AsyncClient(transport=transport, follow_redirects=False, timeout=FETCH_TIMEOUT_S,
                                     headers={"User-Agent": USER_AGENT}) as http:
            for _ in range(MAX_REDIRECTS + 1):
                addrs = await self.guard(url)
                if backend:
                    host = urlsplit(url).hostname or ""
                    backend.pins = {host: addrs or [host]}  # no addresses: a literal IP or local name, as gate() judged it
                async with http.stream("GET", url) as r:
                    if httpx.codes.is_redirect(r.status_code):  # not r.is_redirect: that is False when Location is missing
                        if not r.headers.get("location"):
                            raise BackendFailed(f"HTTP {r.status_code} redirect without a Location", demote=False)
                        url = urljoin(url, r.headers["location"])
                        continue
                    chunks, size = [], 0
                    async for chunk in r.aiter_bytes():
                        chunks.append(chunk)
                        size += len(chunk)
                        if size >= MAX_BYTES:
                            break
                    return r, b"".join(chunks)[:MAX_BYTES], url
        raise BackendFailed(f"more than {MAX_REDIRECTS} redirects", demote=False)


async def _direct(session: WebSession, url: str) -> tuple[str, str]:
    """A plain GET, rendered by content type: HTML to markdown, a feed to one line per entry, text as is."""
    try:
        r, raw, final = await session.get(url)
    except httpx.HTTPError as e:
        raise BackendFailed(f"{type(e).__name__}: {e}") from e
    if r.status_code >= 400:
        raise BackendFailed(f"HTTP {r.status_code}", demote=_worth_demoting(r.status_code))
    ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
    try:
        text = raw.decode(r.charset_encoding or "utf-8", errors="replace")
    except LookupError:  # a charset name Python does not know
        text = raw.decode("utf-8", errors="replace")
    if "html" in ctype or (not ctype and text.lstrip()[:15].lower().startswith(("<!doctype html", "<html"))):
        return html_to_markdown(text, final), final
    if "xml" in ctype or "rss" in ctype or "atom" in ctype:
        return feed_to_text(text) or text, final
    if ctype.startswith("text/") or "json" in ctype or not ctype:
        return text, final
    raise BackendFailed(f"{ctype} is not text; read_url returns text only", demote=False)


_BLOB = re.compile(r"^/([^/]+)/([^/]+)/blob/(.+)$")
_REPO = re.compile(r"^/([^/]+)/([^/]+?)/?$")


async def _github_raw(session: WebSession, url: str) -> tuple[str, str]:
    """A GitHub file or repo page as the raw file (the README for a repo root), not the page's chrome."""
    path = urlsplit(url).path
    if m := _BLOB.match(path):
        raw = f"https://raw.githubusercontent.com/{m[1]}/{m[2]}/{m[3]}"
    elif m := _REPO.match(path):
        raw = f"https://raw.githubusercontent.com/{m[1]}/{m[2]}/HEAD/README.md"
    else:
        raise Skip("not a file or repo URL")
    # GitHub's own raw-file host serves what the approved github.com URL named; it is not a new destination.
    # The admin block list still beats that: a blocked raw host falls through to the plain fetch.
    probe = WebSession([*session.allowed, "raw.githubusercontent.com"], session.approvals, session.transport, session.resolve, session.network_backend)
    if (verdict := gate(raw, probe.allowed)).action != "allow":
        raise Skip(verdict.reason)
    try:
        r, body, final = await probe.get(raw)
    except httpx.HTTPError as e:
        raise BackendFailed(f"{type(e).__name__}: {e}") from e
    if r.status_code >= 400:
        raise BackendFailed(f"HTTP {r.status_code} for {raw}", demote=_worth_demoting(r.status_code))
    return body.decode("utf-8", errors="replace"), final


async def _ytdlp(session: WebSession, url: str) -> tuple[str, str]:
    """A video's subtitles (manual first, else automatic, English) as plain text, via yt-dlp."""
    from .procs import run_hidden

    exe = shutil.which("yt-dlp")
    if not exe:
        raise Skip("yt-dlp is not on PATH")
    with tempfile.TemporaryDirectory(prefix="hswarm-subs-") as tmp:
        cmd = [exe, "--skip-download", "--no-playlist", "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en",
               "--sub-format", "vtt", "-o", str(Path(tmp) / "%(id)s.%(ext)s"), "--", url]
        code, _out, err = await run_hidden(cmd, tmp, YTDLP_TIMEOUT_S)
        subs = sorted(Path(tmp).glob("*.vtt"))
        if not subs:
            # Demote only when YouTube is refusing yt-dlp itself; one video without subtitles says nothing about the next.
            blocked = bool(re.search(r"HTTP Error (403|429|5\d\d)|not a bot|rate.?limit", err, re.I))
            raise BackendFailed(f"no subtitles (yt-dlp exit {code}: {err.strip()[-200:]})", demote=blocked)
        return vtt_to_text(subs[0].read_text(encoding="utf-8", errors="replace")), url


_BACKENDS = {"direct": _direct, "github-raw": _github_raw, "yt-dlp": _ytdlp}


# ---- web_search ---------------------------------------------------------------------------------------- slop-ok(banner: matches this module's section banners)
# The one third-party call in this module: the query goes to a search provider on the owner's own keys (Tavily
# first, Jina when Tavily is down or keyless), through ServiceClient, so key rotation, [limits] and the egress
# receipt are the ones `hswarm service` uses. The web policy still decides everything else: a provider whose host
# is on the admin block list is not asked, a result on a blocked or private host is dropped, and a result on a
# host outside web_hosts is marked, because read_url will answer it with APPROVAL NEEDED.

SEARCH = Channel("search", (), ("tavily", "jina"))


def _search_host(provider: str) -> str:
    from .service import _base_url

    spec = config.PROVIDERS[provider]
    return urlsplit(_base_url(spec, spec["operations"]["search"])).hostname or ""


def _search_status(backend: str) -> tuple[str, str]:
    if not config.load_api_keys(backend):
        return "missing", f"no {backend} key"
    return backend_status(SEARCH.name, backend)


async def _service_search(session: WebSession, provider: str, payload: dict) -> dict:
    from .client import NoUsableKey
    from .service import ServiceClient
    from .usage import ApiError

    host = _search_host(provider)
    if any(host_matches(host, b) for b in load_policy()["block"]):
        raise Skip(f"{host} is on the admin block list")
    try:
        async with ServiceClient(provider, timeout_s=FETCH_TIMEOUT_S, transport=session.transport) as client:
            data = await client.call("search", payload)
    except ApiError as e:
        raise BackendFailed(f"HTTP {e.status}", demote=_worth_demoting(e.status) or e.status in (401, 402)) from e
    except (NoUsableKey, httpx.HTTPError) as e:
        raise BackendFailed(f"{type(e).__name__}: {e}") from e
    if not isinstance(data, dict):
        raise BackendFailed("the reply was not a JSON object", demote=False)
    return data


async def _tavily(session: WebSession, query: str, n: int) -> list[dict]:
    data = await _service_search(session, "tavily", {"query": query, "max_results": n, "search_depth": "basic"})
    return [{"title": r.get("title"), "url": r.get("url"), "snippet": r.get("content")} for r in data.get("results") or []]


async def _jina(session: WebSession, query: str, n: int) -> list[dict]:
    data = await _service_search(session, "jina", {"q": query, "num": n})
    return [{"title": r.get("title"), "url": r.get("url"), "snippet": r.get("description") or r.get("content")}
            for r in data.get("data") or []]


_SEARCH_BACKENDS = {"tavily": _tavily, "jina": _jina}


def _search_order() -> list[str]:
    """Like order(): HSWARM_WEB_SEARCH=jina,tavily promotes by hand, then `ok` ahead of `warn`; a keyless backend is skipped."""
    promoted = [b.strip() for b in os.environ.get("HSWARM_WEB_SEARCH", "").split(",") if b.strip() in SEARCH.backends]
    rows = [(b, _search_status(b)[0]) for b in dict.fromkeys(promoted + list(SEARCH.backends))]
    return [b for b, s in rows if s == "ok"] + [b for b, s in rows if s == "warn"]


def _one_line(text, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


async def _search(session: WebSession, query: str, max_results: int = SEARCH_DEFAULT) -> str:
    query = _one_line(query, QUERY_CHARS)
    if not query:
        return "ERROR: web_search needs a query"
    n = max(1, min(int(max_results or SEARCH_DEFAULT), SEARCH_MAX))
    failures = []
    for backend in _search_order():
        try:
            hits = await _SEARCH_BACKENDS[backend](session, query, n)
        except Skip as e:
            failures.append(f"{backend}: {e}")
            continue
        except BackendFailed as e:
            if e.demote:
                demote(SEARCH.name, backend)
            failures.append(f"{backend}: {e}")
            continue
        return _render_hits(session, backend, query, hits[:n])
    return "ERROR: web_search could not search - " + ("; ".join(failures) or "no search provider has a key here")


def _render_hits(session: WebSession, backend: str, query: str, hits: list[dict]) -> str:
    policy = load_policy()
    lines, dropped, outside = [], 0, 0
    for hit in hits:
        url = str(hit.get("url") or "")
        verdict = gate(url, session.allowed, policy)
        if verdict.action == "deny":
            dropped += 1  # a blocked, private or non-http result is not shown at all
            continue
        mark = ""
        if verdict.action == "suspend":
            outside += 1
            mark = "  [outside web_hosts]"
        lines.append(f"{len(lines) + 1}. {_one_line(hit.get('title'), 120) or '(untitled)'}\n   {url}{mark}\n"
                     f"   {_one_line(hit.get('snippet'), SNIPPET_CHARS)}")
    head = f"[web_search {backend}] {query!r}: {len(lines)} result(s)"
    if dropped:
        head += f", {dropped} dropped by the web policy"
    body = "\n".join(lines) or "(no results)"
    if outside:
        body += (f"\n\n{outside} result(s) are on hosts outside this batch's web_hosts: read_url answers them with APPROVAL "
                 "NEEDED, so use the snippet, or name the host you need in your answer.")
    return f"{head}\n{body}"


def report() -> dict:
    """What `hswarm web` and the doctor show: the standing policy, and which backend serves each channel right now."""
    policy = load_policy()
    channels = {}
    for c in CHANNELS:
        rows = [(b, *backend_status(c.name, b)) for b in c.backends]
        picked = order(c)
        channels[c.name] = {"hosts": list(c.hosts) or ["*"], "serves": picked[0][0] if picked else None,
                            "backends": [{"name": b, "status": s, **({"why": w} if w else {})} for b, s, w in rows]}
    rows = [(b, *_search_status(b)) for b in SEARCH.backends]
    channels[SEARCH.name] = {"tool": "web_search", "serves": next(iter(_search_order()), None),
                             "backends": [{"name": b, "status": s, **({"why": w} if w else {})} for b, s, w in rows]}
    return {"policy_file": str(policy_file()), "allow": policy["allow"], "block": policy["block"], "channels": channels}
