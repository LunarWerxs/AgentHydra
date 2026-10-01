"""Quick add's sign-in window, on zendriver (the owner's chosen engine, 2026-09-30).

Run by server/src/core/signin-window.ts, never by the orchestrator menu:

    python signin_window.py <url> <callback_prefix> [--email <email>] [--position-file <path>] [--headless]

--assist-port <port> runs the same automation on an already open managed popup. Its original
controller retains the CLI handoff and window lifecycle; the assistant only disconnects on exit.

Opens <url> in a new window on a fresh throwaway profile (zendriver's temporary user-data-dir,
removed when the browser stops), so it is never the person's own browser session. The person does
the Cloudflare check and opens the email's link there. With --email, this submits the matching
prefilled email, relays the link page's copyable six-digit code to the waiting email-code form,
and authorizes this OAuth request. Codes stay in memory and never go to the system clipboard.
It also reads which address each tab is on: when
one starts with <callback_prefix> and carries `code` and `state`, it prints the "code#state" the
page shows for pasting. It closes the browser on "close" (or end of input) on stdin.
The popup's last normal position is saved outside its throwaway browser profile on close.

stdout, one JSON object per line:
    {"ready": true} | {"code": "<code>#<state>"} | {"closed": true} | {"error": "<why>"}
--headless exists for the plumbing check only (no window on the owner's screen).
"""

import argparse
import asyncio
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from .signin_clipboard import ClipboardLinkWatcher
except ImportError:  # Direct script execution by the daemon.
    from signin_clipboard import ClipboardLinkWatcher


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def watch_stdin(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    for line in sys.stdin:
        if line.strip() == "close":
            break
    loop.call_soon_threadsafe(stop.set)


class WindowPosition:
    """Remember only the popup's normal screen coordinates, including negative monitor origins."""

    def __init__(self, path: str | None, headless: bool):
        self.path = Path(path) if path and not headless else None
        self.window_id = None
        self.last = None

    @staticmethod
    def valid(value):
        return isinstance(value, dict) and all(
            type(value.get(key)) is int and abs(value[key]) < 1_000_000
            for key in ('left', 'top'))

    def launch_args(self) -> list[str]:
        if self.path is None:
            return []
        try:
            position = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return []
        if not self.valid(position):
            return []
        return [f"--window-position={position['left']},{position['top']}"]

    def remember(self, bounds) -> None:
        state = getattr(bounds.window_state, 'value', bounds.window_state)
        if state not in (None, 'normal'):
            return  # A minimized window's parking coordinates must not replace its location.
        position = {'left': bounds.left, 'top': bounds.top}
        if self.valid(position):
            self.last = position

    async def bind(self, tab) -> None:
        if self.path is None:
            return
        try:
            self.window_id, bounds = await asyncio.wait_for(tab.get_window(), 1.0)
            self.remember(bounds)
        except Exception:  # noqa: BLE001 - placement must not prevent sign-in
            pass

    async def sample(self, browser) -> None:
        if self.window_id is None:
            return
        try:
            from zendriver import cdp
            bounds = await asyncio.wait_for(
                browser.connection.send(cdp.browser.get_window_bounds(self.window_id)), 0.75)
            self.remember(bounds)
        except Exception:  # noqa: BLE001 - the person may already have closed the window
            pass

    async def watch(self, browser, stop: asyncio.Event) -> None:
        while self.window_id is not None and not stop.is_set():
            await self.sample(browser)
            try:
                await asyncio.wait_for(stop.wait(), 0.25)
            except asyncio.TimeoutError:
                pass

    def save(self) -> None:
        if self.path is None or self.last is None:
            return
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix=self.path.name + '.', suffix='.tmp', delete=False) as file:
                temporary = Path(file.name)
                json.dump(self.last, file)
            os.replace(temporary, self.path)
        except OSError:
            pass  # An unwritable settings directory must not interrupt the account addition.
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


def callback_code(url: str, prefix: str, expected_state: str | None = None) -> str | None:
    if not url.startswith(prefix):
        return None
    query = parse_qs(urlparse(url).query)
    code = (query.get("code") or [None])[0]
    state = (query.get("state") or [None])[0]
    return f"{code}#{state}" if code and state and (not expected_state or state == expected_state) else None


