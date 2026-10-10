# The live checkout

The app you run loads its code from a checkout that nobody edits: `live/`, a git worktree of this
repository on branch `live` whose upstream is `origin/main`. It only ever moves by
`git pull --ff-only`, so a restart can only load code that was committed and pushed. Workers and chats
keep editing the working checkout, `app/`. (Why: field notes 74 and 75 in
[CLIMAYTE-FIELD-NOTES.md](CLIMAYTE-FIELD-NOTES.md). A restart once loaded a half-written file and every
queue upload failed.)

All work happens on `main`. The `live` branch is only the name git needs for a second folder on the same
repository (two worktrees cannot check out one branch). It never holds a commit of its own: it is `main`, or
a few commits behind it. Never open a chat with `live/` as its folder. A chat there edits `live/` and blocks
the updater (2026-10-10).

## What runs where

| What | Runs from | Notes |
| --- | --- | --- |
| Daemon (`server/src/index.ts --port 7787`), CliMayte runners, HSwarm sidecar | `live/` | The runners and the sidecar start from the daemon's root. |
| Tray (`misc\AgentHydra-Tray.exe AgentHydra-Tray.json`) | `live/` | Its config is relative (`appRoot ".."`), so only the shortcut moves. A tray still running under its old name, `lunarwerx-tray.exe`, is the old setup: it restarts the daemon from `app/`. |
| Desk 2, the window (`desk2\server` on 7798, `launcher\HydraDesk2.exe`) | `live\desk2` | The AgentHydra shortcuts run `live\desk2\launcher\start.vbs`. `-Apply` installs and builds it there. |
| Desk 2's dev-servers service | the Desk that started it | It outlives a Desk restart. Once its code differs from Desk's and it runs no server, Desk replaces it on the next `/dw/api/*` request. With servers running it is left alone, and `GET /dw/status` says `stale`. |
| Switch-card watchers (`approve_switch_card.ps1`, one per instance) | `live\orchestrator\scripts\actuator` | Started by the `AgentHydra-SwitchCardWatchers` task's wrapper. A watcher that is already running keeps the path it started with. |
| HSwarm: the `hswarm` command (`pip install -e`) and every chat's MCP connect step (`headersHelper` in the `mcpServers` map, [CLAUDE-CONFIG-LAYOUT.md](CLAUDE-CONFIG-LAYOUT.md)) | `live\hswarm` | Not moved by `-Apply` (step 6 below). The shared MCP server on 7793 runs its own copy of the committed code, in `~\.hswarm\code`. |
| `AgentHydra Daemon Supervisor`, `AgentHydra Daemon Watchdog` tasks | `live\misc\Supervisor-Tick.vbs`, `live\scripts\watchdog.vbs` | Same `wscript` switches, same triggers. |
| `Orchestrator-*` tasks and the dashboard (7799) | the job wrappers in the state dir, which run `live\orchestrator\...` | Wrappers are rewritten by text, not regenerated. |
| Anything not on `origin/main` (for example an uncommitted switch-card watcher) | stays on `app/` | `-Plan` warns about each one. Push it, then rerun `-Apply`. |
| Orchestrator state | `%USERPROFILE%\.agenthydra\orchestrator\state`, one place, or the working checkout's own folder with `-StateDir` ([below](#keeping-the-state-where-it-is)) | `app\orchestrator\state` and `live\orchestrator\state` are junctions to it, and `ORCHESTRATOR_STATE_DIR` is set for the user. |
| Daemon data, HSwarm state | `~\.agenthydra\data`, `~\.hswarm` | Already outside both checkouts. Nothing moves. |

## Setting it up

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\live-checkout.ps1 -Plan    # default: prints every change, changes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\live-checkout.ps1 -Apply   # makes them; safe to rerun
```

`-Apply` creates the worktree, runs `bun install` and the web build there, then the same two in its
`desk2\` (Desk 2, the window, has its own packages), all through `fairjob` when it is installed. It moves the state, sets the variable, rewrites the job wrappers, the tasks and the shortcuts.
It never stops or restarts anything. It ends by printing the one restart step:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <workspace>\live\misc\Restart-Daemon.ps1
```

The state move needs a moment when no process holds a file in the old state folder. If one does (the
dashboard keeps its log open), `-Apply` stops before the move, names the process and prints the
`Stop-Process` line. The dashboard's task starts it again within 5 minutes. Rerun `-Apply` after that.

## How code reaches the running app

1. Land the change on `main` and push it (`cycle.py --land`).
2. Then either let the updater take it (Settings, or auto-update: `git pull --ff-only origin main` in
   `live/`, `bun install`, then `bun install` and `bun run build` in `live/desk2`, restart), or rerun
   `-Apply`, which pulls and builds the same way, then the restart step above.
