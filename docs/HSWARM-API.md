# HSwarm API

HSwarm (the `hswarm/` package in this repo) hands cheap, wide work to other models. Chats reach it through MCP
(`hswarm_run`, `hswarm_ask` and the other `hswarm_*` tools). Scripts reach it through the HTTP API below. This file
is the full reference for both. The `hswarm_run` tool description carries only what every call needs, and points
here for the rest.

Paths below use `~/.hswarm`. `HSWARM_HOME` moves that folder.

## HTTP API

The console at `http://127.0.0.1:7793/ui` is a page over this API. Anything it does, a script can do.

- Base: `http://127.0.0.1:7793/api/`. This is the shared server. `hswarm serve-ensure` or `hswarm ui` starts it.
  `HSWARM_PORT` changes the port.
- Every call sends `X-Hswarm-Token: <contents of ~/.hswarm/console-token>`. A missing or wrong token gets 401.
- The Host header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. Anything else gets 403.
- GET takes query parameters. POST takes a JSON object body and nothing in the URL: a POST with a query string gets
  400, because URLs land in logs. Names (providers, models, fingerprints) always go in the body or the query, never
  the path. A body over 1 MB gets 413.
- Errors come back as `{"error": "..."}`. 400 means the request cannot be done as asked; the message says what to
  do instead. 404 is an unknown route, and lists every route. 500 names the file and line that raised.

By default `/ui` opens without a login for any request from this machine, and the page carries the token. With
`HSWARM_UI_SIGN_IN=1` set where the server starts, `hswarm ui` signs the browser in once through `/ui?t=<token>`.
That sets an HttpOnly session cookie and redirects to `/ui`. Without the cookie, `/ui` then answers 401 and carries
no token.

```bash
TOKEN=$(cat ~/.hswarm/console-token)
curl -s -H "X-Hswarm-Token: $TOKEN" http://127.0.0.1:7793/api/state
```

### Settings

Every settings change returns the full `state` afterwards, except three key routes. `keys/add` returns
`{fingerprint, added, masked, file}`. `keys/remove` returns `{fingerprint, removed}`. `keys/enabled` returns
`{fingerprint, enabled}`. Read `state` or `keys` after them.

| method | route | body / query | does |
|---|---|---|---|
| GET | `state` | | providers, models, priority, roles, options, file locations. No network call, no key |
| GET | `keys` | `provider` | that provider's keys in the order the pool uses them: fingerprint, masked form, source, state, priority, editable |
| POST | `keys/add` | `provider`, `key` | add a key to `~/.hswarm/providers/<provider>.toml` |
| POST | `keys/remove` | `provider`, `fingerprint` | delete a key from that file. Keys from the environment or the secrets folder are refused |
| POST | `keys/priority` | `provider`, `fingerprint`, `priority` | a key's priority number. 1 is used first, keys that share a number take turns, keys with none come last. Empty clears it |
| POST | `keys/enabled` | `provider`, `fingerprint`, `enabled` | move a key out of or into the disabled slot |
| POST | `keys/probe` | `provider` (optional) | one free balance read per key. A topped-up key leaves the disabled slot |
| POST | `keys/check` | `provider`, `fingerprint` | one free request with that key alone. `result` is `ok`, `rejected` (the key goes to the disabled slot with the reason) or `unchecked` |
| POST | `providers/set` | `name`, and `enabled`, `base_url` and/or `website` | change a provider. `website` is the company's site; the console shows its icon |
| POST | `providers/add` | `name`, `base_url`, optional `docs`, `anthropic_url`, `website` | add an OpenAI-compatible provider |
| POST | `providers/remove` | `name` | remove a provider you added: its file, its models and the keys in it |
| POST | `favicons/fetch` | optional `providers` (a list of names) | fetch the providers' icons. By default, every provider whose icon was never fetched |
| POST | `models/enabled` | `name`, `enabled` | switch a model on or off |
| POST | `models/add` | `name`, `provider`, optional `api_id`, `ctx`, `price` `{hit, miss, out}` (USD per 1M), `vision`, `tools` | add a model |
| POST | `models/remove` | `name` | remove a model you added |
| POST | `models/priority` | `name`, `priority` | star a model with a priority number. AUTO tries numbered models first, among those that meet the bar. Empty clears it |
| POST | `roles` | `role`, `model` (`auto` or a name) | point a role at a model |
| POST | `options` | `routing` (bool), `load_bias` (0-5), `daily_cap_usd` (dollars, `""` clears) | price routing between equal paths; how hard AUTO spreads load; the most one local day may spend |

