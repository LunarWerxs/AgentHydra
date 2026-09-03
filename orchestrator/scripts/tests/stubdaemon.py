"""stubdaemon - an in-process fake AgentHydra for the unit tests.

Each test declares the routes it needs as plain dicts; the stub serves them on an ephemeral
port and records every POST it receives so a test can assert exactly what an act script sent.
No real daemon, no real chats, no network beyond 127.0.0.1.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


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
                parsed = urlparse(self.path)
                body = {}
                if method == "GET":
                    stub.gets.append((parsed.path, parsed.query))
                if method == "POST":
                    n = int(self.headers.get("content-length") or 0)
                    raw = self.rfile.read(n) if n else b""
                    try:
                        body = json.loads(raw) if raw else {}
                    except json.JSONDecodeError:
                        body = {"_raw": raw.decode(errors="replace")}
                    stub.posts.append((parsed.path, body))
                route = stub.routes.get(parsed.path)
                if route is None:
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b'{"error":"no such route in stub"}')
                    return
                if callable(route):
                    route = route(method, parsed.path, parsed.query, body)
                status, payload = route if isinstance(route, tuple) else (200, route)
                # bytes payloads are sent raw - for tests that need a NON-JSON body
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
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

    def close(self):
        self._server.shutdown()
        self._server.server_close()


def dossier_query(query_string: str) -> str:
    """The unquoted q= value of a dossier GET's query string - for routes that must answer
    the way the real daemon does: BY the query, never the same thing regardless of it."""
    from urllib.parse import parse_qs

    return (parse_qs(query_string).get("q") or [""])[0]
