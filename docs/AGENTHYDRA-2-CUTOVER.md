# AgentHydra 2.0: Hydra Desk 2 becomes AgentHydra's only window

The owner's decision (2026-10-06): Hydra Desk 2 (`desk2/`) is AgentHydra 2.0. Opening AgentHydra shows
Desk 2, which carries the name AgentHydra. The old AgentHydra window (`web/`, served by the daemon on
7787) is removed in 2.0.0, and Hydra Desk 1 (`desk/`) is removed from the repo (2026-10-07). The daemon (`server/`, 7787) stays: it is
Desk 2's engine, and Desk 2 reaches it through its `/ah/api` proxy.

This file is the checklist for that move. Every step is done; 2.0.0 is the first release without the old
window.

## Done

- **The tray icon is Desk 2's.** The tray's Open runs Desk 2's launcher (`misc/AgentHydra-Tray.json`
  `openCommand`), and the launcher starts the tray with `--background` when it is not running
  (`desk2/launcher/start.ps1`, `Start-Tray`). Where `desk2/` is missing (a 1.x release zip), the
  command's `requires` keeps Open on the daemon's URL. A 2.0 bundle carries `desk2/launcher/start.vbs`, so its
  tray opens Desk 2.
- **Parity with the old window.** The ten commits to `web/src` after Desk 2's copy (`779aa0fd`) were
  checked one by one. What Desk 2 lacked was ported in `2a62884c`: "Copy up to here into a new chat" on an
  outside Claude Code session's reply, the auto-update label, and two class fixes.
- **The name is AgentHydra** (owner, 2026-10-06). The window title, the shortcut (`desk2/launcher/install-shortcuts.ps1`
  writes **AgentHydra** and recycles the old "Hydra Desk 2" ones), the launcher's message boxes and Desk's Settings say
  AgentHydra. The internal names below are unchanged.
- **Desk 2 ships in the release (Order step 1, 2026-10-06).** Every bundle (Windows, Linux, macOS) carries `desk2/`
  on the launcher's Bun (downloaded into `runtime/` on first run, never shipped; no `desk2/runtime/`), its server
  source and production `node_modules` (without Claude Code's binary, which Desk 2 fetches itself), its built
  `web/dist` and `hydra/dist`, and on Windows `launcher/` with `HydraDesk2.exe`. Desk 2's dev-servers service (for managing dev
  servers) runs as a hidden service started by Desk 2 itself, with no separate shipping.
  `scripts/package-release.ts` stages it and `scripts/smoke-release.ts` boots it, the same in `release.yml` and on a
  PC (see [RELEASING.md](RELEASING.md)); a tag build whose Windows zip has no `desk2/` does not publish. CI runs
  Desk 2's own suite (the `desk2` job in `ci.yml`). The updater treats `desk2/` as a release component (stops Desk 2
  before the swap, starts it after), and on an install with no `desk2/` (one updated by a 1.x updater, or the
  lone `.exe`) the launcher restores it, with any other missing part, from its own version's archive before it
  starts the daemon.
- **The daemon's openers lead to Desk 2 (Order step 2, 2026-10-06).** `server/src/desk2.ts` is the one place that
  knows Desk 2: present, URL, health, which bun, start, stop, open. A page asked of the daemon, the Connections
  sign-in's return included, goes on to Desk 2 when it answers; when it does not, the daemon starts it and shows a
  "Starting AgentHydra" page that moves on by itself or names the log, never a dead port. A release exe's
  double-click and boot open Desk 2 (Windows: its `start.vbs`; elsewhere its server and the default browser), and
  a checkout's self-update builds `desk2`. `/api` is untouched.
- **The quick-instances window is Desk 2's copy (2026-10-08).** The "AgentHydra Instances" shortcut still starts the
  light daemon (`server/src/instance-mode.ts`), or opens `/instances` on a full daemon that is already up, and
  both now serve `desk2/hydra`'s page from `desk2/hydra/dist` (`server/src/quick-instances-page.ts`: the page at
  `/instances`, its files under `/ah/`, and its `/ah/api/*` answered by the daemon's own guarded `/api/*`). A
  checkout's launcher (`misc/Instance-Launch.vbs`) builds Desk 2 when that build is missing, and Desk's Settings,
  Instances, Desktop has the Add to Desktop button the old Settings had.
- **The old window's table settings moved too.** Desk's Settings has an Instances section (CLI, Desktop, Free)
  holding what the tables' gears held; see `desk2/README.md`.
- **Hydra Desk 1 is off the owner's PC.** Its shortcuts and data went to the Recycle Bin. `desk/` was
  removed from the repo on 2026-10-07 (the owner's call; history keeps it).
- **The old window is gone (Order step 4, 2.0.0).** `web/` was deleted with everything that served,
  built or checked it: the daemon's static serving and the release bundle's embedded copy, the portable
  window and its `portable_mode` setting, the `web` workspace and scripts, its CI and release steps, the tray's
  first-run build (it builds `desk2` now), the live checkout's build, and the checks and tools that read
  `web/src` (they read `desk2/hydra/src`, AgentHydra 2.0's copy, or were cut). A page asked of the daemon goes
  to Desk 2; an install whose `desk2/` is missing gets a page saying so. The README screenshot tool and the
  SUE demo server run on `desk2/hydra` at `/ah/`. The shared kit's AgentHydra entry keeps its server libraries
  and tray and has no web tree.

## What the old window had that Desk 2 left out on purpose

Shut down (the daemon is Desk 2's engine), the theme picker (Desk has one theme) and portable mode
(`desk2/web/src/components/panes/agenthydra.ts`). Desk 2 has the rest:
updates (`agenthydra.ts:214`), transcript export (`desk2/web/src/components/session-header/ah.ts:43`),
the queue, Free instances, notifications and the shortcut sheet.

## Order

1. **Ship Desk 2 in the release.** Done 2026-10-06 (above): every bundle carries `desk2/` and runs it on the Bun the launcher downloads,
   the updater installs and repairs it, and a 2.0 tag does not publish without it.
2. **Point the daemon's openers at Desk 2.** Done 2026-10-06 (above) for every page, the boot and double-click
   openers and a checkout's self-update; the quick-instances window and its shortcut on 2026-10-08.
3. **Rename Hydra Desk 2 to AgentHydra.** User-facing: done 2026-10-06 (above). Internal, each needing a
   migration if renamed: `HydraDesk2.exe`, the mutexes `Local\HydraDesk2Launcher` and `Local\HydraDesk2Host`,
   `~/.hydra-desk-2/`, `%LOCALAPPDATA%\HydraDesk2`, port 7798 and the `desk2/` folder.
4. **Remove `web/`.** Done for 2.0.0 (above). `orchestrator/web/`, the remote gateway, is a separate
   interface and stays.
5. **`desk/`**: removed 2026-10-07 (the owner's call; history keeps it).
