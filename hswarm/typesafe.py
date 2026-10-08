"""TypeSafe's Jev: a "System One" model that answers TYPED questions - pick one option, yes/no, rate on a
scale - with a probability for every answer, in about 0.15 s. It cannot write text or use tools, so it is
never a worker model; hswarm reaches it only through `hswarm_decide` (hswarm/decisions.py), where it answers
first and anything it is unsure of goes to a generative model. Measured 2026-09-21: docs/BENCH-2026-09-21-jev.md.

API: POST https://api.typesafe.ai/v1/systemone with a Bearer key and {state, model, questions: {id: question}};
one answer comes back per question id. Price $0.042 per million INPUT tokens, output free. Limits (2026-09-21,
"adjusting dynamically"): 1,200 requests/min, 250k tokens/s, 64k tokens per request of which the state plus the
longest question may use 32k. Keys: TYPESAFE_API_KEYS / TYPESAFE_API_KEY, or `~/.hswarm/secrets/typesafe_api_keys` (one
per line), or `keys = [...]` in ~/.hswarm/providers/typesafe.toml: the provider file (hswarm/providers/typesafe.toml)
owns the address and the key sources, like every other provider's. A key is never printed or logged.

The same client reaches Featherless's Simple Jev (github.com/featherless-ai/simple-jev): open models that answer
through TypeSafe's own request and response shape (its /v1/systemone is an alias of /v1/classifier) by reading the
next-token scores of the answer labels. Any model id starting `featherless-ai/` goes to the public demo, which
needs no key, refuses a question over 2k tokens with a 422 (never truncates), and allows 2 requests a second per
caller; every client of that host shares one pacer so several bench arms stay under the limit together.

It also reaches Cloudflare's Clef decision models (blog.cloudflare.com/clef-decision-models, 2026-10-01): `clef` and
`clef-flash` on Workers AI take TypeSafe's request and answer in TypeSafe's shape, inside Workers AI's
{"result": ..., "success": ...} envelope; up to 64 questions a call, 64k context. They need a Cloudflare token with
Workers AI access (CLOUDFLARE_API_TOKEN, or ~/.hswarm/secrets/cloudflare_api_keys) and the account: CLOUDFLARE_ACCOUNT_ID,
or a key line written `<account id>:<token>`. An account with no API token to keep runs hswarm/cloudflare/clef-proxy.js
instead, a Worker that reaches Clef through its AI binding, and lists it as `<worker host>:<secret>`.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
from urllib.parse import urlsplit

import httpx

from . import config, egress

URL = config.PROVIDERS["typesafe"]["base_url"] + "/systemone"
# PINNED, not the jev-latest alias: hswarm_decide's 0.7 threshold and Dredd's seat thresholds were tuned on this
# version's probabilities, and TypeSafe's models page says to pin the version a threshold was tuned against because
# the alias moves with each release. Move it after bench/decide.py has measured the new version.
MODEL = "jev-1.13.0"
USD_PER_INPUT_TOKEN = 0.042 / 1_000_000
RETRYABLE = {429, 500, 502, 503, 504, 529}
KEY_DEAD = {401, 402, 403}  # a bad, unpaid or unpermitted key does not heal inside a run
# A key in the shared disabled slot for credit gets one try this often (KeyPool.probation): TypeSafe has no balance
# endpoint that could see a top-up. The pool's own 24-hour no-credit window (client.NO_CREDIT_RECHECK_S, owner
# 2026-09-23): spent keys are not topped up, so a dead key should not be retried every few hours.
JEV_RECHECK_S = 24 * 3600.0
SIMPLE_JEV_PREFIX = "featherless-ai/"
SIMPLE_JEV_DEMO_URL = "https://simple-jev-demo-api.featherless.ai/v1/systemone"
SIMPLE_JEV_DEMO_INTERVAL = 0.5  # the demo's 2 requests/second
_NEXT_SLOT: dict[str, float] = {}  # url -> earliest monotonic time the next request may start, shared by every client
# $ per million input tokens, output free (developers.cloudflare.com/workers-ai/models/clef and /clef-flash, 2026-10-02).
CLEF_PRICES = {"clef": 0.24, "clef-flash": 0.09}
CLEF_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}"
# A cloudflare_api_keys line: `<account id>:<token>` for the REST API, or `<worker host>:<secret>` for a Worker running
# hswarm/cloudflare/clef-proxy.js (an account with no API token to keep reaches Workers AI through a Worker's binding).
CLEF_LINE = re.compile(r"^([0-9a-f]{32}|[a-z0-9-]+(?:\.[a-z0-9-]+)+):(\S+)$")
CLEF_PROXY_URL = "https://{host}/{model}"
NO_KEY = {"typesafe": f"no usable TypeSafe key (TYPESAFE_API_KEY or {config.SECRETS_DIR / 'typesafe_api_keys'})",
          "cloudflare": f"no usable Cloudflare route (CLOUDFLARE_API_TOKEN plus CLOUDFLARE_ACCOUNT_ID, or an `<account id>:<token>` or "
                        f"`<worker host>:<secret>` line in {config.SECRETS_DIR / 'cloudflare_api_keys'})"}


def is_typed_model(model: str) -> bool:
    """A model that answers typed questions natively (Jev, Clef, or an open model behind Simple Jev), not a generative one."""
    return model == "jev" or model in CLEF_PRICES or model.startswith(("jev-", SIMPLE_JEV_PREFIX))


def load_keys() -> list[str]:
    """Every TypeSafe key the provider file's sources hold: the environment, the user's file, ~/.hswarm/secrets/."""
    return config.load_api_keys("typesafe")


def _clef_lines() -> list[tuple[str, str]]:
    """(route, token) for each line of ~/.hswarm/secrets/cloudflare_api_keys: the route is an account id, a Worker host,
    or "" on a bare token. The vault syncs key lists and nothing else, so the route written into the line is what
    carries it to the other PCs: one setup reaches every machine."""
    lines = config._read_key_lines(config.SECRETS_DIR / "cloudflare_api_keys")
    return [(m.group(1), m.group(2)) if (m := CLEF_LINE.match(line)) else ("", line) for line in lines]


def clef_account() -> str:
    """The Cloudflare account Workers AI bills: CLOUDFLARE_ACCOUNT_ID, then ~/.hswarm/secrets/cloudflare_account_id, then
    the account on the first `<account id>:<token>` line, so a caller started without the variable (a Dredd bridge, the
    CreAitor) still reaches the stand-in."""
    return (os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
            or next(iter(config._read_key_lines(config.SECRETS_DIR / "cloudflare_account_id")), "")
            or next((r for r, _ in _clef_lines() if r and "." not in r), ""))


def clef_routes(model: str) -> dict[str, str]:
    """Each usable Clef credential -> the URL that serves `model` with it: the REST API for CLOUDFLARE_API_TOKEN
    (comma-separated for several) and for the file's tokens of `clef_account()` (a line for another account would
    401 there), the Worker for a `<worker host>:<secret>` line. No account means no REST credential."""
    account, routes = clef_account(), {}
    rest = CLEF_URL.format(account=account, model=model)
    for token in config._split_keys(os.environ.get("CLOUDFLARE_API_TOKEN")) if account else []:
        routes.setdefault(token, rest)
    for route, token in _clef_lines():
        if "." in route:
            routes.setdefault(token, CLEF_PROXY_URL.format(host=route, model=model))
        elif account and route in ("", account):
            routes.setdefault(token, rest)
    return routes


class Jev:
    """Async client: round-robin over the key pool, backoff on limits and overload (honouring retry-after),
    a key that answers 401/402/403 leaves the rotation for the life of this client.

    A client on the configured pool (no `keys=`) also shares those refusals through HSwarm's disabled slot
    (client.KeyPool), so a key one process found out of credit is skipped by every later one (each Dredd ask is a
    new process) and `hswarm keys` shows it. Until 2026-10-08 a key TypeSafe had refused with 402 for two days
    still read "ok" there, and nobody knew Jev was down."""

    # 30 s: an answer takes 0.15-2 s, so a longer wait is a hung connection, and a timeout is retried like a 5xx.
    def __init__(self, keys: list[str] | None = None, concurrency: int = 16, timeout: float = 30.0, http: httpx.AsyncClient | None = None,
                 *, url: str = URL, usd_per_input_token: float = USD_PER_INPUT_TOKEN, keyless: bool = False, min_interval: float = 0.0,
                 provider: str = "typesafe", urls: dict[str, str] | None = None):
        self.url, self.keyless, self.min_interval, self.provider = url, keyless, min_interval, provider
        self._urls = urls or {}  # key -> its own endpoint, when keys reach different ones (Clef's REST API and its Worker)
        self.usd_per_input_token = usd_per_input_token
        self._pool, self.disabled = None, 0
        self.keys = [] if keyless else list(keys if keys is not None else self._live_pool_keys())
        self.sem = asyncio.Semaphore(concurrency)
        self._http = http
        self._own = http is None
        self._timeout = timeout
        self._i = 0
        self.calls = 0

    @classmethod
    def for_model(cls, model: str, concurrency: int = 16, **kw) -> "Jev":
        """The client that serves `model`: TypeSafe for jev-*, the keyless Featherless demo for featherless-ai/*,
        Workers AI for clef and clef-flash, through the REST API or a clef-proxy Worker (clef_routes)."""
        if model.startswith(SIMPLE_JEV_PREFIX):
            return cls(concurrency=min(concurrency, 2), url=SIMPLE_JEV_DEMO_URL, usd_per_input_token=0.0, keyless=True,
                       min_interval=SIMPLE_JEV_DEMO_INTERVAL, **kw)
        if model in CLEF_PRICES:
            routes = clef_routes(model)
            return cls(keys=list(routes), urls=routes, concurrency=concurrency, url=CLEF_URL.format(account=clef_account(), model=model),
                       usd_per_input_token=CLEF_PRICES[model] / 1_000_000, provider="cloudflare", **kw)
        return cls(concurrency=concurrency, **kw)

    def _live_pool_keys(self) -> list[str]:
        """The configured keys minus those in the disabled slot, after letting out any disabled for credit more than
        JEV_RECHECK_S ago."""
        from .keys import pool_for

        loaded = load_keys()
        self._pool = pool_for(self.provider) if loaded else None
        if self._pool is None:
            return loaded
        self._pool.probation(JEV_RECHECK_S)
        off = set(self._pool.disabled())
        live = [k for k in loaded if config.fingerprint(k) not in off]
        self.disabled = len(loaded) - len(live)
        return live

    def _shelve(self, key: str, status: int) -> None:
        """Put a refused key in the shared slot: out of credit (402) at once, revoked (401/403) once it strikes out."""
        if self._pool is None:
            return
        if status == 402:
            self._pool.broke(key, status=402)
        else:
            self._pool.rest(key, 0, status=status, dead=True)

    @property
    def usable(self) -> bool:
        return self.keyless or bool(self.keys)

    @property
    def unusable_reason(self) -> str:
        if self.disabled and not self.keys:
            return (f"every {self.provider} key ({self.disabled}) is in the disabled slot, out of credit or revoked: "
                    f"`hswarm keys --provider {self.provider}` lists them")
        return NO_KEY.get(self.provider, f"no usable {self.provider} key")

    async def _pace(self) -> None:
        """Hold this request until the endpoint's next free slot. No await sits between reading and booking the
        slot, so concurrent tasks on one event loop can never take the same one."""
        if self.min_interval <= 0:
            return
        now = time.monotonic()
        slot = max(now, _NEXT_SLOT.get(self.url, 0.0))
        _NEXT_SLOT[self.url] = slot + self.min_interval
        if slot > now:
            await asyncio.sleep(slot - now)

    async def __aenter__(self) -> "Jev":
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=httpx.Timeout(self._timeout))
        return self

    async def __aexit__(self, *exc) -> None:
        if self._own and self._http is not None:
            await self._http.aclose()

    def _key(self) -> str | None:
        if self.keyless:
            return ""
        if not self.keys:
            return None
        self._i = (self._i + 1) % len(self.keys)
        return self.keys[self._i]

    async def ask(self, state, questions: dict, model: str = MODEL, attempts: int = 7) -> dict:
        """{"status": "ok", answers, secs, in, out, model, cost_usd} or {"status": "error", error, http}."""
        last: dict = {"status": "error", "error": self.unusable_reason, "http": None}
        body = {"state": state, "model": model, "questions": questions}
        # Serialised once so the egress receipt hashes the exact bytes that leave (egress.py).
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        for attempt in range(attempts):
            key = self._key()
            if key is None:
                return last
            url = self._urls.get(key, self.url)
            async with self.sem:
                await self._pace()
                t0 = time.perf_counter()
                egress.record(f"{self.provider}:{urlsplit(url).hostname}", payload, provider=self.provider, model=model)  # fail-closed raises here, unsent
                try:
                    headers = {"Content-Type": "application/json", **({} if self.keyless else {"Authorization": f"Bearer {key}"})}
                    resp = await self._http.post(url, content=payload, headers=headers)
                except httpx.HTTPError as e:
                    resp, last = None, {"status": "error", "error": f"{type(e).__name__}: {e}"[:200], "http": None}
                secs = time.perf_counter() - t0
                self.calls += 1
            if resp is not None and resp.status_code == 200:
                data = resp.json()
                if isinstance(data.get("result"), dict):  # Workers AI wraps the System One answer: {"result": ..., "success": ...}
                    data = data["result"]
                if self._pool is not None:
                    self._pool.recover(key)  # a struck key that answers is healthy again
                usage = data.get("usage") or {}
                tin = int(usage.get("input_tokens") or 0)
                return {"status": "ok", "answers": data.get("answers") or {}, "secs": secs, "in": tin, "out": int(usage.get("output_tokens") or 0),
                        "model": data.get("model") or model, "cost_usd": tin * self.usd_per_input_token}
            if resp is not None:
                last = {"status": "error", "error": f"HTTP {resp.status_code}: {resp.text[:180]}", "http": resp.status_code}
                if resp.status_code in KEY_DEAD:
                    if self.keyless:
                        return last  # no key to rotate: a keyless endpoint that refuses us keeps refusing
                    self.keys = [k for k in self.keys if k != key]
                    self._shelve(key, resp.status_code)
                    continue
                if resp.status_code not in RETRYABLE:
                    return last  # a 422 is a malformed question: resending it unchanged fails the same way
                ra = resp.headers.get("retry-after")
                await asyncio.sleep(float(ra) if ra and ra.replace(".", "", 1).isdigit() else _backoff(attempt))
            else:
                await asyncio.sleep(_backoff(attempt))
        return last


def _backoff(attempt: int) -> float:
    """Exponential, capped at 60 s, less up to a quarter at random so a burst of concurrent calls refused together
    does not come back together (the TypeSafe SDK's backoff_jitter)."""
    return min(2 * 2 ** attempt, 60) * (1 - 0.25 * random.random())