3. If `live/` already has the commit but the daemon started before it (`GET /api/health` shows
   `restartNeeded: true`, `bootCommit` older than `diskCommit`), restart it in place with
   `POST /api/daemon/restart` (the app header's Restart). The new daemon starts first and takes over the
   same port; CliMayte workers under their runners keep going and the new daemon picks them up (50 ran
   through one on 2026-10-10). It answers 409 while a worker runs inside the daemon itself or a chat move
   is in flight. The auto-update loop waits for running work on its own.

Never edit files in `live/`. If it has local edits, `-Plan` reports a problem and the updater refuses
the pull.

## Moving a machine that already runs from `app/`

`-Apply` rewrites what starts things. It restarts nothing, and a few things it does not rewrite at all. In this
order, while no CliMayte runner (`climayte-runner-*.exe`) is working, since a daemon restart cuts them off:

1. `-Plan`, then `-Apply`.
2. `live\misc\Restart-Daemon.ps1`. Then check that the daemon's parent chain ends in
   `live\misc\AgentHydra-Tray.exe`. A tray still running as `lunarwerx-tray.exe` (a shortcut made before the tray
   was renamed) brings the daemon back from `app\` within seconds: stop that tray and run the restart again.
3. Desk 2: the owner restarts it from the window's Menu > Restart to update (agents do not run `launcher\restart.ps1`
   or call the restart route; the server refuses them, see `desk2/AGENTS.md`). Chats keep running in their hosts and
   the open window reconnects.
4. Switch-card watchers: stop the ones whose command line names `app\`, then run the
   `AgentHydra-SwitchCardWatchers` task. It starts them again from `live\`.
5. Dev-servers service: once `GET http://127.0.0.1:7798/dw/status` shows `running: 0`, any `/dw/api/*` request
   (for example `GET /dw/api/settings`) makes Desk replace it from `live\`.
6. HSwarm: `python -m pip install -e <workspace>\live\hswarm`, then `python -m hswarm install` (add
   `--client all` for Claude Desktop and Codex), run from any folder outside `app\`. It writes the connect step
   from the checkout it imported. If `hswarm.exe` jobs are running, pip leaves the old exe in a `pip-uninstall-*`
   temp folder and prints a warning. The running jobs keep the code they already loaded.
7. Shortcuts made by hand that name `app\`, such as a copy of the tray shortcut or one for a local
   `rebuild_agenthydra.bat`, need repointing by hand. That gitignored root script restarts the daemon from the
   checkout it sits in, so keep it in `live\` only. `app\AgentHydra.lnk` and `app\AgentHydra Instances.lnk` are
   rewritten by `tests/launcher.test.ts` for whichever checkout runs the tests. Don't use them to start the app.

Done when nothing that runs names `app\`:

```powershell
Get-CimInstance Win32_Process | Where-Object CommandLine -match 'AgentHydra\\app\\(misc|server|desk2|orchestrator)' |
  Select-Object ProcessId, Name, CommandLine
```

## Testing a change without touching the live app

Run a side daemon from `app/` on a spare port with its own store, so it can never take over the live
daemon's pointer, workers or MCP registration:

```powershell
$side = "$env:TEMP\agenthydra-side"
$env:AGENTHYDRA_HOME = $side
$env:AGENTHYDRA_DATA_DIR = "$side\data"
$env:AGENTHYDRA_DB = "$side\agenthydra.db"
$env:AGENTHYDRA_MCP_CONFIG = "$side\mcp.json"
$env:ORCHESTRATOR_STATE_DIR = "$side\orchestrator-state"
bun server/src/index.ts --port 7801
```

Set all five. A side daemon that shared the live store once ran as a second supervisor of the live
daemon's workers (note 74). Run the orchestrator's Python tests the same way, with their own
`ORCHESTRATOR_STATE_DIR` (the tests' `isolate_state_dir` does this).

HSwarm works the same way. `hswarm\tests` and `python -m hswarm` run from the `app\` root load `app\`'s files.
The plain `hswarm` command and every chat's MCP connection load `live\`, so they see a change only after it is
pushed and `live\` has pulled it.

## Undo

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\live-checkout.ps1 -Undo -Plan   # preview
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\live-checkout.ps1 -Undo
```

This points the tasks, job wrappers and shortcuts back to `app/`, then prints the restart step for
`app/`. The state stays in its one place, because moving it back would split it again. `app/` keeps
reaching it through the junction. The `live/` worktree is left alone. To remove it, delete its junction
first: `cmd /c rmdir <workspace>\live\orchestrator\state`, then `git worktree remove <workspace>\live`.

Delete a junction only with `cmd /c rmdir`. `Remove-Item -Recurse` in Windows PowerShell 5.1 follows
the junction and deletes the state it points to. Run `orch.py schedule_jobs --apply` from `live/` so
the wrappers it writes name the live checkout.

## Keeping the state where it is

`-StateDir <path>` naming the working checkout's own real `orchestrator\state` folder (compared
case-insensitively, after junctions and trailing separators are resolved) moves nothing: no copy, no
rename, no junction of `app\`'s folder. The script only links `live\orchestrator\state` to that folder,
sets `ORCHESTRATOR_STATE_DIR` to it and re-points the wrappers' code paths to `live\`. Processes that
hold state files are not blockers, since nothing is renamed. `-Undo` for this case removes the live
junction and the variable (the link only) and never touches the folder.
