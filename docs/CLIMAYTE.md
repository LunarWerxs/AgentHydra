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
- CliMayte runs only when a person started it (a chat he told to climayte a task, or the CliMayte view).
  It is his per-task grant to use the CLI accounts; it is not standing permission for anything else.

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

Persisted with `core/json-store.ts` at `<CONFIG_DIR>/corch/workers.json` (`{ workers: CliMayteWorker[] }`,
same read/mutate discipline as `core/cli-instances.ts`). Logs live in `<CONFIG_DIR>/corch/logs/`
as `<workerId>-<attemptIndex>.jsonl` and `.err.log`. The prompt of each attempt is written to
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
  "You are a CliMayte worker: a Claude Code CLI session that AgentHydra started on one of the
  owner's accounts, at the owner's request, to do one delegated task for an orchestrating chat.
  Do the whole task yourself, in this session. Nobody is watching to answer questions, so make
  the reasonable call and say which call you made. Follow the repository's own rules. Commit only
  the files you changed, and push if the repository's rules say to. Never read or print a secret
  value. End with a short report: what you did, the proof you saw (a command and what it
  printed), and anything left undone with the reason."

### Runner and restarts (`server/src/climayte-runner.ts`)

Owner, 2026-09-30: restarting AgentHydra must not break CliMayte workers. A `Bun.spawn` child sits in
the daemon's kill-on-close job on Windows, so a restart used to kill every worker (it then resumed
as `interrupted` and redid its step); `detached` is no escape (DETACHED_PROCESS flashes a console).

- `launchRunner(spec)` writes `<log>.spec.json` and starts this program in `--climayte-runner <spec>`
  mode (`main.ts`) through the WMI hand-off (`detached-spawn.mjs`, `hideWindow`): it is born
  outside the daemon's tree (parent WmiPrvSE.exe). The runner reads and deletes the spec (it holds
  the CLI's env), starts the CLI with the attempt's files, writes `<log>.pid.json`
  (`{ runner, child }`), waits, and writes `<log>.exit.json`.
- The attempt records `runner: { pid, pidFile, exitFile, launchedAt }`; `attempt.pid` is the CLI's.
  `attemptExited()` reads only files: an exit file means ended; a runner gone without one died
  (`finish` reads it as interrupted); no pid file within a minute means it never started. A runner
  pid is trusted only once its command line names the attempt's spec (`isOurRunner`), so a pid
  Windows reused is never followed or killed. `killAttempt` kills the runner's tree.
- `climayteRunningCount()` counts only pre-runner workers, so `/api/daemon/restart` needs no `force`
  for runner workers. Proven live: two restarts with 6-7 workers running left every attempt count
  unchanged and every worker running.

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

### Model and thinking (field note 16)

The orchestrating chat picks each worker's model and thinking level (owner, 2026-09-30). The CLI
(2.1.284) takes `--model <alias or full name>` and `--effort low|medium|high|xhigh|max`.
`climayteModel(v)` maps `opus`, `opus-5.5`, `opus-5-5`, `claude-opus-5-5` (and the same four for
sonnet) to the full id (`CLIMAYTE_MODELS`), so a later alias move cannot change what a recorded task
asked for; `climayteEffort(v)` accepts `CLIMAYTE_EFFORTS`. Blank means the CLI's default; anything else
throws with the valid values listed, so junk never reaches the CLI (`climayteRun`: "task N: unknown
model ..."; `climayteSend`: `ok: false`).

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
- **queued / waiting**: highest `priority` first, then oldest first (`dueOrder`, field note
  20); when `notBefore` has passed, `pickAccount(worker)`; none → `waiting`
  with `error` naming why (every account walled / none signed in); else launch.

Emit a change event (`onCliMayteChange(cb) → unsubscribe`) whenever a worker's status changes, so
`climayte_status` can wait without polling.

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
  and `weekPct < 99` when known; `active < perAccount`. A handoff (last attempt `quota`/`auth`)
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
  stop at 85-90%); with none, the task waits for the first reset (`waitUntil`). At `CEILING_PCT`
  (90, either window; `df4bb96`) a turn still running is stopped on the spot and the account walled
  until that window resets: it goes on from its handoff if it wrote one, else moves or waits. Those
  are ceiling stops (`ceiling` on the attempt, `ceilingStops` in the totals), never limit hits. An
  owner who allows paid extra usage lifts both lines.
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
exists, so climayte.ts registers `setCliLoginVeto(climayteSignedOutReason)` with `core/cli-instances.ts`.
An account CliMayte walls `signed out` (its last attempt failed `auth`, and its credential file has not
changed since) lists `loggedIn: false` with a `loginNote` saying why, in `list_cli_instances` and
the CLI tab alike, without running `claude auth status` per row. The wall is rechecked in the
background with `cliAuthStatus` every 30 min, and lifts at once when the credential file changes (a
fresh sign-in). An `organization disabled Claude Code` wall lists the same way with its own note,
and only a changed credential file lifts it.

