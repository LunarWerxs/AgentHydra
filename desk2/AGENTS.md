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
  owner 2026-10-06): `web/src/components/servers/DevServersList.vue`, and slides in the Dev servers page on its
  overview. It, the page and `ServersPane` read the one client state, `servers/store.ts` (on `api.ts` and `logic.ts`;
  one polling loop, only while one is on screen), never a second client. A click selects a server, project or found
  folder and the page describes it, never starting anything (owner 2026-10-07; `store.select`, `servers/info/`). The list
  is grouped by company (`server/src/devservers/company.ts`, the README's rule), every group closed by default yet
  showing what runs (owner 2026-10-07: "default collapsed if they have none running ... show the one running unless I
  expand"): study how DevWebUI did a thing before porting it, never only its surface. Its Open in browser hands the servers pane the
  project's folder and the server (`store.show`, DeskFrame's `serversCwd`). Everything DevWebUI did is here: scanning
  and the found list, adding, editing and removing projects and servers, take-over, logs history, errors, free port,
  metrics and alerts, and its settings in Settings -> Dev servers. The Dev servers page is its own page, never a
  right-hand sidebar (owner 2026-10-07: "just be its own page ... like Hydra slides in"): it shares AgentHydra's half
  of DeskFrame's sliding track, so it pushes the chat out as AgentHydra does and opening one closes the other, and its
  content is one centered column capped at 960px. It is cards, never tables (owner 2026-10-07: "fucking ugly table
  when it should be in a nice, like, card display"), with CPU and memory charts and stats (the service's ten-minute
  ring, `GET /dw/api/processes/:id/metrics`), roomy errors, alert rules and forms, a breadcrumb from the overview, a
  back button and a visible star. Build on its kit (`servers/info/kit/`), whose class strings never set one property twice
  (README, "Dev servers in the sidebar").
- Work that touches free accounts leaves them measurably better (owner, 2026-10-07: "free instances should always
  have a mild imperative for RSI"): the RSI metrics `free.route.wrapper_chars` and `free.claude.calls_per_new_chat`
  (`.rsi/rsi.yaml`) are the ones to move, and `python <hydra>/ph.py rsi next --here` picks among them.
- After changing a tooltip, menu, popover, sidebar row or lazy overlay: `bun run build`, then
  `bun run e2e:gestures` (the first gesture on every untouched trigger, headless; see the README).
- `web/dist` and `hydra/dist` are what the running window serves, so `bun run build` never builds into them:
  `scripts/build-dist.ts` builds each app into `dist.next-<pid>` and swaps it in only when vite succeeded (2026-10-07: a
  hydra build failing on another session's half-made edits had left `/ah/` blank for ten minutes). A failed build
  leaves the old dist as it was. A build whose templates use a static class its CSS has no rule for is refused the
  same way (`scripts/dead-classes.ts`, since 2026-10-08: on 2026-10-07 `size-screen`, which Tailwind v4 does not
  generate, left the page shorter than the window with every other check green). So is one with a `.vue` file the Vue compiler
  refuses (`scripts/sfc-errors.ts`, since 2026-10-08: two `:class` bindings on one element built green, while the dev
  server answered the file with a 500 and every dev-server probe saw a blank page). Run `vite build` by hand only with `--outDir` pointing
  somewhere else.
- The window draws its own title bar (README, "Its own window"): the host (`launcher/host`) takes Windows' caption
  off after the page's `ready` and lays its snap-layouts caption sink over the rect `WindowControls` reports
  (`placeButtons`). Anything added to the top row is a control (`no-drag`) or drag area; AgentHydra's pages are a
  frame, where `app-region` does not reach, so their top bar asks Desk to move the window (`ah:window`,
  `hydra/src/lib/desk-embed.ts`). `launcher/HydraDesk2.exe` is committed: after changing `launcher/host`, run its
  tests, build it in release and copy `target/release/HydraDesk2.exe` there. Two sessions that each rebuild it
  conflict on the binary (2026-10-08): take the other's commit, rebuild from the merged source, land that.
- The parity page (`web` dev server, `#/parity/<scene>`) freezes `Date.now`, and Vue drops a click stamped no later
  than its listener was attached; inside the transcript (whose capture listener stamps the click first) a probe's
  click then does nothing (2026-10-08, the working line's ">"). Move the clock before clicking:
  `Date.now = () => frozen + n++`.
- `desk/` is Jacob's: a change meant for both apps is made in each, and never by editing `desk/` from
  a Desk 2 task. Desk's design notes and audit tools (`desk/docs`, `desk/tools`) were not copied.
- Bun for everything (`bun install`, `bun test`, `bun run`). Tests set `HYDRA_DESK_HOME` to a temp
  folder; never write to the real `~/.hydra-desk-2/` from a test.
- A Desk on any home but `~/.hydra-desk-2` (a test's, an e2e script's, a probe's) is a throwaway: it never joins
  Login sync and sets up no Free runtime (`server/src/real-home.ts`, 2026-10-07: before, one pulled every Free login
  into %TEMP%). Never gate that on `NODE_ENV`: e2e scripts and probes run outside `bun test`.
- Never read or print a secret: the agenthydra MCP entry copied from `~/.claude.json` (SPEC.md, `mcpServers`) and any
  `.credentials.json` stay out of logs and output.
- Never open a visible console window: detached processes use `Start-Process -WindowStyle Hidden` with
  logs to files.
- Never restart or stop the live server. Do not curl `/api/server/restart` or `/api/server/shutdown`, and do not run
  `launcher/restart.ps1` or `launcher/stop.ps1` against it. The server refuses those asks from anything but the window
  (409, logged with the caller in `~/.hydra-desk-2/logs/restart.log`). The owner restarts it from the window's
  Menu > Restart to update. Test a restart on your own copy on a spare port with its own home folder. The one
  exception is the owner asking a chat in his own words to restart it (2026-10-09: "can you do it please"): run
  `launcher/restart.ps1` hidden (`Start-Process -WindowStyle Hidden`), its output appended to
  `~/.hydra-desk-2/logs/restart-run.log`, without `-Chats`, and check `/api/server/update` reads `stale: false`.
