"""One self-contained HTML page from the utilization DB, so the running total can be looked at instead of
asked for (owner ask, Michael, 2026-09-16). Written to ~/.hswarm/hswarm.html by `hswarm savings`, `hswarm
sync` and the daily task; no server, no dependencies, opens in any browser.

Shape (Michael, 2026-09-16, on the first version: "a giant-ass wall of text ... we need charts, graphs,
text hierarchy"): one hero figure, a row of stat tiles, charts, the explanations folded away, then the
tables. Every run has a number that never changes so it can be referred to. Dark theme; a saving is green
and a loss red; est. Claude sits left of DeepSeek cost, because saved = est. Claude - DeepSeek cost and the
reader wants to see the subtraction in that order. Chart colours are the dataviz skill's validated dark
categorical slots 1 and 2 on this surface; status green/red only where the number IS a status.

THREE UNITS, one switch (owner ask, Michael, 2026-09-17: "add a toggle to allow me to see savings via
money, tokens, and money ... weighted based on the Claude account $200 plan"):
  - List-price $: what the API would have billed. The old page's only unit.
  - Tokens: what a subscription actually rations, and the honest answer to "how much did we not spend".
  - Plan $: a list dollar converted at what the subscriptions really cost per list dollar, counting only
    the accounts that DID work, on the days they worked (owner ask, same message). The DeepSeek bill is
    real money and is never weighted, so the plan view is the one that can go negative.
Every number is rendered in all three units and the switch only hides; nothing is computed in the browser.
Accounts appear as `acct-<hash>` - never an email, never a name, never a recycled instance number.
"""
from __future__ import annotations

import datetime as dt
import html
import math
from pathlib import Path

from . import accounts, config, utilization
from .savings_view import usd
from .utilization import big, local_dt, local_min

MAX_ROWS = 5000
SWARM, CLAUDE = "#3987e5", "#d95926"  # categorical slots 1 and 2 (dark), validated on the panel surface 2026-09-16
GOOD, BAD = "#0ca30c", "#d03b3b"       # status: a saving / a loss, never used for a series
# Model families in the dataviz skill's fixed dark categorical order (slots 1-5); an unknown model folds into "other".
FAMILY_COLORS = (("opus", "#3987e5"), ("sonnet", "#d95926"), ("fable", "#199e70"), ("haiku", "#c98500"), ("other", "#d55181"))
# (mode, button label, the class every element of that mode carries)
MODES = (("usd", "List-price $", "mu"), ("tok", "Tokens", "mt"), ("plan", "Plan $", "mp"))
SEAT_USD_MONTH = accounts.TIER_USD_MONTH["max_20x"]  # the seat a "how many accounts is that" figure is quoted in

CSS = """
:root{--bg:#0f1115;--panel:#171a21;--line:#262a33;--text:#e6e8ec;--muted:#8a90a0;--head:#1e2230;--hover:#20273a;--good:#0ca30c;--bad:#d03b3b;--grid:#2c2f38}
body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:28px 32px 48px;color:var(--text);background:var(--bg)}
h1{font-size:22px;margin:0 0 2px;font-weight:600}h2{font-size:15px;margin:32px 0 10px;font-weight:600}
.sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.hero{font-size:52px;font-weight:600;line-height:1.05;margin:4px 0 2px}.hero small{font-size:18px;font-weight:500;color:var(--muted);margin-left:10px}
.heroline{color:var(--muted);font-size:13px;margin-bottom:22px;max-width:96ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;max-width:1240px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile .l{font-size:12px;color:var(--muted)}.tile .v{font-size:26px;font-weight:600;margin:2px 0}.tile .s{font-size:12px;color:var(--muted);line-height:1.35}
.pos{color:var(--good)}.neg{color:var(--bad)}
.charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:1720px}
@media (max-width:1240px){.charts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:820px){.charts{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.card h3{font-size:13px;font-weight:600;margin:0 0 2px}.card .cs{font-size:12px;color:var(--muted);margin-bottom:8px}
.legend{display:flex;gap:16px;font-size:12px;color:var(--muted);margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
svg text{font:11px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--muted)}svg text.v{fill:var(--text)}svg text.in{fill:#fff}
details{max-width:110ch;margin-top:18px;color:var(--muted);font-size:13px}summary{cursor:pointer;color:var(--text);font-weight:600;font-size:13px}details p{margin:8px 0}
table{border-collapse:collapse;background:var(--panel);font-size:13px}
th,td{padding:5px 9px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{background:var(--head);cursor:pointer;position:sticky;top:0;color:var(--text);font-weight:600}th:hover{background:var(--hover)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}tr:hover td{background:var(--hover)}
td.muted{color:var(--muted)}.wrap{overflow:auto;max-height:70vh;border:1px solid var(--line);border-radius:6px}
.note{color:var(--muted);font-size:12px;margin:4px 0 8px}
.modes{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:0 0 18px}
.modes button{font:13px/1 inherit;color:var(--muted);background:var(--panel);border:0;border-right:1px solid var(--line);padding:9px 16px;cursor:pointer}
.modes button:last-child{border-right:0}.modes button:hover{background:var(--hover);color:var(--text)}
.modes button[aria-pressed=true]{background:#2b344a;color:var(--text);font-weight:600}
.modes button[disabled]{opacity:.45;cursor:not-allowed}
.unit{font-size:12px;color:var(--muted);margin:-10px 0 18px}
body:not(.mode-usd) .mu,body:not(.mode-tok) .mt,body:not(.mode-plan) .mp{display:none}
code{background:#11141b;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:12px}
"""
JS = """
document.querySelectorAll('th').forEach(function(th){th.addEventListener('click',function(){
 var t=th.closest('table'),i=Array.from(th.parentNode.children).indexOf(th),asc=th.dataset.asc!=='1';
 var rows=Array.from(t.tBodies[0].rows);rows.sort(function(a,b){var x=a.cells[i].dataset.v||a.cells[i].textContent,y=b.cells[i].dataset.v||b.cells[i].textContent;
 var nx=parseFloat(x),ny=parseFloat(y);if(!isNaN(nx)&&!isNaN(ny))return asc?nx-ny:ny-nx;return asc?x.localeCompare(y):y.localeCompare(x)});
 rows.forEach(function(r){t.tBodies[0].appendChild(r)});t.querySelectorAll('th').forEach(function(h){delete h.dataset.asc});th.dataset.asc=asc?'1':'0';});});
(function(){
 var buttons=Array.from(document.querySelectorAll('.modes button'));
 function apply(mode){
  if(!buttons.some(function(b){return b.dataset.mode===mode&&!b.disabled})) return false;
  document.body.className='mode-'+mode;
  buttons.forEach(function(b){b.setAttribute('aria-pressed',b.dataset.mode===mode?'true':'false')});
  try{localStorage.setItem('hswarm-unit',mode)}catch(e){}
  return true;
 }
 buttons.forEach(function(b){b.addEventListener('click',function(){apply(b.dataset.mode)})});
 var saved=null;try{saved=localStorage.getItem('hswarm-unit')}catch(e){}
 if(!saved||!apply(saved)){apply(document.body.className.replace('mode-',''))}
})();
"""


