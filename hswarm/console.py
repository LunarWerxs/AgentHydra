"""`hswarm ui`: the web console and the HTTP API, served by the shared hswarm server (shared.py) on 127.0.0.1.

GET /ui is the console, one self-contained page (ui/console.html). /api/* is JSON: the same calls the page makes,
so a script or another agent can drive hswarm without MCP. Send the token from <home>/console-token as the
X-Hswarm-Token header (docs/API.md lists every route).

The server can spend money and runs workers with file and shell tools, so two locks stand in front of it:
- the Host header must name this machine. A page on another origin that rebinds its DNS name to 127.0.0.1 still
  sends its own name, and is refused;
- every /api call carries the token. Only a process that can read the owner's home has it, or the page /ui serves.
  By default /ui opens without a login for any request from this machine (sign_in_required). With HSWARM_UI_SIGN_IN=1
  set on the SERVER, `hswarm ui` opens /ui?t=<token> once, which sets an HttpOnly session cookie and redirects to the
  bare /ui; then only a request with that cookie gets a page carrying the token, and /ui without it answers 401.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import traceback
from importlib.resources import files
from pathlib import Path

from . import config, ledger, settings, shared
from .shared import local_host  # the Host check every custom route shares

MAX_BODY = 1_000_000
SIGN_IN_PAGE = ("<!doctype html><meta charset=utf-8><title>hswarm</title>"
                "<link rel=icon href=/ui/icon.svg type=image/svg+xml>"
                "<body style=\"font:15px system-ui,sans-serif;color:#111827;margin:3rem\">"
                "<p>This browser is not signed in to the hswarm console.</p>"
                "<p>Run <code>hswarm ui</code>: it opens a one-time sign-in link.</p>")


def token_path() -> Path:
    return config.HOME / "console-token"


def token() -> str:
    path = token_path()
    try:
        value = path.read_text(encoding="utf-8").strip()
        if len(value) >= 32:
            return value
    except OSError:
        pass
    value = secrets.token_urlsafe(32)
    shared.atomic_write(path, value + "\n", private=True)
    return value


def sign_in_required() -> bool:
    """Off by default (owner, 2026-09-25: "I need to be able to access it without a login"): the page opens straight
    away for anything on this machine. HSWARM_UI_SIGN_IN=1 turns on the one-time sign-in link and its cookie, for a
    machine where other people's processes could reach 127.0.0.1."""
    return (os.environ.get("HSWARM_UI_SIGN_IN") or "").strip().lower() in ("1", "true", "on", "yes")


def ui_status(port: int) -> int | None:
    """What /ui on this port answers: 200 (open), 401 (that server wants the one-time sign-in), 404 (a server started
    before the console existed), None (nothing answering). The SERVER's environment decides sign-in, not the shell's."""
    import urllib.error
    import urllib.request

    try:
        urllib.request.urlopen(url(port), timeout=5).close()
    except urllib.error.HTTPError as e:
        return e.code
    except OSError:
        return None
    return 200


def answers(port: int) -> bool:
    """Is the console on this port?"""
    return ui_status(port) not in (None, 404)


def session() -> str:
    """What the console's HttpOnly cookie holds: derived from the token, so the cookie is not the API token itself."""
    return hmac.new(token().encode(), b"hswarm console session", "sha256").hexdigest()


def _same(given: str, expected: str) -> bool:
    # Bytes: compare_digest on str raises TypeError for a non-ASCII header (Starlette decodes headers as latin-1).
    return hmac.compare_digest(given.encode("utf-8", "surrogateescape"), expected.encode())


def page() -> str:
    return files("hswarm").joinpath("ui", "console.html").read_text(encoding="utf-8")


def _body(raw: bytes) -> dict:
    if not raw:
        return {}
    doc = json.loads(raw)
    if not isinstance(doc, dict):
        raise settings.SettingsError("the request body is a JSON object")
    return doc


def _flag(value) -> bool | None:
    return None if value is None else bool(value)


async def _probe(b: dict) -> dict:
    from . import keys

    return await keys.probe(b.get("provider") or None)


async def _check(b: dict) -> dict:
    from . import keys

    return await keys.check(b.get("provider") or "", b.get("fingerprint") or "")


async def _icons(b: dict) -> dict:
    """Fetch the favicons the page asks for (by default every provider whose icon was never fetched)."""
    from . import favicons

    names = [n for n in (b.get("providers") or [n for n in config.PROVIDERS if favicons.state(n)[0] == "unknown"]) if n in config.PROVIDERS]
    return {"icons": await favicons.fetch_all(names)}


