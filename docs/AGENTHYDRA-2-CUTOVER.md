# AgentHydra 2.0: Hydra Desk 2 becomes AgentHydra's only window

The owner's decision (2026-10-06): Hydra Desk 2 (`desk2/`) is AgentHydra 2.0. Opening AgentHydra shows
Desk 2, which will carry the name AgentHydra. The old AgentHydra window (`web/`, served by the daemon on
7787) retires, and Hydra Desk 1 (`desk/`) is no longer used. The daemon (`server/`, 7787) stays: it is
Desk 2's engine, and Desk 2 reaches it through its `/ah/api` proxy.

This file is the checklist for that move: what is done, what still ties AgentHydra to the old window
(file and line as of 2026-10-06, after steps 1 and 2), and the order to undo it in.

## Done

- **The tray icon is Desk 2's.** The tray's Open runs Desk 2's launcher (`misc/AgentHydra-Tray.json`
  `openCommand`), and the launcher starts the tray with `--background` when it is not running
  (`desk2/launcher/start.ps1`, `Start-Tray`). Where `desk2/` is missing (a 1.x release zip), the
  command's `requires` keeps Open on the daemon's URL. A 2.0 bundle carries `desk2/launcher/start.vbs`, so its
  tray opens Desk 2.
- **Parity with the old window.** The ten commits to `web/src` after Desk 2's copy (`779aa0fd`) were
  checked one by one. What Desk 2 lacked was ported in `2a62884c`: "Copy up to here into a new chat" on an
  outside Claude Code session's reply, the auto-update label, and two class fixes. Until `web/` is
  deleted, a change to `web/src` is made in `desk2/hydra/src` too.
- **The name is AgentHydra** (owner, 2026-10-06). The window title, the shortcut (`desk2/launcher/install-shortcuts.ps1`
  writes **AgentHydra** and recycles the old "Hydra Desk 2" ones), the launcher's message boxes and Desk's Settings say
  AgentHydra. The internal names below are unchanged.
- **Desk 2 ships in the release (Order step 1, 2026-10-06).** Every bundle (Windows, Linux, macOS) carries `desk2/`
  with its own bun (`desk2/runtime/`), its server source and production `node_modules`, its built `web/dist` and
  `hydra/dist`, and on Windows `launcher/` with `HydraDesk2.exe`. Desk 2's dev-servers service (for managing dev
  servers) runs as a hidden service started by Desk 2 itself, with no separate shipping.
  `scripts/package-release.ts` stages it and `scripts/smoke-release.ts` boots it, the same in `release.yml` and on a
  PC (see [RELEASING.md](RELEASING.md)); a tag build whose Windows zip has no `desk2/` does not publish. CI runs
  Desk 2's own suite (the `desk2` job in `ci.yml`). The updater treats `desk2/` as a release component (stops Desk 2
  before the swap, starts it after), and a compiled install with no `desk2/` (one updated by a 1.x updater, or the
  lone `.exe`) installs it from its own version's archive at boot.
- **The daemon's openers lead to Desk 2 (Order step 2, 2026-10-06).** `server/src/desk2.ts` is the one place that
  knows Desk 2: present, URL, health, which bun, start, stop, open. A page asked of the daemon, the Connections
  sign-in's return included, goes on to Desk 2 when it answers; when it does not, the daemon starts it and shows a
  "Starting AgentHydra" page that moves on by itself or names the log, never a dead port. A release exe's
  double-click and boot open Desk 2 (Windows: its `start.vbs`; elsewhere its server and the default browser), and
  a checkout's self-update builds `desk2`. `/api` is untouched. Only an install with no `desk2/` still serves `web/`,
  plus the quick-instances page (below).
- **The old window's table settings moved too.** Desk's Settings has an Instances section (CLI, Desktop, Free)
  holding what the tables' gears held; see `desk2/README.md`.