def _e(v) -> str:
    return html.escape("" if v is None else str(v))


def tz_label(when: dt.datetime | None = None) -> str:
    """The reader's clock, named the way a clock is named: "local (UTC-05:00)"."""
    off = (when or dt.datetime.now()).astimezone().utcoffset() or dt.timedelta(0)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    return f"local (UTC{sign}{abs(total) // 3600:02d}:{abs(total) % 3600 // 60:02d})"


def local_date(ts: str) -> str:
    d = local_dt(ts)
    return d.strftime("%Y-%m-%d") if d else (ts or "")[:10]


def sign_class(v) -> str:
    """green for a saving, red for a loss, nothing for zero or not measured."""
    if v is None or v == 0:
        return ""
    return "pos" if v > 0 else "neg"


def signed(v) -> str:
    """A saving reads +$x, a loss -$x: the sign carries the meaning, the colour only repeats it."""
    if v is None or v == 0:
        return usd(v)
    return ("+" if v > 0 else "-") + usd(abs(v))


def signed_tokens(v) -> str:
    if v is None or v == 0:
        return big(v)
    return ("+" if v > 0 else "-") + big(abs(v))


def _cell(text: str, value, cls: str = "") -> str:
    """One numeric cell: `value` is what sorting uses, `text` what the reader sees, `cls` its unit group."""
    classes = " ".join(x for x in ("n", cls, "muted" if value is None else "") if x)
    return f'<td class="{classes}" data-v="{value if value is not None else -1e18}">{_e(text)}</td>'


def _money(v, cls: str = "", sign: bool = False) -> str:
    return _cell(signed(v) if sign else usd(v), v, " ".join(x for x in (cls, sign_class(v) if sign else "") if x))


def _tokens(v, cls: str = "", sign: bool = False) -> str:
    return _cell(signed_tokens(v) if sign else big(v), v, " ".join(x for x in (cls, sign_class(v) if sign else "") if x))


def ratio(est, worker) -> float | None:
    if est is None or not worker or worker <= 0:
        return None
    return est / worker


def ratio_text(r: float | None) -> str:
    return "-" if r is None else f"{r:,.0f}x"


def pct_text(v) -> str:
    return "-" if v is None else f"{v * 100:.1f}%"


def rate_text(r: float | None) -> str:
    """What one list-price dollar cost on the plans, in cents, because it is always a small number."""
    return "-" if r is None else f"{r * 100:.2f}c"


def _ratio(est, worker, cls: str = "") -> str:
    r = ratio(est, worker)
    return _cell(ratio_text(r), r, cls)


def _pct(v, cls: str = "") -> str:
    return _cell(pct_text(v), v, cls)


def _int(v, cls: str = "") -> str:
    num = v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    return _cell(f"{num:,.0f}" if num is not None else str(v), num, cls)


def _table(head: list[tuple], rows: list[str]) -> str:
    """head is (label, numeric) or (label, numeric, unit class); a unit class hides the whole column with its unit."""
    ths = []
    for h in head:
        label, num = h[0], h[1]
        cls = " ".join(x for x in (("n" if num else ""), (h[2] if len(h) > 2 else "")) if x)
        ths.append(f'<th{(" class=" + chr(34) + cls + chr(34)) if cls else ""}>{_e(label)}</th>')
    return f'<div class="wrap"><table><thead><tr>{"".join(ths)}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'


# The money/token/plan columns every total-shaped table carries, in one place so head and cells cannot drift.
UNIT_HEAD = [("est. Claude", True, "mu"), ("DeepSeek cost", True, "mu"), ("saved", True, "mu"), ("saved (floor)", True, "mu"),
             ("cheaper by", True, "mu"), ("Claude beside it", True, "mu"), ("share", True, "mu"), ("unpriced", True, "mu"),
             ("Claude tokens avoided", True, "mt"), ("DeepSeek tokens", True, "mt"), ("fewer by", True, "mt"),
             ("Claude tokens beside it", True, "mt"), ("token share", True, "mt"), ("unsized", True, "mt"),
             ("worth (plan $)", True, "mp"), ("DeepSeek cost (cash)", True, "mp"), ("saved (plan $)", True, "mp"),
             ("saved floor (plan $)", True, "mp"), ("plans used", True, "mp"), ("per list $", True, "mp"), ("share", True, "mp")]


def _unit_cells(r: dict) -> str:
    """The same row in all three units; the switch decides which cells the reader sees."""
    return (_money(r.get("est_usd"), "mu") + _money(r.get("worker_usd"), "mu") + _money(r.get("saved_usd"), "mu", sign=True)
            + _money(r.get("saved_low_usd"), "mu", sign=True) + _ratio(r.get("est_usd"), r.get("worker_usd"), "mu")
            + _money(r.get("claude_usd"), "mu") + _pct(r.get("share"), "mu") + _int(r.get("unpriced", 0), "mu")
            + _tokens(r.get("est_tokens"), "mt") + _tokens(r.get("worker_tokens"), "mt")
            + _ratio(r.get("est_tokens"), r.get("worker_tokens"), "mt") + _tokens(r.get("claude_tokens"), "mt")
            + _pct(r.get("token_share"), "mt") + _int(r.get("unsized", 0), "mt")
            + _money(r.get("plan_est_usd"), "mp") + _money(r.get("worker_usd"), "mp") + _money(r.get("plan_saved_usd"), "mp", sign=True)
            + _money(r.get("plan_saved_low_usd"), "mp", sign=True) + _money(r.get("plan_cost_usd"), "mp")
            + _cell(rate_text(r.get("rate")), r.get("rate"), "mp") + _pct(r.get("plan_share"), "mp"))


# ---- data ----------------------------------------------------------------------------------------

def weigh_row(r: dict, rates: dict) -> dict:
    """Add the plan-dollar view of one machine-shaped row: its own rate when it has one, the fleet's otherwise."""
    rate, borrowed = utilization.rate_of(rates, r.get("machine") or "")
    est = utilization.weigh(r.get("est_usd"), rate)
    low = utilization.weigh(r.get("est_low_usd"), rate)
    worker = r.get("worker_usd") or 0.0
    plan_claude = utilization.weigh(r.get("claude_usd"), rate)
    return r | {"rate": rate, "rate_borrowed": borrowed, "plan_est_usd": est, "plan_share": utilization.share(est, plan_claude),
                "plan_saved_usd": None if est is None else round(est - worker, 4),
                "plan_saved_low_usd": None if low is None else round(low - worker, 4),
                "plan_claude_usd": plan_claude, "plan_cost_usd": r.get("plan_usd")}