CLAUDE_SIGNIN_ORIGINS = {('https', 'claude.com'), ('https', 'claude.ai')}


def signin_origins(url: str) -> set[tuple[str, str]]:
    """Claude's CLI authorize endpoint redirects from claude.com to claude.ai for login."""
    parsed = urlparse(url)
    origin = (parsed.scheme, parsed.netloc.lower())
    return set(CLAUDE_SIGNIN_ORIGINS) if origin in CLAUDE_SIGNIN_ORIGINS else {origin}


# Inspect and click atomically so a navigation to the inbox-code/authorization step cannot turn
# a previously selected submit button into a click on that next step. The marker precedes the
# click: if a redirect loses the evaluation response, another poll cannot send the email twice.
SUBMIT_EMAIL_SCRIPT = r"""(expectedEmail => {
    if (window.__agentHydraEmailSubmitted) return true;
    const visible = el => el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== 'hidden';
    const email = [...document.querySelectorAll('input[type="email"]')].find(el =>
        visible(el) && el.value.trim().toLowerCase() === expectedEmail.toLowerCase());
    if (!email || !email.checkValidity()) return false;
    // Do not submit a later sign-in step, even if it still displays the email address.
    if ([...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]')].some(visible))
        return false;
    const responses = [...document.querySelectorAll('[name="cf-turnstile-response"], [name="g-recaptcha-response"]')];
    if (responses.some(el => !el.value.trim())) return false;
    // A rendered challenge without its response field is still waiting for the person.
    if (!responses.length && document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'))
        return false;
    const root = email.form || document;
    const buttons = [...root.querySelectorAll('button, input[type="submit"]')].filter(el => {
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        return visible(el) && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' &&
            /^(continue with email|continue|submit|send (?:login )?code)$/i.test(label);
    });
    if (buttons.length !== 1) return false;
    window.__agentHydraEmailSubmitted = true;
    buttons[0].click();
    return true;
})"""


class EmailSubmitter:
    """One email submission per window; page changes and failed polls remain safe to retry."""

    def __init__(self, url: str, email: str | None):
        parsed = urlparse(url)
        self.origin = (parsed.scheme, parsed.netloc.lower())
        self.origins = signin_origins(url)
        self.email = email
        self.submitted = False

    async def poll(self, tab) -> None:
        if not self.email or self.submitted:
            return
        parsed = urlparse(tab.url or "")
        if (parsed.scheme, parsed.netloc.lower()) not in self.origins:
            return
        try:
            self.submitted = await tab.evaluate(f"{SUBMIT_EMAIL_SCRIPT}({json.dumps(self.email)})") is True
        except Exception:  # noqa: BLE001 - redirecting, or a closed tab; manual sign-in stays usable
            pass


READ_EMAIL_CODE_SCRIPT = r"""(expectedEmail => {
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const text = document.body?.innerText || '';
    if (!/\bcode\b/i.test(text)) return null;
    const addresses = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || [];
    if (addresses.length && !addresses.some(v => v.toLowerCase() === expectedEmail.toLowerCase())) return null;
    const copies = [...document.querySelectorAll('button, [role="button"]')].filter(el => visible(el) &&
        (/copy/i.test([el.innerText, el.getAttribute('aria-label'), el.title].join(' ')) ||
        el.querySelector('svg[class*="copy"]')));
    if (!copies.length) return null;
    const candidates = [...document.querySelectorAll('input[readonly], input:disabled, textarea[readonly], textarea:disabled, code, pre, div, p, span, [data-clipboard-text], button, [role="button"]'),
        ...copies.flatMap(el => [...(el.parentElement?.children || [])])]
        .filter(visible).map(el => el.getAttribute('data-clipboard-text') || el.value || el.innerText || '')
        .map(v => v.trim().replace(/[\s-]/g, '')).filter(v => /^\d{6}$/.test(v));
    const codes = [...new Set(candidates)];
    return codes.length === 1 ? codes[0] : null;
})"""

