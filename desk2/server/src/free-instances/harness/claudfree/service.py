"""Shared operations for the Python client, CLI and MCP server."""

from contextlib import ExitStack
import json
import re
import sqlite3
import sys
from pathlib import Path
from uuid import UUID, uuid4

from .errors import ClaudeError
from .registry import ChatRegistry, chat_lock, valid_name
from . import http
from .results import transcript


SCHEMA_VERSION = 1


def read_config(path: Path) -> dict:
    # A missing configuration is a first run; malformed saved state needs attention.
    if not path.exists():
        return {}
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(result, dict):
            raise ValueError
        return result
    except (ValueError, OSError):
        raise ClaudeError(
            "The local HTTP configuration is invalid. Repair .state/http-config.json.",
            code="invalid_config",
        ) from None


def update_config(api, updates: dict):
    # Read under the lock so simultaneous chat completions cannot lose other fields.
    with chat_lock(api.HTTP_CONFIG_FILE.parent / "locks", "config", wait=5):
        config = read_config(api.HTTP_CONFIG_FILE)
        config.update(updates)
        api.atomic_write(api.HTTP_CONFIG_FILE, json.dumps(config, indent=2).encode("utf-8"))


def resolve(reference: str, registry: ChatRegistry, config: dict) -> tuple[str, dict | None]:
    # UUIDs work without an alias, which keeps uncertain sends recoverable.
    if reference.lower() == "last":
        reference = config.get("last_chat_id", "")
        if not reference:
            raise ClaudeError(
                "No last chat is saved. Start a chat or specify its name/UUID.", code="unknown_chat"
            )
    try:
        chat_id = str(UUID(reference))
        return chat_id, registry.get(chat_id)
    except ValueError:
        entry = registry.by_name(reference)
        if entry:
            return entry["chat_id"], entry
        raise ClaudeError(
            "Unknown local chat name. Run 'chats', or provide the full chat UUID.",
            code="unknown_chat",
        ) from None


def remember_session(api, baseline: dict, refreshed: dict):
    """Merge only cookies this request changed, preserving concurrent refreshes."""

    def cookie_map(state):
        return {(c["name"], c["domain"], c.get("path", "/")): c for c in state.get("cookies", [])}

    old, new = cookie_map(baseline), cookie_map(refreshed)
    changed = {key for key in old.keys() | new.keys() if old.get(key) != new.get(key)}
    if not changed:
        return
    with chat_lock(api.HTTP_CONFIG_FILE.parent / "locks", "session", wait=5):
        latest = api.load_session()
        # An in-flight request must not recreate a session removed by 'forget'.
        if latest is None:
            return
        current = cookie_map(latest)
        original = current.copy()
        for key in changed:
            # Replace only the baseline value, never a newer login or refresh.
            if current.get(key) == old.get(key):
                if key in new:
                    current[key] = new[key]
                else:
                    current.pop(key, None)
        if current != original:
            api.save_session(
                {"cookies": list(current.values()), "origins": latest.get("origins", [])}
            )


def forget_session(api):
    """Serialize removal with HTTP cookie refresh, including its load/write pair."""
    with chat_lock(api.HTTP_CONFIG_FILE.parent / "locks", "session", wait=5):
        api.SESSION_FILE.unlink(missing_ok=True)


def remember_status(registry: ChatRegistry, chat_id: str, status: str):
    """A secondary bookkeeping failure must not hide the original recovery UUID."""
    try:
        registry.status(chat_id, status)
    except (OSError, sqlite3.Error):
        print("Warning: The local chat status could not be saved.", file=sys.stderr)