### Key vault

The vault keeps this machine's key lists encrypted on a server only you can reach, and in step on every paired
machine (`hswarm vault`; the module header of `hswarm/vault.py` explains how). These routes answer with counts,
names and fingerprints. They never return a key or the pairing code.

| method | route | body / query | does |
|---|---|---|---|
| GET | `vault/status` | | `mode` (`folder` or `vault`), the local lists and their counts, and the backend, last sync and pending requests when a vault is set up |
| GET | `vault/requests` | | the machines waiting to be granted |
| POST | `vault/init` | `kind` `ssh` (`host`, optional `user`, `port`, `folder`) or `dir` (`path`), or a ready `backend` URL | make a vault on this machine, then sync once |
| POST | `vault/join` | `code` | join the vault a pairing code names. Keeps this machine's keys, adds the others, removes nothing |
| POST | `vault/request` | the same backend fields as `init` | ask that vault for its pairing code |
| POST | `vault/accept` | | open this machine's grant and join. `granted: false` with a message while no grant is there |
| POST | `vault/grant` | `machine`, `fingerprint` (the FULL fingerprint) | seal the pairing code to one waiting request |
| POST | `vault/sync` | | one sync round |
| POST | `vault/adopt` | | pair with the vault a ZSwarm on this machine already holds |
| POST | `vault/leave` | `confirm: true` | stop using the vault here. The key lists in the secrets folder stay |

### Work

| method | route | body / query | does |
|---|---|---|---|
| POST | `run` | `tasks`, `cwd`, `tools`, `model`, `role`, `backend`, `system`, `max_turns`, `schema`, `timeout_s`, `concurrency`, `budget_usd`, `label`, `wait`, `wait_s`, `thinking`, `reasoning_effort`, `max_cost_usd`, `profile`, `max_answer_chars`, `unbatched` | start a batch through `hswarm_run`. Only these top-level keys pass; set any other option per task, inside `tasks`. With `wait: false` it returns the job id at once |
| GET | `jobs` | `limit` (default 20) | recent jobs |
| GET | `job` | `id`, optional `max_answer_chars` (default 4000) | `{status, results}` of one job |
| POST | `job/cancel` | `id` | cancel a running job |
| POST | `ask` | `prompt`, `system`, `model`, `schema`, `thinking`, `reasoning_effort`, `max_tokens`, `role`, `profile`, `exclude_models` | one tool-free call through `hswarm_ask` |
| POST | `models/test` | `model` | a one-word paid call on exactly that model, to check a key and a model |
| POST | `select` | `profile`, `tools`, `backend` | the full plan AUTO would run now (`hswarm_select` with `verbose`). No model call |
| GET | `doctor` | | the same report as `hswarm doctor` |
| GET | `usage` | `days` (1-90, default 14) | spend, tasks and outcomes per local day, newest last, for the console's charts |
| GET | `model-stats` | `days` (default 14) | per model: thumbs up/down, cost per successful task, edit survival, daily volume |
| GET | `stats` | `days` (1-90, default 30) | the utilization totals the console's overview shows: per machine, per plan, per Claude family, recent |

### Clients

| method | route | body | does |
|---|---|---|---|
| GET | `clients` | | Claude Code, Claude Desktop and Codex: config path, and whether hswarm is registered |
| POST | `clients/install` | `client` (`claude-code`, `claude-desktop` or `codex`), optional `remove`, `instructions` | register (or unregister) hswarm with that client |

