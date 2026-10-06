"""Manual sign-in in the installed Chrome/Edge through zendriver, on a throwaway profile.

One engine with the CLI's sign-in window (owner, 2026-10-06). Cookies are saved in the
Playwright storage_state shape the HTTP clients already read; origins are always empty.
"""

import asyncio
import json
import time
from urllib.parse import urlsplit

from . import state
from .errors import ClaudeError

CLAUDE_URL = "https://claude.ai/new"
CHATGPT_URL = "https://chatgpt.com/"
COMPOSER = '[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], textarea[placeholder*="Claude" i]'

# Visible = nonzero box and not hidden by style; shared by both checks.
_VISIBLE_JS = """(el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
}"""


async def open_browser(*, headless: bool = False):
    try:
        import zendriver as zd
    except ImportError:
        raise ClaudeError(
            "Install browser support: python -m pip install zendriver==0.17.0",
            code="missing_dependency",
        ) from None
    try:
        return await zd.start(
            headless=headless,
            browser_args=["--window-size=1100,860", "--no-first-run", "--no-default-browser-check"],
        )
    except Exception:
        # The raw exception can carry URLs, so it is never shown.
        raise ClaudeError(
            "No browser could start for sign-in. Install Google Chrome or Microsoft Edge.",
            code="browser_unavailable",
        ) from None


async def close_browser(browser) -> None:
    try:
        await browser.stop()
    except Exception:
        pass


def to_saved(cookie) -> dict:
    expires = cookie.expires
    return {
        "name": cookie.name,
        "value": cookie.value,
        "domain": cookie.domain,
        "path": cookie.path,
        "expires": -1.0 if cookie.session or expires is None else float(expires),
        "httpOnly": bool(cookie.http_only),
        "secure": bool(cookie.secure),
        "sameSite": cookie.same_site.value if cookie.same_site else "Lax",
    }


async def export_cookies(browser) -> list[dict]:
    return [to_saved(c) for c in await browser.cookies.get_all()]


async def load_cookies(browser, cookies: list[dict]) -> None:
    from zendriver.cdp.network import CookieParam, CookieSameSite, TimeSinceEpoch

    now = time.time()
    params = []
    for c in cookies:
        expires = c.get("expires", -1)
        if expires > 0 and expires <= now:
            continue
        domain = c.get("domain", "")
        # As Playwright restored them: a domain without a leading dot is a host-only cookie, set by
        # URL; given a domain, Chrome refuses a __Host- cookie and with it the whole batch.
        params.append(
            CookieParam(
                name=c["name"],
                value=c["value"],
                domain=domain if domain.startswith(".") else None,
                url=None if domain.startswith(".") else f"https://{domain}{c.get('path', '/')}",
                path=c.get("path"),
                secure=c.get("secure"),
                http_only=c.get("httpOnly"),
                same_site=CookieSameSite(c.get("sameSite", "Lax")),
                expires=TimeSinceEpoch(float(expires)) if expires > 0 else None,
            )
        )
    if not params:
        return
    try:
        await browser.cookies.set_all(params)
    except Exception:
        pass  # Only a head start: without the old cookies the person signs in from scratch.


async def claude_signed_in(browser, tab) -> bool:
    if urlsplit(tab.url or "").hostname != "claude.ai":
        return False
    if not any(state.claude_domain(c.domain) for c in await browser.cookies.get_all()):
        return False
    return bool(
        await tab.evaluate(
            f"(() => {{ const visible = {_VISIBLE_JS}; "
            f"return [...document.querySelectorAll({json.dumps(COMPOSER)})].some(visible); }})()"
        )
    )


async def chatgpt_signed_in(browser, tab) -> bool:
    if not (tab.url or "").startswith(CHATGPT_URL):
        return False
    # Logged-out ChatGPT also has a composer; the session JSON is the proof, and only a boolean leaves the page.
    return bool(
        await tab.evaluate(
            f"""(async () => {{
                const visible = {_VISIBLE_JS};
                const temp = [...document.querySelectorAll('button, [role=button]')].some(
                    (el) => visible(el) &&
                        (el.getAttribute('aria-label') === 'Temporary chat' || el.innerText.trim() === 'Temporary chat'));
                if (!temp) return false;
                const r = await fetch('/api/auth/session');
                if (!r.ok) return false;
                const b = await r.json();
                return Boolean(b.user && b.accessToken);
            }})()""",
            await_promise=True,
        )
    )


async def wait_signed_in(browser, check, timeout, *, closed_message, timeout_message, code):
    deadline = time.monotonic() + timeout
    empty = 0
    while time.monotonic() < deadline:
        if browser.stopped:
            raise ClaudeError(closed_message, code=code)
        try:
            await browser.update_targets()
            tabs = list(browser.tabs)
        except Exception:
            tabs = []
        empty = 0 if tabs else empty + 1
        if empty >= 3:
            raise ClaudeError(closed_message, code=code)
        for tab in tabs:
            try:
                if await check(browser, tab):
                    return tab
            except Exception:
                continue  # A tab mid-navigation or closing.
        await asyncio.sleep(0.5)
    raise ClaudeError(timeout_message, code=code)


async def login_claude(timeout: int) -> None:
    browser = await open_browser()
    try:
        await browser.get(CLAUDE_URL)
        await wait_signed_in(
            browser,
            claude_signed_in,
            timeout,
            closed_message="Browser closed before login completed.",
            timeout_message="Login timed out. Run the script again when ready.",
            code="login_required",
        )
        state.save_session({"cookies": await export_cookies(browser), "origins": []})
    finally:
        await close_browser(browser)


async def login_chatgpt(store, timeout: int = 900) -> dict:
    browser = await open_browser()
    try:
        await load_cookies(browser, (store.load() or {}).get("cookies", []))
        await browser.get(CHATGPT_URL)
        message = "ChatGPT login was not completed. Run login --provider chatgpt again."
        await wait_signed_in(
            browser,
            chatgpt_signed_in,
            timeout,
            closed_message=message,
            timeout_message=message,
            code="login_required",
        )
        store.save({"cookies": await export_cookies(browser), "origins": []})
        return {"authenticated": True, "provider": "chatgpt", "encrypted": True}
    finally:
        await close_browser(browser)
