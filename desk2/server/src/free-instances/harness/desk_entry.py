"""Desk boundary: one JSON result, including manual login. No raw browser logs."""
import asyncio
from contextlib import redirect_stdout
import io
import json
import sys

from claudfree.cli import main, parse_args
from claudfree.errors import ClaudeError


def run():
    try:
        args = parse_args()
    except ClaudeError as error:
        print(json.dumps({"ok": False, "error": error.as_dict()}))
        return 1
    if args.command != "login":
        return main()
    try:
        with redirect_stdout(io.StringIO()):
            if args.provider == "chatgpt":
                from claudfree.chatgpt.login import login
                from claudfree.chatgpt.state import ChatGPTState
                from claudfree import ChatGPTClient
                asyncio.run(login(ChatGPTState(), timeout=args.timeout))
                result = ChatGPTClient().auth()
            else:
                from claudfree.browser import run_browser
                from claudfree import Client
                asyncio.run(run_browser(args))
                result = Client().auth()
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ClaudeError as error:
        print(json.dumps({"ok": False, "error": error.as_dict()}))
        return 1
    except Exception:
        print(json.dumps({"ok": False, "error": {"code": "login_failed", "message": "Sign-in was not completed. Try Sign in again."}}))
        return 1


if __name__ == "__main__":
    sys.exit(run())
