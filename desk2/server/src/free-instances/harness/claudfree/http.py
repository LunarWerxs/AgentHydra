"""Claude web-account HTTP client. This module never launches a browser."""

from __future__ import annotations

from copy import deepcopy
import json
import re
import time
from typing import Any, Callable, Iterable
from uuid import UUID, uuid4
from .errors import ClaudeError
from .results import message_text, message_details
from .state import claude_domain
from .sse import frames


BASE = "https://claude.ai"


class HttpError(ClaudeError):
    """A credential-free error suitable for the CLI."""


def model_refusal(response: Any) -> str | None:
    """Claude's own message when a 403 refuses only the chosen model, else None.

    A free account can be offered a model it may not use right now (seen 2026-10-06: its own default was one
    claude.ai no longer gives free accounts): claude.ai answers 403 permission_error, error_code
    model_not_available, before anything is sent. Any other 403 stays a sign-in or verification problem.
    """
    try:
        if "json" not in response.headers.get("content-type", ""):
            return None
        body = b""
        for chunk in response.iter_content(8192):
            body += chunk
            if len(body) > 65536:
                return None
        error = json.loads(body).get("error") or {}
        if (error.get("details") or {}).get("error_code") != "model_not_available":
            return None
        message = error.get("message")
        return message.strip()[:300] if isinstance(message, str) and message.strip() else "This model isn't available right now."
    except Exception:
        return None


def account_label(name: Any, email: Any) -> str | None:
    """Short display name: the name unless it is an address, else an address's local part."""
    name = name.strip() if isinstance(name, str) else ""
    email = email.strip() if isinstance(email, str) else ""
    if name and "@" not in name:
        label = name
    else:
        address = email or name
        label = address.split("@", 1)[0] if "@" in address else ""
    label = "".join(ch for ch in label if ch.isprintable()).strip()
    return label[:60] or None


def retired_haiku(model: str) -> bool:
    """Claude Haiku 4.x and older (claude-haiku-4-5, claude-3-5-haiku-...): never picked (owner, 2026-10-07)."""
    if "haiku" not in model:
        return False
    version = re.match(r"claude-haiku-(\d+)", model)
    return version is None or int(version.group(1)) < 5


def valid_uuid(value: str) -> str:
    # Validate before interpolation: caller-provided IDs never become URL paths.
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise HttpError("Organization and chat IDs must be UUIDs.", code="invalid_id") from None


def events(lines: Iterable[bytes | str]) -> Iterable[dict[str, Any]]:
    """Parse SSE frames, including multiline data and a final unterminated frame."""
    for event_name, raw in frames(lines):
        if raw == "[DONE]":
            yield {"type": "done"}
            continue
        if not raw:
            continue
        try:
            result = json.loads(raw)
        except ValueError:
            raise HttpError("Claude returned an invalid event stream.") from None
        if not isinstance(result, dict):
            raise HttpError("Claude returned an unexpected event stream.")
        if "type" not in result:
            # Older responses put their type in the SSE event field instead.
            result["type"] = event_name
        yield result