_DAY_SQL = ("SELECT date(u.ts, 'localtime') AS day, u.machine AS machine, COUNT(*) AS n, SUM(u.tasks) AS tasks, "
            "SUM(u.worker_usd) AS worker_usd, SUM(u.est_usd) AS est_usd, SUM(u.est_low_usd) AS est_low_usd, SUM(u.saved_usd) AS saved_usd, "
            "SUM(u.saved_low_usd) AS saved_low_usd, SUM(CASE WHEN u.est_usd IS NULL THEN 1 ELSE 0 END) AS unpriced, "
            "SUM(u.tasks * (p.input + p.cache_read + p.cache_5m + p.cache_1h + p.output)) AS est_tokens, "
            "COALESCE(SUM(u.worker_tokens), 0) AS worker_tokens, SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) AS unsized "
            "FROM utilizations u LEFT JOIN profiles p ON p.id = u.profile_id GROUP BY day, u.machine")


def per_day(c, rates: dict) -> list[dict]:
    """Fleet totals per LOCAL day, newest first, with the Claude work done beside them. Each machine's share of a
    day is weighed at ITS OWN plan rate before the day is folded, because two machines do not pay the same."""
    claude: dict[tuple[str, str], dict] = {}
    for r in c.execute("SELECT machine, day, claude_usd, partial, plan_usd, " + utilization._tokens_sum("claude_days") + " AS tokens, "
                       "CASE WHEN tokens IS NULL OR tokens IN ('', '{}') THEN 1 ELSE 0 END AS no_tokens FROM claude_days"):
        claude[(r["machine"], r["day"])] = dict(r)
    days: dict[str, dict] = {}
    for row in c.execute(_DAY_SQL):
        r = weigh_row(dict(row), rates)
        cl = claude.get((r["machine"], r["day"]))
        d = days.setdefault(r["day"], {"day": r["day"], "n": 0, "tasks": 0, "worker_usd": 0.0, "worker_tokens": 0, "unpriced": 0, "unsized": 0,
                                       "est_usd": None, "est_low_usd": None, "saved_usd": None, "saved_low_usd": None, "est_tokens": None,
                                       "claude_usd": None, "claude_tokens": None, "plan_cost_usd": None, "plan_est_usd": None,
                                       "plan_saved_usd": None, "plan_saved_low_usd": None, "plan_claude_usd": None, "partial": False,
                                       "rate": r["rate"], "machines": 0})
        d["machines"] += 1
        for k in ("n", "tasks", "worker_usd", "worker_tokens", "unpriced", "unsized"):
            d[k] += r.get(k) or 0
        for k in ("est_usd", "est_low_usd", "saved_usd", "saved_low_usd", "est_tokens", "plan_est_usd", "plan_saved_usd", "plan_saved_low_usd"):
            d[k] = utilization.add_measured(d[k], r.get(k))
        if cl:
            d["claude_usd"] = utilization.add_measured(d["claude_usd"], cl["claude_usd"])
            d["claude_tokens"] = None if cl["no_tokens"] else utilization.add_measured(d["claude_tokens"], cl["tokens"])
            d["plan_cost_usd"] = utilization.add_measured(d["plan_cost_usd"], cl["plan_usd"])
            d["plan_claude_usd"] = utilization.add_measured(d["plan_claude_usd"], utilization.weigh(cl["claude_usd"], r["rate"]))
            d["partial"] = d["partial"] or bool(cl["partial"])
    for d in days.values():
        d["share"] = utilization.share(d["est_usd"], d["claude_usd"])
        d["token_share"] = utilization.share(d["est_tokens"], d["claude_tokens"])
        d["plan_share"] = utilization.share(d["plan_est_usd"], d["plan_claude_usd"])
        d["rate"] = None if not d["plan_cost_usd"] or not d["claude_usd"] else round(d["plan_cost_usd"] / d["claude_usd"], 8)
    return [days[k] for k in sorted(days, reverse=True)]


def family_of(model: str) -> str:
    return next((f for f, _ in FAMILY_COLORS if f in (model or "")), "other")


def claude_by_family(c, rates: dict) -> list[dict]:
    """Claude's own usage per local day (every machine summed) split by model family, in all three units, newest first."""
    days: dict[str, dict] = {}
    for d in utilization.claude_day_rows(c):
        rate, _ = utilization.rate_of(rates, d.get("machine") or "")
        row = days.setdefault(d["day"], {"day": d["day"], "partial": False, "families": {},
                                         "total": {"usd": 0.0, "tok": 0.0, "plan": 0.0}})
        row["partial"] = row["partial"] or bool(d.get("partial"))
        for model, v in (d.get("by_model") or {}).items():
            fam = family_of(model)
            money = float(v.get("usd") or 0.0)
            toks = sum(int((v.get("tokens") or {}).get(k) or 0) for k in utilization.TOKEN_KEYS)
            plan = utilization.weigh(money, rate) or 0.0
            f = row["families"].setdefault(fam, {"usd": 0.0, "tok": 0.0, "plan": 0.0})
            for key, add in (("usd", money), ("tok", toks), ("plan", plan)):
                f[key] += add
                row["total"][key] += add
    return [days[k] for k in sorted(days, reverse=True)]


def all_rows(c, limit: int = MAX_ROWS) -> list[dict]:
    q = ("SELECT u.*, u.tasks * (p.input + p.cache_read + p.cache_5m + p.cache_1h + p.output) AS est_tokens "
         "FROM utilizations u LEFT JOIN profiles p ON p.id = u.profile_id ORDER BY u.ts DESC, u.id DESC LIMIT ?")
    return [dict(r) for r in c.execute(q, (limit,))]


# ---- charts (inline SVG, no dependencies) -----------------------------------------------------------

def days_note(n: int) -> str:
    """A one-bar chart is a stat tile pretending to be a chart; say so rather than let it read as broken
    (Michael, 2026-09-16: "the saved per day only literally shows one day. Is that not dynamic?")."""
    if n > 1:
        return ""
    return "<div class='note'>One day on record so far. A bar is added for every day the swarm runs; the shape appears as days accumulate.</div>"


def _nice_step(span: float, target: int = 4) -> float:
    if span <= 0:
        return 1.0
    raw = span / target
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


def _gridlines(out: list[str], W: int, left: int, lo: float, hi: float, step: float, y_of, fmt) -> None:
    """The horizontal gridlines from `lo` to `hi` inclusive, each with its label at the left."""
    v = lo
    while v <= hi + 1e-9:
        y = y_of(v)
        out.append(f'<line x1="{left}" x2="{W - 12}" y1="{y:.1f}" y2="{y:.1f}" stroke="var(--grid)" stroke-width="1"/>')
        out.append(f'<text x="{left - 6}" y="{y + 4:.1f}" text-anchor="end">{_e(fmt(v) if v else "0")}</text>')
        v += step


