"""Task and Result records shared by every backend, plus the two helpers both backends need."""
from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import capability as capmod, config, redaction, review, shared, shellpolicy, verify
from . import zdr as zdr_mod
from .receipts import GREEN_LEVELS
from .runtimes import parse_runtime, posix_abs
from .scripted import SCRIPT_SCHEMA, SCRIPTED_CLAUSE
from .toolspecs import PRESETS, WEB_TOOLS, tool_names

BACKENDS = ("api", "cc")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# The cc tiers that run Claude Code with every permission bypassed. Reaching one takes two opt-ins (the
# preset AND confirm_write), so a caller who meant "read" can never widen a worker by a typo or a default.
CC_WRITE_TIERS = ("edit", "all")


def cc_tier(tools: str | list[str]) -> str:
    """The permission tier a task's tools ask of the cc backend: read | none | edit | all. A comma list of api
    tool names maps to the widest tier it names; anything unrecognised is read-only, so it fails closed."""
    if isinstance(tools, str) and tools in ("read", "none", "edit", "all"):
        return tools
    names = {n.strip() for n in (tools.split(",") if isinstance(tools, str) else tools) if n and n.strip()}
    if not names:
        return "none"
    if "bash" in names:
        return "all"
    if names & {"write_file", "edit_file"}:
        return "edit"
    return "read"


def now_iso(timespec: str = "seconds") -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec=timespec)


def add_spend(res: "Result", spent, *, poison: bool = False) -> None:
    """Fold earlier attempts' spend (dicts or Results) into `res`: cost, usage, turns, seconds, api_seconds, rested_s.
    poison=True (profile dispatch): an unknown cost makes the total unknown; otherwise unknown costs are skipped."""
    for d in spent:
        get = d.get if isinstance(d, dict) else (lambda k, default=None, d=d: getattr(d, k, default))
        cost = get("cost_usd")
        if poison and (cost is None or res.cost_usd is None):
            res.cost_usd = None
        elif cost is not None:
            res.cost_usd = (res.cost_usd or 0.0) + cost
        for k, v in (get("usage") or {}).items():
            res.usage[k] = res.usage.get(k, 0) + v
        res.turns += get("turns", 0) or 0
        res.seconds = round(res.seconds + (get("seconds", 0) or 0), 3)
        res.api_seconds = round(res.api_seconds + (get("api_seconds", 0) or 0), 3)
        res.rested_s = round(res.rested_s + (get("rested_s", 0) or 0), 3)


def inline_files(task: "Task", prompt: str, redactor: "redaction.Redactor | None" = None) -> str:
    """Append the contents of task.files to the prompt (relative paths resolve under cwd). With a redactor, each
    file's contents are redacted like a tool output: an inlined file reaches the provider just as a read_file would."""
    if not task.files:
        return prompt
    parts = [prompt, ""]
    for f in task.files:
        p = Path(f)
        if not p.is_absolute():
            p = Path(task.cwd) / p
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            text = f"<unreadable: {e}>"
        if redactor is not None:
            text = redactor.scrub(text, f"file {p.as_posix()}")
        parts.append(f"--- file: {p.as_posix()} ---\n{text}\n--- end file ---")
    return "\n".join(parts)


SCOPE_OPEN = "<scope "


def scope_mark(scope: str) -> str:
    """The short token a worker echoes to prove it read the scope block: stable per block, so one batch shares it."""
    return "SCOPE-" + hashlib.sha1(scope.strip().encode("utf-8")).hexdigest()[:8]


def scope_header(scope: str) -> str:
    mark = scope_mark(scope)
    return (f'{SCOPE_OPEN}id="{mark}">\n{scope.strip()}\n</scope>\n'
            f"Work ONLY inside this scope. Put the line `{mark}` first in your answer, and in the `scope` field "
            "of your submitted result when it has one.")


def mis_scoped(task: "Task", res: "Result") -> bool:
    """True when a task that carried a scope block finished without echoing its mark in the answer or the data."""
    if not task.scope or res.status != "ok":
        return False
    mark = scope_mark(task.scope)
    return mark not in (res.answer or "") and mark not in json.dumps(res.data, ensure_ascii=False, default=str)


def did_you_mean(wrong, valid) -> str:
    """The nearest valid spelling of each mistyped name, as a clause for a refusal (`; did you mean 'read' for
    'raed'?`); "" when nothing is close. A refusal that only lists 40 known names leaves the caller to find the typo."""
    import difflib

    near = [(w, m[0]) for w in wrong if (m := difflib.get_close_matches(str(w).lower(), list(valid), n=1)) and m[0] != w]
    return "; did you mean " + ", ".join(f"{m!r} for {w!r}" for w, m in near) + "?" if near else ""


_JSON_TYPES = ("array", "boolean", "integer", "null", "number", "object", "string")
_SCHEMA_BOUNDS = (("minItems", "maxItems"), ("minimum", "maximum"), ("minLength", "maxLength"))


def schema_contradictions(node, at: str = "") -> list[str]:
    """Every place a JSON Schema asks for something no value can be: a lower bound above its upper bound, or a
    `required` name that `additionalProperties: false` forbids. WHY: jsonschema's check_schema accepts both
    (minItems 5 with maxItems 2 passes it), and such a schema rejects every submit on every leg."""
    if isinstance(node, list):
        return [line for i, v in enumerate(node) for line in schema_contradictions(v, f"{at}/{i}")]
    if not isinstance(node, dict):
        return []
    out, here = [], at or "(root)"
    for lo, hi in _SCHEMA_BOUNDS:
        a, b = node.get(lo), node.get(hi)
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (a, b)) and a > b:
            out.append(f"{here}: {lo} {a} is above {hi} {b}")
    required, props = node.get("required"), node.get("properties")
    if node.get("additionalProperties") is False and isinstance(required, list) and "patternProperties" not in node:
        props = props if isinstance(props, dict) else {}
        if ghosts := [k for k in required if k not in props]:
            out.append(f"{here}: required {ghosts} are not in properties, which additionalProperties: false forbids"
                       + did_you_mean(ghosts, props))
    for k, v in node.items():
        if k not in ("enum", "const", "default", "examples"):  # data, not schemas
            out += schema_contradictions(v, f"{at}/{k}")
    return out


