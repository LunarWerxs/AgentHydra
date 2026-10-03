"""A worker in a checkout must never see live provider keys: path tools, shell words, and an exact-value scrub."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, redaction, shellpolicy  # noqa: E402
from hswarm.tools import Sandbox, find_bash  # noqa: E402

FAKE = "zsw-fake-unique-key-0123456789abcdef"
needs_bash = pytest.mark.skipif(not find_bash(), reason="no bash")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def tree(tmp_path, monkeypatch):
    (tmp_path / ".secrets").mkdir()
    (tmp_path / ".secrets" / "demo_api_keys").write_text(FAKE + "\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("plain notes\n", encoding="utf-8")
    monkeypatch.setattr(config, "all_keys", lambda provider="deepseek": [FAKE])
    redaction.forget_keys()
    yield Sandbox(tmp_path)
    redaction.forget_keys()


def test_path_tools_refuse_a_key_file(tree):  # pins: every path tool refuses .secrets, and the key never appears
    for tool, args in (("read_file", {"path": ".secrets/demo_api_keys"}), ("list_dir", {"path": ".secrets"}),
                       ("outline", {"path": ".secrets/demo_api_keys"}), ("write_file", {"path": ".SECRETS/x", "content": "a"}),
                       ("edit_file", {"path": ".secrets/demo_api_keys", "old_string": "zsw", "new_string": "a"}),
                       ("grep", {"pattern": "zsw", "path": ".secrets"}), ("glob", {"pattern": "*", "path": ".secrets"})):
        out = run(tree.run(tool, args))
        assert out.startswith("ERROR") and FAKE not in out, (tool, out)
    assert "never readable" in run(tree.run("read_file", {"path": ".secrets/demo_api_keys"}))


def test_walking_tools_skip_key_files_silently(tree):  # pins: list_dir, glob and grep from the root omit .secrets without error
    assert run(tree.run("list_dir", {"path": ".", "depth": 3})).split() == ["notes.txt"]
    assert ".secrets" not in run(tree.run("glob", {"pattern": "**/*"}))
    out = run(tree.run("grep", {"pattern": "zsw|plain", "path": "."}))
    assert "plain" in out and FAKE not in out and ".secrets" not in out


def test_the_users_provider_files_are_refused_too(tree):  # pins: config.HOME/providers is a key path
    providers = config.HOME / "providers"
    providers.mkdir(parents=True)
    (providers / "x.toml").write_text(f'keys = ["{FAKE}"]\n', encoding="utf-8")
    box = Sandbox(config.HOME, roots=[config.HOME])
    assert run(box.run("read_file", {"path": "providers/x.toml"})).startswith("ERROR")
    assert "providers" not in run(box.run("list_dir", {"path": "."}))


def test_the_users_secrets_folder_is_refused_too(tree, monkeypatch):  # pins: config.SECRETS_DIR (<home>/secrets) is a key path
    secrets = config.HOME / "secrets"
    secrets.mkdir(parents=True)
    (secrets / "deepseek_keys").write_text(FAKE + "\n", encoding="utf-8")
    monkeypatch.setattr(config, "SECRETS_DIR", secrets)
    box = Sandbox(config.HOME, roots=[config.HOME])
    out = run(box.run("read_file", {"path": "secrets/deepseek_keys"}))
    assert out.startswith("ERROR") and FAKE not in out
    assert "secrets" not in run(box.run("list_dir", {"path": "."}))
    assert shellpolicy.refusal("cat ~/.hswarm/secrets/deepseek_keys", None).startswith("ERROR: refused")


@needs_bash
@pytest.mark.parametrize("cmd", ["cat .secrets/demo_api_keys", "type .secrets\\demo_api_keys",
                                 "powershell -Command Get-Content .secrets/demo_api_keys"])
def test_bash_refuses_key_file_words(tree, cmd):  # pins: the shell policy refuses a command naming a key file
    out = run(tree.run("bash", {"command": cmd}))
    assert out.startswith("ERROR: refused") and FAKE not in out


@needs_bash
def test_a_spelling_the_words_cannot_see_is_scrubbed(tree):  # pins: `cat .secr*/*` runs, but the key comes back withheld
    out = run(tree.run("bash", {"command": "cat .secr*/*"}))
    assert FAKE not in out and redaction.KEY_WITHHELD in out


def test_scrub_replaces_only_exact_held_keys(tree):  # pins: a held key is replaced, near-miss and ordinary tokens are not
    text = f"a {FAKE} b {FAKE}x c some-other-long-token-1234567890"
    out = redaction.scrub_keys(text)
    assert out.count(redaction.KEY_WITHHELD) == 1 and FAKE + "x" in out and "some-other-long-token-1234567890" in out
