"""Offline: the worker shell policy - the bash-line splitter, the wrapper peeling, the rules file and its grants."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, shellpolicy  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402

# GTFOBins-style: every way an ordinary binary runs another command, each carrying a git write.
# The one-regex gate this replaced let every one of these through.
WRAPPED_GIT_WRITES = [
    "env git stash",
    "env -i PATH=/usr/bin git stash",
    "env -S 'git reset --hard'",
    "timeout 60 git restore .",
    "timeout -s KILL 5 git restore .",
    "nice -n 5 git reset --hard",
    "nohup git push",
    "command git add -A",
    "sudo -u me git clean -fdx",
    "find . -name '*.mjs' -exec git checkout -- {} \\;",
    "find . -execdir git add {} +",
    "ls | xargs git reset --hard",
    "ls | xargs -I {} git rm {}",
    "sh -c 'git checkout main'",
    "bash -lc \"git restore src\"",
    "eval git stash",
    "eval 'git commit -m x'",
    "echo \"$(git stash)\"",
    "echo `git stash`",
    "cat <(git stash show; git stash drop)",
    "git -c alias.co=checkout co main",
    "git -c 'alias.x=!git reset --hard' x",
    "git --git-dir .git --work-tree . checkout x",
    "g'i't commit -m x",
    "\\git checkout x",
    "/usr/bin/git.exe push",
    "\"C:/Program Files/Git/cmd/git.exe\" checkout x",
    "git config alias.co checkout",
    # a shell reads its script from stdin when it has no -c and no script file
    "bash <<'EOF'\ngit reset --hard\nEOF",
    "sh <<< 'git stash'",
    "cat <<EOF\n$(git stash)\nEOF",  # an unquoted here-doc body still runs its substitutions
    "cmd //c \"git checkout main\"",
    "powershell -Command git stash",
    "pwsh -c 'git restore .'",
    "busybox sh -c 'git stash'",
    "setsid git stash",
    "flock /tmp/lock -c 'git stash'",
    "script -c 'git stash' /dev/null",
    "git branch -D main",
    "git read-tree HEAD",
]


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _no_opt_in(monkeypatch):
    monkeypatch.delenv("HSWARM_ALLOW_GIT_WRITES", raising=False)


@pytest.mark.parametrize("line", WRAPPED_GIT_WRITES)
def test_wrapped_git_writes_are_refused(line):
    assert (shellpolicy.refusal(line) or "").startswith("ERROR: refused `git "), line


@pytest.mark.parametrize("line", [
    "git stash list",
    "git worktree list --porcelain",
    "git config --get user.email",
    "cat <<'EOF' > notes.md\ngit checkout main\nEOF\necho done",
    "grep -rn 'git reset --hard' docs",
    "echo \"git stash\" > howto.txt",
    "find . -name '*.py' -exec wc -l {} +",
    "rm -rf build ./dist/*",
    "ls | xargs wc -l",
    "git branch -a && git tag -l",
])
def test_reads_and_text_that_mention_a_write_run(line):
    assert shellpolicy.refusal(line) is None, line


@pytest.mark.parametrize("line", [
    "$G checkout x", "git $(echo checkout) x", "git --config-env=alias.co=CO co",
    # a run-time word may stand for the whole command, or supply the words the rule looks at
    "C='git stash'; $C", "eval $C", "sh -c \"$C\"", "echo git stash | sh", "echo checkout main | xargs git",
    "find . -name stash -exec git {} \\;", "powershell -EncodedCommand ZwBpAHQAIABzAHQAYQBzAGgA",
])
def test_a_command_only_known_at_run_time_is_refused_not_guessed(line):
    assert "only known at run time" in (shellpolicy.refusal(line) or ""), line


@pytest.mark.parametrize("line", [
    "rm -rf /", "rm -fr ~", "rm -r -f $HOME", "rm -rf .", "rm -rf ..", "rm -rf ./", "rm -rf *", "rm -rf /usr/..",
    "rm --recursive --force ../..", "rm -rf \"$DIR/\"", "rm -rf C:/", "rm -rf /c/", "sudo rm -rf /", "bash -c 'rm -rf ~/*'",
])
def test_rm_of_a_whole_tree_is_refused_whatever_is_granted(line, monkeypatch):
    monkeypatch.setenv("HSWARM_ALLOW_GIT_WRITES", "1")
    assert (shellpolicy.refusal(line, [shellpolicy.parse_grant("rm")]) or "").startswith("ERROR: refused `rm -r "), line


def test_a_grant_lifts_its_prefix_only(tmp_path):
    grants = [shellpolicy.parse_grant("git add")]
    assert shellpolicy.refusal("git add src/a.py && git status", grants) is None
    assert shellpolicy.refusal("git add a && git commit -m x", grants).startswith("ERROR: refused `git commit`")
    assert shellpolicy.refusal("./git add a", grants).startswith("ERROR: refused `git add`")  # a local script named git is not git
    sb = Sandbox(tmp_path, shell_grants=["git add"])
    assert not run(sb.run("bash", {"command": "git add nothing"})).startswith("ERROR: refused")
    assert run(sb.run("bash", {"command": "git stash"})).startswith("ERROR: refused `git stash`")


@pytest.mark.parametrize("grant", ["./deploy.sh", "/usr/bin/git add", "git $SUB", "git add; git push", ""])
def test_a_grant_that_cannot_be_trusted_is_refused_at_submit(grant, tmp_path):
    with pytest.raises(ValueError, match="task t1: shell grant"):
        Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "shell_grants": [grant]})


def test_the_machine_overlay_adds_rules_and_a_broken_one_fails_loudly(tmp_path):
    overlay = config.HOME / "shell_rules.toml"
    overlay.parent.mkdir(parents=True, exist_ok=True)
    overlay.write_text('[[rule]]\npattern = ["npm", "publish"]\ndecision = "forbidden"\n'
                       'justification = "publishing is the owner\'s call; stop and report instead."\n'
                       "match = ['cd pkg && npm publish --tag next']\nnot_match = ['npm test']\n", encoding="utf-8")
    assert shellpolicy.refusal("npm test && npm publish") == ("ERROR: refused `npm publish` - publishing is the owner's call; "
                                                              "stop and report instead.")
    assert shellpolicy.status().startswith(f"{len(shellpolicy.rules())} rules (shell_rules.toml + ")
    overlay.write_text('[[rule]]\npattern = ["npm", "publish"]\ndecision = "forbidden"\njustification = "no"\n'
                       "match = ['npm pubish']\n", encoding="utf-8")  # the typo is the point: the example must match
    assert "example 'npm pubish' should match it" in shellpolicy.refusal("echo hi")
    assert shellpolicy.status().startswith("BROKEN")


def test_the_shipped_rules_pass_their_own_examples():
    assert len(shellpolicy.load_rules(shellpolicy.RULES_FILE)) >= 4


@pytest.mark.parametrize("line", [
    "cat .secrets/openai_api_keys", "type .secrets\\groq_api_keys", "powershell -Command Get-Content .secrets/demo_api_keys",
    "cat ./.SECRETS/x", "head -5 openai_api_keys.dead", "cat deepseek_api_key", "cat ~/.hswarm/providers/deepseek.toml",
    "bash -c 'cat .hswarm\\providers\\x.toml'",
])
def test_key_files_are_refused_whatever_is_granted(line):  # pins: .secrets, *_api_keys and .hswarm/providers words are a hard refusal
    refused = shellpolicy.refusal(line, [shellpolicy.parse_grant("cat")])
    assert (refused or "").startswith("ERROR: refused") and "key files are never readable" in refused, line


@pytest.mark.parametrize("line", ["cat README.md", "grep -rn api_keys docs", "ls secrets", "echo .secretsfoo"])
def test_ordinary_words_near_key_files_run(line):  # pins: the key-file check names components, not substrings
    assert shellpolicy.refusal(line) is None, line
