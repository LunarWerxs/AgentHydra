"""Windows local named-pipe worker. Authenticated JSON only; never unpickles input."""

import asyncio
import base64
import json
from multiprocessing import AuthenticationError
from multiprocessing.connection import Client as PipeClient, Listener
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from uuid import uuid4

from ..errors import ClaudeError
from ..registry import chat_lock
from ..state import atomic_write, dpapi
from .state import ChatGPTState

MAGIC = b"CLAUDFREE-CHATGPT-WORKER-1\0"
MAX_PACKET = 16 * 1024 * 1024
PIPE_PREFIX = "\\\\.\\pipe\\claudfree-chatgpt-"


def descriptor(store):
    path = store.directory / "worker.dpapi"
    if not path.exists():
        return None
    try:
        data = path.read_bytes()
        if not data.startswith(MAGIC):
            raise ValueError()
        value = json.loads(dpapi(data[len(MAGIC) :], decrypt=True))
        if (
            not value["address"].startswith(PIPE_PREFIX)
            or len(base64.b64decode(value["key"], validate=True)) != 32
        ):
            raise ValueError()
        return value
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ClaudeError("Invalid ChatGPT worker descriptor.", code="invalid_state") from None


def connect(value):
    return PipeClient(value["address"], family="AF_PIPE", authkey=base64.b64decode(value["key"]))


def request(store, payload, *, start=True):
    """Serialize local commands. A sent request is never retried after connection loss."""
    timeout = payload.get("timeout", 120)
    packet = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(packet) > MAX_PACKET:
        raise ClaudeError(
            "The request exceeds the local worker's 16 MiB limit.", code="invalid_arguments"
        )
    with chat_lock(store.directory / "locks", "worker-client", wait=timeout + 90):
        connection = None
        value = descriptor(store)
        if value:
            try:
                connection = connect(value)
            except FileNotFoundError:
                pass  # A stale descriptor after a terminated worker can be replaced.
            except (OSError, EOFError, AuthenticationError):
                raise ClaudeError(
                    "The existing ChatGPT worker could not be authenticated or reached. Its chats have not been closed.",
                    code="worker_unavailable",
                ) from None
        if connection is None:
            if not start:
                return {"stopped": True}
            store.directory.mkdir(parents=True, exist_ok=True)
            # CLI/Python/MCP callers may run from any working directory.
            process = subprocess.Popen(
                [sys.executable, "-m", "claudfree.chatgpt.worker", str(store.directory)],
                cwd=str(Path(__file__).resolve().parents[2]),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise ClaudeError(
                        "The ChatGPT worker could not start.", code="worker_unavailable"
                    )
                candidate = descriptor(store)
                if candidate and candidate != value:
                    try:
                        connection = connect(candidate)
                        break
                    except (OSError, EOFError):
                        pass
                time.sleep(0.1)
            if connection is None:
                raise ClaudeError(
                    "The ChatGPT worker did not become ready.", code="worker_unavailable"
                )
        try:
            connection.send_bytes(packet)
            if not connection.poll(timeout + 90):
                raise OSError()
            result = json.loads(connection.recv_bytes(MAX_PACKET))
        except (OSError, EOFError, ValueError):
            raise ClaudeError(
                "The worker response is uncertain. Read the chat before sending again; no automatic retry was made.",
                code="worker_response_lost",
                chat_id=payload.get("chat_id") or payload.get("reference"),
            ) from None
        finally:
            connection.close()
        if not result["ok"]:
            error = result["error"]
            raise ClaudeError(
                error["message"],
                code=error["code"],
                status=error.get("http_status"),
                chat_id=error.get("chat_id"),
                retryable=error.get("retryable", False),
            )
        return result["result"]


async def serve(store):
    from .browser import BrowserChats

    value = {
        "address": PIPE_PREFIX + str(uuid4()),
        "key": base64.b64encode(secrets.token_bytes(32)).decode(),
    }
    path = store.directory / "worker.dpapi"
    with chat_lock(store.directory / "locks", "worker-process"):
        listener = Listener(
            value["address"], family="AF_PIPE", authkey=base64.b64decode(value["key"])
        )
        driver = BrowserChats(store)
        atomic_write(path, MAGIC + dpapi(json.dumps(value).encode()))
        stopping = False
        try:
            while not stopping:
                try:
                    connection = await asyncio.to_thread(listener.accept)
                except (OSError, EOFError, AuthenticationError):
                    continue
                payload = {}
                response = None
                try:
                    if not await asyncio.to_thread(connection.poll, 10):
                        continue
                    payload = json.loads(await asyncio.to_thread(connection.recv_bytes, MAX_PACKET))
                    if payload.get("command") == "stop":
                        stopping = True
                        await driver.close()
                        path.unlink(missing_ok=True)
                        result = {"stopped": True}
                    else:
                        result = await driver.execute(payload)
                    response = {"ok": True, "result": result}
                except ClaudeError as error:
                    response = {"ok": False, "error": error.as_dict()}
                except Exception:
                    response = {
                        "ok": False,
                        "error": {
                            "code": "browser_operation_failed",
                            "retryable": False,
                            "message": "The ChatGPT page could not be operated. Login may have expired or the UI may have changed. No message was retried.",
                            **(
                                {"chat_id": payload["chat_id"]}
                                if isinstance(payload, dict) and payload.get("chat_id")
                                else {}
                            ),
                        },
                    }
                finally:
                    # A caller can disconnect after a timeout without killing other chats.
                    try:
                        if response is not None:
                            await asyncio.to_thread(
                                connection.send_bytes,
                                json.dumps(response, ensure_ascii=False).encode("utf-8"),
                            )
                    except (OSError, EOFError):
                        pass
                    connection.close()
                    response = None
        finally:
            listener.close()
            if not stopping:
                await driver.close()
            if descriptor(store) == value:
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    asyncio.run(serve(ChatGPTState(sys.argv[1])))
