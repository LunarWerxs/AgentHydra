# AgentHydra: packaged release

This bundle is a self-contained build: the `AgentHydra` executable (Bun runtime embedded, no
Bun, Node, or install step needed) plus the prebuilt web UI in `web/dist/`, which must stay next
to the executable.

## Run it

- **Windows**: double-click `AgentHydra.exe` (or run it from a terminal). For a system-tray icon
  (Open / Restart / Quit) instead of a console window, run `misc\Tray-Launch.vbs`: create a
  shortcut to it with `misc\New-TrayShortcut.ps1`.
- **macOS / Linux**: `./agenthydra`

The daemon serves the UI and API on <http://localhost:7787> (it hops to the next free port if
7787 is busy, and prints the real URL). State (the run queue, settings, saved accounts) lives in
`~/.agenthydra/data/`. Your Claude Code **sessions/transcripts are not stored here**: they're
read live from `~/.claude/projects`, so they show up regardless of which build you run.

`./agenthydra --version` prints the version; `--mcp` runs the MCP stdio server for
MCP-speaking agents, point your `mcpServers` config's `command` at this executable's full path
with `--mcp` as its arg (no Bun needed), e.g. `{ "command": "C:\\path\\to\\AgentHydra.exe",
"args": ["--mcp"] }`.

> **Coming from a `git` checkout?** A source checkout keeps its database under the repo's
> `server/data/`; this packaged build uses `~/.agenthydra/data/` instead, so it starts with an
> empty queue. Your sessions are unaffected (see above). To carry the old queue/accounts/settings
> over, point the binary at the old file: set `AGENTHYDRA_DB=<repo>/server/data/agenthydra.db`.

## Requirements

- The `claude` CLI, for dispatching queue runs.
- Claude Desktop (classic Windows installer), for the multi-instance manager.
- macOS / Linux: instance management is source-accurate but less battle-tested than Windows.

## Updating

Packaged builds don't self-update (that's a source-checkout feature); download the next release
from <https://github.com/LunarWerxs/AgentHydra/releases>. Your data (`~/.agenthydra/`) carries
over unchanged.
