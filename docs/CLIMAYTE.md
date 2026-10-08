# CliMayte: orchestrate work onto CLI accounts

CliMayte ("CLI orchestration") lets one chat hand a whole task to the owner's Claude Code CLI
accounts. The chat keeps only the orchestration: it splits the task, dispatches each piece, reads
the results and checks them. Every piece of real work runs as a Claude Code CLI session on one of
the CLI instances AgentHydra manages, spread across the accounts by headroom, and **moved to
another account automatically when one hits its usage limit** (a Pro account's 5-hour window
lasts about ten minutes of heavy work; before CliMayte a person moved the thread by hand each time).

Quick add is the other half: type an email, confirm in the browser, and that account is a CLI
instance CliMayte can use. No naming, no terminal, no `/login`.

## Owner rulings

- **2026-09-30, Michael:** "give you a task in a chat ... I want this fully delegated ... delegate
  every part of it, except for the absolute bare orchestration level ... orchestrating them only
  to CLI, not desktop instances ... a super fast way to log in to multiple CLI instances ... Ask
  for an email, I'll give it to you, then you open the login page, and then I confirm it."
- **No console windows, and no chat nobody can see** (2026-08-27 / 2026-08-31, `headless-policy.ts`,
  `session-launch.ts`). CliMayte satisfies both: a worker runs with no window (`windowsHide`), and every
  worker is readable live and steerable in AgentHydra (the CliMayte view, `climayte_status`), and its
  transcript is an ordinary Claude Code session in that account's folder that a person can resume
  by hand. CliMayte is the one named exemption from the headless ban; queue dispatch stays refused.
- **2026-10-02, Michael:** "the AI in general should know about CliMayte, being a viable option ...
  like how it knows Z Swarm is available ... it doesn't step on the toes of other accounts running
  ... the Agent Hydra client manager should handle all that stuff." CliMayte is a standing option
  for work that needs Claude quality HSwarm cannot give (AgentHydra's MCP instructions say so),
  and placement is AgentHydra's job: new work goes around an account someone else is using (see
  Placement). It runs nothing by itself: a chat, the CliMayte view, or HSwarm when AgentHydra's cost
  model picks the subscription for a tool-using task (see "Tasks that arrive from HSwarm") sends every task.
- **2026-10-03:** "when a worker hits a five-hour or weekly limit, CliMayte moves it to another
  account and resumes it, unless the limit resets in under five minutes; distribute the load." See
  "The five-minute rule" under Placement; it supersedes the 2026-10-01 pace cooldown where they clash.
- **2026-10-07:** Anthropic released Claude Haiku 5.5. The owner: never use Haiku 4.5, and things
  should start "attempting to offload there first ... it's really good and really cheap". Every kind
  now starts on Haiku 5.5 (see Scorecard), Haiku 4.5 names are refused, and every Claude Code process
  AgentHydra starts has its `haiku` alias pinned to Haiku 5.5 (see Model and thinking).

## Which route first

Free accounts, then CliMayte, then HSwarm's paid API (owner, 2026-10-07: "the free ones are actually free").

1. **Free accounts** take tool-free work at no cost. HSwarm tries them first when `route_via_free` is on and the
   task's profile is in `route_via_free_profiles`; no idle account or a bad reply moves on to the next step.
2. **CliMayte** takes tasks with tools on the subscription, or what free could not take, when the cost comparison
   (`docs/COST-MODEL.md`) puts the subscription side clearly cheaper (beyond `closeRatio`).
3. **The paid API** takes the rest. When the costs are close, only `routing_api_preference_pct` (default 20) of
   the calls go to the API, so that arm stays measured.

## Server: `server/src/climayte.ts`

### Records

```ts
export type CliMayteStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
// waiting = no eligible account right now (all at their limit or signed out); retried every tick
export type AttemptOutcome = 'running' | 'done' | 'quota' | 'transient' | 'auth' | 'error' | 'cancelled'

export interface CliMayteAccountRef { id: string; num: number | null; name: string }

export interface CliMayteAttempt {
  account: CliMayteAccountRef
  pid: number | null
  log: string            // absolute path of this attempt's stream-json stdout log
  errLog: string         // absolute path of its stderr log
  startedAt: number
  endedAt: number | null
  outcome: AttemptOutcome
  notice: string | null  // the limit/error notice, compacted (rate-limit-signal.compactNotice)
  resumed: boolean       // true when this attempt ran `--resume` (a follow-up or a handoff)
  requested?: { model: string | null; effort: string | null }  // what it was launched with
  model?: string         // the model the CLI reported in its system/init event: what really ran
}

export interface CliMayteWorker {
  id: string             // short id, e.g. 'w-' + 8 hex chars
  group: string          // caller-chosen or generated 'g-' + 6 hex; groups one orchestration
  title: string          // short label (caller's or the first 60 chars of the prompt)
  cwd: string
  prompt: string         // the task as given
  pending: string[]      // follow-up messages not yet delivered (FIFO)
  model: string | null       // full id (claude-opus-5-5 / claude-sonnet-5-5); null = the CLI's default
  effort: string | null      // low | medium | high | xhigh | max; null = the CLI's default
  accounts: string[] | null  // restrict to these CLI instance ids (null = every signed-in one)
  status: CliMayteStatus
  sessionId: string | null   // minted by CliMayte before the first launch (`--session-id`)
  accountId: string | null   // the account holding the session now
  attempts: CliMayteAttempt[]
  result: string | null      // the report: `results` joined, oldest turn first (RESULT_SEPARATOR)
  results?: string[]         // each turn's closing text for the current message, oldest first
                             // (MAX_RESULTS 12, MAX_RESULT_CHARS 20k each); reset when a new
                             // message or a fresh session starts
  error: string | null
  lastActivity: string | null // one line: the newest event summarised (see summarizeEvent)
  costUsd: number            // summed over every attempt's `result.total_cost_usd`
  turns: number              // summed `result.num_turns`
  moves: number              // how many times the session changed account
  retries: number            // transient retries used in the current turn
  notBefore: number | null   // epoch ms; a transient retry waits until then
  priority?: number          // higher starts first among queued/waiting work (dueOrder); absent = 0
  handoffNote?: string | null // a move found the transcript nowhere: the next message goes on from it
  createdAt: number
  updatedAt: number
}
```

Persisted with `core/json-store.ts` in two places (same read/mutate discipline as
`core/cli-instances.ts`): `<CONFIG_DIR>/corch/workers.json` (`{ workers: CliMayteWorker[] }`) holds
the work still in flight (queued, running, waiting, checking), and each finished worker (done,
failed, cancelled) is one file, `<CONFIG_DIR>/corch/done/<workerId>.json`, written when that worker
changes. A worker found in both is read from `workers.json` (a message revives a finished worker,
and its file goes once `workers.json` holds it). The first start on this layout files every
finished worker of the old single `workers.json`. Logs live in `<CONFIG_DIR>/corch/logs/`
as `<workerId>-<attemptIndex>.jsonl` and `.err.log`; a finished attempt's `.jsonl` is packed to
`.jsonl.zst` (zstd) a day after it ended, and every reader takes the plain file first, else the
packed one. The prompt of each attempt is written to
`<CONFIG_DIR>/corch/prompts/<workerId>-<attemptIndex>.txt` and fed to the CLI on **stdin**
(never argv: Windows' 32k command-line limit and quoting).

Account walls (an account that hit its limit or is signed out) are kept in memory and in
`<CONFIG_DIR>/corch/walls.json`: `{ [accountId]: { until: number, reason: string } }`.

### Launch (one attempt)

```
argv = [...claudeCommand(), '-p', '--output-format', 'stream-json', '--verbose',
        '--dangerously-skip-permissions',
        first attempt of the session ? ['--session-id', sessionId] : ['--resume', sessionId],
        model ? ['--model', model] : [], effort ? ['--effort', effort] : [],
        '--append-system-prompt', WORKER_BRIEF]
Bun.spawn(argv, { cwd, env, stdin: Bun.file(promptFile), stdout: <fd of log, append>,
                  stderr: <fd of errLog, append>, windowsHide: true })
```

- `claudeCommand()` = `[resolveClaudeExe()]` in production; tests replace it with
  `setCliMayteClaudeCommand(['bun', '<fake script>'])` (pass `null` to restore).
- `env` = `process.env` minus every key matching
  `/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(OAUTH_\w+|ENTRYPOINT|SSE_PORT|SESSION\w*)|CLAUDECODE|CLAUDE_CONFIG_DIR)$/`,
  plus `CLAUDE_CONFIG_DIR = account.configDir` and `AGENTHYDRA_CLIMAYTE_WORKER = worker.id`. The
  worker must bill its OWN login, never an inherited key or token.
- The CLI runs under a RUNNER, never as the daemon's own child (`509c3f7`, see "Runner and
  restarts" below): stdin/stdout/stderr are the attempt's prompt, log and error FILES, so nothing
  ties the CLI to the daemon, and a daemon restart leaves it running.
- The prompt of a first attempt is the task. A follow-up attempt's prompt is the next `pending`
  message. A handoff attempt's prompt is `HANDOFF_PROMPT`:
  "This session was moved to another account because the previous one reached its usage limit.
  Continue the task exactly where you left off. Do not redo steps that are already finished."
- `WORKER_BRIEF` (exported constant):
  "You are a CliMayte worker: a Claude Code CLI session AgentHydra started on one of the owner's
  accounts, at the owner's request, to do one task for an orchestrating chat. Do all of it
  yourself, in this session. Before your first tool call, write one line on its
  own, `ETA: <n> min`: your honest estimate of the working time the whole task will take you,
  checks included (write a new one for each later message you are sent, not when told to
  continue). The owner reads it to decide whether to wait, and AgentHydra compares it with the
  time it really took. Nobody watches live: make the reasonable call and say which you made. ...
  Only when blocked on a real decision ... call climayte_ask ... Follow the repository's rules:
  commit only the files you changed, and push if they say to. Never read or print a secret value. Do not deploy, publish or release unless the task
  says to ... End with a short report: what you did, the proof you saw (a command and what it
  printed), and anything left undone with the reason." The code holds the full text. Once there
  are 5 settled estimates the brief ends with the calibration note (see "Time estimates" below).

**What a worker starts with** (2026-10-02): its settings deny the agenthydra and magnific MCP
servers and set `syncClaudeAiSkills: false`, which hides the claude.ai-synced skills (docx, pptx,
computer-use and the rest) for that run only; its environment sets
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Both keys are in the CLI binary (2.1.286).

**A worker's MCP servers are the owner's** (2026-10-02): `--mcp-config <hooks>/<id>.mcp.json`
gives it the servers in the owner's own user scope ([`~/.claude.json`](CLAUDE-CONFIG-LAYOUT.md)), less the two denied, so
connections-local and hswarm are there whatever its account's `.claude.json` says. That copy is
seeded once, when the account is made, and drifts: one of 33 accounts listed no server at all. Only
an entry with no credential is carried: a URL and at most its `headersHelper`, the command that signs
in at connect time through this machine's own session (connections-local's `node <loader.mjs>
--connect`, hswarm's `python -m hswarm connect`); never static headers, oauth, env, a query
string, user info or a fragment, a token-shaped path segment or host label (`/s/<key>/mcp`), or a
helper that holds a header literal (`Bearer `, `Authorization`, an API key) or a token-shaped
word, so no credential is written to a worker's file. **A stdio server is carried too**
(2026-10-04: the owner's `connections` is stdio, and a chat worker on an account whose
`.claude.json` listed no servers had no Connections at all): its `command`, `args`, `env` and `cwd`,
unless an env key or a flag is named like a secret (`key`, `token`, `secret`, `passw`, `auth`,
`bearer`, `credential`, `cookie`, `private`), or the command, cwd, an env value or an argument holds a
well-known key prefix (`sk-`, `ghp_`, `github_pat_`, `xoxb-`, `glpat-`, `AKIA`, `eyJ`) or a
token-shaped word; such a server is left out whole, never carried stripped of its key.
`CONNECTIONS_ELICITATION` is a mode flag and carries. A server left out for that is logged by its
name and where the secret would be (an env key's name, an argument's place), never a value, and an
owner config that does not parse is logged without the parser's message (it
quotes the text). AgentHydra's own server is denied by name and by its endpoint (`/api/mcp`), so a
second PC's daemon under another name is left out too; the worker settings also deny the endpoint
by URL (`deniedMcpServers: [{ "serverUrl": "*://*/api/mcp*" }]`, any scheme, host and port), so
the account's own `.claude.json` listing it under another name does not load it either (measured
on the CLI 2.1.286: such an entry loads under name denies only and is gone with the URL deny, while
another server in the same file still loads). Any other entry loads from the account's
own copy. A worker's settings and MCP files are removed when its CLI ends or the worker is removed,
and a daemon start removes those of every worker that is gone or finished, never a live one's.
connections-local was denied for a day to save tokens (`8486a2d`); a worker asked to use
connections_execute then had no such tool and drove the local MCP through a script.

**The owner's command guards run in every worker** (2026-10-07). A worker runs with permissions
skipped, so the PreToolUse hooks in its settings are its only guard. Beside the edit_claims hook on
Edit, Write, MultiEdit and NotebookEdit, its settings carry the owner's `destructive_guard.py` and
`push_force_guard.py` from the owner's `.claude/hooks` (each only when that file exists) on every Bash
and PowerShell call (`workerHooks` in `climayte-signal.ts`, wired in `writeWorkerSettings`). Each runs
through `RUN_IF_PRESENT`, a `python -S -c` launcher that does nothing when the file is gone and puts the
script's folder first on `sys.path`, so a guard that imports a sibling module finds it. A sealed task
carries none of the owner's hooks. Verified the same day after a daemon restart: a live worker's
`git switch --discard-changes` was refused by the guard.

### Runner and restarts (`server/src/climayte-runner.ts`)

Owner, 2026-09-30: restarting AgentHydra must not break CliMayte workers. A `Bun.spawn` child sits in
the daemon's kill-on-close job on Windows, so a restart used to kill every worker (it then resumed
as `interrupted` and redid its step); `detached` is no escape (DETACHED_PROCESS flashes a console).