@dataclass
class Task:
    prompt: str
    id: str = ""
    cwd: str = ""
    backend: str = "api"
    model: str = config.AUTO  # published capability profile, then cost and availability
    system: str | None = None
    tools: str | list[str] = "read"
    max_turns: int | None = None  # None: config.DEFAULT_MAX_TURNS for the backend (api 24, cc 40)
    max_tokens: int = 16_000
    max_context: int = 400_000
    # api loop context hygiene (context.py): clear stale tool results past this many prompt tokens, at least
    # context_clear_at_least per pass. 0 turns it off for a task that must keep every result verbatim.
    context_trigger: int = config.CONTEXT_TRIGGER_TOKENS
    context_clear_at_least: int = config.CONTEXT_CLEAR_AT_LEAST
    max_cost_usd: float = 0.25
    # WHY: a worker killed at its cap loses what it found; at this share of max_cost_usd (or of the job's budget_usd)
    # it is asked once to finish and hand back a partial result (budget.py). 0 turns the checkpoint off.
    checkpoint_at: float = 0.8
    timeout_s: int = 600
    schema: dict | None = None
    # Opt-in checked work (verify.py): a command run in cwd after the worker finishes, judge criteria, or both,
    # with a capped retry that hands the failure back. A string is a command; normalised to a dict in _validate.
    verify: str | dict | None = None
    # Typed criteria decided in code after the worker stops (acceptance.py): file:<path>, file_written:<path>,
    # tests_passed:<command>. Unlike verify nothing is re-run: the verdicts come from the disk and the receipt
    # ledger and land in Result.acceptance; anything untyped comes back UNVERIFIED.
    acceptance: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    roots: list[str] = field(default_factory=list)
    # Hosts read_url may fetch for this task (`example.com` covers its subdomains, `*` any public host). Any
    # other host is not fetched: it comes back as an approval request on the Result and the job summary.
    web_hosts: list[str] = field(default_factory=list)
    # The frozen judge: when set, write_file/edit_file may change only paths these globs cover (relative to cwd
    # or absolute; `**` spans folders, a folder covers its contents) and every other file under the roots stays
    # readable but read-only, so a worker asked to make a test pass cannot pass by editing the test. None = no limit.
    writable: list[str] | None = None
    thinking: bool | None = None
    # Zero data retention: only OpenRouter models on its zero-retention list may serve this task, and every request
    # carries `provider: {zdr: true}`. Fails closed: with no list read, the task is refused (zdr.py).
    zdr: bool = False
    reasoning_effort: str | None = None
    temperature: float | None = None
    role: str | None = None  # a kind of work (search, code, judge, ...) resolved to whatever model config.ROLES wires for it
    profile: str | None = None  # published capability requirements; AUTO fills this from role/tools
    # WHAT THE ANSWER IS FOR: "production" (it ships, or feeds work that ships) or "evaluation" (it is only
    # measured - a benchmark, an eval, a probe). Some providers' own terms allow the second only, and this is
    # what routes past them; the full reasoning is selection.PURPOSES. Defaults to production, the safe side.
    purpose: str = "production"
    min_scores: dict[str, float] = field(default_factory=dict)
    exclude_models: list[str] = field(default_factory=list)
    # False pins the model EXACTLY as named, with no price routing to another provider serving the same
    # thing. The A/B harness sets it: an arm called "deepseek-flash" that the router quietly moved to
    # OpenRouter would compare one provider against itself and report it as a difference.
    route: bool = True
    # PII/secret redaction of this task's tool output before it reaches the provider (redaction.py):
    # a strategy name (hash | redact | mask | block), true, "off", or {strategy, detectors, patterns}.
    # None defers to the machine switch HSWARM_REDACT_FREE_TIER for free-tier legs.
    redact: Any = None
    # The model the caller pinned, when hswarm routed the task by its profile instead because nothing on that
    # model's route could serve (jobs.unpinned). Set by hswarm, never by a caller.
    unpinned_from: str = ""
    # cc only: launch Claude Code with `--setting-sources user`, so the task folder's own CLAUDE.md/AGENTS.md,
    # .claude/rules, project hooks and settings are not loaded (the worker's own CLAUDE.md and shield stay).
    # Opt-in, because a reviewer judges code against those house rules; a tools "none" task always runs this way.
    lean: bool = False
    # cc only: the ONE file the worker may write, checked against `schema` by hooks while it still has a turn
    # (result_hooks.py) - the cc twin of submit_result. Relative paths resolve under cwd.
    result_file: str | None = None
    # cc only. The second half of the write opt-in: an edit/all preset on cc bypasses every permission, so it
    # also needs this set, or the task is refused. The api backend's sandbox tools ignore it.
    confirm_write: bool = False
    # cc only. lean plus --strict-mcp-config: the worker loads no MCP server and only hswarm's own worker settings
    # (one shared --setting-sources user), so the task folder's hooks and .mcp.json servers cannot fire. Bench arms
    # set it: a hook that runs on every arm makes the baseline secretly run the thing under test.
    isolated: bool = False
    # A named recipe (the same job run again on new input): the read-only tool calls of its last passing run are
    # replayed before the model plans again (plans.py). A task with no recipe is never cached.
    recipe: str | None = None
    # Command prefixes this task's bash may run although the shell policy forbids them (`["git add", "git commit"]`),
    # for a task that owns its checkout. A hard rule and the rm -r whole-tree deny are never lifted (shellpolicy.py).
    shell_grants: list[str] = field(default_factory=list)
    # A least-privilege grant (capability.py): a preset, a named file under <cwd>/.hswarm/capabilities/ or
    # ~/.hswarm/capabilities/, a .json path, or an inline object. It replaces `tools`, and once resolved it is
    # the normalised grant itself, so job.json records exactly what the worker was allowed.
    capability: str | dict | None = None
    # The green level a "done" must be backed by (receipts.GREEN_LEVELS): the worker then has to name a
    # passing bash receipt, and hswarm_results marks an ok result without one as unverified.
    green: str | None = None
    # The input set a review task must cover (review.py): with it, the result must carry `reviewed_paths` equal to
    # it, checked by hswarm, or the task fails as IncompleteReview instead of passing a silent partial review.
    inventory: list[str] = field(default_factory=list)
    # A batch-level scope block (read root, diff command, "data only") prepended VERBATIM to the prompt, with an
    # echo mark the worker must repeat. Adapted from mui/material-ui's review skill (MIT): a worker that reviewed
    # the wrong tree cannot echo the mark, so its result is flagged `mis_scoped` instead of trusted.
    scope: str | None = None
    # A STRONGER model to re-run this task on once if the worker gives up (escalation.py); None never escalates.
    # Opt-in because it spends on a model the cheap-only route would never reach on its own.
    escalate: str | None = None
    # A checkable condition ("pytest exits 0", "README.md lists every CLI verb"). When set, a separate tool-free call
    # must find the proof in the transcript before the worker's answer is accepted (goal.py); api backend only.
    done_when: str | None = None
    done_when_max_blocks: int = 3  # how many times a failed check sends the worker back; the next one ends the task
    # The spawn-tree envelope this task runs under (envelope.Envelope.as_dict). Set at DISPATCH by envelope.admit,
    # never by the caller: a task that could name its own envelope could widen it. A cc worker hands it on.
    envelope: dict | None = None
    # Scripted-diff mode (scripted.py): the worker makes its change with a bash script and submits the script;
    # the result is accepted only when replaying the script on the starting tree reproduces the worker's tree.
    # The reviewer then reads a few lines of script instead of the whole mechanical diff.
    scripted: bool = False
    # Where the api tools run (runtimes.py): "" / "host" is this machine; docker-container:<id>, podman-container:<id>
    # or ssh:<target> run every tool inside that isolate, with cwd and roots as POSIX paths there.
    runtime: str = ""

    @staticmethod
    def from_dict(d: dict, defaults: dict | None = None, index: int = 0) -> "Task":
        merged = dict(defaults or {})
        merged.update({k: v for k, v in d.items() if v is not None})
        if not str(merged.get("prompt") or "").strip():
            raise ValueError(f"task {index}: 'prompt' is required")
        if "envelope" in merged:
            raise ValueError(f"task {index}: 'envelope' is set at dispatch from the job's envelope, not per task; "
                             "pass it to the job (hswarm_run envelope / python -m hswarm run --envelope)")
        unknown = set(merged) - {f.name for f in dataclasses.fields(Task)}
        if unknown:
            known = sorted(f.name for f in dataclasses.fields(Task))
            raise ValueError(f"task {index}: unknown fields {sorted(unknown)}{did_you_mean(sorted(unknown), known)}; known: {known}")
        t = Task(**merged)
        t.id = str(t.id or f"t{index + 1}")
        t = t._normalised()
        if merged.get("max_cost_usd") is None:  # unnamed: the cap follows the profile AUTO resolved, and whether it has tools
            t.max_cost_usd = config.default_max_cost_usd(t.profile, t.tools)
            # ...raised when finished tasks of the same shape routinely spent more (taskstore: 1,216 tasks killed at
            # the flat default in 7 days to 2026-10-02, with the work they had paid for).
            from . import taskstore

            t.max_cost_usd = taskstore.sized_cap(t.backend, t.profile, t.tools, bool(t.schema), len(t.prompt or ""),
                                                 t.max_cost_usd) or t.max_cost_usd
        return t

    def _apply_capability(self) -> None:
        """Resolve the named grant and let it decide the tool list, before AUTO picks a model by that list."""
        if not self.capability:
            return
        try:
            cap = capmod.resolve(self.capability, self.cwd)
        except ValueError as e:
            raise ValueError(f"task {self.id}: {e}") from e
        self.capability, self.tools = cap.as_dict(), ",".join(cap.tools) or "none"

    def _resolve_backend(self) -> None:
        """The backend, and the model it is allowed to run: `cc` is headless Claude Code, so its model must be served
        by a provider with an Anthropic Messages endpoint (DeepSeek, Hugging Face, OpenRouter) or one reached through
        the loopback facade (gemini, groq, cerebras; anthropic_facade.py)."""
        self.backend = self.backend or "api"
        if self.backend not in BACKENDS:
            raise ValueError(f"task {self.id}: backend must be one of {BACKENDS}")
        from .selection import PURPOSES

        if self.zdr and self.backend != "api":
            raise ValueError(f"task {self.id}: zdr needs backend api (the cc backend cannot carry the zero-retention preference)")
        self.purpose = (self.purpose or "production").strip().lower()
        if self.purpose not in PURPOSES:
            raise ValueError(f"task {self.id}: purpose must be one of {sorted(PURPOSES)} - "
                             + "; ".join(f"{k}: {v}" for k, v in PURPOSES.items()))
        # Explicit model/role pins win; AUTO retains the profile for live availability selection.
        if self.role and config.ROLES.get(self.role.strip().lower()) != config.AUTO:
            self.profile = None
            self.model = config.resolve_role(self.role)
        elif not self.model or str(self.model).strip().lower() == config.AUTO:
            from .dispatch import plan_for
            from .selection import profile_for, plan

            self.profile = self.profile or profile_for(self.role, self.tools)
            choice = plan(self.profile, tools=self.tools, backend=self.backend, purpose=self.purpose,
                          reasoning_effort=self.reasoning_effort, thinking=self.thinking,
                          min_scores=self.min_scores, exclude_models=self.exclude_models, vision=self.role == "vision", zdr=self.zdr)
            if not choice["candidates"]:
                zwhy = f" and is cleared for zero data retention ({(choice['rejected'] or [{}])[0].get('reason', '')})" if self.zdr else ""
                raise ValueError(f"NoCapableSwarmRoute: no evaluated configuration meets profile {self.profile}{zwhy}")
            # The first leg of the plan dispatch will run, over the pools that can serve now; the evidence's own
            # cheapest only when no pool can (submit then refuses, or the run says NoCapableSwarmRoute).
            self.model = (plan_for(self)["candidates"] or choice["candidates"])[0]["model"]
        else:
            self.profile = None
            self.model = config.resolve_model(self.model)
            if self.zdr and (why := zdr_mod.refusal(self.model)):
                raise ValueError(f"task {self.id}: zdr task refused: {why}")
        provider = config.provider_of(self.model)
        # The same gate the router applies, on the PINNED path only (`self.profile` is None exactly when a model or a
        # role named the route, and AUTO's own plan already filtered on purpose): a provider whose own terms allow
        # evaluation only cannot be reached by naming its model either, or the rule would bind AUTO and not the caller
        # who typed the model in. The refusal names the one field that opens it, so an eval says so and gets the route.
        if self.profile is None and self.purpose != "evaluation" and config.PROVIDERS[provider].get("evaluation_only"):
            raise ValueError(f"task {self.id}: {provider}'s own terms allow internal evaluation only, so it cannot serve a "
                             f"{self.purpose} task; set purpose: \"evaluation\" if this answer is only measured, or leave the "
                             f"model on auto and hswarm routes it to a provider whose terms allow shipped work")
        if self.backend == "cc" and self.capability:
            raise ValueError(f"task {self.id}: a capability is enforced by the api backend's sandbox; the cc backend runs "
                             "Claude Code's own tools, which cannot hold its path scope")
        if self.backend == "cc" and not config.PROVIDERS[provider].get("anthropic_url"):
            raise ValueError(f"task {self.id}: the cc backend runs headless Claude Code, which needs an Anthropic-compatible endpoint; "
                             f"model {self.model} is served by {provider}, which has none")
        if self.escalate:
            if self.backend != "api":
                raise ValueError(f"task {self.id}: escalate works on the api backend only (the teacher reads the api worker's trace)")
            self.escalate = config.resolve_model(self.escalate)
            if self.escalate == self.model:
                raise ValueError(f"task {self.id}: escalate must name a stronger model than the task's own ({self.model})")

    def _validate(self) -> None:
        """The working folder, the limits, and the output contract. Anything impossible fails here, by name."""
        if not self._validate_runtime():
            self._validate_host_cwd()
        self._validate_limits()

    def _validate_runtime(self) -> bool:
        """True for a task whose tools run in a container or over ssh (runtimes.py). Its cwd and roots are POSIX paths
        THERE, so none is checked on this host, and each option that reads or runs on this host is refused by name."""
        try:
            rt = parse_runtime(self.runtime)
        except ValueError as e:
            raise ValueError(f"task {self.id}: {e}") from None
        if rt is None:
            self.runtime = ""
            return False
        self.runtime = rt.spec
        # inventory, verify.judge and acceptance read the task's files at cwd on THIS host (review.unread_gap,
        # verify.judge_prompt, acceptance.decide): with a POSIX cwd in the isolate they would find nothing, or a
        # different host file, and pass unchecked.
        host_only = {"backend cc": self.backend != "api", "files": bool(self.files), "scripted": bool(self.scripted),
                     "result_file": bool(self.result_file), "verify.command": bool((self.verify or {}).get("command")),
                     "verify.judge": bool((self.verify or {}).get("judge")), "inventory": bool(self.inventory),
                     "acceptance": bool(self.acceptance), "propose": "propose" in tool_names(self.tools)}
        refused = [name for name, used in host_only.items() if used]
        if refused:
            raise ValueError(f"task {self.id}: runtime {rt.spec} runs the tools elsewhere, but {', '.join(refused)} "
                             "reads or runs on this host; drop it, or run the task on the host")
        try:
            self.cwd = str(posix_abs(self.cwd or ""))
            self.roots = [str(posix_abs(r)) for r in self.roots]
        except ValueError as e:
            raise ValueError(f"task {self.id}: {e}") from None
        return True

    def _validate_host_cwd(self) -> None:
        """The working folder on this host: given, taken from the shared server's caller, or refused by name."""
        if not self.cwd and shared.ACTIVE:  # the shared server's own folder belongs to whoever started it, never this chat
            self.cwd = (shared.REQUEST.get() or {}).get("cwd") or ""
            if not self.cwd and (self.tools not in ("none", []) or self.files):
                raise ValueError(f"task {self.id}: no cwd given, and the shared hswarm server serves every chat from one process, "
                                 "so it cannot know yours; pass cwd (or send the X-Hswarm-Cwd header)")
            self.cwd = self.cwd or tempfile.gettempdir()  # a tool-free task never touches its folder
        elif shared.ACTIVE and not Path(self.cwd).is_absolute():  # "." would resolve against the server's folder
            base = (shared.REQUEST.get() or {}).get("cwd") or ""
            if not base:
                raise ValueError(f"task {self.id}: cwd {self.cwd!r} is relative, and the shared hswarm server has no folder of "
                                 "yours to resolve it against; pass an absolute cwd (or send the X-Hswarm-Cwd header)")
            self.cwd = str(Path(base) / self.cwd)
        self.cwd = str(Path(self.cwd or os.getcwd()).resolve())
        if not Path(self.cwd).is_dir():
            raise ValueError(f"task {self.id}: cwd {self.cwd} is not a directory")
        self._validate_files()

    def _validate_files(self) -> None:
        """Every `files` entry must be a file under cwd now. WHY: a missing one was inlined as `<unreadable: ...>`
        and the paid call went out anyway, to come back ok about a file the worker never saw (inline_files keeps
        that line only for a file that goes away between submit and run)."""
        if isinstance(self.files, str):
            self.files = [self.files]
        missing = [f for f in self.files if not isinstance(f, str) or not (Path(self.cwd) / f).is_file()]
        if not missing:
            return
        near = ""
        for f in missing:
            try:
                near += did_you_mean([Path(str(f)).name], os.listdir((Path(self.cwd) / str(f)).parent))
            except OSError:  # its folder is not there either: nothing to suggest
                pass
        raise ValueError(f"task {self.id}: files {missing} are not files under cwd {self.cwd}{near}; fix the path or drop "
                         "the entry (relative paths resolve under cwd)")

    def _validate_limits(self) -> None:
        """The limits and the output contract, whichever machine the tools run on."""
        if self.max_turns is None:
            self.max_turns = config.DEFAULT_MAX_TURNS[self.backend]
        self._limit("max_turns", int, 1)
        self._limit("timeout_s", int, 5)
        self._limit("max_tokens", int, 1)
        self._limit("max_cost_usd", float, 0.0001)
        self.context_trigger = max(0, int(self.context_trigger or 0))
        self.context_clear_at_least = max(0, int(self.context_clear_at_least or 0))
        if self.reasoning_effort is not None and self.reasoning_effort not in EFFORTS:
            raise ValueError(f"task {self.id}: reasoning_effort must be one of {EFFORTS}")
        self._validate_output()
        self._validate_acceptance()
        if self.backend == "cc" and cc_tier(self.tools) in CC_WRITE_TIERS and self.confirm_write is not True:
            raise ValueError(f"task {self.id}: tools {self.tools!r} on the cc backend runs Claude Code with every permission "
                             "bypassed, which takes two opt-ins: the write preset AND confirm_write: true. Read-only work "
                             "needs neither (tools: read)")
        self._validate_recipe()
        self._validate_shell_grants()

    def _limit(self, name: str, cast, at_least: float, below: float = float("inf")) -> None:
        """One numeric limit, coerced to its type and refused by name when it is not a number or out of range.

        WHY: a limit used to be kept as written. max_cost_usd 0 read as "no cap" (agent and worker test it as a falsy
        value), which is the uncapped worker of 2026-09-15 (80k reasoning tokens, 50x its siblings); the string '1.5'
        from a tasks file raised TypeError only after the first paid turn; and max_turns 0 or timeout_s 0 were
        silently made 1 turn and 5 s instead of being refused."""
        raw = getattr(self, name)
        try:
            value = None if isinstance(raw, bool) else cast(raw)
        except (TypeError, ValueError, OverflowError):
            value = None
        if value is None or not at_least <= value < below:
            top = "" if below == float("inf") else f" and below {below:g}"
            raise ValueError(f"task {self.id}: {name} must be a number of at least {at_least:g}{top}, got {raw!r}")
        setattr(self, name, value)

    def _validate_output(self) -> None:
        """The propose preset, the checkpoint share, the schema and the redaction: what shapes the worker's output."""
        names = self.tools if isinstance(self.tools, list) else str(self.tools).split(",")
        if self.backend == "cc" and "propose" in {str(n).strip() for n in names}:  # stripped as specs_for does: "read, propose" too
            # cc hands the worker Claude Code's own write tools for any preset it does not know: the split would be a lie.
            raise ValueError(f"task {self.id}: the propose preset is api-backend only - a cc worker holds its own write tools")
        self._validate_tools()
        self._limit("checkpoint_at", float, 0.0, 1.0)  # a share of the budget (or of timeout_s), 0 for off
        if self.schema is not None:
            self._validate_schema()
        try:
            redacting = redaction.from_spec(self.redact) is not None  # a bad strategy or regex fails the spec here, by name, not mid-run
        except ValueError as e:
            raise ValueError(f"task {self.id}: {e}") from None
        if redacting and self.backend == "cc":
            # Claude Code runs its own tools, out of reach of the Sandbox: a redaction asked for there would silently not happen.
            raise ValueError(f"task {self.id}: redact applies to the api backend's sandboxed tools; a cc worker's tools cannot be redacted")

    def _validate_tools(self) -> None:
        """Every tool name must be one hswarm has, on both backends. WHY: cc_tier reads an unknown name as read-only, so
        tools 'Edit' or 'write' with confirm_write was accepted and ran a paid read-only Claude Code session that
        could not write what it was sent to write (up to a 40-turn run; cc checks max_cost_usd only afterwards), and
        on the api backend the same typo was refused only once the task ran (toolspecs.specs_for)."""
        from .toolspecs import SPECS

        if not isinstance(self.tools, (str, list)):
            raise ValueError(f"task {self.id}: tools must be a preset name, a comma list of tool names, or a list of them")
        unknown = [n for n in tool_names(self.tools) if not isinstance(n, str) or n not in SPECS]
        if unknown:
            alone = "; a preset is given alone, not inside a list" if any(isinstance(n, str) and n in PRESETS for n in unknown) else ""
            raise ValueError(f"task {self.id}: unknown tools {unknown}{did_you_mean(unknown, [*PRESETS, *SPECS])}{alone}; "
                             f"known: {sorted(SPECS)} or presets {sorted(PRESETS)}")

    def _validate_schema(self) -> None:
        """A schema that is not JSON Schema, or that no answer can meet, is refused before any paid call. WHY: an
        invalid one ({'type': 'strng'}) made worker.schema_errors fall back to its top-level required check, so any
        payload passed; one nothing satisfies was rejected on every leg and rerun dead (the task's whole
        max_cost_usd over about 6 legs, plus 30+ min of rests)."""
        from jsonschema import exceptions, validators

        if not isinstance(self.schema, dict):
            raise ValueError(f"task {self.id}: schema must be a JSON-schema object")
        try:
            validators.validator_for(self.schema).check_schema(self.schema)
        except exceptions.SchemaError as e:
            at = "/".join(map(str, e.absolute_path)) or "(root)"
            near = did_you_mean([e.instance], _JSON_TYPES) if at.endswith("type") and isinstance(e.instance, str) else ""
            raise ValueError(f"task {self.id}: schema is not valid JSON Schema at {at}: {e.message[:200]}{near}") from None
        # api only: there the schema IS submit_result's function parameters, which providers take as an object; a cc
        # result_file may hold any JSON value (result_hooks.validate).
        if self.backend == "api" and self.schema.get("type", "object") != "object":
            raise ValueError(f"task {self.id}: schema root must be type 'object' on the api backend (the answer is the "
                             f"arguments of a submit_result call), got {self.schema.get('type')!r}; wrap it, e.g. "
                             "{'type': 'object', 'properties': {'items': <your schema>}, 'required': ['items']}")
        if wrong := schema_contradictions(self.schema):
            raise ValueError(f"task {self.id}: no answer can satisfy schema: {'; '.join(wrong[:6])}")

    def _validate_acceptance(self) -> None:
        """The acceptance criteria and the cc backend's result_file contract."""
        if isinstance(self.acceptance, str):
            self.acceptance = [self.acceptance]
        if not isinstance(self.acceptance, list) or not all(isinstance(c, str) and c.strip() for c in self.acceptance):
            raise ValueError(f"task {self.id}: acceptance must be a list of criteria such as file:<path>, file_written:<path>, tests_passed:<command>")
        if self.result_file:
            if self.backend != "cc":
                raise ValueError(f"task {self.id}: result_file is the cc backend's one-file contract; an api task returns "
                                 "structured results through schema + submit_result instead")
            self.result_file = str((Path(self.cwd) / self.result_file).resolve())

    def _validate_recipe(self) -> None:
        if self.recipe is None:
            return
        from .plans import RECIPE_RE  # plans imports this module; the rule lives beside the cache it guards

        if not RECIPE_RE.match(str(self.recipe)):
            raise ValueError(f"task {self.id}: recipe must be a name (letters, digits, _ . : -, at most 80), not free text")
        if self.backend != "api":
            raise ValueError(f"task {self.id}: recipe plans replay on the api backend only; cc runs Claude Code's own loop")

    def _validate_shell_grants(self) -> None:
        if isinstance(self.shell_grants, str):
            self.shell_grants = [self.shell_grants]
        if self.shell_grants and self.backend == "cc":  # only the api worker's bash tool reads them; say so, not ignore them
            raise ValueError(f"task {self.id}: shell_grants lift rules of the api backend's bash tool; a cc worker runs "
                             "Claude Code's own shell, which they do not reach")
        for grant in self.shell_grants:
            try:
                shellpolicy.parse_grant(grant)  # a grant that may not be granted fails the task here, by name, not mid-run
            except ValueError as e:
                raise ValueError(f"task {self.id}: {e}") from None

    def _check_backend(self) -> None:
        """The backend NAME, before anything else: the limits _validate sets are per backend, and the grant must be
        resolved (it needs the validated cwd) before _resolve_backend lets AUTO pick a model by its tool list."""
        self.backend = self.backend or "api"
        if self.backend not in BACKENDS:
            raise ValueError(f"task {self.id}: backend must be one of {BACKENDS}")
        if isinstance(self.web_hosts, str):
            self.web_hosts = [h.strip() for h in self.web_hosts.split(",") if h.strip()]
        if not isinstance(self.web_hosts, list) or not all(isinstance(h, str) for h in self.web_hosts):
            raise ValueError(f"task {self.id}: web_hosts must be a list of host names (or a comma list)")
        # WHY: an entry pasted as a URL ('https://docs.python.org/3/') never matched the host it names, so every
        # read_url of it came back APPROVAL NEEDED. Each entry is kept as the bare host the gate compares.
        from .web import _norm_host

        hosts = ["*" if h.strip() == "*" else _norm_host(h) for h in self.web_hosts]
        if "" in hosts:
            raise ValueError(f"task {self.id}: web_hosts entry {self.web_hosts[hosts.index('')]!r} names no host; "
                             "give a bare host such as docs.python.org (it covers its subdomains), or * for any public host")
        self.web_hosts = list(dict.fromkeys(hosts))
        # The per-host gate lives in the api sandbox; Claude Code would take the preset as "all tools" and
        # reach the web through its own WebFetch with no gate at all, so a cc task may not ask for it.
        if self.backend == "cc" and isinstance(self.tools, (str, list)) and WEB_TOOLS & set(tool_names(self.tools)):
            raise ValueError(f"task {self.id}: read_url (the web preset) runs only on the api backend, where its host gate lives")
        self.verify = verify.normalise(self.verify, self.id)
        self._validate_green()
        if not isinstance(self.inventory, list) or not all(isinstance(p, str) and p.strip() for p in self.inventory):
            raise ValueError(f"task {self.id}: inventory must be a list of non-empty path strings")
        self.inventory = list(dict.fromkeys(review.norm_path(p) for p in self.inventory))

    def _validate_green(self) -> None:
        """Green evidence is a receipt of a passing command, so a green task needs a level and the bash tool."""
        if self.green is None:
            return
        if self.green not in GREEN_LEVELS:
            raise ValueError(f"task {self.id}: green must be one of {'|'.join(GREEN_LEVELS)}")
        if self.schema is not None:
            # A schema answer is the submit_result JSON, where a trailing GREEN: line cannot be found, so the
            # pair could never verify: refuse it up front instead of returning every such task unverified.
            raise ValueError(f"task {self.id}: green cannot be combined with a schema; drop one of them")
        if self.backend != "api" or "bash" not in tool_names(self.tools):
            raise ValueError(f"task {self.id}: green evidence needs the api backend and the bash tool (tools='all'), "
                             "since it is checked against the worker's own receipt of the passing run")

    def _review(self) -> None:
        """The review role's rubric and default output, and the coverage receipt an inventory demands (review.py).
        The receipt clause rides on the prompt, not the system prompt, so the shared prefix stays cacheable."""
        if (self.role or "").strip().lower() == review.ROLE:
            self.system = review.RUBRIC + ("\n\n" + self.system.strip() if self.system else "")
            self.schema = self.schema or review.review_schema()
        if self.inventory:
            self.schema = review.with_receipt(self.schema)
            self.prompt = self.prompt.rstrip() + "\n\n" + review.receipt_clause(self.inventory)
        if self.writable is not None:
            if isinstance(self.writable, str):
                self.writable = [self.writable]
            if not isinstance(self.writable, list) or not all(isinstance(g, str) and g.strip() for g in self.writable):
                raise ValueError(f"task {self.id}: writable must be a list of path globs")
            # Only the api sandbox enforces it; a cc worker has Claude Code's own Edit/Write, so accepting it there would be a promise not kept.
            if self.backend == "cc":
                raise ValueError(f"task {self.id}: writable is enforced by the api backend's sandbox only; the cc backend cannot freeze files")
        if self.done_when is not None:
            if not isinstance(self.done_when, str) or not self.done_when.strip():
                raise ValueError(f"task {self.id}: done_when must be a non-empty condition string")
            if self.backend != "api":
                # headless Claude Code runs its own loop to the end; there is no stop boundary here to check at
                raise ValueError(f"task {self.id}: done_when needs the api backend (the cc backend has no stop boundary hswarm sees)")
        self.done_when_max_blocks = max(0, int(self.done_when_max_blocks))
        if self.scripted:
            self._validate_scripted()

    def _validate_scripted(self) -> None:
        """A scripted task must be able to change its folder, and its output contract is the script, nothing else."""
        if self.schema not in (None, SCRIPT_SCHEMA):
            raise ValueError(f"task {self.id}: a scripted task returns its script as the result, so it takes no schema of its own")
        # Both backends: cc's read/none/edit presets disallow Bash too (cc._command), so the same check holds for cc.
        names = PRESETS.get(self.tools, self.tools.split(",")) if isinstance(self.tools, str) else self.tools
        if "bash" not in [n.strip().lower() for n in names]:
            raise ValueError(f"task {self.id}: a scripted task runs its script with bash, so it needs tools 'all' (or a list with bash)")
        if not (Path(self.cwd) / ".git").exists() and not any((p / ".git").exists() for p in Path(self.cwd).parents):
            raise ValueError(f"task {self.id}: a scripted task is verified by a git replay, so cwd {self.cwd} must be inside a git checkout")

    def _normalised(self) -> "Task":
        if self.reasoning_effort is not None and self.reasoning_effort not in EFFORTS:
            raise ValueError(f"task {self.id}: reasoning_effort must be one of {EFFORTS}")
        self._check_backend()
        self._validate()
        self._apply_capability()
        self._resolve_backend()
        # A review role (judge, refute, doubt) is a model AND a written evidence bar; both backends read .system.
        self.system = review.with_contract(self.role, self.system)
        self._review()
        if self.scope and not self.prompt.startswith(SCOPE_OPEN):
            self.prompt = scope_header(self.scope) + "\n\n" + self.prompt
        if self.scope and self.schema is not None:
            self.schema = self._schema_with_scope()
        if (self.backend == "api" and not self.profile and self.reasoning_effort is None and self.thinking is None
                and not config.MODELS.get(self.model, {}).get("benchmark_slug")):
            # Measured 2026-09-15: at DeepSeek's default (thinking on, effort high) a flash worker on a
            # cross-reference task spent 80k reasoning tokens over 13 turns, returned nothing, and cost
            # 50x its siblings. Low effort keeps the tool loop moving; raise it per task when needed.
            self.reasoning_effort = "low"
        if self.scripted:
            self.schema = SCRIPT_SCHEMA
            if SCRIPTED_CLAUSE not in (self.system or ""):
                self.system = f"{self.system.strip()}\n\n{SCRIPTED_CLAUSE}" if self.system else SCRIPTED_CLAUSE
        return self

    def _schema_with_scope(self) -> dict:
        """A copy of the caller's schema with a required `scope` string. WHY: a schema worker's answer is its submitted
        data, and submit_result is checked against the whole schema, so without a `scope` slot (or under
        additionalProperties:false) a correct worker could never echo the mark and every result would read mis_scoped."""
        if self.schema.get("type", "object") != "object":
            raise ValueError(f"task {self.id}: scope needs an object schema to carry its echo mark in a `scope` field; "
                             f"got type {self.schema.get('type')!r} - drop scope or wrap the schema in an object")
        props = dict(self.schema.get("properties") or {})
        props.setdefault("scope", {"type": "string", "description": "the scope mark from the <scope> block"})
        required = list(self.schema.get("required") or [])
        return {**self.schema, "type": "object", "properties": props, "required": required + ([] if "scope" in required else ["scope"])}

    def as_dict(self) -> dict:
        return dataclasses.asdict(self)