async def _test(b: dict) -> dict:
    """One tiny paid call on exactly this model (routing off for it), so a key and a model can be checked from the page."""
    from .mcp_server import manager

    model = b.get("model") or config.AUTO
    r = await manager().ask_routed("Reply with the single word: ready", config.resolve_model(model), route=False, max_tokens=64)
    return {"model": r.model, "status": r.status, "answer": (r.answer or "")[:200], "error": r.error,
            "seconds": r.seconds, "cost_usd": r.cost_usd}


async def _run(b: dict) -> dict:
    from .mcp_server import hswarm_run

    return await hswarm_run(**{k: v for k, v in b.items() if k in RUN_ARGS})


async def _ask(b: dict) -> dict:
    from .mcp_server import hswarm_ask

    return await hswarm_ask(**{k: v for k, v in b.items() if k in ASK_ARGS})


async def _job(b: dict) -> dict:
    from .mcp_server import hswarm_results, hswarm_status

    job_id = b.get("id") or ""
    return {"status": await hswarm_status(job_id), "results": await hswarm_results(job_id, max_answer_chars=int(b.get("max_answer_chars") or 4000))}


async def _jobs(b: dict) -> dict:
    from .mcp_server import hswarm_jobs

    return {"jobs": await hswarm_jobs(int(b.get("limit") or 20), verbose=True)}  # the jobs page shows `created`


async def _cancel(b: dict) -> dict:
    from .mcp_server import hswarm_cancel

    return await hswarm_cancel(b.get("id") or "")


def _stats(b: dict) -> dict:
    from . import stats

    return stats.stats(max(1, min(90, int(b.get("days") or 30))))


async def _doctor(_b: dict) -> dict:
    from .mcp_server import hswarm_doctor

    return await hswarm_doctor()


async def _select(b: dict) -> dict:
    from .mcp_server import hswarm_select

    return await hswarm_select(profile=b.get("profile") or "general", tools=b.get("tools") or "none", backend=b.get("backend") or "api",
                               verbose=True)  # the page shows each candidate's provider and benchmark cost


def _clients(_b: dict) -> dict:
    from . import install

    return {"clients": install.clients()}


def _install(b: dict) -> dict:
    from . import install

    name = b.get("client") or ""
    if name not in install.CLIENTS:
        raise settings.SettingsError(f"client is one of {', '.join(install.CLIENTS)}")
    lines = install.install_client(name, remove=bool(b.get("remove")), instructions=bool(b.get("instructions")))
    return {"client": name, "log": lines, "clients": install.clients()}


RUN_ARGS = {"tasks", "cwd", "tools", "model", "role", "backend", "system", "max_turns", "schema", "timeout_s", "concurrency",
            "budget_usd", "label", "wait", "wait_s", "thinking", "reasoning_effort", "max_cost_usd", "profile", "max_answer_chars",
            "unbatched"}
ASK_ARGS = {"prompt", "system", "model", "schema", "thinking", "reasoning_effort", "max_tokens", "role", "profile", "exclude_models"}

# (method, path) -> handler(body). Names travel in the body, never the path: a model name may hold a '/' or ':'.
ROUTES = {
    ("GET", "state"): lambda b: settings.snapshot(),
    ("GET", "keys"): lambda b: {"provider": b.get("provider"), "rows": settings.key_rows(b.get("provider") or "")},
    ("POST", "keys/add"): lambda b: settings.add_key(b.get("provider") or "", b.get("key") or ""),
    ("POST", "keys/remove"): lambda b: settings.remove_key(b.get("provider") or "", b.get("fingerprint") or ""),
    ("POST", "keys/priority"): lambda b: settings.set_key_priority(b.get("provider") or "", b.get("fingerprint") or "", b.get("priority")),
    ("POST", "keys/enabled"): lambda b: settings.set_key_enabled(b.get("provider") or "", b.get("fingerprint") or "", bool(b.get("enabled"))),
    ("POST", "keys/probe"): _probe,
    ("POST", "keys/check"): _check,
    ("POST", "favicons/fetch"): _icons,
    ("POST", "providers/set"): lambda b: settings.set_provider(b.get("name") or "", enabled=_flag(b.get("enabled")),
                                                               base_url=b.get("base_url"), website=b.get("website")),
    ("POST", "providers/add"): lambda b: settings.add_provider(b.get("name") or "", b.get("base_url") or "", docs=b.get("docs") or "",
                                                               anthropic_url=b.get("anthropic_url") or "", website=b.get("website") or ""),
    ("POST", "providers/remove"): lambda b: settings.remove_provider(b.get("name") or ""),
    ("POST", "models/enabled"): lambda b: settings.set_model(b.get("name") or "", bool(b.get("enabled"))),
    ("POST", "models/add"): lambda b: settings.add_model(b.get("name") or "", b.get("provider") or "", b.get("api_id") or "",
                                                         ctx=int(b.get("ctx") or 131_072), price=b.get("price"),
                                                         vision=bool(b.get("vision")), tools=b.get("tools") is not False),
    ("POST", "models/remove"): lambda b: settings.remove_model(b.get("name") or ""),
    ("POST", "models/priority"): lambda b: settings.set_model_priority(b.get("name") or "", b.get("priority")),
    ("POST", "roles"): lambda b: settings.set_role(b.get("role") or "", b.get("model")),
    ("POST", "options"): lambda b: settings.set_options(routing=_flag(b.get("routing")), load_bias=b.get("load_bias"),
                                                        daily_cap_usd=b.get("daily_cap_usd")),
    ("POST", "models/test"): _test,
    ("POST", "select"): _select,
    ("GET", "doctor"): _doctor,
    # Off the event loop: the first read of the day chart parses the whole ledger (~1 s on a big one).
    ("GET", "usage"): lambda b: asyncio.to_thread(lambda: {"days": ledger.daily(max(1, min(90, int(b.get("days") or 14))))}),
    ("GET", "stats"): lambda b: asyncio.to_thread(lambda: _stats(b)),
    ("POST", "ask"): _ask,
    ("POST", "run"): _run,
    ("GET", "jobs"): _jobs,
    ("GET", "job"): _job,
    ("POST", "job/cancel"): _cancel,
    ("GET", "clients"): _clients,
    ("POST", "clients/install"): _install,
}


