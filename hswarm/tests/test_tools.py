"""Offline: the sandbox and every worker tool, including the bash timeout kill. No network."""
from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import tools  # noqa: E402
from hswarm.tools import PRESETS, Sandbox, git_write_refusal, specs_for  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def test_sandbox_refuses_escape(tmp_path):
    sb = Sandbox(tmp_path)
    with pytest.raises(PermissionError):
        sb.resolve("../outside.txt")
    with pytest.raises(PermissionError):
        sb.resolve(str(tmp_path.parent / "x"))
    assert sb.resolve("a/b.txt") == (tmp_path / "a" / "b.txt").resolve()


def test_sandbox_extra_roots(tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    sb = Sandbox(work, roots=[other])
    assert sb.resolve(str(other / "f.txt")).parent == other.resolve()


def test_writable_globs_freeze_the_judge(tmp_path):
    # The frozen judge: with writable set, a worker may change the code but not the test that grades it,
    # and the refusal comes back as an ERROR string (not an exception) while the test stays readable.
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_a.py").write_text("assert f() == 2\n")
    sb = Sandbox(tmp_path, writable=["src/**"])
    assert "wrote" in run(sb.run("write_file", {"path": "src/pkg/a.py", "content": "def f(): return 2\n"}))
    out = run(sb.run("edit_file", {"path": "tests/test_a.py", "old_string": "2", "new_string": "3"}))
    assert out.startswith("ERROR") and "read-only" in out
    assert run(sb.run("write_file", {"path": "src/../tests/test_a.py", "content": "pass\n"})).startswith("ERROR")
    assert (tmp_path / "tests" / "test_a.py").read_text() == "assert f() == 2\n"
    assert "assert f() == 2" in run(sb.run("read_file", {"path": "tests/test_a.py"}))
    assert sb.files_changed == ["src/pkg/a.py"]
    assert run(Sandbox(tmp_path, writable=[]).run("write_file", {"path": "x.txt", "content": ""})).startswith("ERROR")
    assert "wrote" in run(Sandbox(tmp_path).run("write_file", {"path": "tests/new.py", "content": ""}))  # unset: no limit


def test_write_read_edit(tmp_path):
    sb = Sandbox(tmp_path)
    assert "wrote" in run(sb.t_write_file("a.txt", "hello\nworld\n"))
    assert run(sb.t_read_file("a.txt")).splitlines() == ["1\thello", "2\tworld"]
    assert "1 replacement" in run(sb.t_edit_file("a.txt", "world", "there"))
    assert (tmp_path / "a.txt").read_text() == "hello\nthere\n"
    assert sb.files_changed == ["a.txt", "a.txt"]


def test_write_and_edit_keep_line_endings_verbatim(tmp_path):
    # Python's universal-newline mode rewrites "\n" as os.linesep on write, which on Windows turned
    # every LF file a worker edited into CRLF (2026-09-18). The tools must be byte-transparent both ways.
    sb = Sandbox(tmp_path)
    run(sb.t_write_file("lf.txt", "one\ntwo\n"))
    assert (tmp_path / "lf.txt").read_bytes() == b"one\ntwo\n"
    run(sb.t_edit_file("lf.txt", "two", "three"))
    assert (tmp_path / "lf.txt").read_bytes() == b"one\nthree\n"
    (tmp_path / "crlf.txt").write_bytes(b"one\r\ntwo\r\n")
    run(sb.t_edit_file("crlf.txt", "two", "three"))
    assert (tmp_path / "crlf.txt").read_bytes() == b"one\r\nthree\r\n"


def test_edit_requires_unique(tmp_path):
    sb = Sandbox(tmp_path)
    (tmp_path / "b.txt").write_text("x x x")
    out = run(sb.run("edit_file", {"path": "b.txt", "old_string": "x", "new_string": "y"}))
    assert out.startswith("ERROR") and "3 times" in out
    assert "3 replacements" in run(sb.run("edit_file", {"path": "b.txt", "old_string": "x", "new_string": "y", "replace_all": True}))
    assert "not found" in run(sb.run("edit_file", {"path": "b.txt", "old_string": "nope", "new_string": "y"}))


def test_edit_near_match_absorbs_indent_drift_and_reindents(tmp_path):
    # Cheap workers burn turns on edit_file's byte-exact old_string: a block copied with the wrong indent,
    # or LF lines against a CRLF file, used to be "not found". In a file the worker has read, the block it
    # meant is found line by line and new_string lands at the file's indent and line ending.
    sb = Sandbox(tmp_path)
    (tmp_path / "m.py").write_bytes(b"def f(x):\r\n    if x:\r\n        return 1\r\n    return 2\r\n")
    unread = run(sb.run("edit_file", {"path": "m.py", "old_string": "if x:\n    return 1", "new_string": "if x:\n    return 3"}))
    assert unread.startswith("ERROR") and "not found" in unread  # no read, no guessing
    run(sb.t_read_file("m.py"))
    out = run(sb.run("edit_file", {"path": "m.py", "old_string": "if x:\n    return 1", "new_string": "if x:\n    return 3"}))
    assert "near match at lines 2-3" in out, out
    assert (tmp_path / "m.py").read_bytes() == b"def f(x):\r\n    if x:\r\n        return 3\r\n    return 2\r\n"
    far = run(sb.run("edit_file", {"path": "m.py", "old_string": "while y:\n    yield z", "new_string": "pass"}))
    assert far.startswith("ERROR") and "not found" in far


def test_edit_near_line_picks_between_repeats(tmp_path):
    # A repeated block used to be refusable only by padding old_string; near_line names the one meant.
    sb = Sandbox(tmp_path)
    (tmp_path / "r.txt").write_text("a\nx\nb\nx\nc\n")
    assert "2 times" in run(sb.run("edit_file", {"path": "r.txt", "old_string": "x", "new_string": "y"}))
    assert "line 4" in run(sb.run("edit_file", {"path": "r.txt", "old_string": "x", "new_string": "y", "near_line": 5}))
    assert (tmp_path / "r.txt").read_text() == "a\nx\nb\ny\nc\n"


def test_write_and_edit_refuse_unread_or_stale_files(tmp_path):
    # write_file used to overwrite blind: a file the worker never read, or a sibling's edit made after
    # its read, was silently lost. Now both are an ERROR the worker recovers from by reading again.
    sb = Sandbox(tmp_path)
    (tmp_path / "s.txt").write_text("one\n")
    unread = run(sb.run("write_file", {"path": "s.txt", "content": "mine\n"}))
    assert unread.startswith("ERROR") and "not read" in unread
    run(sb.t_read_file("s.txt"))
    (tmp_path / "s.txt").write_text("one\nsibling\n")  # another worker edits after our read
    for name, args in (("write_file", {"content": "mine\n"}), ("edit_file", {"old_string": "one", "new_string": "two"})):
        stale = run(sb.run(name, {"path": "s.txt", **args}))
        assert stale.startswith("ERROR") and "changed since you read it" in stale, name
    assert (tmp_path / "s.txt").read_text() == "one\nsibling\n"
    run(sb.t_read_file("s.txt"))
    assert "1 replacement" in run(sb.run("edit_file", {"path": "s.txt", "old_string": "one", "new_string": "two"}))
    assert "wrote" in run(sb.run("write_file", {"path": "s.txt", "content": "mine\n"}))  # its own edit re-stamped the file


def test_own_writes_never_need_a_read_first(tmp_path):
    # The first read gate refused a worker's write_file on a file it had changed with an exact edit_file but
    # never read. A file this worker created or already wrote is one it knows; only a blind overwrite needs a read.
    sb = Sandbox(tmp_path)
    assert "wrote" in run(sb.run("write_file", {"path": "new.txt", "content": "a\n"}))
    assert "wrote" in run(sb.run("write_file", {"path": "new.txt", "content": "b\n"}))
    (tmp_path / "old.txt").write_text("x = 1\n")
    assert "1 replacement" in run(sb.run("edit_file", {"path": "old.txt", "old_string": "x = 1", "new_string": "x = 2"}))
    assert "wrote" in run(sb.run("write_file", {"path": "old.txt", "content": "x = 3\n"}))
    assert (tmp_path / "old.txt").read_text() == "x = 3\n"


def test_read_slice_and_size_guard(tmp_path):
    sb = Sandbox(tmp_path, max_read_bytes=10)
    (tmp_path / "big.txt").write_text("\n".join(str(i) for i in range(50)))
    out = run(sb.run("read_file", {"path": "big.txt"}))
    assert out.startswith("ERROR") and "slice" in out
    assert run(sb.run("read_file", {"path": "big.txt", "start_line": 3, "end_line": 4})).splitlines() == ["3\t2", "4\t3"]


def test_list_glob_grep(tmp_path, monkeypatch):
    sb = Sandbox(tmp_path)
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("import os\nTODO security\n")
    (tmp_path / "src" / "b.py").write_text("print(1)\n")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "junk.py").write_text("import os\n")
    ls = run(sb.run("list_dir", {"path": ".", "depth": 2}))
    assert "src/" in ls and "a.py" in ls and "node_modules" not in ls
    walked, real_walk = [], os.walk

    def walk(top, *args, **kwargs):
        for step in real_walk(top, *args, **kwargs):
            walked.append(Path(step[0]).name)
            yield step

    monkeypatch.setattr(os, "walk", walk)
    g = run(sb.run("glob", {"pattern": "**/*.py"}))
    assert "src/a.py" in g and "junk.py" not in g
    assert "src" in walked and "node_modules" not in walked  # its hits were always dropped; now it is not walked at all
    assert sorted(run(sb.run("glob", {"pattern": "*.py", "path": "src"})).splitlines()) == ["src/a.py", "src/b.py"]
    assert run(sb.run("glob", {"pattern": "*.py"})) == "(no matches)"  # `*` stays in one folder, as pathlib's does
    gr = run(sb.run("grep", {"pattern": "import os"}))
    assert "src/a.py:1:" in gr and "junk" not in gr


