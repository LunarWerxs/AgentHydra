# Native control of Claude Desktop chats

Investigation: 2026-09-19, installed Claude Desktop **2.2553.1**. Nothing in the
code is pinned to a Claude release any more: on 2026-09-22 the version, the two
bundle chunks and the executable hashes all became things AgentHydra derives from
whatever is installed, because pinning them stopped every native-control instance
on the day Claude updated (2.2553.13, the first build that runs Opus 5.5, did
exactly that). Bundle names quoted below are examples from a specific build, never
values the code looks for. What replaced the pins is structural, in
[Managed launch](#managed-launch-and-ashley-production-proof).

Scope: moving, archiving and migrating **Code** chats between desktop instances.
Message delivery is outside this work.

## Operating instructions for agents

Use AgentHydra's production native route for archive and migration-source cleanup before
considering Lua, sidebar menus or UIA. The archive and migration scripts already do this;
the POC runner is for diagnostics and bounded experiments, not the general move API.

1. Resolve the intended account to its exact full profile path with
   `GET /api/instances` or `/api/instance-numbers/resolve?ref=<reference>`. Read current
   `GET /api/claude-native/settings`; do not infer settings from historical test accounts.
2. For a profile that should start native control automatically, save
   `{"profile":"<full Windows profile path>","config":{"port":19315,"mode":"native-only","launchDebugger":true}}`
   with `PUT /api/claude-native/settings`. Preserve an existing port; otherwise choose an
   unused configured port. The API rejects duplicate ports and the launcher rejects an
   occupied listener. Settings are per profile; newly created profiles need their own opt-in.
3. Open a closed profile through AgentHydra's Open action or
   `POST /api/instances/<URL-encoded full profile path>/open` when the task calls for opening
   it. The debugger starts automatically on that launch. Saving settings alone does not
   launch an app or activate a debugger inside an existing process. Do not restart active
   desktops or click Developer menus to force activation.
4. Archive through the production archive script or
   `POST /api/sessions/<exact session ID>/desktop-archive`, with
   `{"archived":true,"instance_ref":"desktop:<full profile path>"}`. For moves, use
   `move_chat` / `move_chats` or the migration scripts; they verify destination landing
   before native source cleanup. General destination import/settings, unarchive and
   new/start/stop/resume are not fully converted to native control.
5. Verify the returned result. Native success has `route:"native"`, `ok:true` and
   `verified:true`; the desktop route also has an empty `uiArchive` list. `native-only`
   never falls back to disk/UI, even if the profile is closed or its inspector unavailable.
   A refused, malformed or unknown mutation result is terminal in either mode: inspect
   exact native state before any retry, never retry by a matching title.

`developer_settings.json` with `allowDevTools:true` only exposes the stock Developer menu.
It does **not** start the inspector and is **not required** by AgentHydra's managed automatic
launch. The central `launchDebugger` setting is what makes native control start on each
AgentHydra Open. Unsupported Claude updates are refused until reviewed; do not weaken the
version/hash guards to make one launch.

## AgentHydra settings

Open **Settings → General → Claude native control**, choose the desktop account,
and enable **Start debugger automatically**. Settings are saved per profile; the
panel lists all accounts with automatic startup enabled. The panel and the settings API
are authoritative for current configuration; the account examples below record past proofs.

Changes apply on the next **Open** through AgentHydra. Saving never launches or
restarts a running desktop. Switching automatic startup off retains the profile's
manual native connection and explicitly shows that state. **Use standard controls**
removes the profile's native configuration entirely and restores normal launching
and archive routing. Other accounts keep their own settings.

The panel states the supported Claude build and shows save/load errors. New
profiles receive an unused configured debugger port; existing port and routing
policy are preserved when changing automatic startup.

On 2026-09-19, all **14 then-closed Claude Desktop profiles** were configured with
`launchDebugger:true`, `native-only` and distinct ports, and their
`developer_settings.json` files were provisioned with `allowDevTools:true` for menu
availability. The three open profiles **#12, #38 and #56** were left unchanged. No
profile was launched or restarted during this rollout; all 14 remained closed.
This verifies saved configuration, not 14 successful startups: the full launch/archive
proof below was on Ashley #15. Evidence: `tmp/closed-claude-native-enablement.json`.

UI validation: nine helper/API tests, web typecheck, i18n and Biome checks passed.
The rebuilt UI was checked in a background browser against the running daemon;
Ashley was switched off/on and the saved configuration read back. Ashley stayed
closed, and the other configured profile was unchanged.

The checkout's existing TypeScript 7.0.2 / Vue tooling mismatch prevents the normal
web typecheck/build commands. This delivery used the already installed TypeScript
5.9.3 compiler explicitly for `vue-tsc` and registered it through
`vue/compiler-sfc.registerTS` before the Vite build. Dependency manifests, lockfile
and installed modules were not changed by this workaround.

## What the installed app supports

The app has native operations on its authoritative, in-memory Code session store:

| Operation | Installed implementation | Potential replacement |
| --- | --- | --- |
| Archive / unarchive | `claudeCodeSessionManager.archiveSession`, native `LocalSessions.archive` / `unarchive` | Sidebar selection, row menus and title-based Archive invocation |
| Set title / display metadata | `LocalSessions.updateSession` | Destination rename gestures and disk writes overwritten by app memory |
| Model / effort | Session manager `setModel` / `setEffort` | Destination picker gestures; availability and clamping must be checked |
| Set / read permission mode | `LocalSessions.setPermissionMode` / `getPermissionMode` | Destination permission-picker gestures |
| Read current sessions | `claudeCodeSessionManager.getSessionList` / `getSession` | Guessing visible application state from metadata files |

The internal MCP tools `archive_session`, `unarchive_session` and `set_session_title`
are Code-specific (`sessionType === 'ccd'`). They use the same session manager;
they are not the Cowork or web-chat store. Their native desktop IDs include
`local_` IDs and must not be confused with CLI transcript UUIDs.

Evidence in `resources/app.asar`:

- `index.chunk-DvmOmfFd.js`: exported `claudeCodeSessionManager` singleton.
- `index.chunk-Cd_DKFcM.js`: native Code IPC implementations.
- `mainView.js`: renderer preload API.
- `index.chunk-B-5-UF-d.js`: in-process SDK MCP session tools.
- `index.chunk-8cddiCms.js`: application menu and debugger entry point.

These names are version-specific. The adapter pins the reviewed version and both
bundle hashes and refuses a different build. A native live proof on **another_meh
(#8)** imported a disposable chat, restored its settings and archived it. See the
[results](CLAUDE-DESKTOP-POC-RESULTS.md) for timings and preservation checks.

## Connection requirement

The internal MCP servers run inside Electron/its SDK. They do not expose a public
HTTP endpoint. None of the four inspected running main processes had a TCP
listener. Preload IPC accepts the trusted application renderer, not an arbitrary
external process.

The app contains a supported **Developer → Enable Main Process Debugger** action.
It calls `node:inspector.open()` in the running process. The Developer menu is
gated by `allowDevTools` loaded from `developer_settings.json`, and by the app's
restricted-account policy. It was activated through the stock menu in #8 after
provisioning that closed profile's developer setting and launching it with the
user's authorization. #8 was closed after the proof.
It also opens Chrome's inspector page and defaults to port 9229, so multiple
profiles cannot all use that default simultaneously.

The file belongs to each profile (`app.getPath('userData')`); Claude has no global
fallback for it. AgentHydra's central automatic-launch setting is separate and does not
need this menu setting. The Developer-menu gate is cached at
startup. **Help → Enable Developer Mode** writes the setting and relaunches the
app, so it must not be used on active instances during migration. Provisioning
before the next ordinary launch avoids that interruption. The main window's
Developer menu, including its hidden shortcut, is omitted entirely when the
startup setting is false. Setting the file while that process runs does not add
the menu. Embedded preview/browser windows have a separate shortcut which can
reread the setting, but this is not a proved external connection or a general
bootstrap for an ordinary Claude window.

Enabling the setting does not start a debugger. The stock build has no discovered
persistent inspector-start setting or external command for its menu callback.
That does **not** mean a human must click the menu on every launch. The installed Electron fuses disable
`EnableNodeCliInspectArguments`, `NODE_OPTIONS`, and `RunAsNode`; adding
`--inspect` or `--inspect-brk` to AgentHydra's launch arguments cannot solve this.
No stock automatic activation path has been identified. AgentHydra now has an
opt-in managed-copy launcher that enables only `EnableNodeCliInspectArguments`
and starts the inspector from a launch flag. Full startup and native chat archive
were verified on Ashley #15; see the production proof below.

The native-only POC runner under `scripts/claude-native-poc/native-control.ts`
connects to an explicitly selected loopback inspector port and checks the PID
and full profile path. It never launches an instance or invokes a UI fallback.
Its native program requires the already-loaded manager in `require.cache` and
refuses a different app version or source hash. The live proof verified the
connection, native state, unchanged transcript bytes and before/after native
screenshots. Capturing those screenshots does not send window input or change
foreground focus.

A native bridge needs an enabled developer connection and verified per-instance
discovery. Launching stock Claude with a Chromium remote debugging port
is not a substitute: the installed app separately requires signed authorization
for that separate launch path. The Node-inspector copy proof did not use or alter
the Chromium remote-debugging authorization check.

## Automatic debugger bootstrap proof

On 2026-09-19, a separate copy of the installed executable was created under the
repository's ignored `tmp` directory. Exactly one byte changed: the Electron
`EnableNodeCliInspectArguments` fuse changed from disabled to enabled. All other
fuses, including ASAR integrity validation, stayed unchanged; app resources were
unchanged. The installed executable retained its original hash and valid signature.

Launching that copy with `--inspect-brk=127.0.0.1:19229` automatically opened the
Node inspector. Windows verified the exact copied executable, launch arguments,
PID **58504**, and listening socket ownership. A read-only inspector expression
returned Node **24.20.0**. No UI action or debugger resume command was sent. The
owned process was stopped immediately afterward.

This establishes **automatic inspector startup**, not complete application startup
or migration parity under a modified executable. At this early pause the usual
JavaScript `process.pid` / `execPath` properties were not initialized; identity was
therefore verified from Windows process and TCP-owner records. Two initial harness
attempts rejected that early runtime shape before the corrected successful probe.

The copy's Authenticode result was `HashMismatch`, as expected after modifying
signed bytes. This initial proof left full startup/profile/native-operation
verification outstanding. The managed launcher and Ashley proof below subsequently
completed those checks for the reviewed build. Changing the installed application's
signed executable in place is not required.

Evidence: `tmp/claude-bootstrap-copy-manifest.json`,
`tmp/claude-bootstrap-startup-result.json`, and `tmp/claude-bootstrap-cleanup.json`.
Final checks found no test process or listener. Automatic approval review rejected
deleting the copied files (`blocked by policy`), so the isolated copy remains in
`tmp/native-bootstrap-copy-2.2553.1`; no alternate deletion method was attempted.
Upstream references: [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
and [ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).

An empty test profile was launched with the setting provisioned before startup.
It exited cleanly before the debugger could be inspected. This proves neither
native connectivity nor archive/migration parity; no native mutation was tested.

## Required behavior

1. Verify the connected process PID and full `userData` profile path before any
   session operation. Match the desktop session ID and CLI lineage, never a title.
2. Resolve the already-loaded session-manager singleton. Do not create a second
   manager or treat an unknown app version as compatible.
3. A move must land and verify the destination first, preserve its history,
   title and settings, then archive only the exact source copy.
4. Pass `cleanupWorktree: false` when archiving a migration source. The native
   implementation otherwise may clean up the worktree. Inspect
   `archiveCascadeClosureOf` first and refuse unintended related-session changes.
5. Verify the result through the app's own session state and archive event/list
   update. Disk flags alone cannot prove that the running app removed a row.
6. Compare the other sessions' archive states before and after the operation.
   Any bystander change prevents a clean-success result.
7. Only `prefer-native` permits the existing guarded UI fallback after proven connection
   unavailability before dispatch. `native-only` refuses instead. An uncertain result after
   dispatch must be reconciled by native ID; do not retry it by clicking a matching title.
8. Native unarchive must cancel AgentHydra's existing archive reassert watcher
   before changing state, so that watcher cannot undo the user's action.

## AgentHydra integration

The server's `desktop-archive` route attempts configured native control before
writing disk flags, starting archive-reassert watchers, checking global CLI
liveness, or opening a sidebar menu. Native state checks the selected source
copy, so an active destination does not make a stopped source appear busy.

`POST /api/sessions/:id/native-archive` is the native-only attempt used by the
Python archive and migration-source paths. An explicit unavailable/not-sent
response permits their existing guarded fallback only when routing policy allows it;
`native-only` returns a terminal result instead. A native refusal, malformed
response, or lost mutation reply is terminal: no retry through disk or UI.

Connections are configured centrally through `GET` / `PUT
/api/claude-native/settings`. A PUT body is:

```json
{
  "profile": "C:\\Users\\you\\.claude-instances\\example",
  "config": { "port": 19315, "mode": "native-only", "launchDebugger": true }
}
```

`prefer-native` permits the existing guarded path only when the connection is
definitely unavailable before dispatch. `native-only` reports that condition
without UI fallback. Set `config` to `null` to remove the profile's opt-in.
Configuration stores no PID; every operation discovers and verifies the current
owner. Saving settings does not launch or restart an instance. With
`launchDebugger:true`, the next AgentHydra Open prepares/verifies a separate full
copy of the pinned Windows install and launches it with an instance-specific
loopback inspector port. Omit the field or set it to false to use the ordinary
installed launcher. A direct desktop shortcut still uses its own configured
executable; the new behavior applies to AgentHydra's Open action.

The historical #8 proof used a manually enabled inspector on port 9229. Ashley #15
(`work`) demonstrated `launchDebugger:true` on port 19315 without a developer-menu
setting. #8, #37 and Ashley were closed after those tests. These are test records, not a
current fleet configuration list: read `/api/claude-native/settings` or the Settings panel.
Overlapping native operations for one profile return a terminal, undispatched busy
result so their bystander-state checks cannot interfere with each other.

## Managed launch and Ashley production proof

The managed copy lives under AgentHydra's data directory in
`claude-native/<version>-<first twelve hex of the installed hash>`. The original signed executable is untouched.
The copied executable has the single inspector-fuse modification and therefore
does not retain the original executable's valid signature. Other fuses and all
application resources remain unchanged. Copies are complete regular files, not
junctions into the installed app.

AgentHydra derives the build rather than recognizing a reviewed one, and verifies
it structurally: the installed executable must carry exactly one Electron fuse wire
with the expected layout and the inspector fuse off, and the copy must differ from
the original by that one byte and nothing else. Every copied file is hashed into
the copy's manifest and re-verified on later launches, alongside the exact
profile/PID/executable, loopback connection and loaded Claude view. It rejects
occupied ports, changed copies, an ambiguous or unreadable fuse wire, and an
installed executable whose fuse is not in the expected off state. Inside the app,
the session manager and preview manager are found among already-loaded modules by
the exports and method surface they must have, and anything ambiguous fails closed;
the bundle file names and hashes that answered are recorded as evidence, not
compared against constants. The managed copy omits the
parent Squirrel updater; the live log confirmed its self-updater is disabled.
Managed startups are serialized while global registrations are snapshotted and
restored. Restoration waits for Claude's browser-host startup task, restores only
values still owned by that launch, and preserves unrelated concurrent changes.

Ashley #15 was initially closed and signed in. Full startup automatically enabled
port 19315, and native inspection confirmed the expected account and organization.
The first attempt revealed a readiness-check defect: it checked the outer
file-based window instead of the embedded `claude.ai` view. Claude itself had
loaded successfully. The check was corrected and a regression fixture added.

A disposable transcript was imported in **178 ms**, source settings restored in
**22 ms**, and archived through the ordinary AgentHydra `desktop-archive` endpoint
in **821 ms** including process discovery. That response reported `route:native`,
`verified:true`, and an empty UI-action list. Native screenshots verified the row
appeared and disappeared. All **202** existing metadata records retained their
checked title, model, effort, permission modes, working directory and archive flag;
the transcript bytes were unchanged.

After closing Ashley and reloading AgentHydra, a second Open returned verified
success in **9,651 ms**, including managed-copy validation and normal app startup.
The new process retained the test chat's archived state and settings. A repeated
archive correctly returned a verified no-op (`changed:false`, `dispatch:not-sent`)
in **332 ms**. Protocol, Chrome and Edge registrations were restored with no errors.
The Chrome registration had independently changed to another existing profile
during the first test; that unrelated change was preserved.

Evidence is in `tmp/ashley15-*.json` and the before/after archive PNGs. Ashley was
closed after verification; its AgentHydra automatic-launch opt-in remains enabled.
These results establish automatic startup and native archive on this pinned build,
not a fully native general migration/new/start/stop/resume implementation.

## Remaining migration work

- Support for reviewed future Claude versions and explicit opt-in for new profiles.
  Desktop shortcuts launch Claude directly, so covering those requires routing
  them through AgentHydra's launch path too.
- General destination settings restoration beyond the deliberately restricted
  disposable-chat POC. The proof restored effort and permission/Chrome mode
  through the native setters, but the general migration pipeline still owns its
  existing destination settings handling.
- Native unarchive with archive-watcher cancellation before dispatch.

The installed `claude://resume` handler accepts only the session ID. It does not
accept extra title, model, or permission query parameters. Import derives some
settings from the transcript and deliberately changes imported
`bypassPermissions` to `acceptEdits`; disk settings propagation alone cannot
replace destination permission confirmation.

The live proof establishes import, selected settings restoration, archive and
passive capture on this installed build. It does not establish a completely
native new/start/stop/move/resume sequence or arbitrary migration settings parity.
The earlier UI demo remains separately documented rather than relabeled native.
