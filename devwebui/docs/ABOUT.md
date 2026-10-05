# DevWebUI

> One dashboard to start, stop and watch every local dev server across all your projects - and the same control surface exposed to AI agents over MCP.

<!-- odin:about HAND-OWNED above the GENERATED marker. Edit freely; `odin codex about --ingest` carries it back into Odin's Codex. -->

## What it is

DevWebUI is a local GUI plus MCP control plane for a developer's local dev servers. From one dashboard a user starts, stops, restarts and watches live status, CPU, memory and logs for every `bun run dev`-style process across all their projects, grouped per repo by a small `.devwebui` manifest file. The same running daemon is exposed to AI coding agents over a 31-tool MCP server and a thin CLI, so a human clicking the GUI and an agent driving it over MCP see and change identical state. It runs entirely on the user's machine (no account, no cloud) with a Windows tray host, optional checksum-verified auto-update from GitHub Releases, and an opt-in LunarWerx Connections sign-in for cross-machine settings sync.

## Things not to forget

_The intricacies worth remembering: the gotchas, the half-built parts, the decisions whose
reason lives nowhere else. Odin never overwrites this section._

- Linking processes makes starting or stopping one start or stop the whole group in dependency order, and a companion process (like a shared database) auto-starts alongside anything else in its project - this is deliberate orchestration, not just grouping for display. anchors: `server/src/manager/links.ts:19`
- The .devwebui manifest is a two-way sync surface, not just config: GUI edits write back to the file in the repo's own root, and edits made to that file on disk are picked up live without restarting the daemon. anchors: `server/src/project-watch.ts:188`
- Runtime-aware launches deliberately resolve a real executable per project (following the lockfile to pick bun vs npm/pnpm/yarn) instead of spawning through a permanent shell wrapper. anchors: `server/src/runtime.ts:222`
- Threshold alerts require a breach to stay continuous for a user-set duration before firing, so one sustained incident produces exactly one fired event instead of one per polling tick - do not simplify this into a simple instant-threshold check. anchors: `server/src/alerts.ts:69`
- There is no auto-restart on crash: handleExit records the crash into the error log and marks the process 'crashed', but nothing re-spawns it - restart today only ever happens from a manual click or a linked-group restart. anchors: `server/src/manager/lifecycle.ts:525`
- Fired alert events have no outbound path yet - they persist to NDJSON and push over SSE only, so a user who isn't looking at the app has no way (no webhook, no OS toast) to learn a process breached a threshold. anchors: `server/src/alerts.ts:167`
- The tray host is Windows-only native Rust/Win32 code; macOS and Linux tray support is listed on the README roadmap but has no implementation started anywhere in the repo. anchors: `misc/tray-host-native/src/main.rs:802`
- Vue single-file components aren't indexed by the repo's codemap (it only covers TS/JS/Rust), so UI-side extension anchors intentionally point at the backing store.ts/lib functions rather than the .vue files themselves - don't expect codemap to find .vue-only logic. anchors: `web/src/store.ts:214`

<!-- odin:about GENERATED BEGIN - rewritten by `odin codex about --publish`; edit the Codex, not this -->

## What Odin knows about this project

Everything from here down is generated from this project's Codex dossier
(`codex/projects/devwebui.md` in the Odin clone) and is **rewritten on every publish** -
edit the dossier, not this block. Everything ABOVE the marker is yours.

### At a glance

- **Ships as:** tray app (Windows) + self-hosted web app (daemon + browser GUI, any OS) - prebuilt .exe/tray zip from GitHub Releases, or `bun install && bun run dev` from source; also ships a `devwebui` CLI and a stdio MCP server (server/src/cli.ts, server/src/mcp.ts)
- **Written in:** TypeScript (183 files), Vue (113 files), JavaScript (15 files), PowerShell (7 files)
- **Built with:** Hono, Tailwind, TypeScript, Vite, Vitest, Vue
- **Package:** `devwebui` 1.0.0
- **Entry points:** `bin`, `scripts`, `workspaces`
- **Tests:** 54 test file(s)
- **CI:** `ci.yml`, `release.yml`
- **Domain:** local-dev-servers, process-supervision, dev-tooling, ai-agent-tooling
- **Remote:** https://github.com/LunarWerxs/DevWebUI.git