async def handle(method: str, path: str, body: dict) -> tuple[int, dict]:
    """Route one API call. A SettingsError or ValueError is the caller's mistake (400, its message); anything else
    is ours (500, the type, the message and the frame that raised it)."""
    fn = ROUTES.get((method, path.strip("/")))
    if fn is None:
        return 404, {"error": f"no route {method} /api/{path}", "routes": sorted(f"{m} /api/{p}" for m, p in ROUTES)}
    try:
        # A provider file or settings.toml edited by hand shows up on the next call, as the docs promise. The
        # handlers run on the loop on purpose: a reload in a thread would race the jobs reading the registry.
        config.refresh()
        out = fn(body)
        if hasattr(out, "__await__"):
            out = await out
        return 200, out
    except (settings.SettingsError, ValueError) as e:
        return 400, {"error": str(e).strip("'\"")}
    except Exception as e:  # noqa: BLE001 - a console must show why, never a bare 500
        frame = traceback.extract_tb(e.__traceback__)[-1]
        return 500, {"error": f"{type(e).__name__}: {e}"[:600], "where": f"{Path(frame.filename).name}:{frame.lineno}"}


HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}


def _csp(nonce: str) -> str:
    return (f"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-{nonce}'; base-uri 'none'; "
            "form-action 'none'; frame-ancestors 'none'")


async def _read_body(request) -> bytes | None:
    """The body, or None past MAX_BODY: refused on its declared length, else while it streams in, never buffered whole."""
    try:
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            return None
    except ValueError:
        pass  # a garbled length: the stream below still stops at MAX_BODY
    raw = bytearray()
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY:
            return None
    return bytes(raw)


