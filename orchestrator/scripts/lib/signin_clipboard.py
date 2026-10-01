"""Read a copied code or Claude magic link while Quick add waits for its email code."""

import base64
import binascii
import re
import sys
from urllib.parse import urlparse


def read_clipboard_text() -> str | None:
    if sys.platform != 'win32':
        return None
    import ctypes
    from ctypes import wintypes

    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    user.OpenClipboard.argtypes = [wintypes.HWND]
    user.OpenClipboard.restype = wintypes.BOOL
    user.CloseClipboard.restype = wintypes.BOOL
    user.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
    user.IsClipboardFormatAvailable.restype = wintypes.BOOL
    user.GetClipboardData.argtypes = [wintypes.UINT]
    user.GetClipboardData.restype = wintypes.HANDLE
    kernel.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel.GlobalLock.restype = ctypes.c_void_p
    kernel.GlobalUnlock.argtypes = [wintypes.HANDLE]
    kernel.GlobalSize.argtypes = [wintypes.HANDLE]
    kernel.GlobalSize.restype = ctypes.c_size_t
    if not user.OpenClipboard(None):
        return None  # Another application owns it briefly; the next poll can read it.
    try:
        if not user.IsClipboardFormatAvailable(13):  # CF_UNICODETEXT
            return None
        handle = user.GetClipboardData(13)
        if not handle:
            return None
        size = kernel.GlobalSize(handle)
        if not size or size > 16_384:
            return None
        pointer = kernel.GlobalLock(handle)
        if not pointer:
            return None
        try:
            return ctypes.wstring_at(pointer, size // ctypes.sizeof(ctypes.c_wchar)).split('\0', 1)[0]
        finally:
            kernel.GlobalUnlock(handle)
    finally:
        user.CloseClipboard()


def magic_link(text: str | None, email: str) -> str | None:
    if not text or len(text) > 8192:
        return None
    text = text.strip()
    try:
        parsed = urlparse(text)
        if (parsed.scheme != 'https' or parsed.hostname != 'claude.ai' or
                parsed.path != '/magic-link' or parsed.username or parsed.password or
                parsed.port not in (None, 443)):
            return None
        token, encoded = parsed.fragment.split(':', 1)
        if not re.fullmatch(r'[a-fA-F0-9]{32,128}', token):
            return None
        decoded = base64.b64decode(encoded + '=' * (-len(encoded) % 4),
                                   altchars=b'-_', validate=True).decode('utf-8')
        return text if decoded.casefold() == email.casefold() else None
    except (ValueError, UnicodeError, binascii.Error):
        return None


class ClipboardLinkWatcher:
    def __init__(self, enabled: bool = True, reader=read_clipboard_text):
        self.enabled = enabled
        self.reader = reader
        self.opened = set()

    async def poll(self, browser, relay) -> None:
        if not self.enabled or not relay.waiting_id or relay.code or relay.filled or relay.submitted:
            return
        waiting = next((tab for tab in browser.tabs if tab.target_id == relay.waiting_id), None)
        if waiting is None:
            return
        parsed = urlparse(waiting.url or '')
        if (parsed.scheme, parsed.netloc.lower()) not in relay.form_origins:
            return
        try:
            if not await relay.evaluate_form(waiting, 'inspect'):
                return
            text = self.reader()
            if text and re.fullmatch(r'[0-9]{6}', text.strip()):
                relay.code = text.strip()
                return
            link = magic_link(text, relay.email)
            if not link or link in self.opened:
                return
            self.opened.add(link)  # A navigation with an unknown outcome must not open twice.
            await waiting.get(link, new_tab=True)  # Same popup window, preserving the waiting form.
        except Exception:  # noqa: BLE001 - closed tab or temporary clipboard/navigation failure
            pass