### Architecture

- `server/src/` - Bun + Hono daemon: HTTP + SSE API, process/project manager, MCP engine, CLI, self-updater, native OS calls (shortcuts, dialogs, DPAPI sealing)
- `server/src/http/` - Hono route registrations (process, project, system, Connections routes) mounted by http/index.ts's createApp
- `server/src/manager/` - process/project lifecycle state machine: start/stop/restart, linked/companion groups, wait-for-port ordering, resource polling
- `server/src/projects/` - .devwebui file I/O and schema, git clone, native browse/save dialogs (PowerShell/AppleScript/zenity), load-target resolution
- `web/src/` - Vue 3 + Vite SPA: store.ts holds reactive state driven by the daemon's SSE stream; components/ are the dashboard views; lib/ has theme, i18n, drag-drop and shortcut helpers
- `shared/` - cross-boundary DTOs, zod schema and the route table shared verbatim by server, web, CLI and MCP - the one source of truth for the wire contract
- `misc/tray-host-native/` - lunarwerx-tray: a native Rust Win32 tray host that spawns/health-checks/relaunches the daemon and opens the portable chromeless browser window
- `scripts/` - build/release tooling plus repo guardrail checks (lib-types export audit, spawn-test-timeout audit) run in CI
- `tests/` - Vitest + Bun test suites for server and web (50 files, ~6.4k lines)
- `docs/` - README screenshots and TESTING.md

### Features

26 recorded - 25 shipped, 0 partial, 1 planned. Each path is where the feature is DEFINED; the exact lines live in the Codex entry, which `odin codex check` re-verifies and repairs.

**Shipped**

