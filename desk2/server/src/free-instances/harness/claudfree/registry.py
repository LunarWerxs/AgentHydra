"""Local chat metadata and OS-backed locks. Never stores prompts or credentials."""

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import re
import sqlite3
import time
from uuid import UUID

from .errors import ClaudeError


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def valid_name(name: str) -> str:
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", name) or name.lower() == "last":
        raise ClaudeError(
            "Chat names must start with a letter and contain up to 64 letters, numbers, underscores or hyphens; 'last' is reserved.",
            code="invalid_chat_name",
        )
    try:
        UUID(name)
    except ValueError:
        return name.lower()
    raise ClaudeError("A chat name cannot be a UUID.", code="invalid_chat_name")


@contextmanager
def chat_lock(folder: Path, key: str, *, wait: float = 0):
    """Fail immediately on an overlapping operation. Crashes release the OS lock."""
    folder.mkdir(parents=True, exist_ok=True)
    # Keys are UUIDs or validated names, never path fragments from free text.
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", key):
        raise ClaudeError("Invalid lock identifier.", code="invalid_chat_id")
    path = folder / (key + ".lock")
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        import os

        deadline = time.monotonic() + wait
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise ClaudeError(
                        "Another operation is using this chat or name. Wait for it to finish.",
                        code="chat_busy",
                        retryable=True,
                    ) from None
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class ChatRegistry:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS chats (
            chat_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
            name TEXT UNIQUE COLLATE NOCASE, model TEXT,
            is_temporary INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'known'
        )""")
        self.db.commit()

    def close(self):
        self.db.close()

    def get(self, chat_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM chats WHERE chat_id=?", (chat_id,)).fetchone()
        return self._row(row) if row else None

    def by_name(self, name: str) -> dict | None:
        row = self.db.execute("SELECT * FROM chats WHERE name=? COLLATE NOCASE", (name,)).fetchone()
        return self._row(row) if row else None

    def list(self) -> list[dict]:
        return [
            self._row(row)
            for row in self.db.execute("SELECT * FROM chats ORDER BY last_used_at DESC,chat_id")
        ]

    @staticmethod
    def _row(row) -> dict:
        result = dict(row)
        if result["is_temporary"] is not None:
            result["is_temporary"] = bool(result["is_temporary"])
        return result

    def record(
        self,
        chat_id: str,
        org: str,
        *,
        name: str | None = None,
        model: str | None = None,
        temporary: bool | None = None,
        status: str = "available",
        touch: bool = True,
    ) -> dict:
        timestamp = now()
        if name:
            name = valid_name(name)
        try:
            with self.db:
                self.db.execute(
                    """INSERT INTO chats
                    (chat_id,organization_id,name,model,is_temporary,created_at,updated_at,last_used_at,status)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(chat_id) DO UPDATE SET
                    organization_id=excluded.organization_id,
                    name=COALESCE(excluded.name,chats.name),
                    model=COALESCE(excluded.model,chats.model),
                    is_temporary=COALESCE(excluded.is_temporary,chats.is_temporary),
                    updated_at=excluded.updated_at,
                    last_used_at=CASE WHEN ? THEN excluded.last_used_at ELSE chats.last_used_at END,
                    status=excluded.status""",
                    (
                        chat_id,
                        org,
                        name,
                        model,
                        temporary,
                        timestamp,
                        timestamp,
                        timestamp,
                        status,
                        touch,
                    ),
                )
        except sqlite3.IntegrityError:
            raise ClaudeError(
                "That local name already identifies another chat. Choose another name or resume the existing one.",
                code="name_conflict",
            ) from None
        return self.get(chat_id)

    def status(self, chat_id: str, status: str):
        with self.db:
            self.db.execute(
                "UPDATE chats SET status=?,updated_at=? WHERE chat_id=?", (status, now(), chat_id)
            )