def _label_every(n: int) -> int:
    """How many columns to skip between date labels, so about twelve of them fit on the axis."""
    return max(1, math.ceil(n / 12))


def _rounded_end_path(x: float, y: float, w: float, h: float, r: float, end: str) -> str:
    """A bar rounded only at its data end (square at the baseline): end = right | top."""
    r = min(r, w / 2, h / 2)
    if end == "right":
        return f"M{x:.1f},{y:.1f} h{w - r:.1f} a{r},{r} 0 0 1 {r},{r} v{h - 2 * r:.1f} a{r},{r} 0 0 1 -{r},{r} h-{w - r:.1f} z"
    return f"M{x:.1f},{y + h:.1f} v-{h - r:.1f} a{r},{r} 0 0 1 {r},-{r} h{w - 2 * r:.1f} a{r},{r} 0 0 1 {r},{r} v{h - r:.1f} z"


def chart_share(days: list[dict], swarm_key: str, claude_key: str, share_key: str, fmt, unit: str) -> str:
    """Who did the work, per day: one bar per day split swarm vs Claude itself, 100% wide, in one unit."""
    rows = [d for d in reversed(days) if d.get(share_key) is not None][-30:]
    if not rows:
        return f"<div class='note'>No day with Claude's own {unit} measured yet.</div>"
    lw, gap, bh, right = 74, 8, 18, 64
    W = 640
    H = len(rows) * (bh + gap) + 4
    bw = W - lw - right
    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" height="{H}" role="img" aria-label="share of the work per day">']
    for i, d in enumerate(rows):
        y = i * (bh + gap)
        frac = d[share_key]
        sw = max(0.0, bw * frac - 1)
        cw = max(0.0, bw * (1 - frac) - 1)
        total = (d.get(swarm_key) or 0) + (d.get(claude_key) or 0)
        tip = f"{d['day']}: swarm {fmt(d.get(swarm_key))} of {fmt(total)} ({pct_text(frac)}); Claude itself {fmt(d.get(claude_key))}"
        out.append(f'<text x="{lw - 8}" y="{y + bh - 5}" text-anchor="end">{_e(d["day"][5:])}{"*" if d.get("partial") else ""}</text>')
        out.append(f'<rect x="{lw}" y="{y}" width="{sw:.1f}" height="{bh}" fill="{SWARM}"><title>{_e(tip)}</title></rect>')
        out.append(f'<path d="{_rounded_end_path(lw + sw + 2, y, cw, bh, 4, "right")}" fill="{CLAUDE}"><title>{_e(tip)}</title></path>')
        label = pct_text(frac)
        if sw > 44:
            out.append(f'<text class="in" x="{lw + 6}" y="{y + bh - 5}">{_e(label)}</text>')
        else:
            out.append(f'<text class="v" x="{lw + bw + 8}" y="{y + bh - 5}">{_e(label)}</text>')
    out.append("</svg>")
    out.append(f"<div class='legend'><span><i style='background:{SWARM}'></i>swarm, valued as Claude sub-agents</span><span><i style='background:{CLAUDE}'></i>Claude itself, on this fleet</span></div>")
    out.append(days_note(len(rows)))
    return "".join(out)


def _saved_bar(out: list[str], d: dict, val: float, x: float, cw: float, y_of, tip: str) -> float:
    """One day's column: a rounded cap above the baseline for a saving, a squared block below it for a loss.
    Returns the y of the value, where the number goes."""
    y0, y1 = y_of(0), y_of(val)
    h = max(abs(y1 - y0), 1.0)
    fill = GOOD if val >= 0 else BAD
    if val >= 0:
        out.append(f'<path d="{_rounded_end_path(x, y1, cw, h, 4, "top")}" fill="{fill}"><title>{_e(tip)}</title></path>')
    else:
        out.append(f'<rect x="{x:.1f}" y="{y0:.1f}" width="{cw:.1f}" height="{h:.1f}" rx="4" fill="{fill}"><title>{_e(tip)}</title></rect>')
    return y1


def chart_saved(days: list[dict], key: str, fmt, tip_of) -> str:
    """One column per day in one unit; value on the cap when there is room for every cap, else only the extremes."""
    rows = [d for d in reversed(days) if d.get(key) is not None][-30:]
    if not rows:
        return "<div class='note'>Nothing measured in this unit yet.</div>"
    W, top, ph, axis, left = 640, 18, 150, 26, 62
    vals = [d[key] for d in rows]
    lo, hi = min(0.0, min(vals)), max(0.0, max(vals))
    step = _nice_step(hi - lo)
    lo, hi = math.floor(lo / step) * step, math.ceil(hi / step) * step or step
    scale = ph / (hi - lo)
    y_of = lambda v: top + (hi - v) * scale  # noqa: E731
    pw = W - left - 12
    slot = pw / len(rows)
    cw = min(24.0, slot - 6)
    H = top + ph + axis
    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" height="{H}" role="img" aria-label="per day">']
    _gridlines(out, W, left, lo, hi, step, y_of, fmt)
    label_all = len(rows) <= 14
    extremes = {max(range(len(rows)), key=lambda i: vals[i]), len(rows) - 1}
    every = _label_every(len(rows))
    for i, d in enumerate(rows):
        x = left + i * slot + (slot - cw) / 2
        val = vals[i]
        y1 = _saved_bar(out, d, val, x, cw, y_of, tip_of(d))
        if label_all or i in extremes:
            ty = (y1 - 5) if val >= 0 else (y1 + 12)
            out.append(f'<text class="v" x="{x + cw / 2:.1f}" y="{ty:.1f}" text-anchor="middle">{_e(fmt(val))}</text>')
        if i % every == 0 or i == len(rows) - 1:
            out.append(f'<text x="{x + cw / 2:.1f}" y="{top + ph + 16}" text-anchor="middle">{_e(d["day"][5:])}</text>')
    out.append(f'<line x1="{left}" x2="{W - 12}" y1="{y_of(0):.1f}" y2="{y_of(0):.1f}" stroke="#383835" stroke-width="1"/>')
    out.append("</svg>")
    out.append(days_note(len(rows)))
    return "".join(out)


def _stacked_bars(out: list[str], r: dict, unit: str, x: float, cw: float, scale: float, base: float, fmt) -> float:
    """One day's columns stacked bottom-up in the fixed family order; returns the top of the stack."""
    y = base
    for fam, color in reversed(FAMILY_COLORS):
        val = (r["families"].get(fam) or {}).get(unit, 0.0)
        if val <= 0:
            continue
        h = max(val * scale - 2, 0.5)
        y -= h
        tip = f"{r['day']}: {fam} {fmt(val)} of {fmt(r['total'][unit])}"
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw:.1f}" height="{h:.1f}" fill="{color}"><title>{_e(tip)}</title></rect>')
        y -= 2
    return y


