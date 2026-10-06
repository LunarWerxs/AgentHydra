"""Visible manual login and optional request discovery. Imported only by browser commands."""

import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from .errors import ClaudeError as UserError
from .state import (
    SESSION_FILE,
    BROWSER_RUNTIME_FILE,
    REQUEST_FILE,
    atomic_write,
    load_session,
    save_session,
)

NEW_CHAT_URL = "https://claude.ai/new"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
COMPOSER = '[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], textarea[placeholder*="Claude" i]'


def find_desktop(explicit: str | None = None) -> Path | None:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.is_file():
            raise UserError("The supplied Claude Desktop executable does not exist.")
        return path
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = [
        local / "AnthropicClaude" / "claude.exe",
        local / "Programs" / "Claude" / "Claude.exe",
        local / "Programs" / "AnthropicClaude" / "Claude.exe",
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Claude" / "Claude.exe",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def open_desktop(explicit: str | None) -> None:
    path = find_desktop(explicit)
    if path is None:
        print(
            "Claude Desktop was not found. Continuing with Claude web; use --desktop-exe to set its path."
        )
        return
    subprocess.Popen(
        [str(path)], cwd=str(path.parent), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    print(
        "Opened Claude Desktop. Desktop manages its own login; the browser login below is separate."
    )


def camoufox_options() -> dict[str, Any]:
    """Pin the same installed build on successive runs, as KrzRedUpv does."""
    try:
        from camoufox.pkgman import Version, camoufox_path, launch_path
    except ImportError:
        raise UserError(
            "Camoufox is missing. Install: python -m pip install -e '.[browser]'"
        ) from None
    try:
        directory = None
        if BROWSER_RUNTIME_FILE.exists():
            cached = json.loads(BROWSER_RUNTIME_FILE.read_text(encoding="utf-8"))
            candidate = Path(cached["browser_directory"])
            if candidate.is_dir() and Version.from_path(candidate).is_supported():
                directory = candidate
        if directory is None:
            directory = Path(camoufox_path())
        version = Version.from_path(directory)
        if not version.is_supported():
            raise ValueError("unsupported browser")
        executable = launch_path(directory)
        atomic_write(
            BROWSER_RUNTIME_FILE,
            json.dumps(
                {
                    "browser_directory": str(directory),
                    "executable_path": str(executable),
                },
                indent=2,
            ).encode("utf-8"),
        )
        return {
            "executable_path": str(executable),
            "ff_version": int(version.full_string.split(".", 1)[0]),
            "i_know_what_im_doing": True,
        }
    except (OSError, ValueError, KeyError, TypeError):
        raise UserError(
            "Camoufox's browser is missing or unsupported. Run: .venv\\Scripts\\python.exe -m camoufox fetch"
        ) from None


async def launch_browser(playwright: Any, engine: str, *, headless: bool = False) -> Any:
    if engine == "camoufox":
        from camoufox.addons import DefaultAddons
        from camoufox.async_api import AsyncNewBrowser

        return await AsyncNewBrowser(
            playwright,
            headless=headless,
            os="windows",
            geoip=False,
            exclude_addons=[DefaultAddons.UBO],
            **camoufox_options(),
        )
    options: dict[str, Any] = {"headless": headless}
    if engine != "chromium":
        options["channel"] = engine
    return await playwright.chromium.launch(**options)


def endpoint_template(url: str) -> str:
    parts = urlsplit(url)
    path = UUID.sub("{id}", parts.path)
    path = re.sub(r"(/organizations/)[^/]+", r"\1{organization_id}", path)
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def request_category(method: str, url: str) -> str | None:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "claude.ai":
        return None
    path = parts.path.rstrip("/")
    if not path.startswith("/api/"):
        return None
    if re.search(r"/(?:chat_conversations|conversations)$", path) and method == "POST":
        return "create_chat"
    if re.search(r"/(?:chat_conversations|conversations)/", path):
        if method == "POST" and path.endswith(("/completion", "/messages")):
            return "send_message"
        if method in {"GET", "POST", "PATCH"}:
            return "chat_request"
    return None


def safe_body_description(raw: str | None) -> dict[str, Any]:
    """Retain schema and privacy booleans, never prompts or token values."""
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (ValueError, TypeError):
        return {"body_format": "non-json (not recorded)"}
    if not isinstance(body, dict):
        return {"body_format": "json (not recorded)"}
    types: dict[str, str] = {}
    flags: dict[str, bool] = {}

    def describe(fields: dict[str, Any], prefix: str = "", depth: int = 0) -> None:
        for key, value in list(fields.items())[:100]:
            # Only ordinary field names are retained; arbitrary keys can be user data.
            if not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9]{0,63}", key):
                continue
            path = prefix + key
            types[path] = (
                "boolean"
                if isinstance(value, bool)
                else "null"
                if value is None
                else "object"
                if isinstance(value, dict)
                else "array"
                if isinstance(value, list)
                else "number"
                if isinstance(value, (int, float))
                else "string"
            )
            if key in {
                "is_incognito",
                "incognito",
                "is_temporary",
                "temporary",
                "is_ephemeral",
            } and isinstance(value, bool):
                flags[path] = value
            if isinstance(value, dict) and depth < 3:
                describe(value, path + ".", depth + 1)

    describe(body)
    return {"json_field_types": types, "privacy_flags": flags}


class RequestRecorder:
    """Observe actual browser requests without exporting headers or contents."""

    def __init__(self, path: Path = REQUEST_FILE) -> None:
        self.path = path
        self.records: list[dict[str, Any]] = []
        if path.exists():
            try:
                self.records = json.loads(path.read_text(encoding="utf-8"))["requests"][-100:]
            except (OSError, ValueError, KeyError, TypeError):
                pass
        self.announced: set[str] = set()
        self.error: str | None = None

    def on_response(self, response: Any) -> None:
        try:
            request = response.request
            category = request_category(request.method, request.url)
            if category is None:
                return
            parts = urlsplit(request.url)
            # Account/conversation IDs in the path are kept so this is the actual URL.
            # Query strings, fragments, request/response headers and bodies are excluded.
            actual_url = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
            record = {
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "kind": category,
                "method": request.method,
                "url": actual_url,
                "url_template": endpoint_template(actual_url),
                "status": response.status,
                **safe_body_description(request.post_data),
            }
            identity = (
                record["kind"],
                record["method"],
                record["url"],
                record["status"],
                record.get("privacy_flags"),
            )
            if any(
                (r["kind"], r["method"], r["url"], r["status"], r.get("privacy_flags")) == identity
                for r in self.records
            ):
                return
            self.records.append(record)
            self.records = self.records[-100:]
            report = {
                "note": "Observed private Claude web endpoints, not a public API contract. No cookies, authorization headers, prompt text, or response bodies are saved here.",
                "requests": self.records,
            }
            atomic_write(self.path, json.dumps(report, indent=2).encode("utf-8"))
            if (
                category == "create_chat"
                and 200 <= response.status < 300
                and category not in self.announced
            ):
                print(
                    f"Observed successful chat creation: {request.method} {record['url_template']}",
                    flush=True,
                )
                print(f"Actual URL, status and JSON field types saved to {self.path}", flush=True)
                self.announced.add(category)
            if (
                category == "send_message"
                and 200 <= response.status < 300
                and record.get("privacy_flags", {}).get("create_conversation_params.is_temporary")
                and "incognito" not in self.announced
            ):
                print(
                    f"Observed Incognito chat request: {request.method} {record['url_template']} [{response.status}]",
                    flush=True,
                )
                print("Confirmed: create_conversation_params.is_temporary = true", flush=True)
                self.announced.add("incognito")
        except Exception:
            # Exceptions can include request data; show a generic error only.
            if self.error is None:
                self.error = (
                    "A request could not be recorded. Check that requests.json is writable."
                )
                print(self.error, flush=True)


async def visible_composer(page: Any) -> Any | None:
    for locator in await page.locator(COMPOSER).all():
        if await locator.is_visible():
            return locator
    return None


async def authenticated(page: Any, context: Any) -> bool:
    if page.is_closed() or urlsplit(page.url).hostname != "claude.ai":
        return False
    return (
        bool(await context.cookies("https://claude.ai"))
        and await visible_composer(page) is not None
    )


async def wait_for_login(page: Any, context: Any, timeout: int) -> Any:
    print(
        "Waiting for Claude's message box. Complete sign-in or verification in the browser if prompted.",
        flush=True,
    )
    print(
        "This script continues when the chat message box appears. Close the browser to cancel.",
        flush=True,
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not context.pages:
            raise UserError("Browser closed before login completed.")
        # Email/Google callbacks can open Claude in a second tab, leaving the
        # original login page open. Follow the authenticated tab in this context.
        candidates = [page, *reversed(context.pages)]
        for candidate in candidates:
            try:
                if await authenticated(candidate, context):
                    return candidate
            except Exception:
                if not context.pages:
                    raise UserError("Browser closed before login completed.") from None
        await asyncio.sleep(0.5)
    raise UserError("Login timed out. Run the script again when ready.")


async def incognito_enabled(page: Any) -> bool:
    labels = page.get_by_text(re.compile(r"^Incognito chat$", re.I))
    for label in await labels.all():
        if await label.is_visible() and await label.evaluate(
            "el => !el.closest('button, [role=button], [role=tooltip], [role=dialog]')"
        ):
            return True
    return False


async def enable_incognito(page: Any, timeout: int) -> None:
    # Never send a prompt until the visible Incognito chat label is verified.
    if await incognito_enabled(page):
        return
    candidates = [
        page.get_by_role("button", name=re.compile("incognito", re.I)),
        page.locator(
            'button[aria-label*="incognito" i], button[title*="incognito" i], button[data-testid*="incognito" i]'
        ),
    ]
    clicked = False
    for group in candidates:
        for button in await group.all():
            if await button.is_visible() and await button.is_enabled():
                try:
                    await button.click(timeout=5000)
                    clicked = True
                except Exception:
                    # An unfamiliar/broken control can still be enabled manually.
                    pass
                break
        if clicked:
            break
    # A short wait also allows any transition after clicking the ghost icon.
    for _ in range(20):
        if await incognito_enabled(page):
            print("Claude Incognito chat is active.", flush=True)
            return
        await asyncio.sleep(0.25)
    print("Click Claude's ghost icon at the top right to enable Incognito chat.", flush=True)
    print("Waiting for the visible 'Incognito chat' label before continuing.", flush=True)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.is_closed():
            raise UserError("Browser closed before Incognito chat was enabled.")
        if await incognito_enabled(page):
            print("Claude Incognito chat is active.", flush=True)
            return
        await asyncio.sleep(0.5)
    raise UserError("Incognito chat was not confirmed. No prompt was sent by the script.")


async def send_prompt(page: Any, prompt: str, regular: bool) -> None:
    if not regular and not await incognito_enabled(page):
        raise UserError("Incognito chat is no longer active. No prompt was sent.")
    composer = await visible_composer(page)
    if composer is None:
        raise UserError("The Claude message box was not found.")
    await composer.fill(prompt)
    # Claude's Enter-to-send behavior can be changed in user settings; prefer the button.
    for _ in range(20):
        # React can enable/render the Send button shortly after editor.fill().
        # Poll readiness instead of treating that brief delay as an unknown UI.
        for name in (r"^Send(?: message)?$", r"^Send to Claude$"):
            buttons = page.get_by_role("button", name=re.compile(name, re.I))
            for button in await buttons.all():
                if await button.is_visible() and await button.is_enabled():
                    if not regular and not await incognito_enabled(page):
                        raise UserError(
                            "Incognito chat is no longer active. The prompt was left unsent."
                        )
                    await button.click(timeout=5000)
                    return
        await asyncio.sleep(0.25)
    print(
        "The prompt is in the message box. Click Send manually; the current Send button was not recognized.",
        flush=True,
    )


async def run_browser(args: argparse.Namespace) -> None:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise UserError("Install dependencies: python -m pip install -e '.[browser]'") from None
    if not args.no_desktop:
        open_desktop(args.desktop_exe)
    saved = None if args.command == "login" else load_session()
    async with async_playwright() as playwright:
        try:
            browser = await launch_browser(playwright, args.browser)
        except UserError:
            raise
        except Exception:
            raise UserError(
                "Browser could not start. Run 'python claudfree.py doctor' to check Camoufox. For Chromium run: python -m playwright install chromium. Or use --browser chrome / --browser msedge."
            ) from None
        print(f"Opened browser: {args.browser}", flush=True)
        print(
            "Restoring the saved web session." if saved else "Starting a fresh web session.",
            flush=True,
        )
        context = await browser.new_context(storage_state=saved, no_viewport=True)
        page = await context.new_page()
        recorder = RequestRecorder()
        context.on("response", recorder.on_response)
        try:
            print("Loading Claude.", flush=True)
            # Authentication/editor checks provide the readiness gate. Waiting
            # for every parser-blocking resource can stall a usable Claude page.
            await page.goto(NEW_CHAT_URL, wait_until="commit", timeout=60000)
            page = await wait_for_login(page, context, args.timeout)
            save_session(await context.storage_state(indexed_db=True))
            print(f"Claude web login saved with Windows encryption: {SESSION_FILE}", flush=True)
            if args.command == "login":
                print("Login complete. Next time run: python claudfree.py new", flush=True)
                return  # Desk's guided login completes and closes its owned browser here.
            else:
                # Always begin outside projects, where Incognito chat is available.
                await page.goto(NEW_CHAT_URL, wait_until="commit", timeout=60000)
                page = await wait_for_login(page, context, args.timeout)
                if not args.regular:
                    await enable_incognito(page, args.timeout)
                if args.prompt:
                    await send_prompt(page, args.prompt, args.regular)
                print(
                    "Chat is ready. The request recorder runs until you close this browser window.",
                    flush=True,
                )
                print(
                    "Sending the first message may be needed to observe the chat-creation POST.",
                    flush=True,
                )
                print(
                    "Later: python claudfree.py requests  (prints the observed URLs and methods)",
                    flush=True,
                )
            # Keep the browser and response events alive without blocking on console input.
            refreshed = time.monotonic()
            while browser.is_connected() and context.pages:
                if time.monotonic() - refreshed > 30:
                    try:
                        if await authenticated(page, context):
                            save_session(await context.storage_state(indexed_db=True))
                    except Exception:
                        pass
                    refreshed = time.monotonic()
                await asyncio.sleep(0.5)
        finally:
            if browser.is_connected():
                try:
                    if not page.is_closed() and await authenticated(page, context):
                        save_session(await context.storage_state(indexed_db=True))
                finally:
                    await browser.close()


def show_requests() -> None:
    if not REQUEST_FILE.exists():
        print(
            "No requests observed yet. Run 'python claudfree.py new', then send a message in Claude."
        )
        return
    report = json.loads(REQUEST_FILE.read_text(encoding="utf-8"))
    for record in report.get("requests", []):
        print(f"{record['kind']}: {record['method']} {record['url']} [{record['status']}]")
        if record.get("json_field_types"):
            print("  JSON fields: " + json.dumps(record["json_field_types"]))
        if record.get("privacy_flags"):
            print("  Privacy flags: " + json.dumps(record["privacy_flags"]))
    print("Use 'python claudfree.py new' to start another chat through Claude's UI.")