### The owner's CLAUDE.md and skills (`server/src/climayte-owner-sync.ts`)

A worker runs with `CLAUDE_CONFIG_DIR` = its account's folder, so `~/.claude` (the owner's global
CLAUDE.md, skills and hooks) is not what it reads (field notes 5 and 9). Before each launch,
`syncOwnerClaude('~/.claude', account.configDir)` makes the account folder match:

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
- **The lean worker profile** (`8b3add7`, owner's yes 2026-09-30): when `~/.claude/climayte-worker/`
  holds a `CLAUDE.md`, workers get that instead of the full one, and when it holds `skills.txt`
  (one skill name per line, `#` comments) only those skills are linked; the rest are unlinked at
  the next launch. The owner's profile lives in the claude-memory repo (`home/climayte-worker/`,
  installed by `install.mjs`): 3 KB of rules and 12 engineering skills, against 44 KB and 84. Run 1
  measured what the full set cost: a fresh session's first request grew 57k -> 90k tokens
  (Connections) when it arrived, and that prefix is re-read on every request and written to cache
  on every fresh session and move.

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
  some, and a worker's own "the tests pass" is a claim; a command is neither.
- **The ladder**, cheapest first: Sonnet 5.5 low, medium, high, then Opus 5.5 medium, high, xhigh,
  max. A CLI-default setting counts as Opus high.
- **Kinds**: code, debug, review, sweep, mechanical, docs, trivial (`climayte_run` `kind`). Each starts
  where the climayte skill's table puts it (sweep, mechanical and docs on Sonnet medium, trivial on
  Sonnet low, code and review on Opus high, debug on Opus xhigh).
- **`model: "auto"`** (`pickConfig`): the cheapest rung with at least 3 verdicts at 80% or more
  passes, else the kind's start moved up past any rung with two or more verdicts under half; every
  4th auto pick of a kind tries the rung below that, unless it keeps failing. The pick and its reason
  go in the `dispatched` journal line.
- **`climayteScorecard()`** (`GET /api/corch/scorecard`, `climayte_scorecard`): passes, fails and cost per
  task as a share of a Pro 5-hour window (`UNITS_PER_PRO_PERCENT` = 320,000 weighted units per 1%,
  fitted on run 1, R^2 0.48) per kind and setting, `pick` on the next auto setting. The CliMayte view
  shows it as "What works" and puts thumbs up/down on a finished task.

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
- `pickAccount(..., placement)` scores `max(projected, week%) + 200 when projected > FIT_PCT (85,
  the stop line, since `fc1ca87`)`
  instead of `max(session%, week%) + 100 per worker`; the tick passes it for every start, and adds
  each worker it starts to the projection before the next one is placed. When nothing fits, the
  lowest projection still wins: finishing part of the work and handing off beats waiting hours.

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
  fits (sent `whole`), are never held.
- **Why half:** run 1's 49 finished tasks averaged 24% of a Pro window and 80% stayed under 36%, but
  single tasks ran to 93% and 107%, and code on Opus high (33% on average) moved 33 times over 19
  tasks. An estimate is an average; over half a window a task runs past the whole one often enough
  that pieces cost less than its moves.
- A waiting task carries `waitUntil` (ISO, UTC): when the first of its accounts frees up, a usage
  wall's end or else its 5-hour reset; waiting for room, the first reset of an account whose fresh
  window holds it. A waiter sleeps until it rather than parse the error text's local time.
- An attempt's spend is read from the folder it ran in (`account.configDir` on the attempt), not from
  wherever the instance store points now.

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
text, first line), `turn-done`, `priority` (changed by `climayte_priority`), `done`, `failed`,
`cancelled`. Read with `climayteJournal(filter)` (entries, oldest first, the newest `limit`, default
100) or `climayteJournalLines(filter)`, one readable line each, e.g.
`23:41:07 w-1234abcd 'Fix events rows' launched on #84 (session 12%, week 0%, 0 active)`; when a
model or effort was asked for, the line ends ` with claude-opus-5-5, effort max`.

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
Validation: `cwd` must be an existing directory; `prompt` non-empty; `perAccount` 1..4, default 2.

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

## Routes: `server/src/routes/climayte.ts`

- `GET /api/corch/workers?group=&id=&active=1&limit=&brief=1&wait=` → `climayteList` (`wait`
  seconds: first wait for the next status change in scope, via `climayteWait`)
- `GET /api/corch/workers/:id?wait=` → `climayteGet` (404 when unknown)
- `GET /api/corch/journal?group=&id=&since=&limit=&format=lines` → `climayteJournal`, or
  `climayteJournalLines` with `format=lines`; `since` is an ISO time or epoch ms
