# AgentHydra agent instructions

## Claude Desktop chat operations

Read [the native-control runbook](docs/CLAUDE-DESKTOP-NATIVE-CONTROL.md) before
moving, migrating or archiving Claude Desktop Code chats. Prefer the production
programmatic path for supported operations. Do not start by driving Lua, UIA,
right-click menus, pop-ups or developer-menu toggles.

- Resolve the exact desktop instance number to its full profile directory, and
  target the exact CLI session ID. Never choose an account or chat by a fuzzy title.
- Read `GET /api/claude-native/settings`. A profile configured with
  `launchDebugger: true` starts its local debugger automatically on its next
  **Open through AgentHydra** (`POST /api/instances/:encodedDir/open`). It does not
  need a developer-menu click at every launch. A direct Claude shortcut bypasses
  this launch setting.
- The user-facing control is **Settings → General → Claude native control →
  Start debugger automatically**, per account. Preserve existing port and routing
  mode; each profile must have a distinct debugger port. New profiles are not
  automatically opted in. Check saved settings instead of assuming a fleet-wide
  default.
- `developer_settings.json` with `allowDevTools: true` enables Claude's developer
  controls on its next startup; it does **not** start the debugger. The AgentHydra
  launch setting is what makes the connection automatic.
- Use the normal production archive entry point
  `POST /api/sessions/:id/desktop-archive` with
  `{"instance_ref":"desktop:<full profile directory>"}`, or the existing
  orchestrator archive/migrate commands. They try the native adapter first for
  configured profiles. The Python archive and migration-source cleanup paths
  share `orchestrator/scripts/lib/nativearchivelib.py`.
- `native-only` refuses a missing native connection. `prefer-native` permits the
  guarded legacy path only for definite unavailability before dispatch. A native
  refusal, busy target, failed identity check, or unknown dispatch result
  must never trigger blind retries, disk-flag edits, or a UI fallback. Require the
  native result's `ok: true` and `verified: true` before reporting native success.
- Automatic launch derives the build from the newest installed Claude app and
  uses a verified managed copy that differs from the installed executable by
  exactly one byte (the inspector fuse); every copied file is hashed into the
  copy's manifest and re-checked against the install on each launch. Nothing is
  pinned to a Claude release, so an update needs no code change. Never patch the
  installed executable, and never bypass a fuse-wire, manifest, source-inventory
  or identity refusal to make one launch work. See the runbook for evidence.
- Do not restart or close an active desktop to obtain the connection. Configure
  the next normal launch and report its current availability. Keep chat identity,
  transcript bytes, title/model/effort/permissions and bystander state checks.

Production native coverage is **archive and migration-source cleanup**. General
destination import/settings restoration, unarchive, new-chat/start/stop/resume
have not all been converted. Use their existing guarded workflows; do not claim
an entire migration is native or substitute a one-off POC for production tooling.
Message delivery is a separate feature and is not the objective of this work.

The scripts under `scripts/claude-native-poc/` and proof-result documents are
diagnostics/history, not instructions to repeat the old menu activation process.

## Repository work

Keep unrelated working-tree changes intact. Build and check the main UI in
`web/`; `orchestrator/web/` is a separate interface. Configuration/API details and
the current compiler compatibility note are in the native-control runbook.
