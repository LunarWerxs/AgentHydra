"""Every test runs against a throwaway ~/.hswarm: the utilization DB, the daily savings file and the
sync worktree all hang off config.HOME, and a unit test must never write into the real ones."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))  # the folder holding the `hswarm` package

from hswarm import config  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch, request):
    """Every path config derives from HOME is patched, not just HOME itself: the derived ones are module
    constants fixed at import, so patching HOME alone let a test write into the real ~/.hswarm/jobs
    (caught 2026-09-16 when a new test created folders there)."""
    home = tmp_path / "hswarm-home"
    monkeypatch.setattr(config, "HOME", home)
    for name, rel in (("JOBS_DIR", "jobs"), ("LEDGER", "ledger.jsonl"), ("ROUTING", "routing.jsonl"),
                      ("CC_CONFIG_DIR", "claude-config"), ("PROVIDERS_DIR", "providers"), ("SETTINGS_FILE", "settings.toml"),
                      ("CATALOGUE_FILE", "openrouter-models.json"), ("SKILLS_DIR", "skills"),
                      ("KEYS_STATE", "keys.json"), ("SLOTS_DIR", "procslots"), ("SPILL_DIR", "spill"),
                      ("HISTORY_DIR", "history")):
        monkeypatch.setattr(config, name, home / rel)
    # Price routing is OFF in tests unless a test turns it on, and non-default providers find no key files.
    # With it on, a task for a FAKE DeepSeek client was routed to the real OpenRouter pool whenever
    # OpenRouter priced cheaper - live network calls from unit tests, 9 failures and a suite 5x slower
    # (2026-09-17). Routing is exercised on purpose in test_routing.py, which enables it itself.
    monkeypatch.setattr(config, "_PRICE_ROUTING_DEFAULT", False)
    # Plan prices come from a running AgentHydra when there is one: a unit test must not depend on the owner's.
    from hswarm import accounts

    monkeypatch.setattr(accounts, "_agenthydra_prices", lambda: {})
    # A task whose routes all failed is re-run after a rest in production (jobs.needs_other_route); with no keys in a
    # unit test nearly every task would sleep through hours of rests. Tests of the rerun turn it on themselves.
    monkeypatch.setattr(config, "DEAD_RERUN_PATIENCE_S", 0.0)
    if request.node.get_closest_marker("live") is None:
        # The machine's real keys (the environment and a clone's .secrets/) would decide which model an AUTO task
        # pins (the first LIVE route, 2026-09-25). Only `live` tests keep them: test_live.py runs when its collection
        # finds a key there, so hiding them from it failed all five instead of skipping them.
        monkeypatch.setattr(config, "SECRETS_DIR", tmp_path / "no-secrets")
        for provider in config.PROVIDERS.values():
            for env in provider.get("key_env", ()):
                monkeypatch.delenv(env, raising=False)
        # A unit test never starts the real Claude Code, and a CI runner has none: `claude` is the replay mock.
        monkeypatch.setenv("HSWARM_CLAUDE_BIN", str(MOCK_CLAUDE))
    from hswarm import keys as _keys

    monkeypatch.setattr(_keys, "_POOLS", {})
    # The registry is rebuilt from the real files at import; with HOME redirected it must be rebuilt again,
    # or a machine that has run `models --refresh` carries ~440 OpenRouter entries into every test.
    config.reload()
    monkeypatch.delenv("HSWARM_ORCHESTRATOR_MODEL", raising=False)
    monkeypatch.delenv("HSWARM_SCANNER", raising=False)
    # Armed faults are process-wide (faults._ARMED): one test's fault must never fail the next test's calls.
    from hswarm import faults as _faults

    monkeypatch.delenv(_faults.ENV, raising=False)
    # No test asks the real AgentHydra daemon (7787) where a task should run (climayte_route.py); test_climayte_route.py points this at a fake.
    monkeypatch.setenv("AGENTHYDRA_URL", "")
    monkeypatch.delenv("AGENTHYDRA_CLIMAYTE_WORKER", raising=False)
    # The same blank URL keeps free_route.py (the Free web accounts, /api/mcp) off the real daemon; its process-wide state is reset too.
    from hswarm import free_route as _free_route

    monkeypatch.setattr(_free_route, "_LOGGED", set())
    monkeypatch.setattr(_free_route, "_ACTIVE", 0)
    monkeypatch.setattr(_free_route, "_SENT", [])
    _faults.clear()
    # Crawl marks and provider load are process-wide (selection._CRAWL, _INFLIGHT, _SLOW): one test's crawling model
    # would move the next test's task off it after one turn.
    from hswarm import selection as _selection

    _selection.reset_load()
    # A NoCreditLeft trip is process-wide state (jobs._TRIPS), and submit refuses a job on a tripped leg: one test's
    # trip must not refuse the next test's job.
    from hswarm import jobs as _jobs

    monkeypatch.setattr(_jobs, "_TRIPS", {})
    # An open circuit breaker is process-wide too (breaker._LEGS): one test's failing leg must not reorder the next's plan.
    from hswarm import breaker as _breaker

    monkeypatch.setattr(_breaker, "_LEGS", {})
    # Per-key limits are process-wide (keylimits): one test's requests on a key_rpm provider must not park the next's.
    from hswarm import keylimits as _keylimits

    monkeypatch.setattr(_keylimits, "_SLOTS", {})
    monkeypatch.setattr(_keylimits, "_WAITERS", [])
    monkeypatch.setattr(_keylimits, "_HELD", {})
    # The merged keys.json write is process-wide (client._last_flush, its timer, _LIVE_POOLS): one test's write must
    # not defer the next test's first one, and a finished test's pools must not ride along in the next one's write.
    from hswarm import client as _client

    if _client._flush_timer is not None:
        _client._flush_timer.cancel()
    monkeypatch.setattr(_client, "_flush_timer", None)
    monkeypatch.setattr(_client, "_last_flush", 0.0)
    monkeypatch.setattr(_client, "_LIVE_POOLS", [])


MOCK_CLAUDE = Path(__file__).resolve().parent / "mocks" / "bin" / "claude.py"


@pytest.fixture
def mock_claude(tmp_path, monkeypatch):
    """The cc backend's `claude` swapped for the replay mock (tests/mocks/bin/claude.py): a real child
    process that plays a recorded stream-json session, so a test crosses the process boundary with no
    DeepSeek call. Call it with a recording name; it returns the capture path the mock writes
    (argv, stdin, cwd, ANTHROPIC_* names) once the worker has run."""
    capture = tmp_path / "mock-claude-capture.json"
    monkeypatch.setenv("HSWARM_CLAUDE_BIN", str(MOCK_CLAUDE))
    monkeypatch.setenv("HSWARM_MOCK_CAPTURE", str(capture))
    # The child env is an allowlist (procs.scrubbed_env): the mock's own knobs reach it only through the widening
    # an operator would use, or the mock never learns its recording or capture path.
    monkeypatch.setenv("HSWARM_CHILD_ENV_ALLOW", r"HSWARM_MOCK_\w+")

    def use(recording: str) -> Path:
        monkeypatch.setenv("HSWARM_MOCK_RECORDING", recording)
        return capture

    return use


@pytest.fixture
def user_toml():
    """Write one of the user's files the way a person would (a provider's by its name, or "settings") and reload."""
    def write(name: str, text: str) -> Path:
        path = config.SETTINGS_FILE if name == "settings" else config.PROVIDERS_DIR / f"{name}.toml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        config.reload()
        return path
    return write
