"""Local stdio MCP adapter for the shared ClaudFree client."""

import json
import sys
from pathlib import Path

from .api import Client
from .errors import ClaudeError
from .state import STATE_DIR


def configuration(provider: str = "claude") -> dict:
    """A ready-to-merge stdio server entry; works independently of the host's cwd."""
    if provider not in {"claude", "chatgpt"}:
        raise ClaudeError("Unknown provider. Choose claude or chatgpt.", code="invalid_arguments")
    interpreter = Path(sys.executable).resolve()
    # Use the source launcher when present; installed distributions use -m.
    launcher = Path(__file__).resolve().parent.parent / "claudfree.py"
    args = [str(launcher), "mcp"] if launcher.is_file() else ["-m", "claudfree.mcp_server"]
    if provider == "chatgpt":
        args = ([str(launcher), "mcp"] if launcher.is_file() else ["-m", "claudfree", "mcp"]) + [
            "--provider",
            "chatgpt",
        ]
    return {
        "mcpServers": {
            "claudfree-chatgpt" if provider == "chatgpt" else "claudfree": {
                "command": str(interpreter),
                "args": args,
                "env": {"CLAUDFREE_STATE_DIR": str(STATE_DIR)},
            }
        }
    }


def build_server(client: Client | None = None):
    try:
        from mcp.server import MCPServer
        from mcp.types import CallToolResult, TextContent, ToolAnnotations
    except ImportError:
        raise ClaudeError(
            "Install MCP support: python -m pip install -e '.[mcp]'", code="missing_dependency"
        ) from None

    client = client or Client()
    server = MCPServer(
        "ClaudFree",
        version="0.8.0",
        log_level="WARNING",
        instructions="Use claude_list_chats to discover locally tracked UUID/name handles. "
        "Use explicit references to read/resume; multiple chats have independent context. "
        "Creation/resumption sends account messages. Incognito is the default. "
        "Usage snapshots carry observed_at/is_snapshot; null means unknown, not zero. "
        "Never automatically resend an uncertain message: read error.chat_id first. "
        "Login is manual through the separate CLI login command.",
    )
    read = ToolAnnotations(
        read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=True
    )
    local_read = ToolAnnotations(
        read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False
    )
    send = ToolAnnotations(
        read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=True
    )
    track = ToolAnnotations(
        read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=True
    )

    def call(method, *args, **kwargs):
        try:
            result = method(*args, **kwargs)
        except ClaudeError as error:
            result = {"ok": False, "schema_version": 1, "error": error.as_dict()}
        except Exception:
            result = {
                "ok": False,
                "schema_version": 1,
                "error": {
                    "code": "operation_failed",
                    "retryable": False,
                    "message": "The operation failed. Check local state and connectivity.",
                },
            }
        return CallToolResult(
            content=[TextContent(text=json.dumps(result, ensure_ascii=False))],
            structured_content=result,
            is_error=not result["ok"],
        )

    @server.tool(annotations=local_read)
    def claude_schema() -> CallToolResult:
        """Offline command/response contract, UUID rules, usage interpretation and error recovery."""
        return call(client.schema)

    @server.tool(annotations=read)
    def claude_auth() -> CallToolResult:
        """Verify the saved login. Returns organization UUID; never returns credentials."""
        return call(client.auth)

    @server.tool(annotations=read)
    def claude_list_chats(check: bool = False) -> CallToolResult:
        """List saved names, UUIDs, organization, model, Incognito flag, status and timestamps.

        Offline by default. check=true GETs each tracked chat in the selected organization.
        This cannot discover Incognito chats whose UUIDs were never saved locally.
        """
        return call(client.list_chats, check=check)

    @server.tool(annotations=read)
    def claude_read_chat(reference: str, full: bool = False) -> CallToolResult:
        """Read a chat by local name or full UUID. Includes every turn, code and citations.

        full=true includes raw content, file metadata and web tool result blocks.
        """
        return call(client.read, reference, brief=not full)

    @server.tool(annotations=read)
    def claude_usage() -> CallToolResult:
        """GET usage counters without sending a message. Inspect source/observed_at/is_snapshot.

        Free accounts can return a cached stream reading. It may predate other activity.
        reset_passed marks historical windows; exact remaining message count is unknown.
        """
        return call(client.usage)

    @server.tool(annotations=send)
    def claude_create_chat(
        prompt: str,
        name: str | None = None,
        model: str | None = None,
        web_search: bool = False,
        regular: bool = False,
        full: bool = False,
    ) -> CallToolResult:
        """Send a message in a NEW Incognito chat and save its UUID; name must be unused.

        Consumes account usage. regular=true explicitly creates a regular chat.
        web_search enables search/fetch for this turn. full includes raw tool results.
        """
        return call(
            client.create,
            prompt,
            name=name,
            model=model,
            web_search=web_search,
            regular=regular,
            brief=not full,
        )

    @server.tool(annotations=send)
    def claude_resume_chat(
        reference: str,
        prompt: str,
        model: str | None = None,
        web_search: bool = False,
        regular: bool = False,
        full: bool = False,
    ) -> CallToolResult:
        """Send a follow-up to the specific UUID/local name, retaining its conversation context.

        Consumes account usage. Explicit names/UUIDs are preferable to 'last' in parallel jobs.
        Regular chats require regular=true. full includes raw web tool result blocks.
        """
        return call(
            client.resume,
            reference,
            prompt,
            model=model,
            web_search=web_search,
            regular=regular,
            brief=not full,
        )

    @server.tool(annotations=track)
    def claude_track_chat(reference: str, name: str) -> CallToolResult:
        """Validate access and register/rename a local chat handle. No message is sent."""
        return call(client.track, reference, name)

    @server.resource("claudfree://schema")
    def schema_resource() -> str:
        """Offline machine-readable contract."""
        return json.dumps(client.schema())

    return server


def main():
    try:
        build_server().run(transport="stdio")
    except ClaudeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
