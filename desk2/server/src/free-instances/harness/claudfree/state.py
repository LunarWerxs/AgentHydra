"""Windows-encrypted login state and atomic local persistence."""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile
from typing import Any
from urllib.parse import urlsplit

from .errors import ClaudeError as UserError

# Never beside the code: this copy sits in a public repo, and its logins must not (owner, 2026-10-06).
# Desk passes CLAUDFREE_STATE_DIR on every run; a run without it keeps its state in the user's profile.
DEFAULT_STATE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "ClaudFree" / ".state"
STATE_DIR = Path(os.environ.get("CLAUDFREE_STATE_DIR", DEFAULT_STATE)).expanduser().resolve()
SESSION_FILE = STATE_DIR / "session.dpapi"
HTTP_CONFIG_FILE = STATE_DIR / "http-config.json"
BROWSER_RUNTIME_FILE = STATE_DIR / "browser-runtime.json"
REQUEST_FILE = STATE_DIR / "requests.json"
MAGIC = b"CLAUDFREE-DPAPI-1\x00"


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def dpapi(data: bytes, *, decrypt: bool = False) -> bytes:
    """Use current-user Windows DPAPI; never write unencrypted state to disk."""
    if os.name != "nt":
        raise UserError("Session encryption requires Windows.")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    protect = crypt32.CryptProtectData
    protect.argtypes = [
        ctypes.POINTER(DataBlob),
        wintypes.LPCWSTR,
        ctypes.POINTER(DataBlob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ]
    protect.restype = wintypes.BOOL
    unprotect = crypt32.CryptUnprotectData
    unprotect.argtypes = [
        ctypes.POINTER(DataBlob),
        ctypes.c_void_p,
        ctypes.POINTER(DataBlob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ]
    unprotect.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(data)
    source = DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = DataBlob()
    # CRYPTPROTECT_UI_FORBIDDEN. No machine-wide scope: this Windows user only.
    if decrypt:
        success = unprotect(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    else:
        success = protect(
            ctypes.byref(source),
            "ClaudFree Claude web session",
            None,
            None,
            None,
            1,
            ctypes.byref(result),
        )
    if not success:
        raise UserError(
            "Windows could not decrypt the saved session."
            if decrypt
            else "Windows could not encrypt the session."
        )
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(result.pbData, ctypes.c_void_p))


def claude_domain(domain: str) -> bool:
    domain = domain.lstrip(".").lower()
    return domain == "claude.ai" or domain.endswith(".claude.ai")


def filter_state(state: dict[str, Any]) -> dict[str, Any]:
    """Exclude Google/OAuth-provider state from the saved login."""
    return {
        "cookies": [c for c in state.get("cookies", []) if claude_domain(c.get("domain", ""))],
        "origins": [
            o
            for o in state.get("origins", [])
            if urlsplit(o.get("origin", "")).scheme == "https"
            and claude_domain(urlsplit(o.get("origin", "")).hostname or "")
        ],
    }


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".claudfree-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def save_session(state: dict[str, Any], path: Path | None = None) -> None:
    path = path or SESSION_FILE
    raw = json.dumps(filter_state(state), ensure_ascii=False).encode("utf-8")
    atomic_write(path, MAGIC + dpapi(raw))


def load_session(path: Path | None = None) -> dict[str, Any] | None:
    path = path or SESSION_FILE
    if not path.exists():
        return None
    data = path.read_bytes()
    if not data.startswith(MAGIC):
        raise UserError(
            "Unrecognized session file. Run 'python claudfree.py forget' and log in again."
        )
    try:
        return filter_state(json.loads(dpapi(data[len(MAGIC) :], decrypt=True)))
    except (ValueError, TypeError, AttributeError):
        raise UserError(
            "Invalid saved session. Run 'python claudfree.py forget' and log in again."
        ) from None


class StateStore:
    """Per-client paths without mutating process-wide configuration."""

    def __init__(self, directory: str | Path):
        self.directory = Path(directory).expanduser().resolve()
        self.HTTP_CONFIG_FILE = self.directory / "http-config.json"
        self.session_file = self.directory / "session.dpapi"

    atomic_write = staticmethod(atomic_write)

    def load_session(self):
        return load_session(self.session_file)

    def save_session(self, value):
        save_session(value, self.session_file)
