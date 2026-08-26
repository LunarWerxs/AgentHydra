# AgentHydra: packaged release

This bundle is a self-contained build: the `AgentHydra` executable (Bun runtime embedded, no
Bun, Node, or install step needed) plus the prebuilt web UI in `web/dist/`, which must stay next
to the executable.

## Run it

- **Windows**: double-click `AgentHydra.exe` (or run it from a terminal). For a system-tray icon
  (Open / Restart / Quit), run `misc\Create-Shortcut.ps1` once, then launch from the `AgentHydra`
  shortcut it puts beside the executable. The icon is drawn by `misc\lunarwerx-tray.exe`, a small
  separate launcher, so starting `AgentHydra.exe` directly never produces one no matter what the
  in-app settings say. If the native launcher misbehaves, `misc\Create-Shortcut.ps1 -Legacy`
  rebuilds the same shortcut against the older PowerShell tray host.
  (The single-file `.exe` download has no `misc\` folder, so use the ZIP if you want the tray icon.)
- **macOS / Linux**: `./agenthydra`

The daemon serves the UI and API on <http://localhost:7787> (it hops to the next free port if
7787 is busy, and prints the real URL). State (the run queue, settings, saved accounts) lives in
`~/.agenthydra/data/`. Your Claude Code **sessions/transcripts are not stored here**: they're
read live from `~/.claude/projects`, so they show up regardless of which build you run.

`./agenthydra --version` prints the version; `--mcp` runs the MCP stdio server for
MCP-speaking agents, point your `mcpServers` config's `command` at this executable's full path
with `--mcp` as its arg (no Bun needed), e.g. `{ "command": "C:\\path\\to\\AgentHydra.exe",
"args": ["--mcp"] }`.

> **Coming from a `git` checkout?** Nothing to do. A checkout and this packaged build share one
> state directory, `~/.agenthydra/data/`, so your queue, accounts and settings are already here. A
> checkout still holding the old repo-local `server/data/` gets it moved across the first time
> either one starts. If you had already carried state over by hand and both locations hold a
> database, neither is touched: `~/.agenthydra/data/` is used and the other is named in the boot
> log and in `/api/health`.

## Requirements

- The `claude` CLI, for dispatching queue runs.
- Claude Desktop (classic Windows installer), for the multi-instance manager.
- macOS / Linux: instance management is source-accurate but less battle-tested than Windows.

## Updating

Packaged builds DO self-update. AgentHydra checks GitHub for a newer release on a timer and tells
you when one exists; it installs it only if you switched on unattended auto-update in Settings,
which is off by default because restarting the daemon out from under whoever is using it is a
thing you opt into. An install verifies the published SHA-256 before swapping the executable, and
the daemon then restarts itself onto the new build.

You can always update by hand instead: download the next release from
<https://github.com/LunarWerxs/AgentHydra/releases>. Either way your data (`~/.agenthydra/`)
carries over unchanged.
