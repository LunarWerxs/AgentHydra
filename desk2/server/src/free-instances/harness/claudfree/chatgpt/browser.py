"""Headless Temporary Chats. Live tabs retain context; transcripts stay in memory."""

import asyncio
from dataclasses import dataclass, field
import json
import re
import time
from urllib.parse import urlsplit
from uuid import UUID

from ..browser import launch_browser
from ..errors import ClaudeError
from ..registry import valid_name
from .registry import ChatGPTRegistry

SEND_PATHS = {"/backend-api/f/conversation", "/backend-api/conversation"}
MESSAGE_SELECTOR = "[data-message-author-role][data-message-id]"
EXTRACT_MESSAGES = """els => els.map(e => ({
    id: e.getAttribute('data-message-id'), role: e.getAttribute('data-message-author-role'),
    model: e.getAttribute('data-message-model-slug'), text: e.innerText,
    code_blocks: Array.from(e.querySelectorAll('pre code')).map(c => ({
        language: (c.className.match(/language-([\\w+-]+)/)||[])[1] || '', code: c.textContent
    })),
    citations: Array.from(e.querySelectorAll('a[href]')).filter(a => /^https?:/.test(a.href))
        .map(a => ({url:a.href,title:a.innerText || a.getAttribute('aria-label') || a.href}))
}))"""


async def open_temporary_page(context):
    """Open the normal website and select its visible private controls."""
    page = await context.new_page()
    try:
        await page.goto(
            "https://chatgpt.com/?temporary-chat=true",
            wait_until="domcontentloaded",
            timeout=60000,
        )
        await page.get_by_role("button", name="Turn off temporary chat", exact=True).wait_for(
            state="visible", timeout=45000
        )
        intro = page.get_by_role("dialog").filter(
            has=page.get_by_role("heading", name="Temporary chat", exact=True)
        )
        await asyncio.sleep(0.5)
        if await intro.is_visible():
            await intro.get_by_role("button", name="Continue", exact=True).click()
        personalized = page.get_by_role("button", name="Personalized", exact=True)
        if await personalized.is_visible():
            await personalized.click()
            await page.get_by_role("menuitemradio", name=re.compile(r"^Unpersonalized\b")).click()
        await page.get_by_role("button", name="Unpersonalized", exact=True).wait_for(
            state="visible", timeout=15000
        )
        return page
    except BaseException:
        await page.close()
        raise


def stream_summary(raw: str) -> dict:
    """Read only completion/UUID metadata. Never expose stream authentication tokens."""
    result = {"complete": False, "server_conversation_id": None}
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            value = json.loads(line[5:])
        except ValueError:
            continue
        if not isinstance(value, dict):
            continue
        candidate = value.get("conversation_id")
        if candidate:
            try:
                result["server_conversation_id"] = str(UUID(candidate))
            except (ValueError, TypeError, AttributeError):
                pass
        if value.get("type") == "message_stream_complete":
            result["complete"] = True
        if value.get("error") or value.get("type") == "error":
            result["failed"] = True
    result["complete"] = result["complete"] and not result.get("failed", False)
    return result


@dataclass
class LiveChat:
    page: object
    messages: dict = field(default_factory=dict)
    observation: dict = field(default_factory=dict)
    pending: asyncio.Task | None = None
    awaiting: bool = False
    privacy_blocked: bool = False
    started: bool = False
    server_id: str | None = None


