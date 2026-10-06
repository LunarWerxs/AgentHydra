"""Explicit visible-browser preparation; all browser generation is blocked.

This is imported only by prepare(), never by ordinary HTTP commands. The normal
website prepares its own requests. No verification solver is implemented here.
"""

import asyncio
from contextlib import redirect_stdout
import gzip
import json
import sys
import time
from urllib.parse import urlsplit

from ..errors import ClaudeError
from .browser import BrowserChats, SEND_PATHS, open_temporary_page
from .preparation import MAX_PREPARATIONS, verification_headers

PLACEHOLDER = "ClaudFree connection preparation. This message must not be transmitted."


def capture_headers(url, headers, raw):
    parsed = urlsplit(url)
    try:
        if (
            parsed.scheme != "https"
            or parsed.netloc != "chatgpt.com"
            or parsed.path not in SEND_PATHS
        ):
            raise ValueError()
        encoding = headers.get("content-encoding")
        if encoding == "gzip":
            raw = gzip.decompress(raw)
        elif encoding not in {None, "", "identity"}:
            raise ValueError()
        body = json.loads(raw)
        if body.get("history_and_training_disabled") is not True or body.get("conversation_id"):
            raise ValueError()
        prompts = [
            m.get("content", {}).get("parts")
            for m in body.get("messages", [])
            if isinstance(m, dict) and m.get("author", {}).get("role") == "user"
        ]
        if prompts != [[PLACEHOLDER]]:
            raise ValueError()
        # The captured body is never sent or stored. HTTP constructs its own
        # Temporary, unpersonalized payload, even if the website's flag disagrees.
        return verification_headers(headers)
    except (ValueError, TypeError, AttributeError, OSError, EOFError):
        raise ClaudeError(
            "The website preparation could not be verified. No message was sent.",
            code="preparation_invalid",
        ) from None


async def collect(store, count):
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_PREPARATIONS:
        raise ClaudeError(
            f"count must be between 1 and {MAX_PREPARATIONS}.", code="invalid_arguments"
        )
    browser = BrowserChats(store, headless=False)
    pending = None
    entries = []

    async def intercept(route):
        request = route.request
        target = pending
        if request.method != "POST" or urlsplit(request.url).path not in SEND_PATHS:
            await route.fallback()
            return
        # Abort every generation attempt, including automatic UI retries, before
        # completing capture. No account inference occurs during preparation.
        try:
            headers = {k.lower(): v for k, v in (await request.all_headers()).items()}
            value = capture_headers(request.url, headers, request.post_data_buffer)
        except Exception:
            value = None
        await route.abort()
        if target is not None and target is pending and not target.done():
            if value is None:
                target.set_exception(
                    ClaudeError("Website preparation failed.", code="preparation_invalid")
                )
            else:
                target.set_result({"headers": value, "created_at": time.time()})

    try:
        # Dependency diagnostics must not corrupt the CLI's single JSON object.
        with redirect_stdout(sys.stderr):
            await browser.start()
        await browser.context.route("**/backend-api/**", intercept)
        for _ in range(count):
            page = await open_temporary_page(browser.context)
            try:
                await browser.guard(page)
                pending = asyncio.get_running_loop().create_future()
                await page.get_by_role("textbox", name="Chat with ChatGPT", exact=True).fill(
                    PLACEHOLDER
                )
                await page.get_by_role("button", name="Send prompt", exact=True).click(
                    timeout=10000
                )
                entries.append(await asyncio.wait_for(pending, timeout=60))
            finally:
                pending = None
                await page.close()
        return entries
    except ClaudeError:
        raise
    except Exception:
        raise ClaudeError(
            "Visible preparation did not finish. Check the normal website login and try prepare again. No message was sent.",
            code="preparation_failed",
        ) from None
    finally:
        await browser.close()
