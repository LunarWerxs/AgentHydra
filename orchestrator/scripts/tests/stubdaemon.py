"""stubdaemon - an in-process fake AgentHydra for the unit tests.

Each test declares the routes it needs as plain dicts; the stub records every POST it receives so
a test can assert exactly what an act script sent. No real daemon, no real chats, no network
beyond 127.0.0.1.

TWO WAYS IN, ONE ANSWER. hydralib calls whose BASE is this stub's url are answered IN-PROCESS
through `dispatch` (registered in hydralib.INPROC), so a hydralib call opens no socket at all.
The HTTP server on `url` still runs for anything that speaks HTTP itself - a subprocess handed
AGENTHYDRA_URL, a test that uses urllib directly - and it answers through the same `dispatch`.
Why (measured 2026-09-05): one loopback connection per request left a TIME_WAIT socket behind for
two minutes, the 908-test suite burned thousands of Windows' 16,384 ephemeral ports per run, and
beside another socket-heavy suite the pool ran dry - the daemon read as down and a random test
went red with nothing to say why.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from lib import hydralib


class StubDaemon:
    def __init__(self):
        # path (without query) -> response body (dict/list) OR (status, body) tuple.
        # A callable value is invoked with (method, path, query, body) per request - use it
        # to change answers between calls (e.g. archived flips true after the POST).
        self.routes: dict[str, object] = {}
        self.posts: list[tuple[str, dict]] = []  # (path, body) of every POST received
        self.gets: list[tuple[str, str]] = []  # (path, query) of every GET received

        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _serve(self, method: str):
                raw = b""
                if method == "POST":
                    n = int(self.headers.get("content-length") or 0)
                    raw = self.rfile.read(n) if n else b""
                status, data = stub.dispatch(method, self.path, raw)
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._serve("GET")

            def do_POST(self):
                self._serve("POST")

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        hydralib.INPROC[self.url] = self.dispatch

    def dispatch(self, method: str, path: str, raw: bytes | None = b"") -> tuple[int, bytes]:
        """One request, exactly as the HTTP handler answers it: record the GET or POST, resolve
        the route (404 when unknown), call a callable route, and return (status, body bytes).
        `path` may carry a query string, as hydralib sends it."""
        parsed = urlparse(path)
        body: dict = {}
        if method == "GET":
            self.gets.append((parsed.path, parsed.query))
        if method == "POST":
            raw = raw or b""
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                body = {"_raw": raw.decode(errors="replace")}
            self.posts.append((parsed.path, body))
        route = self.routes.get(parsed.path)
        if route is None:
            return 404, b'{"error":"no such route in stub"}'
        if callable(route):
            route = route(method, parsed.path, parsed.query, body)
        status, payload = route if isinstance(route, tuple) else (200, route)
        # bytes payloads are sent raw - for tests that need a NON-JSON body
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return status, data

    def close(self):
        hydralib.INPROC.pop(self.url, None)
        self._server.shutdown()
        self._server.server_close()


def dossier_query(query_string: str) -> str:
    """The unquoted q= value of a dossier GET's query string - for routes that must answer
    the way the real daemon does: BY the query, never the same thing regardless of it."""
    from urllib.parse import parse_qs

    return (parse_qs(query_string).get("q") or [""])[0]
