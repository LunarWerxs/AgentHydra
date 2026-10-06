"""Normalize observed usage counters; keep cached readings explicitly historical."""

from datetime import datetime, timezone
import json
import math
from pathlib import Path

from .registry import chat_lock


WINDOW_NAMES = {"5h": "five_hour", "7d": "seven_day", "session": "five_hour"}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def timestamp(value) -> str | None:
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            result = datetime.fromtimestamp(value, timezone.utc)
        elif isinstance(value, str):
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if result.tzinfo is None:
                return None
        else:
            return None
        return result.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def percent(value, *, fraction=False) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        finite = math.isfinite(value)
    except OverflowError:
        # Malformed optional counters must not interrupt a valid chat stream.
        return None
    if not finite or value < 0 or (fraction and value > 1):
        return None
    return round(value * 100 if fraction else value, 4)


def window(key, used, reset, status, source_field) -> dict:
    return {
        "id": key,
        "used_percent": used,
        "remaining_percent": round(max(0, 100 - used), 4) if used is not None else None,
        "resets_at": timestamp(reset),
        "status": status if isinstance(status, str) else None,
        "source_field": source_field,
    }


def snapshot(source, windows, observed_at=None) -> dict:
    return {
        "source": source,
        "observed_at": timestamp(observed_at) or now_utc().isoformat(),
        "windows": list(windows),
        "exact_remaining_messages": None,
    }


def from_stream(message_limit: dict, *, observed_at=None) -> dict | None:
    if not isinstance(message_limit, dict):
        return None
    windows = {}
    raw_windows = message_limit.get("windows")
    if isinstance(raw_windows, dict):
        for key, item in raw_windows.items():
            if key not in {"5h", "7d"} or not isinstance(item, dict):
                continue
            canonical = WINDOW_NAMES[key]
            windows[canonical] = window(
                canonical,
                percent(item.get("utilization"), fraction=True),
                item.get("resets_at"),
                item.get("status"),
                f"windows.{key}.utilization",
            )
    resolved = message_limit.get("resolved")
    limit = resolved.get("limit") if isinstance(resolved, dict) else None
    if isinstance(limit, dict):
        # Only map explicitly recognized scopes. A model/tool quota is not the
        # overall session allowance, even if its representative claim is 5h.
        kind = limit.get("kind")
        if not isinstance(kind, str):
            kind = None
        key = WINDOW_NAMES.get(kind) if isinstance(kind, str) else None
        if kind in {"weekly", "week"}:
            key = "seven_day"
        if key and limit.get("scope") is None and limit.get("is_active") is not False:
            used = percent(limit.get("percent"))
            prior = windows.get(key)
            if used is not None:
                current = window(
                    key,
                    used,
                    limit.get("resets_at"),
                    resolved.get("status"),
                    "resolved.limit.percent",
                )
                if prior:
                    # Preserve differing server counters without guessing why
                    # their rounding/timing differs.
                    current["window_reported_used_percent"] = prior["used_percent"]
                    current["resets_at"] = current["resets_at"] or prior["resets_at"]
                windows[key] = current
    if not any(w["used_percent"] is not None or w["resets_at"] for w in windows.values()):
        return None
    return snapshot("chat_stream", windows.values(), observed_at)


def from_dashboard(body: dict, *, observed_at=None) -> dict:
    windows = []
    for key, item in body.items():
        if not key.startswith(("five_hour", "seven_day")) or not isinstance(item, dict):
            continue
        windows.append(
            window(
                key,
                percent(item.get("utilization")),
                item.get("resets_at"),
                item.get("status"),
                f"{key}.utilization",
            )
        )
    return snapshot("usage_endpoint", windows, observed_at)


def read_cache(path: Path, org: str) -> dict | None:
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
        value = body.get(org) if isinstance(body, dict) else None
        if (
            isinstance(value, dict)
            and value.get("source") == "chat_stream"
            and timestamp(value.get("observed_at"))
            and isinstance(value.get("windows"), list)
            and all(isinstance(w, dict) for w in value["windows"])
        ):
            cleaned = []
            for item in value["windows"]:
                key = item.get("id")
                if not isinstance(key, str) or not key.startswith(("five_hour", "seven_day")):
                    continue
                entry = window(
                    key,
                    percent(item.get("used_percent")),
                    item.get("resets_at"),
                    item.get("status"),
                    item.get("source_field"),
                )
                if "window_reported_used_percent" in item:
                    entry["window_reported_used_percent"] = percent(
                        item["window_reported_used_percent"]
                    )
                cleaned.append(entry)
            if any(w["used_percent"] is not None or w["resets_at"] for w in cleaned):
                return snapshot("chat_stream", cleaned, timestamp(value["observed_at"]))
    except (OSError, ValueError):
        pass
    return None


def save_cache(api, org: str, value: dict):
    path = api.HTTP_CONFIG_FILE.parent / "usage-cache.json"
    with chat_lock(path.parent / "locks", "usage", wait=5):
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(existing, dict):
                existing = {}
        except (OSError, ValueError):
            existing = {}
        old = read_cache(path, org)
        if old and datetime.fromisoformat(old["observed_at"]) > datetime.fromisoformat(
            value["observed_at"]
        ):
            return
        existing[org] = value
        api.atomic_write(path, json.dumps(existing, indent=2).encode("utf-8"))


def report(body: dict, cached: dict | None, *, now=None) -> dict:
    now = now or now_utc()
    checked = from_dashboard(body, observed_at=now.isoformat())
    usable = any(w["used_percent"] is not None or w["resets_at"] for w in checked["windows"])
    chosen = checked if usable else cached
    result = {
        **(chosen or snapshot("unavailable", [], now.isoformat())),
        "available": chosen is not None,
        "is_snapshot": not usable and cached is not None,
        "usage_endpoint_counters_available": usable,
        "member_dashboard_available": body.get("member_dashboard_available"),
        "checked_at": now.isoformat(),
        "age_seconds": None,
        "exact_remaining_messages": None,
    }
    if chosen is None:
        result["observed_at"] = None
    if chosen:
        result["age_seconds"] = max(
            0, int((now - datetime.fromisoformat(chosen["observed_at"])).total_seconds())
        )
    result["windows"] = [
        {
            **w,
            "reset_passed": datetime.fromisoformat(w["resets_at"]) <= now
            if w.get("resets_at")
            else None,
        }
        for w in result["windows"]
    ]
    result["note"] = (
        "Last chat-stream observation; other account activity may have changed usage. "
        "Passed reset times do not imply a new zero-usage reading."
        if result["is_snapshot"]
        else "No usage counters exposed. A future chat may supply a timestamped stream observation."
        if not result["available"]
        else "Usage endpoint observation; remaining message count depends on message cost."
    )
    return result
