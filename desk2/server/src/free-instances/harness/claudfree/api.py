"""One structured interface shared by CLI commands, Python callers and MCP tools."""

from pathlib import Path

from . import service, state
from .errors import ClaudeError
from .results import brief_result, export_results


class Client:
    """Use the saved login; every operation returns a JSON-serializable dictionary.

    Calls raise ClaudeError on failure and never print response text, launch a
    browser, or retry message POSTs. A client can serve concurrent operations;
    each call creates its own HTTP session and SQLite connection.
    """

    def __init__(
        self,
        state_dir: str | Path | None = None,
        *,
        organization_id: str | None = None,
        timeout: int = 120,
    ):
        self._state = state if state_dir is None else state.StateStore(state_dir)
        self.organization_id = organization_id
        self.timeout = timeout

    def execute(
        self,
        command: str,
        reference: str | None = None,
        *,
        prompt: str | None = None,
        name: str | None = None,
        model: str | None = None,
        regular: bool = False,
        web_search: bool = False,
        check: bool = False,
        brief: bool = False,
        export_dir: str | Path | None = None,
        on_text=None,
    ) -> dict:
        """Generic structured command API; named methods below are usually simpler."""
        from .cli import parse_args

        if command not in {"auth", "usage", "chats", "read", "track", "chat", "resume"}:
            raise ClaudeError(
                "Unknown API operation. Call Client.schema() for commands.",
                code="invalid_arguments",
            )
        if (reference is not None or command in {"read", "resume", "track"}) and (
            not isinstance(reference, str) or not reference.strip()
        ):
            raise ClaudeError(
                "Specify a nonempty chat name or UUID; use 'last' explicitly.",
                code="invalid_arguments",
            )
        argv = [command, "--json", "--request-timeout=" + str(self.timeout)]
        for flag, value in (
            ("--prompt", prompt),
            ("--name", name),
            ("--model", model),
            ("--org-id", self.organization_id),
            ("--export", export_dir),
        ):
            if value is not None:
                # --flag=value also accepts prompts that begin with a hyphen.
                argv.append(flag + "=" + str(value))
        for flag, enabled in (
            ("--regular", regular),
            ("--web-search", web_search),
            ("--check", check),
            ("--brief", brief),
        ):
            if enabled:
                argv.append(flag)
        if reference is not None:
            # A caller's chat reference is data, even when it looks like --help.
            argv += ["--", reference]
        return self._run(parse_args(argv), on_text=on_text)

    def _run(self, args, *, on_text=None) -> dict:
        result = {
            "ok": True,
            "schema_version": service.SCHEMA_VERSION,
            "command": args.command,
            **service.execute(args, api=self._state, on_text=on_text),
        }
        if args.export_dir:
            try:
                result["export_directory"] = str(export_results(result, str(args.export_dir)))
            except OSError:
                raise ClaudeError(
                    "The response was received, but the export could not be written.",
                    code="export_failed",
                    chat_id=result.get("chat_id"),
                ) from None
        return brief_result(result) if args.brief else result

    def auth(self) -> dict:
        """Verify the saved login using HTTP."""
        return self.execute("auth")

    def list_chats(self, *, check: bool = False) -> dict:
        """List local UUID/name handles; check=True verifies server availability."""
        return self.execute("chats", check=check)

    def read(
        self, reference: str, *, brief: bool = False, export_dir: str | Path | None = None
    ) -> dict:
        """Read all turns, citations, code and tool results by UUID or local name."""
        return self.execute("read", reference, brief=brief, export_dir=export_dir)

    def create(
        self,
        prompt: str,
        *,
        name: str | None = None,
        model: str | None = None,
        regular: bool = False,
        web_search: bool = False,
        brief: bool = False,
        export_dir: str | Path | None = None,
        on_text=None,
    ) -> dict:
        """Create a new Incognito chat and save its UUID before sending."""
        return self.execute(
            "chat",
            prompt=prompt,
            name=name,
            model=model,
            regular=regular,
            web_search=web_search,
            brief=brief,
            export_dir=export_dir,
            on_text=on_text,
        )

    def resume(
        self,
        reference: str,
        prompt: str,
        *,
        model: str | None = None,
        regular: bool = False,
        web_search: bool = False,
        brief: bool = False,
        export_dir: str | Path | None = None,
        on_text=None,
    ) -> dict:
        """Continue exactly one named/UUID chat; normal context is preserved."""
        return self.execute(
            "resume",
            reference,
            prompt=prompt,
            model=model,
            regular=regular,
            web_search=web_search,
            brief=brief,
            export_dir=export_dir,
            on_text=on_text,
        )

    def track(self, reference: str, name: str) -> dict:
        """Validate access and assign a local name to an existing UUID/chat."""
        return self.execute("track", reference, name=name)

    def usage(self) -> dict:
        """Read endpoint counters or the timestamped last-stream snapshot; no POST."""
        return self.execute("usage")

    @staticmethod
    def schema() -> dict:
        """Describe commands, fields and recovery rules without network access."""
        return {
            "ok": True,
            "schema_version": service.SCHEMA_VERSION,
            "command": "schema",
            "transport": "http",
            "network": {
                "base_url": "https://claude.ai",
                "scheme": "https",
                "certificate_verification": True,
                "follow_redirects": False,
            },
            "interfaces": ["cli", "python", "mcp_stdio"],
            "browser_required_for": ["login", "new"],
            "commands": {
                "auth": "auth --json: verify saved login",
                "usage": "usage --json: read usage endpoint; empty counters fall back to a timestamped last-chat observation",
                "chat": "chat --name NAME --stdin --json: create a new Incognito chat; name must be unused",
                "resume": "resume NAME_OR_UUID --stdin --json: continue that specific chat; 'last' is supported",
                "read": "read NAME_OR_UUID --json: retrieve that chat; omitted identifier means 'last'",
                "chats": "chats --json: list local metadata offline; --check verifies server availability",
                "track": "track UUID_OR_NAME --name NAME --json: register/rename a chat locally after validating access",
                "schema": "schema: display this machine contract without network access",
                "mcp": "mcp: run the local stdio server",
                "mcp-config": "mcp-config: print a ready-to-merge MCP host configuration",
            },
            "python": "from claudfree import Client; Client().list_chats()/read(reference)/usage()",
            "mcp_tools": [
                "claude_schema",
                "claude_auth",
                "claude_list_chats",
                "claude_read_chat",
                "claude_usage",
                "claude_create_chat",
                "claude_resume_chat",
                "claude_track_chat",
            ],
            "options": {
                "--regular": "explicitly allow regular chats",
                "--web-search": "enable Claude's web search/fetch for this turn",
                "--brief": "with --json, omit raw/repeated blocks and format compactly",
                "--export DIR": "write full JSON, text and extracted code; never executes generated code",
                "--prompt TEXT": "alternative to --stdin; input stays out of local metadata",
                "--org-id UUID": "select account organization",
                "--model ID": "override model; resumed chats otherwise use their stored model",
            },
            "output": {
                "success": "one JSON object with ok=true, schema_version, command, plus command fields",
                "chat": [
                    "chat_id",
                    "chat_name",
                    "organization_id",
                    "is_temporary",
                    "model",
                    "response",
                    "citations",
                    "code_blocks",
                    "tools_used",
                    "content",
                    "tool_calls",
                    "tool_results",
                    "usage",
                    "incomplete",
                    "warnings",
                ],
                "usage": [
                    "source",
                    "observed_at",
                    "is_snapshot",
                    "age_seconds",
                    "windows",
                    "exact_remaining_messages",
                ],
                "error": "ok=false; error includes code, message, retryable and optional http_status/chat_id",
                "exit_codes": {
                    "0": "success",
                    "1": "operation failed",
                    "2": "invalid arguments",
                    "130": "interrupted",
                },
            },
            "rules": [
                "Omit the chat identifier to create; provide one to continue. Names are local aliases.",
                "Incognito chats are resumed by their UUID while Claude still permits access.",
                "The local list does not enumerate unknown Incognito chats on Claude.",
                "POST messages are never retried automatically. If uncertain, read the returned chat_id.",
                "A successful reply may include warnings if local metadata could not be saved; keep its chat_id.",
                "incomplete is true for a truncated answer or when neither the stream nor the stored message confirms completion.",
                "Concurrent operations on different chats are supported; the same chat/name is locked.",
                "Search/fetch execution and factual freshness are separate checks. Verify important facts.",
                "usage never sends a message. Stream snapshots are historical; null counters mean unknown, not zero.",
            ],
        }
