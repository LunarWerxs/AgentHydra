"""ChatGPT Temporary Chats over HTTP; only manual login opens a browser."""

from pathlib import Path
from uuid import uuid4

from ..api import Client
from ..errors import ClaudeError
from ..registry import chat_lock, valid_name
from ..results import brief_result, export_results
from .http import connection, visible_messages
from .registry import ChatGPTRegistry
from .state import ChatGPTState


class ChatGPTClient(Client):
    """Use private chats by local name or UUID without starting a browser.

    state_dir selects the shared root; ChatGPT state always lives in its chatgpt/
    subfolder. Login is manual. HTTP reads send a Temporary Chat routing marker.
    HTTP sending prepares fresh single-use verification automatically when needed.
    auto_prepare=False requires an explicit prepare() before sending.
    prepare() uses a short JavaScript process.
    No transcript is stored unless export_dir is supplied. Calls are serialized.
    """

    def __init__(self, state_dir=None, *, timeout=120, auto_prepare=True):
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 1:
            raise ClaudeError("timeout must be a positive integer.", code="invalid_arguments")
        self._state = ChatGPTState(Path(state_dir) / "chatgpt" if state_dir else None)
        self.timeout = timeout
        self.organization_id = None
        if not isinstance(auto_prepare, bool):
            raise ClaudeError("auto_prepare must be a boolean.", code="invalid_arguments")
        self.auto_prepare = auto_prepare

    def _run(self, args, *, on_text=None):
        with chat_lock(self._state.directory / "locks", "session", wait=args.request_timeout + 90):
            return self._execute(args, on_text=on_text)

    def preparation_status(self):
        """Read local readiness without network or authentication."""
        from .preparation import Preparations

        with chat_lock(self._state.directory / "locks", "session", wait=self.timeout + 90):
            return {
                "ok": True,
                "schema_version": 1,
                "provider": "chatgpt",
                "command": "prepared",
                "transport": "local",
                **Preparations(self._state.directory).status(),
            }

    def prepare(self, count=3):
        """Collect verification with JavaScript, then close the JavaScript runtime.

        No account message is sent. Each HTTP message subsequently consumes one
        preparation, with a conservative five-minute local expiry.
        """
        from .preparation import MAX_PREPARATIONS, Preparations

        if (
            isinstance(count, bool)
            or not isinstance(count, int)
            or not 1 <= count <= MAX_PREPARATIONS
        ):
            raise ClaudeError(
                f"count must be between 1 and {MAX_PREPARATIONS}.", code="invalid_arguments"
            )
        from . import runtime

        runtime.installation()  # Missing setup fails before account traffic or pool changes.
        with chat_lock(self._state.directory / "locks", "session", wait=self.timeout + 90):
            pool = Preparations(self._state.directory)
            # The same authenticated session owns collection and account binding.
            # Keep the old pool intact if refreshing fails.
            with connection(self._state, self.timeout) as http:
                entries, measurements = runtime.collect(http, count)
                pool.replace(http.account_key, entries)
            return {
                "ok": True,
                "schema_version": 1,
                "provider": "chatgpt",
                "command": "prepare",
                "transport": "javascript_preparation",
                "preparation_method": "javascript",
                "runtime_closed": True,
                "runtime_measurements": measurements,
                "messages_sent": 0,
                **pool.status(),
            }

    def _execute(self, args, *, on_text=None):
        if args.model or args.regular or args.web_search or args.org_id or args.stream or on_text:
            raise ClaudeError(
                "ChatGPT currently supports default-model Temporary Chats. Model selection, regular chats, forced web search, organizations and token streaming are not supported.",
                code="unsupported_option",
            )
        command = args.command
        if command in {"chat", "resume"} and (
            not isinstance(args.prompt, str) or not args.prompt.strip()
        ):
            raise ClaudeError(
                "Supply a nonempty prompt with --prompt or --stdin.", code="invalid_arguments"
            )
        transport = "http"
        if command == "auth":
            with connection(self._state, args.request_timeout):
                value = {"authenticated": True}
        elif command == "usage":
            with connection(self._state, args.request_timeout) as http:
                value = http.usage()
        else:
            value = self._http_execute(args)
            if command == "chats" and not args.check_chats:
                transport = "local"
        result = {
            "ok": True,
            "schema_version": 1,
            "provider": "chatgpt",
            "command": command,
            "transport": transport,
            **value,
        }
        if args.export_dir:
            try:
                result["export_directory"] = str(export_results(result, args.export_dir))
            except OSError:
                raise ClaudeError(
                    "The reply was received but the export could not be written.",
                    code="export_failed",
                    chat_id=result.get("chat_id"),
                ) from None
        return brief_result(result) if args.brief else result

    def _http_execute(self, args):
        registry = ChatGPTRegistry(self._state.directory)
        command = args.command
        try:
            if command == "chats":
                entries = [registry.metadata(entry) for entry in registry.list()]
                if args.check_chats and entries:
                    with connection(self._state, args.request_timeout) as http:
                        for entry in entries:
                            if not entry["server_conversation_id"]:
                                entry.update(
                                    checked=True, readable=False, status="server_id_unknown"
                                )
                                continue
                            try:
                                http.read(entry["server_conversation_id"])
                                entry.update(checked=True, readable=True, status="available")
                            except ClaudeError as error:
                                entry.update(
                                    checked=True,
                                    readable=False if error.code == "not_found" else None,
                                    status=error.code,
                                )
                            registry.status(entry["chat_id"], entry["status"])
                return {"chats": entries}
            if args.name:
                valid_name(args.name)
            new = command == "chat" and not (args.identifier or args.chat_id)
            if new:
                if args.name and registry.by_name(args.name):
                    raise ClaudeError("That name already identifies a chat.", code="name_conflict")
                entry, server_id = {"chat_id": str(uuid4()), "name": args.name}, None
            else:
                entry, server_id = registry.resolve(
                    args.identifier or args.chat_id or "last", allow_unknown=True
                )
                if not server_id:
                    raise ClaudeError(
                        "No server UUID was confirmed for this handle. Do not automatically resend.",
                        code="server_id_unknown",
                        chat_id=entry["chat_id"],
                    )
            if command in {"chat", "resume"}:
                from .preparation import Preparations

                pool = Preparations(self._state.directory)
                if not self.auto_prepare:
                    # Explicit manual mode retains the local, no-traffic check.
                    pool.require_available()
            with connection(self._state, args.request_timeout) as http:
                body = http.read(server_id) if server_id else None
                if command in {"read", "track"}:
                    messages = visible_messages(body)
                    entry = registry.record(
                        entry["chat_id"], "chatgpt", name=args.name or entry["name"], temporary=True
                    )
                    registry.link(entry["chat_id"], server_id)
                    if command == "track":
                        return {
                            **registry.metadata(entry),
                            "chat_name": entry["name"],
                            "checked": True,
                            "readable": True,
                        }
                    return self._read_result(entry, server_id, messages)
                # Verify the reference and privacy before preparing. Reuse this
                # authenticated connection for preparation, POST and readback.
                measurements = []
                if self.auto_prepare and not pool.status()["ready_messages"]:
                    from .runtime import collect

                    entries, measurements = collect(http, 1)
                    pool.replace(http.account_key, entries)
                entry = registry.record(
                    entry["chat_id"],
                    "chatgpt",
                    name=entry["name"],
                    temporary=True,
                    status="pending",
                )
                if server_id:
                    registry.link(entry["chat_id"], server_id)
                try:
                    body, messages, reply, complete = http.send(
                        args.prompt,
                        existing=body,
                        on_id=lambda identifier: registry.link(entry["chat_id"], identifier),
                    )
                except ClaudeError as error:
                    registry.status(entry["chat_id"], error.code)
                    raise ClaudeError(
                        str(error),
                        code=error.code,
                        status=error.status,
                        retryable=error.retryable,
                        chat_id=entry["chat_id"],
                    ) from None
                registry.status(entry["chat_id"], "available")
                return {
                    **self._read_result(entry, body["conversation_id"], messages),
                    "response": reply["text"],
                    "model": reply["model"],
                    "message_id": reply["id"],
                    "citations": reply["citations"],
                    "code_blocks": reply["code_blocks"],
                    "incomplete": not complete or reply["incomplete"],
                    "tools_used": [],
                    "warnings": [],
                    "preparation": {
                        "automatic": bool(measurements),
                        "runtime_closed": True,
                        "runtime_measurements": measurements,
                    },
                }
        finally:
            registry.close()

    @staticmethod
    def _read_result(entry, server_id, messages):
        return {
            "chat_id": entry["chat_id"],
            "chat_name": entry["name"],
            "server_conversation_id": server_id,
            "is_temporary": True,
            "personalization": None,
            "readable": True,
            "resumable": None,
            "messages": messages,
            "incomplete": not messages
            or messages[-1]["role"] != "assistant"
            or messages[-1]["incomplete"],
            "extraction": "http_visible_messages",
            "raw_tool_results_available": False,
        }

    @staticmethod
    def schema() -> dict:
        return {
            "ok": True,
            "schema_version": 1,
            "provider": "chatgpt",
            "command": "schema",
            "interfaces": ["cli", "python", "mcp_stdio"],
            "transport": "http",
            "network": {
                "base_url": "https://chatgpt.com",
                "scheme": "https",
                "certificate_verification": True,
                "follow_redirects": False,
            },
            "default_privacy": {"temporary": True, "personalization": False},
            "browser_required_for": ["login"],
            "preparation_methods": {"default": "javascript"},
            "preparation_runtime": "Node.js 24+ with Happy DOM 20.14.5 and pinned public web assets; see docs/CHATGPT.txt",
            "commands": {
                name: "Use --provider chatgpt"
                for name in [
                    "login",
                    "auth",
                    "prepare",
                    "prepared",
                    "chat",
                    "resume",
                    "read",
                    "chats",
                    "track",
                    "usage",
                    "forget",
                    "schema",
                    "mcp",
                    "mcp-config",
                ]
            },
            "python": "from claudfree import ChatGPTClient; client=ChatGPTClient(); client.auth(); client.read(reference); client.list_chats()",
            "mcp_tools": [
                "chatgpt_" + name
                for name in [
                    "schema",
                    "auth",
                    "prepare",
                    "preparation_status",
                    "list_chats",
                    "read_chat",
                    "usage",
                    "create_chat",
                    "resume_chat",
                    "track_chat",
                ]
            ],
            "capabilities": {
                "browser_free_auth": True,
                "browser_free_read": True,
                "offline_listing": True,
                "browser_free_send": True,
                "browser_free_workflow": True,
                "send_requires_fresh_preparation": True,
                "automatic_preparation": True,
                "explicit_prepare_required": False,
                "http_send_status": "create and resume verified with browser-free JavaScript preparation after manual login; one credential per message",
                "read_requires": "requires saved login, UUID and server availability; routing marker supplied automatically",
                "remaining_usage": False,
                "raw_tool_results": False,
                "token_streaming": False,
            },
            "rules": [
                "chat_id is a local UUID; server_conversation_id is the service UUID. Accessible unknown server UUIDs can be read/tracked with the saved login.",
                "HTTP never starts a browser or falls back to one; only manual login opens a browser.",
                "Temporary privacy is verified before reading/resuming. Creation requests unpersonalized mode; HTTP reads do not independently verify personalization.",
                "Names and UUIDs are stored without transcripts. HTTP supplies the Temporary Chat routing cookie automatically, enabling reads after the browser closes while the service permits access.",
                "Offline listings do not verify availability; readable/resumable=null means unknown. --check performs HTTP reads.",
                "chat/resume automatically collect one JavaScript preparation when the pool is empty or expired, using the same authenticated connection. Read-only commands never prepare. auto_prepare=False / --no-auto-prepare retains explicit preparation.",
                "prepare optionally collects up to eight single-use preparations without sending messages. prepared reports local readiness, not a required next step.",
                "HTTP sending consumes one DPAPI-encrypted preparation before POST, including on failure. Preparations are account-bound with a five-minute local cutoff; service acceptance is not guaranteed. JavaScript collection failures create no pending chat and send no message.",
                "read extracts visible text, code and links on the selected conversation branch, excluding hidden reasoning and raw tool payloads.",
                "No message is retried automatically. On timeout, read the returned chat_id before sending again.",
                "usage verifies Free access to GPT-5.6 Luna Instant and reports its documented unlimited text policy, with separate tool limits; exact remaining-message counters remain unavailable. It never sends a message.",
                "GPT-5.6 Luna Instant only (gpt-5-6-mini). regular, model, web_search, organization selection and token streaming are unsupported.",
                "Exporting is opt-in and writes the private transcript to disk.",
            ],
        }