- `launchRunner(spec)` writes `<log>.spec.json` and starts the runner through the WMI hand-off
  (`detached-spawn.mjs`, `hideWindow`): it is born outside the daemon's tree (parent WmiPrvSE.exe).
  The runner reads and deletes the spec (it holds the CLI's env), starts the CLI with the attempt's
  files, writes `<log>.pid.json` (`{ runner, child }`), waits, and writes `<log>.exit.json`.
- On Windows the runner is `misc/climayte-runner.exe`, a native program with no dependencies (Rust,
  source in `misc/climayte-runner-native/`, built and checked for machine paths by its `build.ps1`;
  the exe is committed, and a release build embeds it as one of `RUNTIME_MISC_FILES` in
  `misc-assets.ts`). It is a console program started hidden,
  so its console host is born before its job and the CLI shares that console, as under the Bun
  runner; a CLI given its own console left that console's host in the job for a moment after it
  exited, listed as a leftover of every attempt. Measured 2026-10-04 on the same stand-in CLI: the
  Bun runner it replaces (this app in `--climayte-runner` mode, now `climayte-runner-posix.ts` for
  macOS and Linux) held 175-191 MB private (123-177 MB across live workers), the native one
  0.9-1.0 MB, with the same exit file and the same process tree (its console host and the CLI).
  One runner per worker stays on purpose: a runner that dies takes only its own worker. The daemon
  starts a copy named by its content, `corch/bin/climayte-runner-<sha256:12>.exe`, made from
  `misc/climayte-runner.exe` when there is one and otherwise from the build's embedded copy:
  Windows cannot replace a running exe, so runners started from `misc/` itself would make a
  `git pull` fail whenever the runner changed while a worker ran, and an embedded file cannot be
  started at all. With neither, the attempt fails and names the file. The runner finds the CLI as
  Bun.spawn did: a path or a bare name on the CLI's PATH, tried with `.exe`, `.cmd` and `.bat`
  unless it ends in one, so npm's extensionless `claude` shim starts the `claude.cmd` beside it.
- The attempt records `runner: { pid, pidFile, exitFile, launchedAt }`; `attempt.pid` is the CLI's.
  `attemptExited()` reads only files: an exit file means ended; a runner gone without one died
  (`finish` reads it as interrupted); no pid file within a minute means it never started. A runner
  pid is trusted only once its command line names the attempt's spec (`isOurRunner`), so a pid
  Windows reused is never followed or killed. `killAttempt` kills the runner's tree.
- `climayteRunningCount()` counts only pre-runner workers, so `/api/daemon/restart` needs no `force`
  for runner workers. Proven live: two restarts with 6-7 workers running left every attempt count
  unchanged and every worker running.
- On Windows the runner first puts itself in a kill-on-close job (`src/job.rs` in the runner's
  crate), then starts the CLI, so everything the session starts is in it: Bun's and
  Node's own child job allows silent breakaway, which is how a finished worker left `bun vite` on
  port 4289 running (field note 43); a breakaway climbs nested jobs only as far as each allows, and
  this one allows none. When the CLI exits the runner lists what is still in the job (pid, exe,
  command line) into the exit file and exits, which closes the job and ends them; `finish` journals
  them as `cleaned`. The job also holds a ceiling of 400 live processes per worker
  (`WORKER_MAX_PROCESSES`; a runaway shell function once started about 3,000), and the exit file
  records `peakProcesses`, which `finish` copies onto the attempt. Per attempt: a follow-up turn starts its own server again.
  The wind-down hook's server (`src/signal.rs`) answers as `serveSignal` does (`{}` inside a
  sub-agent, the loopback guard's exact-origin refusal), and the command lines in `left` are read
  with `NtQueryInformationProcess`, not a PowerShell per exit.

### Tokens, totals and the usage tables

- Every attempt records `tokens { input, output, cacheRead, cacheWrite }` beside its cost
  (`attemptSpend`: its own transcript turns in [startedAt, endedAt], plus its subagents' files
  under `<session>/subagents/`); the worker sums them (`d79e66c`). Each attempt also records its
  own `sessionId` (`95a9a76`): a planned handoff starts a new session, and the first backfill read
  every older attempt against the task's CURRENT session, so the attempts before a handoff counted
  0 tokens (47M missing in run 1). Those were recounted once from the session id in each
  attempt's log (`sessionOfLog`); their cost had been charged correctly at the time.
- `climayteTotals()` (`GET /api/corch/totals`) sums tasks, runs (`sessions`: every start of the CLI,
  retries, resumes and handoffs included), `runsByOutcome`, `cliSessions` (distinct conversations:
  a handoff starts one, a resume or a move carries one on), tokens and cost over every task on
  record, from every chat, for the view's counter, which says "runs" and gives the split in its
  hover. Run 1 measured: 2,105 requests averaging 160k tokens of context, so 324M of 337M tokens
  were cache reads (35% of the cost); cache writes were 3% of the tokens and 45% of the cost
  (1-hour writes at 2x input), output 19%.
- What fills a Pro account's 5-hour meter is not the token count. Fitted on run 1 (77 intervals
  over 7 accounts: the five_hour utilization each request streams, against the account's requests
  in between): output, thinking included, about 54%; cache writes about 32%; cache reads about 14%
  (per 1M tokens: read 0.4%, write 26%, output 272% of a window; the raw token count predicts the
  meter with R^2 0.02). So CliMayte does not turn on the CLI's compaction
  (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`): replayed on run 1, a 200k window cut tokens 26% but its
  summaries and re-written cache would have spent about two more Pro windows.
- `climayteRemove(ids)` (`POST /api/corch/remove`) drops finished tasks; their logs and transcripts
  move to `corch/archive/<stamp>/<id>/`, never deleted. 121 test tasks were archived this way.
- `climayteLiveReadings()` hands each account's newest streamed reading to `usage-live.ts`, which lays
  it over the cached snapshot in `GET /api/usage/cache` and `GET /api/cli-instances`: the usage
  sweep reads each account only every 30 minutes, a running worker's reading is seconds old
  (`6c34872`; #84 read 34% in the table while its workers streamed 85-88%). The readings are kept
  in `corch/live.json` across restarts (a restart used to drop them, and the table fell back to a
  snapshot from before the limit); a reading whose window has reset is void.
- `climayteLimitWalls()` lays CliMayte's usage-limit walls over the same tables (`withLimitWall`): a
  walled account shows that window at its limit (at least 100%, the wall's reset time) until the
  wall ends (field note 19: five walled accounts read 43-50%). The chips say "Limit" at or past
  100%: Anthropic reports 101-106% once a window is spent, because requests already running when
  it hit still count.
- Each attempt also keeps `spend { costUsd, turns, reread }` (`29d4c56`, `d3be433`; backfilled once
  from transcripts, null when its transcript is gone). `reread` is the first request's input and
  cache writes on an attempt after one that spent tokens: the conversation read again into a cold
  cache after a move, a limit, a handoff or a gap. Rows show per-attempt `costUsd`, `turns`, `pct`,
  `rereadPct` and the task's `used { pct, workPct, rereadPct }`; the scorecard and every cost
  estimate count the work only. Over everything on record on 2026-10-01: 14.2% of usage was
  re-reading (limit and move 127% of a Pro window, handoffs 60%, follow-ups 19%).
- The test metrics (owner, 2026-10-01: stop each account at 85-90%, never at its limit) ride on
  `GET /api/corch/totals?since=<ISO or ms>`: `limitHits` and `limitHitList` (runs that ended at a
  real limit; target 0), `ceilingStops` (runs the 90% ceiling stopped), `placedPast` and
  `placedPastList` (runs placed on an account already past the ceiling, stopped at their first
  reading, each with the reading it found and the `placedPct` it was placed on; counted in neither
  `ceilingStops` nor `peaks`), `peaks` (each account's
  highest 5-hour % per window from the CLI's rate_limit_events, `attempt.peak`), `sizing` (finished
  tasks' expected against used, `ratio` used/expected), plus `usedPct`, `rereadPct`,
  `rereadShare`, `rereadByCause`. Waiting rows carry `waitUntil` (ISO, UTC) and every row `size`.

### Model and thinking (field note 16)

The orchestrating chat picks each worker's model and thinking level (owner, 2026-09-30). The CLI
(2.1.284) takes `--model <alias or full name>` and `--effort low|medium|high|xhigh|max`.
`climayteModel(v)` maps `opus`, `opus-5.5`, `opus-5-5`, `claude-opus-5-5` (and the same four for
sonnet and for haiku, which is Haiku 5.5, `claude-haiku-5-5`) to the full id (`CLIMAYTE_MODELS`), so a
later alias move cannot change what a recorded task asked for; `climayteEffort(v)` accepts
`CLIMAYTE_EFFORTS`. Blank means the CLI's default; anything else throws with the valid values listed,
so junk never reaches the CLI (`climayteRun`: "task N: unknown model ..."; `climayteSend`: `ok:
false`). A Haiku 4.5 name (`haiku-4.5`, `haiku-4-5`, `claude-haiku-4-5`, dated ids) is refused with
"Haiku 4.5 is retired here (owner, 2026-10-07): use haiku (Haiku 5.5)", never mapped to 5.5. A
Haiku named with no effort runs at medium (`runSetting`, `chatSetting`; a `climayteSend` that moves
a worker to Haiku with no effort too).

The haiku alias pin (`server/src/core/haiku-pin.ts`, `pinHaikuModel`). Claude Code makes its own
small-model calls (titles, summaries, the Explore agent) on its `haiku` alias, whatever `--model`
says. Over the 7 days before 2026-10-07, 11,884 of 97,974 requests on CliMayte's CLI instances were
`claude-haiku-4-5-20251001`, a median of 220 output tokens each: those calls, inside the workers.
So every env AgentHydra builds for a Claude Code process (a worker's and the nudge's `scrubbedEnv`,
the `/usage` probe, the limit reset, quick add, the CLI tab's Launch and resume in a terminal) sets
`ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5`, unless it already names a model newer than Haiku
4.5.

- `climayteRun`'s top-level `model`/`effort` are the group default for tasks without their own.
- `climayteSend(id, text, { model, effort })` sets them on the worker; they apply from the next
  launch (the follow-up turn and every later one), in the same session.
- Each attempt records `requested` at launch and `model` from the CLI's `system/init` event (read
  by the poll). The stream-json does not report effort (init carries only
  `per_turn_effort_active: true`); the session transcript's assistant entries do (`"effort"`,
  `"perTurnEffort"`).

Live proof (2026-09-30, account #83): `sonnet`/`low` → init `claude-sonnet-5-5`, `modelUsage`
only that model, no thinking block, transcript `"effort":"low"`; `opus`/`max` → init
`claude-opus-5-5`, one thinking block, transcript `"effort":"max"`; the full id
`claude-sonnet-5-5`/`medium` → init `claude-sonnet-5-5`, transcript `"effort":"medium"`. Both
flags are honoured; neither is silently ignored.

### Watching (the tick)

`startCliMayte()` starts one timer (3 s while any worker is queued/running/waiting, else 15 s;
`.unref()` it). Each tick, for every worker:

- **running**: read the attempt's log from the last offset (offsets kept in memory; after a
  daemon restart the whole log is re-read, which is correct). Parse each line with `JSON.parse`
  (skip bad lines). Keep `lastActivity = summarizeEvent(ev) ?? lastActivity`. When the process
  is gone (`isPidAlive(pid)` from `core/process.ts` false, or the Bun subprocess has exited),
  finish the attempt with `classifyAttempt(allEventsOfThisAttempt, stderrText)`:
  - `done`: add `total_cost_usd` / `num_turns`, set `result`. If `pending` is non-empty, queue
    the next follow-up on the same account at once; else status `done`.
  - `quota`: wall the account until `parseResetTime(notice)` (from `usage.ts`, ISO → epoch) or
    now + 60 min when unparsable; status `queued` with the handoff flag (next attempt resumes the
    session on a DIFFERENT account with `HANDOFF_PROMPT`).
  - `auth`: wall the account for 30 min with reason `signed out`; requeue as a handoff (the
    session may have written nothing yet; that is fine, see below). "Your organization has disabled
    Claude subscription access" walls it as `organization disabled Claude Code` instead
    (`ORG_DISABLED_WALL`), lifted only by a new login: `claude auth status` passes such a login, so
    the 30-minute recheck lifted the old wall every time and every waiting task hit the account at
    once (run 1: #91, 11 failed runs, 4 in one second).
  - `auth` or `quota` before the attempt wrote anything (its account's transcript is missing or
    older than the attempt): that account does not become the session's home; `accountId` goes
    back to the account holding the newest transcript (`keepHome`, field note 30).
  - `transient`: `retries < 3` → `notBefore = now + [5, 10, 20]s[retries]`, `retries++`, requeue
    on the same account (resume if the session file exists, else first-attempt again);
    otherwise `failed`.
  - `error`: status `failed`, `error` = the result text or the stderr tail (last 1,500 chars).
- **queued / waiting**: highest `priority` first, then oldest first, then the largest expected
  cost (`dueOrder`, field note 20); when `notBefore` has passed, `pickAccount(worker)`; none → `waiting`
  with `error` naming why (every account walled / none signed in); else launch.

Emit a change event (`onCliMayteChange(cb) → unsubscribe`) whenever a worker's status changes, so
`climayte_status` can wait without polling.

**Turn caps** (`notConverging`, `TURN_CAPS`, 2026-10-02). After a handoff or a limit, before the
task is queued again: past 8 attempts, 4 moves between accounts, 3 handoffs (not counting those
on conversation size, nor the account change after one), or 3 times its size
estimate (at least half a Pro window) since its newest finished attempt, it fails with why and
what to do (split it, or continue with `climayte_send`). Sign-in refusals cost nothing and do not
count. `retries` (transient errors, interrupted resumes, launch retries) resets only when a turn
finishes, not at a limit or a handoff. A check that cannot run (no start, exit 126 or 127) fails
the task at once as a broken check instead of sending it back.

**The pool is read at most every 3 seconds** (`signedInAccounts`, `POOL_MS`); it rebuilt from disk
every second while work ran. The live-session count per account is `liveSessionIds`, which skips
the transcript lookups.

### Pure helpers (exported; the tests pin these)

- `classifyAttempt(events: unknown[], stderr: string): { outcome: AttemptOutcome; notice: string | null; result: string | null; turnTexts: string[]; costUsd: number; turns: number }`
  - `turnTexts`: every turn's closing text, oldest first. The CLI writes one `result` per run, but
    a repo's Stop hook that refuses the stop sends a `user` message `Stop hook feedback: ...` and
    the session goes on (field note 13: a "prove the deploy" turn's text replaced the worker's real
    report). So the assistant text before each such message is a turn's text, and the clean
    result's is the last. `finish` appends them to `results` (`addResults`), sets `result` to
    `joinResults(results)` and journals a `turn-end` per turn.
  - Quota: a `createLimitStopTracker()` fed every event says `pending`, or the terminal `result`
    has `is_error` and `classifyLimit(text) === 'quota'`, or `classifyLimit(stderr) === 'quota'`.
    Model prose and tool output are never evidence (see `rate-limit-signal.ts`).
  - Auth: the same trusted places match
    `/please run \/login|not logged in|invalid api key|oauth token (?:has )?(?:expired|been revoked)|authentication_error/i`.
  - Transient: `classifyLimit(...) === 'transient'` in the same trusted places.
  - Done: a `result` event with `is_error !== true` (and none of the above).
  - Otherwise error.
- `summarizeEvent(ev: unknown): string | null`: `assistant` text block → `said: <first 140 chars>`;
  `assistant` tool_use → `<ToolName> <short input: file_path / command / pattern / description, 100 chars>`;
  `result` → `finished (<num_turns> turns, $<cost>)`; `system/init` → `started (<model>)`; else null.
- `pickAccount(worker, accounts: CliMayteAccount[], walls, active: Map<accountId, number>, perAccount: number, now): CliMayteAccount | null`
  where `CliMayteAccount = { id, num, name, configDir, sessionPct: number | null, weekPct: number | null }`.
  Eligible: in `worker.accounts` when set; not walled (`walls[id].until > now`); `sessionPct < 98`
  and `weekPct < 99` when known; `active < perAccount` (a session going back to its own account
  is not held to it). A handoff (last attempt `quota`/`auth`)
  excludes the account that failed. A follow-up prefers `worker.accountId` when eligible. Score =
  `max(sessionPct ?? 50, weekPct ?? 50) + 100 * active`; lowest wins; ties by `num`. `active` counts
  the workers running on the account from EVERY group (field note 8: at 25, a busy account at 0%
  still beat an idle one at 30%, so two orchestrations piled onto one account); `perAccount` stays
  a per-group cap, with `MAX_PER_ACCOUNT` above it in total. Past the wind-down line (85% session,
  85% week since `df4bb96`, was 95) an account takes no NEW work: not a new task, a handoff's continuation or a moved
  session, only the session already on it (its home). Run 1, 19:32-19:36: the one account below
  the line was at its worker cap, so twenty continuations went to accounts at 89-97% and were told
  to hand off again within three calls (about 290k tokens and $0.75 each). A session that reaches
  the line hands off whether or not another account has room (`fc1ca87`, owner: never the limit,
  stop at 85-90%); with none, the task waits for the first reset (`waitUntil`). A session whose
  conversation reaches `CONTEXT_HANDOFF_TOKENS` (200k since 2026-10-06; at 150k a handoff cost more than it saved: the newest main-agent request's input, cache
  reads and cache writes, `contextTokens`) is asked the same way, whatever its account's usage;
  its attempt's `windDown.reason` is `'context'`, and the account it left is not nudged against
  (no +100) when the next session is placed. At `CEILING_PCT`
  (90, either window; `df4bb96`) a turn still running is stopped on the spot and the account walled
  until that window resets: it goes on from its handoff if it wrote one, else moves or waits. Those
  are ceiling stops (`ceiling` on the attempt, `ceilingStops` in the totals), never limit hits. A
  stop at the run's first reading, already past the ceiling (`pastOnArrival`), is
  `ceiling.onArrival`: the account was full when the run arrived, the reading it was placed on was
  stale or missing, and it counts in `placedPast` instead (2026-10-02: #120 had no reading and its
  first request was refused at 129%; #118 was placed at 82% and read 95%, #119 at 79% and read
  100%). An owner who allows paid extra usage lifts both lines.
- Placement goes by readings at most `READING_STALE_MS` (10 minutes) old: the background usage
  check reads every account only every 30 minutes, and an account can be used outside CliMayte
  meanwhile. While a task waits to be placed, an account whose reading is missing or older is read
  again (`refreshReading` in climayte-core.ts: the usage check, no quota, one account at a time like
  the background sweep, at most once per account per 10 minutes) and takes no new work while that read runs (`refreshing`, up to 30 s). A reading
  still stale after it, like a missing one, lets the account take one worker until that worker's
  stream reads it.
- `copySessionTranscript(fromConfigDir, toConfigDir, sessionId): boolean`: find
  `<from>/projects/*/<sessionId>.jsonl`, copy it (and a sibling `<sessionId>/` directory when
  present, recursively) into `<to>/projects/<same folder name>/`, keeping the source's mtime.
  Returns false when the source is missing (then the next attempt starts fresh with `--session-id`
  and the ORIGINAL task prompt, because nothing was recorded).
- A move copies from `newestTranscript(candidates, sessionId)`: of every account the task's attempts
  ran on (a refused login last) and every usable account, the one whose copy was written last, NOT
  the account last tried (field note 30: five sessions moved off #91, where the organization had
  Claude Code off and whose folder was gone, failed "not found" while their transcripts sat on #83,
  #95, #88 and #98). Only when no account holds it, and the session got past sign-in somewhere, does
  the worker fail; the error says so, and `handoffNote` keeps its newest handoff note, from which a
  `climayte_send` continues in a fresh session.

Production accounts: `listCliInstances()` filtered to `loggedIn`, each with `sessionPct` /
`weekPct` from `lastUsageCheck.session.pct` / `lastUsageCheck.weekAll.pct` (null when absent).
Tests replace the provider with `setCliMayteAccountsProvider(fn | null)`.

The login a listing reports is honest (field note 3): `loggedIn` only proves a credential file
exists, so climayte.ts registers `setCliLoginVeto(climayteSignedOutReason)` (from `climayte-stops.ts`) with `core/cli-instances.ts`.
An account CliMayte walls `signed out` (its last attempt failed `auth`, and its credential file has not
changed since) lists `loggedIn: false` with a `loginNote` saying why, in `list_cli_instances` and
the CLI tab alike, without running `claude auth status` per row. The wall is rechecked in the
background with `cliAuthStatus` every 30 min, and lifts at once when the credential file changes (a
fresh sign-in). An `organization disabled Claude Code` wall lists the same way with its own note,
and only a changed credential file lifts it.

### The owner's CLAUDE.md and skills (`server/src/climayte-owner-sync.ts`)

A worker runs with `CLAUDE_CONFIG_DIR` = its account's folder, so the owner's own Claude Code folder
(`.claude` in the home directory: the global CLAUDE.md, skills and hooks) is not what it reads
(field notes 5 and 9). Before each launch, `syncOwnerClaude(ownerDir, account.configDir)`, with
that folder as `ownerDir`, makes the account folder match:

- `CLAUDE.md` is COPIED (a file symlink needs admin rights or developer mode on Windows; a hard
  link breaks the first time an editor saves by replacing the file), only when the owner's changed,
  and never over a CLAUDE.md the account holds of its own.
- Each owner skill folder is a directory JUNCTION in `<account>/skills/` (no admin rights, always
  current). The account's own entries (its `synced/` folder) stay; a link whose skill the owner
  removed is removed. Removing an account folder removes the links, never the owner's files.
- Cheap: a signature (CLAUDE.md's size and mtime, the skill names) is kept in memory and in
  `<account>/.agenthydra-owner-sync.json`; an unchanged one costs a stat and a readdir.
- Hooks and `settings.json` are NOT carried: the owner's desktop-only hooks can block a headless
  worker. Tests turn it on with `setCliMayteOwnerDir(dir | null)`; under `NODE_ENV=test` it is off.
- **The lean worker profile** (`8b3add7`, owner's yes 2026-09-30): when that folder's
  `climayte-worker/` holds a `CLAUDE.md`, workers get that instead of the full one, and when it holds `skills.txt`
  (one skill name per line, `#` comments) only those skills are linked; the rest are unlinked at
  the next launch. The owner's profile lives in the claude-memory repo (`home/climayte-worker/`,
  installed by `install.mjs`): 3 KB of rules and 12 engineering skills, against 44 KB and 84. Run 1
  measured what the full set cost: a fresh session's first request grew 57k -> 90k tokens
  (Connections) when it arrived, and that prefix is re-read on every request and written to cache
  on every fresh session and move.
- **A first step for every worker** (owner, 2026-10-03: each worker should read its role prompt
  first): it goes in this machine's worker `CLAUDE.md`, not in the task prompt. Every session loads
  that file, so the step holds through retries, moves to another account and compaction with no
  special casing; the 658805b prompt-preamble setting did the same job and was taken back out.

### Chat workers (`chat: true`, owner, 2026-10-04)

A chat front end can run each of the owner's interactive chats as a CliMayte worker (dispatched
once, then every later message by `/send`). An ordinary worker is framed as a delegated task, and on
2026-10-04 a chat asked to answer an outside company drafted the email and handed it back because
its brief said to report, not act. A task with `chat: true` (the task field on `climayteRun`,
`POST /api/corch/workers` and the `climayte_run` MCP tool; default false) makes a chat worker. The
flag is on the worker record (`CliMayteWorker.chat`), so it holds through moves, resends and
revives; workers a chat dispatches with `climayte_run` are ordinary unless they say otherwise.
A Desk chat also sends `desk: {append, mcpServers}` (only with `chat: true`, `append` at most 20,000
characters): its connector servers join the MCP config (the owner's of the same name win) and its
append follows `CHAT_NOTE`, on every launch, continuations and account moves included.

| | Ordinary worker | Chat worker |
| --- | --- | --- |
| Appended prompt | `WORKER_BRIEF` (`--append-system-prompt`) | `CHAT_NOTE` (it runs headless, and a markdown image of a local picture or video shows in the chat), then the owner's `~/.claude/CLAUDE.md` unless the CLI's own walk already reads it from the chat's folder (`--append-system-prompt-file <hooks>/<id>.chat.md`) |
| Account folder's CLAUDE.md (the lean worker profile) | loaded | left out with `claudeMdExcludes` in its `--settings` |
| Skills | the lean profile's | also every owner skill, command and agent, through `--add-dir <home>` |
| MCP servers | the owner's less AgentHydra's and magnific; `deniedMcpServers` | all the owner's, AgentHydra's included; no denial |
| claude.ai connectors and synced skills | off (`ENABLE_CLAUDEAI_MCP_SERVERS=false`, `syncClaudeAiSkills: false`, humanizer off) | on, as in his own `claude` |
| Prompt cache | 5 minutes | 1 hour (a person's next message is often more than 5 minutes away) |
| Model and effort | the scorecard's pick unless named with `modelWhy` | Opus xhigh unless the task (or its run) names its own; no `modelWhy` needed; never `auto`, never split by sizing |
| Hooks | edit claims and the wind-down signal | the same two: edit claims protects files other sessions edit, and the wind-down signal is how a session hands off and moves at a usage limit |
| Placement (2026-10-05) | where its projection fits, the most behind its weekly pace first (`placedRank`); may wait up to `RESUME_WAIT_MS` for another account's reset | where it has the most room before the stop lines, in Pro points (5-hour room under `FIT_PCT` or weekly room, the smaller, times the plan: a Max 20x first), again after every handoff; starts before every task (`dueOrder`); never held for another account's reset |

The account folder's CLAUDE.md is shared by every worker on the account, so it is never swapped
per launch: an ordinary worker's launch is byte for byte what it was. Both mechanisms were checked
on CLI 2.1.286 (2026-10-04): `claudeMdExcludes` applies to the User memory type, so the account's
lean file is not loaded, and `--add-dir` loads the added folder's `.claude/skills` with no hook or
settings from it. Auto-memory stays off for both (the owner's own settings have it off).

Measured 2026-10-04, the first request of a one-line prompt on one account in this repo (Haiku
tokenizer): ordinary 27,864 tokens, chat 28,844 (+980; 124 tools against 33, 66 skills against 23;
MCP tools are deferred, so they cost a name each).

### Sealed tasks (`sealed: {...}`, 2026-10-05)

Some workers need one system prompt and one MCP server and nothing else. SUE (the playtest tool in
the Connections repo) runs each simulated visitor as a CliMayte worker, and one visit measured on
2026-10-05 made 98 requests whose context was already 38,700 tokens before the visitor's first move
(the CLI's tool set, the owner's MCP servers, the account's CLAUDE.md, `WORKER_BRIEF`), median 72k,
6.84M cache-read tokens for the visit and 5.5 minutes from worker start to first move. SUE can seal
its own `claude` spawn, but that would use a CLI login outside CliMayte, which is the one allowed
door to those accounts; so the sealing is a task option here.

A task with `sealed` (the task field on `climayteRun`, `POST /api/corch/workers` and the
`climayte_run` MCP tool) is a sealed worker:

```json
{
  "prompt": "Visit the page and try to sign up.",
  "sealed": {
    "systemPromptFile": "C:/Users/me/sue/visitor-7.md",
    "mcpConfig": "C:/Users/me/sue/visitor-7.mcp.json",
    "allowedTools": ["mcp__sue-hands__*"]
  }
}
```

`sealed.prompt` stands in for the task's `prompt` when that is empty; the task's `cwd` is not read.
`sealedOf` refuses the dispatch, with the task's number, when either path is not an absolute
existing file, when `mcpConfig` is not JSON with an `mcpServers` object, or when `allowedTools` is
not a non-empty array of non-empty strings; a sealed task cannot also be `chat: true`. The option is
on the worker record (`CliMayteWorker.sealed`), so it holds through moves, resends and revives.

| | Ordinary worker | Sealed worker |
| --- | --- | --- |
| System prompt | the CLI's own, plus `WORKER_BRIEF` (`--append-system-prompt`) | `--system-prompt-file <systemPromptFile>`, in place of the CLI's own; no `WORKER_BRIEF`, no `CHAT_NOTE`, no ETA note |
| Settings sources | the account folder's (the lean CLAUDE.md, skills, user settings) | `--setting-sources ""`: no CLAUDE.md, no hook, no skill, no user setting; `syncOwnerClaude` is not run for the launch |
| Built-in tools | all | `--tools ""`: none |
| MCP servers | the owner's and `climayte-worker`, written to `<hooks>/<id>.mcp.json`, never AgentHydra's own or magnific (`deniedMcpServers` by name and AgentHydra's endpoint by URL) | `--strict-mcp-config --mcp-config <mcpConfig>`: exactly that file's, AgentHydra's own when it names it (no deny list); no `climayte-worker`, so no `climayte_ask` |
| Permissions | `--dangerously-skip-permissions` | `--permission-mode default` and `--allowedTools` exactly as given |
| Folder | the task's `cwd` | an empty folder of its own, `corch/sealed/<worker id>`, made at dispatch and again at launch if it was cleaned away; the storage pass clears it with the worker's other files |
| Usage stops | the wind-down ask at the stop line, then the ceiling | the ceiling only: it has no Write tool for a handoff note, so it is never asked for one (`climayte_handoff` refuses it); stopped at the ceiling, its session moves to another account and resumes from its transcript |
| Report | its final text, after the worker contract's steps | its final text; it has no Connections MCP, and nothing in the daemon asks it for the contract's `prompt_get` or rating (those come from the account's CLAUDE.md, which it never loads) |

**The model and effort a sealed task names are held** (`runSetting`), at any rung and with no
`ownerWords`: a sealed task is a measurement (a simulated visitor in a series), so the scorecard
never trials a cheaper setting on it, and with no `kind` it is no kind's sample (`scoreRows` skips a
kindless task). A fail on one is recorded and never sent back up the ladder (`climayteVerdict`):
its next turn would run on a setting it never named. Its reason reads
`named by a sealed task: <modelWhy>`. Why (2026-10-07): 624 SUE
visits that day were sent sealed naming Sonnet 5.5 with a `modelWhy`; none held, every one was scored
as `code`, and they ran on code's pick, 469 at Sonnet low, 150 on Haiku 4.5 and 5 on a Haiku 5.5 trial,
while SUE recorded Sonnet 5.5 for all of them. A Haiku visit beside a Sonnet one is a second variable
in the A/B the series exists for, and a visit says nothing about code work. A sealed task that names
nothing is still the scorecard's. An ordinary worker has every tool, so its holds are unchanged.

Everything else is as for any worker: the account is picked by quota and placement, RAM gating,
usage accounting, pings, checks, verdicts and status. Its `--settings` file is still written and read (a `--settings` flag is not a settings
source), without the edit-claims hook and without the ordinary worker's `deniedMcpServers`: four
sealed test chats of the Free tools named AgentHydra's server and started with no tool at all, the
CLI's only sign a "blocked by enterprise policy" line in the err log (2026-10-06). `--allowedTools`
is the gate on what it calls, so a task that names AgentHydra's server lists only the tools it needs. Two sealed tasks never count as a repeat of each other,
since each has its own folder (`repeatOf` compares folders).

`cliArgv` builds both launches; the sealed branch is in `briefArgs`, and `writeWorkerMcp` answers
the task's own config. `server/tests/climayte-sealed.test.ts` pins the exact argv and the refusals.
Not yet measured: the request size of a live sealed worker (the daemon had not been restarted onto
this code when it was written).

### Scorecard (`server/src/climayte-scorecard.ts`, `5710553`)

Owner, 2026-09-30: "the AI can try a model, and if it works, it gives it a thumbs up ... if it
does not, it reports the failure, and what model it tries next." Output, thinking included, is about
half of what fills a Pro account's 5-hour meter (field note 27), so the model and thinking level are
the biggest quota levers left, and the safe way to lower them is to learn from real results.

- **Verdicts.** `climayteVerdict(id, { verdict, note?, retry?, kind? })` judges a FINISHED task (the
  orchestrator after checking its proof, or the owner's thumbs in the CliMayte view). Each
  `CliMayteVerdict { at, verdict, note, model, effort, units }` keeps the setting that produced the
  result and what the work since the previous verdict cost (`attemptUnits`: the plan-meter weights
  of `usage-tokens.ts`, 5-minute or 1-hour writes by the attempt's `cacheTtl`). A fail needs a note
  and goes back to the same session one rung up (`nextRung`, through `climayteSend`), unless `retry`
  is false. Journal event `verdict`.
- **The check** (`fa547d2`; owner: verdicts should be "whatever is best for the AI"). A task may
  carry `check`, one bash command whose exit 0 proves it done. When the worker reports done, CliMayte
  runs it in the task's folder (`startCheck`: status `checking`, Git's bash, hidden, output in
  `logs/<id>-check-<n>.log`, 20-minute cap) and judges by the exit code itself (`by: check`): a fail
  goes back to the same session one rung up with the end of the output; three failed rounds stop the
  task as `failed` for the orchestrator. The check runs under the daemon, so a restart ends it and
  the next tick runs it again. An orchestrator that must remember to judge every result forgets
  some, and a worker's own "the tests pass" is a claim; a command is neither. An exit 0 is a pass
  only when the files the worker's sessions changed (their Edit, Write, MultiEdit and NotebookEdit
  calls) are committed in the folder's repository (`climayte-unsaved.ts`); otherwise it is a fail
  that names them, on the same three rounds. A file changed more than 30 s after the session last
  wrote it is a peer's and not counted, and a task whose prompt says not to commit is not held to it
  (2026-10-05: a check passed with 15 files never committed, and the task sat done 2h26m while the
  tasks after it waited on work that was not in git).
- **Fail severity** (owner, 2026-10-06: "Did it really fail, or did something have to just do a slight
  bit of work to fix it? Was it ... a catastrophic fail, or was it just kind of like a
  whoopsie-daisy?"; before it, every non-pass read as a full fail and Opus sat at 73%, Sonnet at 75%).
  A fail carries `severity`:
  - **0 not the model's**: the work was not judged or the failure is not this task's. The check could
    not run (126/127, never started, runner lost) or timed out, or it failed only on files this task
    did not edit (another session's work in a shared checkout, the environment, a flaky check); an
    orchestrator may also say the brief was wrong. NOT SCORED: neither a pass nor a fail, and its
    units stay out of the cost.
  - **1 slip**: right work, a small miss someone fixes in minutes: files not committed, a file outside
    the brief's paths, a one-line, typo, lint or format fix, a small missed test or doc update.
  - **2 rework**: a real part is wrong or missing and needs a substantive follow-up, though the
    approach stands.
  - **3 failed**: wrong, unusable or harmful: misunderstood the task, nothing useful, broke unrelated
    things, claimed a success that was not there.

  Credit per scored verdict: pass 1, slip 2/3, rework 1/3, failed 0 (`SLIP_CREDIT`, `REWORK_CREDIT`,
  `scoreOf`). The rate that trusts or writes off a rung (`MIN_SAMPLES`, `PASS_BAR`, `BAD_BAR`) is
  credit over scored verdicts, and `perPass` is units over credit, so a slip-heavy rung that is cheap
  can be picked where all-full-fails would never trust it. A fail with no severity (recorded before
  this, by an older daemon, or by the old window's thumbs-down) counts as 3, as before. A pass takes
  no severity (refused). The orchestrator's `climayte_verdict` must give one on a fail; the route
  still takes a fail without. The check sets it by code (`judgeCheck`): broken or timed out 0; exit 0
  with uncommitted files 1; a non-zero exit 0 when its output names files, none is one the task
  edited (read from the sessions' transcripts like the uncommitted check), and one of them has
  another session's uncommitted changes (`git status` in the task's folder; `failsOnlyOnOthersFiles`,
  the note then says so), else 2, so a test the task's own change broke stays its fail; a transcript
  that cannot be read is unknown, so 2. A wave's fail
  (`judgeInWave`) is 1 for commits outside the brief's paths, else 2. Retries, send-backs and
  status are unchanged: only the severity is new. Scorecard rows carry `slip`, `rework`, `failed`,
  `excluded` and `score`.
- **The ladder**, cheapest first: Haiku 5.5 medium, high, Sonnet 5.5 low, medium, high, then Opus
  5.5 medium, high, xhigh, max. A CLI-default setting counts as Opus high. A Haiku 5.5 verdict with
  no effort counts as Haiku medium (the API's default). Verdicts on Haiku 4.5 stay off the ladder
  (`ladderModel` leaves the id as it is): they judged another model and do not count for 5.5.
- **Kinds**: code, debug, review, sweep, mechanical, docs, trivial, manage (`climayte_run` `kind`).
  Before a rung has earned its trust every kind starts on Haiku medium (`START`, owner,
  2026-10-07). Once both Haiku rungs are written off for a kind it starts where it did before Haiku
  5.5 (`START_PAST_HAIKU`): trivial and manage on Sonnet low; sweep, mechanical, docs, code and
  review on Sonnet medium; debug on Opus medium.
- **Haiku first while it learns** (`haikuTrial`): while the kind's best rung is above Haiku and a
  Haiku rung is still learning (neither trusted nor written off, and no cheaper Haiku rung written
  off), EVERY auto pick goes to that Haiku rung, not only every 4th; the reason reads `trying Haiku
  medium first (Haiku 5.5), cheaper than Sonnet medium, for code`. Once Haiku is trusted the cost
  order prefers it; once it is written off the exploring below returns.
- **A failed Haiku result** goes back on the rung the kind would have run without the Haiku trial
  (`bestRungPastHaiku`: the trusted rung, else `START_PAST_HAIKU` moved past rungs that keep
  failing), or one rung up if that is higher (`nextRung`'s `floor`, passed by `sendBack` when the
  worker has a kind). So a task Haiku cannot do costs one Haiku attempt, then runs where it would
  have run.
- **`model: "auto"`** (`pickConfig`), the default (owner, 2026-10-02: "the cheapest/fastest model
  capable of reliably completing your offloaded task"): of the rungs trusted for the kind (at least 3
  verdicts, 70% or more passes), the one whose passed task costs least (`perPass`: all its work over
  its passes, so a cheap rung's failures are priced in); else the kind's start moved up past any rung
  with two or more verdicts under half. Every 4th auto pick of a kind tries the cheapest rung below
  that is neither trusted nor written off, Haiku first. The first version took the cheapest rung at
  80%, and code's Sonnet medium sat at 78% (93 of 119) at a quarter of the quota of Opus high, so
  every code task went to Opus high. The pick and its reason go in the `dispatched` journal line.
- **Leave `model` out.** Owner, 2026-10-05, seeing every task on Opus 5.5: the point was to offload
  work to moderate models, and Sonnet "had given very reasonable results", "but not a single one is
  using any other model besides Opus 5.5". The scorecard's own picks were mostly Sonnet (383 of 416
  in 24 h on this PC), but senders pinned Opus by naming it with any `modelWhy` (286 tasks in 72 h).
  So a named model or effort (`runSetting`; `climayte_run` top level or per task) is held only when
  (a) the task or its run gives `ownerWords`, the owner's own words in the sending chat asking for
  it, quoted (at most 2000 characters, refused if longer; its reason reads `named by the owner:
  "<first 120 characters>"`), or (b) it gives a `modelWhy` AND the setting sits on a CHEAPER rung
  than the kind's pick (`bestRung`). A setting at or above the pick without `ownerWords` goes to
  auto, and its reason says so. A named setting is ranked with `ladderIndex`: Haiku alone counts
  as Haiku medium; any other model alone counts as that model at `high` (the CLI's default effort);
  an effort alone counts as Opus at that effort (the CLI's default model); a setting off the ladder
  (Haiku low, Opus low) is never held by a `modelWhy`. Chat tasks are unchanged, and a sealed
  task holds whatever it names (Sealed tasks, above).
- **While a kind's pick is an Opus rung, every 2nd auto pick** (`EXPLORE_EVERY_ON_OPUS`) tries the
  cheaper rung still learning, not every 4th: review sat on Opus high because Sonnet had 2 review
  verdicts and a try came too rarely to earn the third.
- **Haiku 5.5, never Haiku 4.5** (owner, 2026-10-07). Haiku came back on the ladder on 2026-10-02
  ("don't forget Haiku exists") as Haiku 4.5, one rung with no effort. On 2026-10-07 Haiku 5.5
  replaced it with two effort rungs, and Haiku 4.5 is refused. The price check behind "really
  cheap": Haiku 5.5 is $0.10 input, $0.50 output, $0.01 cache read per million tokens for a prompt
  of 100,000 tokens or fewer, five times that over (the tier is chosen per request). CliMayte's CLI
  traffic over 7 days (97,974 requests, median prompt 78,698 tokens, 35.1% of requests over 100k)
  re-priced at list prices: Sonnet 5.5 $2,519, Haiku 4.5 $1,276, Haiku 5.5 $494, so 0.2x Sonnet and
  61% cheaper than Haiku 4.5. Anthropic calls it best suited to narrowly scoped tasks and a
  subagent beside Opus and Sonnet; the scorecard writes it off for a kind after two fails, so a kind
  it cannot do costs two small tries, not a habit.
- **`climayteScorecard()`** (`GET /api/corch/scorecard`, `climayte_scorecard`): passes, fails and cost per
  task as a share of a Pro 5-hour window (`UNITS_PER_PRO_PERCENT` = 320,000 weighted units per 1%,
  fitted on run 1, R^2 0.48) per kind and setting, `pick` on the next auto setting. The CliMayte view
  shows it as "What works" and puts thumbs up/down on a finished task. `estimates` carries the time
  estimate calibration (below).

### Time estimates (`server/src/climayte-eta.ts`, owner, 2026-10-05)

Owner, 2026-10-05: sub-agents should "say estimated times ... estimated five minutes", shown on
Desk 2's running-tasks row, and "we could get better at improving the prompt we give the
sub-agents for estimating time until they can actually estimate time properly."

- **The line.** `WORKER_BRIEF` asks for `ETA: <n> min` on its own line before the first tool call,
  and a new one per later message. `parseEta` reads `ETA: ~5 min`, `**ETA:** 12 minutes`,
  `ETA: 1h 20m` (80), `ETA: 5-10 min` (7.5, a range is its middle) and a bare number as minutes;
  only the amounts right after `ETA` count; 0 or over a day is no estimate. `etaOfEvent` looks only
  at an assistant event's text blocks, never a tool result or the prompt.
- **Recording.** `applyLogEvent` (climayte-core.ts) keeps the first estimate of an attempt's log in
  `LogRead.eta` with its event time; `noteActivity` copies it once per message to
  `worker.eta { minutes, at, attempt }` (chat workers are skipped: they get no `WORKER_BRIEF`). A
  move or handoff keeps the first estimate.
- **Settling.** When the message's turn ends `done` (not to ask a question, not failed), `finish`
  sets `eta.tookS` = `etaTookSeconds`: the rest of the attempt the estimate was said in, then every
  later attempt whole. Waits for an account between attempts are not counted. The `done` /
  `turn-done` journal line adds `estimated N min, took M min`.
- **Next message.** `startReport` moves a settled estimate into `pastEtas` (the newest
  `MAX_PAST_ETAS` = 10) and clears `eta`; an unsettled one (cancelled, failed, asked) is dropped.
- **Calibration.** `etaSamples` collects every settled estimate, newest first; `etaCalibration`
  takes the newest `ETA_SAMPLES` = 30 of the task's kind when it has `ETA_MIN_SAMPLES` = 5, else of
  every kind, and gives the median and quartiles of took/estimated; under 5 samples it is null.
  `etaNote` turns it into the sentence `briefArgs` appends to `WORKER_BRIEF`: within 1.25x either way
  "Your estimates have been close ...", otherwise "Calibrate your ETA: ... Multiply your first guess
  by about X before you write it." So the prompt corrects itself as the samples come in.
- **Calibration by size (owner, 2026-10-06: the estimates were "badly off").** Measured over 10 days
  of transcripts, 315 `ETA:` lines against the real working time: first guesses under 10 min ran a
  median 1.01x (right), 10-19 min 0.58x, 20-39 min 0.60x, 40 min or more 0.22x (a 90-minute guess
  typically took about 20); 112 of the 315 were exactly `ETA: 10 min`. One flat multiplier shortens
  the right small guesses and leaves the big ones 3-5x long, so `etaBandCalibrations` also gives the
  median and quartiles of took/estimated per `ETA_BANDS` band (under 10, 10-19, 20-39, 40 and over),
  over the newest `ETA_BAND_SAMPLES` = 200 samples of every kind; a band with under 5 samples is left
  out. When one qualifies, `etaNote` says "Calibrate your ETA by its size: first guesses under 10 min
  have run 1.0x (keep them), 10-19 min 0.58x ... scale your first guess by its band before you write
  it." instead of the flat sentence (kept when no band qualifies); the cause sentence follows, all
  within 450 characters. `climayte_scorecard().estimates.byBand` shows the bands.
- **The ledger (owner, 2026-10-06: "if you track it, it will get better").** `eta.jsonl` in the corch
  folder (`climayte-eta-ledger.ts`), append-only: a `said` row (exact `ETA:` line, the text block it
  was in, the message, kind, model, effort, account), a `settled` row (working `tookS`, `wallS` = what
  the owner waited, attempts and moves since, `ratio`, bucket `close` within 1.25x / `over` / `under`)
  and a `review` row. Calibration and the scorecard read its tail (1 MB, cached on size and mtime)
  merged with the live workers, once per estimate, so removing a worker loses nothing.
- **Asking why.** An ordinary worker (not a chat, not sealed) gets an http `Stop` hook to the daemon,
  `POST /api/corch/stop/:id` (`climayteStopHook`). It answers `{}` unless the worker has an open
  estimate, `stop_hook_active` is false, it is not ending its turn to ask, it was not asked for this
  message, and the working time is outside 1.5x either way (`REVIEW_BAND`). Then it settles `tookS`
  at that moment and blocks with the question: its exact ETA line, the minutes it took, the ratio, and
  two lines to answer, `ETA-REVIEW: <why, and what it would estimate next time>` and `CAUSE:` one of
  `human-pace, scope-smaller, scope-larger, slow-commands, waiting, rework, padding, unclear-ask,
  other` (an unknown word is `other`, the word kept). The answer is stored as `eta.review` and a
  `review` row. `classifyAttempt` drops those two lines from the report, so `result`, `results`,
  checks and verdicts are unchanged. A daemon that is down just skips that one review.
- **Feeding it back.** `climayteScorecard().estimates` also has `recent` (the newest 20 settled
  samples) and `causes` (`{cause, n, medianRatio}` over the newest 100 reviews). From 3 reviews,
  `etaNote` adds the most common cause with its count and a quote (at most 160 characters) of the
  newest review of it, within about 450 characters in all.
- **Prompt versions (owner, 2026-10-06: "a loop that measures each prompt version so it keeps getting
  better").** The estimating sentences of `WORKER_BRIEF` are `ETA_INSTRUCTION` in `climayte-eta.ts`,
  numbered by `ETA_PROMPT_VERSION`. Every estimate records the version it was said under (`eta.prompt`,
  `promptVersion` on the ledger's said and settled rows and on `EtaSample`); one without it counts as
  version 1. Calibration (`etaCalibration`, `etaBandCalibrations`) reads only the current version's
  samples once there are `ETA_MIN_SAMPLES` of them for that kind or band, else all versions, so a better
  prompt is not corrected again for the old prompt's error. The review question has a third line,
  `ETA-PROMPT: <one change to the estimating instruction that would have made your estimate closer, or
  none>`, kept as `promptIdea` on the review. `climayteScorecard().estimates.byPrompt` has one entry per
  version: `samples`, median `ratio`, `closeShare` (ratio 0.8-1.25), `topCause` and the newest 5
  `ideas`. `estimates.rewriteDue` is `{ version, why }` when the current version has at least
  `ETA_REWRITE_MIN_SAMPLES` = 20 settled samples and a close share under `ETA_REWRITE_CLOSE_SHARE` = 0.5
  (the why names the samples, close share, median ratio and top cause), else null.
  - **When `rewriteDue` is set:** rewrite `ETA_INSTRUCTION` from the top cause and the `ETA-PROMPT`
    ideas, bump `ETA_PROMPT_VERSION`, and add the old text below to this history.
  - **v1** (until 2026-10-06): "Before your first tool call, write one line on its own, `ETA: <n> min`:
    your honest estimate of the working time the whole task will take you, checks included (write a
    new one for each later message you are sent, not when told to continue). The owner reads it to
    decide whether to wait, and AgentHydra compares it with the time it really took."
  - **v2** (2026-10-06): "Before your first tool call, write one line on its own, `ETA: <n> min`: the
    working time this whole task will take YOU, checks included. You are an AI agent: reading a file,
    writing an edit or running a quick command takes you seconds, not the minutes a person needs, so
    estimate at your own pace. Build the number: count the tool calls you expect at about 10 seconds
    each, then add the real run time of each slow command you will wait on (a test suite, a build, a
    deploy). Write the number that sum gives, unrounded (3, 7, 14). Write a new ETA line for each later
    message you are sent, not when told to continue. The owner reads it to decide whether to wait, and
    AgentHydra compares it with the time it really took."
  - **Why v2.** Over 10 days of transcripts, 315 ETA lines ran a median 0.61x of the real time (under 10
    min 1.01x, 10-19 min 0.58x, 20-39 min 0.60x, 40 min or more 0.22x) and 112 of them were exactly
    `ETA: 10 min`, a round default. Across 857 finished single-attempt workers the median pace was 10.7
    seconds per turn (quartiles 7.3 / 10.7 / 14.9) and a median task was 37 turns and 6.4 minutes. The
    workers complied but estimated at a human's pace and rounded to 10; v2 tells them their own pace
    and how to build the number.
- **Where it shows.** `climayte_status` rows carry `etaMin`, `etaLeftMin` (while live; negative is
  over) and `tookMin`; `climayteScorecard().estimates` has `all`, `byKind` and the current `note`.
  Desk 2's running-tasks row says "about N min left" from the latest estimate of a running worker,
  and its Background tasks panel shows each worker's estimate beside its time.
- **Not covered.** Sub-agents a Desk 2 chat starts with the Agent tool: Desk 2 does not see their
  text, so they have no estimate.

### Placement (`server/src/climayte-placement.ts`, `a6569b4`)

A task starts where it can FINISH, so it does not move. Run 1: of 101 attempts 23 ended done and 48
moved; a move re-writes the whole conversation into the next account's cold cache (a 200k
conversation is about 4% of a Pro 5-hour window) and cache writes were about a third of the meter.
The old score added a flat 100 per worker already on an account, so an idle account at 75% beat one
at 10% running one worker, and at the 23:30 reset twelve workers went four to an account onto three
Pro accounts, where tasks costing about a quarter of a window each could never all finish.

- `projectedPct(account, running, expected)`: the account's 5-hour usage now, plus what the work
  running there still owes (its expected cost less how far the meter rose since the first of it
  started, from each attempt's `startPct`), plus this task's expected cost; costs are in % of a Pro
  window and shrink by `planFactor` (Pro 1, Max 5x 5, Max 20x 20, from the CLI instance's plan).
- `expectedCost(task)`: from every finished task's work (re-reads left out), judged or not, blended
  from the broadest record to the narrowest: 25% (`DEFAULT_TASK_PCT`), its model family, its kind on
  any model scaled by meter weight, its kind on its family, its exact kind, model and effort. Each
  pulls the estimate toward its own average by its task count against `PRIOR_WEIGHT` 2 (`5bc5ba7`).
- `rankAccounts(..., placement)` (`pickAccount` is its first) ranks where `projected <= FIT_PCT`
  (85, the stop line, since `fc1ca87`) first: accounts at or behind their weekly pace, most behind
  first, then accounts ahead of it; where the task does not fit comes last, lowest projection first
  (it was `max(projected, week%)` plus only a positive pace gap, so a lower 5-hour projection won
  even on an account ahead of its pace). The tick passes it for every start, tries each account in
  that order until one takes the task (`scheduleWorker`), and adds each worker it starts to the
  projection before the next one is placed. When nothing fits, the
  lowest projection still wins: finishing part of the work and handing off beats waiting hours.
  A group with no `perAccount` from its dispatcher runs 2 workers per Pro window of the account
  (`groupCap`: 2 on a Pro, 10 on a Max 5x, under `maxPerAccount`; since 2026-10-03 an account ahead
  of its weekly pace is no longer halved).
- Weekly pace (owner, 2026-10-01, with several Pro accounts and a Max 5x: "just because the pro
  accounts have run low on usage does not mean you should begin immediately dumping everything into
  the 5X ... usage is usage, but it should smartly take into account the cool-down rate of
  up-and-coming accounts, the overhead it will take to do the work, what other things it can start
  or finish in the meantime"). The 5-hour windows refill every five hours; the week is what runs
  out. `paceGap(account)` is how many points its weekly usage runs ahead of the share of its 7-day
  window already gone (`weekPacePct`, from the reading's `weekResetsAt`); an account counts as ahead
  only past `PACE_BAND` (5 points: readings are whole percents, and 3% used with 2.74% of the week
  gone held 19 tasks), and ranks behind every account that is not. `waitsForCooldown` refuses an
  account that is ahead of its pace when another account the task may use (signed in, nobody
  else's, under the weekly stop line, under the group's cap) has no room for the task now, refills
  its 5-hour window (its reset, or the end of its limit wall) within 5 minutes
  (`RESUME_WAIT_MS`; it was 30, `COOLDOWN_WAIT_MS`, until the five-minute rule), has room for the task in a fresh window and is at least `PACE_BAND` less
  ahead of its own pace. An account the task already fits on is never waited for, and a refusal
  passes the task to its next account: the row waits ("Waiting for a reset: ...", `waitUntil` the
  earliest such reset) only when every account refuses it. A held task starts no session, but the
  wait is not free: 2026-10-02, 31 tasks waited 776 task-minutes for resets of accounts that had
  room all along. Never held: a session going on
  at home, priority work (`priority` above 0), a session that hit a limit or handed off (it is
  moving anyway), and anything when the weekly reset is unknown.
- **Someone else's account takes no new work** (`accountInUse`, 2026-10-02). Each account in the
  pool carries `handsOnAgoMs`, how long ago a hand used its linked desktop app (that app's
  `logs/main.log`, a message sent or a chat clicked in the last ten minutes; `core/hands-on.ts`, the
  twin of fan_out's check), and `otherSessions`, the Claude sessions running in its folder that are
  not CliMayte's (its live registry, matched by session id; the chat that sent the work counts).
  Either one takes the account off the list for new work. A session already living there carries
  on, and a task whose `accounts` names it still goes there. With only such accounts left, the
  task waits and its row names them: "Waiting for an account nobody else is using: #14 (its
  desktop app used 3 min ago) ...".

### The five-minute rule (owner, 2026-10-03)

"When a worker hits a five-hour or weekly limit, CliMayte moves it to another account and resumes
it, unless the limit resets in under five minutes; distribute the load." That day priority-1 tasks
sat "waiting" while accounts had room: a flat 4-worker cap per account, and waits for home and for
room with no time bound (one message, "expected to use about 22% of a Pro 5-hour window, and the best
account now has about 19% left", held 9 tasks). The rule: a task never waits more than
`RESUME_WAIT_MS` (5 minutes) while some account admits it. It supersedes the 2026-10-01 pace
cooldown wherever the two clash.

- **Waiting at home** (`waitsForHome`): a session stopped at its own account's limit resumes there
  only when that account frees up within 5 minutes; otherwise it moves at once. Priority work never
  waits.
- **Waiting for a reset** (`waitsForCooldown`): the reset horizon and the total time held
  (`heldForResetSince`) are both 5 minutes, and a session that hit a limit or handed off (its last
  attempt `quota` or `handoff`) is never held for pace.
- **Waiting for room** (`waitsForRoom`): only when an account whose fresh window holds the task frees
  up within 5 minutes (`fitFreesAt`, the helper `holdForRoom` uses for `waitUntil` too).
- **Workers per account** (`maxPerAccount`): `MAX_PER_ACCOUNT` (4) per Pro window, up to
  `ACCOUNT_WORKERS_CEILING` (8): Pro 4, Max 5x 8, Max 20x 8. How many sessions one account runs at
  once before the API refuses is unmeasured; the ceiling is one constant.
- **`per_account` spills.** It is a preference: when no account within it takes the task, the task
  goes to the best account past it (journal `spill`). The walls, the 85% line, `maxPerAccount`,
  someone else's account and a stale reading still apply. `per_account_strict: true` on
  `climayte_run` keeps it a hard cap for that group (kept with `perAccount` in `workers.json`).
- **The order in `scheduleWorker`:** the home step (above); then (1) the first account with no
  refusal; (2) spill, unless strict; (3) a room hold or a reset hold, only when it frees within 5
  minutes ("It starts by HH:MM either way"); (4) start short: the lowest projection with at least
  `MIN_START_ROOM_PCT` (10 Pro-points, times the plan) left under the 85% line (journal
  `start-short`); it runs to the stop line, hands off, and the continuation is placed again by itself;
  (5) wait. Under 10 points left a start would be asked to hand off at once (run 1's twenty hops at
  89-97%), so a task with no account of that much room waits for room; a task with no eligible
  account at all waits for one. A waiting row names the accounts with room that are at their worker
  cap ("#35, #101 have room but run 8/4 workers (their cap)").
- **Not converging** (`notConverging`): a move after a limit (`quota`) and a handoff the usage stop
  line asked for (`windDown.pct` set) are the rule working, so neither counts toward the moves or
  handoffs caps. The attempts cap (8) and the spend cap (3 times the estimate) still bound a task.

### Sizing (`server/src/climayte-placement.ts` sizeTask and waitsForRoom, `0c2c13b`)

Owner, 2026-10-01: estimate the size of the task, check the accounts' available usage, then send the
whole task or smaller ones. Max 5x and 20x accounts join the Pro ones, so every figure weighs the
plan: a Max 5x window holds five Pro windows (`planFactor`).

- **At dispatch** (`climayte_run`): each task's expected cost (`expectedCost`, under Placement)
  against the biggest window among the accounts it may use. Over half of it (`SPLIT_SHARE`) the whole dispatch starts nothing and answers
  `split needed` (HTTP 409 with `splitNeeded: [{task, title, expected, window, pieces}]`), with
  pieces that each stay under half; `size: 'whole'` on the task or the dispatch runs it as it is.
  Every task row carries `size` (stored at dispatch): the expected % and its basis in words, the
  biggest window, and the most room any account had (`room`, `roomOn`), all in % of a Pro window;
  `room` is re-recorded when the task starts waiting.
- **At start** (the tick): when the best account pickAccount finds would not hold the task to the
  end (projected over FIT_PCT) but a fresh window of an account it may use would, the task waits
  ("Waiting for room ...") and smaller tasks take that room; it starts first once an account has
  room (a reset, or the work there finishing). A session going on at home, and a task no window
  fits (sent `whole`), are never held. Since 2026-10-03 it waits only when such a window frees up
  within 5 minutes; else it starts short (see the five-minute rule).
- **Model weight** (`modelMultiplier`, usage-tokens.ts): Opus 5.5 2x Sonnet 5.5, Fable 5x, Haiku 4.5
  and older 0.5x, Haiku 5.5 0.14x. Haiku 5.5's price is 0.05x Sonnet for a prompt of 100,000 tokens or
  fewer and 0.25x over; on CliMayte's measured traffic 45.6% of the meter weight sits on requests over
  100k, so 0.05 x 54.4% + 0.25 x 45.6% = 0.14. A Haiku 5.5 task is sized at that weight.
- **Why half:** run 1's 49 finished tasks averaged 24% of a Pro window and 80% stayed under 36%, but
  single tasks ran to 93% and 107%, and code on Opus high (33% on average) moved 33 times over 19
  tasks. An estimate is an average; over half a window a task runs past the whole one often enough
  that pieces cost less than its moves.
- A waiting task carries `waitUntil` (ISO, UTC): when the first of its accounts frees up, a usage
  wall's end or else its 5-hour reset; waiting for room, the first reset of an account whose fresh
  window holds it. A waiter sleeps until it rather than parse the error text's local time.
- An attempt's spend is read from the folder it ran in (`account.configDir` on the attempt), not from
  wherever the instance store points now.

### Memory (`server/src/climayte-memory.ts`, owner, 2026-10-04)

Owner, 2026-10-04: the same progress with less memory and CPU; memory is the cause, CPU the side
effect. Placement weighs the accounts; this weighs the machine.

- **What happened:** 33 workers ran at once beside the owner's own work on a 63 GB PC. Free RAM
  swung between 0.5 and 5.8 GB, commit stood at 157-170 GB of a 165-177 GB limit, and Windows spent
  about 5 of 32 threads compressing and paging memory. A worker started past that line adds no
  progress: everything on the box slows, and at the commit limit allocations fail (a CLI dies, a
  check goes red for the machine).
- **The gate** (startOn, every start path: the pick, a spill, a short start): a start waits while it
  would leave free RAM under 8% of the machine (`FREE_FLOOR_SHARE`, fairjob's floor) or, on Windows,
  commit under 5% of its limit (`COMMIT_FLOOR_SHARE`). The commit check counts every worker as
  `WORKER_COMMIT_BYTES` (0.75 GB private: 24.5 GB over the 33 worker trees measured that day). The
  RAM check counts working set, not private bytes (2026-10-06: about 0.45 GB a grown tree, learned
  as the median of workers older than `RAMP_MS`, re-read each minute, clamped 0.25-1.0 GB): free RAM
  already excludes what running workers hold, so a worker that started within `RAMP_MS` (2 minutes)
  reserves only what it has left to grow (its tree's working set read now, runner pid and
  descendants), a tree that cannot be read and the start itself reserve the full amount.
- **Held, not refused:** the task stays `queued` with "Waiting for memory: ..." (journaled once, not
  every tick) and starts on the first tick with room, highest priority first (`dueOrder`). Nothing
  running is stopped or slowed. The spill and start-short journal lines are written only when the
  start goes ahead (`goesNow`).
- **Capacity:** with no room for a worker, `climayteCapacity` reports `idle: 0`, so check_my_usage
  tells a chat there is no room to hand work over.
- **Reading:** Windows `GlobalMemoryStatusEx` (bun:ffi, opened once; available physical and the
  commit charge); Linux `/proc/meminfo` MemAvailable, no commit floor (overcommit makes it no
  limit). macOS and a failed read give no reading, and no reading holds nothing: os.freemem on macOS
  leaves out reclaimable memory and would hold every task on a healthy machine. Off under tests
  unless a test sets `setCliMayteMemoryReader`.

### Journal (`server/src/climayte-journal.ts`)

The owner's ask on the first real run ("we probably also need logging in CliMayte"): one short JSON
line per state change of every worker, appended to `<CONFIG_DIR>/corch/journal.jsonl`. At 5 MB it
rotates to `journal.1.jsonl` (one previous file kept). A failed write is logged and dropped; the
journal never stops a worker.

```ts
interface CliMayteJournalEntry {
  ts: string; id: string; group: string; title: string; event: CliMayteJournalEvent
  account?: string            // '#84', or the name of an account without a number
  from?: string; copied?: boolean            // moved
  attempt?: number                           // 1-based
  sessionPct?: number | null; weekPct?: number | null; active?: number  // launched: why it was picked
  notice?: string; until?: string            // limit: the CLI's words and the wall's end (ISO)
  pct?: number | null; path?: string         // handoff-requested / -written
  pending?: number; urgent?: boolean         // follow-up-queued; cancelled: messages kept
  retry?: number; waitS?: number             // retry / interrupted
  costUsd?: number; turns?: number; totalCostUsd?: number  // done / turn-done
  error?: string                             // failed / waiting: the first line
  said?: string                              // turn-end: the turn's closing text, first line
  cwd?: string; accounts?: number            // dispatched
  model?: string | null; effort?: string | null  // dispatched, launched, follow-up-*, handoff-resumed
  priority?: number; was?: number            // dispatched (its priority) / priority (new and old)
}
```

Events: `dispatched`, `launched` (with the account's session/week % and how many workers it already
ran, the two things `pickAccount` scores on), `moved`, `limit`, `signed-out`, `handoff-requested`,
`handoff-written`, `handoff-resumed`, `follow-up-queued`, `follow-up-delivered`, `retry`,
`interrupted` (its CLI ended with no result: killed from outside, or a pre-runner worker at a
restart), `waiting`, `turn-end` (each turn's closing
text, first line), `turn-done`, `priority` (changed by `climayte_priority`), `spill` (started past
its group's `per_account`, `notice` says why), `start-short` (started with less room than its
estimate, `notice` says how much), `done`, `failed`, `cancelled`. Read with `climayteJournal(filter)` (entries, oldest first, the newest `limit`, default
100) or `climayteJournalLines(filter)`, one readable line each, e.g.
`23:41:07 w-1234abcd 'Fix events rows' launched on #84 (session 12%, week 0%, 0 active)`; when a
model or effort was asked for, the line ends ` with claude-opus-5-5, effort max`.

### Pings to the dispatching chat (`server/src/climayte-ping.ts`, owner, 2026-10-03)

Owner, 2026-10-03: "when a chat finishes, it pings the orchestrator that started it", and a worker
that is five-hour or weekly limited and moved is reported to that chat too. Until then a chat only
learned by polling (`climayte_status`, or a background `climayte_wait.py` it had to remember).

**Origin.** Every worker can carry an `origin`, saved with it in `workers.json`:
`{ kind: 'chat', sessionId, home, transcript, how }` (the dispatching chat and the Claude home whose
live registry reaches it) or `{ kind: 'worker', workerId }` (a manager worker). It is only ever set
from the caller the daemon itself resolved: `climayte_run`, `climayte_manage` and `climayte_status`
are caller-aware (`CALLER_AWARE_TOOLS` in `mcp-self.ts`), so the MCP route binds them to the calling
process, and the tool turns that into the chat's transcript (`callerOrigin`, using
`resolveOwnTranscript`, whose answer now names its `home`). An `origin` key a client writes into
its own tool arguments is ignored. The tool posts the resolved origin to `POST /api/corch/workers`
(or `/api/corch/waves`), and the route checks it again before storing it: `sessionId` must be a
UUID and `home` an absolute folder that exists; a malformed one is dropped and pings are off for
that dispatch. `notify: false` on `climayte_run` / `climayte_manage` sends no origin at all.

- A `climayte_run` whose caller is itself a CliMayte worker's session gets
  `{ kind: 'worker', workerId }`: the worker hears of it through `climayteSend` (non-urgent), never
  its transcript. Wave tasks (`wave_dispatch`) get no origin: the wave report already wakes the
  manager. The manager worker carries the origin of the chat that called `climayte_manage`.
- The tool's answer says which: `ping: "on: <first 8 of the session id> is messaged when work
  settles (<how>)"`, `ping: "on: manager <id> is sent a message when work settles"`, or
  `ping: "off: <why>; run python ~/.claude/tools/climayte_wait.py --group <g>"` (the owner's waiter script, which polls the workers endpoint until the group settles; see [CLIMAYTE-FIELD-NOTES.md](CLIMAYTE-FIELD-NOTES.md)).

**What triggers a ping.** Each worker change is diffed against the last snapshot of that worker.
Things the chat must act on: done with the check passed, done and needing a verdict, check failed
(sent back or not), failed, cancelled, the group settled. Things it only needs to know: limited and
moved (an account hit its 5-hour or weekly limit and the work resumed on another), stuck (waiting
more than 5 minutes, the five-minute rule's bound).

**Batching** (so fifteen finishes cost the chat one turn, not fifteen): a settled group, or an origin
with no live work left, goes out 10 s later; otherwise the first event the chat must act on opens a
window that closes after 90 s of quiet or 5 minutes after it opened, whichever is first. Each ping
is now a real turn of a large chat, so while the same origin still has live (or asking) workers, a
`finished` or `needs-verdict` line is held and wakes nothing: it goes out with the next waking line
(failed, check-failed, cancelled, asking), when its group settles, when the origin has no live work
left, or `HOLD_FINISHED_MS` (30 minutes) after the oldest held line, so a straggler cannot hide
finished results forever.
Information-only events ride along with the next batch, or go alone after 30 minutes. A 15 s
heartbeat catches stuck workers and due batches. The outbox is `<POINTER_DIR>/climayte/pings.json`:
an event is written pending before the send and marked delivered only once the send is confirmed, so
a daemon restart replays what was not delivered and never what was.

**The message**, plain text, ids and reasons only (never a prompt, a report, a verdict note, or an
error a worker wrote or its stderr, so worker text never enters the chat). A failed worker's bullet
names CliMayte's own reason (`failedReason`: not converging, overloaded, its check failed, its CLI
run ended in an error, ...) and ends `details in climayte_status`, because a failed attempt's error
can be the worker's own report:

```
[AgentHydra · CliMayte] Not from the user. Ping 3-5, 3 updates since 14:02:
• w-1a2b3c4d "Fix events rows": #94 hit its 5-hour limit; resumed on #102 after 12s.
• w-1a2b3c4d "Fix events rows": done on #102, needs your verdict.
• w-5e6f7a8b "Docs": done on #84, check passed.
Group g-1f2e3d: 2 done, 0 failed, 0 running, 1 waiting.
Next: climayte_status {group:"g-1f2e3d", report:true}, then climayte_verdict.
```

When every group in the ping has ended (nothing queued, waiting, running, checking or asking), one
more line tells the chat to carry the job on, as Claude Code's main chat does when its subagents
finish: their work can be unfinished or broken, so it checks each proof, fixes or re-dispatches
what is left, and tells the owner it is done only when the whole ask is.

At most 15 bullets (`+N more` after that), one tally line per group.

**Delivery, in order.** (0) A chat Hydra Desk 2 runs (its current or a past session): `POST
${DESK2_URL}/api/sessions/:id/ping`, which resumes a closed chat and starts a turn, or queues behind a
running one, and never titles the chat. The peer pipe only queues a note in an idle chat (no turn,
so it was seen at the next tool call), and a closed chat has no pipe at all. A 404 (not a Desk 2
chat) or Desk 2 being down goes on to step 1; any other failure is journalled (`step: desk`) and
goes on too. (1) The chat's own peer pipe (`peer-message.ts`, found through `home`'s live
session registry; it queues behind a running turn). A write the pipe accepted is delivered, once:
a chat mid-turn (inside a long `climayte_status` wait, say) shows it when the turn ends, so its
transcript not growing within 45 s is journalled as `ping-unconfirmed` and never sent again (each
resend queued another copy). An origin without a transcript is not waited on at all. (2) While the
chat has no pipe, or the pipe refused the write, the same again every 2 minutes for 2 hours.
(3) Then, only for a failed or settled group on a desktop chat whose instance is running, the
composer (`POST /api/sessions/:id/message`). (4) Last, one OS toast, and the batch is kept as that chat's unread pings, which its next
`climayte_status` shows (`unreadPings`) and marks read. A `worker` origin gets the text through
`climayteSend` instead.

**Adopting a running group.** Work dispatched before origins existed, or by a caller that could not
be traced, has no origin. `climayte_status { group, ping: true }` makes the calling chat the origin
of that group's live workers that have none, and only those (a worker another chat or manager owns
keeps its origin); it answers `adopted` (how many) and a `ping` line like `climayte_run`'s.

**Kill switch.** While the file `<POINTER_DIR>/climayte/ping-off` exists (`~/.agenthydra/climayte/ping-off`
on a normal install), nothing is recorded or sent, and dispatches answer `ping: "off: ..."` naming
the file. Delete it to turn pings back on. `startCliMayte()` starts the outbox (`startCliMaytePing`
with the real worker feed and transports) and daemon shutdown stops it (`stopCliMaytePing`).

### Moving a worker to another folder (`climayte_send { cwd }`, owner, 2026-10-04)

Hydra Desk moves a chat to another folder when Claude cd's out of its folder; a chat that is a worker
kept its original `cwd`, so later turns still ran in the old one. `POST /api/corch/workers/:id/send`
and `climayte_send` take an optional `cwd`. It is checked like a task's folder (`validateCwd`,
`server/src/climayte-cwd.ts`): an absolute path to an existing folder on this PC; a relative path, a
missing folder, a file, a UNC share (`\\host\share`) or a device path (`\\?\`) is refused with
400 and nothing is queued. A good one sets `worker.pendingCwd` and journals `cwd-changed` (`pending`).
Nothing moves until the next launch (a running worker gets the message when its task ends, or at once
with `urgent`): `applyPendingCwd` copies the session's `.jsonl` and its sidecar folder into
`<configDir>/projects/<encoded cwd>/` on the account the launch runs on (Claude Code resumes only from
there), keeps the original, sets `worker.cwd`, clears `pendingCwd` and journals `cwd-changed` (`cwd`,
`from`, `copied`). A session that ran but cannot be copied stays in its old folder (journaled with an
error) rather than start over empty there. A fresh session just starts in the new folder.
`climayte_status` shows `cwd` and, until the launch, `pendingCwd`.

### Questions from a worker (`climayte_ask`, owner, 2026-10-04)

A headless worker could never ask, so it guessed. Owner: "all the CLI mates can ask questions
themselves properly. Those questions should be handled by the AI that started them, not me. Only if
the question is confusing or needs me should it ask me."

**The tool.** `climayte_ask { question: string, options?: string[], context?: string }`, on a
per-worker MCP server named `climayte-worker` (`server/src/climayte-ask-mcp.ts`). Workers are denied
AgentHydra's own MCP, so every worker's settings carry an http server at
`/api/corch/ask/<workerId>` (written by `writeWorkerMcp`, only when the account has an owner Claude
dir). The route answers only when the caller's socket pid is the worker's latest attempt's CLI
(`attemptCliPid`: the attempt's pid, or the `child` pid its runner wrote, read on the spot because the
CLI connects to its MCP servers a second or two after it starts, before the daemon's poll takes that
pid); any other caller gets **404**, so a worker can ask only for itself. Never 401 or 403: Claude Code
(2.1.286) reads both from an http MCP server as "needs authorization" and caches that in the
account's `mcp-needs-auth-cache.json` for 15 minutes, keyed by server name. Measured 2026-10-04: a 403
while the attempt's pid was still unread marked `climayte-worker` needing sign-in on account #35 and
on another account 2 to 5 s after their workers started, and every worker on those accounts in the
next 15 minutes skipped it without connecting; a real `claude -p` against a probe server showed a 403
server as `needs-auth` (and cached) and a 404 one as `failed` (not cached). Each launch also takes
`climayte-worker` and `climayte-manager` off the account's cache (`forgetOwnNeedsAuth`). The manager
endpoint answers the same way.

**What it does.** Only a running worker can ask. `climayteAsk` records `worker.question`
(`{ text, options?, context?, at }`), journals `asked`, and answers "End your turn": the CLI process is
never held open. The turn that ends after it is not a finish: `finish()` leaves the worker `done` with
its question set, and does not judge it, start a check or add it to a wave batch.

**Where it shows.** `climayte_status { id }` and the report/brief rows carry `question` (the first 400
characters in a report), the CliMayte worker detail has an "Asking" block (question, options,
context), and the origin gets a ping.

**Routing to the origin.** The ping kind `asking` (key `<id>:asking:<question.at>`) flushes urgently and
names the worker and the question text (the one exception to "no worker text in pings"); it is not a
"needs your verdict" and a group with a questioning worker is not settled. A chat origin gets the
peer ping (composer fallback, then the unread pings); a worker origin gets it through `climayteSend`
as its next message. With no reachable origin the question shows in the CliMayte view and in
`climayte_status` for the owner. The ping ends with: answer it yourself from the task context with
`climayte_send { id, text }`; ask the owner only when it needs a decision only they can make.

**The answer.** The existing `climayte_send { id, text }`: it resumes the same session with the text and
deletes `worker.question`. `climayteCancel` clears it too.

**The contract.** `WORKER_BRIEF` tells a worker to use `climayte_ask` only when blocked on a real
decision, and otherwise to make the reasonable call and say which.

Tests: `server/tests/climayte-ask.test.ts`.

### API (what routes and MCP call)

```ts
export function climayteRun(input: { tasks: Array<{ prompt: string; cwd: string; title?: string; model?: string; effort?: string }>; group?: string; accounts?: string[]; perAccount?: number; model?: string; effort?: string }): { group: string; workers: CliMayteWorkerView[] }
   // top-level model/effort: the group default for tasks without their own; tasks and the top
   // level also take `priority` (whole number, default 0, higher starts first)
export function climayteList(filter?: { group?: string; id?: string; active?: boolean; limit?: number; brief?: boolean }): CliMayteWorkerView[] | CliMayteWorkerBrief[]
   // `limit`: every active worker plus only that many most recently finished ones, newest first
   // (recentWorkers); `brief`: without the prompt, and only the last 3 attempts (+ attemptCount)
export function climayteGet(id: string): (CliMayteWorkerView & { events: string[] }) | null  // events = last 60 summarised lines
export async function climayteWait(filter: { group?: string; id?: string }, timeoutMs: number): Promise<CliMayteWorkerView[]>
   // resolves on the first status change in scope, or at timeout, with climayteList(filter)
export function climayteSend(id: string, text: string, opts?: { urgent?: boolean; model?: string; effort?: string }): { ok: boolean; message: string; model?: string | null; effort?: string | null }
   // to a running worker: held until its task ends; `urgent` stops the running work and sends it first
export function climayteDeliverNow(id: string, text?: string): { ok: boolean; stopped?: boolean; message: string }
   // Send now on a HELD message (Hydra Desk 2): stops the running turn like `urgent` and continues the same
   // session with that message first (prefaced by SENT_NOW_PREFIX, which Desk hides), adding no second copy;
   // `text` picks the held message (equal, else the first containing it), else the oldest; nothing held → stopped false
export function climayteHandoff(id: string): { ok: boolean; message: string }
export function climayteSetPriority(id: string, priority: unknown): { ok: boolean; message: string; priority?: number }
   // a whole number -1000..1000; reorders queued/waiting work, never stops a running attempt
export function climayteCancel(filter: { id?: string; group?: string }): { cancelled: string[]; keptMessages: number }
   // queued follow-ups are kept and delivered, in order, when the worker is continued
export function climayteJournal(filter?: { group?: string; id?: string; since?: string; limit?: number }): CliMayteJournalEntry[]
export function climayteJournalLines(filter?: …): string[]
export function startCliMayte(): void
```

`CliMayteWorkerView` = the worker minus `prompt` beyond 300 chars and minus attempt log paths, plus
`account` (`#<num> <name>` or null), `ranS` (seconds it ran: the sum of its attempts, not the time
since it was created), `reportedModel` (the model the CLI reported at init on the newest attempt
that got that far), and `attempts` as `{ account, outcome, notice, requested?, model? }`.
Validation: `cwd` must be an existing directory; `prompt` non-empty; `perAccount` 1..4, default 2 per Pro window of the account (`groupCap`); it spills past the cap unless `perAccountStrict` (see the five-minute rule).

## Server: quick add, `server/src/core/cli-quick-add.ts`

```ts
export interface QuickAddFlow { id: string; email: string; instanceId: string; num: number | null;
  state: 'waiting' | 'signed-in' | 'failed' | 'cancelled'; url: string | null; message: string;
  account: { email: string | null; plan: string | null } | null; startedAt: number }
export function startQuickAdd(email: string): QuickAddFlow | { error: string }
export function getQuickAdd(id: string): QuickAddFlow | null
export function listQuickAdds(): QuickAddFlow[]          // the last 20, newest first
export function submitQuickAddCode(id: string, code: string): { ok: boolean; message: string }
export function cancelQuickAdd(id: string): { ok: boolean; message: string }
export async function cliAuthStatus(configDir: string): Promise<{ loggedIn: boolean; email: string | null; plan: string | null }>
```

- Email: trimmed, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. If a CLI instance is already named exactly that
  email, re-sign that instance instead of creating a new one (a stale login gets fixed the same
  way); else `createCliInstance(email)`.
- Spawn `[resolveClaudeExe(), 'auth', 'login', '--email', email]` with `CLAUDE_CONFIG_DIR` set,
  the same env scrub as CliMayte, `stdin: 'pipe'`, `stdout`/`stderr: 'pipe'`, `windowsHide: true`.
  Do NOT set `BROWSER`: the CLI opens the person's default browser on the sign-in page with the
  email already filled in; that page is the step the owner asked to do himself. The daemon never
  types a credential.
- Read stdout; the line `If the browser didn't open, visit: <url>` gives `url` (the manual-code
  page). The CLI then waits on `Paste code here if prompted > ` for the fallback code, which
  `submitQuickAddCode` writes to stdin followed by `\n`.
- On exit code 0, `cliAuthStatus(configDir)` (runs `claude auth status --json` with that
  `CLAUDE_CONFIG_DIR`, 20 s timeout; reads `loggedIn`, the email field and the subscription
  field when present). Signed in → state `signed-in`, rename the instance to
  `<email> (<plan>)` when the plan is known. Otherwise `failed` with the CLI's last output line.
- 10-minute timeout → kill (`killProcessTree`), `failed`. On `failed`/`cancelled` a NEW instance
  that never signed in is deleted again (`deleteCliInstance(id, name)`); a re-sign of an existing
  instance is left as it was.

`cliAuthStatus` exists because `isLoggedIn` only checks that `.credentials.json` exists, and a
hollow or revoked credential file passes that check (measured 2026-09-30: two instances with the
file present answered `loggedIn: false`).

## The nudge: `server/src/session-keepalive.ts` (owner, 2026-10-01)

When a signed-in CLI account has no 5-hour window running (its reading has no reset time, or the
reset is in the past), the keepalive sends it one cheap prompt so the window starts now and resets
sooner. Off by default (it spends quota); on in **Settings → Instances → CLI** ("Keep windows running", with its weekly floor; the CLI table's gear opens it).

- A nudge: `claude -p 'Reply with the single word: ok' --system-prompt <one line> --model
  claude-haiku-5-5 --effort low --max-turns 1 --tools '' --disable-slash-commands --no-session-persistence
  --output-format stream-json --verbose` plus `CLAUDE_PROBE_NO_MCP_ARGS`, in `scrubbedEnv(configDir)`
  with `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, `windowsHide`.
  Measured on three idle Pro accounts: $0.040 a nudge at list price with the CLI's default system
  prompt, $0.028 with the one-line prompt, $0.018 with the 5-minute cache too; the 5-hour meter
  read 0% after it. It counts as started when the CLI's own `rate_limit_event` or the usage check
  after it shows the window running.
- Why Haiku 5.5: the owner asked for the cheapest model at the lowest effort (2026-10-01). The old
  "never Haiku, however mechanical the task" (2026-09-06) was about Haiku 4.5, which is never used
  here (owner, 2026-10-07); Haiku 5.5 is allowed and preferred. The nudge names the full id, never
  the `haiku` alias, which an older CLI resolves to Haiku 4.5.
- Skipped: a signed-out or org-disabled login (listCliInstances lists it `loggedIn: false`), an
  account CliMayte walled at a limit, one with a Claude session running (its live registry, CliMayte
  workers included), one at or above the weekly floor (85, the owner's line), an unreadable reading,
  one nudged already whose window still runs, one whose last nudge failed within the hour.
- When: after every usage sweep (30 minutes), and on a timer at the soonest window end among the CLI
  accounts plus 90 seconds (`armKeepalive`, usage-refresh.ts), and at once when the switch is turned
  on (`keepaliveSettingsChanged`, the settings route).
- Records: `<DATA_DIR>/keepalive.json` (last nudge per instance id: `at, ok, note, resetsAt, model,
  costUsd`), shown on the CLI row as a timer icon (`lastNudge` on GET /api/cli-instances), and a
  journal line per nudge: `climayte_log { group: 'keepalive' }`, event `nudged`.

## Carrying a CLI login to the other PC: `server/src/core/cli-login-move.ts` (owner, 2026-10-01)

An export COPIES by default (owner, later the same day: "Make it not sign out when transferring. I
sometimes need both to stay logged in."); "Also sign this PC out" makes it a move. Two PCs signed in
to one login stay working only with login sync (below).

A login used on two PCs is two processes refreshing one OAuth session, and the other PC's copy can
end up unable to refresh ("OAuth session expired and could not be refreshed", the #88 symptom). So
a login lives on one PC, and moving it is export here, this PC signed out in the same step, import
there.

- Export (`POST /api/cli-instances/move-out { ids, passphrase }`, the row menu's "Move login to
  another PC"): all or nothing; refused while a session runs on a login or when its credential file
  holds no refresh token. Writes `agenthydra-logins-<host>-<stamp>.ahlogins` to Downloads: the
  numbers, names and plans in the clear, the `.credentials.json` text and the `.claude.json`
  `oauthAccount` block AES-256-GCM encrypted under scrypt (N 2^15, r 8, p 1) of the passphrase. The
  bundle is read back and opened before any login is signed out; then each `.credentials.json` is
  removed and the record gets `movedAway { at, file }` (a row icon).
- The passphrase is made in the web dialog (24 characters, 120 bits), sent once, never returned.
  No MCP tool on purpose: a chat would have to hold it.
- Import (`POST /api/cli-instances/move-in { bundle, passphrase }`, the header's import button):
  the same instance id first, then the same account (the email in a `.claude.json` or a
  "<email> (<plan>)" name), else a new instance under the same id, with the same number when this PC
  never used it (`claimInstanceNumber`). Refused for an instance with a session running or one
  signed in to another account. Then `claude auth status` on each, and a usage check.
- Hardened after review (2026-10-01): the bundle opens only with exactly the scrypt cost written
  (N 2^15, r 8, p 1, a 16-byte salt, 12-byte IV, 16-byte tag; a crafted p fit under maxmem and
  would have held the event loop for an hour) and only when its readable list matches the sealed
  one; export signs out only a login whose file is still byte-for-byte what was sealed and that no
  session holds; import replaces a login signed in here only with the same account's newer one
  (fail closed when either account is unknown; the same file twice reports "Already here"); a
  failed temp write is removed.
- Verified live twice on #84 (2026-10-01): out of this PC, into a separate AgentHydra home standing
  in for the other PC (created under the same id and number #84, `claude auth status` passed), out
  again, and back here (matched by id, signed in, usage read normally).
- How the file travels: by hand (Downloads, any way the owner likes), or not at all once login sync
  is on, which carries every login by itself.

## Login sync: `server/src/core/cli-login-sync.ts` and `cloud/login-sync-worker/` (owner, 2026-10-01)

"Give me the ability to utilize something like a cloudflare worker ... so I can just point the login
manager at my cloud thingy, and it manages and syncs my logins between the 2 PCs." Both PCs keep the
same logins signed in; a refresh on one reaches the other within a pass.

- The store (`cloud/login-sync-worker/worker.js`): a Cloudflare Worker over D1 (strongly
  consistent), versioned blobs keyed by CLI instance id, PUT compare-and-swap on the version (409 with
  the current one), a bearer token checked against the `TOKEN_SHA256` plain-text binding (only the
  hash lives in Cloudflare). The owner's: `agenthydra-login-sync` on the Lunawerx account's
  workers.dev, D1 `agenthydra-login-sync`, deployed through the Connections MCP
  (`cloudflare_worker_deploy`, value-blind).
- On a PC: `<CONFIG_DIR>/login-sync.json` holds the address, the DPAPI-sealed token and 32-byte key,
  the on switch, the logins left out, and per login the store version and credential hash this PC
  last agreed on. Every 30 s (`startLoginSync`) and on Sync now: a login changed here since that
  agreement goes up (even while a session runs: the file is what that CLI last wrote); when the
  store moved on, the copy whose access token expires later wins (a refresh pushes the expiry out);
  a newer copy lands through `landLogin` (the import's guards); a login only the store holds gets an
  instance here with the same id and number. A landed login is recorded by what was landed, so a
  refresh its sign-in check makes still goes up.
- Each login is AES-256-GCM encrypted under the key with its instance id as associated data. The
  pairing code (`ahsync1:` + base64url of address, token, key) is the only way the key leaves a PC:
  the dialog's copy button, for the other PC's Join.
- Left out on a PC (`excluded`): the dialog's per-login switch, a Log out there, a move away. Neither
  uploaded nor landed there.
- Routes: `GET /api/cli-instances/sync` (status, no secrets), `POST .../sync/setup {url, token}`,
  `.../sync/join {code}`, `.../sync/run`, `.../sync/enabled {enabled}`, `.../sync/exclude {id,
  excluded}`, `.../sync/pairing` (the copy button's code), `.../sync/disconnect`. No MCP tools.
- Verified live (2026-10-01): health, 401 without or with a wrong token; this PC uploaded its 10
  signed-in logins (#69 stays out: its credential file has no refresh token); a separate
  AgentHydra home joined with the pairing code, landed all 10 under the same numbers (#83-#103) and
  `claude auth status` passed for each; both sides' next passes found all 10 unchanged.
- The test (`server/tests/cli-login-sync.test.ts`) runs the real Worker on bun:sqlite behind D1's
  API and plays the other PC through the store: a refresh there lands here, one here goes up, one
  made by the sign-in check goes up, an older copy never wins, a left-out login stays put.

### Two PCs: the shared queue, `server/src/core/climayte-queue-sync.ts` (owner, 2026-10-02)

"Sync the CliMayte queue in the login sync as an additional toggle, so that if I have my two computers
running they can see the CliMayte queue and not override each other." With login sync set up and the
toggle on (`POST /api/cli-instances/sync/queue {enabled}`; `shareQueue`, off by default, in
`login-sync.json` beside this PC's `pcId`), each login-sync pass also uploads a snapshot of this PC's
queue under its `pcId` and reads the other PCs'. The snapshot is the queued, running, waiting and
checking workers plus those finished in the last 24 hours (id, title, group, status, kind, model,
effort, account, times, active time, cost, last activity, error, verdict, and the last name of its
folder, "AgentHydra" for `D:/x/AgentHydra`: never the prompt, results, logs or paths; an HSwarm job
carries its caller's folder's last name the same way, so the other PC's Hydra Desk files a chat it
does not have under that folder's group, owner 2026-10-06) and this PC's newest live usage reading per
account, gzipped and AES-256-GCM encrypted
under the sync's key with `climayte-queue:<pcId>` as associated data. Over 256 KB the oldest finished
workers go first. It is uploaded at once when a worker changed, when this PC's live readings moved
(percentages in 5-point steps, reading times ignored) at most every 10 minutes, and never just to
say it is alive (2026-10-03: the old 60 s heartbeat and an upload per usage reading cost ~2,300 D1 rows
read an hour while idle; the later 15-minute heartbeat still cost ~50 of 60 rows an hour). Liveness
rides the store polls: each PC names itself on every changes poll and the Worker answers when it last
saw the others (`x-seen`); a PC not seen for over 20 minutes, by snapshot or poll, is stale (it is off
or not syncing). The rows live in the store's own `queues` table, never in
`logins`: an older AgentHydra would land a `logins` row it does not know as a junk CLI login.

Placement here counts the other PC's running and checking workers toward each account's per-account
cap, and uses its live reading of an account when it is newer than this PC's own; a stale snapshot
counts for nothing. Nothing of the other PC is written to this PC's `workers.json`, and this PC never
cancels, sends to or judges its workers. `GET /api/corch/remote` answers `{enabled, pcs: [{pc, name,
at, stale, workers}]}` for the view's cloud-icon rows (empty when off); `/api/corch/workers` and the
MCP tools are unchanged. A queue that cannot sync (a Worker without the queue routes, a conflict, the
network) is `queueError` in the sync status and one line in its events, never the logins' `lastError`.
The Worker needs redeploying once for the queue routes. Test: `server/tests/climayte-queue-sync.test.ts`.

### Two PCs: the desktop chats switch (owner, 2026-10-02)

Beside the queue switch, the Login sync dialog has a second one, set per PC and on from setup since
2026-10-05 (owner: "sync desktop chat should be default on"; `POST /api/cli-instances/sync/chats
{enabled}`; `chatsOff: true` in `login-sync.json` when turned off, and the `shareChats: false` setup
wrote there before is not read). On, each pass
hands the visible Claude Desktop chats to `core/desktop-chat-sync.ts`: compressed, encrypted under the
sync key, with the PC each came from. The chat pass starts after the logins' part is written and is not
waited for; a second one never starts while one runs. Its state file `desktop-chat-sync.json` sits
beside `login-sync.json` and survives turning the switch off. Status carries `shareChats`,
`chatsError` (apart from `lastError` and `queueError`) and `chats` (empty while off). Test:
`server/tests/cli-login-sync-chats.test.ts`.

**View only (owner, 2026-10-05):** "I don't want them to actually sync back and forth. I just want to
view the ones running on his computer, and he can view the ones running on mine." The two-way sync had
landed the other PC's chats in this PC's Claude Desktop sidebar (written into `~/.claude/projects` ([CLAUDE-CONFIG-LAYOUT.md](CLAUDE-CONFIG-LAYOUT.md)),
then imported), where someone could go on in them and send turns back. Now:

- Only the PC a chat started on (`origin.pc`) writes it. A copy of another PC's chat is never sent,
  however it grows here.
- Another PC's chats come down into the viewer, `DATA_DIR/remote-chats/<project>/<session>.jsonl`
  (`REMOTE_CHATS_DIR`), never into `~/.claude` ([CLAUDE-CONFIG-LAYOUT.md](CLAUDE-CONFIG-LAYOUT.md)) or a desktop chat list. The session list reads it as a
  Claude store marked `remote`, so Sessions and Desk 2's cloud list show those rows with `from_pc` and
  the origin's title and archive state.
- When the store's copy of a PC's own chat is not what that PC last wrote (a chat the two-way sync
  marked `diverged`, or one a PC still on that version wrote into), the starting PC deletes the
  session's rows, which takes the transcript chunks with them, and sends its own transcript again from
  byte 0.
- A chat the two-way sync landed is taken back out once (`retire` in `core/desktop-chat-local.ts`): its
  desktop records are archived (never deleted) and every copy of its transcript moves into the viewer.
  It stays where it is if someone on this PC went on in it, and the viewer then downloads its own copy.
  On MPC-HELL that took out Jacob's 3 chats (4 transcript files: one he had moved between folders had
  been written under both).

**Hydra Desk's chats too (owner, 2026-10-07):** turning on the cloud in Desk 2's sidebar "should show me
... all chats between both of our computers". Only Claude Desktop chats were shared, so a PC whose owner
works in Hydra Desk shared almost nothing: on 2026-10-07 the other PC's 23 chats that started CliMayte work
in three days had none in the store, against its 6 desktop chats. `core/desktop-chat-local.ts` now lists
the chats of Jacob's Desk and of AgentHydra 2.0's window (`chats.json` in `~/.hydra-desk` and
`~/.hydra-desk-2`, never a throwaway Desk's home) beside the desktop records, view only like them. A
chat's transcript is read from its account's own folder (`account.configDir`, else the default login's config dir `~/.claude`, [CLAUDE-CONFIG-LAYOUT.md](CLAUDE-CONFIG-LAYOUT.md)); a
session a desktop record already lists goes once, as that record; one idle over a week that was never
shared is held back (`holdBack`, `DESK_IDLE_MS`), so the store's room goes to what runs. A PC shares its
Desk chats once it runs this version; the PC that views them needs nothing new.

Tests: `server/tests/desktop-chat-sync.test.ts`, `server/tests/desktop-chat-local.test.ts`.

The store stays small (2026-10-03): a chat archived three days ago leaves it, row and transcript, and is
never sent again (`ARCHIVED_KEEP_MS`); the Worker refuses chunks past 400 MB of chats (`CHAT_STORE_MB`
raises it), under D1's 500 MB free-plan database that the logins share, and `chatsError` says so.
Measured that day: 9 chats, 157 MB of transcript stored as 50 MB, about 2.5 MB more per busy hour.

### Desktop logins: `server/src/core/desktop-login-sync.ts` (owner, 2026-10-01)

"Yes, build the desktop login sync." The same pass, store and key carry desktop logins, so a Claude
Desktop account signed in on one PC is signed in on the other without the browser sign-in there.

- What a desktop login is (checked on seven profiles by key and cookie names, never values):
  config.json's `lastKnownAccountUuid` and `oauth:tokenCacheV2` / `oauth:tokenCache` (Electron
  safeStorage: `v10` + nonce + AES-256-GCM under the profile's own key, which `Local State` keeps
  DPAPI-sealed for this Windows user), plus the claude.ai sign-in cookies in `Network/Cookies`
  (`sessionKey*`, `lastActiveOrg`, `routingHint`; cookie database version 24: the same cipher, the
  plaintext led by SHA-256 of the cookie's host). Every profile on every PC has its own key, so
  nothing copies as bytes: a login travels decrypted inside the sync's encryption and is encrypted
  again on arrival (`encryptSafeStorage`, `encryptV10Gcm` in `core/crypto`; a profile this PC makes
  gets its key from `ensureWindowsMasterKey`, written the way Chromium writes one).
- Store rows: keyed by the account's uuid, `meta.kind: 'desktop'` with the sender's folder `name`
  and `num`. The CLI half skips them. A PC still on 1.5.0 cannot open them and says so every pass
  until it updates.
- A profile is never written while its app runs (the app holds config.json and Cookies and saves
  over them): a pass leaves it, the dialog says a newer login waits, and AgentHydra runs one pass
  just before it opens a desktop instance (`syncBeforeLaunch`, a second before-launch hook beside
  move-retire's; ten seconds at most).
- A login a PC signed in on its own is never replaced and never uploaded over the store's: two
  separate sign-ins of one account each keep their own tokens and both stay signed in, and tying
  them together would let either PC's refresh sign the other out. A PC joins the store's copy only
  where it has none: a signed-out profile of the same folder name, else a new profile with that
  name (or `<name>-synced`) and number. From then on the later expiry among the grants wins.
- Cookies are read only while the profile is closed (Chromium locks the database); a pass while it
  runs uploads the new tokens with the cookies the store already has, and the profile's own cookies
  follow once it closes (an upload only when they differ from the store's). The same tokens with
  other cookies land on the other PC too. A new profile's cookie database is made from another
  local profile's schema, or the version-24 schema in the code on a PC with no desktop profile yet.
- Verified live (2026-10-01): this PC uploaded its 14 signed-in desktop logins; a separate
  AgentHydra home and instances folder joined with the pairing code and made 14 profiles with the
  same names and numbers, each token cache identical to the original after decrypting with the new
  profile's own key, the sign-in cookies identical for the 11 whose original was closed (three
  were open, so their cookies follow), and two landed logins answered live from Anthropic. The run
  found both gaps above (no cookies on a PC with no profile; later cookies ignored), each now
  pinned by the test.
- A Log out of a desktop instance leaves that account out of sync on that PC, like a CLI one.
- Windows only (elsewhere the profile key is in the Keychain or a keyring).
- The test (`server/tests/desktop-login-sync.test.ts`, Windows) proves the key round trip, a
  store-only account landing in a new profile under its own key with the cookie in Chromium's
  format, the later expiry winning both ways, a separate sign-in left alone, and a left-out login
  staying put. Not proven by a test: that Claude Desktop itself accepts a landed profile; that
  takes opening one, which only the owner does.

### One sign-in for desktop and CLI: `server/src/core/desktop-cli-feed.ts` (owner, 2026-10-01)

"If I log into desktop, can it auto-log into CLI? Or if I log into CLI, can it auto-log into the
desktop? ... to save me from having to do both individually."

- Desktop to CLI: yes. A desktop token cache holds a grant with the Claude Code scopes
  (`user:inference user:file_upload user:profile user:sessions:claude_code`) whose access token is
  good for weeks (checked on real logins by field names and lifetimes only). A `.credentials.json`
  made from it (access token, expiry, scopes, plan) passed `claude auth status` and answered
  `/usage` from Anthropic, run against a scratch config dir.
- CLI to desktop: no. A desktop sign-in also needs the claude.ai browser cookie and grants under
  the desktop's own client, which a CLI login never has.
- The rule: a CLI instance LINKED to a desktop instance ("Add a CLI login…" in the desktop row's
  menu, `linkCliInstanceToDesktop`) with no login of its own takes the desktop's: at once when
  linked (the route answers `signedInFromDesktop` and the menu skips the sign-in terminal), and
  every minute after (`startDesktopCliFeed`), so a renewed desktop grant follows. A credential with
  a refresh token is a CLI sign-in of its own and is never touched.
- Automatic pairing (owner, 2026-10-07, `core/desktop-cli-pairing.ts`, setting
  `desktop_cli_pairing`, on by default): every signed-in desktop profile (the instances root plus the
  default install) with no CLI instance linked gets one, on the feed's minute pass and before it
  feeds. An unlinked CLI instance logged in as the same account is linked first (lowest number);
  otherwise `<label> (CLI)` is created. A desktop is handled once (`desktop_cli_paired`, which also
  records desktops that already had a link), so a CLI instance the person deletes or unlinks stays
  gone. Only turning the setting on, after a confirm (`POST /api/desktop-cli-pairing`), clears that
  list and pairs everything again; its answer waits at most 7 s (`running: true` after that, and the
  run finishes on its own). A desktop whose pairing failed is left alone by the minute pass for 30
  minutes. One run at a time; Claude only, no Codex; neither key syncs.
  No empty CLI instance (owner, 2026-10-07): a new one is made only for a desktop whose token cache
  holds a Claude Code grant with time left. A profile keeps its account id after that grant runs out,
  and the id alone had made instances nothing could sign in. Such a desktop is left out of the plan
  and the Settings count, is not marked handled, and is paired on the first minute pass after its
  app renews the grant. A new instance the feed still cannot sign in is deleted again.
- Only the Claude Code grant is used (the path proven with the real CLI). A desktop login whose
  Code tab was never used, or not within the grant's weeks, has none: the link route answers
  `desktopHasNoCodeLogin` and the menu opens the usual sign-in, saying why. On 2026-10-01, 9 of the
  owner's 14 signed-in desktop instances held a live one (0 to 28 days left). A plain inference grant
  passed `claude auth status` but answered nothing to `/usage`, so it is not used.
- No refresh token is copied: the desktop app owns it, and a CLI refreshing with it would rotate it
  and sign the desktop out. So the fed login lasts as long as the grant; a desktop instance left
  closed past that leaves its CLI login expired until it is opened once.
- A Log out of a fed CLI instance cuts the link (`logoutCliInstance`), so it stays out.
- A fed login never goes to the login sync store (it has no refresh token); the desktop login
  syncs, and each PC feeds its own CLI instance. The sync dialog says so on that row.
- CliMayte sees a fed instance as any signed-in CLI account.

## Tasks that arrive from HSwarm (owner, 2026-10-05)

The owner asked for HSwarm and CliMayte to act as one tool, with a cost-aware split between API keys and
the subscriptions ("if the cost is even remotely close ... I generally prefer to push things into API
keys"). Before HSwarm runs a task that has tools (read, edit or all) and an absolute folder, it asks
`POST /api/routing/decide` (`server/src/routing-cost.ts`, `docs/COST-MODEL.md`) with the task's estimated
cost on its planned API leg; on "subscription" it dispatches the task here (kind `code` for edit/all, else
`review`), polls it every 10 s and uses the worker's report as the task's answer (`hswarm/climayte_route.py`).
Guards: a CliMayte worker's own HSwarm calls are never routed (the worker's `python -m hswarm connect`
sends `x-hswarm-climayte-worker: 1`, since one shared HSwarm server serves every chat and its own
environment says nothing about the caller); at most `route_via_climayte_max` (4) routed tasks at once;
a worker not running within `route_via_climayte_start_s` (90 s) is cancelled (`POST /api/corch/cancel`) and
the task runs on its API route once, as does a worker that fails; a cancelled HSwarm task cancels its
worker. A free planned leg (an NVIDIA or other $0 model) always stays on the API. These workers show in
the CliMayte view like any other, under the chat that called HSwarm.

## A broken Claude Code install holds work: `server/src/claude-install-guard.ts` (2026-10-06)

An npm update of the CLI that stopped half way left bin/claude.exe a 500-byte placeholder, then a truncated
binary. Every launch died within a second with no output and was called `interrupted`: three retries, then
the chat failed, and it looked like the account was broken. Now:

- **Preflight.** Before a launch the scheduler asks the guard whether the resolved `claude` runs: it exists,
  is not a stub (a native `.exe` under 5 MB), and `claude --version` answers within 8 s. Cached by path + size +
  mtime, so it costs nothing while the file is unchanged (an unhealthy verdict is re-probed every 30 s).
- **Held, not failed.** Unhealthy: no launch, no retry spent, no account move. The task goes to `waiting` with
  "Waiting: Claude Code install broken: <why>" (shown on its row, in climayte_status's `claudeInstall`, and as
  journal events `install-broken` / `install-repaired`) and starts by itself the tick the install answers again.
- **Last-known-good.** A verified copy of a healthy claude.exe is kept in `<data dir>/claude-lkg`. While the
  global install is broken, launches use it (`claudeExeFallback`, read by `resolveClaudeExe`), so nothing waits
  when a copy exists.
- **Self-repair, one at a time.** Re-runs the package's `install.cjs` when its native package is complete, else
  `npm install -g @anthropic-ai/claude-code@<version in its package.json>`; verifies with `--version`; on failure
  backs off (1, 2, 5, 15, 30 min) and raises ONE incident (scope `claude-install`; list_incidents / ack_incident).
- **Classification.** An attempt that dies in under 10 s with empty stdout, empty stderr and no runner pid
  triggers a fresh preflight; if the install is broken it is `install-broken`, not `interrupted`.
- **No self-updating CLI.** `DISABLE_AUTOUPDATER=1` is set daemon-wide (config.ts) and in every worker's
  environment (scrubbedEnv). Updates come only through version-drift's `npm install -g`, which now verifies the
  result and reports a failed update when the new install does not run.

`AGENTHYDRA_CLAUDE_PATH` (an explicit override, e.g. the mock-agent tests) is never judged. Tests:
`server/tests/claude-install-guard.test.ts` (fakes the exe, `--version` and the install step).

## Routes: `server/src/routes/climayte.ts`

- `GET /api/corch/workers?group=&id=&ids=&active=1&limit=&brief=1&wait=` → `climayteList` (`wait`
  seconds: first wait for the next status change in scope, via `climayteWait`; `ids` a
  comma-separated list). Every row carries `judged`: finished, and a verdict covers its newest work
  (no attempt started since); a follow-up or a sent-back fail makes it unjudged again.
- `GET /api/corch/workers?report=1&chars=` (same filters) → `climayteReports`: the report view, one
  compact row per worker (`toReport`: status, account, `judged`, newest `verdict` and `by`,
  `usedPct`, `rereadPct`, `attempts`, `outcomes`, and `report`: its first turn's recap from
  "## What I did" when it wrote one, else that turn from the top, `chars` long, default 1500;
  `reportCut` counts what is not shown). The waiter prints these under each changed worker.
- `POST /api/corch/verdicts` `{ ids, verdict, note?, retry?, kind? }` → `climayteVerdicts`: the same
  verdict for several finished workers, each answering on its own.
- `GET /api/corch/workers/:id?wait=` → `climayteGet` (404 when unknown)
- `GET /api/corch/journal?group=&id=&since=&limit=&format=lines` → `climayteJournal`, or
  `climayteJournalLines` with `format=lines`; `since` is an ISO time or epoch ms
- `POST /api/corch/workers` body `{ tasks, group?, accounts?, perAccount?, perAccountStrict?, model?, effort?, copies? }` → `climayteRun`.
  A task the same `group` was sent in the last 10 minutes (`REPEAT_WINDOW_MS`: same title, prompt
  and cwd, not cancelled or failed) answers with the worker already made, marked `repeat: true`,
  and starts nothing; the answer carries `repeated` and a `note`. `copies: true` makes new ones
  anyway (field note 62).
  The body's `origin` (only ever the caller the MCP tool resolved) is validated and stored; the
  answer carries `ping: { on: true, to? } | { on: false, why }`. `POST /api/corch/waves` the same.
- `POST /api/corch/adopt` `{ group, origin }` → `climayteAdopt` (`climayte_status {group, ping:true}`);
  `GET /api/corch/pings` → `{ unread: [sessionId] }`, the chats holding undelivered pings;
  `POST /api/corch/pings/read` `{ sessionId }` → that chat's `{ count, texts }`, marked read
- `POST /api/corch/workers/:id/send` `{ text, urgent?, model?, effort? }` → `climayteSend`
- `POST /api/corch/workers/:id/deliver-now` `{ text? }` → `climayteDeliverNow`
- `POST /api/corch/workers/:id/handoff` → `climayteHandoff`
- `POST /api/corch/workers/:id/priority` `{ priority }` → `climayteSetPriority` (400 on a bad value)
- `POST /api/corch/cancel` `{ id? , group? }` → `climayteCancel`
- `GET /api/corch/totals` → `climayteTotals`; `POST /api/corch/remove` `{ ids }` → `climayteRemove`
- `GET /api/corch/remote` → the other PCs' shared queues `{ enabled, pcs: [{ pc, name, at, stale,
  workers }] }` (climayte-remote.ts; "Two PCs" above); `POST /api/cli-instances/sync/queue
  { enabled }` turns the sharing on or off on this PC
- `POST /api/cli-instances/quick-add` `{ email, instanceId? }` → `startQuickAdd` (`instanceId`
  signs that existing instance in again, replacing its login: a CLI row's Log in)
- `GET /api/cli-instances/quick-add` → `listQuickAdds`
- `POST /api/cli-instances/quick-add/:id/code` `{ code }` / `POST .../:id/cancel`

Registered in `server/src/index.ts` beside the other route modules; `startCliMayte()` is called at
boot after the stores are ready.

One daemon owns the store (field note 62). The workers live in that daemon's memory, so a second
daemon on the same store holds a different half of them and resumes the first one's running workers
as interrupted. A start whose `/api/health` probes all time out while the pointer's daemon is still a
live process holding its port ends instead of hopping (`findStalledOwner`); the MCP tools a daemon
serves at `/api/mcp` read that daemon, not whatever `runtime.json` names (`useOwnDaemon`); and a
daemon that finds another live one on its store (`findPeerDaemon`, on the minute pointer tick) logs
`TWO DAEMONS`, lists it as `peer` in `/api/health` and stamps every `/api` answer with
`x-agenthydra-peer`, which the MCP client turns into a `peerWarning` on every tool answer (a list is
wrapped as `{ peerWarning, result }`, and an error carries it).

## MCP tools (`server/src/mcp.ts`)

- `climayte_run { tasks: [{ prompt, cwd, title?, model?, effort? }], group?, accounts?, per_account?, per_account_strict?, model?, effort?, copies? }`
  MUTATES. Description says: when the owner tells a chat to climayte a task or fully delegate it,
  the chat keeps only the orchestration and every piece of work goes here; each task must be
  self-contained (a CLI worker sees none of this chat), name its folder, and say what "done"
  means and what proof to report; workers run on the owner's CLI accounts, move to another
  account by themselves at a usage limit, and are visible in AgentHydra's CliMayte view. Answers
  only `{ group, workers: [{ id, title, status, account }] }` (field note 7: the full view echoed
  every prompt back). `model` (opus or sonnet) and `effort` (low..max) get one description line
  each; the top-level pair is the group default. Takes `notify: false` (no ping, see "Pings to
  the dispatching chat") and answers a `ping` line saying whether the calling chat will be pinged.
- `climayte_status { group?, id?, ids?, report?, chars?, active?, limit?, wait_seconds?, ping? }`:
  `ping: true` with a `group` adopts that group's live workers without an origin for the calling
  chat (answers `adopted` and a `ping` line); every call also shows the calling chat's
  `unreadPings` (pings no channel delivered) and marks them read. When there are extras, a list
  answer is wrapped as `{ workers, ...extras }`.
  `report: true` → the report view (above) for the scope, `ids` several workers at once. Without it,
  `id` → that ONE worker's detail
  (`climayteGet`, with its `events`; field note 4). Otherwise a brief list, newest first: a `group`'s
  workers, else every active worker plus the 20 (`RECENT_FINISHED`, or `limit`) most recently
  finished (field note 1: unscoped, it answered all 141 workers ever recorded, 51k characters, and
  overflowed the MCP result); `active: true` lists only queued/running/waiting ones. A brief row
  is the report row without the report text (`toBrief`), empty values left out, and finished work
  a verdict covers is left out unless `all: true` (2026-10-02: the default answer was 96 KB, 80 KB
  of it already-judged work). With
  `wait_seconds` it waits for the next status change in scope (use this instead of polling); waits
  are cut to `CLIMAYTE_MAX_WAIT_S` (45 s): an MCP client drops a call held about 60 s.
- `climayte_log { group?, id?, since?, limit? }`: the journal as readable lines, newest last, default
  100.
- `climayte_send { id, text, urgent?, model?, effort?, cwd? }` MUTATES: a follow-up turn in the same session;
  `urgent` stops a running worker and delivers this first; `model`/`effort` switch them for that
  turn and later ones (e.g. escalate a stuck Sonnet worker to Opus at `max`).
- `climayte_handoff { id }` MUTATES: a running worker writes a handoff and goes on in a fresh session.
- `climayte_verdict { id | ids, verdict, note?, retry?, kind? }` MUTATES: pass or fail on a finished
  task (`ids`: the same verdict for each, one call for a batch checked together); a
  fail goes back one rung up and the answer names `next`. `climayte_run` takes `kind` per task and as a
  group default, and `model: "auto"`.
- `climayte_scorecard {}`: what works per kind (see "Scorecard").
- `climayte_cancel { id?, group? }` MUTATES; answers `keptMessages`, the queued follow-ups it kept.
- `climayte_priority { id, priority }` MUTATES: a task's priority (field note 20). `climayte_run` takes
  `priority` per task and as a group default (0 when omitted); queued and waiting work starts
  highest first, then oldest first. A separate tool rather than a `climayte_send` option, so changing
  the order never queues a message.
`accounts` accepts CLI instance numbers or ids (resolve through the existing instance resolver).

## Web: Quick add and the CliMayte view

In Hydra Desk 2's copy of this window the CliMayte view is the first page of the HSwarm tab, and each
chat's workers are listed under it in Desk 2's sidebar.

- `web/src/components/CliInstancesSection.vue`: a Quick add row at the top, shown by the header's
  plus (and open by itself on an empty table) and closed by its X or by an account being added: one
  email input and an Add button (Enter submits). After a submit the input clears and keeps focus,
  ready for the next account. Each flow shows one line: "Confirm in your browser" with Open page again (the
  `url`), Paste code (a small input that posts to `/code`) and Cancel; then "Signed in as
  <email> (<plan>)" or the failure reason. Poll `GET /api/cli-instances/quick-add` every 2 s while
  any flow is `waiting`; refresh the instance list when one signs in.
- A **CliMayte** view (new `web/src/components/CliMayteView.vue`, reachable the same way the other top
  views are): workers grouped by `group`, newest first; each row: status chip, title, account,
  elapsed, `lastActivity`, moves, and a small run tag (`Opus 5.5 · max`: the model that ran, else
  the one asked for, and the effort; amber when the CLI ran another model than the one asked for;
  the hover lists both), and `P<n>` when its priority is not 0 (the hover says what it does).
  Selecting a row shows `events`, `result` (each turn's text
  under "Turn n of m" when there was more than one)/`error`, a follow-up
  box (`/send`) and Stop (`/cancel`). Poll every 3 s while any worker is active.
- The worker detail has **Model** and **Thinking** rows (asked for, and what ran).
- The selected worker's **Log** (`CliMayteJournal.vue`, in `CliMayteWorkerDetail.vue`): the journal for
  that task, or for its whole group (a toggle), one rendered line per entry, reloaded when the task
  changes and every 10 s for a group.
- Every user-facing string goes through vue-i18n (`web/src/locales`), so `check:i18n` passes.
- The CLI tab fits the window on a wide screen (owner, 2026-10-01, `c3a3c5b`): the page does not
  scroll. The accounts table folds from its header to two pooled gauges, what is left
  of the 5-hour and weekly windows across the accounts (kept per browser,
  `agenthydra.cli.accountsOpen`) and, open, scrolls inside itself (35vh); the task list scrolls
  inside itself with a "Hide finished" switch (`agenthydra.climayte.hideFinished`); in the task
  panel the result, event log and journal share the height left, each in its own box, and the
  message box stays at the bottom. The counter's hover gives the re-read share; an attempt stopped
  at the ceiling shows "stopped at 90%".

## Tests (`server/tests/climayte.test.ts`)

One integration test and the pure helpers, per the test-audit bar:
- `classifyAttempt`: done, quota (synthetic notice), auth, transient, and a model that merely
  TALKS about a session limit is still `done`.
- `pickAccount`: skips walled and full accounts, excludes the failed account on a handoff, and
  spreads by the active count.
- Integration: two fake accounts (temp config dirs) and `tests/mocks/fake-claude.ts` via
  `setCliMayteClaudeCommand(['bun', <path>])`. The first account has a `fake-quota` marker file, so
  the fake prints a synthetic limit notice and exits 1; CliMayte walls it, copies the transcript,
  resumes on the second account, and the worker ends `done` with the fake's result text and
  `moves === 1`.
- Field note 30: the session runs on A (quota), a login is refused on B (`fake-org-disabled`, whose
  folder loses the copied transcript), and the move to C copies from A and goes on in the same
  session. On the old code it failed "not found on the account it last ran on".

The fake CLI: parses `--session-id`/`--resume`, reads the prompt from stdin, and uses
`CLAUDE_CONFIG_DIR`. With `fake-quota` present it writes the session transcript
(`projects/fake-proj/<id>.jsonl`), prints `system/init`, an assistant message with
`model: '<synthetic>'`, `isApiErrorMessage: true` and text `You've hit your session limit · resets 4am`,
a `result` with `is_error: true` and the same text, then exits 1. Otherwise on `--resume` it
requires `projects/*/<id>.jsonl` in its own config dir (else prints `No conversation found` to
stderr and exits 1), appends to it, prints init, an assistant text and a `result` with
`is_error: false`, `result: 'FAKE DONE'`, `total_cost_usd: 0.01`, `num_turns: 1`, exits 0.

## Manager (the CLIManager): design, not built (2026-10-03)

Today one orchestrator chat does all the coordination: a long desktop chat on Opus, about 200k
tokens of context, that dispatches with `climayte_run`, waits with the owner's `climayte_wait` helper (see CLIMAYTE-FIELD-NOTES.md),
reads each batch, checks the proof and records verdicts. Measured 2026-10-03: each of its requests
costs about 0.40% of a Pro 5-hour window (reads 0.12, cache writes 0.09, output 0.19), because every
step re-reads that context, and every worker report it reads makes the next step dearer. Run 2 counted
8 requests a wake (the `--unjudged` note in climayte_wait.py), so one batch wake is about 3% of a Pro
window and the cost grows through the wave.

The manager sits between them. The orchestrator hands it ONE WAVE (a plan file and the task list);
the manager dispatches, waits, has the proof checked, re-dispatches, and wakes the orchestrator once
per wave with a short report. Rules this design keeps:

1. Cheap to wake: a small context and the cheapest model the scorecard trusts, through a new kind,
   `manage`, auto-picked like the others.
2. Its state lives in CliMayte (the wave, its tasks, verdicts, escalations, rounds), never only in
   its conversation, so it can be started fresh at any moment with nothing lost.
3. A pass is recorded only on proof a command gives: the task's check, the commit exists, the diff
   touches only the brief's paths. Anything needing taste or a decision goes up unjudged, with the
   reason. A lenient judge must not poison the scorecard. It never deploys.
4. Opt-in per dispatch, for big waves (about 5+ workers or several rounds). Small jobs keep
   `climayte_run` exactly as it is.
5. The orchestrator still verifies the merged result once per wave, the way CI runs it.
6. No manager of managers.

### What the code does today (the five questions)

**How is a CLI worker woken when its sub-workers finish?** It is not, today; but the parts exist.
A `claude -p` worker ends when its turn ends: `settleWorker` sets `done`, or `queued` when a message
is pending (`server/src/climayte-settle.ts`), and `finish` starts the check on `done`
(`climayte.ts`). A message from `climayteSend` (`climayte.ts`) is held in `pending` while
a turn runs and then resumes the same session (`--resume`, `server/src/climayte-launch.ts:377`) with
`followUpText` as the prompt (`climayte-launch.ts:192`); the tick starts it like any queued worker
(`tick`, `climayte.ts`). So the daemon can wake the manager the way `climayte_send` does: it appends
the batch report to the manager's `pending`. The report text is the one the waiter prints: the waiter
reads `GET /api/corch/workers?report=1&ids=` (`climayte_wait.py:123`), which is `climayteReports`
(`climayte-view.ts`), and holds changes into batches with `--batch`/`--settle-s` (`climayte_wait.py:21-27`,
`holds` at `:243`, `wake` at `:271`). The design moves that batching into the daemon (piece 3), so
the manager runs no waiter and spends no turn waiting.

**Do workers get the agenthydra MCP server?** No, on purpose. It is denied by name
(`WORKER_DENIED_MCP`, `climayte-launch.ts:242`; the reason at `:234-236`: 84 of a worker's 138 tools,
and a worker could start more workers or move desktop chats) and by its endpoint under any name
(`WORKER_DENIED_MCP_URL` = `*://*/api/mcp*`, `climayte-launch.ts:249`, written into the worker's
settings at `:336-339`; `MCP_PATH` is `/api/mcp`, `server/src/mcp-register.ts:79`), and
`ownerMcpServers` drops it from the `--mcp-config` copy by name and by path
(`server/src/climayte-owner-sync.ts:358-359`; the file is written by `writeWorkerMcp`,
`climayte-launch.ts:286-297`, and passed at `:382`). So a manager cannot call `climayte_run`,
status or verdict today, and giving it the whole server back would undo both reasons. The design
gives it a separate, small endpoint instead (piece 4).

