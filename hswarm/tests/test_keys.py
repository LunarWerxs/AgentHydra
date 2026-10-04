"""Offline: the key pool (several DeepSeek keys, round-robin, rested on 429 and on dead-key statuses)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, keystate  # noqa: E402
from hswarm.client import DeepSeekClient, KeyPool  # noqa: E402
from hswarm.usage import ApiError  # noqa: E402

import pytest


@pytest.fixture(autouse=True)
def _isolated_key_state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys-state.json")


K = ["sk-aaaa1111", "sk-bbbb2222", "sk-cccc3333"]


def test_config_pool_merges_env_and_files_in_order(tmp_path, monkeypatch):
    keys_file = tmp_path / "deepseek_api_keys"
    keys_file.write_text("# team keys\nsk-file-one\n\nsk-file-two\nsk-file-one\n", encoding="utf-8")
    single = tmp_path / "deepseek_api_key"
    single.write_text("sk-single\n", encoding="utf-8")
    monkeypatch.setattr(config, "SECRETS_DIR", tmp_path)  # a clone's .secrets/: the pool file, then the older single key
    monkeypatch.setenv("DEEPSEEK_API_KEYS", "sk-env-a, sk-env-b")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-env-b")
    assert config.load_api_keys() == ["sk-env-a", "sk-env-b", "sk-file-one", "sk-file-two", "sk-single"]
    assert config.load_api_key() == "sk-env-a"
    st = config.key_status()
    assert st["present"] and st["count"] == 5 and len(st["fingerprints"]) == 5
    assert all(len(f) == 8 for f in st["fingerprints"]) and "sk-" not in json.dumps(st)


def test_config_no_keys_is_a_clear_error(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SECRETS_DIR", tmp_path)
    monkeypatch.delenv("DEEPSEEK_API_KEYS", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    assert config.load_api_keys() == [] and not config.key_status()["present"]
    try:
        config.load_api_key()
    except RuntimeError as e:
        assert "deepseek.toml" in str(e) and "DEEPSEEK_API_KEY" in str(e)
    else:
        raise AssertionError("expected RuntimeError")


def test_pool_round_robins_and_rests():
    p = KeyPool(K + [K[0]])  # duplicate is dropped
    assert len(p) == 3
    assert [p.pick() for _ in range(4)] == [K[0], K[1], K[2], K[0]]
    p.rest(K[1], 60)
    assert p.available() == 2
    assert [p.pick() for _ in range(3)] == [K[1 + 1], K[0], K[2]]  # the resting key is skipped
    p.rest(K[0], 60)
    p.rest(K[2], 30)
    assert p.available() == 0
    assert p.pick() == K[2]  # all resting: the one that wakes soonest
    st = p.status()
    assert [s["fingerprint"] for s in st] == [config.fingerprint(k) for k in K] and st[2]["resting_s"] <= 30


def _client_with_transport(handler, keys=K) -> DeepSeekClient:
    c = DeepSeekClient(api_keys=keys)
    c._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    return c


def _ok(model="deepseek-flash"):
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}, "model": model})


def test_every_request_takes_the_next_key():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req.headers["Authorization"].removeprefix("Bearer "))
        return _ok()

    c = _client_with_transport(handler)

    async def go():
        for _ in range(4):
            await c.chat([{"role": "user", "content": "x"}])

    asyncio.run(go())
    assert seen == [K[0], K[1], K[2], K[0]]


def test_429_rotates_at_once_without_sleeping():
    seen = []

    def handler(req: httpx.Request):
        key = req.headers["Authorization"].removeprefix("Bearer ")
        seen.append(key)
        if key == K[0]:
            return httpx.Response(429, headers={"retry-after": "30"}, json={"error": "rate"})
        return _ok()

    c = _client_with_transport(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert seen == [K[0], K[1]] and c.rotations == 1
    assert c.pool.available() == 2  # the rate-limited key is resting for the retry-after
    asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert seen[-1] == K[2]  # round robin continued past the resting key


def test_a_rate_limited_pool_is_left_at_once_when_the_task_has_another_leg():
    """Every key answers 429: a call with another leg to go to raises a 429 failover understands instead of
    sleeping out the Retry-After on each attempt (2026-09-23: 25-33 minutes a task on a resting Gemini pool)."""
    from hswarm.jobs import leg_unavailable
    from hswarm.spec import Result

    seen = []

    def handler(req: httpx.Request):
        seen.append(req.headers["Authorization"].removeprefix("Bearer "))
        return httpx.Response(429, headers={"retry-after": "30"}, json={"error": "rate"})

    c = _client_with_transport(handler)
    with pytest.raises(ApiError) as e:
        asyncio.run(asyncio.wait_for(c.chat([{"role": "user", "content": "x"}], rest_budget_s=5), timeout=5))
    assert e.value.status == 429 and "rate-limited" in str(e.value)
    assert seen == K  # each key once, then out - no sleep on the Retry-After
    assert leg_unavailable(Result(id="t", backend="api", model="m", status="error", error=str(e.value)))


def test_dead_key_is_rested_and_the_next_one_serves():
    seen = []

    def handler(req: httpx.Request):
        key = req.headers["Authorization"].removeprefix("Bearer ")
        seen.append(key)
        if key == K[0]:
            return httpx.Response(402, json={"error": "insufficient balance"})
        return _ok()

    c = _client_with_transport(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert seen == [K[0], K[1]]
    # Since 2026-09-17 a 402 DISABLES the key: sticky, no timer, never handed out again (owner ask).
    assert [s["disabled"] for s in c.pool.status()] == [True, False, False]
    assert [s["state"] for s in c.pool.status()] == ["disabled", "ok", "ok"]
    assert c.pool.status()[0]["disabled_reason"] == "out of credit (402)" and c.pool.status()[0]["resting_s"] == 0


def test_single_dead_key_still_raises():
    def handler(req: httpx.Request):
        return httpx.Response(401, json={"error": "revoked"})

    c = _client_with_transport(handler, keys=[K[0]])
    try:
        asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    except ApiError as e:
        assert e.status == 401
    else:
        raise AssertionError("expected ApiError")


def test_balances_report_per_key_without_the_key():
    def handler(req: httpx.Request):
        key = req.headers["Authorization"].removeprefix("Bearer ")
        if key == K[2]:
            return httpx.Response(401, json={"error": "revoked"})
        return httpx.Response(200, json={"is_available": True, "balance_infos": [{"currency": "USD", "total_balance": "1.00"}]})

    c = _client_with_transport(handler)
    rows = asyncio.run(c.balances())
    assert len(rows) == 3 and "balance" in rows[0] and "error" in rows[2]
    assert "sk-" not in json.dumps(rows)


def test_dead_key_state_is_shared_and_backs_off(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    a = KeyPool(K)
    a.rest(K[0], 0, status=402, dead=True)
    st = {s["fingerprint"]: s for s in a.status()}[config.fingerprint(K[0])]
    assert st["strikes"] == 1 and 590 < st["resting_s"] <= 600 and not st["dead"]
    b = KeyPool(K)  # a second process reads the same record
    assert b.available() == 2 and b.pick() == K[1]
    b.rest(K[0], 0, status=402, dead=True)
    b.rest(K[0], 0, status=401, dead=True)
    a._load(force=True)
    st = {s["fingerprint"]: s for s in a.status()}[config.fingerprint(K[0])]
    assert st["strikes"] == 3 and st["dead"] and 2390 < st["resting_s"] <= 2400  # 10 -> 20 -> 40 minutes
    raw = json.dumps(keystate.read_all())
    assert "sk-" not in raw  # fingerprints only on disk
    a.recover(K[0])
    b._load(force=True)
    assert b.available() == 3 and {s["strikes"] for s in b.status()} == {0}


def test_dead_rest_survives_a_thousand_strikes(tmp_path, monkeypatch):
    # A revoked key probed 1,024 times made 2**1023 overflow float, and every `hswarm keys probe` crashed on it.
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    p = KeyPool(K)
    for _ in range(1030):
        p.rest(K[0], 0, status=401, dead=True)
    st = {s["fingerprint"]: s for s in p.status()}[config.fingerprint(K[0])]
    assert st["strikes"] == 1030 and st["dead"]


def test_rest_is_capped_at_six_hours(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    p = KeyPool(K)
    for _ in range(9):
        p.rest(K[2], 0, status=401, dead=True)
    st = {s["fingerprint"]: s for s in p.status()}[config.fingerprint(K[2])]
    assert st["strikes"] == 9 and st["resting_s"] <= 6 * 3600 and st["resting_s"] > 5 * 3600


# --- out of balance: parked, not rested (2026-09-16) ---------------------------------------------


def _balance(usd: str, available: bool = True) -> httpx.Response:
    return httpx.Response(200, json={"is_available": available, "balance_infos": [
        {"currency": "USD", "total_balance": usd, "granted_balance": "0.00", "topped_up_balance": usd}]})


def _key_of(req: httpx.Request) -> str:
    return req.headers["Authorization"].removeprefix("Bearer ")


def test_a_402_parks_the_key_until_a_top_up_and_the_next_key_serves():
    seen = []
    topped_up = {"k0": False}

    def handler(req: httpx.Request):
        key = _key_of(req)
        if req.method == "GET":
            return _balance("5.00") if (key != K[0] or topped_up["k0"]) else _balance("-0.11", available=False)
        seen.append(key)
        if key == K[0] and not topped_up["k0"]:
            return httpx.Response(402, json={"error": {"message": "Insufficient Balance"}})
        return _ok()

    c = _client_with_transport(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert seen == [K[0], K[1]]
    st = c.pool.status()
    # Disabled, not rested: no timer at all, so nothing ever puts it back with a real request.
    assert st[0]["disabled"] and st[0]["status"] == 402 and st[0]["resting_s"] == 0, st[0]
    assert st[0]["broke"] and not st[1]["broke"] and not st[2]["broke"]  # `broke` still reads as "out"
    assert c.pool.disabled() == [config.fingerprint(K[0])]
    # Disabled means never handed out: four more requests go round the other two.
    for _ in range(4):
        asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert K[0] not in seen[2:] and sorted(set(seen[2:])) == [K[1], K[2]]
    # A probe that still reads empty keeps it disabled (the old code cleared any key that answered).
    rows = asyncio.run(c.balances())
    assert rows[0]["usable"] is False and c.pool.status()[0]["disabled"]
    # Topped up: the next probe clears it and it serves again.
    topped_up["k0"] = True
    rows = asyncio.run(c.balances())
    assert rows[0]["usable"] is True
    st = c.pool.status()
    assert not st[0]["broke"] and not st[0]["disabled"] and st[0]["resting_s"] == 0 and st[0]["strikes"] == 0 and st[0]["balance_usd"] == 5.0
    for _ in range(3):
        asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert K[0] in seen[-3:]  # back in the rotation


_USAGE_LIMIT = "You have reached your specified API usage limits. You will regain access on {} UTC."


@pytest.mark.parametrize("refusal", [
    # groq answers a key whose organisation hit its spend alert with a 400, per key: 2026-09-27 one refresh run met it
    # 20 times while 7 calls on groq's other keys answered, and each meeting failed the task's whole leg.
    {"message": "Organization has blocked API access because a spend alert threshold was met.",
     "type": "invalid_request_error", "code": "spend_limit_reached"},
    # Anthropic's two: no credit, and the spend limit the key's organisation set (2026-09-30: seven builder tasks
    # died on the second with `failover: []` while ~39 of 45 keys were ready).
    {"message": "Your credit balance is too low to access the Anthropic API.", "type": "invalid_request_error"},
    {"code": "invalid_request_error", "message": _USAGE_LIMIT.format("2026-10-01 at 00:00"), "type": "invalid_request_error"},
])
def test_a_spend_blocked_key_is_disabled_and_the_next_key_serves(refusal):
    seen = []

    def handler(req: httpx.Request):
        if req.method == "GET":
            return _balance("5.00")
        seen.append(_key_of(req))
        if _key_of(req) == K[0]:
            return httpx.Response(400, json={"error": refusal})
        return _ok()

    c = _client_with_transport(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert seen == [K[0], K[1]] and c.pool.disabled() == [config.fingerprint(K[0])]


def test_a_usage_limited_key_comes_back_on_the_date_it_names(monkeypatch):
    # The refusal says when the key serves again, so probation lets it out then, not on the 24-hour no-credit
    # wind-down: that would retry a key limited for a week every day, and hold one limited for an hour a whole day.
    import datetime as dt
    import time
    regain = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3)).replace(second=0, microsecond=0)

    def handler(req: httpx.Request):
        if req.method == "GET":
            return _balance("5.00")
        if _key_of(req) == K[0]:
            return httpx.Response(400, json={"error": {"type": "invalid_request_error",
                                                       "message": _USAGE_LIMIT.format(regain.strftime("%Y-%m-%d at %H:%M"))}})
        return _ok()

    c = _client_with_transport(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    monkeypatch.setattr(time, "time", lambda: regain.timestamp() - 86400)  # past the 24 h wind-down, a day before the date
    assert c.pool.probation() == [] and c.pool.disabled() == [config.fingerprint(K[0])]
    monkeypatch.setattr(time, "time", lambda: regain.timestamp() + 1)
    assert c.pool.probation() == [config.fingerprint(K[0])] and c.pool.disabled() == []


def test_a_balance_probe_at_or_under_zero_parks_the_key_before_any_request():
    seen, gets = [], []

    def handler(req: httpx.Request):
        key = _key_of(req)
        if req.method == "GET":
            gets.append(key)
            if key == K[1]:
                return _balance("-0.54", available=False)
            if key == K[2]:
                return _balance("0.00", available=False)  # exactly nothing left is nothing left
            return _balance("18.29")
        seen.append(key)
        return _ok()

    c = _client_with_transport(handler)
    assert c.pool.balance_stale()  # never probed
    parked = asyncio.run(c.probe_balances())
    assert parked == [config.fingerprint(K[1]), config.fingerprint(K[2])]
    assert len(gets) == 3 and not c.pool.balance_stale()
    for _ in range(4):
        asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert seen == [K[0]] * 4  # the only key with balance serves everything
    # Fresh readings are not probed again; a stale window is. The disabled keys wait for their own, longer one.
    assert asyncio.run(c.probe_balances()) == [] and len(gets) == 3
    assert asyncio.run(c.probe_balances(max_age_s=0.0)) == [] and gets[3:] == [K[0]]
    assert asyncio.run(c.probe_balances(max_age_s=0.0, disabled_age_s=0.0)) == parked and len(gets) == 7


def test_a_disabled_key_is_re_read_only_on_its_long_window_and_a_top_up_still_heals_it():
    # Owner, 2026-09-17: the spent keys will likely never be topped up, so check occasionally and assume no.
    gets, topped_up = [], []

    def handler(req: httpx.Request):
        if req.method == "GET":
            gets.append(_key_of(req))
            if _key_of(req) == K[0] and not topped_up:
                return _balance("-0.20", available=False)
            return _balance("5.00")
        return _ok()

    c = _client_with_transport(handler)
    assert asyncio.run(c.probe_balances()) == [config.fingerprint(K[0])] and len(gets) == 3
    # The live keys' window passes; the disabled key's has not.
    assert c.pool.stale_keys(max_age_s=0.0) == K[1:]
    assert asyncio.run(c.probe_balances(max_age_s=0.0)) == [] and sorted(gets[3:]) == K[1:]
    topped_up.append(True)
    assert c.pool.status()[0]["disabled"] and c.pool.available() == 2
    # Its own window passes: the free read sees the top-up and the key is back in rotation.
    assert asyncio.run(c.probe_balances(max_age_s=0.0, disabled_age_s=0.0)) == [] and len(gets) == 8
    assert not c.pool.status()[0]["disabled"] and c.pool.available() == 3


def test_a_probe_reads_every_key_at_once_and_keeps_the_pool_order():
    flight = {"now": 0, "peak": 0}

    async def handler(req: httpx.Request):
        flight["now"] += 1
        flight["peak"] = max(flight["peak"], flight["now"])
        await asyncio.sleep(0.05)
        flight["now"] -= 1
        return _balance("-1.00", available=False) if _key_of(req) == K[1] else _balance("2.00")

    c = _client_with_transport(handler)
    rows = asyncio.run(c.balances())
    assert flight["peak"] == 3, flight  # one by one, sixteen real keys took 7 s
    assert [r["fingerprint"] for r in rows] == [config.fingerprint(k) for k in K]
    assert [r["usable"] for r in rows] == [True, False, True]
    assert [r["fingerprint"] for r in asyncio.run(c.balances([K[2]]))] == [config.fingerprint(K[2])]


def test_the_doctor_no_longer_heals_a_key_it_can_see_is_empty():
    def handler(req: httpx.Request):
        if req.method == "GET":
            return _balance("-0.11", available=False) if _key_of(req) == K[0] else _balance("3.30")
        return _ok()

    c = _client_with_transport(handler)
    c.pool.broke(K[0])
    assert c.pool.status()[0]["broke"] and c.pool.available() == 2
    asyncio.run(c.balances())
    st = c.pool.status()[0]
    # Still parked, the reading recorded, and NO second strike: "still empty" is the same failure seen again.
    assert st["broke"] and st["strikes"] == 1 and st["balance_usd"] == -0.11 and c.pool.available() == 2


def test_a_200_clears_the_parking_but_keeps_the_reading():
    p = KeyPool([K[0]])
    assert p.note_balance(K[0], 12.5, True) is True and not p.balance_stale()
    p.broke(K[0])  # a 402 since the reading
    st = p.status()[0]
    assert st["broke"] and st["balance_usd"] == 0.0 and st["strikes"] == 1
    p.recover(K[0])
    st = p.status()[0]
    assert not st["broke"] and st["strikes"] == 0 and st["resting_s"] == 0 and st["balance_age_s"] is not None
    assert not p.balance_stale()  # the reading survived the recovery, so no re-probe for it


def test_an_unknown_balance_shape_parks_nothing():
    from hswarm.client import balance_reading

    assert balance_reading({"credits": 3}) == (None, None)
    assert balance_reading("junk") == (None, None)
    assert balance_reading({"is_available": True, "balance_infos": [
        {"currency": "CNY", "total_balance": "-0.41"}, {"currency": "USD", "total_balance": "0.50"}]}) == (0.5, True)
    assert balance_reading({"is_available": False, "balance_infos": [{"currency": "USD", "total_balance": "x"}]}) == (None, False)
    p = KeyPool(K)
    assert p.note_balance(K[0], None, None) is True and not p.status()[0]["broke"]
    assert p.note_balance(K[1], None, False) is False and p.status()[1]["broke"]


# --- the review of the parking (2026-09-16): the shared file, a failed probe, the provider's flag ------------


def test_a_park_in_one_process_survives_a_rest_in_another(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    a, b = KeyPool(K), KeyPool(K)  # two hswarm processes on one state file, both loaded just now
    a.broke(K[0])
    b.rest(K[1], 20.0, status=429)  # b wrote back the dict it had read before a's disable, and it was gone
    st = KeyPool(K).status()
    assert st[0]["disabled"] and st[0]["broke"] and st[1]["resting_s"] > 0, st
    a.rest(K[2], 20.0, status=429)  # and a's next write does not undo b's rest either
    # Two pools in ONE process share its merged write, so a's rest waits behind b's; a second process's first write
    # would go out at once, which is what this flush stands in for.
    a.flush()
    st = KeyPool(K).status()
    assert st[0]["broke"] and st[1]["resting_s"] > 0 and st[2]["resting_s"] > 0, st


def test_a_rest_writes_only_its_own_row(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    a, b = KeyPool(K), KeyPool(K)
    a.broke(K[0])
    a.broke(K[1])
    seen = max(rev for _, _, rev in keystate.read_changes(None))
    b.rest(K[2], 20.0, status=429)
    b.flush()
    rows = keystate.read_changes(seen)
    assert [fp for fp, _, _ in rows] == [config.fingerprint(K[2])]  # one row, not the whole state
    a._load(force=True)
    assert a.status()[2]["resting_s"] > 0 and a.status()[0]["broke"]  # and the other process picks just that row up


def test_a_failed_probe_counts_as_a_probe_and_leaves_every_record_alone():
    gets = []

    def handler(req: httpx.Request):
        if req.method == "GET":
            gets.append(_key_of(req))
            return httpx.Response(503, text="balance endpoint down")
        return _ok()

    c = _client_with_transport(handler)
    c.pool.broke(K[0], balance_usd=-0.2)
    c.pool.note_balance(K[1], 7.0, True)
    assert c.pool.balance_stale()  # K[2] was never probed
    # The disabled key's window is forced open so the failed read reaches it too; K[1]'s reading is fresh.
    assert asyncio.run(c.probe_balances(disabled_age_s=0.0)) == [config.fingerprint(K[0])]  # still parked, and said so
    assert sorted(gets) == [K[0], K[2]]
    # Nothing was learned, so nothing changed: the park and the reading stand...
    st = c.pool.status()
    assert st[0]["broke"] and st[0]["balance_usd"] == -0.2 and st[1]["balance_usd"] == 7.0 and not st[2]["broke"], st
    # ...and the pool does not ask again inside the window (every task of a job re-probed a down endpoint,
    # under the job's lock, waiting out the connect timeout three times per task).
    assert not c.pool.balance_stale()
    assert asyncio.run(c.probe_balances()) == [] and len(gets) == 2


def test_an_unknown_reading_leaves_a_parked_key_parked_and_its_balance_alone():
    p = KeyPool(K)
    p.broke(K[0], balance_usd=-0.2)
    assert p.note_balance(K[0], None, None) is False  # it said "usable", and wiped the -0.20, until 2026-09-16
    st = p.status()[0]
    assert st["broke"] and st["balance_usd"] == -0.2 and st["strikes"] == 1, st


def test_the_providers_own_flag_decides_and_the_number_only_when_there_is_none():
    from hswarm.client import balance_reading

    # A CNY-only body is not a dollar figure; the flag is what it says.
    assert balance_reading({"is_available": True, "balance_infos": [{"currency": "CNY", "total_balance": "12.00"}]}) == (None, True)
    assert balance_reading({"balance_infos": [{"total_balance": "3.25"}]}) == (3.25, None)  # one unlabelled balance
    p = KeyPool(K)
    assert p.note_balance(K[0], 0.0, True) is True and not p.status()[0]["broke"]  # the provider says it serves
    assert p.note_balance(K[1], 9.0, False) is False and p.status()[1]["broke"]  # and when it says it does not
    assert p.note_balance(K[2], 0.0, None) is False and p.status()[2]["broke"]  # no flag: at or under zero is empty


def test_a_key_whose_daily_quota_is_spent_rests_until_the_reset_not_twenty_seconds():
    """2026-09-24 (jobs 20260924-154437-ebda, 20260924-205816-dd94): Gemini's free tier answers the 21st request of
    the day with a 429 whose quotaId says PerDay. Rested 20 s, the spent key was handed straight back to every task;
    rested until the reset, the pool reads empty, so route_plan drops the leg and the task fails over at once."""
    from hswarm import client as client_mod

    body = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [{"violations": [
        {"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}
    c = _client_with_transport(lambda req: httpx.Response(429, headers={"retry-after": "37"}, json=body), keys=K[:1])
    with pytest.raises(ApiError):
        asyncio.run(asyncio.wait_for(c.chat([{"role": "user", "content": "x"}], rest_budget_s=5), timeout=5))
    assert c.pool.available() == 0
    assert c.pool.soonest_wake() == pytest.approx(client_mod._until_quota_reset(), abs=60)


_GEMINI_ZERO = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [{"metadata": {
    "quota_limit": "GenerateContentRequestsPerMinutePerProjectPerRegion", "quota_limit_value": "0", "quota_location": "us-south1"}}]}}


@pytest.mark.parametrize("headers,body", [
    ({"retry-after": "7"}, _GEMINI_ZERO),  # Gemini says it in the body
    ({"x-ratelimit-limit-req-minute": "0", "x-ratelimit-remaining-req-minute": "0"}, {"message": "Requests rate limit exceeded"}),  # Mistral, in a header
])
def test_a_key_with_a_zero_quota_where_the_call_landed_rests_half_an_hour_not_twenty_seconds(headers, body):
    """2026-09-26: every Gemini key answered 429 with quota_limit_value "0" for its project in us-south1. Rested 20 s,
    the pool was rotated for 34 minutes per task by 124 builders, all of which died; rested long, the leg leaves the
    plan until the keys wake. The same day every sampled Mistral key answered 429 with a request limit of 0 a minute."""
    from hswarm import client as client_mod

    c = _client_with_transport(lambda req: httpx.Response(429, headers=headers, json=body), keys=K[:1])
    with pytest.raises(ApiError):
        asyncio.run(asyncio.wait_for(c.chat([{"role": "user", "content": "x"}], rest_budget_s=5), timeout=5))
    assert c.pool.available() == 0
    assert c.pool.soonest_wake() == pytest.approx(client_mod.ZERO_QUOTA_REST_S, abs=60)


# Contract: "ready" in the console means the provider accepted the key. A key it refuses (401) goes to the disabled
# slot with the reason and the answer never carries the key. Regression: a key shown ready that every call rejects.
def test_a_checked_key_the_provider_refuses_is_disabled_with_the_reason(monkeypatch):
    from hswarm import keys

    good, bad = "sk-check-good-0001", "sk-check-bad-00002"
    monkeypatch.setenv("GROQ_API_KEYS", f"{good},{bad}")

    def handler(req: httpx.Request):
        ok = req.headers["Authorization"].endswith(good)
        return httpx.Response(200 if ok else 401, json={"data": []} if ok else {"error": {"message": "invalid api key"}})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw))
    assert asyncio.run(keys.check("groq", config.fingerprint(good)))["result"] == "ok"
    r = asyncio.run(keys.check("groq", config.fingerprint(bad)))
    assert r["result"] == "rejected" and "sk-check" not in json.dumps(r)
    row = next(x for x in KeyPool([good, bad], "groq").status() if x["fingerprint"] == config.fingerprint(bad))
    assert row["disabled"] and "rejected this key" in row["disabled_reason"]


# Contract: a key added from the terminal is checked with the provider, like one pasted in the console, and a key the
# provider refuses is not kept. Regression: `hswarm keys add` saved whatever it was given (audit, 2026-09-26).
def test_the_terminal_does_not_keep_a_key_the_provider_refuses(monkeypatch, capsys):
    from hswarm import cli, keys

    async def refused(provider, fingerprint):
        return {"fingerprint": fingerprint, "result": "rejected", "note": "groq rejected this key (HTTP 401)"}

    monkeypatch.setattr(keys, "check", refused)
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO("gsk_not_a_real_key_0001\n"))
    assert cli.main(["keys", "add", "groq"]) == 1
    assert config.user_keys("groq") == [] and "not kept" in capsys.readouterr().err


# Contract: several keys piped in at once (one per line, or split by commas) are each added and checked, and only the
# refused one is dropped. Regression: `keys add` read one line, so every key after the first was silently ignored.
def test_the_terminal_adds_every_key_piped_in_and_drops_only_the_refused_one(monkeypatch, capsys):
    from hswarm import cli, keys

    bad = "gsk_not_a_real_key_0002"

    async def check(provider, fingerprint):
        refused = fingerprint == config.fingerprint(bad)
        return {"fingerprint": fingerprint, "result": "rejected" if refused else "ok", "note": "checked"}

    monkeypatch.setattr(keys, "check", check)
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(f"gsk_not_a_real_key_0001\n{bad}, gsk_not_a_real_key_0003\n"))
    assert cli.main(["keys", "add", "groq"]) == 1
    assert config.user_keys("groq") == ["gsk_not_a_real_key_0001", "gsk_not_a_real_key_0003"]


# Contract: a window of 0 ("re-read every key now", as `hswarm keys probe` asks) counts a balance read stamped in the
# same clock tick as due. Regression: `age > window` left it fresh, so the Windows legs of CI failed the probe tests
# whenever the read and the check shared a tick (1.1.1, 2026-09-27).
def test_a_zero_window_counts_a_read_from_the_same_clock_tick_as_due(monkeypatch):
    from hswarm import client

    monkeypatch.setattr(client.time, "time", lambda: 1_000_000.0)
    pool = KeyPool(["sk-aaaa1111", "sk-bbbb2222"], "deepseek")
    for k in ("sk-aaaa1111", "sk-bbbb2222"):
        pool.note_balance(k, 5.0, True)
    assert pool.stale_keys(max_age_s=0.0) == ["sk-aaaa1111", "sk-bbbb2222"]
    assert pool.stale_keys(max_age_s=60.0) == []
