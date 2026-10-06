"""ChatGPT command routing, separate from the backwards-compatible Claude default."""

import asyncio
import json
import sys

from ..errors import ClaudeError
from ..mcp_server import configuration
from ..registry import chat_lock
from ..results import emit
from .api import ChatGPTClient


def run(args):
    client = ChatGPTClient(
        timeout=args.request_timeout,
        auto_prepare=not args.no_auto_prepare,
    )
    if args.command == "schema":
        print(json.dumps(client.schema(), indent=2))
    elif args.command == "mcp-config":
        print(json.dumps(configuration("chatgpt"), indent=2))
    elif args.command == "mcp":
        from .mcp import build_server

        build_server(client).run(transport="stdio")
    elif args.command in {"prepare", "prepared"}:
        if args.command == "prepare":
            print(
                "Preparing single-use verification with JavaScript; no browser will open.",
                file=sys.stderr,
            )
            result = client.prepare(args.count if args.count is not None else 3)
        else:
            result = client.preparation_status()
        print(
            json.dumps(result)
            if args.json_output
            else f"Ready for {result['ready_messages']} HTTP messages; next local expiry in {result['next_expires_in_seconds']} seconds."
        )
    elif args.command == "login":
        from .. import signin

        print("Opening ChatGPT for manual sign-in.", file=sys.stderr)
        with chat_lock(client._state.directory / "locks", "session", wait=args.timeout):
            from .preparation import Preparations

            Preparations(client._state.directory).clear()
            asyncio.run(signin.login_chatgpt(client._state, timeout=args.timeout))
        print(
            "ChatGPT login verified and saved with Windows encryption. Use chat --provider chatgpt --prompt TEXT."
        )
    elif args.command == "forget":
        with chat_lock(
            client._state.directory / "locks", "session", wait=args.request_timeout + 90
        ):
            from .preparation import Preparations

            Preparations(client._state.directory).clear()
            client._state.session_file.unlink(missing_ok=True)
        print("ChatGPT saved login removed.")
    elif args.command == "doctor":
        print("Provider: ChatGPT")
        print(
            "Saved encrypted login: "
            + ("present" if client._state.session_file.exists() else "missing")
        )
    elif args.command in {"auth", "usage", "chats", "read", "track", "chat", "resume"}:
        if args.stdin_prompt:
            args.prompt = sys.stdin.read()
        result = client._run(args)
        if args.command == "auth" and not args.json_output:
            print("ChatGPT login verified via HTTP.")
        else:
            emit(args, result)
    else:
        raise ClaudeError(
            "For ChatGPT use login, prepare, prepared, chat, resume, read, chats, track, usage, forget, doctor, schema, mcp or mcp-config with --provider chatgpt.",
            code="invalid_arguments",
        )
