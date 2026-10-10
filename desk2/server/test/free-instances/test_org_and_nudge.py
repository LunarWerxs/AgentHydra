"""No-network checks: a remembered organization never blocks a new login, and nudge leaves no trace."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from claudfree import cli, http, service, state
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
        (account("claude-haiku-4-5", [{"model": "claude-sonnet-9"}]), "sonnet", True, "claude-sonnet-9"),
        ("<html>", "sonnet", True, None),
    ],
)
def test_model_for_picks_an_offered_model(body, prefer, own_default, expected):
    assert client_with(body).model_for(ORG_A, prefer, own_default=own_default) == expected


def nudge(tmp_path, monkeypatch, config, refuse=(), fail=None):
    """Run 'nudge' against a fake client offering OFFERED; returns (result or error, models sent)."""
    args = SimpleNamespace(
        command="nudge", prompt=None, chat_id=None, identifier=None, org_id=None,
        request_timeout=5, model=None, timezone="UTC", locale="en-US",
    )
    return execute(tmp_path, monkeypatch, config, args, refuse=refuse, fail=fail)


def execute(tmp_path, monkeypatch, config, args, offered=OFFERED, refuse=(), fail=None):
    sent = []

    class FakeHttp:
        last_usage = None

        def __init__(self, state, timeout=120):
            self.state = state

        def authenticate(self, preferred_org=None, *, remembered_org=None):
            return {"uuid": ORG_A}

        model_for = http.ClaudeHttp.model_for
        _account = http.ClaudeHttp._account
        _account_body = None

        def _json(self, method, path, **kwargs):
            return account(None, offered)

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
    api = SimpleNamespace(
        HTTP_CONFIG_FILE=tmp_path / "http-config.json", load_session=lambda: session, atomic_write=state.atomic_write
    )
    (tmp_path / "http-config.json").write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setattr(http, "ClaudeHttp", FakeHttp)
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


@pytest.mark.parametrize(
    "remembered, prefer, offered, expected",
    [
        # Haiku 5.5 work goes through the free accounts (owner, 2026-10-07): a new chat asked for Haiku gets one
        # even when the login last chatted on Sonnet.
        ("claude-sonnet-9", "haiku", OFFERED, "claude-haiku-9"),
        # No newer Haiku offered: the login's own model, never the org's first one (an Opus here).
        ("claude-sonnet-9", "haiku", [{"model": "claude-opus-9"}, {"model": "claude-haiku-4-5"}], "claude-sonnet-9"),
        # A remembered Haiku 4.x is never used again.
        ("claude-haiku-4-5", "sonnet", OFFERED, "claude-sonnet-9"),
        # A new chat asked for Sonnet gets one even when the login last chatted on Haiku (2026-10-10: every Free
        # Claude account answered Sonnet asks on Haiku 5.5).
        ("claude-haiku-9", "sonnet", OFFERED, "claude-sonnet-9"),
        # Asked for nothing: the login's own model.
        ("claude-haiku-9", None, OFFERED, "claude-haiku-9"),
    ],
)
def test_a_new_chat_picks_its_model(tmp_path, monkeypatch, remembered, prefer, offered, expected):
    args = cli.parse_args(["chat", "--prompt", "hello", *(["--prefer", prefer] if prefer else []), "--request-timeout", "5"])
    _, sent = execute(tmp_path, monkeypatch, {"model": remembered}, args, offered=offered)

    assert [m for _, _, m, _ in sent] == [expected]


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


@pytest.mark.parametrize(
    "capabilities, plan",
    [
        (["chat"], "free"),
        (["chat", "claude_pro"], "pro"),
        (["chat", "claude_max", "claude_pro"], "max"),  # the most specific marker wins
        (["chat", "raven"], "team"),
        ([], None),  # no capability Free lists either: unknown, never guessed as free
        (None, None),  # an organization that does not list them
    ],
)
def test_a_claude_organizations_capabilities_name_its_plan(capabilities, plan):
    # Desk marks a Free row by it and tells the owner when an account stops being free (owner, 2026-10-09).
    from claudfree.usage import plan_of

    organization = {"uuid": ORG_A, "name": "Example Owner"}
    if capabilities is not None:
        organization["capabilities"] = capabilities
    assert plan_of(organization) == plan
