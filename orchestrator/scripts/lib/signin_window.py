"""Quick add's sign-in window, on zendriver (the owner's chosen engine, 2026-09-30).

Run by server/src/core/signin-window.ts, never by the orchestrator menu:

    python signin_window.py <url> <callback_prefix> [--headless]

Opens <url> in a new window on a fresh throwaway profile (zendriver's temporary user-data-dir,
removed when the browser stops), so it is never the person's own browser session. The person does
the sign-in there; this clicks and types nothing. It only reads which address each tab is on: when
one starts with <callback_prefix> and carries `code` and `state`, it prints the "code#state" the
page shows for pasting. It closes the browser on "close" (or end of input) on stdin.

stdout, one JSON object per line:
    {"ready": true} | {"code": "<code>#<state>"} | {"closed": true} | {"error": "<why>"}
--headless exists for the plumbing check only (no window on the owner's screen).
"""

import asyncio
import json
import sys
import threading
from urllib.parse import parse_qs, urlparse


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def watch_stdin(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    for line in sys.stdin:
        if line.strip() == "close":
            break
    loop.call_soon_threadsafe(stop.set)


def callback_code(url: str, prefix: str) -> str | None:
    if not url.startswith(prefix):
        return None
    query = parse_qs(urlparse(url).query)
    code = (query.get("code") or [None])[0]
    state = (query.get("state") or [None])[0]
    return f"{code}#{state}" if code and state else None


async def main(url: str, prefix: str, headless: bool) -> int:
    try:
        import zendriver as zd
    except ImportError:
        emit({"error": "zendriver is not installed (python -m pip install zendriver)"})
        return 2
    browser = None
    try:
        browser = await zd.start(
            headless=headless,
            browser_args=["--window-size=520,780", "--no-first-run", "--no-default-browser-check"],
        )
        await browser.get(url)
    except Exception as err:  # noqa: BLE001 - reported to the caller as the reason
        emit({"error": f"could not open the sign-in window: {err}"})
        if browser is not None:
            try:
                await browser.stop()
            except Exception:  # noqa: BLE001 - already gone
                pass
        return 1
    emit({"ready": True})

    stop = asyncio.Event()
    threading.Thread(target=watch_stdin, args=(asyncio.get_running_loop(), stop), daemon=True).start()
    handed_over = False
    misses = 0  # polls in a row that found no tab: a redirect can blip one, a closed window keeps it
    try:
        while not stop.is_set():
            try:
                await browser.update_targets()
                tabs = browser.tabs
            except Exception:  # noqa: BLE001 - mid-navigation, or the browser is gone
                tabs = []
            if tabs:
                misses = 0
            else:
                misses += 1
                if browser.stopped or misses >= 3:
                    # The person closed the window (the browser exits with its last one).
                    emit({"closed": True})
                    break
            if not handed_over:
                for tab in tabs:
                    code = callback_code(tab.url or "", prefix)
                    if code:
                        handed_over = True
                        emit({"code": code})
                        break
            try:
                await asyncio.wait_for(stop.wait(), 1.0)
            except asyncio.TimeoutError:
                pass
    finally:
        try:
            await browser.stop()
        except Exception:  # noqa: BLE001 - already gone
            pass
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--headless"]
    if len(args) != 2:
        emit({"error": "usage: signin_window.py <url> <callback_prefix> [--headless]"})
        sys.exit(2)
    sys.exit(asyncio.run(main(args[0], args[1], "--headless" in sys.argv[1:])))
