"""Browser-free preparation with pinned first-party modules in a short Node process.

The process has no network/write/child-process permission. Python owns the saved
login and permits exactly prepare then finalize over verified ChatGPT HTTPS.
No generation endpoint, account cookies, bearer tokens or transcripts are exposed
to JavaScript. Verification responses are exchanged only over in-memory pipes.
"""

from html.parser import HTMLParser
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time

from ..errors import ClaudeError
from ..state import STATE_DIR, atomic_write
from .preparation import verification_headers

CACHE = Path(os.environ.get("CLAUDFREE_CACHE_DIR", STATE_DIR / "cache")).resolve()
ASSETS = CACHE / "chatgpt-assets"
DEPENDENCIES = CACHE / "chatgpt-runtime"
PROFILE = json.loads(Path(__file__).with_name("runtime_profile.json").read_text("utf-8"))
HASHES = PROFILE["assets"]
LIMIT = 2 * 1024 * 1024


def failure(code="runtime_preparation_failed"):
    return ClaudeError(
        "JavaScript preparation did not finish. No chat message was sent and no browser was opened. Check runtime setup in docs/CHATGPT.txt.",
        code=code,
    )


def bootstrap_config(html):
    class Parser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.capture = False
            self.parts = []

        def handle_starttag(self, tag, attrs):
            if tag == "script" and dict(attrs).get("id") == "client-bootstrap":
                self.capture = True

        def handle_data(self, data):
            if self.capture:
                self.parts.append(data)

        def handle_endtag(self, tag):
            if tag == "script":
                self.capture = False

    parser = Parser()
    parser.feed(html)
    value = json.loads("".join(parser.parts))
    if not isinstance(value, dict):
        raise ValueError("Invalid bootstrap")
    keys = {
        "authStatus",
        "sessionId",
        "cluster",
        "locale",
        "flags",
        "isNoAuthEnabled",
        "isElectron",
        "isIos",
        "isAndroidChrome",
        "datadogRumProxyEnabled",
    }
    result = {key: value[key] for key in keys if key in value}
    if not isinstance(result.get("sessionId"), str) or not result["sessionId"]:
        raise ValueError("Missing request correlation ID")
    # sessionId is a page/request correlation ID, not the account session cookie.
    return {**result, "session": None, "user": None}


def valid_request(message, phase):
    if phase not in (0, 1) or not isinstance(message, dict):
        return False
    endpoint = "prepare" if phase == 0 else "finalize"
    if (
        message.get("url")
        != "https://chatgpt.com/backend-api/sentinel/chat-requirements/" + endpoint
        or message.get("method") != "POST"
        or not isinstance(message.get("body"), str)
        or len(message["body"]) > 1024 * 1024
    ):
        return False
    try:
        body = json.loads(message["body"])
        required = "p" if phase == 0 else "prepare_token"
        allowed = {"p"} if phase == 0 else {"prepare_token", "proofofwork", "turnstile"}
        return (
            isinstance(body, dict)
            and set(body).issubset(allowed)
            and isinstance(body.get(required), str)
            and bool(body[required])
            and all(isinstance(value, str) for value in body.values())
        )
    except (TypeError, ValueError):
        return False


def installation():
    """Fail locally before account traffic; no implicit downloads or installations."""
    node = shutil.which("node")
    try:
        package = DEPENDENCIES / "node_modules" / PROFILE["runtime"]["package"] / "package.json"
        version = json.loads(package.read_text("utf-8"))["version"]
        if not node or version != PROFILE["runtime"]["version"]:
            raise ValueError()
        for name, digest in HASHES.items():
            if hashlib.sha256((ASSETS / name).read_bytes()).hexdigest() != digest:
                raise ValueError()
        return node
    except (OSError, ValueError, KeyError, TypeError):
        raise failure("runtime_setup_required") from None


def download_assets():
    """Explicit setup only: fetch the three pinned public assets, without login."""
    import requests

    downloaded = 0
    for name, digest in HASHES.items():
        target = ASSETS / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
            continue
        try:
            with requests.get(
                "https://chatgpt.com/cdn/assets/" + name,
                stream=True,
                timeout=(10, 20),
                verify=True,
                allow_redirects=False,
            ) as reply:
                if reply.status_code != 200:
                    raise ValueError()
                content = bytearray()
                for chunk in reply.iter_content(65536):
                    content.extend(chunk)
                    if len(content) > 4 * LIMIT:
                        raise ValueError()
                if hashlib.sha256(content).hexdigest() != digest:
                    raise ValueError()
                atomic_write(target, bytes(content))
                downloaded += 1
        except (requests.RequestException, ValueError, OSError):
            raise failure("runtime_asset_download_failed") from None
    return {"ok": True, "files_verified": len(HASHES), "files_downloaded": downloaded}