# Sticky taint letters (the Linux kernel's taint-flag idea, written fresh): one letter per reason a result's
# provenance is suspect, set once and never cleared, so an orchestrator reading results as data can filter or
# re-verify the doubtful ones without opening a transcript. A clean result has an empty string. Letters print in
# this order. A request the client re-sent on another key (a 429 rotation) is not a taint: the reply that came
# back is still one ordinary reply.
TAINTS = {
    "F": "failed over: a route leg could not serve and a later leg answered",
    "R": "re-run: an empty reply was re-prompted, a cc run started over from its prompt on another key after its key ran "
         "dry mid-run (one that resumed the dead run's own session is not), or a verify retry replaced an attempt that "
         "failed its check",
    "S": "schema repaired: a submit_result was rejected and resubmitted, or a cc reply's JSON was dug out of prose around it",
    "T": "truncated: a reply stopped at its output-token limit (finish_reason length)",
    "B": "turn budget: the turns ran out and the answer was forced with no tools",
    "C": "cap hit: the per-task cost or context ceiling stopped the worker",
}


def merge_taint(*parts: str) -> str:
    """The union of taint strings, in TAINTS order. An unknown letter is a bug in the caller, raised by name."""
    have = set("".join(parts))
    if unknown := have - set(TAINTS):
        raise ValueError(f"unknown taint letter(s) {sorted(unknown)}; known: {''.join(TAINTS)}")
    return "".join(c for c in TAINTS if c in have)