def test_glob_leaves_the_shared_server_answering(tmp_path, monkeypatch):
    # 2026-10-09: a worker's `**` glob in a large repo ran on the shared server's one event loop for about fifteen
    # minutes, and port 7793 answered no chat and no AgentHydra window until it ended.
    (tmp_path / "a.py").write_text("x = 1\n")
    answered, real = threading.Event(), tools.glob_files

    def slow(root, pattern):
        if not answered.wait(5):
            raise AssertionError("the glob held the event loop: nothing else ran while it walked")
        yield from real(root, pattern)

    monkeypatch.setattr(tools, "glob_files", slow)

    async def main():
        glob = asyncio.create_task(Sandbox(tmp_path).run("glob", {"pattern": "**/*.py"}))
        await asyncio.sleep(0.05)
        answered.set()  # runs only while the loop is free
        return await glob

    assert run(main()) == "a.py"


def test_glob_takes_an_absolute_pattern_and_never_kills_the_task(tmp_path):
    # A worker globbed "D:/PublicProjects/QuickDictate/app/src/**/*.rs" (2026-09-24): pathlib raised
    # NotImplementedError("Non-relative patterns are unsupported"), which no except clause named, so the
    # whole task died instead of the worker reading an ERROR line.
    work = tmp_path / "work"
    (work / "src").mkdir(parents=True)
    (work / "src" / "a.rs").write_text("fn main() {}\n")
    sb = Sandbox(work)
    assert "src/a.rs" in run(sb.run("glob", {"pattern": (work / "src").as_posix() + "/**/*.rs"}))
    assert "src/a.rs" in run(sb.run("glob", {"pattern": "**/*.rs", "path": (work / "src").as_posix()}))
    outside = run(sb.run("glob", {"pattern": tmp_path.as_posix() + "/**/*.rs"}))
    assert outside.startswith("ERROR") and "outside the sandbox" in outside


