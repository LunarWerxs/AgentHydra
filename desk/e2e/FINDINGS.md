# Engine end to end: findings (2026-10-04)

`bun run e2e:engine` (e2e/engine.e2e.ts) boots `createServer` on port 0 with `HYDRA_DESK_HOME` in a fresh
temp folder and the real `query()` from `@anthropic-ai/claude-agent-sdk@0.3.288`. The only wrapper
records the options each `query()` gets, for steps 5 and 6. It picks a real CLI account from
`GET /api/accounts` and runs four short model turns on it with model `sonnet` (override with
`E2E_MODEL`). Every check prints PASS or FAIL with what it saw. The script exits 1 on any FAIL, then
deletes its chats, stops the server and removes the temp folder.

## What ran

1. Account: Pro, signed in, `inUse` false, lowest 5-hour %, then lowest weekly %. It is pinned by
   `accountId` and printed only by its number.
2. Create plus the first turn ("Reply with exactly the word pong..."), recording the statuses,
   the reply, the result item, `costUsd` and `contextPct`.
3. A permission round trip in `default` mode (Write hello.txt), answered through
   `POST /api/chats/:id/permission/:requestId` with `allow`.
4. A long turn (`sleep 60`), interrupted once the first `tool_use` item appears.
5. Server restart on the same home: the chat comes back `closed` with its items. A send resumes the
   stored session and recalls "pong".
6. Delegation options read from the recorded `query()` options, with no model turn: `disallowedTools`
   and the `systemPrompt.append` text.

## Result (run 2, after the final edit; exit code 0)

```
PASS [1 account] a signed-in Pro account with no live sessions (24 of 42 qualify) :: #83 5h 0% week 65%
PASS [2 create] chat pinned to the picked account (not auto) :: #83
PASS [2 status] statuses starting -> working -> idle :: closed > starting > working > idle
PASS [2 reply] an assistant_text item containing pong :: pong
PASS [2 result] a result item with ok true :: {"kind":"result",...,"ok":true,"durationMs":5105,"costUsd":0.0434167,"turns":1}
PASS [2 cost/context] costUsd and contextPct set :: {"costUsd":0.0434167,"contextPct":3}
PASS [2 no tools] no tool was used :: {"strays":[],"toolUses":[]}
PASS [3 permission] a permission item, state pending :: {"toolName":"Write","state":"pending"}
PASS [3 needs_you] chat status needs_you, pendingCount 1 :: {"status":"needs_you","pendingCount":1}
PASS [3 file] hello.txt on disk containing hi :: hi
PASS [3 idle] status back to idle, the request allowed :: {"status":"idle","pendingCount":0,"state":"allowed"}
PASS [4 interrupt] status stopped, no error :: {"tool":"Bash","status":"stopped","lastError":null,"errorItems":0,"ms":290}
PASS [5 reload] the chat comes back closed with its items :: {"status":"closed","items":11,"before":11}
PASS [5 resume] the new runtime resumes the stored sessionId :: {"stored":"b5ba4ff4-…","resume":"b5ba4ff4-…"}
PASS [5 answer] the answer contains pong :: {"status":"idle","reply":"pong"}
PASS [6 delegate] delegateToCliMayte default on: Agent and Task disallowed, append names climayte_run :: {"setting":true,"chat":true,"disallowedTools":["Agent","Task"],"appendMentionsClimayteRun":true}
16 passed, 0 failed
```

Run 1, before the cleanup fix, also passed 16 of 16. It left the temp folder behind; see defect 3.

## Timings and cost (measured)

| | run 1 | run 2 |
| --- | --- | --- |
| first token, new chat (send to first `item.delta`, CLI start included) | 46.5 s | 7.0 s |
| turn 1 "pong" (send to idle) | 47.6 s | 7.7 s |
| turn 2 Write with permission (send to idle, including the approval) | 12.3 s | 5.4 s |
| interrupt (POST to `stopped`) | 1.1 s | 0.29 s |
| turn 3 after restart (resume start included) | 37.8 s, first token 37.4 s | 17.0 s, first token 14.4 s |
| SDK `durationMs` for "pong" | 11.6 s | 5.1 s |
| total cost reported (`costUsd`, four turns) | $0.2434 | $0.1817 |

The SDK's own `durationMs` is much shorter than our send-to-reply time. The rest is CLI start-up:
spawning the CLI, loading user/project settings, connecting the agenthydra MCP and the account's
MCP servers, and running SessionStart hooks. Run 1 ran on a busy box: fairjob waited for CPU slots
before it started. A single one-word reply costs $0.04 to $0.08. That cost is the claude_code preset,
plus the CLAUDE.md files it loads (defect 2), plus the MCP tool lists.

## Defects

1. **The chat env passes the server's whole process env through to the CLI**
   (`server/src/engine/chat-runtime.ts:140`, `{ ...this.baseEnv, ...SESSION_STATE_ENV }`). If the server
   starts from a Claude Code session, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` reach every chat's
   CLI. If an `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` is ever in the
   server's env, it takes precedence over the account login that `CLAUDE_CONFIG_DIR` points at. That
   is API billing instead of the plan, and the account badge would be wrong. The e2e strips these
   variables through `deps.env`, so the proof runs on the account login. **Not fixed:** none of these
   variables is set in the launcher's normal start, so the proof was not blocked. Suggested fix: delete
   those keys in `buildOptions()`.
2. **Every chat on a CliMayte account loads the CliMayte worker contract as its user CLAUDE.md.**
   `CLAUDE_CONFIG_DIR` is the AgentHydra instance folder (`chat-runtime.ts:141`), and `settingSources`
   includes `'user'` (`chat-runtime.ts:148`). 34 of the 41 instance folders have a `CLAUDE.md`: the
   "Rules for a CliMayte worker" text, which says the FIRST action is `prompt_get climayte_worker`. So
   an interactive Hydra Desk chat on those accounts is told it is a headless worker. In the e2e the
   model obeyed "Do not use any tools", but on a normal prompt it can follow the worker rules.
   Separately, a cwd under `C:\Users\me` also loads `C:\Users\me\.claude\CLAUDE.md` as an
   ancestor project file. **Not fixed:** this is a design call (which instructions a Desk chat should
   get, and whether to drop `'user'` or point to Jacob's own `~/.claude` instructions), and it is too
   big for this piece.
3. **A process from the chat holds the work folder after `server.stop()`** (seen in e2e cleanup). In
   run 1, deleting the temp folder failed for 5 s after stop and only worked later by hand; in run 2 it
   took 2.1 s. The likely holder is the CLI process, or the Bash child of the interrupted `sleep 60`,
   still exiting after `ChatRuntime.close()` (`chat-runtime.ts:288`): `close()` does not wait for the
   child process to exit. That is harmless for the app. A test that deletes its cwd must retry, so the
   e2e now retries for up to 90 s and prints how long removal took (`e2e/engine.e2e.ts`, cleanup
   block). **Fixed in e2e only.**
4. **Cold start is slow and varies** (7 s to 47 s to the first token on a new chat; 14 s to 37 s on a
   resume). There is no bug in our code here, but the sidebar shows `starting` for that whole time,
   which is accurate. If it matters: prewarm (the SDK has a prewarm and spare-query mechanism, see
   sdk.d.ts around line 2785), or start fewer MCP servers.

No defect blocked the proof, so no server code was changed.
