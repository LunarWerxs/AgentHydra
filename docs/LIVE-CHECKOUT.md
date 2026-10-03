# The live checkout

The app you run loads its code from a checkout that nobody edits: `live/`, a git worktree of this
repository on branch `live` whose upstream is `origin/main`. It only ever moves by
`git pull --ff-only`, so a restart can only load code that was committed and pushed. Workers and chats
keep editing the working checkout, `app/`. (Why: field notes 74 and 75 in
[CLIMAYTE-FIELD-NOTES.md](CLIMAYTE-FIELD-NOTES.md). A restart once loaded a half-written file and every
queue upload failed.)

## What runs where

| What | Runs from | Notes |
| --- | --- | --- |
| Daemon (`server/src/index.ts --port 7787`), CliMayte runners, HSwarm sidecar | `live/` | The runners and the sidecar start from the daemon's root. |
| Tray (`misc\lunarwerx-tray.exe AgentHydra-Tray.json`) | `live/` | Its config is relative (`appRoot ".."`), so only the shortcut moves. |
| `AgentHydra Daemon Supervisor`, `AgentHydra Daemon Watchdog` tasks | `live\misc\Supervisor-Tick.vbs`, `live\scripts\watchdog.vbs` | Same `wscript` switches, same triggers. |
| `Orchestrator-*` tasks and the dashboard (7799) | the job wrappers in the state dir, which run `live\orchestrator\...` | Wrappers are rewritten by text, not regenerated. |
| Anything not on `origin/main` (for example an uncommitted switch-card watcher) | stays on `app/` | `-Plan` warns about each one. Push it, then rerun `-Apply`. |
| Orchestrator state | `%USERPROFILE%\.agenthydra\orchestrator\state`, one place | `app\orchestrator\state` and `live\orchestrator\state` are junctions to it, and `ORCHESTRATOR_STATE_DIR` is set for the user. |
| Daemon data, HSwarm state | `~\.agenthydra\data`, `~\.hswarm` | Already outside both checkouts. Nothing moves. |

## Setting it up

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\live-checkout.ps1 -Plan    # default: prints every change, changes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\live-checkout.ps1 -Apply   # makes them; safe to rerun
```

`-Apply` creates the worktree, runs `bun install` and the web build there (through `fairjob` when it is
installed), moves the state, sets the variable, rewrites the job wrappers, the tasks and the shortcuts.
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
   `live/`, `bun install`, the web build, restart), or pull and restart by hand:
   `git -C <workspace>\live pull --ff-only`, then the restart step above.

Never edit files in `live/`. If it has local edits, `-Plan` reports a problem and the updater refuses
the pull.

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