def test_bash_tool_runs_and_times_out(tmp_path):
    sb = Sandbox(tmp_path)
    out = run(sb.run("bash", {"command": "echo hi && exit 3"}))
    assert out.startswith("exit=3") and "hi" in out
    assert run(sb.run("bash", {"command": "sleep 5", "timeout_s": 1})).startswith("exit=124")  # the tree was killed, not left behind


def test_bash_refuses_git_writes_and_allows_git_reads(tmp_path, monkeypatch):
    # 2026-09-21: a worker ran `git checkout <base> -- <detector>` in a shared checkout and staged it.
    monkeypatch.delenv("HSWARM_ALLOW_GIT_WRITES", raising=False)
    sb = Sandbox(tmp_path)
    for command in (
        "git checkout abc123~1 -- src/check.mjs",
        "cd x && git restore .",
        "git -C repo add -A",
        "echo ok; git stash",
        "GIT_INDEX_FILE=/tmp/i git reset --hard",
        "(git commit -m x)",
    ):
        assert run(sb.run("bash", {"command": command})).startswith("ERROR: refused `git "), command
    for command in ("git show HEAD~1:src/check.mjs", "git log -1 --format=%h", "git diff --stat", "echo git checkout is fine as text"):
        assert git_write_refusal(command) is None, command
    monkeypatch.setenv("HSWARM_ALLOW_GIT_WRITES", "1")
    assert git_write_refusal("git checkout main") is None


