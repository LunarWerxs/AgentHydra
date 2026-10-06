# AgentHydra 2.0: Hydra Desk 2 becomes AgentHydra's only window

The owner's decision (2026-10-06): Hydra Desk 2 (`desk2/`) is AgentHydra 2.0. Opening AgentHydra shows
Desk 2, which will carry the name AgentHydra. The old AgentHydra window (`web/`, served by the daemon on
7787) retires, and Hydra Desk 1 (`desk/`) is no longer used. The daemon (`server/`, 7787) stays: it is
Desk 2's engine, and Desk 2 reaches it through its `/ah/api` proxy.

This file is the checklist for that move: what is done, what still ties AgentHydra to the old window
(file and line as of 2026-10-06), and the order to undo it in.

## Done

- **The tray icon is Desk 2's.** The tray's Open runs Desk 2's launcher (`misc/AgentHydra-Tray.json`
  `openCommand`), and the launcher starts the tray with `--background` when it is not running
  (`desk2/launcher/start.ps1`, `Start-Tray`). Where `desk2/` is missing (a release zip today), the
  command's `requires` keeps Open on the daemon's URL, so nothing breaks before Desk 2 ships.
- **Parity with the old window.** The ten commits to `web/src` after Desk 2's copy (`779aa0fd`) were
  checked one by one. What Desk 2 lacked was ported in `2a62884c`: "Copy up to here into a new chat" on an
  outside Claude Code session's reply, the auto-update label, and two class fixes. Until `web/` is
  deleted, a change to `web/src` is made in `desk2/hydra/src` too.
- **Hydra Desk 1 is off the owner's PC.** Its shortcuts and data went to the Recycle Bin. `desk/` stays
  in the repo: it is Jacob's, and removing it is his call.

## What still ties AgentHydra to the old window

### The daemon serves and opens it

| Where | What it does | At cutover |
| --- | --- | --- |
| `server/src/config.ts:354` `WEB_DIST_CANDIDATES` | where the built old window is | drop |
| `server/src/index.ts:924` `embeddedWeb`, and 929-960 | serves the old window, from the compiled exe's embedded copy or from `web/dist` | drop the static serving; `/api/*` stays |
| `server/src/index.ts:1031`, `:1611` `openUi` | a release exe's double-click, and boot, open the old window | open Desk 2 (run its launcher) |
| `server/src/index.ts:839` `/api/portable-window`, `:232-235` `portable_mode` | the chromeless "portable" window of the old UI | drop with the setting (Desk 2 left portable mode behind) |
| `server/src/instance-mode-window.ts:7`, `server/src/instance-mode.ts:296` | the quick-instances window (`/instances`) and the light daemon that serves it | retarget to Desk 2's copy (`desk2/hydra/src/QuickInstancesApp.vue`) or retire |
| `server/src/core/instance-mode-shortcut.ts:50`, `server/src/routes/instances.ts:173` | creates the quick-instances shortcut (`--instances`) | retire with the window, or retarget |
| `server/src/updater.ts:27` `buildCmd` | a checkout's self-update rebuilds `web` | build `desk2` |
| `server/src/github-updater.ts:1143` | a release update replaces `<install>/web` | replace Desk 2's files instead |

### Build, packaging and release

- `package.json:8` workspace `web`, scripts `dev:web`, `build`, `check` and `typecheck` (lines 16-33).
- `scripts/build.ts:140` embeds `web/dist` in the exe; `:278` builds `web` unless `--skip-web`.
- `.github/workflows/release.yml:86` builds `web`; `:119` and `:146` compile the exe with it embedded.
  The zip stages `misc/` and `orchestrator/` but no `desk2/` (`:105-142`).
- `.github/workflows/ci.yml:103` `check:i18n` on `web`, `:207` builds it.
- The tray's first run builds `web\dist` (`misc/AgentHydra-Tray.json:44`; the legacy host
  `misc/AgentHydra-Tray.ps1:73`), and `misc/Instance-Launch.vbs:27` checks for it.
- `scripts/live-checkout.ps1:253,259` rebuilds `web` for the live checkout.

**Desk 2 is not shippable in a release yet.** Its launcher runs `bun server/src/index.ts`
(`desk2/launcher/start.ps1:127` fails without bun), while a release is a compiled exe with no bun, and its
window host `HydraDesk2.exe` is built from `desk2/launcher/host` with cargo. A release needs Desk 2's
server compiled the way the daemon is (or bun shipped), `desk2/web/dist`, `desk2/hydra/dist`,
`HydraDesk2.exe` and the launcher scripts staged beside `misc/`. Once `desk2\launcher\start.vbs` is in
the zip, the tray's `requires` switches Open to Desk 2 by itself. The release freeze holds until then.

### Scripts, checks and tests

- `tests/repo-root.ts:31` finds the repo root by a `web` folder.
- `scripts/checks/transcript-index-born-stale.mjs:219`, `scripts/checks/reka-popper-root-inside-tooltip.mjs:131`
  and `scripts/checks/fixer-only-called-by-its-test.mjs:40` read or scan `web/src`.
- `scripts/sue-demo/serve.ts:21` serves `web/dist`; `scripts/screenshots/capture.mjs:317` starts `web`'s dev
  server.
- `bunfig.toml:18` keeps `desk2/` out of the root suite: Desk 2 runs its own (`bun test ./server/test ./web/test`
  in `desk2/`).

### Docs that send people to the old window

`README.md:259` ("the UI is at <http://localhost:7787>"), `README.md:174`, `:287`, `:292`, `AGENTS.md:10`
and `:30`, `docs/CLAUDE-DESKTOP-NATIVE-CONTROL.md:64`, `docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md:4` and `:478`,
`docs/CLIMAYTE-LIVE-TESTS.md:110` ("Instances tab → gear"), and `docs/REFERENCE.md:381` (7787 as the "UI
port"). The daemon's own URLs (`/api/mcp`, HSwarm's and the orchestrator's `AGENTHYDRA_URL`) are the API
and stay.

### What the old window has that Desk 2 left out on purpose

Shut down (the daemon is Desk 2's engine), the theme picker (Desk has one theme), portable mode, and the
quick-instances shortcut (`desk2/web/src/components/panes/agenthydra.ts:6-7`). Desk 2 has the rest:
updates (`agenthydra.ts:214`), transcript export (`desk2/web/src/components/session-header/ah.ts:43`),
the queue, Free instances, notifications and the shortcut sheet.

## Order

1. **Ship Desk 2 in the release** (packaging above). Until then Desk 2 runs from a checkout only.
2. **Point the daemon's openers at Desk 2**: `openUi` callers, the quick-instances window and its shortcut.
3. **Rename Hydra Desk 2 to AgentHydra.** User-facing: the window title (`desk2/web/index.html:6`), the
   shortcut "Hydra Desk 2" (`desk2/launcher/install-shortcuts.ps1:20-35`), the launcher's message boxes
   (`desk2/launcher/start.ps1`). Internal, each needing a migration if renamed: `HydraDesk2.exe`, the mutex
   `Local\HydraDesk2Launcher`, `~/.hydra-desk-2/`, `%LOCALAPPDATA%\HydraDesk2`, port 7798 and the `desk2/`
   folder.
4. **Remove `web/`**: the static serving and embedding, the workspace and scripts, the CI steps, the checks
   and tests above, the docs, then the folder.
5. **`desk/`**: Jacob's to keep or remove.
