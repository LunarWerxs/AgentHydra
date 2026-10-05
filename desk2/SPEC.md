# Hydra Desk: Jacob's own Claude Code desktop

Jacob's replacement for the Claude Code desktop app (the Code tab of Claude Desktop). It runs Claude
Code chats itself through the Claude Agent SDK, shows at a glance which chats are working, waiting on
him, finished or stopped, lets him stop any of them, and plugs into AgentHydra (the daemon on
`http://127.0.0.1:7787`) for accounts, CliMayte workers and the chats running elsewhere.

Owner: Jacob. His words (2026-10-03): "my own desktop that plugs into Agent Hydra with the goal of
removing Claude Code desktop. My own chat manager, my own everything ... everything is told to hand to
CliMayte. I can see all the active CliMaytes ... make it look and function exactly like Claude Code
Desktop ... I'm tired of not being able to see if a chat's working, stopping or anything."

## Ground rules

- **Look and feel = Claude Code Desktop, dark theme.** References: `docs/reference/claude-desktop-sidebar.png`,
  `docs/reference/claude-desktop-composer.png`, `docs/reference/claude-desktop-toast.png`. Where Claude
  Desktop hides state (it shows no "working" signal in its sidebar), Hydra Desk shows it. That is the one
  place we deliberately differ.
- **Status must never lie.** A chat that is working shows working; one waiting on Jacob shows that, on
  every surface (sidebar row, header, window title, notification). The engine's state comes from the SDK
  (`system/session_state_changed`: idle, running, requires_action) plus local facts (interrupt, error,
  usage limit, closed).
- **Private repo.** This folder is its own git repo, excluded from the public AgentHydra repo through
  AgentHydra's `.git/info/exclude`. Never edit files outside `desk/`. Never commit in the parent repo.
- **Stack** (reuse AgentHydra's): Bun + Hono server, Vue 3 + Vite + Tailwind 4 + reka-ui + @lucide/vue
  window. Copy UI primitives you need from `../web/src/components/ui/` (shadcn-vue style, MIT, same
  owner family) into `web/src/components/ui/` rather than writing new ones.
- **Ports:** server `7798` (serves the built window and the API), Vite dev `4798` (proxies `/api` and
  `/ws` to 7798). Data home: `~/.hydra-desk-2/` (override with `HYDRA_DESK_HOME`, which every test sets
  to a temp folder).
- **Claude Agent SDK** `@anthropic-ai/claude-agent-sdk@0.3.288`. Read its own types
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `sdk-tools.d.ts`) before using any part of
  it. Never guess a field.

## Layout

```
desk/
  shared/protocol.ts      the contract (types only) both sides import as '@shared/protocol'
  server/src/index.ts     Hono app: routes, /ws hub, static web/dist in production
  server/src/ws.ts        broadcast(ServerEvent) to every connected window
  server/src/settings.ts  ~/.hydra-desk-2/settings.json (DeskSettings), defaults below
  server/src/engine/      the SDK chat engine (chat-manager, chat-runtime, normalize, store, input-queue)
  server/src/routes/      chats.ts, folders.ts, git.ts
  server/src/bridge/      AgentHydra client + routes (accounts, external sessions, CliMayte)
  server/src/folders/     the folder menu: Recent (recent.ts) and Windows' folder dialog (pick.ts, pick-folder.cs)
  server/test/            bun tests (engine/, bridge/, git/), fixtures/
  web/src/stores/desk.ts  useDesk(): the one reactive store (REST + /ws)
  web/src/components/     shell/, sidebar/, transcript/, composer/, climayte/, external/, panes/, dialogs/, ui/
  web/src/dev/            Gallery.vue (fixture-driven render of every area, at /#/gallery)
  launcher/               start script, Edge app-window launch, shortcuts
```

Default settings: `defaultModel null` (account default), `defaultEffort null`, `defaultPermissionMode
'bypassPermissions'` (what Jacob runs today), `defaultAccountId 'auto'`, `delegateToCliMayte true`,
`idleCloseMinutes 30`, `notifications true`.

## The engine (server/src/engine)

One `ChatRuntime` per live chat, owned by `ChatManager`.

- **Start:** `query({ prompt: inputQueue, options })` where `inputQueue` is an `AsyncIterable<SDKUserMessage>`
  that stays open for the chat's life (streaming input). Options:
  - `cwd`; `env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir }` (leave the variable out for the
    default login); `model`, `effort` when set; `permissionMode`, and `allowDangerouslySkipPermissions:
    true` when the mode is `bypassPermissions`.
  - `includePartialMessages: true` (stream text as it is written).
  - `settingSources: ['user', 'project', 'local']` so CLAUDE.md files, hooks and MCP servers load as in
    Claude Code.
  - `systemPrompt: { type: 'preset', preset: 'claude_code', append: DESK_APPEND }` (below).
  - `mcpServers`: what plain `claude` gets in the chat's folder under Jacob's MAIN `~/.claude.json`, whatever
    account the chat runs on: its user-level `mcpServers` (agenthydra, connections, any other) plus the
    folder's local-scope servers (`projects[<folder>].mcpServers`; the folder matches case-insensitively and
    with / or \ , a parent folder's entry is not applied, as in Claude Code), passed VERBATIM (never log a
    url, header or env). The folder's `.mcp.json` still loads through the SDK, and a user-level name it also
    defines is left to it (project beats user). A name the account's own config also defines: the main
    config's wins (it is what Jacob's own `claude` runs). A missing or corrupt file is skipped with one log
    line naming the file. `server/src/engine/mcp-servers.ts` computes it for both the chat and the MCP list.
    CliMayte worker chats run in AgentHydra, not here: their MCP parity is AgentHydra's job.
  - When the account's CLAUDE.md is AgentHydra's worker-rules copy ('Rules for a CliMayte worker'), Desk sets
    flag setting `claudeMdExcludes` for it and appends Jacob's real `~/.claude/CLAUDE.md` to the system prompt.
  - `disallowedTools: ['Agent', 'Task']` when `delegateToCliMayte` is on.
  - `resume: sessionId` when the chat already has a session (restart, idle-close, import).
  - `canUseTool` (below); `stderr` to the chat's log file `~/.hydra-desk-2/logs/<chatId>.log`.
- **Status:** `session_state_changed` running -> `working`, requires_action -> `needs_you`, idle -> `idle`
  (unless an interrupt made it `stopped`, an error `error`, a usage limit `limited`). `activity` is the
  running tool ("Bash: bun test", "Edit: web/src/App.vue") from tool_use blocks and tool progress,
  else "Thinking" while thinking streams, else "Writing". `turnStartedAt` set when a turn starts.
- **Messages while working:** a plain send pushes into the input queue at once (the CLI queues it, and may
  fold it into the running turn); the user item is `queued: true` and `queuedCount` counts it until the
  next turn takes it up. Such a send cannot be edited or recalled. Messages that wait for the turn to end
  are the server's own Send queue (below), which pushes nothing until the chat is ready. `send()` takes
  `{ onlyIfReady, messageId }`: onlyIfReady refuses a busy chat with 409 (`ChatBusyError`); messageId
  becomes the SDK message uuid and the user item's id.
- **Interrupt:** `query.interrupt()`; status `stopped`; any pending permission/question/plan item goes
  `expired`.