class _Routes:
    """The console's four routes for one port. Every one refuses a Host that is not this machine first."""

    def __init__(self, port: int):
        self.port = port
        self.cookie = f"hswarm_session_{port}"  # cookies ignore the port: a console on another port keeps its own

    def refused(self, request):
        from starlette.responses import JSONResponse

        if local_host(request.headers.get("host", ""), self.port):
            return None
        return JSONResponse({"error": "the console answers only on 127.0.0.1 / localhost"}, status_code=403, headers=HEADERS)

    async def root(self, request):
        from starlette.responses import RedirectResponse

        return self.refused(request) or RedirectResponse("/ui")

    async def core(self, request):
        # Holds no token (a <script src> can be loaded cross-origin); the page's meta tag carries it.
        from starlette.responses import Response

        return self.refused(request) or Response(files("hswarm").joinpath("ui", "core.js").read_text(encoding="utf-8"),
                                                 media_type="text/javascript", headers=HEADERS)

    async def icon(self, request):
        # The console's own tab icon (ui/icon.svg: charcoal, white in a dark theme). A browser fetches it with no
        # token, before any sign-in; the same policy as a provider icon keeps the SVG from running script.
        from starlette.responses import Response

        return self.refused(request) or Response(files("hswarm").joinpath("ui", "icon.svg").read_bytes(),
                                                 media_type="image/svg+xml", headers={
                                                     **HEADERS, "Cache-Control": "max-age=86400",
                                                     "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})

    async def favicon(self, request):
        # An <img> cannot send the token header; an icon is public anyway. The policy header keeps an SVG icon from
        # running script if someone opens it as a page.
        from starlette.responses import Response

        from . import favicons

        if (bad := self.refused(request)) is not None:
            return bad
        name = request.path_params.get("name", "")
        got = favicons.image(name) if settings.NAME_RX.match(name) else None
        if got is None:
            return Response(status_code=404, headers=HEADERS)
        return Response(got[0], media_type=got[1], headers={**HEADERS, "Cache-Control": "max-age=86400",
                                                            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})

    async def ui(self, request):
        from starlette.responses import HTMLResponse

        if (bad := self.refused(request)) is not None:
            return bad
        if sign_in_required() and (gate := self.signed_in(request)) is not None:
            return gate
        nonce = secrets.token_urlsafe(16)
        html = page().replace("<head>", f'<head><meta name="hswarm-token" content="{token()}">', 1)
        html = html.replace("<script>", f'<script nonce="{nonce}">')
        return HTMLResponse(html, headers={**HEADERS, "X-Frame-Options": "DENY", "Content-Security-Policy": _csp(nonce)})

    def signed_in(self, request):
        """None when this browser holds the session cookie; else the sign-in page, or the redirect that sets it."""
        from starlette.responses import HTMLResponse, RedirectResponse

        signed_out = HTMLResponse(SIGN_IN_PAGE, status_code=401, headers=HEADERS)
        given = request.query_params.get("t")
        if given is not None:  # the one-time link `hswarm ui` opens: trade it for the cookie, drop it from the address bar
            if not _same(given, token()):
                return signed_out
            back = RedirectResponse("/ui", status_code=303, headers=HEADERS)
            back.set_cookie(self.cookie, session(), path="/ui", httponly=True, samesite="strict")
            return back
        return None if _same(request.cookies.get(self.cookie, ""), session()) else signed_out

    async def api(self, request):
        from starlette.responses import JSONResponse

        def error(message: str, status: int):
            return JSONResponse({"error": message}, status_code=status, headers=HEADERS)

        if (bad := self.refused(request)) is not None:
            return bad
        if not _same(request.headers.get("x-hswarm-token", ""), token()):
            return error(f"missing or wrong X-Hswarm-Token (it is in {token_path()})", 401)
        if request.method != "GET" and request.url.query:  # a URL lands in logs; a key or a prompt must not
            return error("a POST takes its arguments in a JSON body, never the URL", 400)
        raw = await _read_body(request)
        if raw is None:
            return error("request body over 1 MB", 413)
        try:
            body = (dict(request.query_params) if request.method == "GET" else {}) | _body(raw)
        except (ValueError, RecursionError, settings.SettingsError) as e:
            return error(f"bad JSON body: {e}", 400)
        status, out = await handle(request.method, request.path_params.get("path", ""), body)
        return JSONResponse(out, status_code=status, headers=HEADERS)


def mount(mcp, port: int) -> None:
    """Register /, /ui, /ui/core.js, /ui/icon.svg and /api/* on the shared server's Starlette app (MCPServer.custom_route)."""
    r = _Routes(port)
    for path, methods, handler in (("/", ["GET"], r.root), ("/ui/core.js", ["GET"], r.core), ("/ui", ["GET"], r.ui),
                                   ("/ui/icon.svg", ["GET"], r.icon), ("/ui/favicon/{name}", ["GET"], r.favicon),
                                   ("/api/{path:path}", ["GET", "POST"], r.api)):
        mcp.custom_route(path, methods=methods, include_in_schema=False)(handler)


def url(port: int) -> str:
    return f"http://127.0.0.1:{port}/ui"


def sign_in_url(port: int) -> str:
    """The one-time link that signs a browser in to the console (it carries the token: open it, never log it)."""
    return f"{url(port)}?t={token()}"


def open_console(port: int | None = None, no_open: bool = False) -> int:
    """`hswarm ui` and the end of `hswarm setup`: start the shared server if it is not up, then open the console in a
    browser, or print its address when there is none (a headless machine) or no_open asks. Returns an exit code."""
    import json
    import webbrowser

    from . import shared

    home = port or shared.PORT
    out = shared.ensure(home)
    port = home
    if out["ok"] and not answers(home):
        # A server started before the console existed. Its jobs belong to live chats, so it is left running and
        # the console gets a server of its own on the next free port until that one is restarted.
        for port in range(home + 1, home + 21):
            out = shared.ensure(port)
            if out["ok"] and answers(port):
                break
        print(f"The hswarm server on port {home} predates the console, so the console runs on {port} for now. "
              f"Restart {home} when no job is running and `hswarm ui` goes back to it.")
    if not out["ok"]:
        print(json.dumps(out))
        return 1
    # Asked of the running server: a shell's HSWARM_UI_SIGN_IN says nothing about the environment it started with.
    gated = ui_status(port) == 401
    print(f"hswarm console: {url(port)}  (API token: {token_path()})")
    if no_open or not webbrowser.open(sign_in_url(port) if gated else url(port)):
        if gated:
            print(f"sign in once at {url(port)}?t=<the token in {token_path()}>")
    return 0