def chart_models(rows: list[dict], unit: str, fmt) -> str:
    """Claude's own work per day as stacked columns by model family, one colour per family, fixed order."""
    rows = [r for r in reversed(rows) if r["total"][unit] > 0][-30:]
    if not rows:
        return "<div class='note'>No day with a per-model split in this unit yet (run `hswarm savings --remeasure 7`).</div>"
    W, top, ph, axis, left = 640, 18, 150, 26, 62
    hi = max(r["total"][unit] for r in rows)
    step = _nice_step(hi)
    hi = math.ceil(hi / step) * step or step
    scale = ph / hi
    pw = W - left - 12
    slot = pw / len(rows)
    cw = min(24.0, slot - 6)
    H = top + ph + axis
    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" height="{H}" role="img" aria-label="Claude per day by model">']
    _gridlines(out, W, left, 0.0, hi, step, lambda v: top + (hi - v) * scale, fmt)
    every = _label_every(len(rows))
    for i, r in enumerate(rows):
        x = left + i * slot + (slot - cw) / 2
        y = _stacked_bars(out, r, unit, x, cw, scale, top + ph, fmt)
        if len(rows) <= 14 or i == len(rows) - 1:
            out.append(f'<text class="v" x="{x + cw / 2:.1f}" y="{y - 4:.1f}" text-anchor="middle">{_e(fmt(r["total"][unit]))}</text>')
        if i % every == 0 or i == len(rows) - 1:
            out.append(f'<text x="{x + cw / 2:.1f}" y="{top + ph + 16}" text-anchor="middle">{_e(r["day"][5:])}{"*" if r.get("partial") else ""}</text>')
    out.append(f'<line x1="{left}" x2="{W - 12}" y1="{top + ph:.1f}" y2="{top + ph:.1f}" stroke="#383835" stroke-width="1"/>')
    out.append("</svg>")
    present = {f for r in rows for f, v in r["families"].items() if v.get(unit, 0) > 0}
    out.append("<div class='legend'>" + "".join(f"<span><i style='background:{c}'></i>{f}</span>" for f, c in FAMILY_COLORS if f in present) + "</div>")
    return "".join(out)


# ---- the rule check (unit-independent) -------------------------------------------------------------

def _tile(label: str, value: str, sub: str = "", cls: str = "") -> str:
    return f"<div class='tile'><div class='l'>{_e(label)}</div><div class='v {cls}'>{_e(value)}</div><div class='s'>{_e(sub)}</div></div>"


def _sonnet_tile(r: dict, detail: bool) -> str:
    sub = (f"{usd(r.get('sonnet_usd'))}, {r.get('sonnet_workflow_agents', 0)} of them inside Workflows. Allowed only with a logged reason."
           if detail else "per-agent detail not recorded for this day")
    return _tile("Sonnet sub-agents", f"{r.get('sonnet_agents', 0)}", sub)


def _flagship_tile(r: dict, detail: bool) -> str:
    sub = (f"{usd((r.get('opus_usd') or 0) + (r.get('fable_usd') or 0))}. Flagship sub-agents: judgment and synthesis only."
           if detail else "per-agent detail not recorded for this day")
    return _tile("Opus + Fable sub-agents", f"{r.get('opus_agents', 0)} + {r.get('fable_agents', 0)}", sub)


def _gate_tile(r: dict) -> str:
    return _tile("Gate decisions", f"{r.get('gate_decisions', 0)}",
                 f"{r.get('gate_blocked', 0)} blocked, {r.get('gate_allowed', 0)} allowed, {r.get('gate_reminded', 0)} reminded; "
                 f"gate live since {r.get('gate_live_since') or '-'} UTC")


def _bypass_tile(r: dict, ungated: int, detail: bool) -> str:
    sub = (f"of {r.get('agents_after_gate', 0)} sub-agents started after the gate went live, from sessions it never saw"
           if detail else "needs per-agent detail")
    return _tile("Bypassed the gate", str(ungated), sub, "neg" if ungated else ("pos" if detail else ""))


def rule_tiles(d: dict | None) -> str:
    """The latest measured day's rule check as tiles: red where a ruling was broken, green where it held."""
    if not d or not d.get("rules"):
        return "<div class='note'>No Claude day measured yet.</div>"
    r = d["rules"]
    day = d["day"] + ("* (today so far)" if d.get("partial") else "")
    haiku = r.get("haiku_requests", 0)
    detail = r.get("agents_detail", False)
    tiles = [
        _tile("Haiku requests", str(haiku), f"{day}. Banned for every task." + (" Held." if not haiku else " BROKEN."), "pos" if not haiku else "neg"),
        _sonnet_tile(r, detail),
        _flagship_tile(r, detail),
        _gate_tile(r),
        _bypass_tile(r, r.get("ungated_agents_after_gate", 0), detail),
    ]
    return "<div class='tiles'>" + "".join(tiles) + "</div>"


# ---- the page --------------------------------------------------------------------------------------

def mode_switch(plan_ok: bool) -> str:
    """The one control on the page: which unit everything is read in."""
    buttons = []
    for mode, label, _cls in MODES:
        off = " disabled title='No account plan could be costed yet, so there is no plan rate to weigh with.'" if mode == "plan" and not plan_ok else ""
        buttons.append(f"<button type='button' data-mode='{mode}' aria-pressed='false'{off}>{_e(label)}</button>")
    return "<div class='modes' role='group' aria-label='unit'>" + "".join(buttons) + "</div>"


def seats_text(plan_est_usd: float | None, days: float | None) -> str:
    """The plan value of the swarm's work said in accounts: "about 3.4 Max 20x seats", which is how the bill grows."""
    if not plan_est_usd or not days:
        return "-"
    per_month = plan_est_usd / days * accounts.DAYS_PER_MONTH
    return f"{per_month / SEAT_USD_MONTH:,.1f}"


def hero_block(total: dict, plan: dict, rates: dict) -> str:
    """One hero per unit; the switch shows one of them."""
    saved, worker = total["saved_usd"], total["worker_usd"]
    fleet = rates.get("fleet") or {}
    out = [f"<div class='mu'><div class='hero {sign_class(saved)}'>{_e(signed(saved))}<small>{'saved' if saved is None or saved >= 0 else 'lost'}</small></div>",
           "<div class='heroline'>The Claude-priced value of the work the swarm did, minus what DeepSeek actually charged. Anthropic list-price "
           "dollars: on a subscription this is quota that stayed unused, not cash back - switch to Plan $ for what it was worth on the plans "
           "you pay for.</div></div>"]
    out.append(f"<div class='mt'><div class='hero'>{_e(big(total.get('est_tokens')))}<small>Claude tokens avoided</small></div>"
               f"<div class='heroline'>Tokens the same work would have run through Claude sub-agents, sized by the measured median sub-agent. "
               f"{_e(big(total.get('est_cache_read')))} of them are cache reads, which Anthropic bills at a tenth of fresh input (a fortieth on "
               f"Fable 5.1). The swarm spent {_e(big(total.get('worker_tokens')))} DeepSeek tokens doing it.</div></div>")
    ps = plan.get("saved_usd")
    if plan.get("rate"):
        line = (f"On the accounts that actually did work, {usd(fleet.get('plan_usd'))} of plan carried {usd(fleet.get('claude_usd'))} of list-price "
                f"work over {fleet.get('days')} day(s): one list-price dollar really cost {rate_text(plan['rate'])}. At that rate the swarm's work "
                f"was worth {usd(plan.get('est_usd'))} of plan, and DeepSeek charged {usd(worker)} in real money.")
    else:
        line = ("No account could be costed yet, so there is no plan rate. Let AgentHydra resolve the accounts, or put a flat figure in "
                "~/.hswarm/plan.json.")
    out.append(f"<div class='mp'><div class='hero {sign_class(ps)}'>{_e(signed(ps))}<small>{'saved on the plans' if ps is None or ps >= 0 else 'lost on the plans'}</small></div>"
               f"<div class='heroline'>{_e(line)}</div></div>")
    return "".join(out)


