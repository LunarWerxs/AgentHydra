# Changelog

All notable changes to DevWebUI are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The Discord link now opens DevWebUI's own channel and gives you the DevWebUI role** on joining,
  instead of dropping you in the server's general room to find it yourself.

## [1.1.0] - 2026-09-27

### Added

- **`get_runtime_services` MCP tool (and `GET /api/runtime-services`).** Returns a paste-ready
  `<RUNTIME_SERVICES>` block listing every running dev server as an agent on this machine reaches
  it (base URL, status, pid), the daemon's own health URL, and the names of credential env vars
  from each process's `.devwebui` env - names only, never values - so an agent stops probing ports
  and guessing base URLs. `includeStopped: true` lists stopped processes too.

- **Open any managed dev server through DevWebUI's own port.** A request to
  `http://<target>.localhost:<daemon port>` is relayed (HTTP and WebSocket, so HMR keeps working)
  to the port of the managed process `<target>` names: a process id, a project name in
  lower-case-hyphen form, or a declared port. `/proxy/<target>/...` redirects there. Each proxied
  server gets its own `*.localhost` origin rather than the daemon's, so its scripts cannot reach
  the local API; only ports a registered process declares are relayed, and the same cross-site
  guard as the API applies (a browser arriving from another site gets a one-click confirm page).
  A dev server listening on IPv6 loopback only (Vite's default `localhost` under Node 17+) is
  reached too. For now the URL is typed by hand: no process card or MCP tool links to it yet, and
  it serves this machine only, since a phone, another PC or a tunnel cannot resolve
  `*.localhost` names. Idea from code-server's domain proxy (MIT).

- **Compose-managed dependencies.** A process can carry a `compose` block: before it spawns,
  DevWebUI runs `docker compose up -d` for the repo's stack (skipped when it is already running),
  waits until every defined healthcheck passes and every published port really serves (a port
  Docker's proxy accepts and then drops does not count), and injects connection env derived from
  each service's image (`postgres` gives `DATABASE_URL`, `redis` gives `REDIS_URL`, and so on).
  A dev server no longer starts before its database and then fails in a way that needs
  diagnosing, and nobody hand-copies a `DATABASE_URL` out of a compose file. Services labelled
  `devwebui.ignore` are left alone, and `mode: "start-and-stop"` stops what DevWebUI started once
  the last process using the stack stops. Idea from Spring Boot's docker-compose support.

- **Safe mode after a crash.** Every daemon launch now leaves a run marker under the data
  directory's `.sentinel/` folder and a clean shutdown removes it, so a marker still there at the
  next launch means the previous run crashed. That launch loads your projects but auto-starts
  nothing (neither `autoStartOnLaunch` nor an auto-update's resume list), records the crash, with
  the uncaught error when there was one, as a de-duplicated entry in the error log, and shows a
  banner with **View crash** and **Leave safe mode**. A marker from before the current OS boot (a
  reboot or logoff) is not a crash and is dropped. Before this, a server that crashed the daemon
  on start was relaunched into the same crash by the tray every time. `--safe-mode` or
  `DEVWEBUI_SAFE_MODE=1` starts in safe mode on purpose; `GET /api/safe-mode` and
  `POST /api/safe-mode/exit` expose it.

- **Agents can ask the live browser tabs of a dev app what is broken.** A dev page that loads
  `<script src="http://localhost:<daemon port>/api/browser/client.js">` keeps an SSE line open to the
  daemon, and five new MCP tools reach it: `list_browser_tabs`, `get_browser_errors` (uncaught
  errors, failed resource loads, unhandled rejections and `console.error` - the client-side errors
  that never reach the dev server's stdout), `get_page_metadata`, `list_page_tools` and
  `call_page_tool`. The last two run inspection tools the app registers on its own page with
  `window.__devwebui.register(...)`, so a component tree or an element's source `file:line` can come
  from the app instead of a CSS selector. One question fans out to every matching tab and returns
  whatever answered within the timeout, failing only when no tab did, so one frozen tab never hides
  the rest. Only loopback-origin pages get the bridge. See AI_GUIDE.md, "Browser tabs".

- **Processes can answer prompts from scripts that read stdin.** Managed processes run on pipes
  with no terminal, so a program that asks a question without checking for a TTY (a shell `read`,
  `set /p`, Python `input()`, a custom setup script) waits forever. A process's new `answers` rules
  (ordered expect/send pairs, plain text or regex, optional or required) are typed into its stdin
  when the output matches. Each answer is noted in the process log by rule number, without echoing
  what was sent. Rule semantics follow Tabby's login scripts (MIT, ideas only).

- **Jump from a logged error to the line that threw it.** Every `file:line:col` in the error log
  (Node/Bun stack frames, Vite, tsc, Python, Rust, bare `path:line`) is now a link that opens that
  spot in the editor you already have running: DevWebUI finds it in the process list (VS Code and
  its forks, JetBrains IDEs, Zed, Sublime Text, Notepad++) and passes that editor's own line/column
  flag. `DEVWEBUI_EDITOR` picks one explicitly. The same jump is `POST /api/open-in-editor` and the
  new `open_in_editor` MCP tool, and `list_errors` now returns each error's `frames` pre-parsed.
  Non-integer lines, UNC paths and control characters are refused before anything is spawned, and
  the editor is launched outside the daemon's process tree, never through `cmd.exe`.

- **Opt-in local API authentication.** The loopback guard only stops cross-site browser pages; any
  other local process could still drive the API. Start the daemon with `DEVWEBUI_REQUIRE_AUTH=1`
  and every `/api` route except `/api/health` needs a credential: the per-boot cookie file the
  daemon writes to its data dir (the CLI and MCP server send it automatically), or a per-browser
  key earned by typing a 6-digit pairing code the daemon prints. The GUI keeps that key in its own
  local storage and sends it as a header (a cookie would reach every localhost dev server, since
  cookies ignore the port); the live stream opens with a single-use ticket. Paired browsers are listed and
  revoked with `devwebui pairing clients|revoke`. The cookie file is written on every boot, so
  turning enforcement on later needs no other setup.

- **Update cooldown for the prebuilt app.** Settings -> App updates -> *Update cooldown (days)*
  (`updateCooldownDays`, 0-90, default 0 = off) makes the release updater offer and install only
  a GitHub Release published at least that many days ago. When the latest release is too young it
  falls back to the newest release that is old enough, and if the release list cannot be read it
  offers nothing rather than the release it is holding back. A bad or compromised release then has
  that long to be caught before this install runs it. The idea comes from oh-my-zsh's update
  cooldown. The setting syncs with settings sync; source checkouts (git updates) are unaffected.

- **The dashboard search box is fuzzy and ranked.** It used a plain substring test, so `asv`
  never found "API Server" and hits came back in list order. It now runs a port of fzf's
  FuzzyMatchV2 scorer (`web/src/lib/fuzzy.ts`, MIT): any in-order subsequence matches, word
  starts, camelCase humps and consecutive runs score higher, and while a search is active the
  best match comes first, both among a project's processes and in the order of the project
  panels. Spaces split the query into terms that must all match. Project names use fzf's
  "path" scheme (slashes are word boundaries; a shorter name wins a tie).

## [1.0.0] - 2026-09-20

### Fixed

- **Sign-in and settings sync reached a domain that no longer exists.** The `.icu` registry
  suspended `connections.icu` on 2026-09-18 and the whole zone went NXDOMAIN - no DNS record at
  all - so every call to it failed at resolution from that date. Nothing reported it, because a
  name with no record returns no status code and writes no log; it fails inside the same path a
  flaky network uses. The daemon now signs in against `accounts.connectionsapi.com` and its
  update check asks `studio.connectionsapi.com`.

  Settings sync needed a second fix and it is the one worth knowing about: the issuer covers
  sign-in, but the data locker is a SEPARATE base URL that came from `@cnct/connect`'s own
  default - so sync kept failing while sign-in looked fine. That default is fixed in
  `@cnct/connect@1.5.2`, which this release takes.

- **The analytics pixel on devwebui.lunarwerx.com stopped recording** for the same reason, and
  now loads from `analytics.connectionsapi.com`.

### Changed

- **The version line moves to 1.x.** The package now declares 1.0.0 (was 0.8.8), so this release is 1.0.0 rather than another 0.x (owner directive, 2026-09-18: no public project stays on a zero major).

## [0.8.8] - 2026-09-12

### Fixed

- **The single-file `devwebui.exe` ships its tray icon.** It embedded every Vite asset and nothing
  from `misc\`, so `misc\lunarwerx-tray.exe` could not exist beside it and the download most people
  take could never show a tray icon, never offer Quit and never get the auto-restart supervisor.
  The README said so, as though 340 KB of Win32 binary were a reason rather than an omission. The
  host, its config and its icon now ride inside the binary and are written out to
  `<dataDir>/tray/<version>` on first run, with the config's shipped `appRoot: ".."` (correct only
  for the extracted zip) replaced by the absolute directory of the RUNNING exe and `compiledExe`
  set to its real filename - so a renamed or relocated download still gets a working watchdog.
  Version-scoped, because Windows cannot overwrite a running image.

- **"Is the tray already running?" stopped answering for a DIFFERENT app.** Caught here, live: the
  toolkit landed correctly and the host still did not start, because the shared probe counted
  processes by binary NAME and every LunarWerx app runs the same `lunarwerx-tray.exe` - it was
  seeing AgentHydra's host. With four apps sharing the binary, only the first to start would ever
  get a tray. It is scoped to this app's own config filename now (the host carries it on its
  command line). The same probe also read a non-zero PowerShell exit as "running", which is exactly
  what an ABSENT process produces, so the answer was backwards in the case it exists to detect.

  Both fixes live in the shared kit (`server/src/tray-bootstrap.mjs`), because AgentHydra, RepoYeti
  and ReDesign shipped the identical hole.



### Added

- **Threshold alerts on CPU/memory**, GUI + CLI + MCP ("alert if this process exceeds 80% CPU
  for 2 minutes"), adapted from PostHog's Alerts product onto the CPU/memory stream every
  managed process already reports (`server/src/metrics.ts`). A rule fires once a process's
  sample has stayed over its threshold for a continuous, user-set duration, then stays quiet
  until the metric drops back under threshold and breaches again: one sustained incident is one
  fired event, not one every tick. Rules and fired-event history persist across restarts
  (`~/.devwebui/alerts-rules.json` / `alerts-events.ndjson`); the in-memory "how long has this
  been breaching" timer deliberately does not, so a restart can never fire an alert instantly
  off a stale, already-elapsed window. REST surface: `GET/POST /api/alerts/rules`,
  `PUT/DELETE /api/alerts/rules/:id`, `GET /api/alerts/events`, `POST /api/alerts/events/clear`,
  a live `alerts` SSE event, matching MCP tools (`list_alert_rules`, `add_alert_rule`,
  `remove_alert_rule`, `list_alert_events`, `clear_alert_events`), a new **Settings → Alerts**
  tab to add/remove rules and review fired events (`web/src/components/settings/
  AlertsSection.vue`), and `devwebui alerts list|add|remove|events|clear` on the CLI
  (`server/src/cli.ts`) mirroring the MCP tools 1:1 - GUI, CLI and MCP now agree on every
  alerting operation, per the product's usual parity convention.

## [0.8.7] - 2026-08-15

### Fixed

- **Quitting from the tray icon while an update is installing no longer leaves you with no app,
  and no dev servers.** Applying an update starts the replacement daemon and shuts the old one
  down 800ms later. For that fraction of a second the replacement was a CHILD of the daemon on its
  way out, and the tray's Quit does not stop one process, it force-kills a whole process tree, so
  a Quit landing in that window killed both, taking the handover of your running dev servers with
  it. Neither `detached: true` nor `.unref()` removes a child from its parent's tree on Windows,
  which is exactly why the shared launch helper exists; the relaunch simply never used it.
  Measured directly: with the old spawn the replacement dies to a tray-style tree-kill, with the
  new one it survives.
- **The relaunch now survives Windows throwing away the environment.** That launch helper hands
  the process off to Windows' own process-creation service, which does not pass on environment
  variables, and the port, the "you are the replacement" signal and the list of dev servers to
  bring back up were all environment variables. All three now travel as command-line arguments,
  which that service does deliver, with the environment kept as a fallback for macOS and Linux.
  Because any argument at all used to mean "this is a command-line invocation, print something and
  exit", the daemon now recognises its own three flags first; anything else still reaches the CLI
  exactly as before.

## [0.8.6] - 2026-08-15

### Fixed

- **An applied update no longer takes DevWebUI down, and no longer leaves your dev servers down with
  it.** On a downloaded release build, installing an update stopped the daemon and started nothing
  in its place. The relaunch built its successor's command from `process.argv[0..1]`, which is the
  runtime and the script in a source checkout but, inside a compiled single-file executable, is a
  placeholder pair pointing at a virtual path that exists only inside the running binary. Respawning
  it fails immediately, and on the machines a compiled release exists for (no runtime installed,
  which is the entire pitch) the command cannot resolve at all. Nothing caught it, because the
  failure is in the child: the spawn call itself succeeds, so the guard that exists precisely to
  never shut down without a successor saw one and stepped aside, taking the running-process handover
  with it. The one function whose whole job is answering "what command relaunches this build?"
  already existed and was already correct for the CLI and desktop shortcuts; the relaunch just never
  called it. The update was always written to disk correctly, so an install on an older build
  recovers the moment you start it again, and this is the last time it will need to.
- **An update no longer moves the daemon to a different port and kills the tab you had open.** The
  successor derived its port from the configured preference rather than from the port its
  predecessor was actually serving on, and those diverge for good the first time anything else holds
  the preferred one. It therefore waited out its full 8-second handoff timeout on a socket nobody
  was going to release, then bound that port instead of the one your browser was talking to, so the
  open GUI's event stream died against a daemon that was otherwise perfectly healthy. It is now
  handed the bound port, so the wait applies to the socket actually being freed and a daemon that
  has hopped once stays where it is across updates.

## [0.8.5] - 2026-08-11

### Fixed

- **Tooltips are reachable on a phone.** Reka UI ignores touch pointers on hover, so on a touch-only
  device every tooltip here was dead. Worst of all the info icons: a settings description lives
  behind that icon and nowhere else, so on mobile the text simply did not exist. Info icons now
  disclose on a single tap and close on a tap outside, a second tap, or a scroll. Every other
  tooltip opens on a press-and-hold, so a plain tap still runs the control's action exactly as
  before, and the click ending a hold is swallowed so nothing fires behind the tooltip. Sliding a
  finger abandons the hold, leaving scrolling alone. Mouse and pen behaviour is untouched: the
  gestures key off the event's own pointer type, not a device media query, so a touchscreen laptop
  keeps hover and merely gains them. From the shared UI kit; reported against RepoYeti as
  [#16](https://github.com/LunarWerxs/RepoYeti/issues/16).

## [0.8.4] - 2026-08-11

### Added

- **You now hear about updates without opting into installs.** The update check only ran when
  unattended auto-apply was switched on, so with it off (the default) nobody was ever told a new
  version existed. The check now always runs; an available update shows a banner in the web UI
  with a one-click "Update now" wired to the existing apply path, and the new `updateNotify`
  setting (on by default) controls the announcements. Unattended auto-apply itself is unchanged
  and stays opt-in. Part of the same policy RepoYeti and ReDesign follow as of today.

## [0.8.3] - 2026-08-10

### Added

- **Anonymous install ping**, folded into the existing update check
  (`GET /api/updates`) for free instead of an extra network call: a random
  per-install id plus your app version and OS family, so we know roughly how
  many installs exist. Never sends host, username, path, account info, or
  your IP. Opt out with `DEVWEBUI_NO_PING=1` (the older
  `DEVWEBUI_PULSE_DISABLE=1` / `CONNECTIONS_PULSE_DISABLE=1` still work too);
  already off automatically in dev/test/CI. Full detail in the README's
  Local-first section.

### Changed

- **Retired the dormant pulse machinery** (`POST /api/pulse`, the
  `app_opened` client ping) end to end. It only ever fired at
  `DEVWEBUI_PULSE_URL`, which nothing has ever set, so it was pure dead code
  now superseded by the install ping above. The install id itself survives:
  it reuses the existing `pulseInstallId` settings slot rather than minting
  a second one.

## [0.8.2] - 2026-08-10

### Added

- **A Windows download that can show a system-tray icon.** The new
  `devwebui-windows-x64-with-tray.zip` bundles the same executable with the `misc\` tray toolkit.
  DevWebUI draws no tray icon itself, a small separate launcher does, so a release download could not
  have one however its settings were set, and the script that sets it up was reachable only from a
  clone. Grab that zip, run `misc\Create-Shortcut.ps1` once, and launch from the shortcut. The
  plain zip is unchanged: it is the automatic updater's transport and stays a single file.

### Fixed

- **The tray icon survives an Explorer restart.** When the Windows shell restarts it destroys every
  tray icon and expects each app to add its own back. The launcher never listened for that, so the
  icon vanished for the rest of the session while the app kept running normally, and relaunching
  the shortcut only reopened the UI.
- **A tray icon that fails to appear at startup now retries instead of giving up.** The launcher
  assumed its first attempt had worked; if it had not (most often because the taskbar did not exist
  yet, on a launcher started at logon), nothing ever tried again.

## [0.8.1] - 2026-08-09

### Security

- **Hardened how DevWebUI launches detached processes on Windows.** The fallback path used by
  desktop shortcuts and the auto-update relaunch handed its command line to `cmd.exe`, which
  re-parsed `&`, `|` and `^`. Those are legal in Windows paths, so a repo or profile folder
  containing one was re-split by a second parser on its way to the process launcher. The
  fallback now passes an argument array straight through with no shell in the middle. Shared
  with the other LunarWerx apps; DevWebUI had been running behind that fix.

## [0.8.0] - 2026-08-09

### Security

- **The daemon only binds to `127.0.0.1`.** It previously bound `0.0.0.0`, so it was reachable by
  anything else on the same network, not just the local machine.
- **The auto-updater verifies `SHA256SUMS.txt` before extracting or executing anything from a
  downloaded release.**

### Added

- **The GUI can search logs, including on-disk log history**, not just the in-memory buffer.
- **A config-drift badge.** If a project's `.devwebui` file changes on disk while its processes are
  running, DevWebUI now holds the running configuration and flags it (`configChanged`) instead of
  silently relaunching the server on the new command; the badge tells you a reload is waiting and
  lets you take it.
- **Name search**, plus confirmation prompts for stop-all and shutdown, and a re-runnable autostart
  take-over action.
- **New test coverage:** HTTP routes, MCP tools, autostart take-over, `.devwebui` file-store
  integrity, updater checksum verification, and the daemon's bind address.

### Changed

- **Adding or cloning a project no longer auto-runs its commands on first load.** Registering a new
  project used to start it immediately; it's now added inert like any other project.
- **`update_process` merges instead of overwriting.** Omitting an optional field from an
  `update_process` call now leaves the existing value alone rather than clearing it.
- **`.devwebui` writes are atomic and preserve unknown keys.** Saves go through a temp file plus
  rename, and any hand-added keys the schema doesn't know about survive a round-trip instead of
  being dropped.
- **Auto-update relaunches resume whatever was running before the update.**
- **Port-conflict probing pauses when nothing is running and no client is connected**, instead of
  polling in the background for no one.

### Fixed

- **Crash handlers no longer orphan managed child processes.** They now kill the whole managed
  process tree instead of leaving it behind.
- **Log vault files are deleted when a project is removed**, instead of being left on disk.
- **`bun install` works again on a fresh machine.** The repo's `bunfig.toml` no longer forces Bun's
  isolated linker and global store, which had been breaking CI and release builds on machines that
  didn't already have that store set up.

## [0.7.0] - 2026-08-06

### Added

- **The tray menu can stop every managed process.** Right-click the tray icon and pick
  **Stop all processes** to halt every dev server DevWebUI runs, without opening the dashboard.
  It calls the same route as the dashboard's Stop all and `devwebui stop-all`, so it stops the
  servers and leaves DevWebUI itself running; Restart and Quit still act on DevWebUI.

### Changed

- **Inter is served by DevWebUI, not fetched from the Google Fonts CDN.** The shared kit's base
  stylesheet opened with an `@import` of `fonts.googleapis.com`, and a remote `@import` at the head
  of a render-blocking stylesheet blocks first paint on a round trip to the internet. Free on a warm
  HTTP cache, which is why it went unnoticed, but dead time on a first run or after a cache
  eviction, and an outright stall with no network, on a local dashboard that otherwise never needs
  to be online. The two Latin subsets of Inter's variable woff2 now ship under `web/public/fonts/`.
  Same typeface, no flash of fallback text, and the dashboard renders offline.

### Fixed

- **A busy port could be reported as having no owner on Windows.** `portOwners()` shells out to
  PowerShell for Get-NetTCPConnection + Get-CimInstance, and the shared capture helper bounded that
  at 5 seconds while RESOLVING WITH WHAT IT HAD on expiry rather than reporting a timeout. Starting
  a PowerShell and making it autoload NetTCPIP and CimCmdlets is ~1.5s warm but goes well past 5s
  cold, so the probe returned an empty string, `portOwners()` returned no owners, and a port that
  was plainly occupied looked free. `diagnose()` then downgraded a straightforward port-in-use
  crash to "low confidence, cause unknown" - the exact case the heuristic exists for, failing
  precisely when the machine is busy enough to make port conflicts likely. The Windows probe now
  gets 20 seconds, because here a slow answer beats a confidently wrong one.
  - This is what had CI red on `windows-latest` on `main` since 2026-08-03: both port tests were
    landing at ~5010ms, i.e. exactly the internal timeout. The two tests that reach this path also
    now carry explicit timeouts of their own, since the call they make can legitimately outlast
    bun's 5s default.

### Internal

- **CI and Release can be dispatched manually.** GitHub's standard mitigation for an Actions
  incident is to throttle webhook triggers, which means a push lands on `origin` and no workflow run
  is ever created: nothing goes red, there is simply nothing, and a release stalls waiting on a run
  that will never exist. `workflow_dispatch` is not throttled alongside the webhooks. Release's
  publish job is additionally gated on `github.ref_type == 'tag'` rather than on the triggering
  event, so dispatching against a tag ref publishes for real and no dispatch can ever publish for
  the wrong one.

## [0.6.1] - 2026-07-26

### Added

- **Table rows now explain why they are dimmed.** A server excluded from autostart was signalled
  only by a faded row, which read as an unexplained rendering quirk rather than a setting. Those
  rows now carry a power-off indicator beside the name; hovering it states what the dimming means
  and where to toggle it. The card view already showed this as a switch, so only the table needed it.

### Changed

- **`check:i18n` now fails on catalog keys nothing renders.** Its three guarantees become four:
  alongside "every referenced key exists", every key must also be referenced. Dead copy used to
  accumulate silently whenever a component dropped a control, and each stale line still costs a
  translator a line to translate. Detection stays exact only while keys are static literals, which
  the existing `dynamic-key` rule already reports; if a dynamic key ever appears, unused keys
  degrade to warnings rather than failing the build on something the scan cannot see.
- **Removed 31 unused strings from the English catalog** (384 keys down to 353), including the
  filter panel's retired sort controls, the process table's removed inline switch, and stale cloud
  sync and settings copy. Nothing rendered any of them.
- **Windows releases are self-contained GUI executables.** The dashboard is embedded, the
  executable carries the app icon and opens without a console window, and the updater continues
  to consume the compact ZIP rather than requiring loose `web` or `node_modules` folders.
- **Connections sync uses the multi-device-safe 1.2 engine.** First-time seeding is atomic, nested
  edits preserve unrelated remote preferences, and shutdown gets five seconds to flush before a
  stuck token or network request is cancelled.

## [0.6.0] - 2026-07-24

### Added

- **Folders and `.devwebui` files can be opened directly.** The new `devwebui open <path>`
  command is the drag-and-drop entry point used by the Windows launcher. A dropped folder is
  scanned for configured or detectable projects; new projects are registered, while dropping an
  already-registered project starts it.
- **Runtime selection now follows each project's lockfile.** With the global runtime set to
  `auto`, Bun lockfiles select Bun and npm, Yarn, or pnpm lockfiles select Node. An explicit
  per-process runtime remains the highest-priority override.
- **Project configuration reloads live.** Changes to a registered project's `.devwebui` file are
  detected and applied without requiring a daemon restart.

### Changed

- **Plain Bun, Node, and executable commands start without a permanent shell wrapper.** Commands
  that need shell syntax or a `.cmd`/`.bat` shim still use the shell, while safely tokenizable
  executable commands launch directly. This removes the extra `cmd.exe` process previously shown
  for every compatible managed server on Windows.
- **Machine scanning is quieter after setup.** A new installation performs one discovery scan so
  the first dashboard is useful, then leaves automatic startup scans disabled unless the user
  explicitly enables them.
- **High-volume logs use bounded batching.** Live log rings, SSE delivery, and disk persistence
  now trim and flush per batch instead of repeatedly shifting arrays or performing a synchronous
  append for every child-output event.

### Fixed

- **The live error feed matches the current-process view.** Errors from an earlier daemon session
  or an older run no longer reappear through SSE after the snapshot and HTTP views have filtered
  them out.
- **Updater integration tests use the actual runtime executable.** This keeps JavaScript arguments
  intact on Windows installations where `bun` on `PATH` is an npm command shim.
- **Project watching no longer depends on `fs.watch` supplying a filename.** Events from platforms
  that omit it still trigger the configuration re-check.
- **Daemon restarts keep a healthy instance available.** Instance probing retries transient
  failures, and tray health checks require consecutive failures before treating the daemon as
  dead.

## [0.5.4] - 2026-07-16

### Fixed

- Align shutdown coverage with the hardened loopback-origin gate, which now protects both GET and
  mutating daemon requests.

## [0.5.3] - 2026-07-16

### Added

- Add measured first-run dashboard sizing to cold tray launches.
- Adopt the shared loopback request guard and cover it with cross-platform tests.

### Changed

- Increase the real-Git updater integration timeouts to tolerate cold Windows process startup.

## [0.5.2] - 2026-07-16

### Fixed
- **Resizing a launcher window now sticks.** Chromium stores a saved placement whose key
  contains a dot - every focus window's does, the process id is `<projectId>.<localId>` - 
  as nested dicts, not under the flat key, so the kit's "has the user sized this window?"
  probe never saw launcher placements and `--window-size` kept overriding the user's
  resize on every fresh launch. The probe now reads both storage forms (and ignores
  degenerate zero-area rects), and the size hint carries the user's saved size to
  forwarded launches, so a resized launcher keeps its size in every launch path.
- **A maximized window stays maximized.** Chromium stores `maximized: true` on the saved
  placement with the rect holding the pre-maximize *restore* bounds; the size hint would
  have resized a deliberately maximized window back down to those bounds on its next
  open. A maximized placement now sends no hint at all - fresh launches restore the
  maximized state natively.
- **"Open dashboard" can't spawn duplicates, and corrected windows stay on-screen.** The
  launcher's dashboard button now ignores re-entry while a request is in flight (a fast
  double-click used to open two dashboard windows), and after the page applies a size
  hint it clamps the window back inside its monitor's available area - a forwarded
  launch inherits the launcher's position, so growing from a corner could push most of
  the window off-screen.

## [0.5.1] - 2026-07-16

### Fixed
- **The launcher's "Open dashboard" button opens a real dashboard window, not a 440x220 one.**
  It used to navigate the launcher window itself to `/`, cramming the full dashboard into the
  launcher's mini-viewer geometry with zero room for any rows. It now asks the daemon to open `/`
  as its own portable window - its own first-run size, its own remembered geometry, zero
  interference with the launcher's - and closes the launcher; if no Chromium can be spawned it
  falls back to the old in-place navigation so the button is never a dead end. The dashboard's
  first-run size is a measured 840x760 (the layout caps content at 800px, so wider is dead
  margin; 13 process rows visible), joining the launcher's measured 440x220.
- **Portable windows opened while another one is already up now get their intended size.** A
  forwarded `--app` launch into a running Chromium instance ignores both `--window-size` and the
  window's own saved placement - it just inherits the existing window's geometry (verified,
  Edge 150). That made "Open dashboard" produce a launcher-sized dashboard even with a first-run
  size in place, since the launcher is by definition running when you click it. The daemon now
  tags each portable window's URL with the size it should have (the user's remembered size when
  one exists, the measured first-run size otherwise) and the page corrects itself once with
  `window.resizeTo` - queries are not part of Chromium's geometry key, and a page-initiated
  resize saves onto the window's own slot, so the hint can't disturb any other window.

## [0.5.0] - 2026-07-16

### Added
- **Desktop shortcuts for one server (or a whole repo).** The process ⋮ menu gains **Add desktop
  shortcut**; the project ⋮ menu gains the same for every process in the codebase. Double-clicking
  the `.lnk` boots the daemon if it isn't running, loads the project if it isn't registered, starts
  the process - bringing up its `links` group and the project's companions, since it goes through
  the ordinary start action - and opens a small focused window showing just that server: status,
  metrics, logs, and a Stop button. No console flash (the shortcut runs through `wscript.exe` and a
  generated launcher), and clicking it twice is a no-op rather than a restart. Windows only;
  elsewhere the action reports that instead of failing. Backed by new
  `POST /api/processes/:id/shortcut` and `POST /api/projects/:id/shortcut` endpoints, plus the
  `create_process_shortcut` / `create_project_shortcut` MCP tools (now 31 total).
- **The compiled binary is now also the CLI.** `dist/devwebui.exe` previously only booted the
  daemon, so a portable install had no command line at all and nothing for a shortcut to invoke.
  Any argument now dispatches to the CLI (`devwebui.exe status`, `… start-process web`, `… mcp`),
  while a bare launch still boots the daemon exactly as before. Two new verbs, `open-process` and
  `open-project`, are what the shortcuts run.

### Fixed
- **A managed server no longer pops a console window.** Every dev server is spawned through
  `cmd` (`shell: true`) but without `windowsHide`, so whether a console appeared depended on the
  console the daemon itself happened to own - invisible under the tray (which starts the daemon
  with `CreateNoWindow`, and children inherit that headless console), but a desktop shortcut boots
  the daemon detached with *no* console, and Windows then gave each dev server a brand-new console
  of its own. With Windows Terminal set as the default terminal that surfaced as a real window that
  stayed up for the life of the server. The spawn now sets `windowsHide` so the result is the same
  on every launch path. `cli.ts`'s daemon boot states it too, so "no window" survives someone
  dropping `detached`.
- **The shortcut's focus window opens small, and remembers the size you give it.** It never passed
  a size, and Chromium's default for a window it has never seen is roughly the whole work area
  (~1905x2092 on a 4K display) - so "a small focused window" was neither small nor sized. It now
  opens at a first-run size measured to fit the card exactly, and yields to your own resize
  afterwards (Chromium persists a manual resize but not a `--window-size`, which is what makes
  "small by default, yours once you touch it" work rather than fighting you every launch).
- **The focus window reads as a launcher, not a shrunken dashboard.** It reused the dashboard's
  full-size ProcessCard, so a small window just clipped a big card: label-above-value metrics
  three rows tall, plus star / enable / edit / engine-chip / overflow controls that a launcher has
  no use for. ProcessCard gained a `compact` density (the same component - status, logs, metrics
  and Start/Stop must never fork into a launcher copy that drifts) which tightens the type and
  spacing, folds the metrics into one icon+value line, and drops the config-only affordances. The
  window hugs the result at 440x220 instead of 520x300.
- **`devwebui start` from the compiled binary.** It hardcoded a spawn of `bun server/src/index.ts`,
  a path that doesn't exist outside a checkout. Daemon launches now resolve the right vector for the
  build they're running in.
- **Restarting the daemon no longer hops it off its own port.** The chromeless window the shortcut
  opens was launched via `cmd /c start ""`, whose `CreateProcess` inherits the parent's handles - 
  including the daemon's listening socket. The browser then pinned the daemon's port for as long as
  its window stayed open, so a restart (or auto-update relaunch) found the port still held by the
  dead daemon's ghost socket and moved to the next one. The launch now goes through WMI
  (`Win32_Process.Create`), where the service creates the process and it inherits nothing of ours - 
  still fully detached from the daemon's tree, but no longer holding its socket.

### Changed
- **The focus view moved from `/?process=<id>` to `/focus/<id>`.** Chromium keys a saved app-window
  placement by host + path only - the query string isn't part of it - so every focus window and the
  dashboard shared one `localhost_/` geometry slot: no focus window could keep its own size, and
  resizing one silently resized the others. A path per process gives each window its own remembered
  geometry. Nothing on disk needs migrating (a `.lnk` stores `open-process <file> <id>`, never a
  URL), and the old query form still renders for a window or bookmark left on it.

## [0.4.0] - 2026-07-13

### Added
- **Edit project (rename + accent color).** The project ⋮ menu gains an **Edit project** action that
  opens a small dialog to rename the project and pick an accent color - shown as a tint on the
  project's stacked-servers icon in the panel header. Project color is a new optional top-level
  `color` field in the `.devwebui` file (any CSS color string; the picker writes `#rrggbb`, and
  clearing it falls back to the theme accent). Renaming or recoloring rewrites the file in place and
  never restarts running servers. Backed by a new `PUT /api/projects/:id` endpoint.
- **MCP server: 11 new tools (now 29 total).** The MCP server gained the config-editing and
  observability tools it was missing, so an agent can do what the GUI can - not just start/stop.
  New: `update_project` (rename/recolor), `add_process`, `update_process`, `remove_process`,
  `set_process_starred`, `start_project` / `stop_project` (transient, distinct from
  enable/disable), `free_port`, `get_log_file` (tail the persisted rotating log), `scan_projects`,
  and `clone_project`. Native file-picker dialogs are intentionally excluded (they can't run
  headless). `AI_GUIDE.md`'s tool reference was updated to match.

## [0.3.0] - 2026-07-13

### Changed
- **Brand tray/taskbar icon regenerated** from the current stacked-servers vector (the shipped
  `misc/DevWebUI.ico` had drifted to a generic placeholder). A new `misc/Make-Icon.ps1` rebuilds
  it from the committed `misc/DevWebUI-icon.png` master (re-rendered from `web/public/icon.svg`),
  matching the sibling apps' icon-generator convention; the web `favicon.ico` was refreshed too.
- **Settings split into tabs.** The settings panel now groups its sections under three tabs
  (General / Servers / Projects) instead of one long scroll, using the shared kit's new
  segmented tab bar. General holds appearance, app updates, resource monitoring, and cloud
  sync; Servers holds the start-behavior knobs plus the portable-window / link-host group;
  Projects holds scanning. Save/Cancel stay visible on every tab and still apply the whole
  form at once.

### Added
- **Linked servers.** Two new optional per-process fields in the `.devwebui` schema. `links` names
  sibling process ids that act as one unit: the relationship is symmetric and transitive, so
  starting or stopping any member of a linked group (GUI single-process actions, or MCP
  `start_process` / `stop_process`) starts or stops the whole group. `companion: true` marks a
  process (a shared database or proxy, say) that starts whenever any other process in the project
  is started individually; companions are never stopped by group propagation. Neither affects
  autostart, "start project"/"start all", or restart. Both live in the process edit dialog (a
  linked-servers picker and a Companion toggle), and persist in the `.devwebui` file. When an
  action ripples to other servers, the GUI shows an "Also started/stopped: …" toast, and the
  HTTP/MCP response lists the affected ids (`coStarted` / `coStopped`).
- **Portable window mode.** A new Settings → Open in browser → "Portable window" toggle opens
  DevWebUI in its own chromeless Chromium app window (`msedge`/`chrome --app=`, no tabs or
  address bar) instead of a normal browser tab. Turning it on immediately opens the app window
  (`POST /api/portable-window`); the desktop launcher/tray follows the same setting on its next
  Open/double-click/launch, falling back to a normal tab when no Edge or Chrome is installed.
  The window uses a dedicated Chromium profile (`~/.devwebui/portable-profile`) shared by both
  open paths, so it remembers its own size and position across launches instead of sharing the
  main browser profile.

## [0.2.0] - 2026-07-09

Release-readiness audit: makes a public `bun install` (no private LunarWerx registry access)
boot cleanly, clarifies what "Sign in with Connections" actually does, and cleans up some
internal duplication.

### Changed
- **Sign in with Connections now uses the official `@cnct/connect` / `@cnct/locker` SDKs**
  instead of a hand-rolled client. Both are optional dependencies that are only ever loaded
  (via dynamic `import()`) when you actually use sign-in - so installing DevWebUI without
  access to the private LunarWerx package registry still boots the daemon cleanly; sign-in
  simply reports itself unavailable instead of crashing anything.
- Existing sign-ins are migrated to the new SDK's token storage automatically on first boot
  after upgrading - no need to sign in again. "Forget" now also revokes the credential with
  the server, not just locally.
- **README clarifies the one optional, off-by-default thing that ever touches the network:**
  settings sync, which requires explicitly signing in with a Connections account.
- **README rewritten for humans**, with real screenshots (dashboard, live logs, de-duplicated
  error log, light theme) and a release badge; the full 17-tool MCP list moved to `AI_GUIDE.md`.
- **Release notes come from the CHANGELOG** (the tagged version's section) rather than an
  auto-generated commit list; dropped a redundant `bun install` in `release.yml`.
- The `bun` workspace was internally renamed from `devdeck` to `devwebui` to match the
  product name (no user-visible effect).

### Fixed
- `/oauth/login` now redirects back to the app with an error instead of returning a server
  error (HTTP 500) when the sign-in machinery isn't available.
- **CI is green again.** `bun run lint` (Biome) had been failing on pre-existing format drift plus
  two `noExplicitAny` warnings in `tests/auto-update.test.ts` (the fixtures are now typed as
  `UpdateStatus` / `UpdateApplyResult`). Bumped `actions/cache` + `actions/checkout` to clear the
  Node.js 20 deprecation warning, and fixed the `release.yml` "stage binary" step that failed on
  Linux/macOS (`ls` of a per-OS path under `set -e -o pipefail`).

### Internal
- De-duplicated several bits of internal logic that had drifted into multiple copies: the
  helper that captures a spawned process's stdout, the shared log-line cap constant, the
  error-event type, and the file-store path normalizer.
- The settings sync UI now cleans up its background refresh timer when it's closed, and the
  in-memory log buffer trims old lines more efficiently (O(1) instead of shifting an array).
- Removed lingering references to the private internal kit-repo name from source comments.

## [0.1.0] - 2026-07-06

First public, open-source release.

### Added
- **`devwebui` CLI.** A single installable command (new `bin`) so humans, scripts, and AI agents
  can run and drive DevWebUI without `bun run <script>` or raw HTTP/MCP: `devwebui start`
  (boots the daemon detached and prints the URL; `--foreground` runs it attached, `--port N`
  pins the port), `devwebui stop` (graceful shutdown), `devwebui status [--json]` (running? where?
  + a project/process summary), `devwebui list`/`ps` (managed processes), `devwebui start-process` /
  `stop-process` / `restart-process` / `enable-process` / `disable-process <id|name>`,
  `devwebui start-all` / `stop-all`, and `devwebui mcp` (the stdio MCP server). It's a thin wrapper
  over the daemon's existing REST API + `instance.ts` discovery (`shared/routes.ts`) - no new
  control logic. Lives in `server/src/cli.ts`.
- **Open a dev server from its title.** Click a running process's name (card or table
  view) to open it in a new browser tab. By default it opens the port-derived
  `http://<host>:<port>` (the host is configurable - see below); a new optional per-process
  `url` field overrides it - an absolute `http(s)://…` opens verbatim, or a path like
  `/admin` is appended to that address. The title is only a link while the process is
  running, and `url` is editable from the Add/Edit process form.
- **Configurable link host** (Settings → *Open in browser*, persisted as `linkHost`). By
  default a process opens on the host you're viewing DevWebUI from (so `localhost` on your
  own machine, the LAN IP from another device); set an explicit host to pin it, e.g. a fixed
  dev-box hostname. A per-process absolute `url` still overrides the host entirely.
- **Server-owned scan presets** (`startup` / `quick` / `deep` / `scoped`) - call sites
  ask for an intent instead of repeating raw depth/budget/limit numbers.
- **Internationalization (i18n).** The web UI is now fully localized with
  [vue-i18n](https://vue-i18n.intlify.dev/). English is the base catalog
  (`web/src/i18n/locales/en.ts`); every user-facing string - including
  accessibility labels, placeholders, and tooltips - is routed through `t()` /
  `<i18n-t>`. See `web/src/i18n/README.md`.
- **Language picker** in Settings → *Language* - driven by the locale registry and
  persisting the choice. It stays hidden while English is the only registered locale,
  so it appears automatically the moment a second language is added.
- **i18n compliance checker** (`bun run check:i18n`, also gates `bun run build`).
  Fails the build on any hardcoded UI string, any `t()` key missing from the base
  catalog, or any locale that drifts from the English key shape.
- **Sponsor credit** - a subtle footer line crediting
  [LunarWerx Studios](https://lunarwerx.com/).
- **MIT `LICENSE`** - DevWebUI is now open source.
- **Launcher guard tests** (`tests/launcher.test.ts`, via `bun test`) - fail unless the
  one-click launcher is intact: the shortcut machinery (`Create-Shortcut.ps1`,
  `DevWebUI.vbs`, `DevWebUI-Tray.ps1`, `DevWebUI.ico`) exists, is committed, and is wired
  shortcut → wscript → vbs → tray → daemon + icon. On Windows it also runs the tray's new
  headless `-SelfTest` (bun on PATH + daemon entry + the icon actually loading into a
  `NotifyIcon`) and regenerates + resolves the root shortcut.

### Changed
- **Single instance.** Only one DevWebUI daemon runs at a time. On launch it checks the
  runtime pointer (validated with an `/api/health` probe) and, if a daemon is already
  serving, prints where it's running and exits instead of starting a second one - across
  every entry point (tray, `bun run daemon`, `bun start`, `bun run dev`). A `--watch`
  reload of the dev daemon is exempt so hot-reload still rebinds cleanly.
- **Daemon survives a busy port.** On launch the daemon prefers its configured port but,
  if it's taken, steps to the next free one instead of crashing on bind - the same
  courtesy it already gives the dev servers it manages. The port it actually bound is
  written to `~/.devwebui/runtime.json`; the tray launcher reads that (validated with an
  `/api/health` probe) to open the right URL and to detect an already-running instance,
  `bun run dev` reserves the port up front so the Vite proxy follows the daemon, and the
  MCP client falls back to that pointer so agents reach a hopped daemon without any manual
  `DEVWEBUI_URL`.
- **Scan notifications say what they found.** The "found new projects" notification now
  lists each project (name, path, process count) instead of just a bare count, and
  **"Review & add" no longer clears it** - a scan notification is removed only when you
  explicitly Dismiss or Clear it, so a mis-click never loses the find.
- **Shared contract (`shared/`).** Cross-boundary DTOs, REST route definitions, daemon
  constants, and the `.devwebui` Zod schema now live in one `shared/` module that the
  daemon, the MCP client, and the web GUI all import - so types, routes, and the file
  schema can no longer drift between surfaces. The schema is the single source of truth
  (the web infers its types from it; zod stays out of the browser bundle).
- **Async, package-backed detection.** Project-scaffold detection moved off the HTTP
  hot path (async `fs/promises`, no event-loop-blocking tree walk), and the bespoke
  workspace-glob / package-manager / pnpm-yaml parsing was replaced with `tinyglobby`,
  `package-manager-detector`, and `yaml`.
- **Tidier HTTP layer.** Repeated request-body parsing, error responses, and
  project-lookup checks in the daemon's routes were factored into small shared helpers
  (identical responses, less boilerplate).
- **Safer "Free port".** Freeing a process's port now stops a DevWebUI-managed holder
  cleanly and, for *external* processes, reports the owner (PID + name) and asks for
  explicit confirmation before killing only those PIDs - instead of blindly killing
  whatever held the port.
- **Log backpressure.** The daemon coalesces child output into batched SSE `log` events
  (and sheds the oldest under a flood) rather than fanning out one event per line.
- **Robust machine scans.** Scans are single-flighted and serialized (no overlapping
  broad-scan storms) and abort when the requesting client disconnects.
- **Hardened subprocess helpers.** Git clone and the native file/folder pickers now have
  timeouts, honour request-abort, bound their captured output, and clean up the partial
  folder a failed/aborted clone leaves behind.
- **Centralized daemon defaults.** The daemon port, MCP base URL, and log-buffer cap live
  in one place (`server/src/constants.ts`); the Vite proxy follows `DEVWEBUI_PORT`.
- **Header redesign.** The live/offline indicator moved to the left beside the
  logo and merged with the active-server count (`● Live · N of M active`).
- The card/table view switch and the sort & filter controls moved into the
  header's "⋮" overflow menu - view is a single split control (Cards | Table) and
  filters open in a focused modal.

### Fixed
- **CPU/memory now reflect the whole server, not its shell wrapper.** Managed
  processes are spawned with `shell: true`, so the pid we hold is the OS shell
  (cmd.exe on Windows), not the real Node/Bun server - which lives in a child. The
  sampler used to read only that wrapper, reporting ~8 MB and ~0% CPU for a server
  actually using 50–200 MB. It now sums the entire descendant process tree
  (`metrics.ts`): on Windows via an in-process `CreateToolhelp32Snapshot` (still no
  spawning), and on the `pidusage` fallback by expanding the subtree first. Covered
  by `tests/metrics.test.ts`.

### Internal
- **End-to-end type checking** - `bun run typecheck` runs `vue-tsc` over the web app
  and `tsc` over the server (previously only the web build was type-checked).
- **Biome** for linting + formatting (`bun run lint` / `bun run format`), tuned to the
  existing style; `.vue` template-blind rules, the generated `ui/` primitives, and
  static assets are scoped out.
- **Expanded unit tests** - pure logic for the link/URL builder, process sort/filter,
  port helpers, and the `.devwebui` schema (`bun test`, 13 → 34 tests).
- **CI** - a GitHub Actions workflow runs install, lint, typecheck, build, and tests on
  every push to `main` and every pull request.
- **Smaller modules** - the log-backpressure batcher (`log-buffer.ts`) and the
  `ProcessView` projection (`process-view.ts`) were split out of `manager.ts`, and the
  drag-drop helpers (`lib/drop.ts`) out of the Add-Project dialog.
- **Dependencies refreshed to latest** - Vite 8, TypeScript 6, vue-tsc 3,
  `@vitejs/plugin-vue` 6, concurrently 10, `@types/node` 26, plus assorted minors;
  CI's `actions/checkout` bumped to v5 (clears the Node 20 deprecation). `baseUrl` was
  dropped from the web tsconfigs (deprecated in TS 6; `paths` resolves without it).
  `zod` is intentionally held at 3.x - `@modelcontextprotocol/sdk` is not yet
  zod-4 compatible, so bumping it would break the MCP server.

[Unreleased]: https://github.com/LunarWerxs/devwebui/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/LunarWerxs/devwebui/compare/v1.0.0...v1.1.0
[0.8.8]: https://github.com/LunarWerxs/devwebui/compare/v0.8.7...v0.8.8
[0.8.3]: https://github.com/LunarWerxs/devwebui/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/LunarWerxs/devwebui/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/LunarWerxs/devwebui/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/LunarWerxs/devwebui/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/LunarWerxs/devwebui/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/LunarWerxs/devwebui/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/LunarWerxs/devwebui/compare/v0.5.4...v0.6.0
[0.5.4]: https://github.com/LunarWerxs/devwebui/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/LunarWerxs/devwebui/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/LunarWerxs/devwebui/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/LunarWerxs/devwebui/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/LunarWerxs/devwebui/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/LunarWerxs/devwebui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LunarWerxs/devwebui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LunarWerxs/devwebui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LunarWerxs/devwebui/releases/tag/v0.1.0
