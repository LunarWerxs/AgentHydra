"""No-network check: browser cookies survive the saved-login shape into the HTTP client's jar."""

import time
import unittest

from claudfree import signin
from claudfree.http import ClaudeHttp
from claudfree.state import filter_state
from zendriver.cdp.network import Cookie


def cookie(name, domain, *, expires, session=False, same_site="Lax"):
    return Cookie.from_json(
        {
            "name": name,
            "value": "example-value",
            "domain": domain,
            "path": "/",
            "size": 10,
            "httpOnly": True,
            "secure": True,
            "session": session,
            "expires": expires,
            "sameSite": same_site,
            "priority": "Medium",
            "sourceScheme": "Secure",
            "sourcePort": 443,
        }
    )


class SigninCookieTests(unittest.TestCase):
    def test_saved_login_reaches_http_jar_without_expired_or_foreign_cookies(self):
        now = time.time()
        cookies = [
            cookie("sessionKey", "claude.ai", expires=now + 3600),
            cookie("sessionOnly", ".claude.ai", expires=-1, session=True, same_site="Strict"),
            cookie("stale", "claude.ai", expires=now - 3600),
            cookie("foreign", "example.test", expires=now + 3600),
        ]
        saved = [signin.to_saved(c) for c in cookies]
        self.assertEqual(saved[1]["expires"], -1.0)
        self.assertEqual(saved[1]["sameSite"], "Strict")
        client = ClaudeHttp(filter_state({"cookies": saved, "origins": []}))
        try:
            jar = {(c.name, c.domain) for c in client.session.cookies}
        finally:
            client.close()
        self.assertEqual(jar, {("sessionKey", "claude.ai"), ("sessionOnly", ".claude.ai")})


if __name__ == "__main__":
    unittest.main()
