"""No-network checks: a remembered organization never blocks a new login, and nudge leaves no trace."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from claudfree import cli, http, service
from claudfree.registry import ChatRegistry

ORG_A = "11111111-1111-4111-8111-111111111111"
ORG_B = "22222222-2222-4222-8222-222222222222"
ORG_C = "33333333-3333-4333-8333-333333333333"


def client_with(organizations):
    client = http.ClaudeHttp({"cookies": [], "origins": []}, session_factory=MagicMock)
    client._json = lambda *args, **kwargs: organizations
    return client


def orgs(*uuids):
    return [{"uuid": uuid, "name": "Example Owner"} for uuid in uuids]


@pytest.mark.parametrize(
    "available, preferred, remembered, expected",
    [
        # The regression: the previous account's org is gone, the new account has one org.
        ([ORG_A], None, ORG_B, ORG_A),
        ([ORG_A, ORG_B], None, ORG_B, ORG_B),
        ([ORG_A], None, "not-a-uuid", ORG_A),
        ([ORG_A, ORG_B], ORG_B, ORG_A, ORG_B),
    ],
)
def test_authenticate_picks(available, preferred, remembered, expected):
    org = client_with(orgs(*available)).authenticate(preferred, remembered_org=remembered)
    assert org["uuid"] == expected


def test_preferred_org_stays_strict():
    with pytest.raises(http.HttpError, match="does not have access"):
        client_with(orgs(ORG_A)).authenticate(ORG_B, remembered_org=ORG_A)


def test_several_orgs_without_a_default_raise():
    with pytest.raises(http.HttpError, match="Several organizations"):
        client_with(orgs(ORG_A, ORG_B)).authenticate(None, remembered_org=ORG_C)


def account(default=None, models=()):
    """An /api/account body shaped like a free account's (2026-10-06 probe), with invented values."""
    return {
        "settings": {"default_model": default},
        "memberships": [
            {"organization": {"uuid": ORG_A, "claude_ai_bootstrap_models_config": list(models)}},
            {"organization": {"uuid": ORG_B, "claude_ai_bootstrap_models_config": [{"model": "claude-other-9"}]}},
        ],
    }


OFFERED = [
    {"model": "claude-opus-9"},
    {"model": "claude-sonnet-9"},
    {"model": "claude-sonnet-8", "inactive": True},
    {"model": "claude-haiku-9"},
    {"model": "claude-haiku-8", "overflow": True},
]


@pytest.mark.parametrize(
    "body, prefer, own_default, expected",
    [
        # The regression: a login that never chatted has no default and must still get a model.
        (account(None, OFFERED), "sonnet", True, "claude-sonnet-9"),
        (account(None, OFFERED), "haiku", False, "claude-haiku-9"),
        (account("claude-opus-9", OFFERED), "sonnet", True, "claude-opus-9"),
        (account("claude-opus-9", OFFERED), "haiku", False, "claude-haiku-9"),
        (account(None, [{"model": "claude-opus-9"}]), "haiku", False, "claude-opus-9"),
        (account(None, [{"model": "claude-haiku-8", "overflow": True}]), "haiku", False, None),
        # Haiku 4.x is never picked (owner, 2026-10-07), even listed first; with no newer Haiku the
        # org's default is used, never an old Haiku own default either.
        (account(None, [{"model": "claude-haiku-4-5-20251001"}, {"model": "claude-haiku-5-5"}]), "haiku", False, "claude-haiku-5-5"),
        (account("claude-haiku-4-5", [{"model": "claude-3-5-haiku-20241022"}, {"model": "claude-sonnet-9"}]), "haiku", False, "claude-sonnet-9"),
        ("<html>", "sonnet", True, None),
    ],
)
def test_model_for_picks_an_offered_model(body, prefer, own_default, expected):
    assert client_with(body).model_for(ORG_A, prefer, own_default=own_default) == expected


def nudge(tmp_path, monkeypatch, config, refuse=(), fail=None):
    """Run 'nudge' against a fake client offering OFFERED; returns (result or error, models sent)."""
    sent = []

    class FakeHttp:
        last_usage = None

        def __init__(self, state, timeout=120):
            self.state = state

        def authenticate(self, preferred_org=None, *, remembered_org=None):
            return {"uuid": ORG_A}

        model_for = http.ClaudeHttp.model_for

        def _json(self, method, path, **kwargs):
            return account(None, OFFERED)

        def send(self, organization_id, prompt, model, **kwargs):
            sent.append((organization_id, prompt, model, kwargs))
            if fail:
                raise fail
            if model in refuse:
                raise http.HttpError("Claude rejected the HTTP request (400).", code="http_rejected", status=400)
            return {"model": model, "is_temporary": True, "response": "ok"}

        def storage_state(self):
            return self.state

        def close(self):
            pass

    session = {"cookies": [], "origins": []}
    api = SimpleNamespace(HTTP_CONFIG_FILE=tmp_path / "http-config.json", load_session=lambda: session)
    (tmp_path / "http-config.json").write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setattr(http, "ClaudeHttp", FakeHttp)
    args = SimpleNamespace(
        command="nudge", prompt=None, chat_id=None, identifier=None, org_id=None,
        request_timeout=5, model=None, timezone="UTC", locale="en-US",
    )
    try:
        outcome = service.execute(args, api=api)
    except http.HttpError as error:
        outcome = error
    return outcome, sent


def test_desk_argv_for_a_nudge_parses():
    # The argv Desk's runner builds (server/src/free-instances/runner.ts commandArgs): every HTTP command gets
    # --json --brief. The first nudge refused --brief, live on 2026-10-06, while the tests above passed.
    args = cli.parse_args(["nudge", "--provider", "claude", "--json", "--brief", "--request-timeout", "120"])
    assert (args.command, args.json_output, args.brief) == ("nudge", True, True)


def test_nudge_sends_one_temporary_message_on_haiku_and_records_nothing(tmp_path, monkeypatch):
    result, sent = nudge(tmp_path, monkeypatch, {})

    assert result == {"nudged": True, "organization_id": ORG_A}
    assert [(o, p, m) for o, p, m, _ in sent] == [(ORG_A, service.KEEPALIVE_PROMPT, "claude-haiku-9")]
    kwargs = sent[0][3]
    assert kwargs["temporary"] is True
    assert kwargs["on_text"] is None
    assert not kwargs.get("web_search")
    registry = ChatRegistry(tmp_path / "chats.sqlite3")
    try:
        assert registry.list() == []
    finally:
        registry.close()
    assert service.read_config(tmp_path / "http-config.json") == {}


def test_a_refused_nudge_retries_once_on_the_chat_model(tmp_path, monkeypatch):
    result, sent = nudge(tmp_path, monkeypatch, {"model": "claude-sonnet-9"}, refuse={"claude-haiku-9"})

    assert result == {"nudged": True, "organization_id": ORG_A}
    assert [m for _, _, m, _ in sent] == ["claude-haiku-9", "claude-sonnet-9"]


@pytest.mark.parametrize(
    "lost",
    [
        http.HttpError("The HTTP request failed.", code="network_error"),
        # A gateway timeout comes after the request reached Claude.
        http.HttpError("Claude rejected the HTTP request (504).", code="http_rejected", status=504),
    ],
)
def test_a_nudge_that_may_have_been_sent_is_never_retried(tmp_path, monkeypatch, lost):
    error, sent = nudge(tmp_path, monkeypatch, {}, fail=lost)

    assert error is lost
    assert [m for _, _, m, _ in sent] == ["claude-haiku-9"]
