"""Visible manual ChatGPT sign-in; only this provider's state is retained."""

import asyncio
import time

from ..browser import launch_browser
from ..errors import ClaudeError
from .state import ChatGPTState


async def login(store: ChatGPTState, *, engine: str = "camoufox", timeout: int = 900) -> dict:
    """Wait for a verified account session, save it encrypted, then close the window."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise ClaudeError(
            "Install browser support: pip install -e '.[browser]'", code="missing_dependency"
        ) from None
    async with async_playwright() as pw:
        browser = await launch_browser(pw, engine, headless=False)
        try:
            context = await browser.new_context(storage_state=store.load(), no_viewport=True)
            page = await context.new_page()
            await page.goto("https://chatgpt.com/", wait_until="commit", timeout=60000)
            deadline = time.monotonic() + timeout
            while browser.is_connected() and context.pages and time.monotonic() < deadline:
                for page in context.pages:
                    if not page.url.startswith("https://chatgpt.com/"):
                        continue
                    # Logged-out ChatGPT also has a composer; it is not proof of login.
                    if not await page.get_by_role(
                        "button", name="Temporary chat", exact=True
                    ).is_visible():
                        continue
                    authenticated = await page.evaluate("""async () => {
                        const r = await fetch('/api/auth/session');
                        if (!r.ok) return false;
                        const b = await r.json();
                        return Boolean(b.user && b.accessToken);
                    }""")
                    if authenticated:
                        store.save(await context.storage_state(indexed_db=True))
                        return {"authenticated": True, "provider": "chatgpt", "encrypted": True}
                await asyncio.sleep(1)
            raise ClaudeError(
                "ChatGPT login was not completed. Run login --provider chatgpt again.",
                code="login_required",
            )
        finally:
            await browser.close()