@dataclass
class Result:
    id: str
    status: str = "pending"  # ok | error | timeout | loop | cancelled | pending | running
    backend: str = "api"
    model: str = config.DEFAULT_MODEL
    answer: str = ""
    data: Any = None
    usage: dict = field(default_factory=lambda: {"in_hit": 0, "in_miss": 0, "out": 0, "reasoning": 0})
    cost_usd: float | None = 0.0
    seconds: float = 0.0
    turns: int = 0
    tool_calls: int = 0
    # Tool calls the model wrote as TEXT that the api loop promoted to real calls (toolcall_repair.py); a non-zero
    # count says the model is a weak tool-caller even when the task came back ok.
    repaired_calls: int = 0
    # Which upstream actually served the call. OpenRouter fronts many hosts per model at different
    # quantisations, so "the model" is not enough to know what answered; empty for a direct provider.
    upstream: list[str] = field(default_factory=list)
    api_seconds: float = 0.0  # time inside the provider call(s) only, excluding local tool work
    rested_s: float = 0.0  # of `seconds`, the part its calls sat rate-limited (client.RATE_WAIT): waiting, not work
    failover: list[str] = field(default_factory=list)  # route legs that could not serve before the one that did
    redactions: dict = field(default_factory=dict)  # detector -> spans redacted from tool output (redaction.py); {} when off
    selection: dict = field(default_factory=dict)  # published evidence, profile, actual effort and attempted routes
    loop: str | None = None  # the loopguard detector that ended an api task as status `loop` (no_progress, ping_pong, global)
    loop_warnings: int = 0  # loopguard reminders the worker was shown, whether or not it recovered
    files_changed: list[str] = field(default_factory=list)
    acceptance: list[dict] = field(default_factory=list)  # {criterion, verdict: holds|fails|UNVERIFIED, detail} per Task.acceptance
    # Changes a `propose`-preset worker queued instead of making (tools.t_propose); hswarm_apply_proposals screens and applies them.
    proposals: list[dict] = field(default_factory=list)
    plan: str | None = None  # a recipe task's cached plan: "hit: N calls", "miss" or "fallback: <the call that errored>"
    # Hosts read_url was asked for and did not fetch: {request_id, kind, host, url, severity}. Allow once by
    # re-running with the host in web_hosts, always with `hswarm web --allow HOST`.
    web_approvals: list[dict] = field(default_factory=list)
    # Only on a task that asked for verify: passed, attempts, the check's exit and output tail, the judge's verdict,
    # every attempt's history, and on a task that never passed an `escalation` record (verify.run_verified).
    verify: dict | None = None
    # The tool-receipt ledger (receipts.py): every sandbox call as r1..rN, the check of the answer's
    # [rN tool] citations against it, and the green-evidence verdict for a task that asked for one.
    receipts: list[dict] = field(default_factory=list)
    citations: dict | None = None
    green: dict | None = None
    # The job whose journal this answer was reused from (jobs.resumable), "" when this job ran it: a resumed
    # batch pays only for what changed, and the reused answer's transcript stays in that earlier job.
    cached_from: str = ""
    mis_scoped: bool = False  # the task carried a scope block and its answer did not echo the mark (spec.mis_scoped)
    # Set when the worker gave up and the task's `escalate` model re-ran it: who, why, which answer was kept, any skill banked.
    escalation: dict | None = None
    skills: list[str] = field(default_factory=list)  # banked skills handed to this worker (escalation.apply_skills)
    # The done_when check's last word when the task set one: {verdict ok|block|impossible|unchecked, reason, checks, blocks}.
    goal: dict | None = None
    # Whether an answered task moved the work (worker.classify_liveness): advanced | planning_only |
    # blocked_external | approval_required | failed, empty until it finishes; next_action is the task's own
    # stated next step or blocker, so a caller can send one bounded continuation or hand it to a human.
    liveness: str = ""
    next_action: str = ""
    error: str | None = None
    started: str = ""
    # When the last model reply was booked onto this task (agent._account_turn), "" before the first. A running task
    # whose stamp stops moving is stalled, not slow; status lists it under `quiet_running` (job.quiet_running).
    progress_at: str = ""
    finished: str = ""
    taint: str = ""  # sticky letters from TAINTS; only add_taint writes it, and it never removes one

    def add_taint(self, *letters: str) -> None:
        self.taint = merge_taint(self.taint, *letters)

    def as_dict(self, max_answer_chars: int | None = None, brief: bool = False, include_selection: bool = False) -> dict:
        d = dataclasses.asdict(self)
        if brief:
            return brief_row(d, max_answer_chars, include_selection)
        _cap_answer(d, max_answer_chars)
        return d


