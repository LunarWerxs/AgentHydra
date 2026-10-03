"""Plain-text view of `hswarm savings`: one line per day, the totals, and the 30-day projection."""
from __future__ import annotations

from collections.abc import Callable

COLUMNS = (("day", 12), ("jobs/tasks", 11), ("DeepSeek", 10), ("Claude", 11), ("subs", 7),
           ("avoided", 21), ("net saved", 21), ("share", 14))


def usd(v: float | None) -> str:
    """'-' is NOT MEASURED, never zero; a tiny cost keeps its first two significant digits, so a $0.000003
    ask never prints as $0.0000 (Michael, 2026-09-16: "was it actually free?")."""
    if v is None:
        return "-"
    if v == 0:
        return "$0"
    a = abs(v)
    if a >= 1:
        return f"${v:,.2f}"
    if a >= 0.01:
        return f"${v:.4f}"
    if a >= 0.000001:
        return f"${v:.6f}".rstrip("0")
    return "<$0.000001" if v > 0 else ">-$0.000001"


def pct(v: float | None) -> str:
    return "-" if v is None else "0%" if v == 0 else f"{v * 100:.1f}%"


def span(lo: float | None, hi: float | None, fmt: Callable[[float | None], str] = usd) -> str:
    if lo is None or hi is None:
        return "-"
    return fmt(lo) if lo == hi else f"{fmt(lo)}-{fmt(hi)}"


def _line(cells: list[str]) -> str:
    return "".join(c.ljust(w) if i == 0 else c.rjust(w) for i, (c, (_, w)) in enumerate(zip(cells, COLUMNS)))


def _day(d: dict) -> str:
    return _line([
        d["day"] + ("*" if d.get("partial") else ""),
        f"{d['hswarm_jobs']}/{d['hswarm_tasks']}",
        usd(d["deepseek_usd"]),
        usd(d["claude_usd"]),
        str(d["claude_subagents"]),
        span(d.get("avoided_low_usd"), d.get("avoided_high_usd")),
        span(d.get("net_saved_low_usd"), d.get("net_saved_high_usd")),
        span(d.get("claude_share_displaced_low"), d.get("claude_share_displaced_high"), pct),
    ])


def _month(m: dict | None) -> str:
    if not m:
        return "30-day projection: needs one completed day of hswarm use."
    return (f"30-day projection (from {m['active_days']} day(s) of hswarm use): DeepSeek {usd(m['deepseek_usd'])}, "
            f"Claude {usd(m['claude_usd'])}, avoided {span(m['avoided_low_usd'], m['avoided_high_usd'])}, "
            f"net saved {span(m['net_saved_low_usd'], m['net_saved_high_usd'])}")


def render(s: dict) -> str:
    from . import utilization  # here, not at import: utilization borrows usd() from this module

    cf, t = s["per_subagent"], s["totals"]
    out = [utilization.render(s["running_total"]), ""] if s.get("running_total") else []
    out += [f"One real Claude sub-agent on this machine: {usd(cf['usd'])} (median of {cf['sample']}, {cf['basis']})", ""]
    out += [_line([name for name, _ in COLUMNS]), "-" * sum(w for _, w in COLUMNS)]
    out += [_day(d) for d in s["days"]]
    out += ["", f"total over {t['days']} day(s): DeepSeek {usd(t['deepseek_usd'])}, Claude {usd(t['claude_usd'])}, "
                f"avoided {span(t['avoided_low_usd'], t['avoided_high_usd'])}, net saved {span(t['net_saved_low_usd'], t['net_saved_high_usd'])}",
            _month(s["month"]), "", s["note"], f"history: {s['file']}"]
    return "\n".join(out)
