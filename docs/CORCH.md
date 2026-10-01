# Corch: orchestrate work onto CLI accounts

Corch ("CLI orchestration") lets one chat hand a whole task to the owner's Claude Code CLI
accounts. The chat keeps only the orchestration: it splits the task, dispatches each piece, reads
the results and checks them. Every piece of real work runs as a Claude Code CLI session on one of
the CLI instances AgentHydra manages, spread across the accounts by headroom, and **moved to
another account automatically when one hits its usage limit** (a Pro account's 5-hour window
lasts about ten minutes of heavy work; before Corch a person moved the thread by hand each time).

Quick add is the other half: type an email, confirm in the browser, and that account is a CLI
instance Corch can use. No naming, no terminal, no `/login`.

## Owner rulings

- **2026-09-30, Michael:** "give you a task in a chat ... I want this fully delegated ... delegate
  every part of it, except for the absolute bare orchestration level ... orchestrating them only
  to CLI, not desktop instances ... a super fast way to log in to multiple CLI instances ... Ask
  for an email, I'll give it to you, then you open the login page, and then I confirm it."
- **No console windows, and no chat nobody can see** (2026-08-27 / 2026-08-31, `headless-policy.ts`,
  `session-launch.ts`). Corch satisfies both: a worker runs with no window (`windowsHide`), and every
  worker is readable live and steerable in AgentHydra (the Corch view, `corch_status`), and its
  transcript is an ordinary Claude Code session in that account's folder that a person can resume
  by hand. Corch is the one named exemption from the headless ban; queue dispatch stays refused.
- Corch runs only when a person started it (a chat he told to corch a task, or the Corch view).
  It is his per-task grant to use the CLI accounts; it is not standing permission for anything else.

## Server: `server/src/corch.ts`

### Records

```ts
export type CorchStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
// waiting = no eligible account right now (all at their limit or signed out); retried every tick
export type AttemptOutcome = 'running' | 'done' | 'quota' | 'transient' | 'auth' | 'error' | 'cancelled'

export interface CorchAccountRef { id: string; num: number | null; name: string }

export interface CorchAttempt {
  account: CorchAccountRef
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

export interface CorchWorker {
  id: string             // short id, e.g. 'w-' + 8 hex chars
  group: string          // caller-chosen or generated 'g-' + 6 hex; groups one orchestration
  title: string          // short label (caller's or the first 60 chars of the prompt)
  cwd: string
  prompt: string         // the task as given
  pending: string[]      // follow-up messages not yet delivered (FIFO)
  model: string | null       // full id (claude-opus-5-5 / claude-sonnet-5-5); null = the CLI's default
  effort: string | null      // low | medium | high | xhigh | max; null = the CLI's default
  accounts: string[] | null  // restrict to these CLI instance ids (null = every signed-in one)
  status: CorchStatus
  sessionId: string | null   // minted by Corch before the first launch (`--session-id`)
  accountId: string | null   // the account holding the session now
  attempts: CorchAttempt[]
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
  createdAt: number
  updatedAt: number
}
```

Persisted with `core/json-store.ts` at `<CONFIG_DIR>/corch/workers.json` (`{ workers: CorchWorker[] }`,
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
  `setCorchClaudeCommand(['bun', '<fake script>'])` (pass `null` to restore).
- `env` = `process.env` minus every key matching
  `/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(OAUTH_\w+|ENTRYPOINT|SSE_PORT|SESSION\w*)|CLAUDECODE|CLAUDE_CONFIG_DIR)$/`,
  plus `CLAUDE_CONFIG_DIR = account.configDir` and `AGENTHYDRA_CORCH_WORKER = worker.id`. The
  worker must bill its OWN login, never an inherited key or token.
- The CLI runs under a RUNNER, never as the daemon's own child (`509c3f7`, see "Runner and
  restarts" below): stdin/stdout/stderr are the attempt's prompt, log and error FILES, so nothing
  ties the CLI to the daemon, and a daemon restart leaves it running.
- The prompt of a first attempt is the task. A follow-up attempt's prompt is the next `pending`
  message. A handoff attempt's prompt is `HANDOFF_PROMPT`:
  "This session was moved to another account because the previous one reached its usage limit.
  Continue the task exactly where you left off. Do not redo steps that are already finished."
- `WORKER_BRIEF` (exported constant):
  "You are a Corch worker: a Claude Code CLI session that AgentHydra started on one of the
  owner's accounts, at the owner's request, to do one delegated task for an orchestrating chat.
  Do the whole task yourself, in this session. Nobody is watching to answer questions, so make
  the reasonable call and say which call you made. Follow the repository's own rules. Commit only
  the files you changed, and push if the repository's rules say to. Never read or print a secret
  value. End with a short report: what you did, the proof you saw (a command and what it
  printed), and anything left undone with the reason."

### Runner and restarts (`server/src/corch-runner.ts`)

Owner, 2026-09-30: restarting AgentHydra must not break Corch workers. A `Bun.spawn` child sits in
the daemon's kill-on-close job on Windows, so a restart used to kill every worker (it then resumed
as `interrupted` and redid its step); `detached` is no escape (DETACHED_PROCESS flashes a console).