def tiles_block(total: dict, plan: dict, rates: dict, acct_view: dict) -> str:
    """One tile row per unit."""
    est, worker, claude = total["est_usd"], total["worker_usd"], total.get("claude_usd")
    whole = (est or 0) + (claude or 0)
    money = [
        _tile("Share of the work", pct_text(total.get("share")),
              f"On the days the swarm ran, this fleet did {usd(whole)} of Claude-priced work: {usd(claude)} by Claude itself, {usd(est)} by the swarm."
              if total.get("share") is not None else "Claude's own usage for these days is not measured yet."),
        _tile("est. Claude", usd(est), "what the same work costs as Claude sub-agents, at the caller's model"),
        _tile("DeepSeek cost", usd(worker), "what was actually paid, in real money"),
        _tile("Cheaper by", ratio_text(ratio(est, worker)), "est. Claude divided by DeepSeek cost"),
        _tile("Saved (floor)", signed(total["saved_low_usd"]), "if every run had been a single sub-agent instead of one per task", sign_class(total["saved_low_usd"])),
        _tile("Unpriced runs", str(total["unpriced"]), "runs from before a sub-agent profile existed on their machine"),
    ]
    tokens = [
        _tile("Share of the work", pct_text(total.get("token_share")),
              "the swarm's share of every token this fleet ran on swarm days"
              if total.get("token_share") is not None else f"Claude's own tokens are not measured for {total.get('days_without_tokens', 0)} of these days yet."),
        _tile("Claude tokens avoided", big(total.get("est_tokens")),
              f"{big(total.get('est_cache_read'))} cache reads, {big(total.get('est_cache_write'))} cache writes, "
              f"{big(total.get('est_input'))} fresh input, {big(total.get('est_output'))} output"),
        _tile("DeepSeek tokens spent", big(total.get("worker_tokens")), "read plus written by the workers that did it"),
        _tile("Fewer tokens by", ratio_text(ratio(total.get("est_tokens"), total.get("worker_tokens"))), "Claude tokens avoided per DeepSeek token spent"),
        _tile("Per task", f"{big((total.get('est_tokens') or 0) / max(total['tasks'], 1))} vs {big((total.get('worker_tokens') or 0) / max(total['tasks'], 1))}",
              "one Claude sub-agent against one swarm task: the whole reason a worker is cheap"),
        _tile("Unsized runs", str(total.get("unsized") or 0), "runs with no measured sub-agent profile behind them"),
    ]
    fleet = rates.get("fleet") or {}
    plan_tiles = [
        _tile("Saved on the plans", signed(plan.get("saved_usd")),
              "the swarm's work at the plan rate, minus the DeepSeek bill, which is cash and is never weighted", sign_class(plan.get("saved_usd"))),
        _tile("Worth (plan $)", usd(plan.get("est_usd")), "what that work would have drawn from the subscriptions you pay for"),
        _tile("A list dollar really cost", rate_text(plan.get("rate")),
              f"{usd(fleet.get('plan_usd'))} of plans carried {usd(fleet.get('claude_usd'))} of list-price work over {fleet.get('days')} day(s)"),
        _tile("Seats it stood in for", seats_text(plan.get("est_usd"), fleet.get("days")),
              f"Max 20x accounts at ${SEAT_USD_MONTH:,.0f}/mo, if the swarm's work had to run on Claude at this fleet's rate"),
        _tile("Accounts that did work", f"{acct_view['worked']}",
              f"of {acct_view['open']} this machine has ever signed in; only the ones that ran something are costed, and only on the days they ran it"),
        _tile("Saved (floor)", signed(plan.get("saved_low_usd")), "if every run had been a single sub-agent instead of one per task", sign_class(plan.get("saved_low_usd"))),
    ]
    return ("<div class='tiles mu'>" + "".join(money) + "</div>"
            + "<div class='tiles mt'>" + "".join(tokens) + "</div>"
            + "<div class='tiles mp'>" + "".join(plan_tiles) + "</div>")


def charts_block(days: list[dict], by_family: list[dict]) -> str:
    """Three charts per unit: who did the work, what was saved, and what Claude itself ran, by model."""
    def card(cls: str, title: str, sub: str, svg: str) -> str:
        return f"<div class='card {cls}'><h3>{_e(title)}</h3><div class='cs'>{_e(sub)}</div>{svg}</div>"

    money = [card("mu", "Who did the work, per day", "Each bar is one day's Claude-priced work on this fleet, split by who did it. * = today, still being written.",
                  chart_share(days, "est_usd", "claude_usd", "share", usd, "usage")),
             card("mu", "Saved per day", "est. Claude minus DeepSeek cost, per day. Green is a saving, red a loss.",
                  chart_saved(days, "saved_usd", usd, lambda d: f"{d['day']}: saved {signed(d['saved_usd'])} (est. Claude {usd(d['est_usd'])}, DeepSeek {usd(d['worker_usd'])})")),
             card("mu", "Claude's own spend per day, by model", "What Claude itself did on this fleet, at list price, split by model family.",
                  chart_models(by_family, "usd", usd))]
    tokens = [card("mt", "Who ran the tokens, per day", "Each bar is one day's tokens on this fleet, split between the swarm's counterfactual and Claude itself.",
                   chart_share(days, "est_tokens", "claude_tokens", "token_share", big, "tokens")),
              card("mt", "Claude tokens avoided per day", "Tokens the swarm kept off Claude, sized by the measured median sub-agent.",
                   chart_saved(days, "est_tokens", big, lambda d: f"{d['day']}: {big(d['est_tokens'])} Claude tokens avoided, {big(d['worker_tokens'])} DeepSeek tokens spent")),
              card("mt", "Claude's own tokens per day, by model", "What Claude itself ran on this fleet, in tokens, split by model family.",
                   chart_models(by_family, "tok", big))]
    plan = [card("mp", "Who did the work, per day", "The same split, with each machine's work valued at the rate its own plans charge.",
                 chart_share(days, "plan_est_usd", "plan_claude_usd", "plan_share", usd, "plan cost")),
            card("mp", "Saved on the plans, per day", "The swarm's work at the plan rate minus the DeepSeek bill. Below the line means the workers cost more than the quota they saved.",
                 chart_saved(days, "plan_saved_usd", usd, lambda d: f"{d['day']}: {signed(d['plan_saved_usd'])} (worth {usd(d['plan_est_usd'])} of plan, DeepSeek {usd(d['worker_usd'])})")),
            card("mp", "Claude's own spend per day, by model", "What Claude itself did, converted to plan dollars at each machine's rate.",
                 chart_models(by_family, "plan", usd))]
    return "<div class='charts'>" + "".join(money + tokens + plan) + "</div>"


