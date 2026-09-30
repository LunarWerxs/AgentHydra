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
}

export interface CorchWorker {
  id: string             // short id, e.g. 'w-' + 8 hex chars
  group: string          // caller-chosen or generated 'g-' + 6 hex; groups one orchestration
  title: string          // short label (caller's or the first 60 chars of the prompt)
  cwd: string
  prompt: string         // the task as given
  pending: string[]      // follow-up messages not yet delivered (FIFO)
  model: string | null
  effort: string | null
  accounts: string[] | null  // restrict to these CLI instance ids (null = every signed-in one)
  status: CorchStatus
  sessionId: string | null   // minted by Corch before the first launch (`--session-id`)
  accountId: string | null   // the account holding the session now
  attempts: CorchAttempt[]
  result: string | null      // the final `result` text of the last completed turn
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
- stdout/stderr go straight to files (`openSync(path, 'a')`), not pipes, so a daemon restart does
  not kill the worker through a broken pipe.
- Never `detached`: on Windows that is DETACHED_PROCESS and every console child the CLI starts
  (bash, git, MCP servers) would flash its own window. `windowsHide` gives the whole tree one
  hidden console.
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
    session may have written nothing yet; that is fine, see below).
  - `transient`: `retries < 3` → `notBefore = now + [5, 10, 20]s[retries]`, `retries++`, requeue
    on the same account (resume if the session file exists, else first-attempt again);
    otherwise `failed`.
  - `error`: status `failed`, `error` = the result text or the stderr tail (last 1,500 chars).
- **queued / waiting**: when `notBefore` has passed, `pickAccount(worker)`; none → `waiting`
  with `error` naming why (every account walled / none signed in); else launch.

Emit a change event (`onCorchChange(cb) → unsubscribe`) whenever a worker's status changes, so
`corch_status` can wait without polling.

### Pure helpers (exported; the tests pin these)

- `classifyAttempt(events: unknown[], stderr: string): { outcome: AttemptOutcome; notice: string | null; result: string | null; costUsd: number; turns: number }`
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
  `max(sessionPct ?? 50, weekPct ?? 50) + 25 * active`; lowest wins; ties by `num`.
- `copySessionTranscript(fromConfigDir, toConfigDir, sessionId): boolean`: find
  `<from>/projects/*/<sessionId>.jsonl`, copy it (and a sibling `<sessionId>/` directory when
  present, recursively) into `<to>/projects/<same folder name>/`. Returns false when the source is
  missing (then the next attempt starts fresh with `--session-id` and the ORIGINAL task prompt,
  because nothing was recorded).

Production accounts: `listCliInstances()` filtered to `loggedIn`, each with `sessionPct` /
`weekPct` from `lastUsageCheck.session.pct` / `lastUsageCheck.weekAll.pct` (null when absent).
Tests replace the provider with `setCorchAccountsProvider(fn | null)`.

### API (what routes and MCP call)

```ts
export function corchRun(input: { tasks: Array<{ prompt: string; cwd: string; title?: string; model?: string; effort?: string }>; group?: string; accounts?: string[]; perAccount?: number }): { group: string; workers: CorchWorkerView[] }
export function corchList(filter?: { group?: string; id?: string; active?: boolean }): CorchWorkerView[]
export function corchGet(id: string): (CorchWorkerView & { events: string[] }) | null  // events = last 60 summarised lines
export async function corchWait(filter: { group?: string; id?: string }, timeoutMs: number): Promise<CorchWorkerView[]>
   // resolves on the first status change in scope, or at timeout, with corchList(filter)
export function corchSend(id: string, text: string): { ok: boolean; message: string }
export function corchCancel(filter: { id?: string; group?: string }): { cancelled: string[] }
export function startCorch(): void
```

`CorchWorkerView` = the worker minus `prompt` beyond 300 chars and minus attempt log paths, plus
`account` (`#<num> <name>` or null), `elapsedS`, and `attempts` as `{ account, outcome, notice }`.
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

- `GET /api/corch/workers?group=&active=1` → `corchList`
- `GET /api/corch/workers/:id` → `corchGet`
- `POST /api/corch/workers` body `{ tasks, group?, accounts?, perAccount? }` → `corchRun`
- `POST /api/corch/workers/:id/send` `{ text }` → `corchSend`
- `POST /api/corch/cancel` `{ id? , group? }` → `corchCancel`
- `POST /api/cli-instances/quick-add` `{ email }` → `startQuickAdd`
- `GET /api/cli-instances/quick-add` → `listQuickAdds`
- `POST /api/cli-instances/quick-add/:id/code` `{ code }` / `POST .../:id/cancel`

Registered in `server/src/index.ts` beside the other route modules; `startCorch()` is called at
boot after the stores are ready.

## MCP tools (`server/src/mcp.ts`)

- `corch_run { tasks: [{ prompt, cwd, title?, model?, effort? }], group?, accounts?, per_account? }`
  MUTATES. Description says: when the owner tells a chat to corch a task or fully delegate it,
  the chat keeps only the orchestration and every piece of work goes here; each task must be
  self-contained (a CLI worker sees none of this chat), name its folder, and say what "done"
  means and what proof to report; workers run on the owner's CLI accounts, move to another
  account by themselves at a usage limit, and are visible in AgentHydra's Corch view.
- `corch_status { group?, id?, wait_seconds? (0..600) }` → views; with `wait_seconds` it waits for
  the next status change in scope (use this instead of polling).
- `corch_send { id, text }` MUTATES: a follow-up turn in the same session.
- `corch_cancel { id?, group? }` MUTATES.
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
  elapsed, `lastActivity`, moves. Selecting a row shows `events`, `result`/`error`, a follow-up
  box (`/send`) and Stop (`/cancel`). Poll every 3 s while any worker is active.
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
- Not yet proven: a real task finishing on a signed-in account, and a quick-add sign-in completed in
  the browser. Both need the owner to add an account first.
- Quick add's Add button stayed disabled on first ship: a lint auto-fix turned `import { Input }`
  into a type-only import, so the tag rendered as a bare `<input>` whose v-model never updated.
  Fixed, with a `biome-ignore` naming why.
- UI rebuilt after a three-lens review (layout, states, affordance): the header says what Corch is
  and carries an "Add a CLI account" button that opens Quick add as a card; tasks sit in one panel
  grouped by hand-off; the sticky detail pane lists every account a task tried and why it moved on
  (`CorchWorkerDetail.vue`); status chips carry an icon and plain words (`lib/corch-status.ts`). The
  message box says what sending does: queued after the current step on a live task, a new turn of
  the same conversation on a finished or stopped one (that is what `corchSend` does).
