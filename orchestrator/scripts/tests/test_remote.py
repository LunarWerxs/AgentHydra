"""remote.py: the gateway is known by what its /api/health says, never by its port merely
answering. On 2026-09-30 zswarm's MCP server was found holding the gateway's port (7790), and a
bare "something answered" check would have let the tray adopt it as its remote door."""

import io
import json
import os
import sys
import threading
import unittest
import unittest.mock as mock
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import remote  # noqa: E402


class _ForeignServer(BaseHTTPRequestHandler):
    """Another program on the gateway's port: a 200 JSON health answer that is not the gateway's."""

    def do_GET(self):
        body = json.dumps({"ok": True, "service": "zswarm"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class ForeignPortHolderTest(unittest.TestCase):
    def test_start_refuses_a_port_another_program_holds(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _ForeignServer)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        err = io.StringIO()
        # _bun -> None only so a regressed refusal returns 2 instead of launching a real gateway.
        with mock.patch.dict(os.environ, {"ORCH_REMOTE_PORT": str(port)}), \
                mock.patch.object(remote, "_bun", return_value=None), redirect_stderr(err):
            code = remote.start(quiet=True)
        self.assertEqual(code, 4)
        self.assertIn(f"port {port} is held by", err.getvalue())


if __name__ == "__main__":
    unittest.main()