def collect(http, count):
    node = installation()
    if not http.account_key:
        raise failure("invalid_response")
    page = http._request("GET", "/")
    try:
        if len(page.content) > 6 * LIMIT:
            raise ValueError()
        bootstrap = bootstrap_config(page.text)
    except (ValueError, TypeError):
        raise failure("runtime_bootstrap_invalid") from None
    finally:
        page.close()
    config = {
        "type": "config",
        "bootstrap": bootstrap,
        "device_id": http.session.headers.get("OAI-Device-ID"),
        "user_agent": http.session.headers.get("User-Agent"),
        "profile": PROFILE,
    }
    entries, measurements = [], []
    for _ in range(count):
        headers, metrics = _run(node, http, config)
        entries.append({"headers": headers, "created_at": time.time()})
        measurements.append(metrics)
    return entries, measurements


def _run(node, http, config):
    script = Path(__file__).with_suffix(".mjs")
    args = [
        node,
        "--experimental-vm-modules",
        "--permission",
        "--allow-fs-read=" + str(script),
        "--allow-fs-read=" + str(ASSETS) + "/*",
        "--allow-fs-read=" + str(DEPENDENCIES) + "/*",
        str(script),
        str(ASSETS),
        str(DEPENDENCIES),
    ]
    try:
        process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            cwd=script.parent,
            env={
                key: value
                for key, value in os.environ.items()
                if key.upper()
                in {
                    "PATH",
                    "SYSTEMROOT",
                    "WINDIR",
                    "TEMP",
                    "TMP",
                    "COMSPEC",
                    "SYSTEMDRIVE",
                    "PATHEXT",
                    "LANG",
                    "LC_ALL",
                    "TZ",
                }
            },
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except OSError:
        raise failure("runtime_start_failed") from None
    inbox = queue.Queue()

    def read_lines():
        try:
            while line := process.stdout.readline(LIMIT + 1):
                if len(line) > LIMIT:
                    break
                inbox.put(json.loads(line))
        except (ValueError, OSError):
            pass
        finally:
            inbox.put(None)

    reader = threading.Thread(target=read_lines, daemon=True)
    reader.start()

    def write(value):
        process.stdin.write(json.dumps(value) + "\n")
        process.stdin.flush()

    phase = 0
    deadline = time.monotonic() + min(http.timeout, 45)
    try:
        write(config)
        while time.monotonic() < deadline:
            try:
                message = inbox.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise failure("runtime_timeout") from None
            if not isinstance(message, dict):
                raise failure()
            if message.get("type") == "result":
                if message.get("error") == "runtime_protocol_changed":
                    raise failure("runtime_protocol_changed")
                if message.get("error") or phase != 2:
                    raise failure()
                headers = verification_headers(message.get("headers"))
                metrics = message.get("report", {})
                if not isinstance(metrics, dict):
                    raise ValueError()
                # Copy only numeric measurements, never arbitrary process output.
                measured = {
                    key: metrics[key]
                    for key in ("seconds", "rss_mib_at_completion")
                    if isinstance(metrics.get(key), (int, float))
                    and not isinstance(metrics[key], bool)
                    and math.isfinite(metrics[key])
                    and metrics[key] >= 0
                }
                return headers, measured
            if message.get("type") != "request" or not valid_request(message, phase):
                raise failure("runtime_protocol_rejected")
            phase += 1  # Consume permission before sending; failures are not retried.
            path = message["url"].removeprefix("https://chatgpt.com")
            original_timeout = http.timeout
            try:
                http.timeout = min(original_timeout, 15, max(1, int(deadline - time.monotonic())))
                reply = http._request(
                    "POST",
                    path,
                    data=message["body"],
                    headers={"Content-Type": "application/json"},
                    verify=True,
                )
            finally:
                http.timeout = original_timeout
            try:
                if len(reply.content) > LIMIT or not isinstance(reply.json(), dict):
                    raise ValueError()
                write(
                    {
                        "type": "response",
                        "id": message.get("id"),
                        "status": reply.status_code,
                        "body": reply.text,
                    }
                )
            finally:
                reply.close()
        raise failure("runtime_timeout")
    except (ValueError, TypeError, OSError, KeyError):
        raise failure() from None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        reader.join(timeout=1)
        process.stdin.close()
        process.stdout.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Download and verify the pinned public preparation modules. No account or browser access."
    )
    parser.add_argument("--download-assets", action="store_true", required=True)
    parser.parse_args()
    try:
        print(json.dumps(download_assets()))
    except ClaudeError as error:
        print(json.dumps({"ok": False, "error": {"code": error.code}}))
        raise SystemExit(1) from None
