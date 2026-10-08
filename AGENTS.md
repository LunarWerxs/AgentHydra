# AgentHydra agent instructions

Read and follow these instructions, including the Claude Desktop native-control
instructions below, before operating or modifying desktop chat management.

## Claude Desktop chat operations

For supported archive and migration-source cleanup, use AgentHydra's production
programmatic path first. **Start debugger automatically** is saved per account in
AgentHydra's **Settings → Instances → Desktop** (the Desktop table's gear opens it)
and activates on the next **AgentHydra Open**; do not repeat developer menu clicks. Enabling `allowDevTools` alone does
not start the debugger.

See [the native-control runbook](docs/CLAUDE-DESKTOP-NATIVE-CONTROL.md) for exact
APIs, configuration, verification and remaining migration limitations. Current
settings are authoritative; old proof scripts and result logs are historical.

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
- The user-facing control is **Settings → Instances → Desktop → Claude native
  control → Start debugger automatically**, per account (in a 1.x release's old
  window: Instances tab → gear). Preserve existing port and routing
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

Keep unrelated working-tree changes intact. The main UI is AgentHydra 2.0's window in
`desk2/` (`desk2/web`, with AgentHydra's own pages in `desk2/hydra`); build and check it there.
`web/` is the old window, served only where `desk2/` is missing; `orchestrator/web/` is a
separate interface. Configuration/API details and
the current compiler compatibility note are in the native-control runbook.

## Releases, CHANGELOG and READMEs (owner, 2026-10-06)

- **AgentHydra is 2.0: never release 1.x.** The window that was Hydra Desk 2 (`desk2/`) is
  AgentHydra 2.0, and the next release is 2.0.0, shipping it. Nothing is released before it ships
  Desk 2. The pre-push hook and `release.yml` refuse a tag below 2.0.0, and a tag build whose Windows
  zip has no `desk2/` does not publish. 1.11.0 to 1.13.0 went out on the closed line from another PC,
  with Desk 2's entries in their notes though their downloads had no Desk 2. See
  [docs/RELEASING.md](docs/RELEASING.md).
- **Release notes, CHANGELOG sections and READMEs open with a TL;DR, and the detail is folded**,
  as SageThumbs does it ("I ain't fucking reading that 10,000-mile-long detailed bullshit list just
  to figure out that you fixed two little things"). A CHANGELOG version section opens with
  `**TL;DR**`, one short headline bullet per change, then `**Everything in X.Y.Z**`;
  `scripts/release-notes.mjs` turns it into the release page and refuses a long section without one.
  A CHANGELOG bullet is a bold headline plus one to three plain sentences for a user. Owner quotes,
  measurements, endpoints and file names go in the commit message and the docs, not the CHANGELOG.
  A README opens with what the thing is and a TL;DR list; its long sections sit in
  `<details><summary>` blocks.

## Public repository

This repo is PUBLIC (LunarWerxs/AgentHydra), `desk2/` included.

- No real identities in tests, fixtures, comments or docs: use `example.com` /
  `example.test` addresses, a neutral name such as "Example Owner", and
  `C:/Users/me/...` paths. No real chat titles or chat text either; gallery and
  parity fixtures use invented text of the same shape.
- A test that must check a real local account (`server/tests/instances-crypto.test.ts`)
  compares a SHA-256 of the address, never the address itself.
- Screenshots of real chats stay on the PC that took them and are never committed.
- History was rewritten on 2026-10-05 to purge 68 such screenshots; main runs
  from `f53bbcda` and tags v1.9.0-v1.9.2 were moved. Never rebase or merge a
  branch made before that onto the new main: it brings the screenshots back.
  With no unpushed commits, `git fetch` then `git reset --soft origin/main`
  (the newest files are identical); the owner's land tool (`cycle.py`, kept outside
  this repo) replays only a session's own commits across such a rewrite. Values scrubbed on 2026-10-05
  (emails, names, user folders, chat text) are still in older history.
