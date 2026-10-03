"""A key's input-tokens-per-minute limit, per model, and whether a cc worker can start on it.

2026-10-02 and 10-03: hswarm_select { profile: code or critical, backend: cc } offered anthropic-direct Opus legs on
the one live Anthropic key, whose organisation allows 10,000 input tokens a minute, and all five tasks sent there died
in 5-37 s of "429 ... rate limit of 10,000 input tokens per minute (model: claude-opus-5-5)". A headless Claude Code
worker's first turn is its system prompt, tools and the repo's instructions: tens of thousands of tokens before it
reads a file, so on that key a cc task can never start, however long it waits.

The limit is learnt two ways and kept in config.HOME/input_limits.json, shared by every hswarm process on the machine
(keyed by fingerprint, never the key): Anthropic's `anthropic-ratelimit-input-tokens-limit` header on any api call
(client.py), and the 429 a cc worker dies of (jobs._run_cc_with_rotation). A key whose limit is under
config.CC_FIRST_TURN_TOKENS is skipped by the cc rotation, and a cc leg whose every live key is short is listed under
`unavailable` by the planner (dispatch._plan) and refused at submit (dispatch.unreachable). A reading ages out after
KEEP_S, so a raised tier is found again by one task, not never.
"""
from __future__ import annotations

import json
import os
import re
import time

from . import config

KEEP_S = 3 * 86400.0
HEADER = "anthropic-ratelimit-input-tokens-limit"
# Claude Code's rendering of Anthropic's 429: "... rate limit of 10,000 input tokens per minute (model: claude-opus-5-5)".
_SAID = re.compile(r"rate limit of ([\d,]+) input tokens per minute(?:\s*\(model:\s*([\w.:/-]+)\))?", re.I)
_CACHE: dict = {"sig": None, "data": {}}


def _path():
    return config.HOME / "input_limits.json"


def _read() -> dict:
    """{api model: {fingerprint: [limit, learnt at]}}; a missing or half-written file is no reading."""
    path = _path()
    try:
        st = path.stat()
        sig = (str(path), st.st_mtime_ns, st.st_size)
        # A file written in the last two seconds is read again: a Windows clock tick can stamp two writes alike.
        if sig == _CACHE["sig"] and time.time() - st.st_mtime_ns / 1e9 > 2.0:
            return _CACHE["data"]
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    _CACHE.update(sig=sig, data=data if isinstance(data, dict) else {})
    return _CACHE["data"]


def note(key: str, model: str, limit: int, now: float | None = None) -> None:
    """Remember `key`'s limit for `model`. Written only when it changed or is half its age, so a header read on every
    api call costs no write."""
    now = time.time() if now is None else now
    fp = config.fingerprint(key)
    data = _read()
    old = (data.get(model) or {}).get(fp)
    if old and int(old[0]) == int(limit) and now - float(old[1]) < KEEP_S / 2:
        return
    data = {m: dict(v) for m, v in data.items()}
    data.setdefault(model, {})[fp] = [int(limit), now]
    path = _path()
    tmp = path.with_name(f"input_limits.{os.getpid()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)  # a hint, never a failure


def from_error(key: str, model: str, text: str | None) -> int | None:
    """The limit a 429's text names, recorded against the model it names (else `model`); None when it names none."""
    said = _SAID.search(text or "")
    if not said:
        return None
    limit = int(said[1].replace(",", ""))
    note(key, said[2] or model, limit)
    return limit


def from_headers(key: str, model: str, headers) -> None:
    raw = headers.get(HEADER) if headers is not None else None
    if raw and str(raw).strip().isdigit():
        note(key, model, int(str(raw).strip()))


def limit(key: str, model: str, now: float | None = None) -> int | None:
    reading = (_read().get(model) or {}).get(config.fingerprint(key))
    if not reading or (time.time() if now is None else now) - float(reading[1]) > KEEP_S:
        return None
    return int(reading[0])


def too_small_for_cc(key: str, model: str) -> bool:
    n = limit(key, model)
    return n is not None and n < config.CC_FIRST_TURN_TOKENS


def api_model(name: str) -> str:
    return config.MODELS.get(name, {}).get("api_id") or name


def why_short(limits: list[int], model: str) -> str:
    top = max(limits)
    return (f"every live key allows {'at most ' if len(set(limits)) > 1 else ''}{top:,} input tokens per minute for {model}, "
            f"under a cc worker's first turn (~{config.CC_FIRST_TURN_TOKENS:,} tokens), so no cc task can start on it; "
            "send Claude-quality work to CliMayte instead")


def cc_short(name: str) -> str | None:
    """Why no cc worker can start on model `name` here, or None: every key of its provider that is not disabled has a
    known input-tokens-per-minute limit under config.CC_FIRST_TURN_TOKENS. A key with no reading yet may fit, and a
    provider whose keys are all disabled is unavailable for that reason instead (dispatch._why_not)."""
    from . import keys

    model = api_model(name)
    readings = _read().get(model)
    if not readings:
        return None  # the common case, answered without touching a key pool
    entry = config.MODELS.get(name)
    pool = keys.pool_for(entry["provider"]) if entry else None
    if pool is None:
        return None
    short = {k: n for k in pool.keys if (n := limit(k, model)) is not None and n < config.CC_FIRST_TURN_TOKENS}
    if not short or pool.live_besides(set(short)) or not pool.live_besides(set(pool.keys) - set(short)):
        return None
    return why_short(list(short.values()), model)
