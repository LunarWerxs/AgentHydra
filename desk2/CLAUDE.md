# Hydra Desk 2 (Michael's copy of desk/)

This folder is Hydra Desk 2: a copy of Jacob's Hydra Desk (`../desk`) made on 2026-10-04 so Michael can
try new things on it without touching Jacob's app. Both run side by side: Desk 2 is on port 7798, keeps
its data in `~/.hydra-desk-2/` and its window profile in `%LOCALAPPDATA%\HydraDesk2\window`, and has its
own "Hydra Desk 2" shortcut. SPEC.md is the design it started from and still describes what is
unchanged; what Desk 2 adds is in README.md under "What Desk 2 adds". shared/protocol.ts is the contract
between server/ and web/.

- This folder is part of the PUBLIC AgentHydra repo. Everything committed here is published: no real
  emails, account addresses, keys or chat content in files, tests or screenshots.
- `hydra/` is Desk 2's own copy of AgentHydra's window (`../web`, copied 2026-10-04 at 779aa0fd), built into
  `hydra/dist` and served by Desk 2 at `/ah/`; its `/ah/api/*` goes on to the one AgentHydra daemon
  (`server/src/plugins/45-agenthydra.ts`). Change it freely here; never edit `../web` from a Desk 2 task.
  The daemon is not copied: two would both run work on the same accounts.
- `desk/` is Jacob's: a change meant for both apps is made in each, and never by editing `desk/` from
  a Desk 2 task. Desk's design notes and audit tools (`desk/docs`, `desk/tools`) were not copied.
- Bun for everything (`bun install`, `bun test`, `bun run`). Tests set `HYDRA_DESK_HOME` to a temp
  folder; never write to the real `~/.hydra-desk-2/` from a test.
- Never read or print a secret: the agenthydra MCP entry copied from `~/.claude.json` and any
  `.credentials.json` stay out of logs and output.
- Never open a visible console window: detached processes use `Start-Process -WindowStyle Hidden` with
  logs to files.