EMAIL_CODE_FORM_SCRIPT = r"""((expectedEmail, code, action) => {
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const text = document.body?.innerText || '';
    if (!/email|inbox/i.test(text)) return false;
    const addresses = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || [];
    if (addresses.length && !addresses.some(v => v.toLowerCase() === expectedEmail.toLowerCase())) return false;
    const emails = [...document.querySelectorAll('input[type="email"]')].filter(visible);
    if (emails.some(el => el.value.trim().toLowerCase() !== expectedEmail.toLowerCase())) return false;
    const inputs = [...document.querySelectorAll('input')].filter(el => visible(el) && !el.readOnly &&
        !el.matches(':disabled') && (el.autocomplete === 'one-time-code' ||
        /code|otp/i.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ')) ||
        (el.inputMode === 'numeric' && [1, 6].includes(el.maxLength))));
    const split = inputs.length === 6 && inputs.every(el => el.maxLength === 1);
    if (inputs.length !== 1 && !split) return false;
    if (inputs.some(el => el.type === 'password' || el.type === 'email')) return false;
    if (action === 'inspect') return true;
    if (action === 'confirm') return inputs.map(el => el.value).join('') === code;
    const tokens = [...document.querySelectorAll('[name="cf-turnstile-response"], [name="g-recaptcha-response"]')];
    if (tokens.some(el => !el.value.trim()) || (!tokens.length && document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'))) return false;
    if (action === 'fill') {
        if (window.__agentHydraInboxCodeFilled) return true;
        if (inputs.some(el => el.value)) return false;
        window.__agentHydraInboxCodeFilled = true;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        inputs.forEach((el, i) => {
            setter.call(el, split ? code[i] : code);
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
        });
        return true;
    }
    if (window.__agentHydraInboxCodeSubmitted) return true;
    if (inputs.map(el => el.value).join('') !== code || inputs.some(el => !el.checkValidity())) return false;
    const root = inputs[0].form || document;
    const buttons = [...root.querySelectorAll('button, input[type="submit"]')].filter(el => visible(el) &&
        !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' &&
        /^(continue|sign in|log in|submit|verify(?: (?:email(?: address)?|code))?)$/i.test((el.innerText || el.value || '').trim()));
    if (buttons.length !== 1) return false;
    window.__agentHydraInboxCodeSubmitted = true;
    buttons[0].click();
    return true;
})"""

AUTHORIZE_SCRIPT = r"""(() => {
    if (window.__agentHydraAuthorized) return true;
    if (document.querySelector('input[autocomplete="one-time-code"], input[type="password"]')) return false;
    const buttons = [...document.querySelectorAll('button, input[type="submit"]')].filter(el =>
        el.getClientRects().length && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' &&
        /^(authorize|authorize claude code)$/i.test((el.innerText || el.value || '').trim()));
    if (buttons.length !== 1) return false;
    window.__agentHydraAuthorized = true;
    buttons[0].click();
    return true;
})()"""

AUTHORIZE_READINESS_SCRIPT = r"""(() => {
    if (window.__agentHydraAuthorized) return null;
    if (document.querySelector('input[autocomplete="one-time-code"], input[type="password"]')) return null;
    const buttons = [...document.querySelectorAll('button, input[type="submit"]')].filter(el =>
        el.getClientRects().length && /^(authorize|authorize claude code)$/i.test((el.innerText || el.value || '').trim()));
    if (buttons.length !== 1) return null;
    return {focused: document.hasFocus(), disabled: buttons[0].matches(':disabled') ||
        buttons[0].getAttribute('aria-disabled') === 'true'};
})()"""


