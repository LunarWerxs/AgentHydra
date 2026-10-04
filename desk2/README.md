# Hydra Desk 2

Hydra Desk 2 is Michael's copy of Jacob's [Hydra Desk](../desk), made on 2026-10-04 to try new things
on without touching Jacob's app. It runs beside it: port 7798, data in `~/.hydra-desk-2/`, window
profile in `%LOCALAPPDATA%\HydraDesk2\window`, and its own **Hydra Desk 2** shortcut
(`launcher/install-shortcuts.ps1`). Everything below is Hydra Desk's own description, with the ports
and folders changed to Desk 2's.

## What Desk 2 adds

(Filled in as features land.)

---

<img src="launcher/hydra-desk.png" width="96" alt="Hydra Desk icon">

Hydra Desk is Jacob's own Claude Code desktop: a replacement for the Code tab of Claude Desktop. It
runs Claude Code chats itself, through the Claude Agent SDK, and shows at a glance which chats are
working, which are waiting on you, which finished and which stopped. You can stop any of them from the
window. It also shows the CliMayte workers AgentHydra is running and the Claude chats running
elsewhere on the PC. It looks like Claude Code Desktop in its dark theme; the one deliberate difference
is that it never hides whether a chat is working.

The full design is in [SPEC.md](SPEC.md). The contract between the server and the window is
[shared/protocol.ts](shared/protocol.ts).

## Starting it

**The shortcut.** Run `launcher\install-shortcuts.ps1` once. It puts a "Hydra Desk" shortcut on the
Desktop and in the Start Menu. Clicking it starts the server in the background if it is not running,
waits for it to answer, then opens Hydra Desk as its own window (Microsoft Edge in app mode, or Chrome
if Edge is missing), with its own taskbar entry. Clicking it again just brings the window forward; it
never starts a second server. No console window appears: the shortcut runs `launcher\start.vbs`, which
runs `launcher\start.ps1` hidden.

```powershell
powershell -NoProfile -File launcher\install-shortcuts.ps1   # make the shortcuts (-DryRun to preview)
powershell -NoProfile -File launcher\start.ps1               # what the shortcut does (-DryRun to preview)
powershell -NoProfile -File launcher\stop.ps1                # stop the server the launcher started
```

`stop.ps1` stops only the server `start.ps1` started (by the pid file it wrote), together with the
Claude Code processes its chats were running. It never touches any other bun process.

If the server does not answer within 20 seconds, the launcher shows a message box with the end of the
server log.

**For development.** `bun install`, then `bun run dev` runs the server with reload on 7798 and the Vite
dev server on 4798 (open http://127.0.0.1:4798). `bun run build` builds the window into `web/dist`,
which the server on 7798 serves; the launcher's window needs that build. `bun test` and
`bun run typecheck` are the checks.

To regenerate the icon: `python launcher\make-icon.py` (needs Pillow), then re-run
`install-shortcuts.ps1` so Windows picks it up.

## Ports

| Port | What |
| --- | --- |
| 7798 | Hydra Desk server: the API, the `/ws` live updates and the built window (`HYDRA_DESK_PORT` overrides) |
| 4798 | Vite dev server during `bun run dev`, forwarding `/api` and `/ws` to 7798 |
| 7787 | AgentHydra's daemon, which Hydra Desk talks to (`HYDRA_URL` overrides) |

## Where data lives

- `~/.hydra-desk-2/` (set `HYDRA_DESK_HOME` to move it; every test points it at a temp folder):
  - `settings.json` your settings
  - `chats.json` the chat list, and `chats/<chatId>.jsonl` each chat's transcript
  - `logs/server.log` the server's output, `logs/launcher.log` what the launcher did,
    `logs/<chatId>.log` each chat's Claude Code log
  - `server.pid` the server the launcher started (read by `stop.ps1`)
- `%LOCALAPPDATA%\HydraDesk2\window` the window's own browser profile (its size and position live here).

## The SDK

Chats run through `@anthropic-ai/claude-agent-sdk` 0.3.288. Each chat is a long-lived SDK session with
your Claude Code settings, CLAUDE.md files, hooks and MCP servers loaded as Claude Code would load them.

## How it plugs into AgentHydra

AgentHydra is the daemon on http://127.0.0.1:7787 (the parent folder of this one). Hydra Desk reads from
it, and works without it:

- **Accounts.** A new chat runs on the signed-in Claude account with the most room left, picked from
  AgentHydra's accounts, or on your default login.
- **CliMayte.** Every chat gets AgentHydra's MCP server, so it can hand work to CliMayte workers on any
  account. The CliMayte panel lists the workers running now, and each chat shows how many of its own
  workers are active.
- **Elsewhere.** The chats running in Claude Desktop or the Claude CLI show in their own list with
  their status, and you can adopt one into Hydra Desk.

If AgentHydra is not running, the window says so in a banner and those lists stay empty; your own chats
keep working.

This folder is its own private git repo. AgentHydra's repo above it is public and excludes this folder.