def account_view(c) -> dict:
    """The accounts table, and the two numbers the plan tiles quote from it."""
    rows = utilization.account_rows(c)
    worked = [r for r in rows if r["account"] != accounts.UNATTRIBUTED and (r.get("days") or 0) > 0]
    return {"rows": rows, "worked": len(worked), "open": len(accounts.resolver()["accounts"]) or len(worked)}


def accounts_block(view: dict) -> str:
    """Which account did what, by its hashed id: no email, no name, and no instance number to be recycled."""
    rows = []
    for r in view["rows"]:
        tier = accounts.label_of(r.get("tier") or "")
        name = "unattributed" if r["account"] == accounts.UNATTRIBUTED else r["account"]
        note = "sessions no account could be resolved for" if r["account"] == accounts.UNATTRIBUTED else f"{tier}, ${accounts.tier_usd_month(r.get('tier') or '') or 0:,.0f}/mo"
        rows.append(f"<tr><td title='{_e(note)}'>{_e(name)}</td><td>{_e(tier)}</td><td>{_e(r.get('machines') or '')}</td>"
                    + _int(r.get("days") or 0) + _int(r.get("sessions") or 0) + _int(r.get("requests") or 0)
                    + _money(r.get("usd"), "mu") + _money(r.get("plan_usd"), "mp") + _tokens(r.get("tokens"), "mt")
                    + _int(r.get("runs") or 0) + _int(r.get("tasks") or 0) + _money(r.get("est_usd"), "mu")
                    + _tokens(r.get("est_tokens"), "mt") + _money(r.get("worker_usd"), "mp") + _money(r.get("worker_usd"), "mu")
                    + "</tr>")
    head = [("account", False), ("plan", False), ("machine(s)", False), ("days worked", True), ("sessions", True), ("requests", True),
            ("its Claude work", True, "mu"), ("its plan cost", True, "mp"), ("its Claude tokens", True, "mt"),
            ("swarm runs it ordered", True), ("tasks", True), ("est. Claude for those", True, "mu"), ("tokens for those", True, "mt"),
            ("DeepSeek cost (cash)", True, "mp"), ("DeepSeek cost", True, "mu")]
    note = ("<div class='note'>An account is named by a hash of its Anthropic account id, so it stays the same when the instance folder is renamed "
            "or its number is reused, and no email or name ever lands in this file. Only the accounts that actually did work are costed, and only on "
            "the days they worked - that is what the plan rate is built from.</div>")
    return note + _table(head, rows)


