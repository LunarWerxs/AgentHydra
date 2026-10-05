# Hydra Desk 2 (Michael's copy of desk/)

This folder is Hydra Desk 2: a copy of Jacob's Hydra Desk (`../desk`) made on 2026-10-04 so Michael can
try new things on it without touching Jacob's app. Both run side by side: Desk 2 is on port 7798, keeps
its data in `~/.hydra-desk-2/`, opens in its own native window (`launcher/HydraDesk2.exe`, a WebView2
host built from `launcher/host`, its data in `%LOCALAPPDATA%\HydraDesk2\webview`), and has its own
"Hydra Desk 2" shortcut. SPEC.md is the design it started from and still describes what is
unchanged; what Desk 2 adds is in README.md under "What Desk 2 adds". shared/protocol.ts is the contract
between server/ and web/.

- This folder is part of the PUBLIC AgentHydra repo. Everything committed here is published: no real
  emails, account addresses, keys or chat content in files, tests or screenshots.
- `hydra/` is Desk 2's own copy of AgentHydra's window (`../web`, copied 2026-10-04 at 779aa0fd), built into
  `hydra/dist` and served by Desk 2 at `/ah/`; its `/ah/api/*` goes on to the one AgentHydra daemon
  (`server/src/plugins/45-agenthydra.ts`). Change it freely here; never edit `../web` from a Desk 2 task.
  The daemon is not copied: two would both run work on the same accounts. The copy has no Sessions tab
  (removed 2026-10-04): Desk's cloud list and its session header (`web/src/components/session-header`)
  replace it, and the copy's "open this chat" goes to Desk (`hydra/src/lib/desk-embed.ts`). Desk owns the one
  sidebar: a copy tab with a sidebar of its own (CliMayte, HSwarm) describes it with `useDeskSidebar`
  and Desk draws it (`web/src/components/hydra/HydraSidebar.vue`); every message both ways is typed in
  `shared/hydra-embed.ts`. A new copy tab with a list beside its content does the same, not a second
  sidebar.
- `../devwebui/` is a whole copy of Michael's DevWebUI (LunarWerxs/DevWebUI at 69c766dc, copied 2026-10-05),
  kept as its own project beside AgentHydra and Desk: its only job here is the servers and browser pane a
  chat opens (start/stop the project's localhost servers, show one). It keeps its own package.json, tests
  and tooling; the root suite and biome skip it, as they skip desk/ and desk2/.
  Desk 2 uses it only through `server/src/plugins/50-devwebui.ts` (+ `server/src/devwebui/daemon.ts`) and the web pane
  `web/src/components/servers`: the plugin finds the daemon (`DEVWEBUI_URL`, else `runtime.json` in `DEVWEBUI_HOME` or
  `~/.devwebui`), starts `bun server/src/index.ts` there hidden when the pane asks, and forwards `/dw/api/*` with the
  daemon's `.cookie` credential. Contract: `shared/devwebui.ts`. Tests set `DEVWEBUI_HOME` to a temp folder. Change
  `../devwebui` only when the pane truly needs it, upstream-shaped, and name it in the commit message.
- `desk/` is Jacob's: a change meant for both apps is made in each, and never by editing `desk/` from
  a Desk 2 task. Desk's design notes and audit tools (`desk/docs`, `desk/tools`) were not copied.
- Bun for everything (`bun install`, `bun test`, `bun run`). Tests set `HYDRA_DESK_HOME` to a temp
  folder; never write to the real `~/.hydra-desk-2/` from a test.
- Never read or print a secret: the agenthydra MCP entry copied from `~/.claude.json` and any
  `.credentials.json` stay out of logs and output.
- Never open a visible console window: detached processes use `Start-Process -WindowStyle Hidden` with
  logs to files.
