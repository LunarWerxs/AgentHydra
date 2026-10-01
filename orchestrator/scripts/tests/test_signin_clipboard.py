import base64
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.signin_clipboard import ClipboardLinkWatcher, magic_link  # noqa: E402


def link(email='owner@example.com'):
    encoded = base64.b64encode(email.encode()).decode()
    return 'https://claude.ai/magic-link#' + 'a' * 32 + ':' + encoded


class ClipboardTest(unittest.IsolatedAsyncioTestCase):
    def test_only_exact_provider_link_for_waiting_account_is_accepted(self):
        expected = link()
        self.assertEqual(magic_link('  ' + expected + '  ', 'owner@example.com'), expected)
        for candidate in [link('another@example.com'), expected.replace('https:', 'http:'),
                          expected.replace('claude.ai/', 'claude.ai.evil.example/'),
                          expected.replace('claude.ai/', 'claude.ai:8080/'),
                          expected.replace('/magic-link', '/other'), 'ordinary clipboard text']:
            with self.subTest(candidate=candidate):
                self.assertIsNone(magic_link(candidate, 'owner@example.com'))

    async def test_read_only_during_code_step_and_open_matching_link_once(self):
        reader = Mock(return_value=link())
        watcher = ClipboardLinkWatcher(reader=reader)
        tab = SimpleNamespace(target_id='waiting', url='https://claude.ai/login', get=AsyncMock())
        browser = SimpleNamespace(tabs=[tab])
        relay = SimpleNamespace(waiting_id=None, code=None, filled=False, submitted=False,
            email='owner@example.com', form_origins={('https', 'claude.ai')}, evaluate_form=AsyncMock(return_value=True))
        await watcher.poll(browser, relay)
        reader.assert_not_called()
        relay.waiting_id = 'waiting'
        relay.evaluate_form.return_value = False
        await watcher.poll(browser, relay)
        reader.assert_not_called()
        relay.evaluate_form.return_value = True
        await watcher.poll(browser, relay)
        await watcher.poll(browser, relay)
        tab.get.assert_awaited_once_with(link(), new_tab=True)
        count = reader.call_count
        relay.filled = True
        await watcher.poll(browser, relay)
        self.assertEqual(reader.call_count, count)

    async def test_headless_checks_do_not_read_clipboard(self):
        reader = Mock()
        await ClipboardLinkWatcher(enabled=False, reader=reader).poll(None, None)
        reader.assert_not_called()

    async def test_copied_code_uses_existing_relay_without_opening_tab(self):
        reader = Mock(return_value=' 123456\n')
        tab = SimpleNamespace(target_id='waiting', url='https://claude.ai/login', get=AsyncMock())
        browser = SimpleNamespace(tabs=[tab])
        relay = SimpleNamespace(waiting_id='waiting', code=None, filled=False, submitted=False,
            email='owner@example.com', form_origins={('https', 'claude.ai')}, evaluate_form=AsyncMock(return_value=True))
        watcher = ClipboardLinkWatcher(reader=reader)
        await watcher.poll(browser, relay)
        self.assertEqual(relay.code, '123456')
        await watcher.poll(browser, relay)
        reader.assert_called_once()
        tab.get.assert_not_awaited()

    async def test_visible_tab_code_keeps_clipboard_as_alternative(self):
        reader = Mock(return_value=link())
        relay = SimpleNamespace(waiting_id='waiting', code='123456', filled=False, submitted=False)
        await ClipboardLinkWatcher(reader=reader).poll(None, relay)
        reader.assert_not_called()
