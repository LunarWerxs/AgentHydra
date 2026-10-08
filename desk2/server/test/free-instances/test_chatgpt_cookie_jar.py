"""No-network check that a ChatGPT login's cookie jar stays small however many Temporary Chats it made."""

import time
import unittest
from uuid import uuid4

from claudfree.chatgpt.http import PER_CHAT_COOKIES_KEPT, ChatGPTHttp


def cookie(name, expires, value="v"):
    return {"name": name, "value": value, "domain": ".chatgpt.com", "path": "/", "expires": expires}


class ChatGPTCookieJarTests(unittest.TestCase):
    def test_a_jar_from_hundreds_of_chats_loads_and_saves_only_the_newest_per_chat_cookies(self):
        # 2026-10-07: ~370 chats left ~760 per-chat cookies (~62 KB) and ChatGPT refused every request.
        now = time.time()
        chats = [(uuid4(), now + 86_400 + i) for i in range(400)]
        saved = {
            "cookies": [cookie("__Secure-next-auth.session-token", now + 86_400 * 30, "session")]
            + [cookie(f"conv_key_{chat}", at) for chat, at in chats]
            + [cookie(f"history_off_{chat}", at) for chat, at in chats],
            "origins": [],
        }
        http = ChatGPTHttp(saved)
        sent = {c.name for c in http.session.cookies}
        self.assertIn("__Secure-next-auth.session-token", sent)
        newest = {str(chat) for chat, _ in chats[-PER_CHAT_COOKIES_KEPT:]}
        self.assertEqual({n.split("_", 2)[-1] for n in sent if n.startswith("conv_key_")}, newest)
        self.assertEqual({n.split("_", 2)[-1] for n in sent if n.startswith("history_off_")}, newest)
        written = [c["name"] for c in http.saved_state()["cookies"]]
        self.assertEqual(len(written), 1 + 2 * PER_CHAT_COOKIES_KEPT)
        http.close()


if __name__ == "__main__":
    unittest.main()