## hswarm_run options

The `hswarm_run` tool description points here. It is in every chat's context on every turn, so it carries only what
every call needs. Each option below is a top-level argument that sets every task's default, a task key, or both.
"Per task" means a task key only. "Job-wide" means a top-level argument only.

An argument `hswarm_run` does not take is refused with the nearest valid name, and nothing runs. A task key it does
not know is refused the same way.

### Task keys

`prompt`, `id`, `cwd`, `tools`, `model`, `role`, `backend`, `system`, `max_turns`, `max_tokens`, `max_context`,
`schema`, `files`, `roots`, `timeout_s`, `thinking`, `reasoning_effort`, `temperature`, `max_cost_usd`,
`checkpoint_at`, `lean`, `profile`, `min_scores`, `exclude_models`, `route`, `result_file`, `confirm_write`,
`isolated`, `recipe`, `shell_grants`, `capability`, `web_hosts`, `verify`, `acceptance`, `green`, `context_trigger`,
`context_clear_at_least`, `inventory`, `scope`, `escalate`, `writable`, `done_when`, `done_when_max_blocks`,
`scripted`, `redact`, `purpose`, `zdr`, `runtime`.

`envelope` is job-wide only: a task that names it is refused. `unpinned_from` is set by hswarm, never by a caller.

### Job-wide arguments

