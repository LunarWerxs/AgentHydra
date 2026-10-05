# CliMayte on any model: Claude Code, Codex, swarm models, local models

Jacob, 2026-10-04: "This should work with CliMayte, which means CliMayte should work with Claude Code,
Codex, and any model that we have on our PC that is accessible."

This is a scoping plan. Nothing here is built yet. Paths without a prefix are in AgentHydra
(`C:/Users/me/Desktop/Project/Agent Hydra`, Michael's repo, read-only for us). Paths starting
`desk/` are Hydra Desk's own. Every observation was made on 2026-10-04 with GET requests to
127.0.0.1:7787 or with read-only commands, and none of them printed a name, an email or a key.

## 1. What works today

| # | Claim | Evidence | Observation |
|---|---|---|---|
| 1 | CliMayte runs **only the Claude Code CLI**. | `server/src/climayte-core.ts:216` (`claudeCommand = () => [resolveClaudeExe()]`); `server/src/climayte-launch.ts:415-439` (`cliArgv`: `-p --output-format stream-json --session-id/--resume --model --effort --settings --append-system-prompt`); `docs/CLIMAYTE.md:3-8`. `rg -i codex server/src/climayte*.ts` finds nothing. | `GET /api/corch/workers?limit=0`: 10 workers running, all Claude (5 `claude-opus-5-5`, 5 `claude-sonnet-5-5`; kinds 8 code, 2 docs). `GET /api/corch/totals`: 384 tasks, 876 runs, 768 CLI sessions. |
| 2 | A worker's model is limited to **Haiku 4.5, Sonnet 5.5 and Opus 5.5**. Any other name is refused. | `server/src/climayte-lib.ts:532-549` (`CLIMAYTE_MODELS`), `:553-560` (`climayteModel` throws "use auto, haiku, sonnet or opus"); `server/src/mcp.ts:780-784` (the `climayte_run` model description); the scorecard ladder in `docs/CLIMAYTE.md:455-467`. | `GET /api/corch/scorecard` answers `{ unitsPerPercent, rows }`. Its units are fitted on Claude's Pro meter (`UNITS_PER_PRO_PERCENT`, `docs/CLIMAYTE.md:474-477`). |
| 3 | `kind` is a scorecard label: code, debug, review, sweep, mechanical, docs, trivial, manage. It does **not** pick a runtime. | `server/src/climayte-scorecard.ts:27-37`; `desk/server/src/bridge/client.ts:111-135` (`AhWorker.kind/model/effort/reportedModel`); `desk/server/src/bridge/climayte.ts:37-39` maps them straight through. | The workers above carry `kind` and `model` and no runtime field. |
| 4 | The account pool is **Claude CLI instances only**. Placement reads `cli:<id>` usage. | `server/src/climayte-core.ts:416-418` (`listCliInstances().filter(loggedIn)`); `:434` (`latestUsage` reads ``cache[`cli:${id}`]``). | `GET /api/cli-instances`: 41 instances, 39 signed in (36 Pro, 1 Max 5x, 4 with no plan reading). |
| 5 | A worker's environment **strips** `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, so a CliMayte worker cannot be pointed at another provider's Anthropic endpoint. | `server/src/climayte-lib.ts:819`. | n/a (a constant). |
| 6 | AgentHydra **manages Codex accounts**: it can list and create them, read their usage, move chats between them and copy their transcripts. It **cannot run a Codex task headless**. `launch_codex_instance` opens a visible terminal. | `server/src/mcp.ts:1206-1233`; `server/src/core/codex-instances.ts:707-790` (`windowsTerminalArgv` = `cmd /c start ... cmd /k`, `server/src/core/launch-options.ts:30`; the comment at `codex-instances.ts:752` says "`start` still creates the visible inner terminal"); `server/src/core/codex-rpc.ts:5-21` (`app-server` connection that "never starts a model turn"); `server/src/core/codex-transcript-copy.ts`; `server/src/core/codex-account.ts:35-42,349-364` (rate-limit windows); `server/src/config.ts:425-446` (`resolveCodexExe`). | `GET /api/codex-instances`: 1 instance (#8), signed in. `GET /api/usage/cache` → `codex:default`: 5-hour 0%, week 1%, read 13:21Z. That is the same `UsageSnapshot` shape (`session`, `weekAll`) that placement reads for Claude. |
| 7 | The Codex CLI on this PC can run headless. It supports JSON events, resume, a model flag, config overrides, a prompt on stdin and local providers. | `codex exec --help` lists `--json`, `resume`, `-m`, `-c`, `--oss`, `--local-provider <lmstudio\|ollama>`, `-C`, `--dangerously-bypass-approvals-and-sandbox`, `-o`, and "if `-` is used, instructions are read from stdin". | `codex-cli 0.155.0-alpha.9.2` at `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`. It is not on PATH (`command -v codex` finds nothing). `resolveCodexExe` finds it. |
| 8 | **Claude Code on non-Claude models already exists** in HSwarm. Its `backend: "cc"` runs headless Claude Code against a provider's Anthropic endpoint. For a provider that only speaks OpenAI chat it uses a loopback facade, so Gemini, Groq, Cerebras and any added OpenAI-compatible endpoint work too. | `docs/HSWARM-API.md:177` (backend cc); `hswarm/claude_env.py:117-147` (`cc_env`: sets `ANTHROPIC_BASE_URL`, the key, `ANTHROPIC_MODEL`); `hswarm/anthropic_facade.py:5-15`; `anthropic_url` in `hswarm/providers/{deepseek,openrouter,huggingface}.toml` (native) and `{gemini,groq,cerebras}.toml` (`"facade"`); `docs/HSWARM-API.md:51,55` (`providers/add` with any `base_url`, `models/add`). | See row 9. Today it is not running. |
| 9 | **HSwarm is down right now.** The ZSwarm it replaced (retired 2026-10-03) is still the server answering on this machine. | `server/src/hswarm.ts:20-28` (`hswarmDir`: `AGENTHYDRA_HSWARM_DIR`, else `hswarm/__init__.py` beside the app root or one level up). | `GET /api/hswarm/health` → 503, `"hswarm is not running"`, lastError `"hswarm package not found (no hswarm/__init__.py beside the app)"`. 127.0.0.1:7793 refuses connections. A `pythonw ... zswarm.py mcp --http --port 7790` process is running. A hook on this machine refuses commands that name the old ZSwarm folder ("ZSwarm is retired ... HSwarm replaces it"). |
| 10 | **No local model is reachable.** | n/a | 11434 (Ollama), 1234 (LM Studio), 8080, 8000, 1337 and 8081 all refuse. Ollama is not installed. The LM Studio app is installed (`%LOCALAPPDATA%\Programs\LM Studio`), but its server is off and there is no `~/.lmstudio` or `~/.cache/lm-studio` models folder. ComfyUI runs on loopback, but it is an image model and cannot run a chat. UNVERIFIED: an LM Studio models folder in a custom place. |
| 11 | Hydra Desk runs chats **only on Claude logins**. It sees CliMayte workers but does not dispatch them itself: chats dispatch through the agenthydra MCP. | `desk/server/src/engine/chat-runtime.ts:137-159` (`CLAUDE_CONFIG_DIR` from the account, `disallowedTools` Agent/Task when delegating, `mcpServers.agenthydra`); `desk/server/src/engine/models.ts:11-17` (Claude models only); `desk/shared/protocol.ts:21-26` (`AccountRef` = a Claude login); `desk/server/src/bridge/client.ts:213-233` (GETs plus cancel and send, no `POST /api/corch/workers`); `desk/server/src/engine/desk-prompt.ts:8-9`. | `desk/shared/protocol.ts:167` already allows `ExternalSession.source: 'codex'`, and `desk/server/src/bridge/external.ts:75` maps it, so Codex sessions can already show in the sidebar. |

## 2. Gaps

1. **HSwarm is not running** (row 9), so no swarm or local model is usable through AgentHydra today. Chats that still call `zswarm_*` reach the retired server.
2. **CliMayte has no runtime field.** A worker is a Claude CLI session by construction: the launcher, the event classifier (`classifyAttempt`, `server/src/climayte-lib.ts:1019`), the spend reader (`attemptSpend`, `:1140`, which reads Claude transcripts), `summarizeEvent` (`:1235`), the account pool and the model whitelist all assume it.
3. **Codex has no headless worker.** There is no `codex exec` runner, no parser for Codex `--json` events or rollouts, and no limit notice classifier for Codex. The only launch path opens a visible console, which breaks the no-console rule.
4. **The placement cost model is Claude-only.** `expectedCost`, `planFactor` and the units-per-percent fit (`server/src/climayte-placement.ts:53,66,116`) are fitted on Claude Pro meters. A Codex meter and a dollar budget are not in the same units.
5. **No local endpoint exists** (row 10). One would also need registering with HSwarm (`providers/add` + `models/add`), and that changes Jacob's HSwarm state.
6. **The swarm facade is per run.** Outside a cc run it refuses (`hswarm/claude_env.py:129-130`), so Hydra Desk has no endpoint to point an interactive chat at, and Hydra Desk must never hold a provider key.
7. **Hydra Desk has no "Run on" concept.** `ChatSummary.account` is a Claude login. The model list is Claude's. The running-tasks panel knows only CliMayte workers, not HSwarm jobs.

## 3. Design: "Run on" in Hydra Desk

### The choice

One menu in the composer, beside the model picker, with the same look as the account popup. It has four groups:

- **Claude Code**: Auto, then each signed-in Claude account (today's `AccountRef`, unchanged).
- **Codex**: Auto, then each signed-in Codex instance (#8 today), with its condensed 5-hour and weekly bars.
- **Swarm model**: Auto, then the HSwarm models that are enabled and have a working key (names from HSwarm's `state`, read through the daemon, never a key).
- **Local**: models whose provider `base_url` is loopback. When HSwarm is down or no local server answers, the group is greyed with the reason.

Protocol (additive and optional, so no current constructor breaks):

```ts
export type RunTarget =
  | { kind: 'claude'; accountId: string }   // 'auto' or an AccountRef id: exactly today's behaviour
  | { kind: 'codex'; instanceId: string }   // 'auto' or an AgentHydra Codex instance id
  | { kind: 'swarm'; model: string }        // 'auto' or an HSwarm model name
  | { kind: 'local'; model: string }        // an HSwarm model whose provider is on 127.0.0.1
// ChatSummary.runOn?, CreateChatRequest.runOn?, ChatPatch.runOn?, DeskSettings.defaultRunOn?, DeskSettings.delegateRunOn?
// CliMayteWorker.runtime?: 'claude' | 'codex' | 'swarm' | 'local'
```

A missing `runOn` means `{ kind: 'claude', accountId: chat.account.id }`.

### Per chat

- **claude**: no change.
- **swarm / local**: Hydra Desk keeps its Claude Agent SDK runtime, so the window, the tools and the transcript all stay Claude Code. The chat's env gets `ANTHROPIC_BASE_URL` = a daemon loopback endpoint (for example `http://127.0.0.1:7787/api/hswarm/anthropic`) and `ANTHROPIC_MODEL` = the model. The endpoint adds the key server-side, so Hydra Desk never sees one. This needs gap 6 closed in Michael's code. The cost pill shows dollars, not window %.
- **codex**: a second engine, `desk/server/src/engine/codex-runtime.ts`. It drives `codex app-server` (JSON-RPC over stdio, the protocol `server/src/core/codex-rpc.ts` already speaks) with `CODEX_HOME` = the instance's folder and `windowsHide`, and normalizes its items into `TranscriptItem`. This is all Hydra Desk code. Permission prompts map onto app-server approvals. Bypass mode maps to `--dangerously-bypass-approvals-and-sandbox`.

### Per delegated task

`DESK_APPEND` names the chat's `delegateRunOn` (default: claude auto):

- **claude / codex**: the chat calls `climayte_run { tasks: [{ ..., runtime: 'codex' }] }`. This needs the CliMayte runtime field in Michael's code (section 4). The task appears in the running-tasks panel with a runtime chip.
- **swarm / local**: the chat calls `hswarm_run { backend: 'cc', model, tasks, confirm_write: true }`. That is headless Claude Code on that model, and it works today once HSwarm runs. The running-tasks panel lists HSwarm jobs (`GET /api/hswarm/jobs`, `job`) beside CliMayte workers, with the model and dollars spent.

### How Placement and Sizing treat non-Claude workers

- **Codex workers** use the same machinery, keyed by runtime:
  - Pool: Codex instances, read from `codex:<id>` usage. It is the same snapshot shape (row 6), so the `FIT_PCT` 85 stop line, the 90% ceiling, walls, the five-minute rule and `waitsForRoom` apply as they are.
  - `accountInUse`: "hands on" is the Codex desktop running (`isDesktopRunning`).
  - `planFactor`: Codex plans start at 1 until measured.
  - `expectedCost`: its own blend per runtime, starting at `DEFAULT_TASK_PCT` (25). Never mixed with Claude's record, because Claude units do not convert.
  - Moves: Codex to Codex through `copyCodexTranscript`. Never across runtimes: a Claude session cannot resume in Codex, so a cross-runtime move is a handoff note into a fresh session, and only when the task allows both.
  - Per account: `maxPerAccount` 4 as the Pro equivalent (unmeasured, like Claude's).
- **Swarm workers** have no account, no window and no wall. The limit is dollars: `max_cost_usd` per task and `daily_cap_usd` per day. HSwarm's own failover across providers replaces moves, and its per-provider live-call caps (`route_outlook`) replace `perAccount`. Sizing's `split needed` is skipped, or works on a dollar estimate once there is a record.
- **Local workers** have no quota and no dollars. The machine is the limit. The memory gate (`server/src/climayte-memory.ts:36`, `WORKER_BYTES` 0.75 GB per Claude Code process) still counts each cc worker, plus the loaded model's resident size once, plus one stream per loaded model unless configured higher. It also contends with ComfyUI for the GPU.
- **Scorecard**: a rung becomes `runtime + model + effort`. `model: "auto"` stays inside the Claude ladder unless Jacob opts a runtime in (section 4, decision b). Other runtimes earn trust on the same 3-verdicts / 70% bar before auto picks them.

## 4. Whose code

**Michael's AgentHydra (smallest change each):**

1. Bring HSwarm up. Point `AGENTHYDRA_HSWARM_DIR` at the repo's `hswarm/` (read by `server/src/hswarm.ts:24-28`), or ship `hswarm/` beside the built app. This is configuration or packaging, not logic. Check: `GET /api/hswarm/health` → 200.
2. CliMayte `runtime: 'claude' | 'codex'`:
   - `server/src/climayte-lib.ts`: the worker field, validation, a Codex model map beside `CLIMAYTE_MODELS`, and a Codex branch in `classifyAttempt` / `summarizeEvent` / `attemptSpend` reading `codex exec --json` events and rollouts.
   - `server/src/climayte-launch.ts`: a `codexArgv` beside `cliArgv`: `codex exec --json [resume <id>] -m <model> -c model_reasoning_effort=... --dangerously-bypass-approvals-and-sandbox -C <cwd> -`, with the prompt on stdin, `CODEX_HOME` set, and the same runner and hidden window.
   - `server/src/climayte-core.ts:416`: add `listCodexInstances` to the pool with `codex:<id>` readings.
   - `server/src/climayte-placement.ts`: key `expectedCost` by runtime.
   - `server/src/mcp.ts:767`: `runtime` on `climayte_run`.
3. A persistent Anthropic endpoint for interactive swarm and local chats:
   - `hswarm/anthropic_facade.py`: serve it for the life of the sidecar, keyed by model, adding the key server-side.
   - The daemon: proxy it under `/api/hswarm/anthropic` in `server/src/hswarm.ts`'s proxy.
4. Local models need no code. Once a local server runs, HSwarm `providers/add { name, base_url: 'http://127.0.0.1:1234/v1', anthropic_url: 'facade' }` plus `models/add` registers it. That changes HSwarm's state.

**Hydra Desk's own:** `RunTarget` in `desk/shared/protocol.ts`; the Run on menu in `desk/web/src/components/composer/`; the default in settings; `desk/server/src/engine/codex-runtime.ts`; the swarm and local env in `chat-runtime.ts`; bridge GETs for `/api/codex-instances`, `/api/usage/cache` (`codex:*`) and `/api/hswarm/state` + `jobs`; runtime chips and HSwarm jobs in the running-tasks panel; `DESK_APPEND` naming the delegate target.

**Jacob must decide (these touch Michael's repo or Jacob's accounts and data):**

- **(a)** Whether to ask Michael for items 1-3, or approve editing AgentHydra. Without item 2, delegated Codex work gets no placement, walls or moves. The fallback is a Codex runner inside Hydra Desk, which would duplicate CliMayte.
- **(b)** Whether `auto` may send work to non-Claude runtimes, and which providers may see his code (DeepSeek, Gemini, Groq, OpenRouter; `zdr` for OpenRouter).
- **(c)** Whether Codex workers run with the sandbox bypassed, matching CliMayte's `--dangerously-skip-permissions`.
- **(d)** Whether to load a model in LM Studio (or install Ollama), and which one fits beside ComfyUI.
- **(e)** Retiring the still-running ZSwarm process once HSwarm is up.

## 5. Build order (each step ships on its own)

1. **Hydra Desk, read-only:** the Run on menu lists Claude accounts, Codex #8 with its bars, and the HSwarm and local groups with their status ("HSwarm is not running", "No local model server"). The running-tasks panel gets a runtime chip. Only GETs, no new behaviour.
2. **AgentHydra configuration (decision a or Michael):** HSwarm up (item 1). Proof: `GET /api/hswarm/health` 200 and the models listed in step 1's menu.
3. **Hydra Desk:** delegated swarm and local tasks. `DESK_APPEND` routes them to `hswarm_run backend cc`, and the panel lists HSwarm jobs beside CliMayte workers. No Michael code.
4. **AgentHydra (Michael):** CliMayte `runtime: 'codex'` (item 2). Hydra Desk shows it with no further work beyond the chip.
5. **Hydra Desk:** per-chat Codex engine over `codex app-server`.
6. **AgentHydra + Hydra Desk:** per-chat swarm and local models through the persistent Anthropic endpoint (item 3), then a local provider once decision (d) gives one.