**How does the orchestrator's waiter wait on just the manager?** The waiter exits when the wave's
status leaves `running` or the manager worker failed or was cancelled. The orchestrator runs
`python ~/.claude/tools/climayte_wait.py --wave <id> --timeout-s 7200` (the owner's waiter script, which polls the workers endpoint until the wave settles; see [CLIMAYTE-FIELD-NOTES.md](CLIMAYTE-FIELD-NOTES.md))
and wakes once per wave when the manager reports the wave done, rejected, verified, or failed,
or when the manager dies. This ensures the orchestrator wakes only once per wave, not at every
manager turn (piece 2).

**How do sizing and placement treat a long-lived, mostly idle manager?** As one ordinary task,
which is wrong both ways, so piece 6 changes it. Between wakes no CLI runs at all (each wake is a
fresh `claude -p` turn), and the tick counts only `running` workers per account
(`server/src/climayte-schedule.ts:84-88`), so an idle manager holds no slot. A wake is a follow-up
at home: `staysHome` keeps it on its own account (`climayte-schedule.ts:113-115`) and `waitsForRoom`
never holds a session going on at home (`server/src/climayte-placement.ts:280-293`). But at dispatch
`sizeTasks` (`climayte-dispatch.ts`) would price it with `expectedCost`, which for a kind with no record
falls to `DEFAULT_TASK_PCT` 25 (`climayte-placement.ts:28`, `:112-139`) and, once the kind has a
record, to the cost of a whole wave, which can pass half a window and answer `split needed`
(`sizeTask`, `climayte-placement.ts:162-171`). And its group would share `groupCap` with the wave
(`server/src/climayte-lib.ts:1222`) if they were one group. `accountInUse` is no issue: the
manager's own sessions are CliMayte's, not "other" (`climayte-lib.ts:267-268`). The turn caps are no
issue either: `notConverging` counts only attempts since the newest finished one
(`climayte-lib.ts:1611-1620`), so every wake that ends `done` starts the count again.

**How would the manager's verdicts feed the scorecard?** Every verdict counts the same today:
`scoreRows` sums every verdict of every task by kind and setting, whoever gave it
(`server/src/climayte-scorecard.ts:152-176`); `by` is recorded (`climayte-scorecard.ts:110`) but
anything not `check` or `owner` is stored as `orchestrator` (`climayte-steer.ts`). A verdict judges
the work since the previous verdict (`verdictRecord`, `climayte-steer.ts`), so a later fail with
no attempt in between adds a 0-unit fail and leaves the earlier pass counted. A lenient manager
would therefore teach `pickConfig` (`climayte-scorecard.ts:263`) to trust a cheap rung it should
not. The design never lets the manager's model say pass (the daemon judges by command), holds those
passes out of the scorecard until the orchestrator's wave check confirms them, and lets a later
verdict on the same work replace an earlier one (piece 5).

### The wave record

`<CONFIG_DIR>/corch/waves/<waveId>.json`, one file per wave (`core/json-store.ts`, like the done
files), so a restarted daemon and a fresh manager session read the same truth.

```ts
interface CliMayteWave {
  id: string                 // 'wv-' + 6 hex
  group: string              // the workers' group; the manager's is 'mgr-' + id
  managerId: string          // the manager worker
  plan: string               // absolute path of the plan file (the manager reads it as needed)
  cwd: string                // the repository the wave works in
  branch: string             // the branch commits must land on (default: cwd's current branch)
  verify: string | null      // the command the orchestrator runs on the merged result, carried to the report
  tasks: Array<{
    key: string              // stable name from the plan ('t1', 'api-routes'), survives re-dispatch
    prompt: string; title: string; kind: string; check: string | null
    paths: string[]          // globs the diff may touch; [] = must not commit
    after: string[]          // keys that must pass first (rounds)
    workerId: string | null  // the current worker for this key
    state: 'pending' | 'running' | 'passed' | 'failed' | 'escalated'
    proof: { check: boolean | null; commits: string[]; paths: boolean | null; note: string } | null
  }>
  escalations: Array<{ key: string; reason: string; at: number }>
  notes: string              // the manager's scratch, capped at 2,000 chars
  rounds: number; maxRounds: number      // re-dispatches per key, default 3
  batch: { size: number; settleS: number; held: string[]; since: number | null }
  status: 'running' | 'reported' | 'verified' | 'rejected' | 'failed' | 'cancelled'
  report: string | null      // the short report the orchestrator is woken with
  createdAt: number; updatedAt: number
}
```

Workers carry `wave?: string` (the wave they belong to; the manager carries it too, with
`kind: 'manage'`) and the manager `hold?: 'wave' | null`.

### How a wave runs

1. **Dispatch** (`climayte_manage`, piece 7). The orchestrator writes the plan to a file and calls
   `climayte_manage { plan, cwd, tasks: [{ key, prompt, kind, check?, paths, after? }], verify?, branch?, max_rounds? }`.
   Refused under 3 tasks ("use climayte_run": small jobs keep today's path; the description
   recommends it from about 5 workers or several rounds), and refused for any task of kind `manage`.
   It writes the wave, starts the manager in `mgr-<wave>` and answers the waiter command line to run.
   Nothing else starts: the manager dispatches.
2. **The manager's first turn** reads the wave state (its prompt, below) and dispatches the tasks
   whose `after` is met with `wave_dispatch`; the wave tasks are ordinary workers in the wave's group,
   auto-picked and sized as today. Then it ends its turn.
3. **Held, not waiting on itself.** When a manager's turn ends `done` while its wave has live tasks
   and no report, the daemon sets it `waiting` with `hold: 'wave'` and
   `error: 'Managing wave wv-x: 4 running, 2 queued'` instead of `done`. The tick's due list skips a
   held worker. No CLI runs; no slot is held.
4. **The daemon judges, by command** (piece 5). When a wave task reports done, its `check` runs as
   today; then (or at once with no check) `judgeWaveTask` reads the `Commits:` line every wave brief
   must end with, and runs, hidden, in `cwd`: `git cat-file -e <sha>^{commit}` per commit,
   `git merge-base --is-ancestor <sha> <branch>`, and `git diff-tree --no-commit-id --name-only -r <sha>`
   against the task's `paths`. All present proofs pass, and at least the check or a commit with its
   paths exist: a pass verdict `by: 'wave'`, `provisional: true`. A proof that fails: a fail verdict
   `by: 'wave'` with the command and its output, sent back one rung up like a failed check
   (`judgeCheck`, `climayte.ts`; three rounds, then the task is failed). Nothing provable (no
   check and `Commits: none`, as a review or a research task): no verdict, the key is escalated
   `unproven`.
5. **Wake the manager** (piece 3). The daemon holds wave changes the way `--batch` does (wake when
   `batch.size` tasks have changed, `batch.settleS` (600) has run since the first, or nothing is
   live), then appends ONE message to the manager's pending and clears the hold: the report view of
   the changed tasks (`climayteReports(..., 600)`, the waiter's text) with each one's proof result,
   and a header line of counts. A failed task, or a `split needed` answer, wakes it at once.
6. **The manager's wake**: escalate what needs a decision (`wave_escalate { key, reason }`: a report
   that says something was left undone, a worker that made a choice the plan does not cover, a plan
   step that says deploy), re-dispatch a failed or crashed key within `maxRounds` (`wave_dispatch`
   again, or `wave_send` to continue its session), dispatch the next round whose `after` keys passed,
   and end its turn. It never writes a pass or a fail.
7. **Report.** When every key is `passed`, `failed` or `escalated`, the manager calls
   `wave_report { text }` (at most 2,000 characters; the daemon prefixes a table it builds itself:
   one line per key, state, proof, commits, and the branch head) and ends its turn. With the wave
   `reported` the manager is no longer held, so it ends `done`, and the orchestrator's waiter wakes
   with the report under the manager's line. A turn that ends with nothing of the wave running, keys
   still pending and no report gets one message ("report or dispatch"); a second such turn in a row
   fails the manager with that reason, and the orchestrator wakes on `failed`. A manager that ends
   `done` on a finished wave without calling `wave_report` (it wrote its report as its answer:
   wv-42c178 and wv-5a5bbc, 2026-10-05, sat `running` for hours) has the wave reported for it: the
   daemon's table, then the manager's last answer. The 5-second wave check does the same for one that
   ended so before this daemon started.
8. **The orchestrator verifies once** (rule 5): it runs the wave's `verify` (the repo's CI or gate,
   through fairjob) on the branch head, reads the escalations, and calls
   `climayte_wave_verify { wave, ok, note? }`. `ok` confirms the provisional passes (they count in
   the scorecard from then on) and records a pass on the manager; not `ok` leaves them out, and the
   orchestrator records its own fails on the tasks it blames (each replaces that task's provisional
   pass) and a fail on the manager with the note, `retry: false` (the wave is over). An unverified
   wave's provisional passes never count.
   The daemon judges a task's commits as a whole: a sha that is not on the branch is looked up by
   `git patch-id --stable` among the branch's newest 500 commits (a landing tool's rebase), and paths
   are judged on the net diff, so an outside edit the task reverted does not fail it. An escalated or
   failed key is settled with `climayte_wave_resolve { wave, key, ok, note? }` (route `POST
   /api/corch/waves/:id/tasks/:key/resolve`) or by a `climayte_verdict` on that key's worker: a pass
   counts for `after`, and the manager hears the key in its next batch message.