| argument | what it does |
|---|---|
| `tasks` | prompt strings, or `{prompt, id?, ...}` objects carrying any task key |
| `concurrency` | how many tasks of this job run at once. Unset, the job shares the server's default |
| `budget_usd` | caps the WHOLE job. Once crossed, what is still pending is cancelled. Unset, the job has no ceiling |
| `label` | a name for the job in `hswarm_jobs`, the ledger and the console |
| `wait`, `wait_s` | `wait: true` (default) returns what finished within `wait_s`, at most 240 s: an MCP client drops a call that is silent for about 300 s. The job runs on; read it with `hswarm_status` / `hswarm_results`. `wait: false` returns the job id at once |
| `max_answer_chars` | cuts each answer in this reply (default 4000). `hswarm_results` returns them whole |
| `unbatched` | 8 or more small tool-free tasks of one shape are refused with the packing recipe. `true` sends them anyway. `purpose: "evaluation"` jobs are never refused |
| `resume_from_job` | an earlier job id. Every task whose content (prompt, system, cwd, backend, model, tools, schema, the files' contents, roots, thinking, reasoning_effort, temperature, runtime) matches one that finished ok there reuses that answer at no cost. `result.cached_from` names the job; `summary.cached` counts them. Only changed, failed or unfinished tasks run |
| `envelope` | caps the whole SPAWN TREE this job roots: `{max_depth?, tools?, spend_usd?, max_nodes?, deadline_s?}`. Defaults: `max_depth` 2, `max_nodes` 32, all tools, no spend ceiling, no deadline. cc workers hand it on, and a job a worker starts can only narrow it. Past depth, nodes, spend or deadline, the job is refused with the reason. `spend_usd` and `max_nodes` count the whole tree |

### The basics

| option | what it does |
|---|---|
| `cwd` | an ABSOLUTE folder. The worker's tools see nothing outside it (plus `roots`). The shared server serves every chat, so it cannot guess yours: there, a task with tools or files and no cwd (and no `X-Hswarm-Cwd` header) is refused |
| `roots` | more folders the tools may read, beside cwd |
| `files` | files inlined into the prompt (relative paths resolve under cwd). Each must exist at submit, or the task is refused |
| `tools` | `read` (default) \| `edit` \| `all` \| `jobs` \| `web` \| `none` \| `propose`, or a comma list of tool names: `read_file`, `list_dir`, `glob`, `grep`, `outline`, `unfold`, `write_file`, `edit_file`, `bash`, `read_url`, `web_search`, `propose`, `bash_start`, `job_wait`, `job_tail`, `job_input`, `job_kill`. `edit` = read + write files. `all` = edit + a shell. `jobs` = `all` plus background shell jobs, for builds and servers. `propose` = the read tools plus a `propose` tool that QUEUES file changes instead of making them (api backend only); `hswarm_apply_proposals` screens the queue and writes only what passes. Use it for work over untrusted input. `read` has no web access. An unknown tool name is refused |
| `web_hosts` | `web` = read plus `web_search` and `read_url`. `web_search` finds pages: up to 5 results (max 8), each a title, URL and a snippet of at most 300 characters, from Tavily on the owner's keys (Jina when Tavily is down or keyless; `HSWARM_WEB_SEARCH=jina,tavily` reorders). Only the query leaves the machine; a provider on the admin block list is not asked, a result on a blocked or private host is dropped, and a result outside `web_hosts` is marked `[outside web_hosts]`. For open research across unknown sites give `web_hosts: ["*"]`, so every public result can be read. `read_url` is a GET-only page read routed by host: HTML as markdown, a feed one line per entry, YouTube subtitles, a GitHub file raw. api backend only. It fetches only hosts in `web_hosts` (`"example.com"` covers its subdomains, `"*"` any public host) or allowed for good with `hswarm_web`. Any other host is NOT fetched and comes back in `summary.web_approvals` (`request_id`, `host`, `severity`, `tasks`). Re-run with the host in `web_hosts` to allow it once, call `hswarm_web(allow=[host])` to allow it always, or leave it out to deny. The admin block list beats both |
| `schema` | a JSON schema whenever the answer is data. The worker must call `submit_result` with it, and the parsed object comes back in `data`. The WHOLE schema is enforced (nested `required`, `minItems`, types), so say `minItems` / `minProperties` where an empty answer is wrong. On the api backend the root must be an object. A schema that is not valid JSON Schema, or that no answer can meet (`minItems` above `maxItems`, a required key `additionalProperties: false` forbids), is refused before any paid call. An all-empty payload is pushed back once. A leg that keeps breaking the schema fails over (`InvalidStructuredAnswer`) |
| `system` | a system prompt for the worker |
| `timeout_s` | RUN time per task, default 600. A task queued at a busy provider's gate spends none of it |
| `max_turns` | default 24 on api, 40 on cc (a cc worker pays the repo's CLAUDE.md and rules first). The TASK's, however many keys or legs serve it: when one dies (a spent key, a leg that cannot serve), the next runs on the turns left. A cc run counts the model calls it made, not Claude Code's `num_turns`, which also counts the call a 402 or the turn cap cut off |
| `max_tokens`, `max_context` | the output-token limit per reply (default 16,000) and the context limit (default 400,000) |

### Model and route

| option | what it does |
|---|---|
| `model`, `profile` | `auto` (default) picks the cheapest available evaluated model that meets the profile's published score floors. Profiles: `routine` (tool-free only), `general`, `code`, `decision`, `research`, `critical`; the role and the tools supply the default. When credits, quota or an endpoint run out, AUTO moves on through capable configurations, stronger models included, inside the task's own budget; the exact effort and finished tool results are kept. A model name pins that model. `hswarm_select` previews the route |
| `min_scores`, `exclude_models` | raise a profile's score floors for this task; leave models out of AUTO's choice |
| `route` | `true` (default) lets price routing take another provider that serves the same model. `false` pins the model exactly as named (the A/B harness uses it) |
| `role` | `default` \| `search` \| `code` \| `judge` \| `grader` \| `summarize` \| `review` \| `vision` \| `refute` \| `doubt`, resolved to whatever model this machine wires for it (it fails loudly when none). `review` also brings a written rubric (problem/solution/ownership evidence, scope drift, test padding, rerun stability) and, when no schema is given, a verdict+findings schema. Pair it with `inventory` for a coverage receipt. `judge`, `refute` and `doubt` carry their own evidence bar |
| `reasoning_effort`, `thinking` | `low` \| `medium` \| `high` \| `xhigh` \| `max`. AUTO keeps the evaluated setting; an explicit one filters the evidence. A pinned api model with no published evidence and no effort or thinking set runs at `low` |
| `temperature` | the sampling temperature, where the provider takes one |
| `purpose` | `production` (default) \| `evaluation`: what this task's ANSWER is for. `production` means it ships, or feeds work that ships. `evaluation` means it is only measured (a benchmark, an eval, a probe). A provider whose own terms allow evaluation only (NVIDIA's free trial keys, which may also train on what they are sent) serves an evaluation task and nothing else, and is still served there before every paid route. Naming such a model on a production task is refused. Leave it unset for real work: the plan's `rejected` names each route skipped with filter `purpose` |
| `zdr` | zero data retention. Only OpenRouter models on OpenRouter's zero-data-retention list may serve the task, and every request carries `provider: {"zdr": true}` (merged into any provider pin the model already has). It fails CLOSED: if the list was never read or cannot be parsed, nothing is cleared and the task is refused with the reason, before anything is sent. OpenRouter's automatic router (`openrouter/auto`) is never cleared. A model served by any other provider is refused, so is the native Anthropic transport, and so is backend `cc`. Under AUTO, models off the list show in the plan's `rejected` with filter `zdr`; if none is left, the task is refused with `NoCapableSwarmRoute` and the zdr reason. Refresh the list with `hswarm models --refresh openrouter` (or `hswarm_models(refresh="openrouter")`): it saves `~/.hswarm/openrouter-zdr.json` with its time. A failed refresh keeps the last good list. `hswarm run --zdr` sets it for every task |

### Cost

| option | what it does |
|---|---|
| `max_cost_usd` | caps ONE worker, and a capped task dies with its work: set it for long code or research tasks. Defaults: $0.25; with tools, `code` $1 and `research` $1.50; `critical` $2. A task shape that routinely spent more gets a higher default. Must be above 0 |
| `budget_usd` | job-wide; see above |
| `checkpoint_at` | a share of `max_cost_usd` (or of the job's `budget_usd`), default 0.8. At it the worker is asked once to finish and hand back a partial result. 0 turns it off |

### Backend

| option | what it does |
|---|---|
| `backend` | `api` (default) = the sandboxed tool loop. `cc` = headless Claude Code; its model must be on a provider with an Anthropic-compatible endpoint. On cc, `read` / `none` (and any list without a write tool) run on an allowlist (Read, Grep, Glob) that denies every other tool. `edit` / `all` bypass permissions and take BOTH opt-ins, the preset AND `confirm_write: true`, or the task is refused. cc refuses `web`, `propose`, `capability`, `writable`, `shell_grants`, `redact`, `recipe`, `escalate`, `done_when` and `zdr`: each needs the api sandbox |
| `confirm_write` | cc only: the second opt-in for `edit` / `all` |
| `lean`, `isolated` | cc only. `lean` skips the task folder's own CLAUDE.md, `.claude/rules`, hooks and settings (`--setting-sources user`): about 40% less context per turn on a big repo. Use it for fully specified edits that need no house rules. `isolated` is `lean` plus `--strict-mcp-config`: no MCP server either, not even the task folder's `.mcp.json`. Setting both is the same as `isolated` |
| `result_file` | per task, cc only: the ONE file the worker may write. Hooks deny every other write, hand schema errors back after each write, and block the first stop until the file validates. The parsed file comes back in `data` |
| `runtime` | per task: where an api task's tools run. `host` (default) \| `docker-container:<id>` \| `podman-container:<id>` (a RUNNING container) \| `ssh:<target>` (BatchMode). Off the host, cwd and roots are absolute POSIX paths there, and every command runs under `timeout`. Options that read or run on this host (`files`, `scripted`, `result_file`, `verify`, `inventory`, `acceptance`, `propose`, backend cc) are refused with it |

### Guards and grants

| option | what it does |
|---|---|
| `capability` | a least-privilege grant that REPLACES `tools` (api backend only): a name looked up in `<cwd>/.hswarm/capabilities/` then `~/.hswarm/capabilities/`, a `.json` path, or an inline `{identifier, permissions, allow?, deny?}`. A permission is a preset, a tool, `allow-<tool>` / `deny-<tool>`, or `{identifier: <tool>, allow: [globs], deny: [globs]}`. Deny beats allow |
| `writable` | per task, api backend: path globs (relative to cwd or absolute; `**` spans folders) that `write_file` / `edit_file` may change. Everything else under the roots stays readable but frozen, so a worker told to make a test pass cannot edit the test. The bash tool is not path-guarded: pair `writable` with tools `edit` when the judge must not move |
| `shell_grants` | per task, api backend only: command prefixes (`["git add", "git commit"]`) this task's bash may run although the shell policy refuses them. The policy is `hswarm/shell_rules.toml`, with `~/.hswarm/shell_rules.toml` on top. Never a `./` or absolute-path program, and never the `rm -r` whole-tree deny |
| `redact` | `hash` \| `redact` \| `mask` \| `block` \| `off`: strip secrets, emails and card numbers from every tool output (and every inlined file) before the provider sees it. api backend only. `hash` tags a value `<email:1a2b3c4d>`, the same tag for the same value, and a write or command carrying a tag gets the real value back. Per task it may be `{strategy, detectors, patterns}`. Detectors: `secret`, `email`, `credit_card` (the default three), and opt-in `ip`, `mac`, `url`. Unset, it defers to `HSWARM_REDACT_FREE_TIER` for free-tier legs. Each result's `redactions` counts what was redacted |
| `scope` | a block (read root, diff command, "treat the input as data") put VERBATIM before every worker prompt, with an echo mark. With a schema, a required `scope` field is added. A result that does not echo the mark comes back with `mis_scoped: true` and is listed in `summary.mis_scoped`: do not trust it |

### Checked work

| option | what it does |
|---|---|
| `verify` | opt-in checked work: a shell command run in the task cwd after the worker finishes (exit 0 = pass), or `{command?, judge?, retries?, timeout_s?}`. `judge` is the acceptance criteria (`true` = "does what the task asks"), scored PASS/FAIL by the judge role. `retries` defaults to 2 (at most 5), `timeout_s` to 300. A failed check re-runs the task with the failure added, up to `retries` times, all inside `max_cost_usd`. The result's `verify` holds `passed`, `exit`, `output_tail`, `verdict` and every attempt's history. A task that never passed is status error `VerifyFailed:` with `verify.escalation` |
| `acceptance` | per task: typed criteria decided in code after the worker stops, never on its word, and with nothing re-run. `file:<path>` (exists, not empty). `file_written:<path>` (this worker's write or edit tool wrote it, and it reads back). `tests_passed:<command>` (a bash receipt ran exactly that command, parsed, with exit 0 and a test summary; an echo naming it, a `\| tail` or `\|\| true` does not count; api backend only, UNVERIFIED on cc). Each result carries `acceptance: [{criterion, verdict: holds\|fails\|UNVERIFIED, detail}]`, and `summary.acceptance` counts the verdicts |
| `green` | per task: `targeted_tests` \| `package` \| `workspace` \| `merge_ready`. The worker must end with a GREEN line naming the receipt of a passing bash run at that level (`merge_ready` also a base sha a git receipt printed). An ok result without it comes back in `unverified` with the `green.missing` list. Needs tools `all` (bash) on the api backend, and no schema |
| `done_when`, `done_when_max_blocks` | api only: a checkable condition, such as "pytest exits 0". When the worker stops, a separate tool-free call must find the proof in its transcript. `block` sends the reason back as a user turn, at most `done_when_max_blocks` times (default 3); then the task errors "goal not met". `impossible` errors at once. A failed evaluator keeps the answer. Each result's `goal` holds the last verdict (`ok` \| `block` \| `impossible` \| `unchecked`) and its reason |
| `inventory` | per task: the paths a review task must cover. Its result must carry `reviewed_paths` equal to them; hswarm adds the key to the schema and checks it. On the api backend each listed path that exists must also have been opened with `read_file`. Otherwise the task errors `IncompleteReview` instead of passing a partial review |
| `scripted` | scripted-diff mode for mechanical renames and sweeps. The worker (tools `all`, cwd inside a git checkout, one scripted task per checkout) makes the change with a bash script and submits the script. hswarm replays it under `set -euo pipefail` on a throwaway worktree of the starting tree, and returns ok only when the replay gives exactly the worker's tree (else error `ScriptMismatch`). `data` = `{script, summary, replay}`: review the script, not the diff. It takes no schema of its own |

### Long runs and retries

| option | what it does |
|---|---|
| `context_trigger`, `context_clear_at_least` | per task. `context_trigger` defaults to 60,000 tokens; 0 turns it off. Past it, an api worker's older tool results (all but the last 3) go out as `fetch_output` pointers, at least `context_clear_at_least` (default 20,000) tokens a pass. A capped tool output keeps its head and tail, and names the `fetch_output` call that returns the middle. Every worker with a sandbox tool gets `fetch_output` |
| `escalate` | OFF by default. A stronger model (api backend) to re-run a task on ONCE when its worker gives up: FAILED, an empty or "could you clarify" / "I don't have a tool" reply, a run of tool errors. Never for a leg that could not serve. The failed trace goes to it as untrusted data. Its answer is kept only if it does not give up too, and then a skill is saved under `~/.hswarm/skills/`, handed to later escalate-enabled tasks of that kind. `escalation` on the result says what happened; both runs' spend is on it. It must name a different model from the task's own |
| `recipe` | a name for a job you run again and again on new input (api backend). The read-only tool calls of its last passing run are replayed first, so the model answers instead of planning them again. Any replayed call that errors drops the replay. Keyed on (recipe, input shape, hswarm version); the prompt is never cached. `result.plan` says `hit` \| `miss` \| `fallback` |

Retries hswarm makes on its own, with no option to set:

- **An empty reply** is not kept. The worker is nudged and asked again, up to 2 times per task, and the result gets
  taint `R`. On OpenRouter the retry goes ROUND the upstream host that served the empty reply: that host is added
  to the request's `provider.ignore`, so the same model answers from another host. A model whose provider entry pins
  its hosts (`extra.provider.only` or `order`) has nowhere else to go, so its retry stays on the same route.
- **A leg that cannot serve** (no credit, quota, an endpoint down) fails over to the next capable leg, and the
  result gets taint `F` and lists the leg in `failover`.

## What comes back

- `route_outlook` (first response) names a profile left with one provider, a resting pool, or a width past that
  provider's live-call cap.
- `server_behind` says this server runs older code than is on disk: a fix that landed since it started is not
  running. The full sentence comes once per chat, then `true`. `hswarm_doctor` always has it.
- `summary.savings` is the estimated cost of the same work as Claude sub-agents on the calling session's model, and
  the saving.
- `unverified` lists the ok tasks whose "done" is not backed. Check those first.
- Each result's `liveness` says whether it moved the work: `advanced` \| `planning_only` (replied with a plan, not a
  result) \| `blocked_external` (credentials or access) \| `approval_required` (asked for a yes) \| `failed`.
  `next_action` is its own stated next step or blocker, and `summary.not_advanced` lists those ids per label. The
  label is a text heuristic, not a grade: check or continue those tasks before counting them done.
- `taint` holds sticky letters saying why a result is doubted (none = clean): `F` failed over, `R` re-run or
  re-prompted, `S` schema repaired, `T` output truncated, `B` the turn budget forced the answer, `C` a cost or
  context cap stopped it.
- `citations` (api results) checks the answer's `[rN tool]` citations against the receipts of the tool calls it
  really made. `hswarm_results` documents the verdicts.
