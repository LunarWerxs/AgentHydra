"""Usage pings: a configured ingest URL and key are what an event leaves the machine under."""
from __future__ import annotations

import importlib
import json

from hswarm import fleetstats


# Pins: with HSWARM_PING_URL and HSWARM_PING_KEY set, send() posts the event under that key. A line of literal
# PowerShell "`n" escapes once left KEY, URL and _session inside a comment, so no event was ever sent.
def test_a_configured_ping_posts_its_event_under_the_ingest_key(monkeypatch):
    sent = []

    class Reply:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def urlopen(req, timeout):
        sent.append((req.full_url, json.loads(req.data)))
        return Reply()

    with monkeypatch.context() as m:
        m.setenv("HSWARM_PING_URL", "https://ingest.example/v1/events")
        m.setenv("HSWARM_PING_KEY", "ak_test")
        importlib.reload(fleetstats)  # both are read at import
    try:
        monkeypatch.setattr(fleetstats, "enabled", lambda: True)  # pytest itself switches pings off
        monkeypatch.setattr(fleetstats.urllib.request, "urlopen", urlopen)
        fleetstats.send("app_open", cmd="run")
        fleetstats.flush(5)
    finally:
        importlib.reload(fleetstats)  # every later test gets the unconfigured module back
    assert sent, "no event left the machine"
    url, body = sent[-1]
    assert url == "https://ingest.example/v1/events" and body["ingestKey"] == "ak_test"
    assert body["events"][-1]["name"] == "app_open" and body["events"][-1]["props"]["cmd"] == "run"