class InboxCodeRelay:
    """Relay a copyable link-page code only into this window's previously observed email form."""

    def __init__(self, url: str, prefix: str, email: str | None):
        parsed = urlparse(url)
        self.origin = (parsed.scheme, parsed.netloc.lower())
        self.form_origins = signin_origins(url)
        callback = urlparse(prefix)
        self.origins = self.form_origins | {(callback.scheme, callback.netloc.lower())}
        self.authorize_routes = {(self.origin, parsed.path)}
        if self.origin in CLAUDE_SIGNIN_ORIGINS:
            self.authorize_routes |= {(('https', 'claude.com'), '/cai/oauth/authorize'),
                                      (('https', 'claude.ai'), '/oauth/authorize')}
        self.state = (parse_qs(parsed.query).get('state') or [None])[0]
        self.email = email
        self.waiting_id = None
        self.history_entry = None
        self.code = None
        self.filled = False
        self.submitted = False
        self.confirmed = False
        self.source_id = None
        self.source_closed = False
        self.activated_authorization = set()

    async def evaluate_form(self, tab, action: str):
        return await tab.evaluate(f"{EMAIL_CODE_FORM_SCRIPT}({json.dumps(self.email)}, "
                                  f"{json.dumps(self.code)}, {json.dumps(action)})")

    async def close_source(self, tabs) -> None:
        if not self.confirmed or not self.source_id or self.source_closed:
            return
        if self.source_id == self.waiting_id:
            self.source_closed = True  # Same-tab links were restored to the waiting form.
            return
        source = next((tab for tab in tabs if tab.target_id == self.source_id), None)
        if source is not None:
            await source.close()
        self.source_closed = True

    async def poll(self, tabs) -> None:
        if not self.email:
            return
        # A redirect can interrupt any DOM read. Leave the window usable for manual completion.
        for tab in tabs:
            parsed = urlparse(tab.url or '')
            origin = (parsed.scheme, parsed.netloc.lower())
            if origin not in self.origins:
                continue
            try:
                # A corrected controller can join after verification already advanced. These
                # markers belong to the exact original OAuth request, never an unrelated tab.
                state = (parse_qs(parsed.query).get('state') or [None])[0]
                if not self.waiting_id and self.state and state == self.state and (origin, parsed.path) in self.authorize_routes:
                    if await tab.evaluate('window.__agentHydraInboxCodeFilled === true && window.__agentHydraInboxCodeSubmitted === true'):
                        self.waiting_id = tab.target_id
                        self.filled = self.submitted = self.confirmed = True
                if origin in self.form_origins and not self.waiting_id and await self.evaluate_form(tab, 'inspect'):
                    from zendriver import cdp
                    index, entries = await tab.send(cdp.page.get_navigation_history())
                    self.history_entry = entries[index].id_
                    self.waiting_id = tab.target_id
                if self.waiting_id and not self.code:
                    value = await tab.evaluate(f"{READ_EMAIL_CODE_SCRIPT}({json.dumps(self.email)})")
                    if isinstance(value, str) and len(value) == 6 and value.isdecimal():
                        self.code = value
                        self.source_id = tab.target_id
                        if tab.target_id == self.waiting_id and self.history_entry is not None:
                            from zendriver import cdp
                            # Restore the exact waiting history entry, including redirect chains.
                            await tab.send(cdp.page.navigate_to_history_entry(self.history_entry))
                            continue
                if tab.target_id == self.waiting_id and origin in self.form_origins and self.code:
                    if not self.filled:
                        self.filled = await self.evaluate_form(tab, 'fill') is True
                    elif not self.submitted:
                        self.confirmed = await self.evaluate_form(tab, 'confirm') is True
                        if self.confirmed:
                            await self.close_source(tabs)
                            self.submitted = await self.evaluate_form(tab, 'submit') is True
                await self.close_source(tabs)
                # An email link may sign in directly in the same browser. The exact original OAuth
                # path and state on an Authorize page confirm that authentication advanced.
                if self.waiting_id and self.state and (origin, parsed.path) in self.authorize_routes:
                    state = (parse_qs(parsed.query).get('state') or [None])[0]
                    if state == self.state and not await self.evaluate_form(tab, 'inspect'):
                        readiness = await tab.evaluate(AUTHORIZE_READINESS_SCRIPT)
                        if readiness and not readiness['focused'] and tab.target_id not in self.activated_authorization:
                            from zendriver import cdp
                            await tab.send(cdp.page.bring_to_front())
                            self.activated_authorization.add(tab.target_id)
                            continue  # The page enables its own button on focus; inspect it next poll.
                        await tab.evaluate(AUTHORIZE_SCRIPT)
            except Exception:  # noqa: BLE001 - closed tab, redirect or changed page
                continue