- **canUseTool(toolName, input, { signal, suggestions, blockedPath })**:
  - `AskUserQuestion` -> a `question` item; resolves on the answer with `{ behavior: 'allow',
    updatedInput: { ...input, answers } }` (check sdk-tools.d.ts for the exact answers shape), or on
    skip with deny "The user skipped the question.". The answer may carry `images` (question -> pictures with
    `dataBase64`): the server saves each into `<home>/media` (the content-addressed cache) and appends one line
    `[Image: source: <absolute path>]` to that question's answer text, the form Claude Code uses so the model
    opens it with Read; the bytes never go inside the answer. A picture that is not a PNG, JPEG, GIF or WebP
    refuses the answer (400) and the question stays open.
  - `ExitPlanMode` -> a `plan` item; reject -> deny with the feedback. Approve -> allow with
    `updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }]`, then `setPermissionMode(mode)`,
    where `mode` is the decision's, else the mode the chat had before plan mode (a Bypass chat returns to
    Bypass; `acceptEdits` when unknown). A process that ran in Bypass, or is asked to return to it, is started
    with `allowDangerouslySkipPermissions`.
  - anything else -> a `permission` item (`title`, `description`, `reason`, `defaultToNo`, `alwaysRules`: the
    lines "Always allow" would save, each with where it is kept, from the SDK's suggestions). Decisions:
    `allow`; `session` (the same rules, kept for this session only); `always` (`updatedPermissions:
    suggestions`); `deny` with a reason (Claude carries on and reads it) or bare (denied with `interrupt`,
    and the turn stops, as Esc does in the terminal).
  - `onElicitation` (an MCP server asking for a form or for a link to be opened) -> an `elicitation` item
    (`mode` form or url, `serverName`, `title`, `description`, the requested JSON schema flattened into
    `fields`, a url's host). `POST /api/chats/:id/elicitation/:requestId` answers `accept` (with `values`,
    checked and coerced against the fields first: a value the form refuses answers 400 with the reason and
    leaves the request open) or `decline`.
  - while any request is pending the chat is `needs_you`; `signal` abort marks the item `expired`. A request
    no process can answer any more (a fork's copy, one left by a dead process, a server restart) is
    `expired` on disk and in every window.
  - The default mode stays Bypass, yet AskUserQuestion and ExitPlanMode still reach `canUseTool` there (the
    CLI requires the user for them), so those cards show by default; other tools ask only in the other
    modes. CliMayte workers are separate processes AgentHydra runs: their prompts never reach this code.
- **Normalize** (`normalize.ts`, pure, unit-tested on recorded SDK messages in `server/test/fixtures/`):
  SDK messages -> `TranscriptItem` upserts and `item.delta` appends. assistant text/thinking blocks
  stream from `stream_event` deltas and are finalized by the `assistant` message; `tool_use` blocks
  become `tool_use` items (`running`), matched `tool_result` blocks finish them (`done`/`error`), a deny
  marks them `denied`; `TodoWrite` input also updates the chat's single `todos` item; sub-agent messages
  carry `parent_tool_use_id` -> `parentToolUseId`; `result` -> a `result` item and the cost total;
  `compact_boundary`, `api_retry`, `rate_limit_event`, refusal fallbacks, hook errors -> `system` items.
  Unknown message types are ignored, never thrown on.
- **Store** (`store.ts`): `~/.hydra-desk-2/chats.json` (ChatSummary[] without volatile fields) and
  `~/.hydra-desk-2/chats/<chatId>.jsonl` (one TranscriptItem per line, append-only; loading keeps the last
  line per id). Streaming deltas are not written per delta: the finished item is written once.
  `~/.hydra-desk-2/queue.json` holds the Send queue (below), written immediately and atomically on every change.
- **Session meta** (`session-meta.ts`): `~/.hydra-desk-2/session-meta.json`, Hydra Desk's own marks on
  outside sessions keyed by session id (`SessionMeta`: pinned, archived, unread, title, group), written
  atomically. The bridge applies them to every external list (`setSessionMeta`); the session's own files
  are never written or deleted. Importing a session carries its group (and pin) over to the chat.
- **Fork** (`ChatManager.fork`): a new closed chat with the same folder, account, model and group, the
  history copied (open requests expired), title "<title> (fork)", `sessionId` null and `forkedFrom` the
  source session. Its first start resumes `forkedFrom` with the SDK's `forkSession: true`; system/init
  then gives it its own session id. (The SDK's standalone `forkSession()` cannot be used: it reads the
  process's one memoized config folder, not the chat account's.)
- **Lifecycle:** on server start every chat is `closed`, but for the ones whose chat hosts kept them
  running through the restart, which the new server takes over (see "Chat hosts"). A send to a closed chat
  starts a runtime with `resume`. A runtime idle for `idleCloseMinutes` closes (status `closed`). Server
  shutdown lets hosted chats run on in their hosts and closes in-process ones.
- **Usage limits:** a `rate_limit_event` that says the limit is reached, or a turn failing on a usage
  limit, sets `limited` with `limitResetsAt` and a `system` item naming the account and the reset time.
  The chat then moves to another account by itself, however its account was chosen (see "Account
  choice", "Limit failover"); it stays `limited` only when no other account has room.
- **After each turn:** `getContextUsage()` -> `contextPct`; `result.total_cost_usd` added to `costUsd`;
  `unread = true`; a `notify` event (finished / needs_you / error / limited).
- **Titles:** the first line of the first prompt, at most 60 chars, until Jacob renames it. Then, for every new chat (CliMayte, SDK, queued), a generated title replaces it shortly after the first message is sent: 3-6 words, sentence case, no quotes or trailing period. `server/src/engine/chat-title.ts` makes it with one Sonnet query (never Haiku) on the chat's own account, low effort, no tools, maxTurns 1, from the first ~2000 chars of the message, 20 s limit; run off the send, so the send never waits. It is applied once, pushed as a `chat.upsert`, and never over a title Jacob set (a rename before it returns wins). Any failure or timeout keeps the first words, silently. Always on (no setting). HydraSwarm was not used: this needs no extra service and rides the login the chat has.
- **Accounts:** `accountId 'auto'` asks the bridge `placeAccount(liveChatsByAccount())` (see "Account
  choice"); an explicit id is used as given and never re-placed.

DESK_APPEND (the orchestrator default every chat gets):

> You are running inside Hydra Desk, Jacob's own desktop for Claude Code. Sub-agents here are CliMayte
> workers, not the Agent tool: when you would start a sub-agent or hand off a piece of work, send it
> through the agenthydra MCP with `climayte_run { tasks: [{ prompt, cwd, kind, check }] }` (or
> `climayte_manage` for five or more tasks in rounds). Each task must stand alone: its folder, its
> goal, what done means and the proof to report. You keep the orchestration: split, dispatch, check
> each result's proof, judge it with `climayte_verdict`, report. Do yourself only what is faster than
> writing the brief.

When `delegateToCliMayte` is off, DESK_APPEND is only its first sentence.

### A chat moves folders (engine/cwd-move.ts, chat-manager noteCwd)

Like Claude Code's own app: tell a chat "make folder X and move yourself there" and its sidebar group
becomes X, and later turns run in X with X's instructions and MCP servers.

- **Detect.** Claude Code writes the Bash tool's working directory as `cwd` on every transcript line.
  When an SDK chat's turn ends and the chat is idle (ChatRuntime `onTurnEnd`), the manager reads the
  `cwd` of the newest line of the session's .jsonl (`lastCwd`, the file's tail only). A CliMayte-worker
  chat is checked in `applyWorker` whenever its worker's `updatedAt` changed.
- **Only a move out counts** (`movedOutOf`): the observed folder must be an absolute, existing local
  directory (never a UNC or device path) that is not the chat's folder or inside it (compared
  case-insensitively). A cd into `A\web\src`, or into a repo nested in A, moves nothing.
- **On a move:** the chat's stored `cwd` changes (chats.json), one muted system line `Moved this chat to
  <folder>.` is added, and `chat.upsert` goes out, so the sidebar puts the chat in that folder's group
  (creating the group as for any new folder).
- **The next turn runs there (SDK chats).** The process runs in the old folder, so the runtime ends at
  once (`closeWhenIdle`; `switchedAway` is also true when `ranCwd` differs from `chat.cwd`). The next send
  runs `seedResume`, which now also calls `placeInCwd`: Claude Code resumes only from
  `<configDir>/projects/<encoded cwd>/<session>.jsonl` of the folder it starts in, so the transcript (and
  its sidecar folder) is copied under the new folder's name; the original stays, an older copy there (the
  chat went back) is refreshed. `buildOptions` then reads `chat.cwd` again, so `cwd`, the folder's project
  settings and the main-config MCP servers (mcp-servers.ts) are the new folder's.
- **Worker chats.** The sidebar move happens, and the next send to the worker passes the chat's folder as
  `cwd` (`POST /api/corch/workers/:id/send`): AgentHydra copies the worker's session into that folder's project
  dir on its account and resumes there. Desk remembers the folder it last started or sent the worker into
  (`workerCwd`, else the worker's own `cwd`); only a differing chat folder is passed, once.

### Chat hosts (server/src/host)

Jacob, 2026-10-04: an update to Hydra Desk must not kill the chats. A chat this server runs itself (an
import, a fork, a chat stored before CliMayte workers; worker chats run in AgentHydra and need none of
this) runs its Agent SDK query in a **chat host**: a small bun process (`host/chat-host.ts`) born outside
the server's process tree (Windows: WMI `Win32_Process.Create`, as AgentHydra's `detached-spawn.mjs` does;
hidden, inheriting no handle), so restarting or killing the server leaves the chat and its Claude Code
running.

- **What runs where.** The host only pumps the SDK: sends in, messages out, permission and elicitation
  calls forwarded under the SDK's `requestId`, the Query's control calls (`interrupt`, `setModel`...)
  answered. Everything else (normalizer, status, transcript, queue, notifications) stays in the server
  behind the runtime's `QueryImpl` seam (`HostedQuery`, `host/client.ts`), so a server update reaches
  running chats at the restart. `HYDRA_DESK_HOSTS=0` runs new ones in the server's own process instead
  (a host already running is still taken over).
- **Wire** (`host/protocol.ts`, version 1): a websocket on 127.0.0.1, a random port, the token from the
  spec; a request with an Origin header is refused. `<home>/hosts/<chatId>.json` says where (pid, port,
  token, startedAt). The spec the host starts from (`<chatId>.spec.json`, which carries the chat's
  environment) is deleted the moment it is read. A host speaks the version it started with for its whole
  life, so a newer server must keep answering every version a running host may have.
- **Journal.** The host journals every SDK message, every send and every Stop (the button, or a No that
  stops the turn). At each quiet point after a turn (idle, stopped, error or limited; nothing queued or
  pending) the server acks: the host drops what came before, but for the sends a limited turn may still
  carry to another account, and keeps the server's carry (cost base, the query's cost so far, turns run,
  status). A long turn's journal sheds text deltas and tool progress from before its newest whole entry.
- **Restart.** After the plugins load and before the server answers, `ChatManager.attachHosts()`
  connects to every live host (hello, journal, then live traffic) and the runtime replays the journal
  through the live path from the status the chat had at the last ack (`ChatRuntime.adopt`). Only items
  that differ from the stored transcript are written; what the last server already told Jacob is not told
  again, what happened while no server was there is (a finished turn, a request), and a usage limit hit
  then is carried now. Requests the host still waits on open again under the same ids. A host whose chat
  is gone is ended. A stopping server says what it saw (`detach { seen, shown }`) and the host closes the
  connection: closing it from the server could lose that frame (Bun drops a frame a close follows while
  the host is sending).
- **Lifetime.** One host per chat: a fresh start ends an older host of the chat first. `close()` (idle
  close, delete, an account switch, a limit move) ends the host and its Claude Code. With no server a
  host stays up while its chat works and ends once the chat has been idle `idleCloseMinutes`. A query that
  ended while no server was there ends its host once the next server has been told.

## Send queue (server/src/engine/queue.ts)

Messages for a chat, and new chats, that the server holds until they can go out. It is not the SDK's own
queue: a message pushed while a turn runs can join that turn and can never be edited or recalled. Queued
items are never pushed into the CLI early.

- The queue is the `QueueState` in the protocol: `items` (in send order), `paused`, `sendMode` (`immediate`
  by default; what a plain Enter does while a chat works; the window acts on it), `maxNewChats` (default 2,
  1-8), `held` (chatId -> `stopped` | `error` | `restart`) and `rev`.
- Every change bumps `rev`, writes the file and broadcasts `queue.update { queue }`. `hello.queue` carries
  the queue on connect.
- **Items:** `message` (chatId, text, images) or `chat` (a CreateChatRequest whose prompt is the item's `text`).
  - Text and pictures may not both be empty (400).
  - Pictures go into the media cache when added and are kept as url refs. A picture the cache cannot take
    (not PNG, JPEG, GIF or WebP, or over 10 MB) is refused with 400; it is never silently dropped.
  - When the item goes out, the pictures are read back to base64.
  - An item's `rev` is bumped by the owner's edits and retries, not by the dispatcher's reason updates.
- **Order:** first in, first out per chat. New chats go in queue order.

| State | Meaning |
| --- | --- |
| `waiting` | It goes out by itself; `reason` says what it waits for ("Waiting for the turn to finish", "Account at its usage limit", "Waiting for an account with room", "Waiting for AgentHydra to list the accounts", "Waiting for a free slot (N queued chats run at once)", "The queue is paused") |
| `held` | Only the owner releases it (Resume, or Send now): "You stopped this chat. Resume to send." / the chat's lastError / "The server restarted while this chat was working. Resume to send." |
| `sending` | Being handed over now. It cannot be edited or removed (409). |
| `failed` | `reason` says why ("This chat was deleted", a create refusal, "The chat started, but its first message failed: ..."). Retry or edit puts it back in line. |

**When a message goes**, by the chat's status:
- **idle / closed** (and the chat not held): after the chat has stayed ready for 800 ms, its oldest item goes
  through `send` with `onlyIfReady`. One item goes per turn; the next waits for the next idle.
- **starting / working / needs_you:** it waits.
- **stopped:** the chat is held, latched when the status changes. Leftover CLI sends that turn the chat
  working and then idle again do not release it.
- **error:** the chat is held with lastError as the reason. The later `closed` (after idleCloseMinutes) does
  not release it.
- **limited:** it waits only for a known reset still ahead (a timer at `limitResetsAt`). Past it, or with
  none known, it goes: the manager moves a chat off an account at its limit to one with room.
- **chat deleted:** its items fail with "This chat was deleted".
- **paused:** nothing goes out.

An item queued for a chat that is already stopped or failed is held. Once the owner resumes the chat, it
sends even while the chat is still `stopped`.

**New chats:**
- They start one create at a time, in order, while fewer than `maxNewChats` of the chats the queue started
  are live (starting, working or needs_you).
- They go through `ChatManager.createFromQueue({ waitForRoom })`. On the placement chain, an Auto pick that
  finds no room (or cannot read AgentHydra) answers `{ waiting }` instead of falling back to the default
  login. With no CLI account listed at all, it falls back as `create()` does, because waiting would never
  end. A named account never waits.
- A waiting Auto item keeps the Auto items behind it waiting; a named item does not wait behind it. A
  waiting item tries again when a chat the queue started stops being live, and every 15 s.
- A create refusal makes the item `failed` with its message. If the first message fails, the item is
  `failed` with `startedChatId` set; Retry then sends it as a message to that chat.

**Races:**
- The dispatch re-reads the chat when it fires, and `send(onlyIfReady)` re-checks inside the manager after
  any account move. A turn that started in between (the owner's own Enter, or a turn the CLI started
  itself) answers `ChatBusyError` (409), and the item simply waits again.
- Any other refusal (a session that cannot resume) fails the item once.
- The owner's own sends are never blocked or reordered.
- Edit, remove and send-now refuse a `sending` item (409). A stale `ifRev` gets a 409. Reorder must name
  exactly the current ids (409).

**Persistence and restart:**
- `<home>/queue.json` is written immediately on every change (temp file + rename). It also keeps each
  in-flight send's uuid and `wasLive`: the chats with queued messages that were last seen live.
- A failed write never throws into the queue: the change stays in memory and the next change writes it. A
  message or new chat is handed over only once the file holds its `sending` state, because the uuid there
  is how a restart tells whether it went; when that write fails the item goes back to what it was and tries
  again later.
- At start:
  - A missing file means an empty queue with the defaults. An unreadable one is renamed
    `queue.json.bad-<ms>` (what a hand edit or a torn write left stays recoverable) and the queue starts empty.
  - Items of chats that no longer exist are dropped.
  - A `sending` message whose uuid is the id of a user item in its chat's transcript went out, so it is
    dropped; otherwise it waits again.
  - A `sending` new chat whose chat exists becomes a message to it; otherwise it is created again.
  - Every chat in `wasLive` is held as `restart`. This covers a hard kill as well as a normal stop: the
    queue's stop hook runs before `manager.closeAll`, so the chats closing do not erase it.

**Send now** sends the item at once, past pause, hold and readiness. A message goes without `onlyIfReady`,
so a busy chat takes it into its running turn like a plain Enter, and the chat's hold is released. A new
chat is created at once, ignoring `maxNewChats` and the wait for room (Auto may fall back to the default login).

## REST API (server, all JSON)

| Route | Answer |
| --- | --- |
| `GET /api/health` | `{ ok: true, version }` |
| `GET /api/settings`, `PUT /api/settings` (partial DeskSettings) | `DeskSettings` |
| `GET /api/chats?archived=1` | `ChatSummary[]` (archived only with the flag) |
| `POST /api/chats` (CreateChatRequest) | `ChatSummary` (409 when the named account is signed out: "<label> is signed out"; the same applies to `PATCH /api/chats/:id` with `accountId`) |
| `GET /api/chats/:id` | `ChatSummary` |
| `GET /api/chats/:id/items` | `TranscriptItem[]` (a CliMayte chat answers from its Desk file at once; the worker's JSONL is read behind it and new items arrive over `/ws`) |
| `POST /api/chats/:id/warm` | `{ started: boolean }` (the warm start, see "Speed (timings)": starts a closed SDK chat's process ahead of its message; false for a worker chat, a running or archived one) |
| `GET /api/chats/:id/transcript` (`?format=jsonl`) | The chat's whole record, oldest first, across every session: `TranscriptItem[]`, or one item per line (`application/x-ndjson`); refreshed from the worker first |
| `POST /api/chats/:id/messages` (SendMessageRequest) | `{ queued: boolean }` |
| `POST /api/chats/:id/interrupt` | `{ ok: true }` |
| `POST /api/chats/:id/permission/:requestId` (PermissionDecision) | `{ ok: true }` |
| `POST /api/chats/:id/question/:requestId` (QuestionAnswer) | `{ ok: true }` |
| `POST /api/chats/:id/plan/:requestId` (PlanDecision) | `{ ok: true }` |
| `POST /api/chats/:id/elicitation/:requestId` (ElicitationAnswer) | `{ ok: true }` (400 with the reason when a form value is refused; the request stays open) |
| `PATCH /api/chats/:id` (ChatPatch) | `ChatSummary` (model/effort/mode applied live when running) |
| `DELETE /api/chats/:id` | `{ ok: true }` (drops it from Hydra Desk; the CLI transcript stays) |
| `POST /api/chats/import` (ImportSessionRequest) | `ChatSummary` (adopts an outside session, resumed on next send; `fork: true` makes a new chat that forks it at its first message, the original stays listed) |
| `POST /api/chats/:id/fork` | `ChatSummary` (the fork, closed; 409 when the chat has no session yet) |
| `PATCH /api/external/sessions/:id/meta` (SessionMetaPatch) | `SessionMeta` (title, pinned, archived, unread, group; group trimmed 1-60 chars or null, as in ChatPatch) |
| `POST /api/folders/reveal` (`{ path }`) | `{ path }` (opens an existing absolute folder in Explorer, `explorer.exe <path>`, no shell; else 400) |
| `GET /api/chats/:id/commands` | `SlashCommandInfo[]` |
| `GET /api/models` | `ModelChoice[]` |
| `GET /api/folders/recent` | `string[]` (the folder menu's Recent: the chats' folders and the folders opened or chosen in the menu, latest first, at most 20; a folder taken off stays off until it is used again; folders gone from disk left out; `<home>/folders.json`) |
| `POST /api/folders/recent` (`{ path }`) | `string[]` (the folder was chosen: it tops Recent, back on it if it was taken off; 400 unless an existing absolute folder on this machine) |
| `DELETE /api/folders/recent?path=` | `string[]` (takes the folder off Recent until it is opened, chosen or gets a new chat) |
| `POST /api/folders/pick` (`{ current? }`) | `{ path: string \| null }` (Windows' own Select Folder dialog, in `current`'s parent while Windows remembers no folder of its own for it; the folder chosen tops Recent; null = cancelled; asking again while one is open replaces it; a network folder 400, no dialog possible 502) |
| `POST /api/server/shutdown` (`{ chats? }`) | `{ ok: true, chats }`, then the server stops as on SIGTERM: chats in hosts run on for the next server; `chats: true` ends them first (`launcher/stop.ps1`) |
| `GET /api/mcp-servers?cwd=&configDir=` | `McpServerInfo[]` (the MCP servers a chat there loads: the account's `.claude.json` user servers, the cwd's `.mcp.json`, Hydra Desk's agenthydra; name, scope and transport only, never the config; max 100) |
| `GET /api/chats/:id/mcp` | `McpStatus` (the live session's `mcpServerStatus()`, name and status only; `live: false` without a runtime) |
| `POST /api/chats/:id/mcp/:name` (`{ enabled }`) | `{ ok: true }` (`toggleMcpServer` on the live session; 409 without one) |
| `GET /api/folders/browse?path=` | `{ path, parent, dirs: string[] }` |
| `GET /api/git?cwd=` | `GitStatus` |
| `GET /api/git/diff?cwd=&path=` | `{ diff: string }` (unified diff of one file, untracked shown as all-added) |
| `GET /api/bridge/status` | `{ up: boolean, url: string }` (is AgentHydra answering) |
| `GET /api/accounts` | `AccountInfo[]` |
| `GET /api/accounts/pick` | `AccountRef` (what 'auto' would use now) |
| `GET /api/queue` | `QueueState` |
| `POST /api/queue` (QueueAddRequest) | `QueueItem` (400 bad body, empty text and pictures, bad cwd or a picture the cache cannot take; 404 unknown chat) |
| `PATCH /api/queue` (QueueSettingsPatch: paused, sendMode, maxNewChats 1-8) | `QueueState` |
| `POST /api/queue/reorder` (QueueReorder) | `QueueState` (409 on a stale `ifRev` or when `ids` is not exactly the current ids) |
| `PATCH /api/queue/:id` (QueuePatch: text, images, ifRev) | `QueueItem` (409 while `sending` or on a stale `ifRev`; a `failed` item goes back to `waiting`) |
| `DELETE /api/queue/:id` | `{ ok: true }` (404 unknown, 409 while `sending`) |
| `POST /api/queue/:id/send-now` | `{ ok: true, chatId, queued }` |
| `POST /api/queue/:id/retry` | `QueueItem` (`failed` -> `waiting`; 409 otherwise, or when its chat was deleted) |
| `POST /api/queue/chats/:chatId/resume` | `QueueState` (releases that chat's hold) |
| `GET /api/external/sessions` | `ExternalSession[]` |
| `GET /api/external/sessions/:id/items` | `TranscriptItem[]` (converted from AgentHydra's transcript) |
| `GET /api/search?q=&limit=` | `SearchHit[]`: AgentHydra's transcript search (`GET /api/sessions/search`, its `search_sessions` tool), each hit joined with its session row for title and time (`bridge/search.ts`). q 2+ chars (else 400), limit 25 by default, at most 50; AgentHydra down 503, any other failure 502 with the reason |
| `GET /api/climayte/workers?all=1` | `CliMayteWorker[]` (active + the last 20 finished; all with the flag) |
| `POST /api/climayte/workers/:id/cancel` | `{ ok: true }` |
| `POST /api/climayte/workers/:id/send` (`{ text }`) | `{ ok: true }` |

Errors answer `{ error: string }` with a 4xx/5xx status, the real reason in the text.

`/ws`: on connect the server sends `hello`, then every `ServerEvent` as it happens. While at least one
window is connected the bridge polls AgentHydra every 3 s and broadcasts `external.update`,
`climayte.update` and (every 30 s) `accounts.update`. AgentHydra down = empty lists plus a `bridge.status { up: false }` event (the window shows a banner
"AgentHydra is not running"), never a crash.

## The bridge (server/src/bridge)

A typed client for the AgentHydra daemon (`HYDRA_URL`, default `http://127.0.0.1:7787`). Read
AgentHydra's own routes before mapping: `../server/src/routes/{sessions,climayte,instances,usage,agent-status}.ts`
and `../docs/REFERENCE.md`. Exports used by the engine: `startWorker`, `sendToWorker`, `cancelWorker`,
`workersByIds` and `workerItems` (see "Chats are CliMayte workers") and `listAccounts()`; `pickAccount()`
answers the default login (`/api/accounts/pick`). External sessions = AgentHydra's live sessions minus the ones whose session id
belongs to a Hydra Desk chat. CliMayte workers carry `originSessionId` (AgentHydra stores the
dispatching chat as the worker's origin, and `sessions` lists every session a worker has had);
`ChatSummary.climayteActive` counts the active workers that belong to that chat.

**Which workers belong to a chat** (`workersOfChat`, server/src/bridge/climayte.ts): a worker belongs to a
Desk chat (its fixed Desk id, not one session id) when its origin session is ANY session the chat has had
(its `sessionId`, and for a CliMayte-worker chat that worker's `sessionId` and every id in its `sessions`,
because a handoff gives the worker a new session), or its origin is the chat's own `workerId`, or its
origin is a worker that belongs (recursively, cycle-safe). The match is kept in `ChatSummary.workerIds`
(stored in chats.json, never volatile): every worker ever matched, running and finished, so finished ones
stay listed after AgentHydra's recent-finished window drops them (the bridge re-reads those ids with
`?ids=` and merges them into the worker list). The web filters by `workerIds`: the Background tasks panel
opens on 'This chat' ('All' stays one click away, remembered in localStorage), and the composer's agents chip,
the inline 'N running tasks' row and the CliMayte pane's 'only this chat' box use the same list.

### Chats are CliMayte workers

Hydra Desk is a viewer (Jacob, 2026-10-04): it keeps no account policy, no failover and no limit or
login handling. A new chat (create, or a queued new chat) is a CliMayte worker: its first message calls
`POST /api/corch/workers` (`tasks: [{ prompt, cwd, title, chat: true }]`, group `hydra-desk`). `chat: true`
is AgentHydra's chat mode: the worker launches like the owner's own `claude` (no worker brief, the owner's
full instructions, skills and MCP, Opus xhigh, never auto-downgraded). Desk sends no model, effort or
`modelWhy` of its own; an explicit owner choice would be passed through. Every later message goes to
`POST /api/corch/workers/:id/send` (CliMayte holds one sent during a turn for the next turn of the same
session). `ChatSummary.workerId` is the worker (`null` until it started; absent on SDK chats). CliMayte
picks the account and moves the worker when that account hits its limit or its login dies.

- **Status** comes from `GET /api/corch/workers?ids=` (each poll for live workers, and before a
  transcript read): queued / waiting = `starting`, running / checking = `working`, done = `idle`
  (unread), failed = `error`, cancelled = `stopped`. A changed account updates `account` and adds
  "CliMayte moved this chat from #61 to #62." to the transcript.
- **Transcript** = Hydra Desk's own file for the chat, `<home>/chats/<chatId>.jsonl`, the chat's record: every
  item across every session and account the worker has had (its `sessions` then `sessionId`), oldest first, one
  TranscriptItem per line, deduplicated by item id (the source line's uuid), appended as new or changed items
  arrive, a torn last line tolerated. The worker's session JSONL is the live source: opening a chat serves the file at
  once (`GET /api/chats/:id/items` never waits for a folder scan), then a background read of the JSONL (outside-session
  reader, `session-jsonl.ts`) appends what is new and pushes only that over `/ws`. The bridge remembers the path each
  session was found at and checks it first; it scans the account folders only when that file is gone or the worker
  changed account. An earlier session's lines stay in the file even if its JSONL is later removed or older than the
  8 MB tail read. Other programs read the whole chat with `GET /api/chats/:id/transcript`. A message sent shows at
  once as a stand-in user item (memory only, never in the file); the worker's own copy of it (same text, else the
  oldest stand-in sent before it) replaces it with `item.removed`, and a failed send removes it the same way.
- Stop cancels the worker; the next message revives it. Delete cancels a live worker. Pictures, account,
  model, effort and permission-mode changes are refused or ignored for these chats; a fork is refused.
- **Headless:** a worker runs without a window, so its permission prompts and questions never reach
  Hydra Desk.
- **Still in this process (ChatRuntime, the Agent SDK):** sessions continued from outside (imports) on
  the account named by their folder or Settings' default account (unasked, never the default login),
  forks, and chats stored before this change. 'auto' for these = the default login.
- **No SDK chat ends on an account failure (in-runtime failover, not CliMayte):** AgentHydra's
  `POST /api/corch/workers` takes only a prompt and cwd (no resume or seed option), so an imported session
  cannot start as a worker. Instead, when a turn fails on its account (expired/revoked login, 401/403 auth,
  org mismatch: `isSignInFailureText`; or a usage limit: `isUsageLimitText`), `ChatManager.carryToAnotherAccount`
  asks `listAccounts()` (AgentHydra's word: `signedIn`, usage percentages, never a token) for the least used
  signed-in account not yet tried (`pickHealthy`), copies the session there (`seedSession`), restarts the
  runtime and resends the unanswered message once, with the muted line 'Moved from #126 (signed out) to #61.'.
  At most 4 accounts per message, then one clear error. Any other error (tool failure, bad request) never moves.
- **Fork** copies the transcript now and cuts the SDK session at the source's last message at that moment
  (`resumeSessionAt`, server-internal `forkAt`), so the source's later turns never reach the fork.
- **Local server guard:** the server answers 403 to any request whose Host or Origin is not loopback
  (`127.0.0.1`, `localhost`, `[::1]`, any port), whose Origin is `null`, or whose `Sec-Fetch-Site` is
  `cross-site`, on every route and on `/ws`; UNC and device paths are refused (400) wherever a route
  takes a folder. `GET /api/external/sessions/:id` answers one outside session of any age (the list
  holds the last 24 hours), which is how a search hit for an older session opens with its composer.

## The window (web/)

Dark theme tokens (CSS variables in `web/src/style.css`). **Every value in this table is measured** from the
real Claude Desktop (instance eek, `data-theme=claude data-mode=dark`, 2026-10-03); the full set with sources
is `docs/reference/real/tokens.json` and `docs/reference/real/DESIGN.md`, screenshots beside them:

| Token | Value (measured) | Use |
| --- | --- | --- |
| `--bg-sidebar` | `#111111` | sidebar (`--cds-surface-0` is `#0b0b0b`, used for tooltips-on-dark/inset only) |
| `--bg-main` | `#151515` | transcript area, page (`--cds-page-bg`) |
| `--bg-panel` | `#1a1a19` | side panels (`--cds-surface-2`) |
| `--bg-elev` | `#20201f` | composer box, menus, popovers, tooltips (`--cds-surface-3`) |
| `--bg-user-bubble` | `#ffffff0d` (white 5%) | user message bubble, composer strip, inline code fill |
| `--bg-hover` | `#ffffff13` (white 7.5%) | row and menu-item hover (`--df-hover`) |
| `--bg-selected` | `#ffffff26` (white 15%) | selected sidebar row (`--df-selected`) |
| `--border` | `#ffffff1a` (white 10%) | hairlines, box rings (drawn as inset 1px shadow); strong 20%, stronger 40% |
| `--text` | `#f0efec` | primary text |
| `--text-secondary` | `#c3c2b7` | composer toolbar, secondary |
| `--text-muted` | `#898781` | labels, placeholder, icons, group headers |
| `--accent` | `#2a78d6` | focus ring, links (`--cds-fill-accent`; hover `#3987e5`, text `#6da7ec`) |
| `--brand` | `#c6613f` | Claude clay (`--cds-fill-brand`; hover `#d97757`; sparkle logo) |
| `--amber` | `#fab219` | warning (`--cds-fill-warning`; text `#db9300`) |
| `--red` | `#d03b3b` | danger fill (text `#ec7e7e`; inline code ink `#ec7e7e`) |
| `--green` | `#009300` | success fill (text `#0ca30c`); git added `#32d74b`, removed `#ff2c56` |
| `--pro` | `#7161e0` | purple (effort name "Ultracode" label) |

Font (measured): body `anthropic-sans, system-ui, "Segoe UI", Roboto, Helvetica, Arial, ...CJK/script
fallbacks, sans-serif` (on Windows without the proprietary web font that renders as Segoe UI; use
`system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`); mono `anthropic-mono, ui-monospace,
monospace, "SF Mono", Menlo, Consolas` (use `ui-monospace, "Cascadia Mono", Consolas, monospace`).
Sizes: assistant text 14px/20px, user text 14px/18px, sidebar rows 13px/19.5px, group labels 12px/16px,
composer toolbar 12px/15px, code 13px/19px (inline 12.6px), title 13px/500. Icons are the proprietary
`Anthropicons-Variable` font: use `@lucide/vue` (name map in DESIGN.md).

**Shell** (`components/shell/`, App.vue): sidebar left (280px, resizable 220-420, collapsible with
Ctrl+B), main column right. Main column: header (chat title, editable on double-click; folder and
branch muted; account badge; status pill; buttons to toggle the right pane: Diff, CliMayte), transcript,
composer at the bottom. Optional right pane (380px): DiffPane or CliMaytePanel. The window title is
`(N working, M need you) Hydra Desk`.

**Sidebar** (`components/sidebar/`): top row: sidebar toggle. Then nav rows like Claude Desktop's:
"+ New session" (Ctrl+N), "CliMayte" with a count of active workers, "Elsewhere" with a count of outside
sessions working (opens the list of ExternalSessions), "Settings". Then chats grouped by project
(folder basename, lowercase like the reference), each group with + (new chat in that folder) on hover;
pinned chats first in their group; a search box (Ctrl+K) filters titles at once and, after 250 ms of
quiet (2+ characters), lists AgentHydra's transcript search below under a muted "Everywhere" caption,
minus sessions the list already shows (`sidebar/search.ts`, `SearchHitRow.vue`): title, folder, age and
the matching line with the query's words emphasised; one of our chats opens as the chat, anything else
in ExternalSessionView (read-only when AgentHydra does not list it live). Arrow keys walk both lists,
Enter opens, Escape clears then closes; only the newest query's answer is shown; AgentHydra down keeps
the title filter with "AgentHydra search is offline". Each row: status glyph +
title, truncated:

| Status | Glyph |
| --- | --- |
| starting, working | solid grey dot blinking (as Claude Desktop), plus the elapsed time on the right ("2m") |
| needs_you | pulsing orange (`--status-needs-you`) dot |
| idle / stopped / closed, `climayteActive > 0` (replied, background tasks still running) | solid orange dot, "Replied, background tasks running"; read or not, reading never clears it (a chat must never look done while its workers run). The transcript's end-of-turn line reads "Replied in 19s · 2 background tasks still running" until they finish |
| idle / stopped / closed, no background running, unread (a finished turn not looked at) | solid green dot (`--status-done`), "Done, unread". When the background work of a replied chat finishes the server marks the chat unread again, so it turns green |
| idle / stopped, read, nothing running | hollow grey ring (as Claude Desktop) |
| error | red dot |
| limited | hollow pink ring (`--status-limited`), "resets ..." beside the title |
| closed | the title dims |

Details in `docs/fidelity/shell.md` "Status dots".

Hover tooltip: status in words, activity, elapsed, account. A chat with active CliMayte workers shows a
small count chip. Row menu (right-click, the row's "...", and the title bar's chat menu: one list, the
real app's): Open in > (File Explorer, Copy resume command, Copy session ID), Stop (only while working),
Pin P / Unpin, Mark as unread U / Mark as read, Rename R, Fork F, Move to group > (every folder and moved-to
group, a check on the current one, New group…, Remove from group), Archive A / Unarchive, Delete D (red,
confirmed in a dialog). The letter runs its item while the menu is open. A chat moved to a group is listed
under it instead of its folder (a group named like a folder joins that folder's group). Outside sessions
get the same menu without Delete; their marks are Hydra Desk's session meta. The Filter menu shows Active (default, not archived), Archived (only archived chats) or All
(an "Archived" group at the bottom). Collapsed, the sidebar slides in over the content while the pointer
is on the show-sidebar toggle or the window's left edge. Footer: "Auto account" or the
pinned account, with the accounts popover (each account's 5-hour and weekly bars) and a gear (Settings).

*Sidebar, measured (see DESIGN.md "Sidebar"):* width 288px (resizable, 12px handle, `--df-sidebar-width`), left inset
8px, `padding-top` 36px (window chrome bar is 36px high), body padding 4px 8px, gap 8px. Nav rows
(New, Projects `Beta`, Artifacts, Customize, More) and chat rows are 269x26, radius 6px, padding-x 2px, gap
4px, 13px/19.5px text, leading slot 24x24, icons 16px. Group header row 34px high (padding 12px 1px 4px 6px),
12px muted, trailing buttons 24x24 (`+` new session in folder, Search, Filter and group). Selected row
`#ffffff26`, hover `#ffffff13`; the long title fades out (24px mask, 44px while hovered, where the 20px "More
options" button appears). Status dot: 14x14 slot holding a 6px dot; idle = hollow 1px ring `#898781` at 50%
opacity, running = solid `#898781` blinking (`dframe-dot-blink` 1.2s ease-in-out infinite, opacity .3 to 1),
unread/needs attention = solid `#2a78d6` (Hydra Desk: orange, see the table above). Footer 44px: user button (avatar "E", name, plan) + "Send feedback"
24x24. The "More" row opens a 128px menu (Routines, separator, "Edit sidebar...").

**Transcript** (`components/transcript/TranscriptView.vue`, props `{ chatId: string, items:
TranscriptItem[], readOnly?: boolean }`): centered column, max width 780px, auto-scroll that stops when
Jacob scrolls up (a "Jump to latest" button appears). User messages in a rounded `--bg-elev` box;
assistant text as markdown (markdown-it + shiki, dark theme, copy button on code blocks); thinking as a
collapsed "Thinking" row (expands to the text); tool calls as compact rows like Claude Code: icon, tool
name, the key argument (Bash command, file path, pattern, URL), a status spinner/tick/cross, click to
expand input and result. Edit/MultiEdit/Write show a red/green diff; Bash shows command and output in
mono; Read shows path and line range; TodoWrite renders the checklist; Agent/Task renders a nested card
holding its sub-items (`parentToolUseId`); `mcp__agenthydra__climayte_*` calls render as a CliMayte card
(tasks dispatched, worker ids). Permission, question, plan and elicitation items render as cards that call
the store (*Request cards* below); answered cards collapse to one line. `system` items
as muted lines (warn amber, error red); `result` as a muted footer line ("Done in 1m 12s · $0.42").
`readOnly` hides every button.

*Transcript, measured (see DESIGN.md "Transcript"):* the scroller is the whole pane (scrollbar at its right
edge, thin, thumb `#e1e0d9` at 35%); inside, a centered column 840px wide with 32px gutters (text width
768px, so "max width 780" above is really 768 text / 840 box; below 560px of pane the gutter is 16px).
Turn gap 20px (compact density 16px). User bubble: right-aligned, max-width 638px, padding 8px 12px,
radius 10px, background white 5%, 14px/18px text, enters with `code-user-bubble-enter` (opacity 0 to 1,
scale .92 and 6px up to none). Assistant text has no bubble: `prose` 14px/20px, paragraphs padded 4px left and
56px right, list indent 28px, `strong` 600, h3 15.75px/20.5px 600 with 21px top margin, inline code 12.6px mono
`#ec7e7e` on white 5% with 1px white-10% border, radius 5px, padding .79px 3.15px. Tool/status rows are 24px
high ("Ran a command, used a tool" + a 12px muted chevron, radius 6px, padding 2px 4px, gap 6px, `data-state`
done/running). Under each reply a toolbar of 24x24 muted buttons (Copy, Fork from here, Pin as chapter, Read
aloud, time), hidden (opacity 0) until the message is hovered (reveal .12s, hide 60ms).

**Composer** (`components/composer/Composer.vue`, props `{ chat: ChatSummary | null }`; null = a new
session): exactly like the reference: a strip above the box with folder name and branch on the left and
`+added -removed` (green/red) on the right (click opens the Diff pane); the rounded box with placeholder
"Type / for commands", Enter sends, Shift+Enter new line, auto-grows to 40% of the window; inside on the
right a send arrow, which becomes a stop button (circle with a square) while the chat is working and
the box is empty. Below the box: `+` (attach images; paste and drag-drop work too, previews as chips),
the permission mode menu (Ask permissions / Accept edits / Plan mode / Bypass permissions), and on the
right the model menu (from `/api/models`), the effort menu, and a small context ring (contextPct). Typing
`/` opens the slash command menu (from `/api/chats/:id/commands`). Ctrl+Enter queues the message instead of
sending it (*Send queue: the window* below). The `+` menu's Connectors submenu lists
`/api/mcp-servers` (muted transport per row); in a live chat each row has a status dot and a click toggles
the server for that session. In new-session mode the strip holds the
folder menu (*Folder picker* below) and the account picker (Auto + each account with its 5-hour %),
and sending creates the chat. Drafts are kept per chat in localStorage. Messages sent while working show
as queued in the transcript.

*Request cards* (`components/transcript/parts/`, logic in `lib/requests.ts`, `lib/elicitation.ts`): what the
chat asks, in the box's place (the composer hides while one is open).
- Permission: "Allow <tool>?" with the key argument, or the item's `title`, `description` and `reason`. Buttons
  Allow (1), Allow for this session (2), Always allow (3) and No with an optional reason (Esc; a bare No
  stops the turn). 2 and 3 show only when the item can be always-allowed, and the rules it would save are
  listed under the buttons. A prompt with `defaultToNo` offers no one-key approval: 1, 2, 3 and Enter do
  nothing and focus starts in the No box.
- Keys answer a card only when the owner is not typing past it. The key must land in the card or on the page
  body (not on another control), the card must have been up 400 ms, the key must not be auto-repeat, and no
  other key may have come in the 600 ms before it (`lib/key-clock.ts` records keys from load). A request that
  docks while the owner types hides the box and drops focus to the body; the rest of their sentence
  ("step 3", Enter) must not answer it.
- Question: options per question (single or multiple) with Other, Skip. With several questions the card
  shows one at a time under "Question N of M" (a dot per question), with Next / Back; answers are kept while
  moving, Enter goes to the next step, and the last step's Answer submits them all together. A single
  question has no step header. The "Other" box takes pictures by Ctrl+V or drop (composer rules: PNG, JPEG,
  GIF, WebP, 5 MB each) as thumbnails with a remove x; on submit they travel as `images` (see canUseTool). Plan: Approve plan (back to the
  mode the chat had before plan mode, so a Bypass chat stays Bypass), Approve, review each edit (mode
  `default`), Keep planning with feedback.
- Elicitation: a form (one field per requested property, with its title, description and constraints; the
  answer is checked in the window and again on the server) or a link request (the url's host is shown, Open
  link), and Cancel. A refused answer shows the server's reason in the card.
- Settled cards collapse to one line (Allowed, Allowed for this session, Always allowed, Denied, Declined,
  Expired); `readOnly` hides every button.

*Folder picker* (`components/composer/FolderPicker.vue`; server `server/src/folders/`): the real app's folder
menu, opening upward from the folder pill. "Recent" lists folders by name only (folders sharing a name also
get the end of their parent path, muted) with a check on the current one; hovering a row shows an X that takes
it off the list (Delete does it from the keyboard) until it is used again. Below a separator, "+ Add new
folder…" opens Windows' own Select Folder dialog. A page cannot learn a folder's path, so the server shows it:
`pick-folder.cs` is compiled once with the .NET Framework's csc.exe into `<home>/bin/pick-folder-<hash>.exe`
and run per click (no console; owned by the Hydra Desk window when that is in front, which is enabled again as
soon as the dialog shows, so a killed helper never leaves it disabled). The folder chosen becomes the new
session's folder and tops Recent. No typed paths, no browsing inside the menu.

*Composer, measured (see DESIGN.md "Composer"):* dock 768px wide, centered in the same column. Order top to
bottom: the repository strip (`nav` "Repository and pull request controls": 768x40, radius 10px, padding 8px,
white 5%; project button, branch button, `+13,658 -4,852` counts button, "Create PR" split button with a "More
PR options" chevron, "Dismiss" X), 6px gap, the box (background `#20201f`, radius 12px, padding 8px, 1px inset
ring white 10%, shadow `0 4px 20px #00000009`, textbox 14px/20px, caret `#f0efec`, auto-grows to max-h 384px
(`max-h-96`), send button 24x24 at its bottom right), then the toolbar row (20px high, 12px `#c3c2b7`, margin-top
6px, padding 0 10px 0 7px): left `+` (aria "Add"), mic ("Press and hold to record"), "Dictation settings" chevron,
the permission-mode button; right model ("Model: ..."), effort ("Effort: ..."), "Fast mode", the usage ring
(aria "Usage: Context ..."). The real placeholder on a new session is "Describe a task or ask a question".
Menus: 10px radius, `#20201f`, ring white 10%, shadow `0 8px 24px #00000052, 0 2px 6px #0003`, padding 4px, item
24px (40.5px with a description line), radius 6px, padding 2.5px 8px. Exact labels and orders: DESIGN.md.

**Send queue: the window** (`components/composer/`, behind the server's queue, see "Send queue" above): the
server holds the queue and sends from it. The window only shows and edits it and never dispatches
anything. All queue UI is Hydra Desk's own; there is no real-app reference capture for it.

*Keys* (`composer/logic.ts` `composerKeyAction`, `composer/queue.ts` `sendOrEnqueue`):
- Enter returns `send`. Ctrl+Enter or Cmd+Enter returns `queue`. Shift+Enter is still a new line. An open
  slash or mention list still takes Enter, and Ctrl+Enter, as a pick. Ctrl-click on the send button counts
  as Ctrl+Enter. With no queue reported by the server, every send goes out as before.
- "busy" is the window's own reading of the chat status: working, starting or needs_you. "ahead" is this
  chat's items that are `waiting` or `sending` (a held or failed one does not make a new message wait for it).

| Where | Key | Result |
|---|---|---|
| Chat with items ahead | any Enter | enqueue (the order holds) |
| Busy chat, nothing ahead | Ctrl+Enter | enqueue |
| Busy chat, nothing ahead, mode 'queue' | Enter | enqueue |
| Busy chat, nothing ahead, mode 'immediate' | Enter | send (into the running turn, as today) |
| Any other status (idle, closed, stopped, error, limited), nothing ahead | any Enter | send (nothing to wait for) |
| New-session screen | Ctrl+Enter | queue a `{ kind: 'chat' }` item, clear the draft, show "Queued: starts when an account has room" in grey |
| New-session screen | Enter | enqueue only in mode 'queue', otherwise create the chat |

- A failed enqueue puts the text and images back and shows "Not sent: <server error>".
- ArrowUp in an empty box, while this chat has queued items, takes the last item that is not sending back
  into the box (text and pictures) and removes it from the queue. Otherwise it recalls the last sent message.
- The send button's word (`Send` or `Queue`, its aria-label) and its tooltip come from `sendWords`: `Queue`
  when Enter would enqueue, with what the item waits for.

*Send button* (`composer/SendSplit.vue`):
- The default state is unchanged. The button is `aria-disabled`, never `disabled`, when there is nothing to
  send, so a right-click on it still opens the queue from an empty box.
- Hovering the button for 1000 ms, or giving it keyboard focus, shows a 16x24 up-chevron absolutely to its
  LEFT. It takes no layout width. It stays while the popover is open.
- The chevron, a right-click on the button (capture phase on the group), Shift+F10 or the Menu key open the popover.
- The popover is anchored to the group with no PopoverTrigger, because a Tip between a popover root and its
  trigger leaves the popper unplaced. The button's Tip is disabled while the chevron or the popover shows.
- The popover closes when the chat on screen changes or a request card takes the box's place.

*Popover* (`composer/QueuePopover.vue`): role="dialog", label "Message queue", 360 wide, the MENU look, side
top, align end, at most 480 high with scrolling. Top to bottom:
- Header: "Queue", the item count (", paused" when paused) and a Pause/Resume button.
- "When you press Enter", with two choices: "Send immediately" ("A message goes straight into the running
  turn") and "Send as a queue" ("It waits until the chat finishes its turn. Ctrl+Enter always does this").
- A separator, then one banner per held chat ("<title>: you stopped it / it failed / the server restarted")
  with Resume.
- The list (role="list"). Order: the open chat's items first, then other chats', then new chats, each group
  in the order its first item stands in the server's queue; the server's order is kept within each group.
  Each row shows its position within its chat, a chip with the chat's title ("New chat" for new-chat items),
  the text clamped to 2 lines, an image count, and a badge only for Sending..., Held: <reason> or
  Failed: <reason>. Actions on hover or focus: Edit, Move up, Move down, Send now (Retry on a failed item),
  Remove.
- Edit is inline: Enter saves with `ifRev`, Shift+Enter adds a line, Esc cancels the edit but not the
  popover. Move swaps the item with the next item of the same chat (or the next new chat) and is disabled at
  either end.
- Empty state: "Nothing queued. Ctrl+Enter adds a message." A refused action shows the server's error in the popover.

*Tray* (`composer/QueueTray.vue`): inside the box, above the text, only while this chat has queue items. At
most 3 rows (h-6, 13px, truncated, with a badge; an images-only item says so) plus "+N more". Every row opens
the popover. While a request card hides the box, a dock chip "N queued" (`composer/QueueChip.vue`) opens the
same popover. The WorkerDock's own "N queued" chip (the SDK's queue) is unchanged.

*Store* (`stores/desk.ts`): `queue: Ref<QueueState | null>`. `hello.queue` replaces it whole (null when hello
has none); `queue.update` replaces it unless its `rev` is lower. Actions: `queueAdd` (POST /api/queue),
`queueEdit` (PATCH /api/queue/:id), `queueRemove` (DELETE), `queueMove(id, +-1)` (POST /api/queue/reorder with
the whole id order and `ifRev`; nothing is sent at an end), `queueSendNow`, `queueRetry`, `queueResume(chatId)`,
`queueSettings` (PATCH /api/queue). Answers that are a QueueState are taken at once; a QueueItem arrives
through `queue.update`. A refusal rejects with the server's `{ error }` text. `ShellSource` carries them as
optional members (`queue?`, `queueAdd?`, ...): the composer shows queue UI only when the source has them and
the server reported a queue. Demo composers (Gallery, parity) never show it.

**CliMayte** (`components/climayte/CliMaytePanel.vue`, props `{ originSessionId?: string | null }`):
active workers first, grouped by group, then recently finished. Each row: status glyph (same language as
the sidebar), title, account, model/effort, elapsed, usedPct bar, last activity line. Actions: Stop
(cancel), Send (a follow-up message), Open (shows the worker's live transcript in the main area,
read-only, via ExternalSessionView with its sessionId). A toggle "This chat only" filters by origin.

**Elsewhere** (`components/external/`): `ExternalSessionList.vue` (all outside sessions with status,
source, instance, last activity, sorted working first) and `ExternalSessionView.vue` (props `{ sessionId:
string }`, transcript refreshed every 3 s while working). A Claude Desktop or terminal session that is idle
(`ExternalSession.canResume`) opens with the live composer; its first message imports it (`POST
/api/chats/import`) and resumes it. It continues in place on the CLI instance whose folder already holds
its transcript (`accountId`), otherwise as a copy under the account the window lands it on (Settings'
default account, or Auto's pick): a session is a file, and `seedSession` copies it into that account's
config folder before the resume, so it never fails with "No conversation found".
- The copy is the transcript `<id>.jsonl` and the session's sidecar folder (tool results, subagent
  transcripts), which the resume reads. A copy that is already there is refreshed only when it is an older
  version of the same transcript; one that went its own way is never overwritten. The original is never touched.
- A session that has run in Hydra Desk before resumes from the folder it last ran in (`ranIn`, kept on the
  chat), so moving A -> B -> A carries every turn.
- The default `~/.claude` login is not used to resume (its own CLI token expires): with no account that has
  room the import is refused (409) rather than landed there, and a named account that is signed out is
  refused the same way ("<label> is signed out").
- Before the first message the stand-in's quiet line says where it goes: "Continues in place on #N." or
  "Continues as a copy on #N. The original stays as it is."; "Continues as a copy on the account CliMayte
  picks when you send. The original stays as it is." when the pick lands on the default login (CliMayte
  places the copy on an account with room at the first message). A failed import leaves the stand-in open with the server's
  reason.
- Working elsewhere, the strip is a quiet line (the session is not resumed while its owner's process works
  on it). Only Claude Desktop and terminal sessions continue; Codex, CliMayte and other sources stay
  read-only, and the server refuses to import them (400).

**Diff pane** (`components/panes/DiffPane.vue`, props `{ cwd: string }`): changed files with +/- counts,
click a file to see its unified diff (green/red lines), refresh button, auto-refresh when a chat in that
folder finishes a turn.

**Settings** (`components/panes/SettingsView.vue`, rows as data in `panes/settings.ts`): a dialog over the
window (min(920, 100vw - 48) x min(680, 100vh - 48), Esc or the X returns to the view under it), shaped
like the real Settings without its account, billing and connector pages. Left nav: Search (filters every
row by label and description, grouped under the section name, "No settings match" when none), then
General, Accounts, CliMayte and About (arrow keys move between them; below 640px a pill row). Right:
bold group headings over rows of label, muted description and control, split by hairlines. Rows: default
model, effort, permission mode, notifications (with Test), idle-close minutes, the default account
(`AccountsList embedded`), delegate to CliMayte, workers running, bridge status, version, data folder.

**Notifications:** browser `Notification` when a chat finishes, needs Jacob, errors or hits a limit
while the window is not focused or the chat is not the one on screen; clicking it focuses that chat.

**Store** (`web/src/stores/desk.ts`, `useDesk()`): reactive `chats`, `itemsByChat` (Map chatId ->
TranscriptItem[], loaded on first view then kept live from `/ws`), `external`, `workers`, `accounts`,
`settings`, `connected`, `selected` (`{ kind: 'chat', id } | { kind: 'new', cwd? } | { kind:
'external', id } | { kind: 'climayte' } | { kind: 'elsewhere' } | { kind: 'settings' }`; `settings` opens
the Settings dialog over the last other view), and actions
`select, createChat, send, interrupt, respondPermission, answerQuestion, respondPlan, answerElicitation,
updateChat, removeChat, cancelWorker, sendToWorker, loadItems, loadExternalItems, updateSettings` and the
queue actions (*Send queue: the window*).
Reconnects `/ws` with backoff and reloads on reconnect. A new build reloads the window onto it, back on
the chat it showed (see "Launcher").

## Server wiring (so workers never edit the same file)

`server/src/index.ts` (written once by the scaffold task) loads every file in `server/src/plugins/`
in filename order; each exports `default async function plugin(app: Hono, ctx: ServerContext)`.
`server/src/context.ts` exports `ctx`: `{ home, broadcast(event: ServerEvent), settings(),
registerHello(fn) }`. Plugins: `10-bridge.ts` (bridge routes and poller), `20-engine.ts` (chat manager,
chat routes, models, commands, folders/recent and folders/pick, registers the `hello` provider), `30-git.ts` (git and
folders/browse). Each plugin imports what it needs from its own folder; the bridge is a lazy singleton
exported as `bridge()` from `server/src/bridge/index.ts`, so the engine calls `bridge().placeAccount()`
directly. Nobody edits `index.ts`, `context.ts` or another worker's plugin.

The window mirrors it: `web/src/App.vue`, `web/src/stores/desk.ts` and `web/src/components/shell/` belong
to the shell task; each other area owns its own folder under `web/src/components/` and its own
`web/src/dev/sections/<Area>Section.vue` (the Gallery loads every file in `sections/` with
`import.meta.glob`, so adding a section never touches another file).

## Diagnostics (failures and speed)

One place for what went wrong and what was slow. Settings > Diagnostics (`web/src/components/diagnostics/`) is a
container: `sections.ts` lists its sections (`DIAGNOSTICS_SECTIONS`, or `registerDiagnosticsSection`), each a component
that reads its data with `usePaneApi().diagnostics(name, params)` (GET `/api/diagnostics/<name>`). Failures is the
first; a Speed section adds one entry. Shared server helpers live in `server/src/engine/diagnostics.ts`:
`maskEmails`/`safeText`, `JsonlLog` (append-only `<home>/<name>.jsonl`, rolled to `<name>-YYYY-MM[-n].jsonl` at a new
month or 5 MB, a failed write only logged), `dayKey`, `sinceParam`, and `diagnosticsRoute(app, name, handler)`, which
registers `GET /api/diagnostics/<name>` behind the server's loopback guard (every route has it).

### Failure ledger (server/src/engine/failures.ts)

`<home>/failures.jsonl`, one line per failure: `id, ts, chatId, title, cwd, kind ('sdk'|'worker'), accountId,
accountNumber (never an email), model, cause, message (500 chars, emails masked), durationMs, sessionId`. A recovery is a
later line `{ event: 'recovered', failureId, movedToAccountId }` that readers fold into the row (`recovered`,
`movedToAccountId`). `classifyFailure(text, fallback)` is the one classifier: `auth_expired, org_disabled, usage_limit,
interrupted, refused_send, worker_failed, hook_timeout, hook_failed, move_failed, network, unknown`.

Written from every failure path, by `ChatManager.fail`: an SDK turn's error result or a crash and a failed hook
(`ChatRuntime.onFailure`, not while replaying a journal), a refused first message (`open`, which covers the queue's
chats too), a worker that turned to error (`applyWorker`, once per distinct error), and a failed account move
(`moveFailed`, cause `move_failed`). A move that went through (`moveChat`, or CliMayte's move seen in `applyWorker`)
marks the chat's latest failure recovered.

`GET /api/diagnostics/failures?since=&cause=&limit=` (since: epoch ms or a date; limit default 100, max 1000):
`{ rows: FailureRow[] (newest first), total, byCause, byAccount ('#126' or id), byDay ('YYYY-MM-DD') }`, the counts over
every match, not just the returned rows. `since` also reads the rolled files. The Failures section shows counts by
cause for today and 7 days, by account over 7 days, and the latest rows, each opening its chat.

AgentHydra incidents: not fed from here. `server/src/routes/incidents.ts` only lists, reads, acks and resolves
(`GET /api/incidents`, `/:id`, `POST /:id/ack`, `/:id/resolve`); incidents are created in-process by `recordIncident`
(dispatch, usage, loop detection), so no existing one-call route takes a Desk failure. Sending them would need a new
create route in AgentHydra, which is its owner's call.

### Speed (timings) (server/src/engine/timings.ts, shared/timings.ts)

`<home>/timings.jsonl`, one line per measured stage (`JsonlLog`, rolled like the failure ledger): `ts` (when the stage
ended), `stage`, `ms`, and as they apply `chatId, turnId, name, kind ('sdk'|'worker'), accountId, accountNumber (never
an email), model, cwd, cold, ok`; a `turn` line adds `stages` (ms per part of the turn), a `sync_poll` line `n` and `max`.
Taking a timing never breaks a chat: every entry point swallows its own error and no timer holds the process open.
An SDK chat is timed from the SDK's own messages against the server clock (`ChatRuntime`'s `onMessage`, live messages
only, never a replayed journal); a worker chat from what the 3 s poll sees, so its stages are accurate to one poll.

Every stage (`TIMING_STAGES`):

| Stage | What it measures | Clock |
| --- | --- | --- |
| `click_to_server` | Send clicked -> `POST /messages` answered | window (`performance.now()`) |
| `click_to_bubble` | Send clicked -> the user bubble drawn (next frame after its `item.upsert`) | window |
| `open_to_paint` | a chat opened -> its history fetched and painted | window |
| `chat_open` | `GET /api/chats/:id/items` from request to items served (`n` = items) | server |
| `process_start` | the SDK process started -> its first message | server |
| `hook` | one hook, `hook_started` -> `hook_response`; `name` is `Event:script.mjs` when the hook's output names its file, else the SDK's `hook_name` (`SessionStart:startup`) | server, SDK messages |
| `session_start_hooks` | the SessionStart group: first hook started -> last ended (they run in parallel), `name` = startup / resume | server, SDK messages |
| `mcp_connect` | the process start -> each MCP server's first status other than pending (`mcpServerStatus()`, read every 500 ms for 30 s), `name` = server, `ok` = connected | server |
| `ready` | the message sent -> `system/init`; `cold` says how the process stood: `new`, `resume`, `warm`; none for a running chat | server |
| `warm` | a warm start's process start -> `system/init` (no one waited on it) | server |
| `queue_wait` | a message sent during a turn -> the turn it waited behind ended | server |
| `first_token` | the later of the turn's start and ready -> the first streamed delta or assistant message | server |
| `tool` | one tool call, `tool_use` -> its `tool_result`, `name` = tool, `ok` | server, SDK messages |
| `api` | the result's `duration_api_ms` (the model's own time) | CLI |
| `turn` | sent -> `result`; `stages` = `{ hooks, ready, first_token, tools, api, queue_wait }` | server |
| `worker_accept` | Desk's send -> CliMayte accepted the message | server |
| `worker_queue` | accepted -> the worker seen running (or replying, or done) | server, poll |
| `worker_first_item` | sent -> the first new assistant item synced | server, poll |
| `worker_turn` | sent -> the worker no longer at work; `stages` = the four worker stages | server, poll |
| `account_move` | sent -> CliMayte moved the worker to another account, `name` = `#126>#61` | server, poll |
| `sync_poll` | one read of the workers' status and transcripts; one line per minute (mean `ms`, `n` polls, `max`) | server |
| `title` | the generated title's request -> answer, `ok` = a title came | server |

`GET /api/diagnostics/timings` (`TimingsResponse`, over the last 7 days): `today` and `week` (per stage: count, p50,
p90 by nearest rank, max, total ms, the most total first), `slowestTurns` (20, each with its stage breakdown, account,
model, cold kind), `coldStart` (process start, each SessionStart hook and group, each MCP server), `ready` by cold kind,
`hooks` and `tools` by name, `workers` (accept, queue, first item, moves), `slowNow` (today's waits per stage and name,
ranked by total time lost; a whole turn, the model's time and the background poll are not waits), and turns `byAccount`
('#126' or id), `byModel`, `byFolder`. `POST /api/diagnostics/timings/client` (`{ stage, ms, chatId? }`) takes the
window's own stages only, `ms` 0 to 600000; anything else 400.

The Speed section (`SpeedSection.vue`, `speed.ts`) shows what is slow right now, per-stage p50/p90 bars for today or 7
days, the slowest turns (each opens its chat), the cold start breakdown and send -> ready by cold kind, the worker
waits, and turns by account, model and folder.

The warm start: typing in a closed SDK chat (the composer focused, text not empty) calls `POST /api/chats/:id/warm`,
which starts its process with its session (`ChatRuntime.warm()`: started, idle, the idle timer armed), so the process
start and the SessionStart hooks run while the owner types and the turn's `ready` is the `warm` kind. A worker chat,
a running, archived or outside chat is never warmed. An idle-closed chat's next message otherwise costs a whole
`resume` start (process plus SessionStart hooks); a longer `idleCloseMinutes` also avoids it.

The SessionStart hooks are the owner's own Claude Code settings, loaded into Desk's SDK chats as into any CLI session;
Desk does not skip them (the only switch, `disableAllHooks`, would drop the safety hooks too). Their cost shows by
name in the cold start breakdown.

## Parallel workers and ports

Several workers run at once in this one folder. Vite dev ports are assigned per worker so they never
collide: shell 4796, transcript 4797, composer 4798, panels 4799, diff-settings 4800, e2e-ui 4801
(`bun run --cwd web dev --port <n> --strictPort`, started hidden, stopped when done). Server test ports
are always 0 (a free port).

## Launcher (launcher/)

`launcher/start.ps1`: if `GET http://127.0.0.1:7798/api/health` fails, start the server hidden
(`Start-Process -WindowStyle Hidden`, stdout/stderr to `~/.hydra-desk-2/logs/server.log`), wait for
health, then open Microsoft Edge as an app window (`--app=http://127.0.0.1:7798
--user-data-dir=%LOCALAPPDATA%\HydraDesk2\window`) so it is its own window with its own taskbar entry.
`launcher/install-shortcuts.ps1` makes Desktop and Start Menu shortcuts named "Hydra Desk" with an icon
(`launcher/hydra-desk.ico`). Never a visible console window.

**Updates without losing the chats.** `launcher/stop.ps1` asks `POST /api/server/shutdown`, waits 15 s,
then ends what is left of the server by the pids in `~/.hydra-desk-2/server.pid` (`taskkill /T`; chat
hosts are outside that tree). The chats keep running; `-Chats` ends them too (through the server, else by
the pids in their host files). `launcher/restart.ps1` is stop.ps1 then `start.ps1 -NoWindow`: how a server
update goes live. A change to the window alone needs only `bun run build`: the server serves `web/dist`
from disk on every request, and an open window looks for a new build on every hello, every minute and
when it comes back into view, then reloads onto it at once when out of sight, else once it has not been
touched for 30 s, back on the chat or screen it showed (`web/src/lib/stale-bundle.ts`, `view-memory.ts`;
drafts are saved as they are typed).

## Done means

1. `bun run typecheck`, `bun test` and `bun run build` pass at the root.
2. A real chat works end to end against a real account: create, stream a reply, status goes
   working -> idle in the sidebar, interrupt a long turn (stopped), a permission prompt in Ask mode is
   approved from the window and the tool runs, a second message while working is queued then answered.
3. CliMayte panel lists the real active workers; Elsewhere lists the real Claude Desktop/CLI sessions
   with their status.
4. The launcher opens it as its own window.