def _cap_answer(d: dict, max_answer_chars: int | None) -> None:
    answer = d.get("answer") or ""
    if max_answer_chars and len(answer) > max_answer_chars:
        d["answer"] = answer[:max_answer_chars] + f"\n... [{len(answer) - max_answer_chars} more chars; fetch with hswarm_results]"
        d["answer_truncated"] = True


def brief_row(d: dict, max_answer_chars: int | None = None, include_selection: bool = False) -> dict:
    """A result row as an MCP answer carries it (a live Result's dict or a record's row); results.jsonl and job.json
    keep every field. Measured over the last 300 jobs: a schema answer repeated in `answer` was 32.6% of
    hswarm_results bytes, and empty fields, timestamps and usage 7.6%.
    - `answer` goes only when it is exactly the JSON text of `data`: 77 of 2,319 rows carried prose beside their data.
    - `data` is capped like `answer`: a 200-char request returned 360 KB on job 20261001-032232-58a9 and spilled to a file.
    - None, "", [] and {} go, with started, progress_at and usage. A number stays: cost_usd 0.0 is free, a missing
      one is unknown; a missing `taint` is clean."""
    if d.get("data") is not None and d.get("answer"):
        try:
            if json.loads(d["answer"]) == d["data"]:
                d["answer"] = ""
        except ValueError:
            pass  # prose beside the data: both stay
    _cap_answer(d, max_answer_chars)
    if max_answer_chars and d.get("data") is not None:
        text = json.dumps(d["data"], ensure_ascii=False, default=str)
        if len(text) > max_answer_chars:
            # Cut as text and said so, never silently: the hint is the call that returns the whole of it.
            d["data"] = text[:max_answer_chars] + (f"\n... [{len(text) - max_answer_chars} more chars; fetch with "
                                                   f"hswarm_results(ids=[{d.get('id')!r}], max_answer_chars={len(text)})]")
            d["data_truncated"] = len(text)
    if not include_selection:
        d["selection"] = brief_selection(d.get("selection"), d.get("error"))
    # A parsed `data` that is itself empty ([] for "no findings") is an answer, not an empty field.
    return {k: v for k, v in d.items() if k not in ("started", "progress_at", "usage")
            and not (v is None or v == "" or (k != "data" and (v == [] or v == {})))}