async def assist_existing(url: str, prefix: str, email: str, port: int) -> int:
    """Apply a corrected automation loop without restarting the current browser or CLI login."""
    import zendriver as zd
    with tempfile.TemporaryDirectory(prefix='agenthydra-signin-assist-') as config_dir:
        browser = await zd.Browser.create(host='127.0.0.1', port=port, user_data_dir=config_dir)
        email_submitter = EmailSubmitter(url, email)
        relay = InboxCodeRelay(url, prefix, email)
        clipboard = ClipboardLinkWatcher()
        deadline = asyncio.get_running_loop().time() + 600
        emit({'attached': True})
        reported_email = False
        try:
            while asyncio.get_running_loop().time() < deadline:
                try:
                    await browser.update_targets()
                except Exception:  # noqa: BLE001 - the original controller closed the popup
                    return 0
                tabs = browser.tabs
                if not tabs:
                    return 0
                if any(callback_code(tab.url or '', prefix, relay.state) for tab in tabs):
                    emit({'complete': True})
                    return 0  # The original controller alone hands the final code to the CLI.
                for tab in tabs:
                    await email_submitter.poll(tab)
                if email_submitter.submitted and not reported_email:
                    emit({'email_submitted': True})
                    reported_email = True
                await relay.poll(tabs)
                await clipboard.poll(browser, relay)
                await asyncio.sleep(0.5)
            return 1
        finally:
            # Browser.stop normally closes Chrome. Close only our CDP connections first, so
            # stop unregisters this borrowed session without touching its owner's window.
            for target in browser.targets:
                try:
                    await target.aclose()
                except Exception:  # noqa: BLE001 - already disconnected
                    pass
            if browser.connection:
                await browser.connection.aclose()
                browser.connection = None
            await browser.stop()


async def main(url: str, prefix: str, headless: bool, email: str | None = None,
               position_file: str | None = None) -> int:
    try:
        import zendriver as zd
    except ImportError:
        emit({"error": "zendriver is not installed (python -m pip install zendriver)"})
        return 2
    browser = None
    position = WindowPosition(position_file, headless)
    try:
        browser = await zd.start(
            headless=headless,
            browser_args=["--window-size=520,780", "--no-first-run", "--no-default-browser-check",
                          *position.launch_args()],
        )
        first_tab = await browser.get(url)
        await position.bind(first_tab)
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
    position_task = asyncio.create_task(position.watch(browser, stop))
    threading.Thread(target=watch_stdin, args=(asyncio.get_running_loop(), stop), daemon=True).start()
    handed_over = False
    email_submitter = EmailSubmitter(url, email)
    inbox_relay = InboxCodeRelay(url, prefix, email)
    clipboard = ClipboardLinkWatcher(enabled=not headless)
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
                    code = callback_code(tab.url or "", prefix, inbox_relay.state)
                    if code:
                        handed_over = True
                        emit({"code": code})
                        break
                    await email_submitter.poll(tab)
                if not handed_over:
                    await inbox_relay.poll(tabs)
                    await clipboard.poll(browser, inbox_relay)
            try:
                await asyncio.wait_for(stop.wait(), 1.0)
            except asyncio.TimeoutError:
                pass
    finally:
        stop.set()
        await position_task
        await position.sample(browser)
        position.save()
        try:
            await browser.stop()
        except Exception:  # noqa: BLE001 - already gone
            pass
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("callback_prefix")
    parser.add_argument("--email")
    parser.add_argument("--position-file")
    parser.add_argument("--assist-port", type=int)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    if args.assist_port:
        if not args.email:
            parser.error('--assist-port requires --email')
        sys.exit(asyncio.run(assist_existing(args.url, args.callback_prefix, args.email, args.assist_port)))
    sys.exit(asyncio.run(main(args.url, args.callback_prefix, args.headless, args.email, args.position_file)))
