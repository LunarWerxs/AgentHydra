"""Quick add submits only the chosen email after the person's human check clears."""

import asyncio
import base64
import importlib.util
import json
import sys
import threading
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.signin_window import (  # noqa: E402
    AUTHORIZE_SCRIPT, EmailSubmitter, InboxCodeRelay, READ_EMAIL_CODE_SCRIPT, WindowPosition, assist_existing, callback_code, main,
)
from lib.signin_clipboard import ClipboardLinkWatcher  # noqa: E402


class SubmitterTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # The relay builds its CDP commands with zendriver, an optional install that CI's runners do
        # not carry; without it the import fails inside the relay's catch-all and these tests saw
        # nothing happen. A stand-in keeps them about the relay, on any machine.
        stand_in = patch.dict(sys.modules, {'zendriver': SimpleNamespace(cdp=MagicMock())})
        stand_in.start()
        self.addCleanup(stand_in.stop)

    async def test_disabled_without_email_or_on_another_origin(self):
        tab = SimpleNamespace(url="https://other.example/login", evaluate=AsyncMock())
        await EmailSubmitter("https://claude.ai/login", "owner@example.com").poll(tab)
        tab.url = "https://claude.ai/login"
        await EmailSubmitter(tab.url, None).poll(tab)
        tab.evaluate.assert_not_awaited()

    async def test_waits_through_redirect_then_stops_after_one_submission(self):
        tab = SimpleNamespace(url="https://claude.ai/login", evaluate=AsyncMock(
            side_effect=[RuntimeError("navigating"), False, True]))
        submitter = EmailSubmitter(tab.url, "owner@example.com")
        for _ in range(5):
            await submitter.poll(tab)
        self.assertTrue(submitter.submitted)
        self.assertEqual(tab.evaluate.await_count, 3)

    async def test_claude_com_oauth_redirect_submits_on_claude_ai_login(self):
        submitter = EmailSubmitter('https://claude.com/cai/oauth/authorize?state=fixture', 'owner@example.com')
        tab = SimpleNamespace(url='https://claude.ai/login', evaluate=AsyncMock(return_value=True))
        await submitter.poll(tab)
        self.assertTrue(submitter.submitted)
        tab.evaluate.assert_awaited_once()

    async def test_provider_redirect_still_rejects_other_hosts_and_plain_http(self):
        for url in ['https://claude.ai.evil.example/login', 'http://claude.ai/login',
                    'https://example.com/login']:
            with self.subTest(url=url):
                tab = SimpleNamespace(url=url, evaluate=AsyncMock())
                await EmailSubmitter('https://claude.com/cai/oauth/authorize', 'owner@example.com').poll(tab)
                tab.evaluate.assert_not_awaited()

    async def test_code_relay_observes_redirected_waiting_form_and_matching_authorize_route(self):
        relay = InboxCodeRelay('https://claude.com/cai/oauth/authorize?state=fixture',
                               'https://platform.claude.com/callback', 'owner@example.com')
        tab = SimpleNamespace(url='https://claude.ai/login', target_id='waiting',
                              evaluate=AsyncMock(side_effect=[True, None]),
                              send=AsyncMock(return_value=(0, [SimpleNamespace(id_=12)])))
        await relay.poll([tab])
        self.assertEqual(relay.waiting_id, 'waiting')
        self.assertIn(('https', 'claude.ai'), relay.form_origins)
        tab.url = 'https://claude.ai/oauth/authorize?state=fixture'
        tab.evaluate = AsyncMock(side_effect=[None, False, {'focused': True, 'disabled': False}, True])
        await relay.poll([tab])
        self.assertEqual(tab.evaluate.await_count, 4)

    async def test_authorization_activates_once_then_waits_for_naturally_enabled_button(self):
        relay = InboxCodeRelay('https://claude.com/cai/oauth/authorize?state=fixture',
                               'https://platform.claude.com/callback', 'owner@example.com')
        tab = SimpleNamespace(url='https://claude.ai/oauth/authorize?state=fixture', target_id='auth',
            evaluate=AsyncMock(side_effect=[True, None, False, {'focused': False, 'disabled': True}]),
            send=AsyncMock())
        await relay.poll([tab])
        tab.send.assert_awaited_once()
        self.assertEqual(relay.activated_authorization, {'auth'})
        self.assertFalse(any(call.args[0] == AUTHORIZE_SCRIPT for call in tab.evaluate.await_args_list))
        tab.evaluate = AsyncMock(side_effect=[None, False, {'focused': True, 'disabled': False}, True])
        await relay.poll([tab])
        self.assertEqual(tab.send.await_count, 1)
        self.assertEqual(tab.evaluate.await_args_list[-1].args[0], AUTHORIZE_SCRIPT)

    def test_final_code_capture_is_unchanged(self):
        prefix = "https://platform.claude.com/oauth/code/callback"
        self.assertEqual(callback_code(prefix + "?code=abc&state=xyz", prefix), "abc#xyz")
        self.assertIsNone(callback_code(prefix + "?code=abc", prefix))
        self.assertIsNone(callback_code(prefix + "?code=abc&state=wrong", prefix, "xyz"))