class BrowserChats:
    """Own one browser context and one independently resumable tab per local handle."""

    def __init__(self, store, *, headless=True):
        self.store = store
        self.registry = ChatGPTRegistry(store.directory)
        self.live: dict[str, LiveChat] = {}
        self.pw = self.browser = self.context = None
        self.headless = headless

    async def start(self):
        if self.context is not None:
            return
        saved = self.store.load()
        if saved is None:
            raise ClaudeError("Run login --provider chatgpt first.", code="login_required")
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise ClaudeError(
                "Install browser support: pip install -e '.[browser]'", code="missing_dependency"
            ) from None
        self.pw = await async_playwright().start()
        try:
            self.browser = await launch_browser(self.pw, "camoufox", headless=self.headless)
            self.context = await self.browser.new_context(
                storage_state=saved, viewport={"width": 1280, "height": 900}
            )
        except BaseException:
            try:
                if self.browser:
                    await self.browser.close()
            finally:
                await self.pw.stop()
                self.pw = self.browser = self.context = None
            raise

    def resolve(self, reference: str) -> dict:
        return self.registry.resolve(reference)[0]

    def metadata(self, entry: dict) -> dict:
        row = self.registry.db.execute(
            "SELECT server_id FROM chatgpt_ids WHERE chat_id=?", (entry["chat_id"],)
        ).fetchone()
        chat = self.live.get(entry["chat_id"])
        available = chat is not None and not chat.page.is_closed()
        return {
            **{k: v for k, v in entry.items() if k != "organization_id"},
            "server_conversation_id": (chat.server_id if chat else None)
            or (row[0] if row else None),
            "resumable": available,
            "status": "available" if available else "closed",
        }

    def active(self, entry):
        chat = self.live.get(entry["chat_id"])
        if chat is None or chat.page.is_closed():
            raise ClaudeError(
                "This browser tab is closed. Use HTTP read with the saved login; browser continuation needs a live tab.",
                code="chat_closed",
                chat_id=entry["chat_id"],
            )
        return chat

    async def guard(self, page, *, chat_id=None, started=False):
        # After the first turn, ChatGPT replaces the mode controls with Save chat.
        # Continuations also have their conversation UUID and privacy flags checked
        # at the network boundary, before the browser may transmit them.
        if started and await page.get_by_role("button", name="Save chat", exact=True).is_visible():
            return
        if not await page.get_by_role(
            "button", name="Turn off temporary chat", exact=True
        ).is_visible():
            raise ClaudeError(
                "Temporary Chat could not be verified. No message was sent.",
                code="privacy_not_verified",
                chat_id=chat_id,
            )
        if not await page.get_by_role("button", name="Unpersonalized", exact=True).is_visible():
            raise ClaudeError(
                "Unpersonalized mode could not be verified. No message was sent.",
                code="privacy_not_verified",
                chat_id=chat_id,
            )

    async def create(self, chat_id, name):
        if name:
            name = valid_name(name)
            if self.registry.by_name(name):
                raise ClaudeError(
                    "That name already identifies a chat. Resume it or choose an unused name.",
                    code="name_conflict",
                )
        if len(self.live) >= 16:
            raise ClaudeError(
                "Close an existing ChatGPT chat before opening another (16 live tabs maximum).",
                code="chat_limit",
            )
        await self.start()
        page = await open_temporary_page(self.context)
        try:
            await self.guard(page, chat_id=chat_id)
            chat = LiveChat(page)

            async def protect(route):
                request = route.request
                if urlsplit(request.url).path in SEND_PATHS and request.method == "POST":
                    try:
                        payload = request.post_data_json
                    except Exception:
                        payload = None
                    invalid = (
                        not isinstance(payload, dict)
                        or payload.get("history_and_training_disabled") is not True
                    )
                    if not invalid:
                        invalid = payload.get("temporary_chat_requests_personalization") is True
                        if chat.started:
                            invalid = (
                                invalid
                                or not chat.server_id
                                or payload.get("conversation_id") != chat.server_id
                            )
                        else:
                            invalid = (
                                invalid
                                or payload.get("temporary_chat_requests_personalization")
                                is not False
                                or bool(payload.get("conversation_id"))
                            )
                    if invalid:
                        chat.privacy_blocked = True
                        await route.abort()
                        return
                    chat.started = True
                await route.fallback()

            async def capture(response):
                try:
                    chat.observation = {"http_status": response.status, "complete": False}
                    if response.status == 200:
                        chat.observation.update(stream_summary(await response.text()))
                except Exception:
                    # Browser exceptions may include private URLs or headers.
                    chat.observation["complete"] = False
                if chat.observation.get("server_conversation_id"):
                    chat.server_id = chat.observation["server_conversation_id"]
                    try:
                        self.registry.link(chat_id, chat.server_id)
                        # Temporary Chats have per-chat access cookies. Persist them
                        # encrypted so HTTP reads can survive closing this browser.
                        self.store.save(await self.context.storage_state(indexed_db=True))
                    except Exception:
                        chat.observation["metadata_save_failed"] = True

            def observe(response):
                if urlsplit(response.url).path in SEND_PATHS and response.request.method == "POST":
                    chat.pending = asyncio.create_task(capture(response))

            await page.route("**/backend-api/**", protect)
            page.on("response", observe)
            entry = self.registry.record(chat_id, "chatgpt", name=name, temporary=True)
            self.live[chat_id] = chat
            return entry
        except BaseException:
            await page.close()
            raise

    async def refresh(self, entry):
        chat = self.active(entry)
        messages = await chat.page.locator(MESSAGE_SELECTOR).evaluate_all(EXTRACT_MESSAGES)
        for message in messages:
            if (
                message["role"] not in {"user", "assistant"}
                or message["id"].startswith("request-placeholder")
                or not message["text"]
            ):
                continue
            message.update({"content": [], "tool_calls": [], "tool_results": []})
            chat.messages[message["id"]] = message
        if chat.pending is not None and chat.pending.done():
            chat.awaiting = False
        return list(chat.messages.values())

    async def read(self, entry):
        messages = await self.refresh(entry)
        chat = self.active(entry)
        metadata = self.metadata(entry)
        return {
            "chat_id": entry["chat_id"],
            "chat_name": entry["name"],
            "server_conversation_id": metadata["server_conversation_id"],
            "is_temporary": True,
            "personalization": False,
            "resumable": True,
            "messages": messages,
            "incomplete": chat.awaiting or not chat.observation.get("complete", False),
            "extraction": "rendered_messages",
            "raw_tool_results_available": False,
        }

    async def send(self, entry, prompt, timeout):
        chat = self.active(entry)
        await self.refresh(entry)
        if chat.awaiting:
            raise ClaudeError(
                "A response is still pending. Read this chat before sending again.",
                code="chat_busy",
                chat_id=entry["chat_id"],
                retryable=True,
            )
        await self.guard(chat.page, chat_id=entry["chat_id"], started=chat.started)
        old_ids = set(chat.messages)
        await chat.page.get_by_role("textbox", name="Chat with ChatGPT", exact=True).fill(prompt)
        chat.pending = None
        chat.observation = {}
        chat.awaiting = True
        chat.privacy_blocked = False
        try:
            await chat.page.get_by_role("button", name="Send prompt", exact=True).click(
                timeout=10000
            )
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if chat.privacy_blocked:
                    chat.awaiting = False
                    raise ClaudeError(
                        "The browser tried to send without the required privacy flags. The request was blocked.",
                        code="privacy_not_verified",
                        chat_id=entry["chat_id"],
                    )
                status = chat.observation.get("http_status", 200)
                if status != 200:
                    chat.awaiting = False
                    raise ClaudeError(
                        "ChatGPT rejected the browser request. No automatic retry was made.",
                        code="chatgpt_request_failed",
                        status=status,
                        chat_id=entry["chat_id"],
                    )
                messages = await self.refresh(entry)
                fresh = [
                    m
                    for m in messages
                    if m["role"] == "assistant" and m["id"] not in old_ids and m["text"]
                ]
                if (
                    fresh
                    and chat.observation.get("complete")
                    and (chat.pending is None or chat.pending.done())
                ):
                    break
                await asyncio.sleep(0.25)
            else:
                messages = await self.refresh(entry)
                fresh = [
                    m
                    for m in messages
                    if m["role"] == "assistant" and m["id"] not in old_ids and m["text"]
                ]
            if not fresh:
                raise ClaudeError(
                    "The reply is not confirmed yet. Read this chat; do not resend automatically.",
                    code="response_pending",
                    chat_id=entry["chat_id"],
                )
            message = fresh[-1]
            warnings = []
            if chat.observation.get("metadata_save_failed"):
                warnings.append(
                    {
                        "code": "metadata_save_failed",
                        "message": "The server UUID could not be saved locally. Keep both returned IDs.",
                    }
                )
            try:
                entry = self.registry.record(
                    entry["chat_id"], "chatgpt", model=message.get("model"), temporary=True
                )
            except Exception:
                warnings.append(
                    {
                        "code": "metadata_save_failed",
                        "message": "The reply was received, but metadata could not be updated. Keep its chat_id.",
                    }
                )
            return {
                **await self.read(entry),
                "response": message["text"],
                "model": message.get("model"),
                "citations": message["citations"],
                "code_blocks": message["code_blocks"],
                "tools_used": [],
                "warnings": warnings,
            }
        except ClaudeError:
            raise
        except Exception:
            raise ClaudeError(
                "The browser operation ended with an uncertain result. Read this chat before sending again.",
                code="response_pending",
                chat_id=entry["chat_id"],
            ) from None

    async def execute(self, request):
        command = request["command"]
        if command == "chats":
            return {"chats": [self.metadata(entry) for entry in self.registry.list()]}
        if command == "chat" and not request.get("reference"):
            entry = await self.create(request["chat_id"], request.get("name"))
        else:
            entry = self.resolve(request.get("reference") or "last")
        if command in {"chat", "resume"}:
            return await self.send(entry, request["prompt"], request["timeout"])
        if command == "read":
            return await self.read(entry)
        if command == "track":
            self.active(entry)
            entry = self.registry.record(
                entry["chat_id"], "chatgpt", name=request["name"], temporary=True, touch=False
            )
            return {**self.metadata(entry), "chat_name": entry["name"]}
        if command == "close":
            chat = self.live.pop(entry["chat_id"], None)
            if chat:
                if chat.pending:
                    chat.pending.cancel()
                    await asyncio.gather(chat.pending, return_exceptions=True)
                await chat.page.close()
            self.registry.status(entry["chat_id"], "closed")
            return {"chat_id": entry["chat_id"], "closed": True, "resumable": False}
        raise ClaudeError("Unknown ChatGPT worker operation.", code="invalid_arguments")

    async def close(self):
        for chat in self.live.values():
            if chat.pending:
                chat.pending.cancel()
                await asyncio.gather(chat.pending, return_exceptions=True)
        try:
            if self.context:
                self.store.save(await self.context.storage_state(indexed_db=True))
        finally:
            try:
                if self.browser:
                    await self.browser.close()
            finally:
                if self.pw:
                    await self.pw.stop()
                self.registry.close()