def test_a_workers_shell_never_sees_the_operators_keys(tmp_path, monkeypatch):
    # Until 2026-09-24 t_bash inherited this process's whole environment: a free remote model running
    # `env` read every provider key hswarm holds. PATH and HOME still reach it; the opt-in git flag too.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "leak-one-deepseek")
    monkeypatch.setenv("SOME_VENDOR_DSN", "leak-two-not-allowlisted")
    monkeypatch.setenv("HSWARM_ALLOW_GIT_WRITES", "1")
    out = run(Sandbox(tmp_path).run("bash", {"command": "env"}))
    assert out.startswith("exit=0"), out
    assert "leak-one" not in out and "leak-two" not in out and "SOME_VENDOR_DSN" not in out
    assert "HOME=" in out and "PATH=" in out and "HSWARM_ALLOW_GIT_WRITES=1" in out


def test_scrubbed_env_screens_what_the_allowlist_lets_in():
    from hswarm.procs import scrubbed_env

    gh = "gh" + "p_" + "x" * 36  # assembled so no scanner mistakes the test for a real token
    source = {
        "PATH": "/usr/bin", "GOPRIVATE": "example.com/*", "HTTP_PROXY": "http://proxy:8080",
        "HTTPS_PROXY": "http://user:pw@proxy:8080",  # allowlisted name, credential-bearing value
        "LANG": gh,  # allowlisted name, token-shaped value
        "HSWARM_CHILD_ENV_ALLOW": "MY_\\w+|NODE_OPTIONS",  # the operator widens the allowlist...
        "MY_TOOL_DIR": "/opt/tool", "MY_API_KEY": "abc",  # ...but a secret-shaped name is still screened
        "NODE_OPTIONS": "--require /tmp/x.js",  # ...and code injection is never let back in
        "AWS_SECRET_ACCESS_KEY": "abc", "OPENAI_API_KEY": "abc",
    }
    env = scrubbed_env({"MY_API_KEY": "deliberate"}, source=source)
    assert env == {"PATH": "/usr/bin", "GOPRIVATE": "example.com/*", "HTTP_PROXY": "http://proxy:8080",
                   "MY_TOOL_DIR": "/opt/tool", "MY_API_KEY": "deliberate"}
    assert scrubbed_env(source={"PATH": "/usr/bin", "HSWARM_CHILD_ENV_ALLOW": "(", "X": "1"}) == {"PATH": "/usr/bin"}


def test_unknown_tool_and_bad_args(tmp_path):
    sb = Sandbox(tmp_path)
    assert run(sb.run("nope", {})).startswith("ERROR: unknown tool")
    assert run(sb.run("read_file", {"bogus": 1})).startswith("ERROR: bad arguments")


