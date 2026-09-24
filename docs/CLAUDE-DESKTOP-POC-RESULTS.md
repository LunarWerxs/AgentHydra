# Claude Desktop archive proof results

Tested 2026-09-19 against installed Claude Desktop 2.2553.1.

## Live test in an existing instance

The test used **test9, instance 56**, which was already running. It created one
disposable Code chat titled **AgentHydra archive proof**, received the requested
one-line reply, and archived that exact chat through the app's Archive control.

| Check | Result |
| --- | --- |
| New chat appears in the app and responds | Passed; screenshot inspected |
| Archive removes the test row from the active sidebar | Passed; screenshot and accessibility tree inspected |
| App writes `isArchived: true` for the identified test session | Passed |
| Original test prompt and reply remain in the transcript | Passed |
| Pre-existing chats retain their archive states | Passed for all 45 records in this profile |
| Archive dispatch leaves foreground focus unchanged | Passed in this run |
| Entire creation flow leaves foreground focus unchanged | **Failed**: accessibility Invoke and SetValue brought the target forward |
| Direct native session-manager connection | **Not proved** |
| Migration between accounts | **Not tested live** |

The initial creation actions used Windows accessibility patterns. Although the
helper contains no call to activate a window, those two actions brought Claude
forward. That is a failed background-operation check, not a successful result.

Submission and the final archive used messages posted to the exact renderer
window at the observed control's bounds. They did not move the system cursor or
inject system keyboard input. The archive dispatch's foreground handle was
unchanged before and after. Opening the archive menu required accessibility
Expand; posted pointer messages alone did not open it reliably. Foreground
changed between the Expand samples, but neither sample was the test window;
that observation does not establish whether there was a brief activation.

This is **a live UI-based baseline**, not a native-bridge implementation. It still
depends on a rendered row and menu, and needs stronger race handling before use
in unattended migrations. `background-control.ps1` is a manual proof helper,
not a replacement for the production actuator. Its output reports observations;
an action returning does not by itself mean that the intended result occurred.

After verification, the original running chat was displayed again without a
foreground change. The earlier empty test instance was closed. Existing app
instances were not restarted. The disposable chat remains archived, as requested.

Machine-local evidence, kept outside the tracked source:

- `tmp/claude-live-replied.png`: test chat and reply before archive.
- `tmp/claude-live-archive-menu.png`: Archive menu attached to the test row.
- `tmp/claude-live-archived.png`: active sidebar after archive.
- `tmp/claude-live-result.json`: exact IDs, retained transcript checks, and
  bystander archive-state comparison.

## Extracted native-method tests

The separate fixture tests execute hash-pinned, unmodified archive/unarchive and
cascade methods extracted from the installed app. Six tests passed with 31
assertions: exact IDs despite duplicate titles, archive/unarchive transitions,
worktree cleanup disabled, cascade refusal, running-session refusal, and carried
settings preservation. Persistence and lifecycle dependencies are inert fixtures.

These tests establish native method behavior in those fixtures. They do not prove
access to a running app or visible native migration results. See the
[POC instructions](../scripts/claude-native-poc/README.md) for execution and source
provenance, and the [native-control investigation](CLAUDE-DESKTOP-NATIVE-CONTROL.md)
for the remaining connection work.

## Live start, stop, move, resume, stop, archive sequence

