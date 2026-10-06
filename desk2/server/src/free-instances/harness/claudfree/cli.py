"""ClaudFree command-line interface. HTTP commands do not load browser packages."""

import argparse
import asyncio
import json
import sys
from .errors import ClaudeError
from .errors import ClaudeError as UserError
from . import state


def run_http(args):
    # Browser and MCP extras are optional: an HTTP command only imports its own path.
    from .api import Client
    from .results import emit

    if args.stdin_prompt:
        # Read verbatim so multiline prompts reach the API without shell quoting.
        args.prompt = sys.stdin.read()
    on_text = (lambda text: print(text, end="", flush=True)) if args.stream else None
    emit(args, Client()._run(args, on_text=on_text))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Validate all interfaces consistently; only CLI help may exit or print here."""

    class Parser(argparse.ArgumentParser):
        def error(self, message):
            # argparse normally exits and prints; API/MCP callers need an exception.
            raise UserError(message, code="invalid_arguments")

    parser = Parser(
        description=__doc__,
        epilog="For agents: schema describes commands and output. Use --stdin --json --brief for reliable pipes.",
    )
    parser.add_argument(
        "command",
        # Preserve the original visible launcher when no command was supplied.
        nargs="?",
        default="new",
        choices=[
            "new",
            "login",
            "auth",
            "usage",
            "chat",
            "resume",
            "read",
            "track",
            "chats",
            "schema",
            "mcp",
            "mcp-config",
            "requests",
            "forget",
            "doctor",
            "close",
            "stop",
            "prepare",
            "prepared",
        ],
    )
    parser.add_argument("identifier", nargs="?", help="Local chat name, full chat UUID, or 'last'")
    parser.add_argument(
        "--provider",
        choices=["claude", "chatgpt"],
        default="claude",
        help="Account service; Claude remains the default",
    )
    parser.add_argument(
        "--transport",
        choices=["http", "browser"],
        default="http",
        help="ChatGPT defaults to HTTP; browser explicitly enables its heavier worker",
    )
    parser.add_argument(
        "--browser", choices=["camoufox", "chromium", "chrome", "msedge"], default="camoufox"
    )
    parser.add_argument("--desktop-exe", help="Explicit path to Claude Desktop's executable")
    parser.add_argument(
        "--no-desktop", action="store_true", help="Only open the Claude browser session"
    )
    parser.add_argument(
        "--regular",
        action="store_true",
        help="Use an ordinary chat instead of Claude Incognito chat",
    )
    parser.add_argument(
        "--prompt",
        help="Message for HTTP chat, or an optional first message for the browser launcher",
    )
    parser.add_argument("--chat-id", help="Continue or read this chat UUID")
    parser.add_argument("--name", help="Local name for a new chat, or local rename with track")
    parser.add_argument(
        "--count", type=int, default=None, help="ChatGPT preparations to collect (1-8; default 3)"
    )
    parser.add_argument(
        "--preparation-method",
        choices=["javascript", "browser"],
        default=None,
        help="ChatGPT prepare defaults to JavaScript; browser explicitly opens visible preparation",
    )
    parser.add_argument(
        "--no-auto-prepare",
        action="store_true",
        help="Require existing ChatGPT preparation instead of collecting it automatically",
    )
    parser.add_argument(
        "--check",
        dest="check_chats",
        action="store_true",
        help="Verify tracked chats in the selected organization (chats only)",
    )
    parser.add_argument("--org-id", help="Select an organization UUID for HTTP commands")
    parser.add_argument("--model", help="Claude model identifier for HTTP chat")
    parser.add_argument(
        "--stdin",
        dest="stdin_prompt",
        action="store_true",
        help="Read an HTTP chat prompt from stdin",
    )
    parser.add_argument(
        "--stream", action="store_true", help="Stream the HTTP chat reply to stdout"
    )
    parser.add_argument(
        "--json",
        dest="json_output",
        action="store_true",
        help="Return HTTP/local command output as JSON",
    )
    parser.add_argument(
        "--brief", action="store_true", help="Compact JSON with repeated/raw content blocks omitted"
    )
    parser.add_argument(
        "--web-search",
        action="store_true",
        help="Enable Claude's web search/fetch tool for this HTTP chat message",
    )
    parser.add_argument(
        "--export",
        dest="export_dir",
        help="Save chat/read results as JSON, text and extracted code files in this directory",
    )
    parser.add_argument(
        "--request-timeout", type=int, default=120, help="HTTP socket read timeout in seconds"
    )
    parser.add_argument(
        "--timezone", default="America/Chicago", help="Timezone supplied with HTTP chat"
    )
    parser.add_argument("--locale", default="en-US", help="Locale supplied with HTTP chat")
    parser.add_argument(
        "--timeout",
        type=int,
        default=900,
        help="Seconds to allow for manual login / Incognito activation",
    )
    args = parser.parse_args(argv)
    if args.command in {"prepare", "prepared"} and args.provider != "chatgpt":
        parser.error("prepare/prepared require --provider chatgpt")
    if args.count is not None and (args.command != "prepare" or not 1 <= args.count <= 8):
        parser.error("--count is only for prepare and must be between 1 and 8")
    if args.preparation_method is not None and (
        args.command != "prepare" or args.provider != "chatgpt"
    ):
        parser.error("--preparation-method is only for prepare --provider chatgpt")
    if args.no_auto_prepare and (
        args.provider != "chatgpt"
        or args.command not in {"chat", "resume", "mcp"}
        or args.transport != "http"
    ):
        parser.error("--no-auto-prepare is only for ChatGPT HTTP chat/resume/mcp")
    # Validate the command/option combinations before opening any state or sockets.
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    if args.command not in {"new", "chat", "resume"} and (args.prompt or args.regular):
        parser.error("--prompt and --regular are only valid with new/chat/resume")
    if args.command not in {"chat", "resume", "read", "track", "close"} and (
        args.identifier or args.chat_id
    ):
        parser.error("A chat reference is only valid with chat/resume/read/track")
    if args.identifier and args.chat_id:
        # Selecting one chat in two ways is ambiguous, even when the values match.
        parser.error("Choose a positional chat reference or --chat-id")
    if args.command in {"resume", "track", "close"} and not (args.identifier or args.chat_id):
        # A missing resume handle must never silently become a new conversation.
        parser.error("Specify a local name or chat UUID (use 'last' explicitly for resume)")
    if args.name and (
        args.command not in {"chat", "track"}
        or (args.command == "chat" and (args.identifier or args.chat_id))
    ):
        # Names register new handles; track is the explicit rename operation.
        parser.error("--name is only valid for a new chat or for track")
    if args.command == "track" and not args.name:
        parser.error("track requires --name")
    if args.check_chats and args.command != "chats":
        parser.error("--check is only valid with chats")
    if args.brief and (
        not args.json_output
        or args.command not in {"auth", "usage", "chat", "resume", "read", "track", "chats"}
    ):
        parser.error("--brief requires --json and an HTTP/local chat command")
    if args.prompt and args.stdin_prompt:
        parser.error("Choose --prompt or --stdin")
    if args.stdin_prompt and args.command not in {"chat", "resume"}:
        parser.error("--stdin is only valid with chat/resume")
    if args.stream and (args.command not in {"chat", "resume"} or args.json_output):
        # Token callbacks and a JSON envelope cannot share the same stdout stream.
        parser.error("--stream is only valid with chat/resume and cannot be combined with --json")
    if args.json_output and args.command not in {
        "auth",
        "usage",
        "chat",
        "resume",
        "read",
        "track",
        "chats",
        "schema",
        "mcp-config",
        "close",
        "stop",
        "prepare",
        "prepared",
    }:
        parser.error("--json is only valid with HTTP/local chat commands or schema")
    if args.web_search and args.command not in {"chat", "resume"}:
        parser.error("--web-search is only valid with chat/resume")
    if args.export_dir and args.command not in {"chat", "resume", "read"}:
        parser.error("--export is only valid with chat/resume/read")
    if args.request_timeout < 1:
        parser.error("--request-timeout must be positive")
    if args.command in {"close", "stop"} and args.provider != "chatgpt":
        parser.error("close and stop require --provider chatgpt")
    if args.transport == "browser" and (
        args.provider != "chatgpt" or args.command not in {"chat", "resume", "read", "track", "mcp"}
    ):
        parser.error("--transport browser is only for ChatGPT chat/resume/read/track/mcp")
    return args


def main(argv: list[str] | None = None) -> int:
    supplied = argv if argv is not None else sys.argv[1:]
    json_requested = "--json" in supplied
    args = None
    # Keep parse errors structured even when parsing never produces a Namespace.
    try:
        args = parse_args(supplied)
        if args.provider == "chatgpt":
            from .chatgpt.cli import run

            run(args)
        elif args.command == "mcp":
            from .mcp_server import main as run_mcp

            run_mcp()
        elif args.command == "mcp-config":
            from .mcp_server import configuration

            print(json.dumps(configuration(), indent=2))
        elif args.command == "schema":
            from .api import Client

            print(json.dumps(Client.schema(), ensure_ascii=False, indent=2))
        elif args.command in {"auth", "usage", "chat", "resume", "read", "track", "chats"}:
            run_http(args)
        elif args.command == "forget":
            from .service import forget_session

            forget_session(state)
            print("Saved web session removed. Desktop and other browser logins are separate.")
        elif args.command == "requests":
            from .browser import show_requests

            show_requests()
        elif args.command == "doctor":
            # Diagnostics inspect local installations without decrypting the login.
            from .browser import find_desktop, camoufox_options

            print(f"Python: {sys.version.split()[0]}")
            print(f"Claude Desktop: {find_desktop(args.desktop_exe) or 'not found'}")
            print(
                f"Encrypted web session: {'present' if state.SESSION_FILE.exists() else 'not saved yet'}"
            )
            print(
                f"Observed request report: {'present' if state.REQUEST_FILE.exists() else 'not captured yet'}"
            )
            try:
                print(f"Camoufox: {camoufox_options()['executable_path']}")
            except UserError as error:
                print(str(error))
            try:
                from importlib.metadata import version, PackageNotFoundError

                print(f"Playwright: {version('playwright')}")
            except PackageNotFoundError:
                print("Playwright: run python -m pip install -e '.[browser]'")
        else:
            from .browser import run_browser

            asyncio.run(run_browser(args))
        return 0
    except KeyboardInterrupt:
        # The exit code remains distinguishable from both usage and network errors.
        if json_requested:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "schema_version": 1,
                        "error": {"code": "interrupted", "message": "Stopped.", "retryable": False},
                    }
                )
            )
        else:
            print("\nStopped.", file=sys.stderr)
        return 130
    except ClaudeError as error:
        # Only the explicit public error fields cross the CLI boundary.
        if json_requested:
            print(
                json.dumps(
                    {"ok": False, "schema_version": 1, "error": error.as_dict()}, ensure_ascii=False
                )
            )
        else:
            print(f"Error: {error}", file=sys.stderr)
            if error.chat_id:
                provider = (
                    " --provider chatgpt" if getattr(args, "provider", None) == "chatgpt" else ""
                )
                print(
                    f"Recovery: python claudfree.py read {error.chat_id}{provider}", file=sys.stderr
                )
        return 2 if error.code == "invalid_arguments" else 1
    except Exception:
        # Browser/navigation exceptions may contain credentials, so do not dump them.
        message = "The operation failed. Check your connection and local session files. No raw error or credentials were logged."
        if json_requested:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "schema_version": 1,
                        "error": {
                            "code": "operation_failed",
                            "message": message,
                            "retryable": False,
                        },
                    }
                )
            )
        else:
            print(f"Error: {message}", file=sys.stderr)
        return 1


def entrypoint():
    # Windows pipe encodings otherwise depend on the launching terminal's locale.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
