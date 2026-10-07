# AgentHydra 2.0 (Hydra Desk 2, Michael's copy of desk/)

This folder is AgentHydra's window, AgentHydra 2.0: called Hydra Desk 2 until 2026-10-06, when the owner
named it AgentHydra. What a person sees says AgentHydra (the window title, the shortcut, the launcher's
messages); the folder, port, data folders, `HydraDesk2.exe` and the mutexes keep Desk 2's names, each a
migration of its own if ever renamed. It began as a copy of Jacob's Hydra Desk (`../desk`) made on
2026-10-04 so Michael can try new things on it without touching Jacob's app. Both run side by side: Desk 2 is on port 7798, keeps
its data in `~/.hydra-desk-2/`, opens in its own native window (`launcher/HydraDesk2.exe`, a WebView2
host built from `launcher/host`, its data in `%LOCALAPPDATA%\HydraDesk2\webview`), and has its own
"AgentHydra" shortcut. SPEC.md is the design it started from and still describes what is
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
  sidebar: a copy tab with a sidebar of its own (HSwarm's tree, whose nodes include Routing and CliMayte,
  `hydra/src/components/HSwarmView.vue`) describes it with `useDeskSidebar(view, build, onEvent)`, keyed by
  the tab's AppView, and only the tab on screen (App.vue's `setDeskView`) is sent; Desk draws it (`web/src/components/hydra/HydraSidebar.vue`); every message both ways is typed in
  `shared/hydra-embed.ts`. A new copy tab with a list beside its content does the same, not a second
  sidebar.
- Dev servers are AgentHydra's own (owner 2026-10-06: DevWebUI "isn't supposed to be separate", yet a "separate
  instance ... I wanna be able to kill it without killing Agent Hydra"): `server/src/devservers/` (contract
  `contract.ts`) runs as one hidden process, the dev-servers service (`service.ts`), which Desk starts outside its
  own tree on demand (`client.ts`) and never stops; the dev servers are its children. One copy per server: a server
  already up (whoever started it) is used, never doubled, and nothing is killed to free a port. Desk forwards
  `/dw/api/*` to it (`plugins/50-devwebui.ts`); chats get its `devservers` MCP tools (`mcp.ts`, through the built-in
  `devwebui` connector). Projects stay `.devwebui` files; data in `~/.hydra-desk-2/devservers/`. Page contract:
  `shared/devwebui.ts`. There is no separate DevWebUI copy or daemon any more: never bring one back.
- The title bar's Dev servers button lists the projects and servers in the sidebar (README, "What Desk 2 adds",
  owner 2026-10-06): `web/src/components/servers/DevServersList.vue`. It and `ServersPane` read the one client
  state, `servers/store.ts` (on `api.ts` and `logic.ts`; one polling loop, only while one is on screen), never a second
  client. A click selects a server, project or found folder and the right-hand info pane describes it, never starting
  anything (owner 2026-10-07; `store.select`, `servers/info/`); its Open in browser hands the servers pane the
  project's folder and the server (`store.show`, DeskFrame's `serversCwd`). Everything DevWebUI did is here: scanning
  and the found list, adding, editing and removing projects and servers, take-over, logs history, errors, free port,
  metrics and alerts, and its settings in Settings -> Dev servers.
- After changing a tooltip, menu, popover, sidebar row or lazy overlay: `bun run build`, then
  `bun run e2e:gestures` (the first gesture on every untouched trigger, headless; see the README).
- `desk/` is Jacob's: a change meant for both apps is made in each, and never by editing `desk/` from
  a Desk 2 task. Desk's design notes and audit tools (`desk/docs`, `desk/tools`) were not copied.
- Bun for everything (`bun install`, `bun test`, `bun run`). Tests set `HYDRA_DESK_HOME` to a temp
  folder; never write to the real `~/.hydra-desk-2/` from a test.
- Never read or print a secret: the agenthydra MCP entry copied from `~/.claude.json` and any
  `.credentials.json` stay out of logs and output.
- Never open a visible console window: detached processes use `Start-Process -WindowStyle Hidden` with
  logs to files.