- **Process control panel** _(free)_ - Start, stop and restart any registered dev server from the dashboard and see its live status, uptime, CPU and memory. - `server/src/manager/lifecycle.ts`, `server/src/http/process-routes.ts`, `server/src/metrics.ts`
- **Project grouping via .devwebui files, live-reloaded** _(free)_ - A small .devwebui manifest groups every process for a repo under one collapsible panel; edits from the GUI write back to the file, and edits to the file on disk are picked up without a restart. - `server/src/projects/file-store.ts`, `server/src/project-watch.ts`, `shared/schema.ts`
- **Linked and companion process groups** _(free)_ - Processes can be linked so starting or stopping one starts or stops the whole group in dependency order, and a companion process (e.g. a shared database) auto-starts alongside anything else in its project. - `server/src/manager/links.ts`, `server/src/manager/wait-for-port.ts`, `server/src/manager/lifecycle.ts`
- **Runtime-aware launches** _(free)_ - Automatic runtime mode follows each project's lockfile (bun vs npm/pnpm/yarn) and resolves compatible commands to a real executable so they launch without a permanent shell wrapper. - `server/src/runtime.ts`, `server/src/spawn-plan.ts`
- **Auto-scan and dev-project detection** _(free)_ - On first launch (and on demand) DevWebUI scans configured roots for .devwebui files and recognizable package.json dev scripts, inferring framework, port and a pretty name for each. - `server/src/scan.ts`, `server/src/detect.ts`
- **Add a project (drag-drop, browse, git clone, scaffold)** _(free)_ - Register a new project by dropping a folder or .devwebui file onto the app, a native folder-browse dialog, cloning a git URL, or scaffolding a fresh .devwebui file into an existing folder. - `web/src/lib/drop.ts`, `server/src/projects/git-clone.ts`, `server/src/projects/load-target.ts`, `server/src/projects/native-dialogs.ts`
- **Port-conflict rescue** _(free)_ - When a process's port is already taken, DevWebUI identifies the owning process by name/pid and can free the port on request. - `server/src/ports.ts`, `server/src/http/process-routes.ts`
- **Persistent de-duplicated error log** _(free)_ - Stderr, crashes and error-looking stdout are fingerprinted and collapsed into one entry with an occurrence count that survives restarts, and can be dismissed or cleared. - `server/src/errors.ts`, `server/src/http/core.ts`
- **Automatic failure diagnosis** _(free)_ - Matches a failed process's exit/log signature against known error shapes (port in use, module not found, missing env, command not found) and suggests a root cause and remediation. - `server/src/diagnose.ts`
- **Live per-process log streaming** _(free)_ - Tail any running process's stdout/stderr live in the GUI without leaving the dashboard, pushed over an SSE connection shared by every client. - `server/src/http/core.ts`, `server/src/log-buffer.ts`
- **Notifications inbox** _(free)_ - An in-app drawer surfaces scan results and other alerts as read/unread notifications the user can dismiss individually or clear. - `web/src/store.ts`
- **Desktop shortcuts (Windows)** _(free)_ - Send a single process or an entire repo's linked processes to the Desktop; double-clicking the shortcut starts them in a small window with a Stop button. - `server/src/shortcuts.ts`
- **Windows tray host** _(free)_ - A native Rust tray icon runs the daemon hidden, with Open / Rebuild & Restart / Restart / Stop all processes / Quit, health-polls the daemon, and revives it after a crash. The compiled single-file exe now also materializes its embedded tray host and starts it on launch if nothing else has, closing the earlier gap where only the extracted-zip distribution ever showed a tray icon. - `misc/tray-host-native/src/main.rs`, `misc/tray-host-native/src/daemon.rs`, `server/src/tray-bootstrap.mjs`
- **Portable focus window** _(free)_ - Opens a chromeless single-process browser window (used by desktop shortcuts and the tray's Open action) that remembers its last size and position per process. - `server/src/portable-window.mjs`, `server/src/window-size.ts`, `misc/tray-host-native/src/browser.rs`
- **MCP server for AI agents** _(free)_ - A stdio MCP server exposes 43 tools (projects, process start/stop/restart/enable/disable/all, logs, error log, threshold alerts, live browser tabs of a dev app) as a thin client over the same running daemon the GUI uses, on the shared kit-synced MCP engine that now dispatches requests concurrently (bounded by maxInFlight, default 8) so a slow tool call no longer blocks a fast ping or tools/list queued behind it on the same connection. - `server/src/mcp.ts`, `server/src/mcp-stdio.mjs`
- **CLI** _(free)_ - `devwebui start|stop|status|list|open|start-process|stop-process|restart-process|start-all|stop-all|alerts|mcp` - a thin client over the same REST API the GUI and MCP server use. - `server/src/cli.ts`
- **Shared REST + SSE API contract** _(free)_ - One typed route table (shared/routes.ts) and DTO set drive the Hono server, the Vue GUI, the CLI and the MCP server, so all four surfaces stay in sync by construction. - `shared/routes.ts`, `server/src/http/index.ts`
- **Auto-update (compiled distribution)** _(free)_ - The prebuilt binary checks GitHub Releases on an interval, downloads and SHA-256-verifies the matching asset, and applies it in place with an optional relaunch. - `server/src/github-updater.ts`
- **Self-update (source checkout)** _(free)_ - A source checkout instead checks and applies updates via git fetch/pull plus a rebuild, using a shared LunarWerx updater engine (kit-synced, now split for a complexity-gate lint) instead of the compiled-binary path; a failed self-update no longer erases edits made to the checkout while it ran. - `server/src/updater-engine.mjs`, `server/src/updater.ts`
- **Autostart takeover from other launchers** _(free)_ - Detects a project's existing autostart triggers (a VS Code task, a Vite extension) and offers to disable them (with a backup) so DevWebUI becomes the single launcher, restorable later. - `server/src/takeover.ts`
- **Settings sync via LunarWerx Connections** _(free)_ - Opt-in sign-in with a Connections account syncs a small allowlist of portable prefs and theme across machines; the refresh token is sealed at rest with Windows DPAPI. - `server/src/connections.ts`, `server/src/dpapi-seal.mjs`
- **Localization and theming** _(free)_ - Full i18n with an English base and community-addable locales (flagged if machine-drafted), plus a light/dark theme with a crossfade transition. - `web/src/i18n/locales/index.ts`, `web/src/lib/theme.ts`
- **Dashboard search, sort & filter toolbar** _(free)_ - Search projects/processes by name, filter the dashboard by status bucket, sort by column, and switch between card and table view - sort/filter/view choices persist across reloads (search text deliberately does not). - `web/src/store.ts`, `web/src/components/ProjectPanel.vue`
- **Threshold alerts on process CPU/memory** _(free)_ - Set a CPU or memory threshold per process that must stay breached for a continuous, user-set duration before it fires, so one sustained incident is one fired event rather than one per tick; rules and fired-event history persist across restarts. Parity across GUI (Settings -> Alerts tab), CLI (`devwebui alerts list|add|remove|events|clear`) and 5 matching MCP tools, adapted from PostHog's Alerts product onto the CPU/memory stream every managed process already reports. Debounced event saves resolve their destination file at scheduling time rather than when the timer fires, so a write can no longer land in the wrong data directory. - `server/src/alerts.ts`, `server/src/http/alert-routes.ts`, `server/src/cli.ts`
- **CSRF-hardened local API** _(free)_ - The daemon's unauthenticated localhost REST API rejects cross-site requests carrying browser-supplied provenance markers (Sec-Fetch-Site, Origin, Host), closing a drive-by-RCE class where any web page the user visits could otherwise POST to the local API with the owner's own credentials; non-browser clients (curl, the tray, MCP) are unaffected. - `server/src/loopback-guard.mjs`, `server/src/http/index.ts`

**Planned - written down, not built**

- **macOS / Linux tray support** _(free)_ - README's FAQ and roadmap list macOS and Linux tray support as not yet built; the tray host today is Windows-only Rust/Win32 (misc/tray-host-native).

### Where to add a new one

- **a new HTTP/REST route** - add a handler in server/src/http/*-routes.ts, register it in createApp, and add its pattern to the shared ROUTES table so server/web/CLI/MCP stay type-checked against it anchors: `server/src/http/index.ts`, `shared/routes.ts`
- **a new MCP tool** - add an entry to the TOOLS array in server/src/mcp.ts with its schema, then a case in the dispatch that calls the daemon's REST API anchors: `server/src/mcp.ts`
- **a new CLI command** - add to CLI_COMMANDS in server/src/cli.ts and a matching *Cmd handler function beside the existing ones anchors: `server/src/cli.ts`
- **a new manager capability (process/project behavior)** - add a mixin under server/src/manager/ and compose it into the Manager class in manager/index.ts, following ManagerBase/ManagerWithLifecycle/ManagerWithLinks anchors: `server/src/manager/index.ts`
- **a new locale** - add the code to the LOCALES union in web/src/i18n/locales/index.ts and a message catalog file beside it, per web/src/i18n/README.md anchors: `web/src/i18n/locales/index.ts`
- **a new repo guardrail/audit script** - add a script under scripts/ exporting an `audit.run` in the shape of check-lib-types.mjs / check-spawn-test-timeout.mjs so CI picks it up anchors: `scripts/check-spawn-test-timeout.mjs`
- **a new dashboard view or panel** - add reactive state to web/src/store.ts, then a .vue component under web/src/components/ wired into TopBar/RightDrawer anchors: `web/src/store.ts`

### Gaps and wants

_Withheld: this repository is public, and the gap list is not published outside the private index._
_Read it with `python odin.py codex brief devwebui` in the Odin clone._

---

_Generated by `odin codex about --publish devwebui` on 2026-09-16 from a Codex dossier stamped 2026-09-14. Regenerate after the product moves; `odin codex about` reports drift._
<!-- odin:about GENERATED END sha=f7cc46acb0ed -->
