"""Small Claude and ChatGPT account clients; optional providers load on demand."""

from .api import Client
from .errors import ClaudeError

__all__ = ["Client", "ChatGPTClient", "ClaudeError"]
__version__ = "0.7.0"


def __getattr__(name):
    if name == "ChatGPTClient":
        from .chatgpt.api import ChatGPTClient

        return ChatGPTClient
    raise AttributeError(name)
