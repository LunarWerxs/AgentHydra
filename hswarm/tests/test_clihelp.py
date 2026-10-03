"""Offline: the self-describing CLI (`hswarm help --json`, `hswarm skill`).

Pins that every registered command reaches the JSON sitemap with a classified effect, so a new subparser
added without an effect or an agent guide fails here instead of reaching agents as "unknown".
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import clihelp  # noqa: E402
from hswarm.cli import build_parser, main  # noqa: E402


def test_every_command_is_in_the_sitemap_with_an_effect_and_a_guide(capsys):
    assert main(["help", "--json", "--compact"]) == 0
    out = json.loads(capsys.readouterr().out)
    registered = set(clihelp._subparsers(build_parser()).choices)
    listed = {c["command"]: c for c in out["commands"]}
    assert set(listed) == registered
    for name, c in listed.items():
        assert set(c) == {"command", "description", "effect"}
        assert c["effect"] in clihelp.EFFECTS, f"{name} has no classified effect in clihelp.META"
        assert c["description"], f"{name} has no help text"
        if c["effect"] != clihelp.READ:
            assert clihelp.META[name].get("guide"), f"{name} changes state but carries no agent guide"


def test_command_help_carries_flags_and_effect(capsys):
    assert main(["help", "run", "--json"]) == 0
    run = json.loads(capsys.readouterr().out)
    assert run["effect"] == clihelp.SPEND
    assert [a["name"] for a in run["args"]] == ["tasks"]
    budget = next(f for f in run["flags"] if "--budget" in f["flags"])
    assert budget["takes_value"] and "USD" in budget["help"]
    assert main(["help", "no-such-command"]) == 2


def test_skill_check_detects_a_stale_install(tmp_path, monkeypatch):
    path = str(tmp_path / "SKILL.md")
    assert main(["skill", "--check", "--path", path]) == 1  # missing
    assert main(["skill", "--install", "--path", path]) == 0
    assert main(["skill", "--check", "--path", path]) == 0
    monkeypatch.setitem(clihelp.META, "cost", {**clihelp.META["cost"], "guide": "changed"})
    assert main(["skill", "--check", "--path", path]) == 1  # the CLI moved on; the installed skill is stale
