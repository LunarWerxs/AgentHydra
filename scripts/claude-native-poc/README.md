# Claude native archive proof of concept

For everyday operations, use the production archive/migration scripts or AgentHydra's
`desktop-archive` route. Native archive and migration-source cleanup are integrated there.
Enable **Settings → General → Claude native control → Start debugger automatically** per
profile (API: `launchDebugger:true` in `/api/claude-native/settings`), then use AgentHydra
Open when that closed account is needed. No Developer-menu activation is required. See the
[operating guide](../../docs/CLAUDE-DESKTOP-NATIVE-CONTROL.md) for exact-profile requests,
automatic startup, version guards and failure handling. Do not use this directory's
restricted import/settings experiments as the general migration pipeline.

This directory contains local experiments, not a production integration. It includes
bundled-code tests and a separate live `background-control.ps1` helper. The archive tests
execute selected methods from the installed Claude Desktop bundle against an isolated
in-memory session manager fixture. They do not open apps, connect to a running app, move
the mouse, send keys, take foreground focus, or modify real chats.

Run the bundled-code tests from the app directory:

```powershell
bun test ./scripts/claude-native-poc/native-archive.poc.ts
```

The explicit relative path is required: `.poc.ts` keeps this installed-app experiment out
of ordinary `bun test` discovery and CI. The default source is the installed Claude
Desktop **2.2553.1** archive at
`%LOCALAPPDATA%/AnthropicClaude/app-2.2553.1/resources/app.asar`.
`CLAUDE_POC_ASAR` can point to another copy of that same build. The fixture parses the
ASAR header and reads `.vite/build/index.chunk-BQEs5Gzg.js` directly. It never imports
or initializes the Electron bundle.

The source member must have SHA-256:

```text
484ab045a1fbe63766a8f65d1258412c3943a60f21b8dcea3a8d63f1ed36a151
```

An unexpected checksum fails before any extracted code executes. The test output also
records each extracted method's signature, character offset, length, and SHA-256.
These are the unmodified bundled method bodies:

- `archiveSession` and `teardownSession`
- `unarchiveSession`
- `liveSideSessionsOf` and `sideSessionGoesWithParent`
- `archiveCascadeOf` and `archiveCascadeClosureOf`

The tests demonstrate that the native archive path addresses the exact desktop session
ID even when titles are identical, updates that fixture session's archive state, requests
persistence, and emits an archive/unarchive event. With `cleanupWorktree: false`, the
tested branch does not request Git status or worktree removal. Carried settings and
unrelated session objects remain unchanged in the tested cases.

The actual cascade methods discover child and grandchild sessions that would be archived
with their parent. Our **harness guard** rejects such an operation before mutation. The
guard also rejects a running/starting session and missing or mismatched IDs. These guards
are POC code, not behavior attributed to the native `archiveSession` method; the native
method itself can tear down a running query.

Filesystem persistence, process/PTY cleanup, Git, remote bridges, telemetry, and app
lifecycle dependencies are inert replacements. Account/profile routing, IPC transport,
renderer event delivery, real transcript preservation, and visible sidebar disappearance
are **not proved** by these tests. The fixture does not run native cascading mutations,
remote sessions, active queries, or worktree deletion. This is bundled-logic evidence,
not a live migration or archive result.

A live proof requires a separate, explicitly disposable chat in the intended already-open
instance, before/after screenshots, verified target identity, and unchanged bystanders.
Any live demonstration and its screenshots must be reported separately from these tests.

## Native inspector runner

`native-control.ts` is a native-only diagnostic command for an instance with an enabled
main-process inspector, normally started automatically by AgentHydra Open. The stock
**Developer → Enable Main Process Debugger** action was used only for the earlier manual
proof. The runner does not launch an app,
enable developer mode, open menus, click controls, or fall back to the PowerShell helper.

Use a JSON request, after obtaining the current PID and profile from AgentHydra:

```json
{
  "action": "inspect",
  "pid": 12345,
  "profileDir": "C:\\Users\\you\\.claude-instances\\example",
  "port": 9229
}
```

```powershell
bun scripts/claude-native-poc/native-control.ts --request tmp/native-request.json --output tmp/native-result.json
```

The output filename must be new. It is reserved before any operation is sent. The command
reports connection and operation timings, exact native identity, and native state evidence.
It never exports transcript text. The connection has a two-second setup deadline and
ten-second call deadline. Losing a response after submitting an archive reports an unknown
outcome; it does not retry by title or switch to UI automation.

For `"action": "archive"`, the request must additionally include `accountId`, `orgId`,
`sessionId` (the native `local_…` ID), and `cliSessionId`, all obtained from inspection.
`expectedTitle` is an optional extra assertion, never an identity lookup. The program
checks the pinned app version and manager source, uses only the already-initialized
singleton, and rechecks identity after awaited work. It requests
`cleanupWorktree: false`, rejects live/pending work and cascading archives, and verifies
settings and other sessions' archive flags afterward. It also checks the pinned preview
manager: a shared working directory is allowed only when archive would stop no affected
server or HTML preview. Attached parent sessions remain conservatively unsupported.
The generic inspector and archive program now live in `server/src/core/claude-native`;
the files here re-export them so the live runner exercises the same implementation.

`"action": "import"` and `"action": "settings"` are deliberately restricted to the
disposable transcripts created for this task. They are not general migration APIs.
Import uses native `importCliSession` with automatic trust disabled and checks transcript
bytes before/after. Settings restoration uses the native effort and permission setters,
checks target availability, and verifies the known source settings and bystanders.
Native unarchive is not implemented in this runner.

`native-capture.ts` obtains a PNG through the verified app's trusted Electron webContents,
without activating the window, sending input, or restoring it:

```powershell
bun scripts/claude-native-poc/native-capture.ts --pid 12345 --profile C:\Users\you\.claude-instances\example --output tmp/native-after.png
```

The portable mocked transport and program-guard tests run without Claude installed:

```powershell
bun test ./scripts/claude-native-poc/inspector-client.test.ts ./scripts/claude-native-poc/native-program.test.ts
```

A live native proof on #8 on 2026-09-19 measured import at 130 ms, settings restoration at
22 ms and archive at 20 ms. The screenshot row disappeared, transcript bytes were unchanged,
and all 132 pre-existing records retained their archive states. The before/after captures
took 27/24 ms. Both test instances were closed afterward. See
[the proof results](../../docs/CLAUDE-DESKTOP-POC-RESULTS.md) for the exact scope and evidence.

The server and Python archive/source-settlement paths now use the generic native archive
adapter when a profile is configured. The per-profile `launchDebugger:true` option makes
AgentHydra Open use a verified managed executable copy and start the main-process inspector
on its unique loopback port automatically. `allowDevTools` in `developer_settings.json`
alone does not start this connection. Use `native-only` to refuse disk/UI fallback when
the connection is unavailable; refusals or unknown mutation outcomes never permit a UI
retry in any mode. Saving never restarts an active app, and new profiles need their own
configuration. This full startup path was tested on Ashley #15; see the operating guide
for the managed-copy constraints and evidence.
