"""hswarm_decide's cascade: Jev answers first, an unsure or failed answer escalates, and the fallback's answer wins."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from hswarm import config
from hswarm import decisions as d
from hswarm import typesafe


class FakeJev:
    """Answers by a table: question text -> Jev answer object. Records every call."""

    def __init__(self, table: dict, keys=("k",), fail: dict | None = None):
        self.table, self.keys, self.fail, self.calls = table, list(keys), fail, []
        self.usable = bool(self.keys)

    async def ask(self, state, questions, model=typesafe.MODEL):
        self.calls.append((state, questions))
        if self.fail:
            return self.fail
        return {"status": "ok", "answers": {qid: self.table[q["instructions"]] for qid, q in questions.items()}, "secs": 0.1, "in": 100, "out": 10,
                "model": "jev-1.13.0", "cost_usd": 100 * typesafe.USD_PER_INPUT_TOKEN}


class FakeMgr:
    def __init__(self, answer="FINAL: billing", status="ok"):
        self.answer, self.status, self.prompts = answer, status, []

    async def ask_routed(self, prompt, model, **kw):
        self.prompts.append(prompt)
        return SimpleNamespace(status=self.status, answer=self.answer, model=model, cost_usd=0.0001, error=None if self.status == "ok" else "boom")


CRIT = {"billing": "Payments", "technical": "Bugs", "sales": "Pricing"}


def _item(q, **kw):
    return {"state": "My payouts failed", "question": q, "options": CRIT, **kw}


def test_normalize_accepts_friendly_shapes():
    assert d.normalize({"state": "s", "question": "q?", "options": ["a", "b"]})["criteria"] == {"a": None, "b": None}
    n = d.normalize({"state": "s", "question": "urgent?"}, 3)
    assert (n["type"], n["id"], n["criteria"]) == ("noul", "d3", None)
    assert d.normalize({"state": "s", "question": "q", "type": "yesno", "options": {"yes": "Y", "no": "N"}})["criteria"] == {"true": "Y", "false": "N"}
    assert d.normalize({"state": "s", "question": "q", "type": "score", "options": ["lo", "hi"]})["type"] == "score"


@pytest.mark.parametrize("bad", [{"question": "q"}, {"state": "s"}, {"state": "s", "question": "q", "options": ["only"]},
                                 {"state": "s", "question": "q", "type": "score", "options": ["one"]}, {"state": "s", "question": "q", "type": "essay"}])
def test_normalize_refuses_what_jev_cannot_answer(bad):
    with pytest.raises(ValueError):
        d.normalize(bad)


def test_a_confident_jev_answer_is_final_and_nothing_escalates():
    jev = FakeJev({"Which team?": {"type": "choice", "choice": "billing", "probabilities": {"billing": 0.95, "technical": 0.05, "sales": 0}, "confidence": 0.9}})
    mgr = FakeMgr()
    out = asyncio.run(d.decide([_item("Which team?", id="t1")], mgr, jev=jev))
    [a] = out["answers"]
    assert (a["id"], a["answer"], a["source"], a["jev"]["confidence"]) == ("t1", "billing", "jev", 0.9)
    assert mgr.prompts == [] and out["summary"]["escalated"] == 0 and out["summary"]["by_jev"] == 1


def test_an_unsure_jev_answer_escalates_and_the_fallback_wins():
    jev = FakeJev({"Which team?": {"type": "choice", "choice": "technical", "probabilities": {"billing": 0.45, "technical": 0.55, "sales": 0}, "confidence": 0.3}})
    mgr = FakeMgr("reasoning...\nFINAL: billing")
    out = asyncio.run(d.decide([_item("Which team?")], mgr, jev=jev, escalate_below=0.7))
    [a] = out["answers"]
    assert a["answer"] == "billing" and a["source"] != "jev" and a["jev"]["answer"] == "technical"
    assert "OPTIONS" in mgr.prompts[0] and out["summary"]["escalated"] == 1


def test_a_failed_escalation_keeps_jev_evidence_but_does_not_authorize_an_answer():
    jev = FakeJev({"Which team?": {"type": "choice", "choice": "technical", "probabilities": {"billing": 0.4, "technical": 0.6, "sales": 0}, "confidence": 0.2}})
    out = asyncio.run(d.decide([_item("Which team?")], FakeMgr("I am not sure."), jev=jev))
    [a] = out["answers"]
    assert (a["answer"], a["source"]) == (None, "none")
    assert a["jev"]["answer"] == "technical"
    assert "UnresolvedDecision" in a["error"]


def test_jev_down_sends_everything_to_the_fallback():
    jev = FakeJev({}, fail={"status": "error", "error": "HTTP 402: no credit", "http": 402})
    out = asyncio.run(d.decide([_item("Which team?"), _item("Which team?")], FakeMgr(), jev=jev))
    assert [a["answer"] for a in out["answers"]] == ["billing", "billing"] and out["summary"]["escalated"] == 2
    assert all("error" in a["jev"] for a in out["answers"])


def test_jev_down_at_escalate_below_zero_leaves_every_item_unanswered():
    # 0 means Jev alone: Dredd asks its yes/no questions there and answers Jev's gaps with its own keywords, because the
    # fallback's yes/no answers measured 19 of 39 dockets right against Jev's 39 of 39.
    jev = FakeJev({}, fail={"status": "error", "error": "HTTP 402: no credit", "http": 402})
    mgr = FakeMgr()
    out = asyncio.run(d.decide([_item("Which team?"), {"state": "s", "question": "Urgent?"}], mgr, jev=jev, escalate_below=0))
    assert mgr.prompts == [] and out["summary"]["escalated"] == 0 and out["summary"]["unanswered"] == 2
    assert [(a["answer"], a["source"]) for a in out["answers"]] == [(None, "none")] * 2
    assert all("402" in a["jev"]["error"] and "402" in a["error"] and "fallback" not in a for a in out["answers"])


def test_clef_stands_in_when_every_jev_key_is_refused_and_is_held_to_its_own_scale():
    # TypeSafe answered 402 to every key from 2026-10-06 to 2026-10-08; Clef answers instead, as the typed leg.
    jev = FakeJev({}, fail={"status": "error", "error": "HTTP 402: no credit", "http": 402})
    clef = FakeJev({"Which team?": {"type": "choice", "choice": "billing", "probabilities": {"billing": 0.5, "technical": 0.3, "sales": 0.2}, "confidence": 0.45},
                    "Urgent?": {"type": "noul", "noul": 0.9}})
    mgr = FakeMgr("FINAL: technical")
    out = asyncio.run(d.decide([_item("Which team?"), {"state": "s", "question": "Urgent?"}], mgr, jev=jev, stand_in=clef, escalate_below=0.7))
    team, urgent = out["answers"]
    # 0.45 clears Clef's equivalent of 0.7 (0.415) where it would not clear Jev's, so nothing escalates
    assert (team["answer"], team["source"], team["jev"]["model"]) == ("billing", "jev:clef", "clef") and mgr.prompts == []
    assert (urgent["answer"], urgent["source"]) == ("yes", "jev:clef")
    assert out["summary"]["stand_in"]["items"] == 2 and out["summary"]["by_jev"] == 2


def test_a_malformed_question_is_not_handed_to_the_stand_in():
    jev = FakeJev({}, fail={"status": "error", "error": "HTTP 422: criteria required", "http": 422})
    clef = FakeJev({"Urgent?": {"type": "noul", "noul": 0.9}})
    out = asyncio.run(d.decide([{"state": "s", "question": "Urgent?"}], FakeMgr(), jev=jev, stand_in=clef, escalate_below=0))
    assert clef.calls == [] and out["answers"][0]["answer"] is None and "stand_in" not in out["summary"]


def test_yesno_and_score_answers():
    jev = FakeJev({"Urgent?": {"type": "noul", "noul": 0.97}, "How angry?": {"type": "score", "score": 1.1, "probabilities": {"0": 0.0, "1": 0.9, "2": 0.1}, "confidence": 0.9}})
    items = [{"state": "s", "question": "Urgent?"}, {"state": "s", "question": "How angry?", "type": "score", "options": ["calm", "cross", "furious"]}]
    out = asyncio.run(d.decide(items, FakeMgr(), jev=jev))
    yes, sc = out["answers"]
    assert (yes["answer"], yes["source"]) == ("yes", "jev")  # 0.97 -> confidence 0.94
    assert (sc["answer"], sc["level"]) == ("1", 1)


def test_invalid_items_are_reported_without_sinking_the_batch():
    jev = FakeJev({"Urgent?": {"type": "noul", "noul": 0.9}})
    out = asyncio.run(d.decide([{"state": "s", "question": "Urgent?"}, {"question": "no state"}], FakeMgr(), jev=jev))
    assert out["answers"][0]["answer"] == "yes" and out["answers"][1]["error"] and out["summary"]["invalid"] == 1


def test_batch_is_capped_at_five_items_per_jev_call():
    jev = FakeJev({"About `items[%d]`: Urgent?" % i: {"type": "noul", "noul": 0.9} for i in range(5)})
    items = [{"state": f"s{i}", "question": "Urgent?"} for i in range(12)]
    out = asyncio.run(d.decide(items, FakeMgr(), jev=jev, batch=50))
    assert [len(q) for _, q in jev.calls] == [5, 5, 2] and all(a["answer"] == "yes" for a in out["answers"])


def test_items_with_one_state_share_one_jev_call_and_each_answer_keeps_its_id():
    team = {"type": "choice", "choice": "billing", "probabilities": {"billing": 0.95, "technical": 0.05, "sales": 0}, "confidence": 0.9}
    jev = FakeJev({"Which team?": team, "Urgent?": {"type": "noul", "noul": 0.9}, "Calm?": {"type": "noul", "noul": 0.1},
                   "Angry?": {"type": "noul", "noul": 0.2}})
    items = [_item("Which team?", id="a"), {"state": "Another ticket", "question": "Angry?", "id": "b"},
             {"state": "My payouts failed", "question": "Urgent?", "id": "c"}, {"state": "My payouts failed", "question": "Calm?", "id": "d"}]
    out = asyncio.run(d.decide(items, FakeMgr(), jev=jev, escalate_below=0))
    shared = [(st, qs) for st, qs in jev.calls if len(qs) > 1]
    assert len(jev.calls) == 2 and [(st, len(qs)) for st, qs in shared] == [("My payouts failed", 3)]  # the state goes once, as is
    assert [(a["id"], a["answer"]) for a in out["answers"]] == [("a", "billing"), ("b", "no"), ("c", "yes"), ("d", "no")]


def test_a_structured_question_reaches_jev_as_an_object():
    q = {"candidate": {"name": "John Smith", "last_employer": "Google"}, "question": "Is the resume for `candidate`?"}

    class Recorder(FakeJev):
        async def ask(self, state, questions, model=typesafe.MODEL):
            self.calls.append((state, questions))
            return {"status": "ok", "answers": {k: {"type": "noul", "noul": 0.9} for k in questions}, "secs": 0.1, "in": 1, "out": 1,
                    "model": "jev-1.13.0", "cost_usd": 0.0}

    jev = Recorder({})
    asyncio.run(d.decide([{"state": "resume text", "question": q, "type": "yesno"}], FakeMgr(), jev=jev, escalate_below=0))
    assert jev.calls[0][1]["q0"]["instructions"] == q


def test_batched_questions_point_at_their_own_slot():
    q = d.batched_question({"type": "choice", "state": {"premise": "p", "hypothesis": "h"}, "instructions": "Relation of `premise` and `hypothesis`?", "criteria": {"a": None}}, 3)
    assert q["instructions"] == "Relation of `items[3].premise` and `items[3].hypothesis`?"
    q = d.batched_question({"type": "noul", "state": "text", "instructions": "Urgent?", "criteria": None}, 0)
    assert q["instructions"] == "About `items[0]`: Urgent?" and "criteria" not in q


def test_pack_respects_the_batch_size_and_the_state_budget(monkeypatch):
    items = [{"type": "noul", "state": "x" * 100, "instructions": "q?", "criteria": None} for _ in range(10)]
    assert [len(g) for g in d.pack(items, 4)] == [4, 4, 2]
    monkeypatch.setattr(d, "BATCH_STATE_CHARS", 250)
    assert [len(g) for g in d.pack(items, 20)] == [2] * 5


def test_jev_client_rotates_out_a_dead_key_and_backs_off_on_a_limit(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        key = request.headers["authorization"].split()[-1]
        seen.append(key)
        if key == "dead":
            return httpx.Response(401, json={"detail": "invalid key"})
        if len(seen) == 2:
            return httpx.Response(429, headers={"retry-after": "0"}, json={"detail": "slow down"})
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"q": {"type": "noul", "noul": 0.8}}, "usage": {"input_tokens": 50, "output_tokens": 5}})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            jev = typesafe.Jev(keys=["good", "dead"], http=http)
            return await jev.ask("s", {"q": {"type": "noul", "instructions": "q?"}}), jev.keys

    res, keys = asyncio.run(go())
    assert res["status"] == "ok" and res["in"] == 50 and keys == ["good"] and "dead" in seen


def test_a_key_out_of_credit_is_shelved_for_every_later_client_and_retried_after_the_window(monkeypatch):
    # 2026-10-08: TypeSafe refused a key with 402 for two days while `hswarm keys` still read it "ok", and every Dredd
    # ask (a new process) asked it again first.
    from hswarm import config, keys

    monkeypatch.setenv("TYPESAFE_API_KEYS", "good-key-0000,dead-key-0000")
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        key = request.headers["authorization"].split()[-1]
        seen.append(key)
        if key == "dead-key-0000":
            return httpx.Response(402, json={"detail": "no credit"})
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"q": {"type": "noul", "noul": 0.8}}, "usage": {"input_tokens": 5}})

    async def ask_once():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            jev = typesafe.Jev(http=http)
            return jev, await jev.ask("s", {"q": {"type": "noul", "instructions": "q?"}})

    jev, res = asyncio.run(ask_once())
    assert res["status"] == "ok" and seen == ["dead-key-0000", "good-key-0000"]
    assert config.fingerprint("dead-key-0000") in keys.pool_for("typesafe").disabled()
    seen.clear()
    jev, res = asyncio.run(ask_once())
    assert (jev.keys, jev.disabled, seen) == (["good-key-0000"], 1, ["good-key-0000"])
    monkeypatch.setattr(typesafe, "JEV_RECHECK_S", -1.0)  # the window has passed: the shelved key gets one try
    assert typesafe.Jev().keys == ["good-key-0000", "dead-key-0000"]


def test_jev_client_fails_fast_on_a_malformed_question():
    def handler(request):
        return httpx.Response(422, json={"detail": "criteria required"})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            return await typesafe.Jev(keys=["k"], http=http).ask("s", {"q": {"type": "choice", "instructions": "q"}})

    res = asyncio.run(go())
    assert res["status"] == "error" and res["http"] == 422


def test_a_featherless_model_goes_keyless_to_the_simple_jev_demo_paced_and_free():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("authorization")))
        return httpx.Response(200, json={"model": "featherless-ai/Qwen3.8-27B-classifier", "answers": {"q": {"type": "noul", "noul": 0.9}},
                                         "usage": {"input_tokens": 900, "output_tokens": 1}})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            jev = typesafe.Jev.for_model("featherless-ai/Qwen3.8-27B-classifier", concurrency=16, http=http)
            jev.min_interval = 0.05
            t0 = asyncio.get_running_loop().time()
            res = await asyncio.gather(*(jev.ask("s", {"q": {"type": "noul", "instructions": "q?"}}, model="featherless-ai/Qwen3.8-27B-classifier") for _ in range(3)))
            return res, asyncio.get_running_loop().time() - t0, jev

    res, took, jev = asyncio.run(go())
    assert all(r["status"] == "ok" and r["cost_usd"] == 0.0 for r in res) and jev.usable and jev.sem._value == 2
    assert seen == [(typesafe.SIMPLE_JEV_DEMO_URL, None)] * 3
    assert took >= 0.09  # three requests, two 0.05 s gaps: the pacer spaced them
    assert typesafe.is_typed_model("featherless-ai/gemma-4-26B-A4B-classifier") and typesafe.is_typed_model("jev-latest")
    assert not typesafe.is_typed_model("groq-gpt-oss-120b")


def test_a_clef_model_goes_to_workers_ai_and_its_envelope_is_unwrapped(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("authorization"), json.loads(request.content)["model"]))
        return httpx.Response(200, json={"result": {"model": "clef-flash", "answers": {"q": {"type": "noul", "noul": 0.9}},
                                                    "usage": {"input_tokens": 1000, "output_tokens": 0}}, "success": True, "errors": [], "messages": []})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            jev = typesafe.Jev.for_model("clef-flash", http=http)
            return await jev.ask("s", {"q": {"type": "noul", "instructions": "q?"}}, model="clef-flash")

    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cf-test-token")
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    assert not typesafe.Jev.for_model("clef").usable  # no account id: nothing to call, so decide() falls back
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct123")
    res = asyncio.run(go())
    assert res["status"] == "ok" and res["answers"]["q"]["noul"] == 0.9 and res["model"] == "clef-flash"
    assert res["cost_usd"] == pytest.approx(1000 * 0.09 / 1_000_000)
    assert seen == [("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash", "Bearer cf-test-token", "clef-flash")]
    assert typesafe.is_typed_model("clef") and typesafe.is_typed_model("clef-flash")


def test_a_clef_key_line_carries_its_account_so_a_synced_pc_needs_nothing_else():
    """The vault syncs key lists only: on the other PC there is no CLOUDFLARE_ACCOUNT_ID and no account file, and a
    line written `<account id>:<token>` must still reach that account with the bare token as the bearer."""
    account, other = "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"
    config.SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    (config.SECRETS_DIR / "cloudflare_api_keys").write_text(f"{account}:cf-token-a\n{other}:cf-token-b\n", encoding="utf-8")
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("authorization")))
        return httpx.Response(200, json={"result": {"answers": {"q": {"type": "noul", "noul": 0.9}}}, "success": True})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            jev = typesafe.Jev.for_model("clef", http=http)
            return jev.keys, await jev.ask("s", {"q": {"type": "noul", "instructions": "q?"}}, model="clef")

    keys, res = asyncio.run(go())
    assert res["status"] == "ok" and keys == ["cf-token-a"]  # the other account's token would 401 on this URL
    assert seen == [(f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef", "Bearer cf-token-a")]