def test_specs_presets():
    assert [s["function"]["name"] for s in specs_for("read")] == PRESETS["read"]
    assert len(specs_for("all")) == 9
    assert specs_for("none") == []
    assert [s["function"]["name"] for s in specs_for("read_file,grep")] == ["read_file", "grep"]
    with pytest.raises(ValueError):
        specs_for("read_file,teleport")


def test_edit_lf_old_string_matches_crlf_source(tmp_path):
    # read_file rewrites every line ending as LF, so the old_string a worker copies out of it is LF. With
    # newline="" t_edit_file could never match that copy against a uniformly CRLF file. Only the queried
    # range is retried in CRLF, and the inserted text keeps the file's endings.
    sb = Sandbox(tmp_path)
    (tmp_path / "crlf.txt").write_bytes(b"alpha\r\nbeta\r\ngamma\r\n")
    assert run(sb.t_read_file("crlf.txt")) == "1\talpha\n2\tbeta\n3\tgamma"
    assert "1 replacement" in run(sb.t_edit_file("crlf.txt", "beta\ngamma", "delta\nepsilon"))
    assert (tmp_path / "crlf.txt").read_bytes() == b"alpha\r\ndelta\r\nepsilon\r\n"


def test_edit_crlf_single_line_to_multiline_stays_crlf(tmp_path):
    # Replacing one line with several must not sprinkle lone LFs into a CRLF file.
    sb = Sandbox(tmp_path)
    (tmp_path / "crlf.txt").write_bytes(b"one\r\ntwo\r\nthree\r\n")
    assert "1 replacement" in run(sb.t_edit_file("crlf.txt", "two", "2a\n2b"))
    assert (tmp_path / "crlf.txt").read_bytes() == b"one\r\n2a\r\n2b\r\nthree\r\n"
    # An old_string that already carries CRLF still matches literally; its CRLF replacement is not doubled.
    (tmp_path / "crlf2.txt").write_bytes(b"p\r\nq\r\n")
    assert "1 replacement" in run(sb.t_edit_file("crlf2.txt", "p\r\nq", "P\r\nQ"))
    assert (tmp_path / "crlf2.txt").read_bytes() == b"P\r\nQ\r\n"


def test_edit_crlf_match_is_never_ambiguous(tmp_path):
    sb = Sandbox(tmp_path)
    (tmp_path / "crlf.txt").write_bytes(b"a\r\nb\r\nx\r\na\r\nb\r\n")
    out = run(sb.run("edit_file", {"path": "crlf.txt", "old_string": "a\nb", "new_string": "z"}))
    assert out.startswith("ERROR") and "2 times" in out
    assert (tmp_path / "crlf.txt").read_bytes() == b"a\r\nb\r\nx\r\na\r\nb\r\n"
    assert "2 replacements" in run(sb.run("edit_file", {"path": "crlf.txt", "old_string": "a\nb", "new_string": "z", "replace_all": True}))
    assert (tmp_path / "crlf.txt").read_bytes() == b"z\r\nx\r\nz\r\n"


def test_edit_lf_file_stays_lf_and_exact(tmp_path):
    sb = Sandbox(tmp_path)
    (tmp_path / "lf.txt").write_bytes(b"one\ntwo\nthree\n")
    assert "1 replacement" in run(sb.t_edit_file("lf.txt", "two\nthree", "2\n3"))
    assert (tmp_path / "lf.txt").read_bytes() == b"one\n2\n3\n"
    # No CRLF retry can invent a match in an LF file, and the error text is unchanged.
    assert "not found" in run(sb.run("edit_file", {"path": "lf.txt", "old_string": "2\nzz", "new_string": "y"}))


def test_edit_mixed_endings_keeps_exact_bytes(tmp_path):
    # A mixed file has no single convention: the literal match wins, is never reinterpreted, and the CRLF
    # line the match does not cover is left alone.
    sb = Sandbox(tmp_path)
    (tmp_path / "mixed.txt").write_bytes(b"a\r\nb\na\nb\n")
    assert "1 replacement" in run(sb.t_edit_file("mixed.txt", "a\nb", "z\nw"))
    assert (tmp_path / "mixed.txt").read_bytes() == b"a\r\nb\nz\nw\n"