class ClaudeHttp:
    def __init__(
        self,
        state: dict[str, Any],
        *,
        timeout: int = 120,
        session_factory: Callable[[], Any] | None = None,
    ) -> None:
        if session_factory is None:
            try:
                from requests import Session
            except ImportError:
                raise HttpError("Install the HTTP dependency: python -m pip install -e .") from None
            session_factory = Session
        self.session = session_factory()
        # Browser-origin storage can be large; HTTP only reads it for export.
        self.state = {
            "cookies": deepcopy(state.get("cookies", [])),
            "origins": state.get("origins", []),
        }
        self.timeout = timeout
        self.last_usage: dict[str, Any] | None = None
        self.session.headers.update(
            {"Accept": "application/json", "Origin": BASE, "Referer": BASE + "/new"}
        )
        for cookie in state.get("cookies", []):
            # Saved browser state may contain expired or unrelated cookies.
            # Only current Claude cookies participate in an HTTP request.
            if not claude_domain(cookie.get("domain", "")):
                continue
            expiry = cookie.get("expires", -1)
            if expiry > 0 and expiry < time.time():
                continue
            self.session.cookies.set(
                cookie["name"],
                cookie["value"],
                domain=cookie["domain"],
                path=cookie.get("path", "/"),
                secure=cookie.get("secure", False),
                expires=int(expiry) if expiry > 0 else None,
                rest={
                    "HttpOnly": cookie.get("httpOnly", False),
                    "SameSite": cookie.get("sameSite", "Lax"),
                },
            )

    def close(self) -> None:
        self.session.close()

    def storage_state(self) -> dict[str, Any]:
        # Translate requests' cookie jar back into browser-compatible state.
        # Cookie flags and scopes are preserved along with rotated values.
        cookies = []
        for cookie in self.session.cookies:
            if not claude_domain(cookie.domain):
                continue
            same_site = cookie.get_nonstandard_attr("SameSite", "Lax")
            same_site = str(same_site).capitalize()
            if same_site not in {"Strict", "Lax", "None"}:
                same_site = "Lax"
            cookies.append(
                {
                    "name": cookie.name,
                    "value": cookie.value,
                    "domain": cookie.domain,
                    "path": cookie.path,
                    "expires": cookie.expires if cookie.expires is not None else -1,
                    "secure": bool(cookie.secure),
                    "httpOnly": cookie.has_nonstandard_attr("HttpOnly")
                    and cookie.get_nonstandard_attr("HttpOnly") is not False,
                    "sameSite": same_site,
                }
            )
        return {"cookies": cookies, "origins": self.state.get("origins", [])}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        # URLs are constructed here; redirects cannot forward login cookies elsewhere.
        try:
            response = self.session.request(
                method, BASE + path, timeout=(10, self.timeout), allow_redirects=False, **kwargs
            )
        except Exception:
            # Transport errors can include request headers; expose a fixed message.
            raise HttpError(
                "The HTTP request failed. Check your connection. A message request is never retried automatically.",
                code="network_error",
                retryable=method == "GET",
            ) from None
        if 200 <= response.status_code < 300:
            return response
        status = response.status_code
        # Rejected responses are never logged, and their connections still close.
        refusal = model_refusal(response) if status == 403 else None
        response.close()
        if refusal:
            raise HttpError(refusal, code="model_not_available", status=status)
        if status == 401:
            raise HttpError(
                "The saved login expired. Run 'python claudfree.py login' to sign in again.",
                code="login_expired",
                status=status,
            )
        if status == 403 or 300 <= status < 400:
            raise HttpError(
                "Claude requires sign-in or verification. Run 'python claudfree.py login'; the HTTP client will not open a browser automatically.",
                code="login_required",
                status=status,
            )
        if status == 429:
            raise HttpError(
                "Claude's usage or rate limit was reached (HTTP 429). Try again when the account limit resets.",
                code="rate_limited",
                status=status,
                retryable=True,
            )
        if status == 404:
            raise HttpError(
                "Claude could not find that chat or organization (HTTP 404).",
                code="not_found",
                status=status,
            )
        raise HttpError(
            f"Claude rejected the HTTP request ({status}). Check the model, account access and request parameters.",
            code="http_rejected",
            status=status,
        )

    def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self._request(method, path, **kwargs)
        try:
            return response.json()
        except ValueError:
            raise HttpError(
                "Claude returned a verification page or an unexpected non-JSON response. Sign in again with 'python claudfree.py login'."
            ) from None
        finally:
            response.close()

    def authenticate(
        self, preferred_org: str | None = None, *, remembered_org: str | None = None
    ) -> dict[str, Any]:
        # A saved chat's organization takes precedence over the last active browser tab.
        organizations = self._json("GET", "/api/organizations")
        if not isinstance(organizations, list):
            raise HttpError("Claude returned an unexpected organization list.")
        available = [org for org in organizations if isinstance(org, dict) and org.get("uuid")]
        if preferred_org:
            wanted = valid_uuid(preferred_org)
            for org in available:
                if org["uuid"] == wanted:
                    return org
            raise HttpError("This session does not have access to the selected organization.")
        if remembered_org:
            # Owner report 2026-10-06: the org left by a previous account is only a default, never a block.
            try:
                wanted = valid_uuid(remembered_org)
            except HttpError:
                wanted = None
            for org in available:
                if org["uuid"] == wanted:
                    return org
        last_active = next(
            (c["value"] for c in self.state.get("cookies", []) if c.get("name") == "lastActiveOrg"),
            None,
        )
        for org in available:
            if org["uuid"] == last_active:
                return org
        if len(available) == 1:
            return available[0]
        # Guessing between organizations could put a message in the wrong account.
        if not available:
            raise HttpError("The login has no accessible Claude organization.")
        raise HttpError("Several organizations are available. Choose one with --org-id.")

    def account_label_for(self, org: dict[str, Any]) -> str | None:
        """A short display name for the signed-in account; never raises."""
        try:
            try:
                body = self._json("GET", "/api/account")
            except Exception:
                body = None
            name = email = None
            if isinstance(body, dict):
                for source in (body, body.get("account")):
                    if not isinstance(source, dict):
                        continue
                    name = name or next((source[k] for k in ("display_name", "full_name", "name") if isinstance(source.get(k), str) and source[k].strip()), None)
                    email = email or next((source[k] for k in ("email_address", "email") if isinstance(source.get(k), str) and source[k].strip()), None)
            if not name and not email:
                org_name = org.get("name")
                if isinstance(org_name, str):
                    name = re.sub(r"[’']s Organization$", "", org_name.strip(), flags=re.I)
            return account_label(name, email)
        except Exception:
            return None

    def model_for(self, org_id: str, prefer: str, *, own_default: bool = True) -> str | None:
        """The model a new chat gets when none is remembered; never raises.

        A login that never chatted has no model in its config (seen 2026-10-06), and claude.ai stores no
        default for a free account (settings.default_model is null). Its organization lists the models it
        offers (claude_ai_bootstrap_models_config, newest first; retired ones are inactive or overflow):
        the account's own default when it has one (unless `own_default` is off), else the first active
        model whose id holds `prefer` ("sonnet" for a chat, as claude.ai picks; "haiku" for a keepalive
        nudge, the cheapest), else the account's default, else the first active one. Only the account's own
        default (with `own_default` on) can be a Haiku 4.x: an org that offers no newer Haiku gets its
        default instead (owner, 2026-10-07: never use Haiku 4.5).
        """
        try:
            body = self._json("GET", "/api/account")
            if not isinstance(body, dict):
                return None
            own = (body.get("settings") or {}).get("default_model")
            own = own if isinstance(own, str) and re.fullmatch(r"claude-[a-zA-Z0-9._-]+", own) else None
            if own and own_default:
                return own
            offered: list[str] = [own] if own else []
            for membership in body.get("memberships") or []:
                organization = (membership or {}).get("organization") or {}
                if organization.get("uuid") not in (None, org_id):
                    continue
                for entry in organization.get("claude_ai_bootstrap_models_config") or []:
                    model = (entry or {}).get("model")
                    if (
                        isinstance(model, str)
                        and re.fullmatch(r"claude-[a-zA-Z0-9._-]+", model)
                        and not entry.get("inactive")
                        and not entry.get("overflow")
                    ):
                        offered.append(model)
            offered = [m for m in offered if not retired_haiku(m)]
            return next((m for m in offered if prefer in m), offered[0] if offered else None)
        except Exception:
            return None

    def read(self, organization_id: str, chat_id: str) -> dict[str, Any]:
        # Rich rendering includes tool evidence that the legacy text field omits.
        org, chat = valid_uuid(organization_id), valid_uuid(chat_id)
        result = self._json(
            "GET",
            f"/api/organizations/{org}/chat_conversations/{chat}",
            params={"tree": "True", "rendering_mode": "messages", "render_all_tools": "true"},
        )
        if not isinstance(result, dict):
            raise HttpError("Claude returned an unexpected conversation response.")
        return result

    def usage(self, organization_id: str) -> dict[str, Any]:
        org = valid_uuid(organization_id)
        result = self._json("GET", f"/api/organizations/{org}/usage")
        if not isinstance(result, dict):
            raise HttpError(
                "Claude returned an unexpected usage response.", code="invalid_response"
            )
        return result

    def send(
        self,
        organization_id: str,
        prompt: str,
        model: str,
        *,
        chat_id: str | None = None,
        temporary: bool = True,
        web_search: bool = False,
        new_chat_id: str | None = None,
        existing: dict[str, Any] | None = None,
        timezone: str = "America/Chicago",
        locale: str = "en-US",
        on_text: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        """Send once, then identify the persisted reply against the prior transcript.

        HTTP EOF alone does not prove generation finished. Keep partial answers
        readable, but require a terminal event or stored stop reason for completion.
        """
        org = valid_uuid(organization_id)
        self.last_usage = None
        if not re.fullmatch(r"claude-[a-zA-Z0-9._-]+", model):
            raise HttpError("Specify a Claude model identifier with --model.")
        if not prompt.strip():
            raise HttpError("The message is empty.")
        if chat_id and new_chat_id:
            raise HttpError("Choose an existing chat or a new chat ID.", code="invalid_arguments")
        if existing is not None and (not chat_id or existing.get("uuid", chat_id) != chat_id):
            raise HttpError(
                "The provided conversation does not match this chat.", code="invalid_chat_id"
            )
        existing = (
            existing if existing is not None else self.read(org, chat_id) if chat_id else None
        )
        # The prior IDs distinguish this turn from a previously identical answer.
        previous_ids = (
            {
                str(m.get("uuid", m.get("id", "")))
                for m in existing.get("chat_messages", existing.get("messages", []))
                if isinstance(m, dict)
            }
            if existing is not None
            else set()
        )
        if existing is not None and temporary and existing.get("is_temporary") is not True:
            raise HttpError("This is a regular chat. Pass --regular explicitly to continue it.")
        chat = valid_uuid(chat_id or new_chat_id) if chat_id or new_chat_id else str(uuid4())
        assistant_id = str(uuid4())
        payload = {
            "prompt": prompt,
            "model": model,
            "timezone": timezone,
            "locale": locale,
            "attachments": [],
            "files": [],
            "sync_sources": [],
            "tools": [{"type": "web_search_v0", "name": "web_search"}] if web_search else [],
            "rendering_mode": "messages",
            "turn_message_uuids": {
                "human_message_uuid": str(uuid4()),
                "assistant_message_uuid": assistant_id,
            },
            "completion_request_id": str(uuid4()),
        }
        if existing is None:
            # Creation and the first message share one POST and one recovery UUID.
            payload["create_conversation_params"] = {
                "name": "",
                "model": model,
                "is_temporary": temporary,
            }
            if web_search:
                payload["create_conversation_params"]["enabled_web_search"] = True
        elif existing.get("current_leaf_message_uuid"):
            # Continuing the current leaf preserves the server's conversation branch.
            payload["parent_message_uuid"] = valid_uuid(existing["current_leaf_message_uuid"])
        path = f"/api/organizations/{org}/chat_conversations/{chat}/completion"
        response = self._request(
            "POST", path, json=payload, stream=True, headers={"Accept": "text/event-stream"}
        )
        chunks: list[str] = []
        server_message_id: str | None = None
        event_types: set[str] = set()
        stream_finished = False
        try:
            if "text/event-stream" not in response.headers.get("content-type", ""):
                raise HttpError("Claude did not return a chat event stream.")
            for event in events(response.iter_lines(chunk_size=128)):
                kind = event.get("type")
                if isinstance(kind, str):
                    event_types.add(kind)
                if kind == "message_start" and isinstance(event.get("message"), dict):
                    server_message_id = event["message"].get("uuid")
                if kind == "message_limit":
                    # Usage can arrive before a later generation error; keep the observation.
                    from .usage import from_stream

                    observed = from_stream(event.get("message_limit"))
                    if observed:
                        self.last_usage = observed
                if kind == "error" or event.get("error"):
                    raise HttpError(
                        "Claude reported an error while generating the reply. Read the chat before sending again.",
                        code="generation_error",
                        chat_id=chat,
                    )
                text = event.get("completion", "")
                # Only visible text reaches callbacks; tool JSON remains in stored content.
                if not isinstance(text, str):
                    text = ""
                block = event.get("content_block", {})
                if (
                    kind == "content_block_start"
                    and isinstance(block, dict)
                    and block.get("type") == "text"
                ):
                    initial = block.get("text", "")
                    if isinstance(initial, str):
                        text += initial
                delta = event.get("delta", {})
                if isinstance(delta, dict) and delta.get("type") == "text_delta":
                    delta_text = delta.get("text", "")
                    if isinstance(delta_text, str):
                        text += delta_text
                if text:
                    chunks.append(text)
                    if on_text:
                        on_text(text)
                if kind in {"done", "message_stop"}:
                    # A terminal event is stronger evidence than an ordinary socket EOF.
                    stream_finished = True
                    break
        except HttpError:
            raise
        except Exception:
            raise HttpError(
                f"The reply stream was interrupted. Read chat {chat} to check its contents; the message was not resent.",
                code="stream_interrupted",
                chat_id=chat,
            ) from None
        finally:
            response.close()
        # Claude can assign its own message UUIDs. Identify the newly stored answer
        # using the pre-request transcript, and allow a brief persistence delay.
        streamed = "".join(chunks)
        assistant = None
        for attempt in range(10):
            # Poll only GETs for persistence; never repeat the message POST.
            conversation = self.read(org, chat)
            if temporary and conversation.get("is_temporary") is not True:
                raise HttpError("Claude did not confirm that this chat is temporary.")
            candidate = next(
                # When provided, the server's UUID wins over the proposed message ID.
                (
                    m
                    for m in reversed(
                        conversation.get("chat_messages", conversation.get("messages", []))
                    )
                    if isinstance(m, dict)
                    and m.get("sender", m.get("role")) == "assistant"
                    and str(m.get("uuid", m.get("id", ""))) not in previous_ids
                    and (not server_message_id or m.get("uuid", m.get("id")) == server_message_id)
                    and (not streamed or message_text(m) == streamed)
                ),
                None,
            )
            assistant = message_details(candidate) if candidate is not None else None
            if assistant is not None:
                break
            if attempt < 9:
                time.sleep(0.2)
        if assistant is None:
            raise HttpError(
                f"Claude did not confirm a stored answer yet. Read chat {chat}; the message was not resent.",
                code="answer_not_confirmed",
                chat_id=chat,
            )
        return {
            "chat_id": chat,
            "organization_id": org,
            "is_temporary": conversation.get("is_temporary"),
            "model": conversation.get("model", model),
            "response": assistant["text"],
            "streamed_response": streamed,
            "message_id": assistant["id"],
            "stop_reason": assistant["stop_reason"],
            "incomplete": assistant["truncated"]
            or assistant["stop_reason"] in {"max_tokens", "max_output_tokens"}
            or not (stream_finished or assistant["stop_reason"]),
            **{
                key: assistant[key]
                for key in (
                    "content",
                    "citations",
                    "tool_calls",
                    "tool_results",
                    "code_blocks",
                    "attachments",
                    "files",
                )
            },
            "tools_used": sorted(
                {str(tool.get("name")) for tool in assistant["tool_calls"] if tool.get("name")}
            ),
            "event_types": sorted(event_types),
            "usage": self.last_usage,
        }