- `launchRunner(spec)` writes `<log>.spec.json` and starts this program in `--corch-runner <spec>`
  mode (`main.ts`) through the WMI hand-off (`detached-spawn.mjs`, `hideWindow`): it is born
  outside the daemon's tree (parent WmiPrvSE.exe). The runner reads and deletes the spec (it holds
  the CLI's env), starts the CLI with the attempt's files, writes `<log>.pid.json`
  (`{ runner, child }`), waits, and writes `<log>.exit.json`.
- The attempt records `runner: { pid, pidFile, exitFile, launchedAt }`; `attempt.pid` is the CLI's.
  `attemptExited()` reads only files: an exit file means ended; a runner gone without one died
  (`finish` reads it as interrupted); no pid file within a minute means it never started. A runner
  pid is trusted only once its command line names the attempt's spec (`isOurRunner`), so a pid
  Windows reused is never followed or killed. `killAttempt` kills the runner's tree.
- `corchRunningCount()` counts only pre-runner workers, so `/api/daemon/restart` needs no `force`
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
- `corchTotals()` (`GET /api/corch/totals`) sums tasks, runs (`sessions`: every start of the CLI,
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
  meter with R^2 0.02). So Corch does not turn on the CLI's compaction
  (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`): replayed on run 1, a 200k window cut tokens 26% but its
  summaries and re-written cache would have spent about two more Pro windows.
- `corchRemove(ids)` (`POST /api/corch/remove`) drops finished tasks; their logs and transcripts
  move to `corch/archive/<stamp>/<id>/`, never deleted. 121 test tasks were archived this way.
- `corchLiveReadings()` hands each account's newest streamed reading to `usage-live.ts`, which lays
  it over the cached snapshot in `GET /api/usage/cache` and `GET /api/cli-instances`: the usage
  sweep reads each account only every 30 minutes, a running worker's reading is seconds old
  (`6c34872`; #84 read 34% in the table while its workers streamed 85-88%). The readings are kept
  in `corch/live.json` across restarts (a restart used to drop them, and the table fell back to a
  snapshot from before the limit); a reading whose window has reset is void.
- `corchLimitWalls()` lays Corch's usage-limit walls over the same tables (`withLimitWall`): a
  walled account shows that window at its limit (at least 100%, the wall's reset time) until the
  wall ends (field note 19: five walled accounts read 43-50%). The chips say "Limit" at or past
  100%: Anthropic reports 101-106% once a window is spent, because requests already running when
  it hit still count.

### Model and thinking (field note 16)

The orchestrating chat picks each worker's model and thinking level (owner, 2026-09-30). The CLI
(2.1.284) takes `--model <alias or full name>` and `--effort low|medium|high|xhigh|max`.
`corchModel(v)` maps `opus`, `opus-5.5`, `opus-5-5`, `claude-opus-5-5` (and the same four for
sonnet) to the full id (`CORCH_MODELS`), so a later alias move cannot change what a recorded task
asked for; `corchEffort(v)` accepts `CORCH_EFFORTS`. Blank means the CLI's default; anything else
throws with the valid values listed, so junk never reaches the CLI (`corchRun`: "task N: unknown
model ..."; `corchSend`: `ok: false`).

- `corchRun`'s top-level `model`/`effort` are the group default for tasks without their own.
- `corchSend(id, text, { model, effort })` sets them on the worker; they apply from the next
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

`startCorch()` starts one timer (3 s while any worker is queued/running/waiting, else 15 s;
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
  - `transient`: `retries < 3` → `notBefore = now + [5, 10, 20]s[retries]`, `retries++`, requeue
    on the same account (resume if the session file exists, else first-attempt again);
    otherwise `failed`.
  - `error`: status `failed`, `error` = the result text or the stderr tail (last 1,500 chars).
- **queued / waiting**: when `notBefore` has passed, `pickAccount(worker)`; none → `waiting`
  with `error` naming why (every account walled / none signed in); else launch.

Emit a change event (`onCorchChange(cb) → unsubscribe`) whenever a worker's status changes, so
`corch_status` can wait without polling.

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
- `pickAccount(worker, accounts: CorchAccount[], walls, active: Map<accountId, number>, perAccount: number, now): CorchAccount | null`
  where `CorchAccount = { id, num, name, configDir, sessionPct: number | null, weekPct: number | null }`.
  Eligible: in `worker.accounts` when set; not walled (`walls[id].until > now`); `sessionPct < 98`
  and `weekPct < 99` when known; `active < perAccount`. A handoff (last attempt `quota`/`auth`)
  excludes the account that failed. A follow-up prefers `worker.accountId` when eligible. Score =
  `max(sessionPct ?? 50, weekPct ?? 50) + 100 * active`; lowest wins; ties by `num`. `active` counts
  the workers running on the account from EVERY group (field note 8: at 25, a busy account at 0%
  still beat an idle one at 30%, so two orchestrations piled onto one account); `perAccount` stays
  a per-group cap, with `MAX_PER_ACCOUNT` above it in total. Past the wind-down line (85% session,
  95% week) an account takes no NEW work: not a new task, a handoff's continuation or a moved
  session, only the session already on it (its home). Run 1, 19:32-19:36: the one account below
  the line was at its worker cap, so twenty continuations went to accounts at 89-97% and were told
  to hand off again within three calls (about 290k tokens and $0.75 each). `roomElsewhere` (should
  a session near its limit hand off?) asks `pickAccount` itself, so worker caps count there too.
- `copySessionTranscript(fromConfigDir, toConfigDir, sessionId): boolean`: find
  `<from>/projects/*/<sessionId>.jsonl`, copy it (and a sibling `<sessionId>/` directory when
  present, recursively) into `<to>/projects/<same folder name>/`. Returns false when the source is
  missing (then the next attempt starts fresh with `--session-id` and the ORIGINAL task prompt,
  because nothing was recorded).

Production accounts: `listCliInstances()` filtered to `loggedIn`, each with `sessionPct` /
`weekPct` from `lastUsageCheck.session.pct` / `lastUsageCheck.weekAll.pct` (null when absent).
Tests replace the provider with `setCorchAccountsProvider(fn | null)`.

The login a listing reports is honest (field note 3): `loggedIn` only proves a credential file
exists, so corch.ts registers `setCliLoginVeto(corchSignedOutReason)` with `core/cli-instances.ts`.
An account Corch walls `signed out` (its last attempt failed `auth`, and its credential file has not
changed since) lists `loggedIn: false` with a `loginNote` saying why, in `list_cli_instances` and
the CLI tab alike, without running `claude auth status` per row. The wall is rechecked in the
background with `cliAuthStatus` every 30 min, and lifts at once when the credential file changes (a
fresh sign-in). An `organization disabled Claude Code` wall lists the same way with its own note,
and only a changed credential file lifts it.

### The owner's CLAUDE.md and skills (`server/src/corch-owner-sync.ts`)

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
  worker. Tests turn it on with `setCorchOwnerDir(dir | null)`; under `NODE_ENV=test` it is off.
- **The lean worker profile** (`8b3add7`, owner's yes 2026-09-30): when `~/.claude/corch-worker/`
  holds a `CLAUDE.md`, workers get that instead of the full one, and when it holds `skills.txt`
  (one skill name per line, `#` comments) only those skills are linked; the rest are unlinked at
  the next launch. The owner's profile lives in the claude-memory repo (`home/corch-worker/`,
  installed by `install.mjs`): 3 KB of rules and 12 engineering skills, against 44 KB and 84. Run 1
  measured what the full set cost: a fresh session's first request grew 57k -> 90k tokens
  (Connections) when it arrived, and that prefix is re-read on every request and written to cache
  on every fresh session and move.

### Scorecard (`server/src/corch-scorecard.ts`, `5710553`)

Owner, 2026-09-30: "the AI can try a model, and if it works, it gives it a thumbs up ... if it
does not, it reports the failure, and what model it tries next." Output, thinking included, is about
half of what fills a Pro account's 5-hour meter (field note 27), so the model and thinking level are
the biggest quota levers left, and the safe way to lower them is to learn from real results.

- **Verdicts.** `corchVerdict(id, { verdict, note?, retry?, kind? })` judges a FINISHED task (the
  orchestrator after checking its proof, or the owner's thumbs in the Corch view). Each
  `CorchVerdict { at, verdict, note, model, effort, units }` keeps the setting that produced the
  result and what the work since the previous verdict cost (`attemptUnits`: the plan-meter weights
  of `usage-tokens.ts`, 5-minute or 1-hour writes by the attempt's `cacheTtl`). A fail needs a note
  and goes back to the same session one rung up (`nextRung`, through `corchSend`), unless `retry`
  is false. Journal event `verdict`.
- **The ladder**, cheapest first: Sonnet 5.5 low, medium, high, then Opus 5.5 medium, high, xhigh,
  max. A CLI-default setting counts as Opus high.
- **Kinds**: code, debug, review, sweep, mechanical, docs, trivial (`corch_run` `kind`). Each starts
  where the corch skill's table puts it (sweep, mechanical and docs on Sonnet medium, trivial on
  Sonnet low, code and review on Opus high, debug on Opus xhigh).
- **`model: "auto"`** (`pickConfig`): the cheapest rung with at least 3 verdicts at 80% or more
  passes, else the kind's start moved up past any rung with two or more verdicts under half; every
  4th auto pick of a kind tries the rung below that, unless it keeps failing. The pick and its reason
  go in the `dispatched` journal line.
- **`corchScorecard()`** (`GET /api/corch/scorecard`, `corch_scorecard`): passes, fails and cost per
  task as a share of a Pro 5-hour window (`UNITS_PER_PRO_PERCENT` = 320,000 weighted units per 1%,
  fitted on run 1, R^2 0.48) per kind and setting, `pick` on the next auto setting. The Corch view
  shows it as "What works" and puts thumbs up/down on a finished task.

### Journal (`server/src/corch-journal.ts`)

The owner's ask on the first real run ("we probably also need logging in Corch"): one short JSON
line per state change of every worker, appended to `<CONFIG_DIR>/corch/journal.jsonl`. At 5 MB it
rotates to `journal.1.jsonl` (one previous file kept). A failed write is logged and dropped; the
journal never stops a worker.

```ts
interface CorchJournalEntry {
  ts: string; id: string; group: string; title: string; event: CorchJournalEvent
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
}
```

Events: `dispatched`, `launched` (with the account's session/week % and how many workers it already
ran, the two things `pickAccount` scores on), `moved`, `limit`, `signed-out`, `handoff-requested`,
`handoff-written`, `handoff-resumed`, `follow-up-queued`, `follow-up-delivered`, `retry`,
`interrupted` (its CLI ended with no result: killed from outside, or a pre-runner worker at a
restart), `waiting`, `turn-end` (each turn's closing
text, first line), `turn-done`, `done`, `failed`,
`cancelled`. Read with `corchJournal(filter)` (entries, oldest first, the newest `limit`, default
100) or `corchJournalLines(filter)`, one readable line each, e.g.
`23:41:07 w-1234abcd 'Fix events rows' launched on #84 (session 12%, week 0%, 0 active)`; when a
model or effort was asked for, the line ends ` with claude-opus-5-5, effort max`.

### API (what routes and MCP call)

```ts
export function corchRun(input: { tasks: Array<{ prompt: string; cwd: string; title?: string; model?: string; effort?: string }>; group?: string; accounts?: string[]; perAccount?: number; model?: string; effort?: string }): { group: string; workers: CorchWorkerView[] }
   // top-level model/effort: the group default for tasks without their own
export function corchList(filter?: { group?: string; id?: string; active?: boolean; limit?: number; brief?: boolean }): CorchWorkerView[] | CorchWorkerBrief[]
   // `limit`: every active worker plus only that many most recently finished ones, newest first
   // (recentWorkers); `brief`: without the prompt, and only the last 3 attempts (+ attemptCount)
export function corchGet(id: string): (CorchWorkerView & { events: string[] }) | null  // events = last 60 summarised lines
export async function corchWait(filter: { group?: string; id?: string }, timeoutMs: number): Promise<CorchWorkerView[]>
   // resolves on the first status change in scope, or at timeout, with corchList(filter)
export function corchSend(id: string, text: string, opts?: { urgent?: boolean; model?: string; effort?: string }): { ok: boolean; message: string; model?: string | null; effort?: string | null }
   // to a running worker: held until its task ends; `urgent` stops the running work and sends it first
export function corchHandoff(id: string): { ok: boolean; message: string }
export function corchCancel(filter: { id?: string; group?: string }): { cancelled: string[]; keptMessages: number }
   // queued follow-ups are kept and delivered, in order, when the worker is continued
export function corchJournal(filter?: { group?: string; id?: string; since?: string; limit?: number }): CorchJournalEntry[]
export function corchJournalLines(filter?: …): string[]
export function startCorch(): void
```

`CorchWorkerView` = the worker minus `prompt` beyond 300 chars and minus attempt log paths, plus
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
  the same env scrub as Corch, `stdin: 'pipe'`, `stdout`/`stderr: 'pipe'`, `windowsHide: true`.
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

## Routes: `server/src/routes/corch.ts`

- `GET /api/corch/workers?group=&id=&active=1&limit=&brief=1&wait=` → `corchList` (`wait`
  seconds: first wait for the next status change in scope, via `corchWait`)
- `GET /api/corch/workers/:id?wait=` → `corchGet` (404 when unknown)
- `GET /api/corch/journal?group=&id=&since=&limit=&format=lines` → `corchJournal`, or
  `corchJournalLines` with `format=lines`; `since` is an ISO time or epoch ms
- `POST /api/corch/workers` body `{ tasks, group?, accounts?, perAccount?, model?, effort? }` → `corchRun`
- `POST /api/corch/workers/:id/send` `{ text, urgent?, model?, effort? }` → `corchSend`
- `POST /api/corch/workers/:id/handoff` → `corchHandoff`
- `POST /api/corch/cancel` `{ id? , group? }` → `corchCancel`
- `GET /api/corch/totals` → `corchTotals`; `POST /api/corch/remove` `{ ids }` → `corchRemove`
- `POST /api/cli-instances/quick-add` `{ email, instanceId? }` → `startQuickAdd` (`instanceId`
  signs that existing instance in again, replacing its login: a CLI row's Log in)
- `GET /api/cli-instances/quick-add` → `listQuickAdds`
- `POST /api/cli-instances/quick-add/:id/code` `{ code }` / `POST .../:id/cancel`

Registered in `server/src/index.ts` beside the other route modules; `startCorch()` is called at
boot after the stores are ready.

## MCP tools (`server/src/mcp.ts`)

- `corch_run { tasks: [{ prompt, cwd, title?, model?, effort? }], group?, accounts?, per_account?, model?, effort? }`
  MUTATES. Description says: when the owner tells a chat to corch a task or fully delegate it,
  the chat keeps only the orchestration and every piece of work goes here; each task must be
  self-contained (a CLI worker sees none of this chat), name its folder, and say what "done"
  means and what proof to report; workers run on the owner's CLI accounts, move to another
  account by themselves at a usage limit, and are visible in AgentHydra's Corch view. Answers
  only `{ group, workers: [{ id, title, status, account }] }` (field note 7: the full view echoed
  every prompt back). `model` (opus or sonnet) and `effort` (low..max) get one description line
  each; the top-level pair is the group default.
- `corch_status { group?, id?, active?, limit?, wait_seconds? }`: `id` → that ONE worker's detail
  (`corchGet`, with its `events`; field note 4). Otherwise a brief list, newest first: a `group`'s
  workers, else every active worker plus the 20 (`RECENT_FINISHED`, or `limit`) most recently
  finished (field note 1: unscoped, it answered all 141 workers ever recorded, 51k characters, and
  overflowed the MCP result); `active: true` lists only queued/running/waiting ones. With
  `wait_seconds` it waits for the next status change in scope (use this instead of polling); waits
  are cut to `CORCH_MAX_WAIT_S` (45 s): an MCP client drops a call held about 60 s.
- `corch_log { group?, id?, since?, limit? }`: the journal as readable lines, newest last, default
  100.
- `corch_send { id, text, urgent?, model?, effort? }` MUTATES: a follow-up turn in the same session;
  `urgent` stops a running worker and delivers this first; `model`/`effort` switch them for that
  turn and later ones (e.g. escalate a stuck Sonnet worker to Opus at `max`).
- `corch_handoff { id }` MUTATES: a running worker writes a handoff and goes on in a fresh session.
- `corch_verdict { id, verdict, note?, retry?, kind? }` MUTATES: pass or fail on a finished task; a
  fail goes back one rung up and the answer names `next`. `corch_run` takes `kind` per task and as a
  group default, and `model: "auto"`.
- `corch_scorecard {}`: what works per kind (see "Scorecard").
- `corch_cancel { id?, group? }` MUTATES; answers `keptMessages`, the queued follow-ups it kept.
`accounts` accepts CLI instance numbers or ids (resolve through the existing instance resolver).

## Web: Quick add and the Corch view

- `web/src/components/CliInstancesSection.vue`: a Quick add row at the top: one email input and
  an Add button (Enter submits). After a submit the input clears and keeps focus, ready for the
  next account. Each flow shows one line: "Confirm in your browser" with Open page again (the
  `url`), Paste code (a small input that posts to `/code`) and Cancel; then "Signed in as
  <email> (<plan>)" or the failure reason. Poll `GET /api/cli-instances/quick-add` every 2 s while
  any flow is `waiting`; refresh the instance list when one signs in.
- A **Corch** view (new `web/src/components/CorchView.vue`, reachable the same way the other top
  views are): workers grouped by `group`, newest first; each row: status chip, title, account,
  elapsed, `lastActivity`, moves, and a small run tag (`Opus 5.5 · max`: the model that ran, else
  the one asked for, and the effort; amber when the CLI ran another model than the one asked for;
  the hover lists both). Selecting a row shows `events`, `result` (each turn's text
  under "Turn n of m" when there was more than one)/`error`, a follow-up
  box (`/send`) and Stop (`/cancel`). Poll every 3 s while any worker is active.
- The worker detail has **Model** and **Thinking** rows (asked for, and what ran).
- The selected worker's **Log** (`CorchJournal.vue`, in `CorchWorkerDetail.vue`): the journal for
  that task, or for its whole group (a toggle), one rendered line per entry, reloaded when the task
  changes and every 10 s for a group.
- Every user-facing string goes through vue-i18n (`web/src/locales`), so `check:i18n` passes.

## Tests (`server/tests/corch.test.ts`)

One integration test and the pure helpers, per the test-audit bar:
- `classifyAttempt`: done, quota (synthetic notice), auth, transient, and a model that merely
  TALKS about a session limit is still `done`.
- `pickAccount`: skips walled and full accounts, excludes the failed account on a handoff, and
  spreads by the active count.
- Integration: two fake accounts (temp config dirs) and `tests/mocks/fake-claude.ts` via
  `setCorchClaudeCommand(['bun', <path>])`. The first account has a `fake-quota` marker file, so
  the fake prints a synthetic limit notice and exits 1; Corch walls it, copies the transcript,
  resumes on the second account, and the worker ends `done` with the fake's result text and
  `moves === 1`.

The fake CLI: parses `--session-id`/`--resume`, reads the prompt from stdin, and uses
`CLAUDE_CONFIG_DIR`. With `fake-quota` present it writes the session transcript
(`projects/fake-proj/<id>.jsonl`), prints `system/init`, an assistant message with
`model: '<synthetic>'`, `isApiErrorMessage: true` and text `You've hit your session limit · resets 4am`,
a `result` with `is_error: true` and the same text, then exits 1. Otherwise on `--resume` it
requires `projects/*/<id>.jsonl` in its own config dir (else prints `No conversation found` to
stderr and exits 1), appends to it, prints init, an assistant text and a `result` with
`is_error: false`, `result: 'FAKE DONE'`, `total_cost_usd: 0.01`, `num_turns: 1`, exits 0.

## Status (2026-09-30)

- Shipped on `main`: the runtime (`server/src/corch.ts`), its pure half (`server/src/corch-lib.ts`),
  quick add (`server/src/core/cli-quick-add.ts`), the routes, the four MCP tools, the Corch view with
  Quick add at its top (`web/src/components/CorchView.vue`, `CliQuickAdd.vue`), and the `corch` skill
  in the shared claude-memory repo.
- Proven: `server/tests/corch.test.ts` (9 tests, including a two-account handoff through
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
- UI rebuilt after a three-lens review (layout, states, affordance): the header says what Corch is
  and carries an "Add a CLI account" button that opens Quick add as a card; tasks sit in one panel
  grouped by hand-off; the sticky detail pane lists every account a task tried and why it moved on
  (`CorchWorkerDetail.vue`); status chips carry an icon and plain words (`lib/corch-status.ts`). The
  message box says what sending does: queued after the current step on a live task, a new turn of
  the same conversation on a finished or stopped one (that is what `corchSend` does).