class WindowPositionTest(unittest.IsolatedAsyncioTestCase):
    async def test_manual_close_keeps_last_normal_position_and_next_launch_restores_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'settings' / 'signin-window-position.json')
            position = WindowPosition(path, False)
            self.assertEqual(position.launch_args(), [])
            tab = SimpleNamespace(get_window=AsyncMock(return_value=(12, SimpleNamespace(
                left=-1200, top=140, window_state='normal'))))
            await position.bind(tab)
            position.remember(SimpleNamespace(left=-960, top=240, window_state='normal'))
            position.remember(SimpleNamespace(left=-32000, top=-32000, window_state='minimized'))
            position.remember(SimpleNamespace(left=0, top=0, window_state='maximized'))
            browser = SimpleNamespace(connection=SimpleNamespace(send=AsyncMock(
                side_effect=RuntimeError('window already closed'))))
            # The manual close has removed the window before the final sample.
            await position.sample(browser)
            position.save()
            reopened = WindowPosition(path, False)
            self.assertEqual(reopened.launch_args(), ['--window-position=-960,240'])
            self.assertEqual(json.loads(Path(path).read_text()), {'left': -960, 'top': 240})
            self.assertEqual(list(Path(path).parent.glob('*.tmp')), [])

    async def test_headless_checks_leave_saved_position_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'position.json'
            path.write_text('{"left": 85, "top": 120}', encoding='utf-8')
            position = WindowPosition(str(path), True)
            self.assertEqual(position.launch_args(), [])
            tab = SimpleNamespace(get_window=AsyncMock())
            await position.bind(tab)
            position.remember(SimpleNamespace(left=0, top=0, window_state='normal'))
            position.save()
            tab.get_window.assert_not_awaited()
            self.assertEqual(json.loads(path.read_text()), {'left': 85, 'top': 120})

    def test_bad_settings_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'position.json'
            for content in ['broken json', 'null', '{"left": true, "top": 12}',
                            '{"left": 12, "top": "wrong"}']:
                with self.subTest(content=content):
                    path.write_text(content, encoding='utf-8')
                    self.assertEqual(WindowPosition(str(path), False).launch_args(), [])


