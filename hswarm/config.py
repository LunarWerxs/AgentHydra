"""Configuration: paths, providers, models, roles, pricing, peak/off-peak, and API-key resolution.

Providers are OpenAI-compatible chat endpoints, one TOML file each: the shipped ones in hswarm/providers/, a
person's own in ~/.hswarm/providers/ (docs/PROVIDERS.md). Adding a provider, a model or a key is a file, never a
code change (owner asks, Michael, 2026-09-15 and 2026-09-26: "configurable expandable easy files ... so they aren't
spread all over"). ROLES map a kind of work to a model, so a task can say role: "search" and get whatever is wired
for it on this machine (~/.hswarm/settings.toml).

Prices are USD per 1M tokens. A model with no price on record costs None ("not measured", never
zero), which the ledger prints as '-'. Only DeepSeek has peak/off-peak pricing.

The API keys are resolved at runtime and never logged or printed. `key_status()` is the only
inspection surface and reports presence, length and a short fingerprint only.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import tomllib
from pathlib import Path

from . import prices

HOME = Path(os.environ.get("HSWARM_HOME") or (Path.home() / ".hswarm"))
JOBS_DIR = HOME / "jobs"
LEDGER = HOME / "ledger.jsonl"
ROUTING = HOME / "routing.jsonl"  # written by the agent_routing_gate hook: one line per Claude sub-agent decision
CC_CONFIG_DIR = HOME / "claude-config"
# Providers and models are TOML files, one per provider (docs/PROVIDERS.md): the built-ins ship in hswarm/providers/,
# the user's own live in <home>/providers/. A user file with a built-in's name layers over it; a new name is a new
# provider. A user file may also hold that provider's keys (`keys = [...]`) and the console's switches.
BUILTIN_PROVIDERS_DIR = Path(__file__).resolve().parent / "providers"
PROVIDERS_DIR = HOME / "providers"
SETTINGS_FILE = HOME / "settings.toml"  # roles, the review panel, price routing, load bias
# The OpenRouter catalogue, pulled from its own /models endpoint by `hswarm models --refresh openrouter`. Kept apart
# from the provider files so a refresh of ~440 generated entries can never overwrite a hand-written line; the user's
# files are layered AFTER it, so a price you set yourself always wins over the generated one.
CATALOGUE_FILE = HOME / "openrouter-models.json"
SKILLS_DIR = HOME / "skills"  # procedures banked by teacher escalations (escalation.py), one unreviewed .md each
SECRETS_DIR = HOME / "secrets"  # key files live with the user's state, never in the (public) clone; `hswarm import-keys` fills it
# A tool output over the sandbox cap keeps its head and tail in the worker's context; the full text lands here,
# named by its content hash, and the worker's fetch_output tool pages the omitted middle back. Moved into the history
# (history.pack_spill, never deleted) 1 day past its last use, and at most SPILL_MAX_BYTES of one output (its two ends): a handle only matters while its task runs, and at
# 7 days whole the folder was 3,247 MiB, 80% of it in 396 files over 1 MiB that no worker pages through (the largest,
# 79.6 MiB, is ~2,700 fetch_output calls) (2026-10-02).
SPILL_DIR = HOME / "spill"
# Everything past its working life, packed one archive a day and never deleted (history.py).
HISTORY_DIR = HOME / "history"
SPILL_RETENTION_S = 24 * 3600
SPILL_MAX_BYTES = 2 * 2**20
# Context hygiene for the api worker loop (context.py): once the history passes CONTEXT_TRIGGER_TOKENS, older
# tool results are swapped for a short fetch_output pointer, keeping the last CONTEXT_KEEP_TOOL_RESULTS whole.
# A pass must free at least CONTEXT_CLEAR_AT_LEAST tokens or it waits: each pass breaks the provider's cached
# prompt prefix from the first cleared result on, so it should happen rarely, in big bites. Per task: 0 = off.
CONTEXT_TRIGGER_TOKENS = 60_000
CONTEXT_CLEAR_AT_LEAST = 20_000
CONTEXT_KEEP_TOOL_RESULTS = 3
# A leg with no cache discount (price hit == miss: groq, cerebras, mistral) re-pays every tool output in full on every
# later turn, and the median 30.7k-char transcript never reaches 60k tokens. Replayed over 6,683 real multi-turn legs
# (2026-10-02), 16k/4k cut 35.8% of the chars sent on groq against 2.5-6.1% at 60k/20k (an upper bound: a cleared
# output can be fetched again). Only for a task that kept the defaults above (context.ContextEditor.for_leg).
CONTEXT_TRIGGER_UNCACHED = 16_000
CONTEXT_CLEAR_AT_LEAST_UNCACHED = 4_000

DEFAULT_PROVIDER = "deepseek"
# `anthropic_url = "facade"` in a provider file: an OpenAI-only provider runs `cc` workers through the loopback
# Anthropic Messages facade (anthropic_facade.py), started per cc run on an ephemeral port.
ANTHROPIC_FACADE = "facade"
# The registry, rebuilt by reload() from the provider files: every provider, every model (a model's `provider` is
# the file it is in), every alias, and each routed model's ordered legs (`route`, and `route_cc` for cc workers).
PROVIDERS: dict[str, dict] = {}
MODELS: dict[str, dict] = {}
ALIASES: dict[str, str] = {}
ROUTES: dict[str, tuple[str, ...]] = {}
ROUTES_CC: dict[str, tuple[str, ...]] = {}
DEFAULT_MODEL = "deepseek-flash"

# ---- the AUTO default: the right model depends on whether the task uses TOOLS (2026-09-20) ----
#
# Measured in docs/BENCH-2026-09-20-providers.md, on two suites, because these are two different skills:
#   tool-FREE reasoning   gpt-oss-120b 51/51 · deepseek-flash 48/51 · gemini-3.8-flash 45/51(+3 rate-limited)
#   tool-USING (agentic)  gemini-3.8-flash 24/24 · deepseek-flash 22/24 · glm-4.5-air 17/24 · mistral-3.5 15/24
# gpt-oss is the best reasoner AND the worst tool-caller (it emits harmony-format tool calls this backend
# 400s on), so picking one default for both would be wrong either way. A caller that names a model or a
# role still gets exactly that; AUTO only fills in the blank, from the published ranked profiles
# (selection.plan) over the providers this machine has a key for (dispatch.first_choice), never from a
# model named here: a named default is one provider's model, and a machine without that key could not call it.
AUTO = "auto"
# A leg that is ALIVE but crawling fails over like a dead one, while the task still has time (2026-09-22,
# Connections: 48 read-only code-fix tasks on the free gemini-3.8-flash leg at concurrency 48 averaged ~55-60 s
# a turn and 47 hit their 900 s timeout; the same prompts on deepseek-flash ran ~8 s a turn). Judged after
# SLOW_LEG_MIN_TURNS turns on the provider's own API seconds, never on local tool time, and never on the
# route's LAST leg - with nowhere to go, a slow answer beats none. Unless the route was CUT SHORT by missing
# credit: then the caller's own model is the next leg, and a crawl errors back as NoCreditLeft (jobs.NO_CREDIT_TRIP_S).
SLOW_LEG_TURN_S = 30.0
SLOW_LEG_MIN_TURNS = 3
# One turn this slow marks its model crawling for every task at once (selection.note_crawl), not when its leg ends;
# and on a leg with somewhere to go, a call to a model ALREADY marked crawling is cut at this age and fails over, its
# transcript kept for the next leg. The turn average above only judges turns that ended, so hung calls held their
# tasks for the provider's own timeout three times over (2026-09-27: DeepSeek V4.1 Flash on NVIDIA, 120-300 s a
# call). A call to an unmarked model that has answered on this leg is not cut: a healthy model writing a large file can
# take this long. Its FIRST call on a leg is (agent._call_turn), and a crawling later leg counts as somewhere to go then.
SLOW_LEG_CALL_S = 150.0
# An ask's leg ALREADY marked crawling keeps its place (free legs first) but gets only this long before the walk moves
# on, and only the healthy legs still to try share the rest of the budget (dispatch.ask_selected). 2026-09-29: with
# NVIDIA's free legs at 73-100 s a call, every Dredd board seat split its 120 s evenly over twenty legs, six seconds
# each, and even the healthy legs behind the crawl could not write a seat's turn in that; two Lift boards sat for nothing.
CRAWLING_LEG_TRY_S = 5.0
# A running api task with no model reply booked for this long is listed under the job summary's `quiet_running`
# (job.quiet_running). Above SLOW_LEG_CALL_S on purpose: one legitimately slow call must not read as a stall.
# Filed 2026-09-28 (job 20260928-220929-fa2b): a stalled read job looked exactly like a slow one until cancelled.
QUIET_TASK_S = 180.0
# A task on its route's LAST leg (nowhere to fail over to) may wait this long, in wall-clock seconds, on a pool
# whose keys answer 429 before its call errors with `PoolSaturated`. Before 2026-09-24 it had no bound but the
# task's own timeout_s: job 20260924-152821-54f1 lost 43 tasks at 600 s with zero replies that way.
SATURATED_REST_S = 120.0
# How many times an evaluated-profile task whose LAST leg ended `PoolSaturated` goes back through that provider's
# gate (halved by the 429s) with its transcript kept, instead of failing (dispatch.run_selected). Its run clock
# still bounds it; this only stops a pool that never recovers from looping a task that spends no run time.
SATURATED_REQUEUES = 6
# A task whose every route could not serve (jobs.needs_other_route) rests and runs again on the whole ladder until
# DEAD_RERUN_PATIENCE_S has passed since it first came back dead, and only then as an error. The rest starts at
# DEAD_RERUN_REST_S (outlasts a gate trip, SATURATED_REST_S) and doubles to DEAD_RERUN_REST_MAX_S, so a long outage
# costs a handful of probes an hour, not a hammering. Its turn and cost budgets still bound it (jobs.remaining). A
# resting task gives its concurrency slot back (jobs._Slot), so it never holds up the rest of its job.
DEAD_RERUN_PATIENCE_S = 3 * 3600.0
DEAD_RERUN_REST_S = 150.0
DEAD_RERUN_REST_MAX_S = 600.0
# How often a running job rewrites job.json with its live status (jobs.JobManager._finish), and how long a running
# record may go without one before a reader says the process running it is gone or wedged (job.Job.load_from_disk).
CHECKPOINT_S = 10.0
CHECKPOINT_SILENT_S = 120.0
# A shared server that starts on a port carries on the jobs the server before it on that port left unfinished
# (jobs.JobManager.adopt_orphans), so a restart costs no work. A record quiet for longer than this is an old crash to
# look at, not a restart, and is left as the orphan it is.
ADOPT_WITHIN_S = 1800.0
# Live calls per provider (jobs.JobManager._gate_for, leggate.LegGate): a job opens at LEG_RAMP_START, grows by
# one per reply, halves when every key is resting, and never exceeds usable keys x LIVE_PER_KEY (a provider may
# set its own `live_per_key`). Same job: 64 tasks landed on the free Gemini pool in one second and drowned it.
LEG_RAMP_START = 8
# Nothing a task waits on may outlast these, in seconds (2026-09-28, Connections burn-down: 190 builders, 12 done in
# 35 minutes). The rest of a batch waits for the pilot's first reply only PILOT_PATIENCE_S: the pilot warms DeepSeek's
# cache, and one pilot on a crawling NVIDIA model held 95 tasks idle. A task queued at a provider's gate longer than
# GATE_PATIENCE_S moves to the next leg of its route that is not crawling and has room at its gate: 94 tasks sat
# 20 minutes behind a Gemini gate halved to 2 live calls. A gate halved by 429s grows back (doubles) after
# GATE_RECOVER_S with no new 429 while tasks wait, instead of only one call per reply: that Gemini pool had 44 keys
# ready again and its gate still let 2 through.
PILOT_PATIENCE_S = 20.0
GATE_PATIENCE_S = 45.0
GATE_RECOVER_S = 30.0
# A task's turn budget when it names none. `cc` is higher because headless Claude Code pays the task folder's
# orientation cost first: on 2026-09-19, 18 of 18 cc workers on Connections died at 24 (or 18) turns with correct
# edits on disk and no report, and a ONE-file edit's floor was ~19 turns. A worker that dies at the cap costs
# full price and returns nothing, so headroom is cheaper than a retry. `lean` (spec.Task) cuts the cost itself.
DEFAULT_MAX_TURNS = {"api": 24, "cc": 40}
# The input tokens a headless Claude Code worker's FIRST turn sends: its system prompt, tool schemas and the folder's
# CLAUDE.md/AGENTS.md, before it reads a file. A conservative floor: a key whose organisation allows fewer input tokens
# a minute cannot start one cc task (input_limit.py; 10,000 on the 2026-10-02 Anthropic key failed every task).
CC_FIRST_TURN_TOKENS = 40_000
# A worker's cost cap when its task names none, by the profile AUTO resolved. 0.25 catches a reasoning runaway on the
# cheap legs most profiles lead with. `critical` leads with Opus 5.5 at xhigh ($20/M out), where 0.25 stopped a
# review of a 600-line diff after 5 turns (job 20260930-170329-0193). A named max_cost_usd always wins, and the job's
# budget_usd still caps the whole run.
# `research` and `code` WITH tools get more: over 7 days to 2026-10-02 the 0.25 default killed 343 such tasks ($68.85):
# research/read 15%, code/read 8%, research/web 8%, against 2% for research/web at an explicit $2 and 0.3% for
# code/edit at $1. A tool-free task of either profile keeps 0.25: with nothing to read, a long run is a runaway.
DEFAULT_MAX_COST_USD = {"critical": 2.0}
DEFAULT_MAX_COST_TOOLS_USD = {"research": 1.5, "code": 1.0}
DEFAULT_MAX_COST_FALLBACK_USD = 0.25


def default_max_cost_usd(profile: str | None, tools: str | list[str] | None = None) -> float:
    by_profile = DEFAULT_MAX_COST_USD if is_tool_free(tools) else {**DEFAULT_MAX_COST_USD, **DEFAULT_MAX_COST_TOOLS_USD}
    return by_profile.get(profile or "", DEFAULT_MAX_COST_FALLBACK_USD)


LIVE_PER_KEY = 4
# Load bias (the idea behind DeepSeek-V3's bias-only MoE gate: a bias picks the expert, the unbiased score still
# measures it). AUTO ranks evaluated candidates by benchmark cost; a provider's live pressure - tasks this process
# has committed to it plus its SlowLeg/PoolSaturated marks from the last SLOW_MARK_S, over usable keys x
# LIVE_PER_KEY, capped at 1 - inflates the cost a candidate is RANKED on by up to this fraction, so a batch spreads
# over near-equal legs before one saturates (2026-09-22: 48 tasks on one free leg, 47 timed out). Only the order
# moves: capability floors still filter, and the plan keeps the unbiased benchmark_cost_usd. 0 turns it off;
# HSWARM_LOAD_BIAS or `load_bias` in settings.toml override it.
def _float_env(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(name) or default))
    except ValueError:
        return default


_LOAD_BIAS_DEFAULT = _float_env("HSWARM_LOAD_BIAS", 0.5)
LOAD_BIAS = _LOAD_BIAS_DEFAULT
# The most this machine spends in one local day (`daily_cap_usd` in settings.toml): once the ledger says today reached
# it, new jobs and asks are refused (ledger.over_daily_cap); work already running finishes. None: no cap.
DAILY_CAP_USD: float | None = None
SLOW_MARK_S = 600.0


def is_tool_free(tools: str | list[str] | None) -> bool:
    """True when a task runs with NO tools, so the tool-free default applies."""
    if not tools:
        return True
    if isinstance(tools, str):
        t = tools.strip().lower()
        return t in ("", "none") or not [x for x in t.split(",") if x.strip()]
    return not list(tools)


def default_model_for(tools: str | list[str] | None = "read", backend: str = "api") -> str:
    """The model AUTO resolves to: the first published-profile candidate capable of these tools on this backend
    (e.g. `cc` needs an Anthropic Messages endpoint), on a provider this machine has a key for when any can serve."""
    from .dispatch import first_choice
    from .selection import profile_for

    return first_choice(profile_for(None, tools), tools=tools, backend=backend)


# A role is a kind of work; the model wired to it is a machine decision ([roles] in settings.toml), not a code one.
# None means "nothing wired yet": a task asking for that role fails loudly instead of silently using flash.
# Wired 2026-09-20 from the same benchmark: the two roles that are grading/writing text with no tools go to
# the best tool-free model; the two that must read a repo go to the best tool-using one.
ROLES: dict[str, str | None] = {
    "default": AUTO,
    "search": AUTO,
    "code": AUTO,
    "judge": AUTO,
    # Grades a worker's recorded TRACE against expectations (hswarm/trace.py, hswarm/skillbench.py). Its own role, not
    # `judge`, so a machine can move trace grading to another model without moving every answer judge with it.
    "grader": AUTO,
    "summarize": AUTO,
    "review": AUTO,  # scores a diff against its task and reads the files it touches (profile: code; rubric: review.py)
    "vision": AUTO,
    # The review roles (review.py) carry a written contract on top of the model: refute must read the repo to
    # disprove a finding -> tool-using; doubt reviews an artifact it is handed -> tool-free, and meant to be a
    # non-Claude model so the orchestrator's second opinion comes from another family (the wiring's choice, not enforced).
    "refute": AUTO,
    "doubt": AUTO,
}

# The blind panel beside the judge role (hswarm_panel, panel.py): the models that review ONE prompt side by side and
# then rebut each other anonymously. Empty means AUTO: two makers' models this machine's keys reach
# (dispatch.default_panel), because a panel of one model's training agrees with itself. A machine sets its own with
# `panel = [...]` in settings.toml.
PANEL: list[str] = []

# Peak windows, UTC, Monday-Friday: 01:00-04:00 and 06:00-10:00.
PEAK_WINDOWS = prices.peak_windows()  # DeepSeek's full-rate hours, written once in data/prices.json

# ---- routing (owner ask, Michael, 2026-09-17: take the cheaper path to a model, per call) ----
#
# One logical model, several paths to it (a model's `route` in its provider file), in two TIERS. Price orders paths
# WITHIN a tier and never across (route_plan): a path marked `fallback` serves only when no primary path has a key
# with credit, because the side-by-side benchmark (docs/BENCH-2026-09-17.md) found the router legs weaker on code
# review and slower, and the owner's doctrine is "cheaper only with NO regression". The route's own order breaks ties
# within a tier. `cc` owns its request body, so it cannot carry OpenRouter's host steer: a model's `route_cc` says
# where cc goes instead.
# The token mix a swarm task ACTUALLY has, measured across 7,577 `api` rows in this machine's ledger
# on 2026-09-17: 65.1% cache hits, 31.8% cache misses, 3.1% output. Routing compares paths on this
# blend rather than on any single rate, because the rates differ in SHAPE: a path that looks cheaper
# on output can cost more overall when two thirds of the tokens are cache hits. This decides only
# WHICH path is taken; what the ledger records is always the real cost of the call that happened.
REFERENCE_MIX = {"hit": 0.651, "miss": 0.318, "out": 0.031}
# On by default, off with HSWARM_PRICE_ROUTING=off (or `routing = false` in settings.toml), because silently
# serving a model from another provider is the kind of thing an operator must be able to stop.
# NOT named ROUTING: that is already this module's path to routing.jsonl, the agent_routing_gate's log.
_PRICE_ROUTING_DEFAULT = (os.environ.get("HSWARM_PRICE_ROUTING") or "on").strip().lower() not in ("0", "off", "false", "no")
PRICE_ROUTING = _PRICE_ROUTING_DEFAULT
# `route_via_climayte` in settings.toml: ask AgentHydra (POST /api/routing/decide) whether an agentic task should run as a
# CliMayte worker on the owner's Claude subscription instead of its API route (climayte_route.py). On by default.
# A LOCAL opt-out ANDed with AgentHydra's own routing switch (settings.enabled of /api/routing/cost-model): both must be on.
ROUTE_VIA_CLIMAYTE = True
# `route_via_climayte_max`: tasks routed to CliMayte at once across the server process; a task over it takes its API route
# without asking. `route_via_climayte_start_s`: a worker not running by then is cancelled and the task runs on its API route.
ROUTE_VIA_CLIMAYTE_MAX = 4
ROUTE_VIA_CLIMAYTE_START_S = 90.0
# `route_via_free` in settings.toml: a TOOL-FREE task of an ordinary profile is first sent to the owner's signed-in Free
# claude.ai and chatgpt.com accounts through AgentHydra (free_route.py), at no cost, before any paid API leg. On by default.
# `route_via_free_max`: tasks on free accounts at once across the server process. `route_via_free_profiles`: the profiles
# that may go (never critical by default); an unlisted profile takes its API route without asking.
ROUTE_VIA_FREE = True
ROUTE_VIA_FREE_MAX = 6
_ROUTE_VIA_FREE_PROFILES_DEFAULT = ("routine", "general", "research", "decision")
ROUTE_VIA_FREE_PROFILES = _ROUTE_VIA_FREE_PROFILES_DEFAULT

_CORES = os.cpu_count() or 4
# Process discipline (owner, Michael, 2026-09-15: "make sure we don't end up spinning up a billion sub
# processes and murdering my cpu"). `api` workers are HTTP calls and cost no process; what costs CPU is the
# children the sandbox spawns (ripgrep, bash, git) and the headless Claude Code `cc` workers. Every child
# goes through procgate: at most MAX_TOOL_PROCS per server process, MACHINE_MAX_PROCS across every hswarm
# process on the box, at normal priority (the count is the discipline). Override with HSWARM_MAX_PROCS / HSWARM_MACHINE_PROCS.
MAX_TOOL_PROCS = max(2, int(os.environ.get("HSWARM_MAX_PROCS") or max(2, _CORES // 4)))
MACHINE_MAX_PROCS = max(2, int(os.environ.get("HSWARM_MACHINE_PROCS") or max(4, _CORES // 2)))
DEFAULT_CONCURRENCY = {"api": 64, "cc": min(6, max(2, _CORES // 4))}
MAX_CONCURRENCY = {"api": 2000, "cc": max(2, min(32, _CORES // 4))}  # a cc worker is a whole Node process
KEYS_STATE = HOME / "keys.json"      # per-key rest/strike state, shared by every hswarm process (fingerprints only)
SLOTS_DIR = HOME / "procslots"       # one file per live child process, machine-wide

# The switches `hswarm ui` writes into the user's provider files: a model with `enabled = false` (or any model of a
# provider with `enabled = false`) is never routed to, and a model's `priority` puts it ahead of the benchmark-cost
# order in AUTO, lowest number first. Floors still filter: priority reorders, it never admits.
DISABLED_MODELS: set[str] = set()
PRIORITY: dict[str, int] = {}
# What the shipped files alone define, after `inherits`: what AUTO checks an evaluated model against (a user file must
# not keep a model's evidence while changing what it runs), and which providers and models are the user's own.
BUILTIN_PROVIDERS: dict[str, dict] = {}
BUILTIN_MODELS: dict[str, dict] = {}

_TUPLE_FIELDS = ("key_env", "key_files", "options", "passthrough", "omit")
_ROLES_DEFAULT, _PANEL_DEFAULT = dict(ROLES), list(PANEL)
_LOADED: tuple = ()  # the stamp of the files the registry was last built from; refresh() compares it
_LAST_GOOD: dict[str, dict] = {}  # file -> its last readable parse, so a broken hand edit never drops a provider


class ConfigError(ValueError):
    """A provider or settings file that is there but cannot be read or is not valid TOML."""


def read_toml(path: Path) -> dict:
    """A config file, strictly: {} only when it does not exist. A read Windows refuses while another process swaps
    the file in is retried; a file that is not valid TOML raises ConfigError, because treating it as empty would drop
    every setting and key in it."""
    for attempt in range(3):
        try:
            text = path.read_text(encoding="utf-8")
            break
        except FileNotFoundError:
            return {}
        except OSError as e:
            if attempt == 2:
                raise ConfigError(f"{path} could not be read ({e})") from e
            time.sleep(0.05 * (attempt + 1))
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path} is not valid TOML ({e}); fix it by hand") from e


def _user_doc(path: Path) -> dict:
    """A user file for the registry: a broken one keeps what it last said (or nothing, the first time) and says why
    on stderr, so one typo cannot take a provider or its keys away from a running server."""
    try:
        doc = read_toml(path)
    except ConfigError as e:
        good = _LAST_GOOD.get(str(path))
        print(f"[hswarm] {e}; {'keeping what it said before' if good is not None else 'ignoring it'} until it is fixed", file=sys.stderr)
        return good or {}
    _LAST_GOOD[str(path)] = doc
    return doc


def ranks(value) -> dict[str, int]:
    """A priority mapping from a file, cleaned: name -> whole number 1 (first) to 999. Anything malformed is dropped,
    never fatal."""
    if not isinstance(value, dict):
        return {}
    return {str(k).strip().lower(): n for k, n in value.items() if _rank(n) is not None}


def _rank(n) -> int | None:
    return n if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 999 else None


def _default_provider(name: str) -> dict:
    """What a provider file leaves out: keys from <NAME>_API_KEYS / <NAME>_API_KEY and <home>/secrets/<name>_api_keys."""
    env = re.sub(r"[^A-Z0-9]", "_", name.upper())
    return {"key_env": (f"{env}_API_KEYS", f"{env}_API_KEY"), "key_files": (f"{name}_api_keys",), "options": (),
            "models_path": None, "balance_path": None}


def _add_provider(name: str, doc: dict, user: bool) -> None:
    spec = {k: (tuple(v) if k in _TUPLE_FIELDS and isinstance(v, list) else v)
            for k, v in doc.items() if k not in ("models", "keys")}  # keys are read where they are used (user_keys)
    for k in ("base_url", "anthropic_url"):
        if isinstance(spec.get(k), str):
            spec[k] = spec[k].strip().rstrip("/")
    if "key_priority" in spec:
        spec["key_priority"] = ranks(spec["key_priority"])
    PROVIDERS[name] = PROVIDERS.get(name, _default_provider(name)) | spec
    _add_models(name, doc.get("models"), user)


def _add_models(provider: str, models, user: bool) -> None:
    for raw, spec in (models or {}).items():
        if not isinstance(spec, dict):
            continue
        name, spec = str(raw).strip().lower(), dict(spec)
        if user:  # the console's switches, kept beside the model they switch
            if spec.pop("enabled", True) is False:
                DISABLED_MODELS.add(name)
            if (n := _rank(spec.pop("priority", None))) is not None:
                PRIORITY[name] = n
        if not spec:
            continue  # switches only: the model itself is defined in a shipped file
        for alias in spec.pop("aliases", None) or ():
            ALIASES[str(alias).strip().lower()] = name
        for key, table in (("route", ROUTES), ("route_cc", ROUTES_CC)):
            legs = spec.pop(key, None)
            if isinstance(legs, list) and legs:
                table[name] = tuple(str(x).strip().lower() for x in legs)
                if key == "route" and user and "route_cc" not in spec:
                    ROUTES_CC.pop(name, None)  # a hand-written order wins for cc too, unless route_cc says otherwise
        ref = spec.pop("price_ref", None)  # the price lives in data/prices.json (prices.py); the registry carries its resolved shape
        if ref and "price" not in spec and "peak" not in spec:
            found = prices.registry_price(str(ref))
            if found is None:
                print(f"[hswarm] {provider}/{name}: price_ref {ref!r} is not in data/prices.json; the model stays unpriced", file=sys.stderr)
            else:
                spec["peak" if found[1] else "price"] = found[0]
                if over := prices.registry_price_over(str(ref)):
                    spec["price_over"] = over  # a long prompt's tier (Haiku 5.5): price() picks it per call
        old = MODELS.get(name, {})
        merged = {**old, **spec}
        # A table changes only what it names, one level down too: `price = {out = 0.5}` keeps the shipped hit and
        # miss rates rather than pricing them at zero, and so on for peak and extra.
        for k in ("price", "peak", "extra"):
            if isinstance(old.get(k), dict) and isinstance(spec.get(k), dict):
                merged[k] = {**old[k], **spec[k]}
        if "price" in spec and "peak" not in spec:
            merged.pop("peak", None)  # a price written here is the price; a shipped peak table would win over it
        if "price" in spec and "price_over" not in spec:
            merged.pop("price_over", None)  # and a shipped long-prompt tier would replace it on long prompts
        MODELS[name] = {**merged, "provider": provider}


def _inherit() -> None:
    """`inherits = "<model>"`: the model starts as a copy of that one (its wire id included) and its own lines change
    what differs. How an evaluated AUTO configuration ("rank:...") rides a model defined for routing. A parent that
    inherits in turn is resolved first, whatever order the files loaded in; a cycle stops where it closes."""
    done: dict[str, dict] = {}

    def resolved(name: str, seen: tuple) -> dict:
        if name in done:
            return done[name]
        m, parent_name = MODELS[name], MODELS[name].get("inherits") or ""
        if parent_name in MODELS and parent_name not in seen and parent_name != name:
            parent = resolved(parent_name, (*seen, name))
            base = {k: v for k, v in parent.items() if k not in ("fallback", "benchmark_slug", "inherits", "siblings")}
            if "price" in m:  # a price written on the child is its price: the parent's peak or long-prompt tier would win
                for tier in ("peak", "price_over"):
                    if tier not in m:
                        base.pop(tier, None)
            m = {**base, "api_id": parent.get("api_id") or parent_name, **m}
        done[name] = m
        return m

    for name in list(MODELS):
        MODELS[name] = resolved(name, ())


def _apply_settings(doc: dict) -> None:
    global PRICE_ROUTING, LOAD_BIAS, DAILY_CAP_USD, ROUTE_VIA_CLIMAYTE, ROUTE_VIA_CLIMAYTE_MAX, ROUTE_VIA_CLIMAYTE_START_S
    global ROUTE_VIA_FREE, ROUTE_VIA_FREE_MAX, ROUTE_VIA_FREE_PROFILES
    cap = doc.get("daily_cap_usd")
    if isinstance(cap, (int, float)) and not isinstance(cap, bool) and cap > 0:
        DAILY_CAP_USD = float(cap)
    if isinstance(doc.get("routing"), bool):
        PRICE_ROUTING = doc["routing"]
    if isinstance(doc.get("route_via_climayte"), bool):
        ROUTE_VIA_CLIMAYTE = doc["route_via_climayte"]
    mx, st = doc.get("route_via_climayte_max"), doc.get("route_via_climayte_start_s")
    if isinstance(mx, int) and not isinstance(mx, bool) and mx >= 0:
        ROUTE_VIA_CLIMAYTE_MAX = mx
    if isinstance(st, (int, float)) and not isinstance(st, bool) and st > 0:
        ROUTE_VIA_CLIMAYTE_START_S = float(st)
    if isinstance(doc.get("route_via_free"), bool):
        ROUTE_VIA_FREE = doc["route_via_free"]
    fmx, fpr = doc.get("route_via_free_max"), doc.get("route_via_free_profiles")
    if isinstance(fmx, int) and not isinstance(fmx, bool) and fmx >= 0:
        ROUTE_VIA_FREE_MAX = fmx
    if isinstance(fpr, list) and all(isinstance(p, str) for p in fpr):
        ROUTE_VIA_FREE_PROFILES = tuple(p.strip().lower() for p in fpr)
    bias = doc.get("load_bias")
    if isinstance(bias, (int, float)) and not isinstance(bias, bool) and bias >= 0:
        LOAD_BIAS = float(bias)
    ROLES.update({str(k).lower(): (str(v).lower() if v else None) for k, v in (doc.get("roles") or {}).items()})
    if isinstance(doc.get("panel"), list) and len(doc["panel"]) >= 2:
        PANEL[:] = [str(m).strip().lower() for m in doc["panel"]]


def _read_json(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _builtins() -> list[tuple[str, dict]]:
    """The shipped provider files, parsed once. A broken one is a bug in the release, so it raises."""
    return [(f.stem.lower(), tomllib.loads(f.read_text(encoding="utf-8"))) for f in sorted(BUILTIN_PROVIDERS_DIR.glob("*.toml"))]


_BUILTIN_DOCS = _builtins()


def _reset() -> None:
    global PRICE_ROUTING, LOAD_BIAS, DAILY_CAP_USD, ROUTE_VIA_CLIMAYTE, ROUTE_VIA_CLIMAYTE_MAX, ROUTE_VIA_CLIMAYTE_START_S
    global ROUTE_VIA_FREE, ROUTE_VIA_FREE_MAX, ROUTE_VIA_FREE_PROFILES
    for table in (PROVIDERS, MODELS, ALIASES, ROUTES, ROUTES_CC, DISABLED_MODELS, PRIORITY, ROLES):
        table.clear()
    ROLES.update(_ROLES_DEFAULT)
    PANEL[:] = _PANEL_DEFAULT
    # Reset with everything else: a settings file that says nothing about routing must not leave a
    # `routing = false` from a PREVIOUS read standing (it did until 2026-09-17).
    PRICE_ROUTING, LOAD_BIAS, DAILY_CAP_USD = _PRICE_ROUTING_DEFAULT, _LOAD_BIAS_DEFAULT, None
    ROUTE_VIA_CLIMAYTE, ROUTE_VIA_CLIMAYTE_MAX, ROUTE_VIA_CLIMAYTE_START_S = True, 4, 90.0
    ROUTE_VIA_FREE, ROUTE_VIA_FREE_MAX, ROUTE_VIA_FREE_PROFILES = True, 6, _ROUTE_VIA_FREE_PROFILES_DEFAULT
    for name, doc in _BUILTIN_DOCS:
        _add_provider(name, doc, user=False)


def reload() -> None:
    """Rebuild the registry: the shipped provider files, then the generated catalogue (`hswarm models --refresh`),
    then the user's provider files and settings.toml. Order is the point: a price a person wrote outlives the next
    refresh. Called at import; tests call it too."""
    global _LOADED
    stamp = _stamp()  # taken before the reads: a change landing mid-read shows up as a new stamp next refresh()
    _reset()
    for name, spec in (_read_json(CATALOGUE_FILE).get("models") or {}).items():
        if isinstance(spec, dict) and spec.get("provider") in PROVIDERS:
            MODELS[str(name).strip().lower()] = spec
    for cache in (_LAST_GOOD, _KEYS_READ):  # a file that is gone takes what it last said with it
        for path in [p for p in cache if not Path(p).exists()]:
            del cache[path]
    for f in sorted(PROVIDERS_DIR.glob("*.toml")):
        if not NAME_RX.match(f.stem.lower()):
            print(f"[hswarm] {f.name}: not a provider name; ignoring it", file=sys.stderr)
            continue
        _add_provider(f.stem.lower(), _user_doc(f), user=True)
    _apply_settings(_user_doc(SETTINGS_FILE))
    _inherit()
    _LOADED = stamp
    from . import redaction  # the exact-value key scrub rebuilds its set from the keys this reload can see
    redaction.forget_keys()


def _stamp() -> tuple:
    out = []
    for p in (CATALOGUE_FILE, SETTINGS_FILE, *sorted(PROVIDERS_DIR.glob("*.toml"))):
        try:
            st = p.stat()
            out.append((p.name, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((p.name, None))
    return tuple(out)


def refresh() -> bool:
    """Rebuild the registry when a file it was built from changed on disk, so a long-lived MCP server takes what
    `hswarm ui` or a hand edit wrote without a restart. A few stats; True when it reloaded. Called where work enters
    (JobManager.submit, ask_routed, hswarm_select), never per turn."""
    if _stamp() == _LOADED:
        return False
    reload()
    return True


def provider_enabled(provider: str) -> bool:
    """False for a provider switched off in settings (`enabled = false` in its user file)."""
    return PROVIDERS.get(provider, {}).get("enabled", True) is not False


# 2026-10-03: AgentHydra has no launcher script and the package is not installed, so `python -m hswarm` only worked from
# the AgentHydra root. This bootstrap puts the package's parent (argv[1]) on sys.path and runs the module, so it
# starts from any folder with no install. No backslash and no double quote, so one command string, a stdio
# command/args pair and a TOML array all carry it unchanged.
_BOOTSTRAP = ("import sys,runpy;sys.path.insert(0,sys.argv[1]);sys.argv[1:2]=[];"
              "runpy.run_module('hswarm',run_name='__main__',alter_sys=True)")


def launcher() -> list[str]:
    """The command that runs THIS hswarm from any working folder, installed or not. Every registration, scheduled
    task and detached start uses it; callers append the subcommand."""
    return [sys.executable, "-c", _BOOTSTRAP, str(Path(__file__).resolve().parent.parent)]


def _register_passthrough(name: str, original: str | None = None) -> str | None:
    """A provider that fronts a whole catalogue (OpenRouter: ~440 models) must not need a code change per model.
    `or:deepseek/deepseek-chat-v3.1` registers that model on the spot and returns its registry name. It carries
    NO price until `hswarm models --refresh openrouter` writes the live rates, so its cost reads '-' rather than
    a guessed number - except that OpenRouter reports the real charged cost on every call, which the client uses."""
    for provider, spec in PROVIDERS.items():
        for prefix in spec.get("passthrough") or ():
            if name.startswith(prefix) and len(name) > len(prefix):
                # The registry key is lowercase; the WIRE id keeps the caller's case, because a Hugging Face
                # repo id is case-sensitive (`DeepSeek-V4.1-Flash` exists, `deepseek-v4.1-flash` is a 400).
                api_id = (original or name)[len(prefix):].strip()
                # `or:<id>#<host>` pins ONE upstream, no fallback: the only way to measure a single host,
                # because OpenRouter's default (and even an `order` preference) bounces a multi-turn task
                # between hosts at different quantisations (125 of 150 tasks did, 2026-09-17). Unpriced on
                # purpose - a host's rate is not the model page's - and the call reports what it billed.
                api_id, _, host = api_id.partition("#")
                api_id, host = api_id.strip(), host.strip()
                if not api_id:
                    return None
                entry: dict = {"provider": provider, "api_id": api_id, "passthrough": True}
                if host and spec.get("host_pin") == "suffix":
                    entry["api_id"] = f"{api_id}:{host}"  # Hugging Face: the host is part of the model id
                elif host:
                    entry["extra"] = {"provider": {"only": [host], "allow_fallbacks": False}}  # OpenRouter: a request field
                MODELS.setdefault(name, entry)
                return name
    return None


def resolve_model(name: str | None) -> str:
    if not name:
        return DEFAULT_MODEL
    n = name.strip().lower()
    # AUTO with no tools context: fall back to the TOOL-USING pick, which is the safe one - it can do
    # tool-free work too, where the reverse may not be. Callers that know
    # their tools (Task._resolve_backend) resolve AUTO themselves before reaching here.
    if n == AUTO:
        return default_model_for("read")
    n = ALIASES.get(n, n)
    if n not in MODELS and _register_passthrough(n, name.strip()):
        return n
    if n not in MODELS:
        raise ValueError(f"unknown model {name!r}; known: {sorted(MODELS)} (aliases {sorted(ALIASES)}). Add it as "
                         f"[models.<name>] in {PROVIDERS_DIR}{os.sep}<provider>.toml (docs/PROVIDERS.md), or address an "
                         "OpenRouter model directly as 'or:<its id>'.")
    return n


def api_model_id(model: str) -> str:
    """The id the PROVIDER's endpoint expects, which is the registry name unless the entry overrides it
    (`or:deepseek/deepseek-chat-v3.1` is sent as `deepseek/deepseek-chat-v3.1`)."""
    return MODELS[resolve_model(model)].get("api_id") or resolve_model(model)


def resolve_role(role: str | None) -> str:
    """The model wired to a role; a role with nothing wired fails loudly instead of silently using flash."""
    if not role:
        return DEFAULT_MODEL
    r = role.strip().lower()
    if r not in ROLES:
        raise ValueError(f"unknown role {role!r}; known: {sorted(ROLES)}. Add one under [roles] in {SETTINGS_FILE}")
    if not ROLES[r]:
        raise ValueError(f"no model wired for role {role!r}; set `{r} = \"<model>\"` under [roles] in {SETTINGS_FILE}")
    if ROLES[r] == AUTO:
        from .dispatch import first_choice
        from .selection import profile_for

        return first_choice(profile_for(r, "none"), vision=r == "vision")
    return resolve_model(ROLES[r])


def provider_of(model: str) -> str:
    return MODELS[resolve_model(model)]["provider"]


def sees(model: str) -> bool:
    """True when `model` reads image content parts (`vision = true` in its provider file).
    Unmarked means blind: a model is never trusted with pictures on a guess."""
    return bool(MODELS[resolve_model(model)].get("vision"))


def free_tier(model: str) -> bool:
    """True when `model` is served by a provider whose file says `free_tier = true`. A free tier's terms may let
    it keep what it is sent, which is what HSWARM_REDACT_FREE_TIER keys on (redaction.py)."""
    try:
        return bool(PROVIDERS.get(provider_of(model), {}).get("free_tier"))
    except (KeyError, ValueError):  # a model not in the registry (a test fake) has no provider terms to go by
        return False


def billed_of(model: str) -> bool | None:
    """Does a call to `model` take money from an account? True: paid per use. False: free or trial (a provider whose
    calls cost nothing, an OpenRouter `:free` model, or a provider file that says its key pool is free tier with
    `key_billing = "free"`). None: not known (a provider with a free tier or trial whose keys may be either). The
    ledger writes this beside cost_usd (the list price), so a report can tell money spent from value used."""
    try:
        spec = PROVIDERS.get(provider_of(model), {})
        if spec.get("free_calls") or api_model_id(model).endswith(":free"):
            return False
    except (KeyError, ValueError):  # a model not in the registry (a test fake) has no terms to go by
        return None
    say = spec.get("key_billing")
    if say in ("free", "paid"):
        return say == "paid"
    if say == "unknown" or spec.get("free_tier"):
        return None
    return True


def billed_of_legs(models: list[str]) -> bool | None:
    """One answer for a task that spent on several legs (failover, escalation): the shared answer, else None, since the
    ledger line carries one cost for all of them and cannot say which part was money."""
    seen = {billed_of(m) for m in models if m}
    return seen.pop() if len(seen) == 1 else None


def is_peak(when: dt.datetime | None = None) -> bool:
    t = (when or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    if t.weekday() >= 5:
        return False
    return any(lo <= t.hour < hi for lo, hi in PEAK_WINDOWS)


def next_rate_change(when: dt.datetime | None = None) -> tuple[dt.datetime, str]:
    """Return (utc time of the next peak/off-peak switch, state after the switch)."""
    t = (when or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    now_peak = is_peak(t)
    probe = t
    for _ in range(24 * 8):
        probe = probe + dt.timedelta(hours=1)
        if is_peak(probe) != now_peak:
            return probe, ("peak" if not now_peak else "off-peak")
    return probe, "off-peak"


def price(model: str, when: dt.datetime | None = None, prompt_tokens: int = 0) -> dict | None:
    """{hit, miss, out} USD per 1M at this moment, plus `write` where the model prices a prompt cache write (Anthropic:
    1.25x input for the 5-minute cache; a model without one pays input for it). None for a model with no price on record.
    A model with a `price_over` tier (Haiku 5.5) charges it on one request whose `prompt_tokens` is over its threshold;
    0 (a total, or a size not known) is the first tier."""
    m = MODELS[resolve_model(model)]
    if m.get("peak"):
        f = 1.0 if is_peak(when) else 0.5
        return {k: v * f for k, v in m["peak"].items()}
    p = m.get("price")
    over = m.get("price_over")
    if p and over and prompt_tokens > int(over.get("prompt_tokens") or 0):
        p = over
    if not p:
        return None
    rates = {"hit": float(p.get("hit", p.get("miss", 0.0)) or 0.0), "miss": float(p.get("miss") or 0.0), "out": float(p.get("out") or 0.0)}
    if p.get("write"):
        rates["write"] = float(p["write"])
    return rates


def blended_price(model: str, when: dt.datetime | None = None) -> float | None:
    """One number for comparing paths: USD per 1M tokens at REFERENCE_MIX. None when unpriced."""
    p = price(model, when)
    return None if p is None else sum(p[k] * w for k, w in REFERENCE_MIX.items())


def routes_for(model: str, backend: str = "api") -> tuple[str, ...]:
    """Every concrete model that can serve `model`, itself included. Just itself when nothing is wired.
    The `cc` backend has its own order where one is written down (ROUTES_CC), because Claude Code cannot
    carry an OpenRouter host steer."""
    m = resolve_model(model)
    if backend == "cc" and ROUTES_CC.get(m):
        return ROUTES_CC[m]
    return ROUTES.get(m) or (m,)


def route_options(model: str, when: dt.datetime | None = None, backend: str = "api") -> list[dict]:
    """Every path to `model`, cheapest first at `when`. An unpriced path sorts last: it cannot be
    compared, so it is never chosen over one whose cost is known."""
    out = []
    for name in routes_for(model, backend):
        try:
            blended = blended_price(name, when)
        except (ValueError, KeyError):
            continue  # a route naming a model this machine no longer knows is skipped, never fatal
        out.append({"model": name, "provider": provider_of(name), "usd_per_1m": blended,
                    "rates": price(name, when), "fallback": bool(MODELS[resolve_model(name)].get("fallback"))})
    return sorted(out, key=lambda r: (r["usd_per_1m"] is None, r["usd_per_1m"] or 0.0))


def route_plan(model: str, when: dt.datetime | None = None, usable=None, backend: str = "api") -> list[str]:
    """Every path to `model` in the order to try them: primary legs cheapest first, then fallback legs
    cheapest first, each filtered to providers that can take a request (`usable(provider) -> bool`).
    The first entry is the route; the rest are what a task fails over to when that leg is UNAVAILABLE
    (no eligible endpoint, out of credit, the host down) - never when the work itself failed.
    With routing off, or nothing usable, it is just the model as asked for: routing can redirect a
    call, never make one impossible, and a failure then names what the caller actually chose."""
    if not PRICE_ROUTING:
        return _switched_on([resolve_model(model)], model)
    opts = [o for o in route_options(model, when, backend) if o["model"] not in DISABLED_MODELS]
    if usable is not None:
        opts = [o for o in opts if usable(o["provider"])]
    # Price orders legs within a tier, never across tiers: a cheaper path that benchmarked worse stays a
    # fallback until the pool it backs up runs dry, or the owner promotes it.
    plan = [o["model"] for o in opts if not o["fallback"]] + [o["model"] for o in opts if o["fallback"]]
    return plan or _switched_on([resolve_model(model)], model)


def _switched_on(plan: list[str], asked: str) -> list[str]:
    """A model switched off in settings is never called, even when a task names it outright."""
    if plan and plan[0] in DISABLED_MODELS:
        raise ValueError(f"model {asked!r} is switched off in settings; turn it on in `hswarm ui` "
                         f"(or remove `enabled = false` from it in {user_file(provider_of(plan[0]))})")
    return plan


def cheapest_route(model: str, when: dt.datetime | None = None, usable=None) -> str:
    """The path a call takes right now: the head of route_plan()."""
    return route_plan(model, when, usable)[0]


def cost_usd(model: str, hit: int, miss: int, out: int, when: dt.datetime | None = None, write: int = 0,
             prompt_tokens: int = 0) -> float | None:
    """USD for one call. `write` is the part of `miss` written to the prompt cache, billed at the `write` rate.
    `prompt_tokens` is that one call's prompt (hit + miss), which picks a tiered model's rates; a caller holding
    totals of many calls leaves it 0 and gets the first tier."""
    p = price(model, when, prompt_tokens)
    if p is None:
        return None  # not measured, never zero: the ledger prints '-'
    write = min(int(write or 0), miss)
    return (hit * p["hit"] + (miss - write) * p["miss"] + write * p.get("write", p["miss"]) + out * p["out"]) / 1_000_000.0


def _read_key_lines(path: Path) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]


def _split_keys(s: str | None) -> list[str]:
    return [k.strip() for k in re.split(r"[,;\s]+", s or "") if k.strip()]


NAME_RX = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")  # a provider or model name: also a file name, so never a path


def user_file(provider: str) -> Path:
    """The user's own file for a provider: its settings over the shipped ones, its models, its switches and its keys
    (`keys = [...]`). `hswarm ui` and `hswarm keys add` write it; so can a person. Read through HOME at call time, so
    HSWARM_HOME (and a test's home) is honoured. A name that is not a provider name (`../settings`, a drive path) is
    refused: removing a provider deletes this file."""
    if not NAME_RX.match(provider or ""):
        raise ConfigError(f"{provider!r} is not a provider name (lowercase letters, digits, '.', '_' or '-')")
    return PROVIDERS_DIR / f"{provider}.toml"


def user_source(provider: str) -> str:
    """The label of the one key source hswarm edits (the user's file), built from the real path."""
    path = user_file(provider)
    try:
        return "~/" + path.relative_to(Path.home()).as_posix()
    except ValueError:
        return path.as_posix()


_KEYS_READ: dict[str, tuple] = {}  # file -> ((mtime, size), its keys)


def user_keys(provider: str) -> list[str]:
    """The `keys` in the user's file for a provider, re-read when the file changed: keys.pool_for asks every few
    seconds, so a key added by hand or in `hswarm ui` reaches a running server without a restart. A file that stops
    parsing keeps the keys it had."""
    path = user_file(provider)
    try:
        st = path.stat()
    except OSError:
        return []
    stamp, hit = (st.st_mtime_ns, st.st_size), _KEYS_READ.get(str(path))
    if hit and hit[0] == stamp:
        return list(hit[1])
    try:
        doc = read_toml(path)
    except ConfigError:
        return list(hit[1]) if hit else []
    raw = doc.get("keys") or ()
    raw = [raw] if isinstance(raw, str) else raw  # a hand-written `keys = "sk-..."` is one key, not one per character
    keys = list(dict.fromkeys(k.strip() for k in raw if isinstance(k, str) and k.strip()))
    _KEYS_READ[str(path)] = (stamp, keys)
    return keys


def key_sources(provider: str = DEFAULT_PROVIDER) -> tuple:
    """(name, reader) pairs for a provider: its environment variables, then the user's file, then the key files in
    <home>/secrets/ (one key per line). All of them feed the pool, in this order."""
    p = PROVIDERS[provider]
    env = tuple((f"env:{e}", (lambda e=e: _split_keys(os.environ.get(e)))) for e in p.get("key_env", ()))
    mine = ((user_source(provider), lambda: user_keys(provider)),)
    files = tuple((f"<home>/secrets/{f}", (lambda f=f: _read_key_lines(SECRETS_DIR / f))) for f in p.get("key_files", ()))
    return env + mine + files


def fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:8]


def all_keys(provider: str = DEFAULT_PROVIDER) -> list[str]:
    """Every distinct key from every source, in source order, whether or not the provider is switched on."""
    return list(dict.fromkeys(k for _name, fn in key_sources(provider) for k in fn() if k))


def load_api_keys(provider: str = DEFAULT_PROVIDER) -> list[str]:
    """all_keys, or empty when the provider is switched off in settings: no key is what makes every route treat it
    as unavailable."""
    return all_keys(provider) if provider_enabled(provider) else []


def no_key_message(provider: str = DEFAULT_PROVIDER) -> str:
    if not provider_enabled(provider):
        return f"{provider} is switched off in settings; turn it on in `hswarm ui` (or remove `enabled = false` from {user_file(provider)})."
    env = " or ".join(PROVIDERS.get(provider, {}).get("key_env") or ("<PROVIDER>_API_KEY",))
    return (f"No {provider} API key found. Add one in `hswarm ui`, with `hswarm keys add {provider}`, or as "
            f"`keys = [\"...\"]` in {user_file(provider)}; or set {env}.")


def load_api_key(provider: str = DEFAULT_PROVIDER) -> str:
    keys = load_api_keys(provider)
    if keys:
        return keys[0]
    raise RuntimeError(no_key_message(provider))


def key_status(provider: str = DEFAULT_PROVIDER) -> dict:
    """Presence, count, sources and fingerprints only. Never returns a key."""
    keys = load_api_keys(provider)
    sources = []
    for name, fn in key_sources(provider):
        n = len([k for k in fn() if k])
        if n:
            sources.append({"source": name, "keys": n})
    return {
        "present": bool(keys),
        "count": len(keys),
        "sources": sources,
        "source": sources[0]["source"] if sources else None,
        "length": len(keys[0]) if keys else 0,
        "fingerprint": fingerprint(keys[0]) if keys else None,
        "fingerprints": [fingerprint(k) for k in keys],
    }


def providers_status() -> dict:
    """Every provider: base URL, keys (fingerprints only), the models registered for it and whether they are priced."""
    out = {}
    for name, p in PROVIDERS.items():
        models = sorted(m for m, spec in MODELS.items() if spec.get("provider") == name)
        out[name] = {
            "base_url": p.get("base_url"), "keys": key_status(name)["count"], "models": models,
            "unpriced_models": [m for m in models if price(m) is None], "docs": p.get("docs"),
        }
    return out


def ensure_dirs() -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    CC_CONFIG_DIR.mkdir(parents=True, exist_ok=True)


_reset()
_inherit()
BUILTIN_PROVIDERS.update({k: dict(v) for k, v in PROVIDERS.items()})
BUILTIN_MODELS.update({k: dict(v) for k, v in MODELS.items()})
reload()
