"""ChatGPT handles used by the HTTP client."""

from ..errors import ClaudeError
from ..http import valid_uuid
from ..registry import ChatRegistry


class ChatGPTRegistry(ChatRegistry):
    def __init__(self, directory):
        super().__init__(directory / "chats.sqlite3")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS chatgpt_ids (chat_id TEXT PRIMARY KEY, server_id TEXT)"
        )
        self.db.commit()

    def server_id(self, chat_id):
        row = self.db.execute(
            "SELECT server_id FROM chatgpt_ids WHERE chat_id=?", (chat_id,)
        ).fetchone()
        return row[0] if row else None

    def link(self, chat_id, server_id):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO chatgpt_ids VALUES (?,?)",
                (valid_uuid(chat_id), valid_uuid(server_id)),
            )

    def resolve(self, reference, *, allow_unknown=False):
        try:
            reference = valid_uuid(reference)
        except ClaudeError:
            pass
        entries = self.list() if reference == "last" else []
        entry = entries[0] if entries else self.by_name(reference) or self.get(reference)
        if entry is None:
            row = self.db.execute(
                "SELECT chat_id FROM chatgpt_ids WHERE server_id=?", (reference,)
            ).fetchone()
            entry = self.get(row[0]) if row else None
        if entry is None:
            if allow_unknown:
                try:
                    identifier = valid_uuid(reference)
                    return {"chat_id": identifier, "name": None}, identifier
                except ClaudeError:
                    pass
            raise ClaudeError(
                "Unknown ChatGPT handle. Use chats --provider chatgpt to list names and IDs.",
                code="unknown_chat",
            )
        return entry, self.server_id(entry["chat_id"])

    def metadata(self, entry):
        return {
            **{k: v for k, v in entry.items() if k != "organization_id"},
            "server_conversation_id": self.server_id(entry["chat_id"]),
            "checked": False,
            "readable": None,
            "resumable": None,
        }