A second disposable chat, **AgentHydra move drill AH-MOVE-20260919**, completed
the requested sequence between already-running **test9 (#56)** and **temp2 (#14)**:

1. Created the chat on test9, submitted a harmless garden-name generation task,
   observed Running and the Stop control, then stopped it and observed Idle.
2. Moved the same CLI session to temp2 through the existing `/migrate` endpoint.
   Verified the landed chat visually, then archived the source row through its
   own app control so it disappeared there.
3. Corrected two migration regressions before restarting: the destination UI
   displayed Fable 5.1 instead of Opus 5, and Accept edits instead of Bypass
   permissions. Both original settings were restored through the app controls.
4. Submitted the continuation on temp2, observed Running, then stopped it.
   The transcript contains 3,396 assistant-text characters and zero tool calls;
   the stopped screenshot shows the generated list through item 127.
5. Archived the destination. Both desktop records are now archived, the test row
   is absent from both active sidebars, and the dossier reports no live engine.

The initial and continuation prompts remain in the same transcript. All **341
pre-existing records** across the two profiles retained their archive states.

This sequence required interventions, so it is not a regression-free migration
result. The migration API's initial call was rejected because the test harness
constructed an invalid target path; the corrected, exact-profile call succeeded.
The helper also encountered window-discovery and renderer-coordinate failures.
Source creation and stopping worked with posted window messages; destination
actions needed accessibility patterns, some of which changed foreground focus.
No system mouse movement or keyboard injection was used. No native debugger
bridge was involved, and no production migration code was changed.

Additional machine-local evidence:

- `tmp/sequence-02-source-running.png`
- `tmp/sequence-03-source-stopped.png`
- `tmp/sequence-04-target-landed.png`
- `tmp/sequence-05-source-cleared.png`
- `tmp/sequence-07-target-running.png`
- `tmp/sequence-08-target-stopped.png`
- `tmp/sequence-09-target-archived.png`
- `tmp/sequence-result.json` and `tmp/sequence-final-dossier.json`

## Native connection implementation after the UI demo

Added a native-only inspector client and command runner, plus a pinned native
inspect/archive program. They do not invoke the UI helper or start Claude. The
client verifies the process and full profile before exposing evaluation; the
program additionally verifies account, organization, native/CLI session IDs,
loaded singleton, app version and source hash. Archive disables worktree cleanup,
refuses live/cascading work, and checks settings and bystander archive flags.
Attached parent sessions are conservatively unsupported. The final preview guard
allows shared working directories only when archive would stop no affected server
or HTML preview.

The new transport and guard suites pass **30 tests / 138 assertions** without a
live app. Strict TypeScript and Biome checks also pass. The earlier six extracted
method tests remain separate installed-bundle evidence.

A read-only probe against the existing test9 process found no inspector at the
selected loopback port. It returned in **5 ms**, with `verified:false` and
`dispatch:"not-sent"`. No window, input, profile setting or chat state was changed.
Evidence: `tmp/native-inspect-connection-result.json`.

That refused connection was not an archive-speed measurement. The user declined
relaunching test9 and authorized opening closed #37 and/or #8, with cleanup
afterward. #37 was logged out and was closed. #8 was signed in and supplied the
working native connection below. None of the existing instances was restarted.

## Successful live native import, settings restoration and archive

On **another_meh (#8)**, PID **55228**, Claude **2.2553.1**, the stock Developer
menu enabled the main-process inspector after `allowDevTools` was provisioned
before launch. That one-time setup used the application menu. The following
operations used the verified native connection with no chat-menu clicks:

| Operation | Measured total |
| --- | ---: |
| Import the disposable archive-proof transcript | 130 ms |
| Restore source effort and permission/Chrome settings | 22 ms |
| Archive the exact imported native session | 20 ms |
| Capture before / after PNG through Electron | 27 / 24 ms |

These are individual measured calls including connection setup, not a broad
benchmark or the duration of writing/testing the adapter.

The proof's CLI ID is `b554be08-8a81-4711-b772-2d8b290b3844`; its imported native
ID is `local_b554be08-8a81-4711-b772-2d8b290b3844`. Native import preserved the
title and Opus 5 model, but reset effort and permissions. Native `setEffort` and
`setPermissionMode` restored **xhigh**, **bypassPermissions** and
**skip_all_permission_checks**. The archive then preserved all checked settings.
No prompt was submitted and no query was started.

The native before screenshot shows **AgentHydra archive proof** in the sidebar;
the after screenshot shows it absent. The original transcript remained byte-for-
byte unchanged, with SHA-256
`e238ca52dc1bfa9dd840635bdf19c47779b29709a76c5195464f78c77da2184b`.
All **132 pre-existing records** in #8 retained their archive states. The native
settings operation also reported no bystander changes.

Computer Use was stopped with Escape after the import. It was not called again.
The subsequent settings, archive and passive captures used the native connection;
the captures did not activate or restore the window. #8 was closed through its
exact-profile daemon endpoint after verification; #37 was also confirmed closed.
The Chrome native-host registration changed by app startup was restored to its
recorded prior value. The original active test9, 2uhmany and pap3r rotate2 processes
retained their PIDs. Temp2 closed separately at 01:37:36, before the #8 cleanup.

Machine-local evidence:

- `tmp/native8-import-result.json`
- `tmp/native8-settings-result.json`
- `tmp/native8-archive-result.json`
- `tmp/native8-imported.png` and `tmp/native8-archived.png`
- `tmp/native8-final-verification.json`
- `tmp/native8-quit-result.json`

The generic archive program and verified inspector client are now shared with
the server's native archive adapter. General native migration settings and
unarchive remain separate from this deliberately restricted disposable-chat
proof; the earlier complete start/stop/move sequence was UI-based.

## Production integration and cleanup

AgentHydra's archive route and Python archive/migration-source paths now attempt
native archive before window locks, UI actions or archive disk writes. A verified
native result completes that step; a refusal or uncertain result prevents a second
attempt through the legacy path. Per-profile concurrency guards reject overlapping
native operations before dispatch. The general destination import/settings path
and unarchive are not yet native production operations.

The source daemon was gracefully reloaded with no active dispatch or orchestrator
operations. Only **#8** is registered in the central native configuration, using
port **9229**, mode **native-only**. Other profiles retain their existing routing.
The developer-menu setting remains enabled in #8 and #37; neither process is
running and port 9229 is closed. A new process still needs the stock debugger
activation before it can accept native calls.

A production endpoint probe against closed #8 returned HTTP 409, `verified:false`,
`dispatch:"not-sent"`, and “The configured Claude profile is not running” in
**630 ms** including fresh process discovery. No window was opened and no chat
changed. This is a safe-unavailability test, not another archive timing.

Final cleanup verification checked all **69** original #37 records and all **132**
original #8 records: their archive states were unchanged. Recorded registry values
matched the baseline and the original transcript hash still matched. Evidence:
`tmp/native8-production-route-result.json` and `tmp/native-cleanup-verification.json`.

The Python regression selection passed **200 tests**. The TypeScript route,
coordinator, settings, inspector, native-program and installed-fixture selection
passed **124 tests / 558 assertions**;
server typecheck and Biome checks passed. A real unminified Windows Bun executable
also generated and executed the native inspect/archive expression against an inert
fixture, verifying that compilation does not break the serialized program.

## Subsequent automatic-launch test: Ashley #15

Automatic debugger startup is now integrated into AgentHydra Open through the
per-profile `launchDebugger:true` setting and a verified full executable copy.
Ashley #15 (`work`) was tested on loopback port 19315. A readiness-check defect
found in the first launch was fixed: Claude's trusted embedded view, rather than
its outer file-based window, establishes that the main UI loaded.

The corrected second launch completed and verified the debugger in **9.651 s**.
Native import took **178 ms**, settings restoration **22 ms**, and production
archive **821 ms** including process discovery. The archived state and settings
survived closing and reopening. A repeat archive was a verified no-op in **332 ms**.
All **202** existing records retained checked settings and archive flags; transcript
bytes were unchanged. Ashley was closed afterward, with its automatic-launch opt-in
retained. The original installed executable still had its original hash and valid
signature. See [implementation and full evidence](CLAUDE-DESKTOP-NATIVE-CONTROL.md#managed-launch-and-ashley-production-proof).

Screenshots: `tmp/ashley15-before-archive.png`, `tmp/ashley15-after-archive.png`.
Final verification: `tmp/ashley15-final-verification.json`.
