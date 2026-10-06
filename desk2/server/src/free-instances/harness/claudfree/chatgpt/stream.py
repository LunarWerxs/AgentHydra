"""Consume ChatGPT control events while discarding streamed content deltas.

The final transcript comes from an authenticated GET after completion. Delta-v1
content is deliberately not reconstructed, exposed or persisted. The encoding
announcement is a scalar, unlike Claude's JSON-object events.
"""

import json

from ..errors import ClaudeError
from ..sse import frames


def events(lines):
    delta_v1 = False
    for name, raw in frames(lines):
        if name == "delta_encoding":
            if raw.strip() not in {"v1", '"v1"'}:
                raise ClaudeError("Unknown ChatGPT stream encoding.", code="invalid_response")
            delta_v1 = True
            continue
        if name == "delta":
            if not delta_v1:
                raise ClaudeError(
                    "ChatGPT delta encoding was not announced.", code="invalid_response"
                )
            continue
        if raw == "[DONE]":
            yield {"type": "done"}
            continue
        if not raw:
            continue
        try:
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError()
            kind = body.get("type", name)
            if not isinstance(kind, str):
                raise ValueError()
        except ValueError:
            raise ClaudeError(
                "ChatGPT returned an invalid control event.", code="invalid_response"
            ) from None
        # No text, hidden reasoning, resume token or arbitrary metadata escapes.
        control = {"type": kind}
        if "conversation_id" in body:
            control["conversation_id"] = body["conversation_id"]
        if body.get("error"):
            control["error"] = True
        yield control
