# Reference

Everything the README deliberately leaves out. The README is for deciding whether you want this;
this file is for running, configuring and hacking on it.

- [MCP server](#mcp-server)
- [Claude Desktop session mapping](#claude-desktop-session-mapping)
- [Config (env)](#config-env)
- [ChatGPT handoff](#chatgpt-handoff)
- [Auto-update](#auto-update)
- [Instance appearance](#instance-appearance)
- [Stack](#stack)
- [Layout](#layout)
- [Checks](#checks)

Agents looking for the quota tools specifically want [AI_USAGE_SELFCHECK.md](AI_USAGE_SELFCHECK.md).

## MCP server

The daemon's REST API is also exposed over MCP stdio (`server/src/mcp.ts`, or `bun run mcp`), so
agents (Claude Code, Claude Desktop, Cursor) can drive sessions, the run queue, accounts, the
scheduler, and instances the same way the web UI does. Start the daemon first; the MCP server
follows its actual bound port via the runtime pointer, overridable with `AGENTHYDRA_URL` (full base
URL) or `AGENTHYDRA_PORT`.

```json
{
  "mcpServers": {
    "agenthydra": {
      "command": "bun",
      "args": ["run", "--cwd", "<path-to-agenthydra>", "mcp"]
    }
  }
}
```

Tools cover sessions (list / get / tail / search / export across Claude, Codex, OpenCode and the
foreign readers), project discovery (`list_projects`), chats a usage limit cut off
(`list_rate_limited_sessions`), the queue (list / add /
update / run / cancel / events), accounts (secrets always masked), the scheduler (get / set),
Claude Desktop instances (list / launch / quit), Claude CLI instances, and Codex CLI/Desktop
instances (list / create / CLI launch / login helper / desktop open / focus / quit), usage-check
(`check_usage`, `check_my_usage`), and the auto-resume monitor (get / set), plus an update check.
Mutating tools say `MUTATES:` in their description; there is deliberately no shutdown tool.

`list_sessions`, `get_session`, and `tail_session` accept a `source` of `claude`, `codex`,
`opencode` or `foreign` (the shared reader for Cursor, Windsurf, Zed, Copilot CLI and the rest);
every returned session is source-tagged. Session viewing/search is unified, but queue dispatch,
composing replies, and rate-limit auto-resume remain Claude-only.

### Reading ALL the history, not just today's

`list_sessions` defaults to the **last 24 hours**, because the list it powers answers "what am I
working on". An agent told to go through "all my chat histories" therefore has to say so, and the
tool description says the default out loud so it knows to:

- `period: "24h" | "7d" | "30d" | "all"`, or explicit `since` / `until` bounds (epoch ms or an ISO
  date) for a real date range.
- `offset`, for paging past the 500-row ceiling. Pages are contiguous — `offset: 500, limit: 500` is
  exactly page 2 of the same ordering — because the offset is counted in returned rows rather than
  in index entries, which would skip an unknown number of them.
- `project`, a case-insensitive substring of the working directory or project key.
- `list_projects {}` — every folder that has conversations in it, with a session count and a
  per-provider breakdown. Read from the transcript index, never a transcript, so it is cheap. This
  is the index of the index: start here to find out what "all" contains, then scope a real query.

### Chats a usage limit cut off

`list_rate_limited_sessions { pendingOnly?, period?, project?, limit? }` lists the conversations a
quota wall ended — "You've hit your weekly limit · resets 3am". Every session row also carries the
same verdict as `limit_stop`, and `rateLimited: "only" | "pending"` narrows `list_sessions` the same
way; the web UI exposes it as **List options -> Usage limits**.

`pending: true` means nothing followed the notice, so that session is *still* stopped there — the
actionable half. `pending: false` means it was resumed afterwards and is history. Pending-ness is a
pure function of the file, recomputed on every scan: the CLI cannot resume a session that died on an
API error without appending its own bookkeeping, so any resume flips it on its own.

Detection trusts only the CLI's own error report (`isApiErrorMessage` / a `<synthetic>` assistant
turn / an errored terminal `result`), never model prose or tool output, so a session that merely
*discussed* rate limits is not listed. It is Claude-only: Codex and OpenCode record an error, but not
in a form worth trusting, and a false claim here would be worse than a missing one. The judgment
lives in one place (`createLimitStopTracker` in `server/src/rate-limit-signal.ts`) and is shared with
the auto-resume monitor, so the badge and the resume queue cannot disagree.

### Why a thread is called what it is called

Every session row carries `title_source` — `custom` (a saved title the writing app displays), `ai`
(the model's own summary), `store` (the provider handed us one as a field), `envelope`, `message`
(the first thing said) or `id`. `envelope` is the one worth knowing about: the first turn arrived
wrapped in a pseudo-tag carrying a `name` attribute — `<scheduled-task name="nightly-sweep">` — and
that name became the title, so the string was chosen by whatever wrote the wrapper (a scheduler, a
hook, a harness) and may match nothing you have ever named. `title_tag` names that tag, and the web
UI prints it beside the title. This exists because threads turned up under a name their owner did
not recognise and there was no way to ask the app where the label had come from.

### Usage-check

`check_usage { account?, configDir? }` and `check_my_usage {}` let any MCP-speaking agent read an
account's remaining Claude subscription quota without asking a human. Pass `account` (a saved
dispatch account id or label) or `configDir` (a `CLAUDE_CONFIG_DIR` that's been `/login`'d once);
`check_my_usage` is a self-check that works out which account the calling process actually bills to.
Both report the session (5h) %, the weekly (all-models) %, and any per-model weekly %.

### Built-in guidance

The MCP `initialize` handshake returns an `instructions` block (`SERVER_INSTRUCTIONS` in
`server/src/mcp.ts`), which clients show the model once per session before any tool call, and every
usage or identity answer carries a one-line `nextStep`. Between them an agent gets AgentHydra's
operating rules (check your quota unprompted before heavy work, save state when `shouldOffload` is
true, gate a fan-out on current + projected cost, never quote an unattributed percentage) without a
human typing any of it. The handshake block is length-capped by a test, because it sits in context
for the whole session.

### Self-identification

`whoami {}` answers "which instance am I?" and shows its working: the permanent number, account
email, plan and rate-limit tier, plus a `confidence` (`exact` / `assumed` / `none`), the `method`
that won, the literal `clues`, and everything `ruledOut`. `check_my_usage` and a no-argument
`usage_budget` embed the same answer as an `identity` block, so a quota reading is never
unattributed.

It is not one env var. A Claude **CLI** instance sets `CLAUDE_CONFIG_DIR`; a Claude **Desktop**
instance sets none, because the account is chosen by the Electron host's `--user-data-dir`. So
detection layers `CODEX_HOME` → `CLAUDE_CONFIG_DIR` → `CLAUDE_CODE_EXECPATH` → the instance folder
holding this session's `claude-code-sessions` file → the parent `claude.exe`'s image path → the
Electron host's `--user-data-dir`, stopping at the first hit and only spawning a process scan when
everything cheaper came up empty. It runs in the MCP server process, never on the daemon, which
would faithfully identify the daemon. See [AI_USAGE_SELFCHECK.md](AI_USAGE_SELFCHECK.md) for the
three signals that look authoritative and are wrong.

**The weekly (all-models) % is the binding cap.** A fresh session % is a red herring when weekly is
near 100, and switching the flagship model doesn't dodge the shared weekly bucket. An agent should
check its own quota before a heavy multi-agent fan-out and pace accordingly, routing heavy work to
whichever account has the lowest weekly %.

## Claude Desktop session mapping

Claude Desktop and the `claude` CLI write the same transcript store under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Desktop separately keeps per-chat metadata
under `<user-data-dir>/claude-code-sessions/<org>/<user>/local_*.json`; the metadata's
`cliSessionId` is the only reliable link to the shared transcript. The scanner in
`server/src/instance-sessions.ts` therefore:

- matches only by `cliSessionId`, never metadata filenames or titles;
- scans both `%APPDATA%/Claude/` and every `~/.claude-instances/<name>/` store; and
- treats Desktop activity timestamps as advisory because externally appended turns do not
  reliably update them.

Never use `claude://resume?session=<uuid>` to refresh a live chat. It is a one-way import for a
finished CLI session: it rewrites the shared transcript without thinking blocks and creates a
second Desktop chat. External dispatch can append valid turns to a Desktop-backed transcript, but
whether reopening an existing Desktop chat causes the renderer to request those turns is not a
stable interface and must not be assumed by product logic.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `7787` | preferred API/UI port (hops if busy) |
| `AGENTHYDRA_INSTANCE_PORT` | `PORT + 1` | preferred port for `--instances` quick mode (hops if busy; separate from the full daemon) |
| `HOST` | `127.0.0.1` | loopback bind host; only `127.0.0.1`, `localhost`, and `::1` are accepted because the local API is intentionally passwordless |
| `AGENTHYDRA_PORT_FIXED` | unset | `1` = bind `PORT` exactly, skip the single-instance/port-hop |
| `AGENTHYDRA_HOME` | `~/.agenthydra` | config dir (`runtime.json`, instance-identity cache) |
| `AGENTHYDRA_SHUTDOWN_TOKEN` | unset | if set, `/api/shutdown` requires a matching `x-agenthydra-shutdown-token` header (the tray sets it) |
| `AGENTHYDRA_FAKE` | unset | dispatch uses the harmless fake CLI |
| `AGENTHYDRA_DATA_DIR` | `~/.agenthydra/data` | state directory (sqlite db, run logs, caches) |
| `AGENTHYDRA_DB` | `~/.agenthydra/data/agenthydra.db` | sqlite path |
| `AGENTHYDRA_RUN_LOG_DIR` | `~/.agenthydra/data/run-logs` | detached-run log and sidecar directory |
| `AGENTHYDRA_CODEX_HOME` | `~/.codex` | default Codex rollout store to scan |
| `AGENTHYDRA_CODEX_PATH` | auto-detected / `codex` | Codex executable used by managed Codex instances |
| `AGENTHYDRA_CODEX_DESKTOP_PATH` | auto-detected | Codex Desktop GUI executable; useful for nonstandard installs |
| `AGENTHYDRA_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | OpenCode CLI/Desktop SQLite session store |

`/api/health` returns `service: "agenthydra"`, which is load-bearing for the single-instance
pointer. It also returns `dataDir`, `dbPath` and `dataDirNotice`, which answer "which database is
this daemon actually using" by looking rather than by inference.

**One state directory, both modes.** A source checkout used to keep its state in the repo's
`server/data` while a packaged build used `~/.agenthydra/data`, so `bun run start` and the
installed daemon were the same app reading two different sqlite files: settings, the run queue,
orchestrator acks, `/orcstop` holds and the done-mark ledger all diverged, silently, and forensics
run against the wrong one answered confidently and wrongly. Both modes now resolve to
`~/.agenthydra/data`, and a checkout's existing `server/data` is moved across on first run (by
copy when the two live on different volumes, which is the normal Windows layout). If BOTH already
hold state, nothing is moved or merged: the per-user directory is used and the other one is named
in the boot log and in `dataDirNotice`, because the only unrecoverable version of this problem is
the one nobody is told about.

**What the first real migration proved (2026-08-26).** A live fleet's state moved 33 MB from a
checkout on `D:` to a profile on `C:`, verified row-for-row afterwards: 22/22 done-marks, 27/27
monitor rows, 46/46 settings and both `/orcstop` holds present at the destination, `dataDirNotice`
null. Two things only surfaced by running it rather than designing it. `renameSync` throws `EXDEV`
across volumes, and repo-on-`D:` with profile-on-`C:` is the *normal* Windows layout here, so a
rename-only migration would have silently never run for exactly the people who have the split. The
fallback copies and then deletes, in that order, so an interrupted migration leaves two copies
rather than none. And when both directories already hold real state there is no safe arbiter:
mtime inverts the moment someone runs the other mode once, so the code refuses to choose and says
so instead. Stop the daemon before moving anything: a copy taken while it holds the sqlite WAL is
not a copy of a consistent database.

Manually added dispatch API keys and OAuth tokens are stored as plain values in the per-user SQLite
database so the database remains portable. The state directories and database receive owner-only
POSIX modes where supported, and the daemon cannot bind beyond loopback. This protects the local
service boundary but is not a password vault: anyone who can read files as the same OS user can
read those manually supplied credentials.

## ChatGPT handoff

Enable **Settings → Providers → ChatGPT handoff** to add a ChatGPT action to the single-session
composer. It uses the composer task and effective working directory to create a Markdown
attachment, downloads it in the browser, copies a matching prompt, and opens
<https://chatgpt.com/>. AgentHydra never signs in, submits the prompt, uploads the attachment, or
reads the response.

The pack is capped at roughly 100,000 estimated tokens and 256 KiB per file. Git checkouts respect
standard Git ignore rules; non-Git directories use a bounded walk with common dependency/build and
credential directories excluded. Common secret filenames, private keys, and high-confidence token
patterns are omitted and reported as warnings. This is a guardrail, not a guarantee: review the
download before attaching private source code.

The endpoint is `POST /api/chatgpt/context-pack` with `{ "cwd": "...", "task": "..." }`; it is
available only while the provider toggle is enabled.

## Auto-update

Opt-in background self-update (off by default; it restarts the daemon):

```
POST /api/update/settings   { "enabled": true, "intervalSecs": 21600 }
```

`intervalSecs` clamps to [900, 604800]; default 21600 (6h). Each tick checks the remote and, only if
the working tree is clean, applies (`git pull --ff-only` + reinstall + rebuild) and relaunches itself
on the same port (`AGENTHYDRA_RELAUNCH=1` makes the successor wait for the predecessor to free it).
A dirty tree is never touched.

Because updates are a `git pull --ff-only` against `origin/main`, **pushing `main` is the release**:
as soon as `main` moves, every instance with auto-update enabled fast-forwards to it on its next
check. Treat a push to `main` as user-facing rather than as a staging step.

## Instance appearance

Renaming an instance changes only its display label; it never renames the profile folder. Windows
can hold a running profile folder open, and the folder name is also the stable session/instance id.
The removed `POST /api/instances/:dir/rename` endpoint must not be restored as a live folder rename.

### The four names on an instance row

They are four independent sources, and a row can legitimately show a different one in each column.
Written down here because "where is this name coming from?" is otherwise unanswerable from the UI:

| Shown as | Source | Changes when |
|---|---|---|
| **Name** column | `label` from `instance-meta.json`, else the account's friendly name, else the folder basename (`web/src/lib/instance-appearance.ts` `displayName`) | you rename the instance |
| **Instance account** column | the local part of the account's email, one rule for every row (`accountHandle`) | the profile signs into a different account |
| the hover on that badge | the full email, plus the Anthropic profile display name (`full_name`) when the account has one | that account's profile is edited at Anthropic |
| profile **folder** | fixed by the name typed at creation (`server/src/core/lifecycle.ts`), sanitized | never |

The account column deliberately does **not** use `accountName`. That resolver returns `full_name`
when set and an email fragment when not, so the column rendered a mix: one row a person's name, the
next an email fragment, with nothing distinguishing them. `accountName` remains the right
choice for *naming* a row (`displayName`), where a friendly string is wanted and its provenance
does not matter.

Appearance metadata `{ label, icon, color }` lives in
`~/.agenthydra/instance-meta.json`, keyed by normalized folder path and cleaned up when the
instance is deleted. `POST /api/instances/:dir/meta` applies a present value, clears a field when it
is `null`, and leaves an absent field unchanged. The curated icon/color keys live in
`server/src/core/shared.ts`; the web mapping and deterministic defaults live in
`web/src/lib/instance-appearance.ts`.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vue 3 + Vite, a shared LunarWerx UI kit (shadcn-vue `reka-mira` on Reka UI), Tailwind v4, `@lucide/vue`, TypeScript |
| Backend | **Bun + Hono**, `bun:sqlite` (queue / dispatch / scheduler / accounts and read-only OpenCode access) + JSON under `CONFIG_DIR`, SSE (`hono/streaming`) for live run output |
| Dispatch | `Bun.spawn` of the real `claude` CLI (no Agent SDK) |
| Multi-instance | per-OS Claude and Codex Desktop discovery / launch / focus / quit plus isolated Claude/Codex CLI homes (`server/src/core/*`); Windows DPAPI / macOS Keychain / Linux libsecret read Claude Desktop credentials |
| Launcher | Windows browser + system-tray (`misc/`) |

## Layout

```
server/    Bun + Hono daemon: sqlite, Claude/Codex/OpenCode session readers, transcript tail,
           dispatch, scheduler, instance pointer, core/ (Claude + Codex Desktop/CLI instances)
web/       Vue 3 SPA (Sessions / Queue / Instances views)
tests/     launcher.test.ts (the tray guard, Windows-gated) + server/instance unit tests
misc/      the Windows launcher toolkit (tray .ps1 / .vbs / .ico / Create-Shortcut / Make-Icon / Rebuild.bat)
scripts/   repo tooling (screenshots/: regenerate the README images)
```

## Screenshots

The three README images are generated, not hand-taken:

```
bun run screenshots                 # shoot and install into .github/screenshots/
bun run screenshots -- --keep       # write to tmp/screenshots/ instead, to eyeball first
bun run screenshots -- --url <url>  # reuse a server you already have running
```

It starts its own web server on a private port (5199, so an open dev session on 5173 is neither
disturbed nor photographed), drives headless Chrome over the DevTools protocol, and writes one PNG
per view at a viewport sized to that view's max-width shell.

**Nothing real is ever in frame.** These images are public, so instead of pointing a daemon at a
synthetic home directory, `scripts/screenshots/page-fixtures.js` replaces `window.fetch` before the
SPA boots: every `/api/` response is invented and no daemon runs at all. Any request that finds no
fixture is recorded, and the run **fails** rather than keeping images that could contain live data.
Adding a shot means adding an entry to `SHOTS` in `capture.mjs`; each one carries an `expect`
predicate that must hold before the shutter fires, so a fixture that stops matching the UI fails
the run instead of silently producing a screenshot of empty skeletons.

Requires a Chromium-based browser; set `CHROME_PATH` if it is not in a standard location.

## Checks

`bun run check` runs Biome + the i18n gate + a kit drift-check. The kit check needs an internal
LunarWerx kit checkout, so it's **owner-only and skipped in CI**; external contributors should run
the individual checks instead:

- `bun run lint`: Biome.
- `bun run --cwd web check:i18n`: no hardcoded UI strings; every `t()` key resolves (also gates `build`).
- `bun test`: includes the Windows-gated tray launcher guard and instance/crypto tests.
- `bun run typecheck`: web (`vue-tsc`) + server (`tsc`).

`bun run check:local` is the owner-only half on its own: today it is just `check:kit`, split out under a
name a pre-push runner can look for. It exists because the kit check is the one gate CI *structurally*
cannot run, comparing this app's synced copies against a private sibling repo that a public repo's
workflow can never check out. Before it had a name, a pre-commit hook was its only enforcement, and
that hook is skipped by `--no-verify` and silently does nothing on any machine without the sibling
checkout. External contributors should not run it; nothing in CI depends on it.

CI runs these across `[ubuntu-latest, windows-latest]`, so a green local run on one OS clears one
leg of two.

### A flake that only exists inside a full-suite run

`bun test` runs the whole suite in one process, so state that a single-file run never accumulates
(caches keyed to wall-clock granularity, shared temp dirs, module-level singletons) is reachable
only there. The OpenCode reader's session cache was one: a write landing inside the same filesystem
timestamp tick as a previous read could be cached away, which requires that preceding read in the
same process to happen at all. Two rules came out of chasing it:

- **An isolation run proves nothing about a flake that only fires in the full suite.** Re-run the
  whole suite, enough times that luck is implausible: 15 consecutive green runs against a reported
  ~1-in-3 failure rate is roughly a 0.2% chance of coincidence.
- **Anything keyed on mtime alone needs a tiebreaker** (size, or an explicit generation counter),
  because two writes can share one tick and the second one then looks like no write at all.

### Repo guardrails (`scripts/checks/`)

Custom checks, each a standalone `bun scripts/checks/<name>.mjs` run as its own CI step, and each
written from a bug that actually shipped. Node stdlib only, no install. Their headers carry the
incident; `tests/guardrails.test.ts` proves every one of them still fires on the broken shape and
stays quiet on the fixed one, so none can rot into a silent no-op.

- `reka-popper-root-inside-tooltip.mjs`: a popper root (DropdownMenu, Popover) wrapped AROUND an
  `IconTooltip` steals the anchor, so the real content opens off-screen and, when modal, freezes
  pointer events.
- `wmi-commandline-query-self-match.mjs`: a `CommandLine LIKE` query that forgets to exclude the
  shell running it matches itself and answers "found" forever.
- `kit-lib-type-drift.mjs`: a vendored kit lib whose `.mjs` and hand-written `.d.mts` disagree,
  which is either a compile error on import or `undefined` at runtime.
- `spawn-console-window.mjs`: `windowsHide` missing on a console spawn (a stray console window) or
  present on a GUI one (the window never appears).
- `spawn-test-without-timeout.mjs`: a test **or lifecycle hook** that reaches a subprocess while
  inheriting bun's 5s default. Such a case times the runner, not itself, and a cold windows-latest
  box runs this class ~10x slower than a dev machine. A repo-wide `bun test --timeout N` stands the
  check down, which is the better answer for a suite where nearly everything spawns.