### The manager session

- **Its prompt is the store.** Every fresh session starts from `MANAGER_BRIEF` (appended system
  prompt, beside `WORKER_BRIEF`) plus `waveStateText(wave, workers)`: the plan path, each key's state,
  worker, proof and rounds, the escalations and `notes`, rendered from the wave record, about 2-4k
  tokens for 20 tasks. A follow-up wake resumes the session and carries only the batch message. When
  its conversation passes `MANAGER_CONTEXT_TOKENS` (60k, against 200k for a worker), or after any
  handoff, limit, move or crash, the next wake starts a NEW session from the state text instead of a
  handoff note: there is nothing in the conversation the store does not hold. `climayte_handoff` on
  the manager does the same at once.
- **What it may call**: only the manager endpoint's tools (piece 4) and its built-in tools (to read
  the plan and run a quick look); the lean worker profile's CLAUDE.md, no skills
  (`skills.txt` empty for `manage`), no HSwarm or connections. Less to load is less to re-read.
- **Cache**: a 1-hour prompt cache for `manage` (`CLAUDE_CODE_PROMPT_CACHE_TTL: '1h'`), where workers
  run 5 minutes (`climayte-launch.ts:431`): a wake comes about every 10 minutes (the 600 s settle),
  so with 5 minutes every wake would re-write its whole context into a cold cache. To be measured
  against 5 minutes on the first real wave (piece 6's numbers).
- **Expected cost**: a wake is a resumed turn of a few requests on a context under 60k: on the
  meter fit above (per 1M tokens read 0.4%, write 26%, output 272% of a Pro window), about 1% of a
  Pro window, most of it output, against about 3% for an orchestrator batch wake that also grows. The
  manager's tools answer compact JSON and it does not restate reports, because output is the dear
  part.
- **It never deploys**: `MANAGER_BRIEF` says so, its endpoint has no tool that could, and
  `wave_dispatch` appends to every brief "Do not deploy, publish or release; end with a line
  `Commits: <sha> ...` or `Commits: none`".

### Scope and identity of the manager endpoint

`POST /api/corch/mcp/<managerId>`: the same MCP-over-HTTP handler as `/api/mcp`
(`server/src/index.ts:368-400`, `handleMcpHttp`), with its own short tool list and instructions. It
is outside `/api/mcp*`, so the URL deny every worker carries still keeps the full server out, the
manager's included. The manager's `--mcp-config` lists it as `climayte-manager` with only a URL (no
header, no token: the daemon listens on 127.0.0.1 and the id is not a secret). Every call is refused
unless that worker is the live manager of a running wave and the calling process is that worker's
CLI (`callerPidOf`, `index.ts:356`, against the attempt's `pid`). Every tool is scoped to the wave:
`wave_state`, `wave_dispatch` (into the wave's group only; refuses kind `manage`, so there is no
manager of managers, and refuses a key past `maxRounds`), `wave_send`, `wave_cancel`, `wave_escalate`,
`wave_note`, `wave_report`. There is no verdict tool. Ordinary workers keep the agenthydra server
denied, so nothing the manager starts can start anything.

### Model: the `manage` kind

`CLIMAYTE_KINDS` gains `manage` (`climayte-scorecard.ts:27-35`). Like every kind it starts on Haiku
5.5 medium (owner, 2026-10-07); with Haiku written off it starts on Sonnet low
(`START_PAST_HAIKU.manage`): the work is reading short reports and following a plan, and the judging
is done by commands. The orchestrator's
`climayte_wave_verify` is the manager's verdict, so the scorecard learns which rung manages a wave
the orchestrator accepts, with its cost per wave, like any kind. `modelWhy` still overrides.

### Build list

Each piece builds and checks on its own; a later piece uses the earlier ones but each test stands
alone. Checks run through the owner's `fairjob` wrapper (weight 3) from `app/`, plus
`bun run --cwd server typecheck` for every piece.

1. **The wave store and its pure helpers.** `CliMayteWave`, `wave?` and `hold?` on the worker, the
   store under `corch/waves/`, and pure `waveStateText` and `waveDone(wave)` (every key passed,
   failed or escalated). Files: `server/src/climayte-wave.ts` (new), `server/src/climayte-lib.ts`
   (types), `server/tests/climayte-wave.test.ts` (new). Check:
   `bun test server/tests/climayte-wave.test.ts` (a wave survives a reload; the state text names
   every key's state and proof).
2. **The hold.** `settleWorker` sets a manager with a live, unreported wave to `waiting` /
   `hold: 'wave'`; the tick's due filter (`tick`, `climayte.ts`) skips it; the stall rule (one nudge, then
   failed). Files: `server/src/climayte.ts`, `server/src/climayte-wave.ts`,
   `server/tests/climayte-wave.test.ts`. Check: the same test file, with the fake CLI
   (`server/tests/mocks/fake-claude.ts`): a manager whose wave has a running task ends its turn
   `waiting`, launches nothing on the next ticks, and ends `done` once the wave is reported.
3. **The daemon's batch wake.** Pure `waveBatch(wave, workers, now) → ids | null` (the `--batch` /
   `--settle-s` rules of `climayte_wait.py`, plus at once on a failure); the tick calls it and queues
   one message built from `climayteReports` on the manager. Files: `server/src/climayte-wave.ts`,
   `server/src/climayte.ts`, `server/tests/climayte-wave.test.ts`. Check:
   `bun test server/tests/climayte-wave.test.ts` (5 tasks, batch 3: the third change wakes it once
   with three reports; settle time out wakes it with fewer; a held wake survives a daemon reload).
4. **The manager endpoint.** `POST /api/corch/mcp/:managerId` with the wave tools and the caller
   check; the manager's `--mcp-config` lists it; workers' settings unchanged. Files:
   `server/src/climayte-manager-mcp.ts` (new), `server/src/index.ts` (route),
   `server/src/climayte-launch.ts` (`writeWorkerMcp` for `manage`), `server/tests/climayte-manager-mcp.test.ts`
   (new). Check: `bun test server/tests/climayte-manager-mcp.test.ts` (a non-manager or a finished
   manager is refused; `wave_dispatch` lands in the wave's group and refuses `manage`; an ordinary
   worker's settings still deny `*://*/api/mcp*` and the agenthydra name).
5. **Judging by command, and a scorecard that cannot be poisoned.** `judgeWaveTask` (commits, branch,
   paths) chained after the check; verdicts `by: 'wave'` with `provisional`; `scoreRows` skips
   provisional verdicts and counts only the newest verdict per span of work (a verdict with no
   attempt since the previous one replaces it); `by` keeps `wave` instead of folding it into
   `orchestrator` (`verdictRecord`, `climayte-steer.ts`). Files: `server/src/climayte-wave.ts`, `server/src/climayte.ts`,
   `server/src/climayte-scorecard.ts`, `server/tests/climayte-scorecard.test.ts`,
   `server/tests/climayte-wave.test.ts`. Check:
   `bun test server/tests/climayte-scorecard.test.ts server/tests/climayte-wave.test.ts` (a temp git
   repo: a commit outside `paths` fails, one inside passes provisionally; a provisional pass is not in
   `scoreRows`; an orchestrator fail after a pass leaves one fail, not both).
6. **Kind, cost and placement of the manager.** `manage` in `CLIMAYTE_KINDS` with `START` rung 1;
   the manager skips `sizeTasks`; its expected cost for placement is per wake (its kind's average wake
   attempt, else 2%); the 1-hour cache for `manage`; `MANAGER_CONTEXT_TOKENS` starts the next wake in
   a fresh session from `waveStateText`; totals report `managerPct` per wave. Files:
   `server/src/climayte-scorecard.ts`, `server/src/climayte-placement.ts`,
   `server/src/climayte-launch.ts`, `server/src/climayte.ts`, `server/src/climayte-totals.ts`,
   `server/tests/climayte-placement.test.ts`. Check: `bun test server/tests/climayte-placement.test.ts
   server/tests/climayte-scorecard.test.ts` (a 20-task wave's manager never answers `split needed`;
   `pickConfig('manage', [], 0)` is Sonnet low).
7. **The orchestrator's entry and exit. BUILT (2026-10-03).** `climayte_manage` and `climayte_wave_verify` MCP tools,
   `POST /api/corch/waves`, `POST /api/corch/waves/:id/verify`, `GET /api/corch/waves` (`{ waves }`,
   newest first, each exactly the stored record) and `GET /api/corch/waves/:id` (404 if unknown), the under-3-tasks refusal, the
   answer carrying the waiter command, and `climayte_status { wave }`. Files: `server/src/mcp.ts`,
   `server/src/routes/climayte.ts`, `server/src/climayte.ts`, `server/tests/climayte-wave.test.ts`.
   Check: `bun test server/tests/climayte-wave.test.ts server/tests/climayte.test.ts`
   (verify `ok` confirms every provisional pass and records a pass on the manager; not `ok` confirms
   none).
8. **The view.** Waves as a group header in the CliMayte view (manager row, keys, escalations,
   the report); every string through vue-i18n. Files: `web/src/components/CliMayteView.vue`,
   `web/src/lib/climayte-status.ts` (the held state's chip), `web/src/i18n/locales/en/climayte.ts`.
   Check: `bun run --cwd web typecheck && bun run --cwd web check:i18n`.
9. **The skill and a live wave.** The claude-memory `climayte` skill learns when to choose
   `climayte_manage` and the waiter line; then one real wave of 5+ code tasks. No code here. Check:
   `GET /api/corch/totals?since=<wave start>` shows the manager's wakes and `managerPct`, the
   orchestrator woke once (`climayte_log { group: 'mgr-<wave>' }`), and no provisional pass counted
   before `climayte_wave_verify`.

## Status (2026-09-30)

- Shipped on `main`: the runtime (`server/src/climayte.ts`), its pure half (`server/src/climayte-lib.ts`),
  quick add (`server/src/core/cli-quick-add.ts`), the routes, the four MCP tools, the CliMayte view with
  Quick add at its top (`web/src/components/CliMayteView.vue`, `CliQuickAdd.vue`), and the `climayte` skill
  in the shared claude-memory repo.
- Proven: `server/tests/climayte.test.ts` (9 tests, including a two-account handoff through
  `tests/mocks/fake-claude.ts`), and a live run against the real CLI instances: #69 failed `auth`,
  was walled, the worker moved to #68, which also failed `auth`, and the worker waited with the
  signed-out reason. That run found the `Failed to authenticate: OAuth session expired` wording,
  which is now classified `auth`.
- Proven 2026-09-30: a quick-add sign-in completed by the owner renamed the new instance to
  its account's address with `(pro)` after it (#83), and a real task restricted to #83 finished `done` with the
  result `OK` in 6 s. Quick add then got its sign-in window (`core/signin-window.ts`, driving
  `orchestrator/scripts/lib/signin_window.py`): Add account opens a new private window with
  zendriver (the owner's chosen engine; `python -m pip install zendriver`) on a throwaway profile,
  the owner completes any Cloudflare check, the window submits the matching prefilled email once,
  and the owner opens their email's sign-in link in that window. The window relays the copyable
  six-digit verification code to its waiting email form (restoring the form from browser history
  if the link replaced that tab), then authorizes only the original OAuth path and state. The page's final
  code goes to the CLI by itself before the window closes. The hand-off was checked headless (code
  in 1 s, no browser, Python process or profile left behind); a full sign-in through the window is
  the next account the owner adds.
  The popup remembers its last normal screen position on close in
  `<AgentHydra config dir>/signin-window-position.json`, outside the throwaway profile. Manual
  closure uses the last sampled position; automatic closure samples once more before stopping.
  Minimized/maximized coordinates and headless checks do not overwrite the saved location.
  Claude's `claude.com/cai/oauth/authorize` redirects to `claude.ai/login`; both exact HTTPS
  origins are allowed for email submission and code entry. Authorization remains bound to the
  original OAuth state and the two known authorization routes. The sign-in helper's
  `--assist-port` mode can update automation in an existing managed popup while its original
  controller retains the CLI handoff and browser shutdown.
  Once the verification code is read back from the waiting input, its separate source tab/window
  closes automatically. The destination stays open for verification, authorization and CLI handoff;
  a same-tab email link returns to that destination without closing it.
  When the matching authorization page appears without focus, the driver brings that page to the
  front once. This lets Claude enable its Authorize button through its normal focus handling;
  the driver still waits for the button to be enabled before submitting it.
  The waiting step checks both open popup tabs for a verification code and, on Windows,
  the clipboard. A copied six-digit code uses the same fill/confirmation/submission flow.
  The small clipboard watcher reads text only while the email-code form is waiting.
  Copying a `https://claude.ai/magic-link#...` link for that account opens it once in a new tab
  in the same popup and continues the code-transfer/authorization flow. Links and clipboard
  contents are kept out of logs; headless checks do not read the clipboard.
- Quick add's Add button stayed disabled on first ship: a lint auto-fix turned `import { Input }`
  into a type-only import, so the tag rendered as a bare `<input>` whose v-model never updated.
  Fixed, with a `biome-ignore` naming why.
- UI rebuilt after a three-lens review (layout, states, affordance): the header says what CliMayte is
  and carries an "Add a CLI account" button that opens Quick add as a card; tasks sit in one panel
  grouped by hand-off; the sticky detail pane lists every account a task tried and why it moved on
  (`CliMayteWorkerDetail.vue`); status chips carry an icon and plain words (`lib/climayte-status.ts`). The
  message box says what sending does: queued after the current step on a live task, a new turn of
  the same conversation on a finished or stopped one (that is what `climayteSend` does).

## Status (2026-10-01)

- Live on `main`: sizing before dispatch (`split needed` over half the biggest window, plan-aware:
  Max 5x and 20x hold 5 and 20 Pro windows) and waiting for room; the 85% stop line on the 5-hour
  and weekly windows with a handoff whether or not another account has room; the 90% ceiling;
  per-attempt spend and the re-read share; the test metrics above; blended cost estimates from
  every finished task; leftover processes ended with their run; the CLI tab layout.
- Measured that night (since 05:00 UTC): 3 limit hits, all before the stop line shipped; 0 ceiling
  stops; peaks #101 87%, #102 78% (the older accounts had already hit 96-100%); Sonnet medium code
  estimated at 4.9% from 7 finished tasks (was 13.7, from Opus code scaled).
- Next run, check: `limitHits` stays 0 and peaks sit at 85-90; how often the ceiling fires
  (`ceilingStops`: the 85% handoff came late); `sizing.ratio` near 1; the re-read share falls
  below 14%; `cleaned` events in the journal; waiting tasks' `waitUntil` matches the real reset.
- First ceiling stop (reported by the Connections orchestrator after `df4bb96`): #102 reached 90%
  with 4 Sonnet workers running at once; `sizing.ratio` was 0.59 (Sonnet now under its estimate).
  Every worker there is already asked at 85% (each reads the account's usage in its own stream),
  but four sessions each writing a handoff move the meter past 90. To weigh: start the stop line
  lower as more workers share an account (for example 85 minus a point or two per extra worker),
  and add a `ceilingStopList` to the totals like `limitHitList` (task, account, pct, workers
  running then).
- Overnight review (2026-10-01 evening; field notes 45, 46 and 49): since the 85/90 fix, 0 limit
  hits, 1 ceiling stop, sizing ratio 0.92. The ceiling stop was one worker whose own stream jumped
  76% -> 87% across a long tool call while its siblings had seen 85% six minutes earlier, so the
  stop line and the ceiling now go by the account's newest reading from any worker
  (`sessionReading` in climayte-lib.ts). An account with no reading in its 5-hour window takes one
  worker until that worker reads it (#88 took four at once and all failed sign-in).
  `GET /api/corch/totals?since=` now scopes every figure, the re-read share included, and lists
  `ceilingStopList` (`pct`, `askedPct`, `workers`). The journal shows a ceiling stop whose handoff
  was written, and a waiting row's `until`. Each worker runs the owner's edit_claims hook (its
  PreToolUse in the worker's settings), claiming under its task id.
- Verified live on the next run (the D: and H: drive survey, groups dhsurvey-w1..w4, 19:00-19:25
  UTC): 12 tasks, 0 limit hits, 0 ceiling stops, re-read share 0; no account without a reading got
  a second worker (the two doubled starts, #95 and #102, had readings at 3% and 6%); every worker's
  `hooks/<id>.json` carries the edit_claims PreToolUse and 9 `w-*.json` claims were written.
- Note 47 (an external budget a brief spends): no CliMayte side for now. The Connections
  orchestrator's answer: the waste was one tool minting a sign-in on every run, fixed where it
  happened (w-7dd056e4), and a declared-budget feature waits until a second outside budget bites.
  Run 2 never hit "split needed" (409): every task was sized well under half a window.