def execute(args, *, api, on_text=None) -> dict:
    """Run one operation with its own connections and per-chat mutation lock.

    Register new UUIDs before sending so an interrupted POST is recoverable.
    Once a reply is confirmed, optional local bookkeeping cannot discard it.
    """
    prompt = None
    if args.command in {"chat", "resume"}:
        prompt = args.prompt
        if not prompt or not prompt.strip():
            raise ClaudeError(
                "Supply a nonempty message with --prompt or --stdin.", code="empty_prompt"
            )
    config = read_config(api.HTTP_CONFIG_FILE)
    registry = ChatRegistry(api.HTTP_CONFIG_FILE.parent / "chats.sqlite3")
    # Each call owns these connections; the public Client can be shared by callers.
    client = None
    baseline = None
    active_chat = None
    org = None
    try:
        # Keep the legacy 'last' handle on upgrades; no conversation text is imported.
        if (
            config.get("last_chat_id")
            and config.get("organization_id")
            and not registry.get(config["last_chat_id"])
        ):
            registry.record(
                config["last_chat_id"],
                config["organization_id"],
                model=config.get("model"),
                status="known",
            )
        if args.command == "chats" and not args.check_chats:
            # Local handles remain usable for recovery while offline or signed out.
            return {
                "source": "local_registry",
                "availability_checked": False,
                "chats": registry.list(),
            }

        reference = args.chat_id or args.identifier
        entry = None
        if args.command in {"resume", "read", "track"} or (args.command == "chat" and reference):
            active_chat, entry = resolve(reference or "last", registry, config)
        selected_org = http.valid_uuid(args.org_id) if args.org_id else None
        # An alias binds to its original organization; explicit mismatches fail early.
        preferred_org = (
            selected_org or (entry or {}).get("organization_id") or config.get("organization_id")
        )
        if entry and selected_org and selected_org != entry["organization_id"]:
            raise ClaudeError(
                "That chat belongs to another organization.", code="organization_mismatch"
            )
        baseline = api.load_session()
        if baseline is None:
            raise ClaudeError(
                "No saved login. Run 'python claudfree.py login' once.", code="login_required"
            )
        client = http.ClaudeHttp(baseline, timeout=args.request_timeout)
        organization = client.authenticate(preferred_org)
        org = organization["uuid"]
        if args.command == "usage":
            # An empty endpoint may fall back to a historical reading, never a new POST.
            from .usage import read_cache, report

            result = report(
                client.usage(org), read_cache(api.HTTP_CONFIG_FILE.parent / "usage-cache.json", org)
            )
            return {"organization_id": org, **result}
        if args.command == "auth":
            update_config(api, {"organization_id": org})
            return {
                "authenticated": True,
                "organization_id": org,
                "transport": "http",
                "browser_launched": False,
                "account_label": client.account_label_for(organization),
            }
        if args.command == "chats":
            for item in registry.list():
                if item["organization_id"] != org:
                    continue
                try:
                    conv = client.read(org, item["chat_id"])
                    registry.record(
                        item["chat_id"],
                        org,
                        model=conv.get("model"),
                        temporary=conv.get("is_temporary"),
                        touch=False,
                    )
                    # Availability probes do not change the user's recency ordering.
                except http.HttpError as error:
                    if error.code == "not_found":
                        registry.status(item["chat_id"], "unavailable")
                    else:
                        raise
            return {
                "source": "local_registry",
                "availability_checked": True,
                "checked_organization_id": org,
                "chats": registry.list(),
            }

        with ExitStack() as locks:
            # Acquire the alias before the UUID consistently across create/track calls.
            # Different chat UUIDs still run concurrently.
            if args.name:
                name = valid_name(args.name)
                locks.enter_context(
                    chat_lock(api.HTTP_CONFIG_FILE.parent / "locks", "name-" + name)
                )
                named = registry.by_name(name)
                if named and named["chat_id"] != active_chat:
                    raise ClaudeError(
                        "That name already identifies a chat. Use 'resume NAME' or choose another name.",
                        code="name_conflict",
                    )
            else:
                name = (entry or {}).get("name")
            if active_chat:
                locks.enter_context(
                    chat_lock(api.HTTP_CONFIG_FILE.parent / "locks", "chat-" + active_chat)
                )
                conversation = client.read(org, active_chat)
                # Reuse this read during send; it supplies both privacy and parent context.
            else:
                conversation = None
            if args.command in {"read", "track"}:
                tracked = registry.record(
                    active_chat,
                    org,
                    name=name,
                    model=conversation.get("model"),
                    temporary=conversation.get("is_temporary"),
                )
                result = {
                    "chat_id": active_chat,
                    "chat_name": tracked["name"],
                    "organization_id": org,
                    "is_temporary": conversation.get("is_temporary"),
                    "model": conversation.get("model"),
                }
                if args.command == "read":
                    result["messages"] = transcript(conversation)
                return result

            model = args.model or (conversation or {}).get("model") or config.get("model")
            if not model:
                raise ClaudeError("Choose a Claude model with --model.", code="model_required")
            if not isinstance(model, str) or not re.fullmatch(r"claude-[a-zA-Z0-9._-]+", model):
                raise ClaudeError(
                    "Specify a Claude model identifier with --model.", code="invalid_model"
                )
            if (
                conversation is not None
                and not args.regular
                and conversation.get("is_temporary") is not True
            ):
                raise ClaudeError(
                    "This is a regular chat. Pass --regular explicitly to continue it.",
                    code="privacy_mismatch",
                )
            if not active_chat:
                # Commit the recovery handle before the first request that can create a chat.
                active_chat = str(uuid4())
                locks.enter_context(
                    chat_lock(api.HTTP_CONFIG_FILE.parent / "locks", "chat-" + active_chat)
                )
                registry.record(
                    active_chat,
                    org,
                    name=name,
                    model=model,
                    temporary=not args.regular,
                    status="pending",
                )
            try:
                result = client.send(
                    org,
                    prompt,
                    model,
                    chat_id=active_chat if conversation is not None else None,
                    new_chat_id=active_chat if conversation is None else None,
                    existing=conversation,
                    temporary=not args.regular,
                    web_search=args.web_search,
                    timezone=args.timezone,
                    locale=args.locale,
                    on_text=on_text,
                )
            except ClaudeError as error:
                # Failure does not prove the server rejected the POST. Read before retrying.
                error.chat_id = active_chat
                error.retryable = False
                remember_status(registry, active_chat, "needs_check")
                raise
            result["chat_name"] = name
            result.pop("streamed_response", None)
            try:
                tracked = registry.record(
                    active_chat,
                    org,
                    name=name,
                    model=result["model"],
                    temporary=result["is_temporary"],
                )
                result["chat_name"] = tracked["name"]
                # Only a confirmed send changes 'last'; reading a chat does not.
                update_config(
                    api,
                    {"organization_id": org, "model": result["model"], "last_chat_id": active_chat},
                )
            except (ClaudeError, OSError, sqlite3.Error):
                # Local disk trouble must not turn a received reply into a lost response.
                result.setdefault("warnings", []).append(
                    {
                        "code": "metadata_save_failed",
                        "message": "The reply was received, but local chat metadata could not be saved. Use the returned chat_id; the name, status or 'last' handle may be stale.",
                    }
                )
            return result
    except http.HttpError as error:
        if active_chat and error.code == "not_found":
            error.chat_id = active_chat
            remember_status(registry, active_chat, "unavailable")
        raise
    finally:
        # Cookie/usage observations can still be useful after generation fails.
        # Optional persistence failures cannot replace the primary result or error.
        try:
            if client is not None and baseline is not None:
                if org and client.last_usage:
                    from .usage import save_cache

                    try:
                        save_cache(api, org, client.last_usage)
                    except (ClaudeError, OSError):
                        print("Warning: The usage observation could not be saved.", file=sys.stderr)
                try:
                    remember_session(api, baseline, client.storage_state())
                except (ClaudeError, OSError):
                    print(
                        "Warning: The refreshed session could not be saved; the chat result remains valid.",
                        file=sys.stderr,
                    )
        finally:
            if client is not None:
                client.close()
            registry.close()
