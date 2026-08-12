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

Tools cover sessions (list / get / tail across Claude, Codex, and OpenCode), the queue (list / add /
update / run / cancel / events), accounts (secrets always masked), the scheduler (get / set),
Claude Desktop instances (list / launch / quit), Claude CLI instances, and Codex CLI/Desktop
instances (list / create / CLI launch / login helper / desktop open / focus / quit), usage-check
(`check_usage`, `check_my_usage`), and the auto-resume monitor (get / set), plus an update check.
Mutating tools say `MUTATES:` in their description; there is deliberately no shutdown tool.

`list_sessions`, `get_session`, and `tail_session` accept a `source` of `claude`, `codex`, or
`opencode`; every returned session is source-tagged. Session viewing/search is unified, but queue
dispatch, composing replies, and rate-limit auto-resume remain Claude-only.

### Usage-check

`check_usage { account?, configDir? }` and `check_my_usage {}` let any MCP-speaking agent read an
account's remaining Claude subscription quota without asking a human. Pass `account` (a saved
dispatch account id or label) or `configDir` (a `CLAUDE_CONFIG_DIR` that's been `/login`'d once);
`check_my_usage` is a shorthand self-check of the calling process's own `CLAUDE_CONFIG_DIR`. Both
report the session (5h) %, the weekly (all-models) %, and any per-model weekly %.

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
| `AGENTHYDRA_DB` | `server/data/agenthydra.db` | sqlite path |
| `AGENTHYDRA_RUN_LOG_DIR` | `server/data/run-logs` | detached-run log and sidecar directory |
| `AGENTHYDRA_CODEX_HOME` | `~/.codex` | default Codex rollout store to scan |
| `AGENTHYDRA_CODEX_PATH` | auto-detected / `codex` | Codex executable used by managed Codex instances |
| `AGENTHYDRA_CODEX_DESKTOP_PATH` | auto-detected | Codex Desktop GUI executable; useful for nonstandard installs |
| `AGENTHYDRA_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | OpenCode CLI/Desktop SQLite session store |

`/api/health` returns `service: "agenthydra"`, which is load-bearing for the single-instance
pointer.

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

CI runs these across `[ubuntu-latest, windows-latest]`, so a green local run on one OS clears one
leg of two.

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