class FixtureHandler(BaseHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except ConnectionResetError:
            # Chromium may cancel a speculative connection when the fixture window closes.
            pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        path = urlparse(self.path).path
        content = ''
        if path == '/oauth/authorize':
            content = '''<p>Check your email: owner@example.com</p>
            <form onsubmit="event.preventDefault(); document.body.innerHTML =
            `<button onclick=&quot;location.href='/callback?code=final-fixture-code&amp;state=fixture-state'&quot;>Authorize</button>`;">
            <input autocomplete="one-time-code" maxlength="6" oninput="document.querySelector('button').disabled = this.value.length !== 6">
            <button type="submit" disabled>Verify email address</button></form>'''
        elif path == '/email-link':
            content = '<h1>Use verification code to continue</h1><p>Enter this verification code where you first tried to sign in</p><div class="text-5xl">123456</div><div><button>Copy code</button><a href="/login">Sign in here instead</a></div>'
        self.wfile.write(('<!doctype html><html><body>' + content + '</body></html>').encode())

    def log_message(self, *_args):
        pass


@unittest.skipUnless(importlib.util.find_spec("zendriver"), "zendriver browser fixture is optional")
class EmailPageTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import zendriver as zd
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.browser = await zd.start(headless=True)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    async def asyncTearDown(self):
        await self.browser.stop()
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close()
        self.thread.join(timeout=2)

    async def test_saved_position_is_restored_by_next_chromium_launch(self):
        import zendriver as zd
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'position.json')
            tab = await self.browser.get(self.base + '/login')
            position = WindowPosition(path, False)
            await position.bind(tab)
            await tab.set_window_size(left=190, top=160, width=520, height=780)
            await position.sample(self.browser)
            position.save()
            self.assertEqual(position.last, {'left': 190, 'top': 160})
            reopened = WindowPosition(path, False)
            browser = await zd.start(headless=True, browser_args=reopened.launch_args())
            try:
                restored_tab = await browser.get(self.base + '/login')
                _, bounds = await restored_tab.get_window()
                self.assertEqual((bounds.left, bounds.top), (190, 160))
            finally:
                await browser.stop()

    async def test_corrected_assistant_disconnects_without_closing_original_popup(self):
        url = self.base + '/oauth/authorize?state=fixture-state'
        original = await self.browser.get(url)
        await self.browser.get(self.base + '/email-link', new_tab=True)
        with patch('lib.signin_window.emit'):
            result = await asyncio.wait_for(assist_existing(url, self.base + '/callback',
                                           'owner@example.com', self.browser.config.port), 10)
        self.assertEqual(result, 0)
        self.assertFalse(self.browser.stopped)
        await self.browser.update_targets()
        self.assertEqual(callback_code(original.url, self.base + '/callback', 'fixture-state'),
                         'final-fixture-code#fixture-state')
        self.assertEqual(await original.evaluate('1 + 1'), 2)

    async def test_clipboard_link_opens_tab_and_continues_through_oauth(self):
        url = self.base + '/oauth/authorize?state=fixture-state'
        tab = await self.browser.get(url)
        relay = InboxCodeRelay(url, self.base + '/callback', 'owner@example.com')
        encoded = base64.b64encode(b'owner@example.com').decode()
        copied_link = 'https://claude.ai/magic-link#' + 'a' * 32 + ':' + encoded
        watcher = ClipboardLinkWatcher(reader=lambda: copied_link)

        async def open_fixture(_url, new_tab):
            # Keep the test entirely on loopback; exercise Chromium's real new-tab navigation.
            return await self.browser.get(self.base + '/email-link', new_tab=new_tab)

        with patch.object(tab, 'get', AsyncMock(side_effect=open_fixture)) as opened:
            for _ in range(30):
                await self.browser.update_targets()
                await relay.poll(self.browser.tabs)
                await watcher.poll(self.browser, relay)
                if callback_code(tab.url, self.base + '/callback', 'fixture-state'):
                    break
                await asyncio.sleep(0.1)
            opened.assert_awaited_once_with(copied_link, new_tab=True)
        self.assertEqual(callback_code(tab.url, self.base + '/callback', 'fixture-state'),
                         'final-fixture-code#fixture-state')
        self.assertTrue(relay.source_closed)

    async def test_clipboard_code_continues_through_oauth_without_source_tab(self):
        url = self.base + '/oauth/authorize?state=fixture-state'
        tab = await self.browser.get(url)
        relay = InboxCodeRelay(url, self.base + '/callback', 'owner@example.com')
        watcher = ClipboardLinkWatcher(reader=lambda: '123456')
        with patch.object(tab, 'get', wraps=tab.get) as opened:
            for _ in range(30):
                await self.browser.update_targets()
                await relay.poll(self.browser.tabs)
                await watcher.poll(self.browser, relay)
                if callback_code(tab.url, self.base + '/callback', 'fixture-state'):
                    break
                await asyncio.sleep(0.1)
            opened.assert_not_called()
        self.assertEqual(callback_code(tab.url, self.base + '/callback', 'fixture-state'),
                         'final-fixture-code#fixture-state')
        self.assertTrue(relay.confirmed)
        self.assertTrue(relay.submitted)

    async def test_link_code_guards_in_real_browser(self):
        tab = await self.browser.get(self.base + '/email-link')
        fixtures = [
            ('<p>Verification code</p><input readonly value="123456"><button>Copy code</button>', '123456'),
            ('<p>Verification code</p><input disabled value="123456"><button>Copy code</button>', '123456'),
            ('<p>Verification code</p><div><span>123456</span><button>Copy</button></div>', '123456'),
            ('<h1>Use verification code to continue</h1><div class="text-5xl">123456</div><div><button>Copy code</button></div>', '123456'),
            ('<p>Verification code</p><input value="123456"><button>Continue</button>', None),
            ('<p>Code for another@example.com</p><code>123456</code><button>Copy</button>', None),
            ('<p>Verification code</p><code>123456</code><code>654321</code><button>Copy</button>', None),
            ('<p>OAuth code</p><code>long-code#state</code><button>Copy</button>', None),
        ]
        for fixture, expected in fixtures:
            with self.subTest(fixture=fixture):
                await tab.evaluate(f"document.body.innerHTML = {json.dumps(fixture)}")
                self.assertEqual(await tab.evaluate(f'{READ_EMAIL_CODE_SCRIPT}("owner@example.com")'), expected)

    async def test_same_tab_and_new_tab_relay_reach_only_matching_oauth_callback(self):
        for new_tab in [False, True]:
            with self.subTest(new_tab=new_tab):
                url = self.base + '/oauth/authorize?state=fixture-state'
                tab = await self.browser.get(url, new_tab=True)
                relay = InboxCodeRelay(url, self.base + '/callback', 'owner@example.com')
                await relay.poll([tab])
                self.assertEqual(relay.waiting_id, tab.target_id)
                source = await tab.get(self.base + '/email-link', new_tab=new_tab)
                targets = [tab, source] if new_tab else [tab]
                for _ in range(30):
                    await self.browser.update_targets()
                    await relay.poll(targets)
                    if callback_code(tab.url, self.base + '/callback', 'fixture-state'):
                        break
                    await asyncio.sleep(0.1)
                self.assertEqual(callback_code(tab.url, self.base + '/callback', 'fixture-state'),
                                 'final-fixture-code#fixture-state')
                self.assertTrue(relay.filled)
                self.assertTrue(relay.submitted)
                self.assertTrue(relay.confirmed)
                self.assertTrue(relay.source_closed)
                await tab.close()

    async def test_rejected_code_does_not_authorize_and_wrong_oauth_state_is_ignored(self):
        url = self.base + '/oauth/authorize?state=fixture-state'
        tab = await self.browser.get(url)
        relay = InboxCodeRelay(url, self.base + '/callback', 'owner@example.com')
        await relay.poll([tab])
        source = await self.browser.get(self.base + '/email-link', new_tab=True)
        await tab.evaluate("document.querySelector('form').onsubmit = e => {e.preventDefault(); window.rejected = true;}")
        for _ in range(5):
            await relay.poll([tab, source])
        self.assertTrue(await tab.evaluate('window.rejected === true'))
        self.assertIn('/oauth/authorize', tab.url)
        await tab.evaluate("history.replaceState(null, '', '/oauth/authorize?state=another-state'); "
                           "document.body.innerHTML = '<button onclick=\"window.authorized=true\">Authorize</button>'")
        await self.browser.update_targets()
        await relay.poll([tab])
        self.assertFalse(await tab.evaluate('window.authorized === true'))

    async def test_main_hands_off_final_code_then_closes_throwaway_browser(self):
        import zendriver as zd
        finished = threading.Event()
        messages = []
        tasks = []
        loop = asyncio.get_running_loop()

        def watch(_loop, stop):
            finished.wait(15)
            loop.call_soon_threadsafe(stop.set)

        async def open_email_link():
            # Simulate the person receiving their email after the waiting form was observed.
            await asyncio.sleep(1.2)
            await self.browser.get(self.base + '/email-link', new_tab=True)

        def capture(message):
            messages.append(message)
            if message.get('ready'):
                tasks.append(asyncio.create_task(open_email_link()))
            if message.get('code'):
                finished.set()

        try:
            with patch.object(zd, 'start', AsyncMock(return_value=self.browser)), \
                    patch('lib.signin_window.watch_stdin', watch), patch('lib.signin_window.emit', capture):
                await asyncio.wait_for(main(self.base + '/oauth/authorize?state=fixture-state',
                                            self.base + '/callback', True, 'owner@example.com'), 12)
            self.assertEqual(messages, [{'ready': True}, {'code': 'final-fixture-code#fixture-state'}])
            self.assertTrue(self.browser.stopped)
        finally:
            finished.set()
            if tasks:
                await asyncio.gather(*tasks)

    async def test_real_browser_waits_for_human_check_and_clicks_only_email_step(self):
        browser = self.browser
        url = self.base + '/login'
        tab = await browser.get(url)
        email = '<input type="email" value="owner@example.com">'
        button = '<button type="submit" onclick="window.clicks++">Continue with email</button>'
        form = lambda content: '<form onsubmit="event.preventDefault()">' + content + '</form>'

        async def load(content):
            await tab.evaluate(f"document.body.innerHTML = {json.dumps(content)}; "
                               "window.clicks = 0; delete window.__agentHydraEmailSubmitted;")

        cases = [
            ("ready email", email + button, 1),
            ("wrong email", email.replace("owner@", "another@") + button, 0),
            ("blank email", email.replace("owner@example.com", "") + button, 0),
            ("disabled button", email + button.replace('type="submit"', 'type="submit" disabled'), 0),
            ("aria disabled", email + button.replace('type="submit"', 'type="submit" aria-disabled="true"'), 0),
            ("pending challenge", email + '<input name="cf-turnstile-response" type="hidden" value="">' + button, 0),
            ("challenge widget only", email + '<div class="cf-turnstile"></div>' + button, 0),
            ("verified challenge", email + '<input name="cf-turnstile-response" type="hidden" value="fixture-human-response">' + button, 1),
            ("inbox code step", email + '<input autocomplete="one-time-code">' + button, 0),
            ("password step", email + '<input type="password">' + button, 0),
            ("authorize step", email + button.replace("Continue with email", "Authorize"), 0),
            ("hidden email", email.replace('<input ', '<input style="display:none" ') + button, 0),
            ("ambiguous buttons", email + button + button, 0),
        ]
        for name, content, expected in cases:
            with self.subTest(name=name):
                await load(form(content))
                submitter = EmailSubmitter(url, "owner@example.com")
                await submitter.poll(tab)
                await submitter.poll(tab)
                self.assertEqual(await tab.evaluate("window.clicks"), expected)

        # The same poller waits while the person verifies, then submits when the token and
        # button become ready. Even a lost response / replacement poller cannot double-click.
        await load(form(email + '<input name="cf-turnstile-response" type="hidden">' +
                        button.replace('type="submit"', 'type="submit" disabled')))
        submitter = EmailSubmitter(url, "owner@example.com")
        await submitter.poll(tab)
        self.assertEqual(await tab.evaluate("window.clicks"), 0)
        await tab.evaluate("document.querySelector('[name=cf-turnstile-response]').value = 'fixture-human-response'; "
                           "document.querySelector('button').disabled = false;")
        await submitter.poll(tab)
        await EmailSubmitter(url, "owner@example.com").poll(tab)
        self.assertEqual(await tab.evaluate("window.clicks"), 1)


if __name__ == "__main__":
    unittest.main()