def brief_selection(selection: dict | None, error: str | None = None) -> dict | None:
    """AUTO's record as the orchestrator reads it on every task of a batch: nothing on a row its first leg served
    (`model` already names it), and on a failed or failed-over row the legs that failed with their errors. A rescue
    leg's `below_floor` and its verify-it warning stay, and so does why a pin was dropped. The rest (requirements,
    ~40 rejected models, candidates, three fixed warnings) was the same ~2.9 KB on every row AUTO routed, 22% of
    hswarm_results bytes over 284 jobs; results.jsonl, the job file, hswarm_select and include_selection keep it,
    and a NoCapableSwarmRoute result keeps it too, since there it IS the answer."""
    if not isinstance(selection, dict) or (error or "").startswith("NoCapableSwarmRoute"):
        return selection
    # `route`: which route the task took and why (climayte_route.py), kept on every row that carries one.
    out = {k: selection[k] for k in ("below_floor", "unpinned_from", "pinned_error", "route") if selection.get(k)}
    if "below_floor" in out and selection.get("warnings"):
        out["warnings"] = selection["warnings"][:1]  # dispatch puts the below-floor sentence first
    attempts = selection.get("attempts")
    failed = [{"model": a.get("model"), "error": a["error"]} for a in attempts if isinstance(a, dict) and a.get("error")] if isinstance(attempts, list) else []
    if failed:
        out["attempts"] = failed
    return out or None
