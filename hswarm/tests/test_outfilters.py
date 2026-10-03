"""Offline: the declarative output filters a worker's bash output passes through before the cap (outfilters.py)."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, outfilters  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402

# A project filter whose command marker is a shell comment, so the test drives it with plain echo.
NOISY = '''
[filters.noisy]
match_command = '# noisy-build'
strip_lines_matching = ['^noise \\d+$']
on_empty = "noisy: clean"

[[tests.noisy]]
input = "noise 1\\nFAIL: real"
expected = "FAIL: real"
'''


def _project(tmp_path: Path, text: str) -> Path:
    (tmp_path / ".hswarm").mkdir(exist_ok=True)
    (tmp_path / ".hswarm" / "filters.toml").write_text(text, encoding="utf-8")
    return tmp_path


def test_every_builtin_filter_loads_and_passes_its_own_tests():
    filters, rejects = outfilters.load_file(outfilters.BUILTIN, "builtin")
    assert rejects == []
    assert {"pip-install", "npm-install", "pytest", "cargo", "git-transfer"} <= {f.name for f in filters}
    assert all(f.tests >= 2 for f in filters)


def test_untested_or_failing_filter_is_rejected_and_never_applied(tmp_path):
    _project(tmp_path, '''
[filters.untested]
match_command = 'untested'
strip_lines_matching = ['.']

[filters.liar]
match_command = 'liar'
strip_lines_matching = ['^x']

[[tests.liar]]
input = "x\\ny"
expected = "x"
''')
    filters, rejects = outfilters.load_filters(tmp_path)
    assert {name for _, name, _ in rejects} == {"untested", "liar"}
    assert "no inline tests" in next(why for _, name, why in rejects if name == "untested")
    assert not any(f.name in ("untested", "liar") for f in filters)
    long = "x line\n" * 200
    assert outfilters.filter_output("untested", long, tmp_path) == long


def test_lookup_is_project_then_user_then_builtin(tmp_path):
    override = '''
[filters.pytest]
match_command = 'pytest'
on_empty = "SOURCE"
keep_lines_matching = ['^never$']

[[tests.pytest]]
input = "anything"
expected = "SOURCE"
'''
    config.HOME.mkdir(parents=True, exist_ok=True)
    (config.HOME / "filters.toml").write_text(override.replace("SOURCE", "user"), encoding="utf-8")
    assert outfilters.match("pytest -q").source == "user"
    (tmp_path / "work").mkdir()
    work = _project(tmp_path / "work", override.replace("SOURCE", "project"))
    assert outfilters.match("pytest -q", work).source == "project"
    assert [f.name for f in outfilters.load_filters(work)[0]].count("pytest") == 1


def test_never_worse_and_raw_escape_hatch(tmp_path):
    work = _project(tmp_path, NOISY)
    short = "noise 1\nFAIL: real"
    assert outfilters.filter_output("make # noisy-build", short, work) == short  # the note would cost more than it saves
    long = "".join(f"noise {i}\n" for i in range(300)) + "FAIL: real\n"
    filtered = outfilters.filter_output("make # noisy-build", long, work)
    assert filtered.startswith("FAIL: real\n[hswarm output filter \"noisy\": 1 of 301 lines shown")
    assert outfilters.filter_output("HSWARM_RAW=1 make # noisy-build", long, work) == long


def test_builtin_pytest_filter_does_not_match_a_file_named_pytest():
    assert outfilters.match("python -m pytest tests -q").name == "pytest"
    assert outfilters.match("cat pytest.log") is None


def test_bash_failure_in_the_middle_survives_the_cap(tmp_path):
    # Before the filter, _cap kept a blind head and tail: a failure mid-log was cut out of what the worker read.
    work = _project(tmp_path, NOISY)
    command = 'for i in $(seq 1 400); do echo "noise $i"; done; echo "FAIL: real"; for i in $(seq 1 400); do echo "noise $i"; done # noisy-build'
    out = asyncio.run(Sandbox(work, max_output_chars=600).run("bash", {"command": command}))
    assert out.startswith("exit=0\nFAIL: real\n[hswarm output filter")
    assert "noise 7" not in out
    raw = asyncio.run(Sandbox(work, max_output_chars=600).run("bash", {"command": "HSWARM_RAW=1 " + command}))
    # The marker is stripped before bash runs: left in, it is a syntax error in front of `for`.
    assert raw.startswith("exit=0\nnoise 1\n") and "FAIL: real" not in raw and "chars omitted" in raw