- `POST /api/corch/workers` body `{ tasks, group?, accounts?, perAccount?, model?, effort? }` → `climayteRun`
- `POST /api/corch/workers/:id/send` `{ text, urgent?, model?, effort? }` → `climayteSend`
- `POST /api/corch/workers/:id/handoff` → `climayteHandoff`
- `POST /api/corch/workers/:id/priority` `{ priority }` → `climayteSetPriority` (400 on a bad value)
- `POST /api/corch/cancel` `{ id? , group? }` → `climayteCancel`
- `GET /api/corch/totals` → `climayteTotals`; `POST /api/corch/remove` `{ ids }` → `climayteRemove`
- `POST /api/cli-instances/quick-add` `{ email, instanceId? }` → `startQuickAdd` (`instanceId`
  signs that existing instance in again, replacing its login: a CLI row's Log in)
- `GET /api/cli-instances/quick-add` → `listQuickAdds`
- `POST /api/cli-instances/quick-add/:id/code` `{ code }` / `POST .../:id/cancel`

Registered in `server/src/index.ts` beside the other route modules; `startCliMayte()` is called at
boot after the stores are ready.

## MCP tools (`server/src/mcp.ts`)

- `climayte_run { tasks: [{ prompt, cwd, title?, model?, effort? }], group?, accounts?, per_account?, model?, effort? }`
  MUTATES. Description says: when the owner tells a chat to climayte a task or fully delegate it,
  the chat keeps only the orchestration and every piece of work goes here; each task must be
  self-contained (a CLI worker sees none of this chat), name its folder, and say what "done"
  means and what proof to report; workers run on the owner's CLI accounts, move to another
  account by themselves at a usage limit, and are visible in AgentHydra's CliMayte view. Answers
  only `{ group, workers: [{ id, title, status, account }] }` (field note 7: the full view echoed
  every prompt back). `model` (opus or sonnet) and `effort` (low..max) get one description line
  each; the top-level pair is the group default.
- `climayte_status { group?, id?, active?, limit?, wait_seconds? }`: `id` → that ONE worker's detail
  (`climayteGet`, with its `events`; field note 4). Otherwise a brief list, newest first: a `group`'s
  workers, else every active worker plus the 20 (`RECENT_FINISHED`, or `limit`) most recently
  finished (field note 1: unscoped, it answered all 141 workers ever recorded, 51k characters, and
  overflowed the MCP result); `active: true` lists only queued/running/waiting ones. With
  `wait_seconds` it waits for the next status change in scope (use this instead of polling); waits
  are cut to `CLIMAYTE_MAX_WAIT_S` (45 s): an MCP client drops a call held about 60 s.
- `climayte_log { group?, id?, since?, limit? }`: the journal as readable lines, newest last, default
  100.
- `climayte_send { id, text, urgent?, model?, effort? }` MUTATES: a follow-up turn in the same session;
  `urgent` stops a running worker and delivers this first; `model`/`effort` switch them for that
  turn and later ones (e.g. escalate a stuck Sonnet worker to Opus at `max`).
- `climayte_handoff { id }` MUTATES: a running worker writes a handoff and goes on in a fresh session.
- `climayte_verdict { id, verdict, note?, retry?, kind? }` MUTATES: pass or fail on a finished task; a
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

- `web/src/components/CliInstancesSection.vue`: a Quick add row at the top: one email input and
  an Add button (Enter submits). After a submit the input clears and keeps focus, ready for the
  next account. Each flow shows one line: "Confirm in your browser" with Open page again (the
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
  `abdoamdah3@gmail.com (pro)` (#83), and a real task restricted to #83 finished `done` with the
  result `OK` in 6 s. Quick add then got its sign-in window (`core/signin-window.ts`, driving
  `orchestrator/scripts/lib/signin_window.py`): Add account opens a new private window with
  zendriver (the owner's chosen engine; `python -m pip install zendriver`) on a throwaway profile,
  the owner does "Continue with email", the email code and Authorize there, and the page's final
  code goes to the CLI by itself before the window closes. The hand-off was checked headless (code
  in 1 s, no browser, Python process or profile left behind); a full sign-in through the window is
  the next account the owner adds.
- Quick add's Add button stayed disabled on first ship: a lint auto-fix turned `import { Input }`
  into a type-only import, so the tag rendered as a bare `<input>` whose v-model never updated.
  Fixed, with a `biome-ignore` naming why.
- UI rebuilt after a three-lens review (layout, states, affordance): the header says what CliMayte is
  and carries an "Add a CLI account" button that opens Quick add as a card; tasks sit in one panel
  grouped by hand-off; the sticky detail pane lists every account a task tried and why it moved on
  (`CliMayteWorkerDetail.vue`); status chips carry an icon and plain words (`lib/climayte-status.ts`). The
  message box says what sending does: queued after the current step on a live task, a new turn of
  the same conversation on a finished or stopped one (that is what `climayteSend` does).
