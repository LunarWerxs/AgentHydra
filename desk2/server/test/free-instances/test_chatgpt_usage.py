"""No-network checks for the verified text policy and fixed private-chat model."""

import json
import unittest
from unittest.mock import Mock

from claudfree.chatgpt.http import ChatGPTHttp, TEXT_MODEL, TEXT_MODEL_NAME
from claudfree.errors import ClaudeError


def account(plan, **extra):
    return {"account": {"plan_type": plan, "email": "example@example.test"}, **extra}


def model(**extra):
    return {"slug": TEXT_MODEL, "title": TEXT_MODEL_NAME, "reasoning_type": "none", **extra}


def usage(accounts, models):
    http = object.__new__(ChatGPTHttp)
    http._json = Mock(side_effect=[{"accounts": accounts}, {"models": models}])
    result = http.usage()
    assert all(call.args[0] == "GET" for call in http._json.call_args_list)
    return result


class ChatGPTUsageTests(unittest.TestCase):
    def test_verified_free_instant_is_unlimited_text_without_a_numeric_quota(self):
        result = usage({"personal": account("free")}, [model()])
        self.assertTrue(result["available"])
        self.assertTrue(result["unlimited_text"])
        self.assertEqual(result["model_slug"], TEXT_MODEL)
        self.assertIsNone(result["exact_remaining_messages"])
        self.assertEqual(result["windows"], [])
        self.assertIsNotNone(result["observed_at"])
        self.assertIn("separate limits", result["note"])
        self.assertNotIn("example@example.test", json.dumps(result))

    def test_ambiguous_or_unverified_access_stays_unknown(self):
        cases = [
            ({}, [model()]),
            ({"paid": account("plus")}, [model()]),
            ({"personal": account("free"), "workspace": account("team")}, [model()]),
            ({"personal": account("free"), "malformed": {}}, [model()]),
            ({"personal": account("free")}, []),
            ({"personal": account("free")}, [model(title="Another model")]),
            ({"personal": account("free")}, [model(reasoning_type="reasoning")]),
        ]
        for accounts, models in cases:
            with self.subTest(accounts=accounts, models=models):
                result = usage(accounts, models)
                self.assertFalse(result["available"])
                self.assertFalse(result["unlimited_text"])
                self.assertIsNone(result["exact_remaining_messages"])

    def test_inaccessible_workspace_does_not_describe_the_current_login(self):
        result = usage({"personal": account("free"), "workspace": account("team", can_access_with_session=False)}, [model()])
        self.assertTrue(result["unlimited_text"])

    def test_http_failure_is_not_converted_to_unlimited(self):
        http = object.__new__(ChatGPTHttp)
        http._json = Mock(side_effect=ClaudeError("Fixture access failure", code="login_required"))
        with self.assertRaises(ClaudeError):
            http.usage()
        self.assertEqual(http._json.call_count, 1)

    def test_new_and_resumed_messages_use_only_luna_and_remain_temporary(self):
        chat = "11111111-2222-4333-8444-555555555555"
        parent = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        existing = {"conversation_id": chat, "current_node": parent, "is_temporary_chat": True,
                    "mapping": {parent: {"parent": None, "message": None}}}
        for body in (None, existing):
            with self.subTest(resuming=body is not None):
                http = object.__new__(ChatGPTHttp)
                http.preparations = None
                http._request = Mock(side_effect=ClaudeError("Stop before fixture transmission", code="fixture"))
                with self.assertRaises(ClaudeError):
                    http.send("Synthetic smoke message", existing=body)
                self.assertEqual(http._request.call_count, 1)
                request = http._request.call_args
                self.assertEqual(request.args, ("POST", "/backend-api/f/conversation"))
                self.assertEqual(request.kwargs["json"]["model"], TEXT_MODEL)
                self.assertTrue(request.kwargs["json"]["history_and_training_disabled"])
                if body:
                    self.assertEqual(request.kwargs["json"]["conversation_id"], chat)
                    self.assertNotIn("temporary_chat_requests_personalization", request.kwargs["json"])
                else:
                    self.assertFalse(request.kwargs["json"]["temporary_chat_requests_personalization"])


if __name__ == "__main__":
    unittest.main()