- **Hydra Desk 1 is off the owner's PC.** Its shortcuts and data went to the Recycle Bin. `desk/` stays
  in the repo: it is Jacob's, and removing it is his call.

## What still ties AgentHydra to the old window

### The daemon serves and opens it

| Where | What it does | At cutover |
| --- | --- | --- |
| `server/src/config.ts:354` `WEB_DIST_CANDIDATES` | where the built old window is | drop |
| `server/src/index.ts` `embeddedWeb` and `dist` | serves the old window, from the compiled exe's embedded copy or from `web/dist`, only where `desk2/` is missing, and the quick-instances page `/instances` | drop the static serving; `/api/*` stays |
| `server/src/index.ts:839` `/api/portable-window`, `:232-235` `portable_mode` | the chromeless "portable" window of the old UI | drop with the setting (Desk 2 left portable mode behind) |
| `server/src/instance-mode-window.ts:7`, `server/src/instance-mode.ts:296` | the quick-instances window (`/instances`) and the light daemon that serves it | retarget to Desk 2's copy (`desk2/hydra/src/QuickInstancesApp.vue`) or retire. Desk 2's copy is built for base `/ah/` and picks the quick app only on the exact path `/instances`, which Desk 2 does not route yet |
| `server/src/core/instance-mode-shortcut.ts:50`, `server/src/routes/instances.ts:173` | creates the quick-instances shortcut (`--instances`) | retire with the window, or retarget |

### Build, packaging and release

- `package.json:8` workspace `web`, scripts `dev:web`, `build`, `check` and `typecheck` (lines 16-33).
- `scripts/build.ts:140` embeds `web/dist` in the exe; `:278` builds `web` unless `--skip-web`.
- `.github/workflows/release.yml` still builds `web` ("Build web SPA"), and the compiled exe embeds it for an
  install with no `desk2/`.
- `.github/workflows/ci.yml:103` `check:i18n` on `web`, `:207` builds it.
- The tray's first run builds `web\dist` (`misc/AgentHydra-Tray.json:44`; the legacy host
  `misc/AgentHydra-Tray.ps1:73`), and `misc/Instance-Launch.vbs:27` checks for it.
- `scripts/live-checkout.ps1:253,259` rebuilds `web` for the live checkout.

### Scripts, checks and tests

- `tests/repo-root.ts:31` finds the repo root by a `web` folder.
- `scripts/checks/transcript-index-born-stale.mjs:219`, `scripts/checks/reka-popper-root-inside-tooltip.mjs:131`
  and `scripts/checks/fixer-only-called-by-its-test.mjs:40` read or scan `web/src`.
- `scripts/sue-demo/serve.ts:21` serves `web/dist`; `scripts/screenshots/capture.mjs:317` starts `web`'s dev
  server.
- `bunfig.toml:18` keeps `desk2/` out of the root suite: Desk 2 runs its own (`bun test ./server/test ./web/test`
  in `desk2/`, and the `desk2` job in `ci.yml`).

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

1. **Ship Desk 2 in the release.** Done 2026-10-06 (above): every bundle carries `desk2/` on a shipped bun,
   the updater installs and repairs it, and a 2.0 tag does not publish without it.
2. **Point the daemon's openers at Desk 2.** Done 2026-10-06 (above) for every page, the boot and double-click
   openers and a checkout's self-update. Still open: the quick-instances window and its shortcut (table above).
3. **Rename Hydra Desk 2 to AgentHydra.** User-facing: done 2026-10-06 (above). Internal, each needing a
   migration if renamed: `HydraDesk2.exe`, the mutexes `Local\HydraDesk2Launcher` and `Local\HydraDesk2Host`,
   `~/.hydra-desk-2/`, `%LOCALAPPDATA%\HydraDesk2`, port 7798 and the `desk2/` folder.
4. **Remove `web/`**: the static serving and embedding, the workspace and scripts, the CI steps, the checks
   and tests above, the docs, then the folder.
5. **`desk/`**: Jacob's to keep or remove.
