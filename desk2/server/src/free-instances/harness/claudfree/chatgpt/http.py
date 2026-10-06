"""Small authenticated HTTP requests. No browser imports, workers or send retries."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import re
import time
from uuid import uuid4

import requests

from ..errors import ClaudeError
from ..http import account_label, valid_uuid
from ..results import code_blocks
from .stream import events
from .preparation import Preparations, account_key

BASE = "https://chatgpt.com"
TEXT_MODEL = "gpt-5-6-mini"
TEXT_MODEL_NAME = "GPT-5.6 Luna"
UNLIMITED_PLANS = {"free", "go", "plus", "pro"}  # paid personal plans include everything in Free


def visible_messages(conversation):
    """Follow the selected branch and allow only visible user/assistant text."""
    mapping = conversation.get("mapping")
    current = conversation.get("current_node")
    if not isinstance(mapping, dict) or not isinstance(current, str):
        raise ClaudeError("Unexpected ChatGPT conversation format.", code="invalid_response")
    branch, seen = [], set()
    while current is not None:
        if current in seen or current not in mapping or not isinstance(mapping[current], dict):
            raise ClaudeError("Invalid ChatGPT conversation branch.", code="invalid_response")
        seen.add(current)
        node = mapping[current]
        branch.append(node.get("message"))
        current = node.get("parent")
    result = []
    for message in reversed(branch):
        if not isinstance(message, dict):
            continue
        author, content = message.get("author", {}), message.get("content", {})
        metadata = message.get("metadata") or {}
        if (
            not isinstance(author, dict)
            or not isinstance(content, dict)
            or not isinstance(metadata, dict)
        ):
            raise ClaudeError("Invalid ChatGPT message format.", code="invalid_response")
        role = author.get("role")
        if (
            role not in {"user", "assistant"}
            or message.get("channel") not in {None, "final"}
            or message.get("recipient") not in {None, "all"}
            or metadata.get("is_visually_hidden_from_conversation")
            or content.get("content_type") not in {"text", "multimodal_text"}
        ):
            continue
        parts = content.get("parts", [])
        if not isinstance(parts, list):
            raise ClaudeError("Invalid ChatGPT text format.", code="invalid_response")
        text = "".join(part for part in parts if isinstance(part, str))
        if not text:
            continue
        # The web app's visible link token is rendered as an ordinary Markdown
        # link. Its private-use delimiters must not become part of a source URL.
        text = re.sub(
            r"\ue200url\ue202([^\ue202]+)\ue202(https?://[^\ue201]+)\ue201",
            r"[\1](\2)",
            text,
        )
        citations, urls = [], set()

        def add(url, title=None):
            if isinstance(url, str) and url.startswith(("https://", "http://")) and url not in urls:
                urls.add(url)
                citations.append({"url": url, "title": title if isinstance(title, str) else url})

        # Only expose documented-looking public link fields, never raw metadata/tokens.
        for key in ("citations", "content_references"):
            for reference in metadata.get(key, []) or []:
                if isinstance(reference, dict):
                    add(reference.get("url"), reference.get("title"))
                    nested = reference.get("metadata")
                    if isinstance(nested, dict):
                        add(nested.get("url"), nested.get("title"))
        for url in re.findall(r"https?://[^\s<>\]\)\"'\ue000-\uf8ff]+", text):
            add(url.rstrip(".,;:!"))
        result.append(
            {
                "id": message.get("id"),
                "role": role,
                "text": text,
                "model": metadata.get("model_slug") or metadata.get("resolved_model_slug"),
                "incomplete": message.get("status") != "finished_successfully",
                "content": [{"type": "text", "text": text}],
                "code_blocks": code_blocks(text),
                "citations": citations,
                "tool_calls": [],
                "tool_results": [],
            }
        )
    return result


class ChatGPTHttp:
    def __init__(self, saved, *, timeout=120, session_factory=None, preparations=None):
        self.original = {
            "cookies": deepcopy(saved.get("cookies", [])),
            "origins": saved.get("origins", []),
        }
        self.session = (session_factory or requests.Session)()
        self.timeout = timeout
        self.preparations = preparations
        self.account_key = None
        self.account_label = None
        self.session.headers.update(
            {"Accept": "application/json", "Origin": BASE, "Referer": BASE + "/"}
        )
        for cookie in saved.get("cookies", []):
            # A cookie from auth.openai.com must never be sent to chatgpt.com.
            expiry = cookie.get("expires", -1)
            if cookie.get("domain", "").lstrip(".").lower() != "chatgpt.com" or (
                expiry > 0 and expiry <= time.time()
            ):
                continue
            self.session.cookies.set(
                cookie["name"],
                cookie["value"],
                domain=cookie["domain"],
                path=cookie.get("path", "/"),
                secure=cookie.get("secure", True),
                expires=int(expiry) if expiry > 0 else None,
                rest={
                    "HttpOnly": cookie.get("httpOnly", False),
                    "SameSite": cookie.get("sameSite", "Lax"),
                },
            )
            if cookie["name"] == "oai-did":
                self.session.headers["OAI-Device-ID"] = cookie["value"]

    def close(self):
        self.session.close()

    def saved_state(self):
        cookies = [
            c
            for c in self.original.get("cookies", [])
            if c.get("domain", "").lstrip(".").lower() != "chatgpt.com"
        ]
        for cookie in self.session.cookies:
            if cookie.domain.lstrip(".").lower() != "chatgpt.com" or cookie.is_expired():
                continue
            same_site = str(cookie.get_nonstandard_attr("SameSite", "Lax")).capitalize()
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
                    "sameSite": same_site if same_site in {"Strict", "Lax", "None"} else "Lax",
                }
            )
        return {"cookies": cookies, "origins": self.original.get("origins", [])}

    def _request(self, method, path, **kwargs):
        if path == "/api/auth/session":
            # Only the split session cookie is needed for this endpoint. Avoid
            # sending analytics, device and unrelated chat cookies on every call.
            jar = requests.cookies.RequestsCookieJar()
            for cookie in self.session.cookies:
                if re.fullmatch(r"__Secure-next-auth\.session-token(?:\.\d+)?", cookie.name):
                    jar.set_cookie(cookie)
            prepared = requests.Request(method, BASE + path).prepare()
            kwargs["headers"] = {
                **kwargs.get("headers", {}),
                "Cookie": requests.cookies.get_cookie_header(jar, prepared) or "",
            }
        try:
            response = self.session.request(
                method, BASE + path, timeout=(10, self.timeout), allow_redirects=False, **kwargs
            )
        except requests.RequestException:
            raise ClaudeError(
                "ChatGPT HTTP request failed. No automatic retry or browser fallback was made.",
                code="network_error",
                retryable=method == "GET",
            ) from None
        if 200 <= response.status_code < 300:
            return response
        status = response.status_code
        response.close()
        if status == 403:
            code, message = (
                "http_verification_required",
                "ChatGPT rejected the HTTP request with a device or access check. Verification may need refreshing. No retry or browser fallback was made; read the chat before deciding whether to send again.",
            )
        elif status == 401 or 300 <= status < 400:
            code, message = (
                "login_required",
                "ChatGPT requires sign-in. Run login --provider chatgpt.",
            )
        elif status == 404:
            code, message = (
                "not_found",
                "ChatGPT could not read this chat. Its UUID and current access cookies are required; the chat may also have expired.",
            )
        elif status == 429:
            code, message = (
                "rate_limited",
                "ChatGPT's account or request limit was reached. Wait for the limit to reset.",
            )
        else:
            code, message = (
                "http_rejected",
                "ChatGPT rejected the HTTP request. No retry or browser fallback was made.",
            )
        raise ClaudeError(message, code=code, status=status)

    def _json(self, method, path, **kwargs):
        response = self._request(method, path, **kwargs)
        try:
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except ValueError:
            raise ClaudeError(
                "ChatGPT returned an unexpected response.", code="invalid_response"
            ) from None
        finally:
            response.close()

    def authenticate(self):
        body = self._json("GET", "/api/auth/session")
        if (
            not isinstance(body.get("user"), dict)
            or not body["user"]
            or not isinstance(body.get("accessToken"), str)
            or not body["accessToken"]
        ):
            raise ClaudeError(
                "ChatGPT login expired. Run login --provider chatgpt.", code="login_required"
            )
        self.session.headers["Authorization"] = "Bearer " + body["accessToken"]
        try:
            self.account_label = account_label(body["user"].get("name"), body["user"].get("email"))
        except Exception:
            self.account_label = None
        identifier = body["user"].get("id")
        self.account_key = (
            account_key(identifier) if isinstance(identifier, str) and identifier else None
        )

    def read(self, server_id):
        server_id = valid_uuid(server_id)
        # This boolean marker selects Temporary Chat lookup; it is not an auth
        # credential. The authenticated server still decides account access.
        body = self._json(
            "GET",
            "/backend-api/conversation/" + server_id,
            headers={"Cookie": "history_off_" + server_id + "=1"},
        )
        if body.get("conversation_id") != server_id:
            raise ClaudeError("ChatGPT returned a different conversation.", code="invalid_response")
        if body.get("is_temporary_chat") is not True:
            raise ClaudeError(
                "This chat is not confirmed as Temporary. No message was sent.",
                code="privacy_not_verified",
            )
        return body

    def usage(self):
        """Verify Free access and report text policy, without sending a message."""
        accounts = self._json("GET", "/backend-api/accounts/check/v4-2023-04-27")
        models = self._json("GET", "/backend-api/models?history_and_training_disabled=true")
        records = accounts.get("accounts", {})
        records = list(records.values()) if isinstance(records, dict) else []
        plans = []
        for item in records:
            if isinstance(item, dict) and item.get("can_access_with_session") is False:
                continue
            account = item.get("account") if isinstance(item, dict) else None
            plans.append(account.get("plan_type") if isinstance(account, dict) else None)
        advertised = models.get("models", [])
        luna = any(isinstance(model, dict) and model.get("slug") == TEXT_MODEL
                   and model.get("title") == TEXT_MODEL_NAME and model.get("reasoning_type") == "none"
                   for model in advertised) if isinstance(advertised, list) else False
        unlimited = bool(plans) and all(p in UNLIMITED_PLANS for p in plans) and luna
        plan = plans[0] if plans and all(p == plans[0] for p in plans) else None
        return {
            "plan": plan,
            "available": unlimited,
            "unlimited_text": unlimited,
            "text_model": TEXT_MODEL_NAME,
            "model_slug": TEXT_MODEL,
            "source": (
                "not_exposed" if not unlimited
                else "verified_free_text_policy" if plan == "free"
                else "plan_includes_free_text_policy"
            ),
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "is_snapshot": False,
            "windows": [],
            "exact_remaining_messages": None,
            "note": (
                "GPT-5.6 Luna: unlimited everyday text on the Free plan, subject to abuse safeguards. "
                "Uploads, images, voice and other tools have separate limits. This is a verified plan policy, not a remaining-message counter."
                if unlimited and plan == "free" else
                f"GPT-5.6 Luna: unlimited everyday text on the {plan.capitalize() if plan else 'paid'} plan, which includes everything in Free, subject to abuse safeguards. "
                "Uploads, images, voice and other tools have separate limits. This is a plan policy, not a remaining-message counter."
                if unlimited else
                "An unlimited Free text allowance could not be verified for this login. No remaining-message counter was returned."
            ),
        }

    def send(self, prompt, *, existing=None, on_id=None):
        """One private POST. A prepared credential is consumed before transmission."""
        if not isinstance(prompt, str) or not prompt.strip():
            raise ClaudeError("Supply a nonempty prompt.", code="invalid_arguments")
        if existing is not None and existing.get("is_temporary_chat") is not True:
            raise ClaudeError("Temporary Chat is not verified.", code="privacy_not_verified")
        previous = {m["id"] for m in visible_messages(existing)} if existing else set()
        payload = {
            "action": "next",
            "messages": [
                {
                    "id": str(uuid4()),
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": [prompt]},
                }
            ],
            "parent_message_id": valid_uuid(existing["current_node"]) if existing else str(uuid4()),
            "model": TEXT_MODEL,
            "history_and_training_disabled": True,
        }
        server_id = valid_uuid(existing["conversation_id"]) if existing else None
        if existing:
            payload["conversation_id"] = server_id
        else:
            # The service rejects this field on continuations (HTTP 422).
            payload["temporary_chat_requests_personalization"] = False
        headers = {"Accept": "text/event-stream"}
        if self.preparations is not None:
            headers.update(self.preparations.take(self.account_key))
        response = self._request(
            "POST",
            "/backend-api/f/conversation",
            json=payload,
            stream=True,
            headers=headers,
        )
        complete = False
        try:
            if "text/event-stream" not in response.headers.get("content-type", ""):
                raise ClaudeError(
                    "ChatGPT did not return a message stream.", code="invalid_response"
                )
            for event in events(response.iter_lines(chunk_size=1024)):
                if event.get("type") == "error" or event.get("error"):
                    raise ClaudeError(
                        "ChatGPT generation failed; read the chat before sending again.",
                        code="generation_error",
                    )
                candidate = event.get("conversation_id")
                if candidate:
                    candidate = valid_uuid(candidate)
                    if server_id and candidate != server_id:
                        raise ClaudeError(
                            "The reply belongs to a different conversation.",
                            code="invalid_response",
                        )
                    if not server_id:
                        server_id = candidate
                        if on_id:
                            on_id(server_id)
                if event.get("type") == "message_stream_complete":
                    complete = True
        except (requests.RequestException, UnicodeError):
            raise ClaudeError(
                "The reply stream was interrupted. Read the chat; do not resend automatically.",
                code="stream_interrupted",
            ) from None
        finally:
            response.close()
        if not server_id:
            raise ClaudeError(
                "No server UUID was confirmed. Do not automatically resend.",
                code="response_pending",
            )
        body = self.read(server_id)
        messages = visible_messages(body)
        fresh = [m for m in messages if m["role"] == "assistant" and m["id"] not in previous]
        if not fresh:
            raise ClaudeError(
                "A new assistant reply is not confirmed. Read this chat before sending again.",
                code="response_pending",
            )
        return body, messages, fresh[-1], complete


@contextmanager
def connection(store, timeout):
    saved = store.load()
    if saved is None:
        raise ClaudeError("Run login --provider chatgpt first.", code="login_required")
    client = ChatGPTHttp(saved, timeout=timeout, preparations=Preparations(store.directory))
    failed = False
    try:
        client.authenticate()
        yield client
    except BaseException:
        failed = True
        raise
    finally:
        try:
            updated = client.saved_state()
            if updated != saved:
                store.save(updated)
        except (OSError, ClaudeError):
            if not failed:
                raise ClaudeError(
                    "The HTTP operation finished, but rotated login cookies could not be saved. Do not automatically resend a message.",
                    code="session_save_failed",
                ) from None
        finally:
            client.close()