def render(total: dict, machines: list[dict], days: list[dict], rows: list[dict], profile: dict | None, generated: str,
           by_family: list[dict] | None = None, latest_day: dict | None = None, rates: dict | None = None,
           plan: dict | None = None, acct_view: dict | None = None) -> str:
    rates = rates or {"machines": {}, "fleet": {}}
    plan = plan or {}
    acct_view = acct_view or {"rows": [], "worked": 0, "open": 0}
    plan_ok = bool(plan.get("rate"))
    head = ["<h1>hswarm running total</h1>",
            f"<div class='sub'>{_e(utilization.MACHINE)} · generated {_e(local_min(generated))} {_e(tz_label())} · {total['n']} runs · {total['tasks']:,} tasks · "
            f"since {_e(local_date(total['first'] or ''))} · {len(machines)} machine(s) · every time on this page is your local clock</div>",
            mode_switch(plan_ok),
            "<div class='unit mu'>Unit: Anthropic list price - what the API would have billed for the same work.</div>"
            "<div class='unit mt'>Unit: tokens - what a subscription actually rations.</div>"
            "<div class='unit mp'>Unit: plan dollars - a list-price dollar converted at what the accounts that did the work really cost. "
            "The DeepSeek bill is real money and is never converted.</div>",
            hero_block(total, plan, rates)]
    charts = (charts_block(days, by_family or [])
              + "<h2>Rule check</h2><div class='note'>The latest measured day, from the transcripts and the routing gate's log. Green held, red broken.</div>"
              + rule_tiles(latest_day))
    prof = (f"<p>The measuring stick on {_e(profile['machine'])}: one {_e(profile['basis'])} sub-agent = {profile['input']:,} input + {profile['cache_read']:,} cache-read + "
            f"{profile['cache_5m']:,} cache-write (5 min) + {profile['cache_1h']:,} cache-write (1 h) + {profile['output']:,} output tokens over {profile['requests']} requests, "
            f"the median of {profile['sample']:,} real sub-agents in the last {profile['pool_days']} recorded days ({_e(local_date(profile['ts']))}).</p>") if profile else "<p>No sub-agent profile measured yet.</p>"
    fleet = rates.get("fleet") or {}
    details = ("<details><summary>How these numbers are made</summary>"
               "<p><b>est. Claude</b>: one swarm task is counted as one Claude sub-agent, sized by the measured profile below and priced at Anthropic's list rate for the model the "
               "calling session was running at that moment (cache reads and cache writes at their own rates, so caching is already in). A run whose caller is unknown is priced at "
               "the Sonnet floor and its 'how' says (floor).</p>"
               "<p><b>DeepSeek cost</b>: exact, from the usage DeepSeek returned, at the live peak/off-peak rate. <b>saved</b> = est. Claude - DeepSeek cost. "
               "<b>Saved (floor)</b> prices one sub-agent for the whole run instead of one per task. <b>cheaper by</b> = est. Claude / DeepSeek cost.</p>"
               "<p><b>Tokens</b>: the same counterfactual in the unit a subscription rations - tasks x the profile's token buckets. Most of it is cache reads, which is "
               "why the dollar figure is so much smaller than the raw count suggests. The DeepSeek side is what the workers really read and wrote.</p>"
               f"<p><b>Plan dollars</b>: a list-price dollar is not what a subscription bills. Each account that did work on a day is charged that day at its own plan's "
               f"price divided by {accounts.DAYS_PER_MONTH:.2f} days; an account that sat idle that day is not charged at all. The rate is that cost divided by the "
               f"list-price value of the work those accounts did: here {_e(usd(fleet.get('plan_usd')))} of plan over {_e(str(fleet.get('days')))} complete day(s) carried "
               f"{_e(usd(fleet.get('claude_usd')))} of list-price work, so one list dollar cost {_e(rate_text(plan.get('rate')))}. Swarm work is converted at its own "
               "machine's rate where that machine has one, and at the fleet's rate otherwise. The DeepSeek bill is never converted: it is cash. Override the plan prices, "
               "or set one flat monthly figure, in <code>~/.hswarm/plan.json</code>.</p>"
               "<p><b>Share of the work</b>: the swarm's estimate over (itself + the Claude work actually done on those machines on the same days, from their own transcripts). "
               "It answers 'of everything Claude-shaped this fleet did on swarm days, how much did the swarm take'.</p>"
               "<p><b>#</b> is the run number: it counts up per machine in time order and never changes, so 'run 196' means the same row next month. "
               "A run priced before any profile existed shows '-' until one lands; after that its numbers never change.</p>"
               f"<p><b>Clocks.</b> Every time and every day on this page is {_e(tz_label())}, this machine's own clock, and a day runs local midnight to local "
               "midnight. Times are stored in UTC and converted for display, which is why a run at 8pm on the 15th here is stamped 01:00 on the 16th in the "
               "database and in the shared totals file.</p>"
               + prof + f"<p>Source: {_e(utilization.db_path())}. Rendered by every savings run, every sync and the daily task.</p></details>")
    mrows = [f"<tr><td>{_e(m['machine'])}</td>{_int(m['n'])}{_int(m['tasks'])}{_unit_cells(m)}<td>{_e(local_date(m['first'] or ''))}</td><td>{_e(local_min(m['last'] or ''))}</td></tr>"
             for m in machines]
    drows = [f"<tr><td>{_e(d['day'])}{'*' if d.get('partial') else ''}</td>{_int(d['n'])}{_int(d['tasks'])}{_unit_cells(d)}</tr>" for d in days]
    tier_of = {a["account"]: a.get("tier") or "" for a in acct_view["rows"]}
    urows = []
    for r in rows:
        who = f"{r['caller_instance'] or '-'} / {r['caller_session'] or '-'} / {Path(r['caller_cwd']).name if r['caller_cwd'] else '-'}"
        acct = r.get("caller_account") or ""
        plan_label = accounts.label_of(tier_of.get(acct, "")) if acct else "-"
        rate, _borrowed = utilization.rate_of(rates, r.get("machine") or "")
        plan_est = utilization.weigh(r.get("est_usd"), rate)
        plan_saved = None if plan_est is None else round(plan_est - (r.get("worker_usd") or 0.0), 6)
        urows.append(f"<tr><td class='n'>{_e(r.get('seq') or '')}</td><td data-v='{_e(r['ts'])}'>{_e(local_min(r['ts']))}</td><td>{_e(r['machine'])}</td><td>{_e(r['kind'])}</td>"
                     f"<td title='{_e(r['id'])}'>{_e((r['label'] or '')[:48])}</td><td title='{_e(r['caller_cwd'])}'>{_e(who)}</td>"
                     f"<td>{_e(acct or '-')}</td><td>{_e(plan_label)}</td><td>{_e(utilization.short_model(r['orchestrator_model']))}</td>{_int(r['tasks'])}{_int(r['ok'])}"
                     f"<td>{_e(r['worker_model'])}</td>"
                     + _money(r["est_usd"], "mu") + _money(r["worker_usd"], "mu") + _money(r["saved_usd"], "mu", sign=True) + _ratio(r["est_usd"], r["worker_usd"], "mu")
                     + _tokens(r.get("est_tokens"), "mt") + _tokens(r.get("worker_tokens"), "mt") + _ratio(r.get("est_tokens"), r.get("worker_tokens"), "mt")
                     + _money(plan_est, "mp") + _money(r["worker_usd"], "mp") + _money(plan_saved, "mp", sign=True)
                     + f"<td class='muted' title='{_e(r['basis'])}'>{_e(utilization.how(r))}</td></tr>")
    body = "".join(head) + tiles_block(total, plan, rates, acct_view) + "<h2>Charts</h2>" + charts + details
    body += "<h2>Accounts</h2>" + accounts_block(acct_view)
    body += "<h2>Per machine</h2>" + _table([("machine", False), ("runs", True), ("tasks", True), *UNIT_HEAD, ("first", False), ("last", False)], mrows)
    body += (f"<h2>Per day</h2><div class='note'>Local days, {_e(tz_label())}, midnight to midnight. * = today, still being written.</div>"
             + _table([("day", False), ("runs", True), ("tasks", True), *UNIT_HEAD], drows))
    body += (f"<h2>Every run ({len(rows)}{' most recent' if len(rows) >= MAX_ROWS else ''})</h2>"
             "<div class='note'># never changes: say 'run 196'. Click a header to sort. Hover the label for the job id, the caller for the folder, 'how' for the full basis.</div>")
    body += _table([("#", True), (f"when, {tz_label()}", False), ("machine", False), ("kind", False), ("label", False), ("caller", False), ("account", False),
                    ("its plan", False), ("model at the time", False), ("tasks", True), ("ok", True), ("worker model", False),
                    ("est. Claude", True, "mu"), ("DeepSeek cost", True, "mu"), ("saved", True, "mu"), ("cheaper by", True, "mu"),
                    ("Claude tokens avoided", True, "mt"), ("DeepSeek tokens", True, "mt"), ("fewer by", True, "mt"),
                    ("worth (plan $)", True, "mp"), ("DeepSeek cost (cash)", True, "mp"), ("saved (plan $)", True, "mp"),
                    ("how", False)], urows)
    start = "plan" if plan_ok else "usd"
    return (f"<!doctype html><html><head><meta charset='utf-8'><meta name='color-scheme' content='dark'><title>hswarm running total</title>"
            f"<style>{CSS}</style></head><body class='mode-{start}'>{body}<script>{JS}</script></body></html>\n")


def html_path() -> Path:
    return config.HOME / "hswarm.html"


def write(path: Path | None = None) -> Path:
    """Render the page from the DB and write it atomically. Returns the path."""
    p = path or html_path()
    c = utilization.connect()
    try:
        mine = utilization.claude_day_rows(c, utilization.MACHINE)
        rates = utilization.plan_rates(c)
        total = utilization.totals(c)
        machines = [weigh_row(m, rates) for m in utilization.by_machine(c)]
        page = render(total, machines, per_day(c, rates), all_rows(c), utilization.current_profile(c),
                      dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), claude_by_family(c, rates), mine[0] if mine else None,
                      rates, utilization.plan_view(total, rates), account_view(c))
    finally:
        c.close()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".html.tmp")
    tmp.write_text(page, encoding="utf-8")
    tmp.replace(p)
    return p
