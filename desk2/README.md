# Hydra Desk 2

Hydra Desk 2 is Michael's copy of Jacob's [Hydra Desk](../desk), made on 2026-10-04 to try new things
on without touching Jacob's app. It runs beside it: port 7798, data in `~/.hydra-desk-2/`, its own
window (`launcher/HydraDesk2.exe`, WebView2 data in `%LOCALAPPDATA%\HydraDesk2\webview`), and its own **Hydra Desk 2** shortcut
(`launcher/install-shortcuts.ps1`). Everything below is Hydra Desk's own description, with the ports
and folders changed to Desk 2's.

## What Desk 2 adds

A first, quick version of each, to see whether the direction is right. The layout is Desk's own: the
sidebar on the left stays put, and only the pane on the right changes.

- **Servers and a small browser beside the chat, like Claude Code Desktop's.** The title bar's Browser button opens a right pane (wider than Changes, drag its left edge to resize, the width is remembered) with a Servers | Browser switch in its header, always there. Servers lists this chat's localhost servers, centred in the pane: a status dot, name, port, Start / Stop / Restart, Open for one that runs, the last output of one that crashed, Start all / Stop all, and below them the servers other folders have running ("Also running", Open / Stop). Browser is the page: an address bar, back, forward, reload and open in the system browser, and before anything is opened "No page open" with a button for each server that answers. Open shows a server there, and Start opens it as soon as it answers; the header then has the server's name and Stop, and a stopped server shows "X is stopped" with Start over the page. "Open an address, or a port" at the bottom opens any address. The chat's folder needs no Add step: `POST /dw/folder {cwd}` (`server/src/devwebui/folder.ts`) uses the project DevWebUI already has for that folder, or sets one up from Claude Code's `.claude/launch.json` (its preview servers: `runtimeExecutable`/`runtimeArgs` or `program`, `port`, `cwd`, `env`) or else package.json's dev scripts, every server left stopped, and adds the `.devwebui` file it writes to the repo's `.git/info/exclude` so it never shows in git status; a folder with neither says so, with Look again. The servers come from DevWebUI (`../devwebui`), found through `DEVWEBUI_URL` or its `runtime.json` pointer and started hidden by `server/src/plugins/50-devwebui.ts` when the pane is opened and none answers (log in `~/.hydra-desk-2/logs/devwebui.log`; it keeps running when Desk 2 exits). `/dw/api/*` goes on to the daemon only for Desk 2's own page, with DevWebUI's local credential added server-side; `GET /dw/status` says running, starting, stopped or failed. A Desk 2 server started before this existed shows "Restart Hydra Desk 2 to turn on servers".
- **AgentHydra inside the window, Desk 2's own copy of it.** The AgentHydra button in the chrome bar,
  after Back and Forward (an outline two-headed serpent drawn like the Cloud and Bot beside it), slides AgentHydra in over the chat with a push (0.42 s, the chat moving out
  to the left as AgentHydra comes in). While it is open there is still only the one sidebar, Desk's: on
  HSwarm it is HSwarm's tree alone (`hydra/src/components/HSwarmView.vue`), Routing and CliMayte two of its
  nodes (CliMayte after Jobs; owner, 2026-10-05: "HSwarm should pretty much just show the HSwarm sidebar.
  Routing should be an option under the HSwarm in the sidebar, and CliMayte should also be an item under
  that"), drawn in Desk's look (the copy describes it in `shared/hydra-embed.ts` and hides its own; a click
  goes back to it); with HSwarm down the tree holds just Routing and CliMayte under a "not running"
  banner. On every other tab the cloud list is below. Only the tab on screen decides Desk's sidebar
  (App.vue's `setDeskView`), and the copy sends it again on every `desk:visible` and on a click of the tab
  already on screen, so no other tab's rows are left behind. CliMayte has no tab of its own (owner,
  2026-10-05: "move what is currently on the CliMayte tab into HSwarm"): its node shows a compact manager
  list inside the pane, one line per task (status, title, account, model, time, a cloud for another PC's
  task), Running / All, the waves above it and the scorecard closed; a click opens the task with "Back to
  tasks", and CliMayte's tasks never go into Desk's sidebar. Desk's links land on the node: a task row
  opens CliMayte on that task, a job row Jobs on that job. The Routing node is one page: HSwarm's
  routing first (`hswarm/HSwarmRouting.vue`), then AgentHydra's cost routing between API keys and the
  Claude subscriptions (`hswarm/HSwarmCostRouting.vue`, alone while HSwarm is down): the on/off switch, the
  API-or-subscription split used when the two costs are close (default 60 / 40 to API keys), the close
  band, a bulk-rate discount per provider, and tables of each plan's measured worth and each model's list
  price, price at your rate and subscription equivalent; every change is saved at once (`PUT
  /api/routing/settings`) and synced to the other PC by login sync. How the choice is made is in
  `../docs/COST-MODEL.md`. The copy has no Sessions
  tab: the cloud list is the session list, and a session clicked there slides the chat
  back and opens it in Desk's own view, under the session header below. A chat the copy itself is asked
  to open (the Instances move dialog's list, the landing page's session rows) comes back to Desk the
  same way. Every other AgentHydra tab (Instances, Analytics, HSwarm) is there as usual.
  Escape, the AgentHydra button again, or picking one of Desk's own chats slides the chat back. The pane
  has no strip of its own above the copy (owner, 2026-10-05: "remove the header bar ... and remove the
  logo"): the copy's top bar fills it, without the AgentHydra logo and title or the Queue button. It
  opens at once: the copy loads in the background once Desk has painted and the window is idle, keeps
  every tab it has opened, and keeps one shared store per kind of data (CLI and desktop instances,
  analytics, HSwarm, CliMayte), asked again about every 2 minutes while the window is visible and
  right when a page or the pane is shown, so every tab reads the same numbers (`hydra/src/lib/warm-data.ts`).
  What slides in is not AgentHydra's own window but Desk 2's copy of it, `hydra/` (AgentHydra's `web/`,
  copied at 779aa0fd), so it can be changed as much as wanted without touching AgentHydra. Desk 2
  serves it at `/ah/` and hands its API calls to the one AgentHydra daemon (`HYDRA_URL`, default
  http://127.0.0.1:7787), only from Desk 2's own page and without the browser's cookies or origin; the
  daemon itself is not copied, since two would both run work on the same accounts. `bun run build`
  builds both windows.
- **The cloud list.** The cloud button (next to it, blue while it is on) turns the sidebar into every
  session AgentHydra knows, from both PCs: the desk list's rows plus the rest. Turning it on or off moves
  nothing (owner, 2026-10-04: "for some reason they change order"): both lists keep one saved order, so a
  row the desk list shows sits in the same group at the same place, and is there even when it is older
  than the cloud list's time period; the rows only the cloud list has come after the desk's in their group
  (and their groups after the desk's groups), each kept where it first appeared. The cloud icon means the
  other PC and nothing else (owner, 2026-10-05: "why chats on my computer are considered cloud ... it's a
  different app, sure, but it's not cloud"): a row from the other PC leads with a cloud, its tooltip naming
  that PC (and the app when it is not Claude), pulsing gray while that chat or the work a row was added for
  runs (blue for a running HSwarm job), and nothing else sets it apart (owner, 2026-10-05: no PC-name chip;
  the desk list marks a synced chat with the same cloud); this PC's Codex, OpenCode and other apps' chats
  lead with a small muted mark for their app in both lists (`rowLead` in `web/src/components/cloud/logic.ts`),
  and the Apps ticks below decide which apps' chats the desk list shows too (Desk's own chats always).
  Each row shows its AgentHydra instance number (#37), as AgentHydra's rows do. The Filter menu opens with
  Apps, one checkbox per app (Claude, Codex, OpenCode, Hermes, DSH, HSwarm), one click each, and starts at
  Claude alone (owner, 2026-10-05: "I don't necessarily want to see open code or ChatGPT in my sidebar by
  default, but I want to be able to"); search still looks through every app unless Only this view is
  ticked. The scopes call it `apps`, so a filter saved before (as `source`, every app ticked) comes back at
  Claude alone with the rest of it kept. A row the desk list shows keeps
  its dot, and the dot moves as it does there: gray and pulsing while the session works, orange while it
  waits on you (owner, 2026-10-05: "the gray dots in the sidebar should pulse when they're working"). A session the desk list does
  not show goes under the folder it
  started in, which is where Claude Desktop files it, even after it moved into a subfolder. Clicking one opens its
  transcript on the right. Search looks through every session, archived ones included, from all time,
  and shows the best matches first. The cloud button again goes back to the desk list. It replaces
  AgentHydra's Sessions tab.
- **Rows that go away fade.** A row leaving either sidebar list, a CliMayte task line, or a folder whose last
  row left fades out and then folds shut, so the rows under it slide up instead of jumping (owner,
  2026-10-05). Rows a search or a filter hides go at once, and so does everything while the window is
  hidden or asks for reduced motion. Rows also stopped popping in and out: an outside session only
  AgentHydra's transcript index knows (a Codex session, a CLI outside `~/.claude`) stays listed for 10
  minutes after its last write, idle after the first 30 s, instead of leaving 30 s after each write, and
  HSwarm's job transcripts stay out of the desk list (HSwarm has its own tab), as they do in the cloud list.
- **Rows you arrange.** A row in either list drags to another place in its group (a line shows where it
  will land), into the one order both lists share; not while selecting, searching or filtering (owner,
  2026-10-05: "items in the sidebar need to be draggable to rearrange order"). A cloud list row has a
  right-click menu: a row the desk list shows gets its desk menu, any other Open, Pin and Copy session
  ID. A pinned outside session stays listed however long it has been idle. A row the desk list shows
  idle has the dimmer hollow ring, as Claude draws one, in the cloud list too. Motion is calmer, and
  nothing in the sidebar spins (owner, 2026-10-05: "instead of being blue spinning icons, ... a slow blue
  pulsing icon"). Blue is HSwarm's alone: a running HSwarm job's mark (its line's icon, its Count badge, a
  row that is the job itself) pulses slowly in blue. A running CliMayte task, here or on the other PC, and
  a chat working on the other PC pulse gray, as a working chat's dot does. All of them share the working
  dot's 2.4 s blink (`.run-pulse` in `web/src/style.css`, `runPulse` and `glyphDotClass` in
  `sidebar/logic.ts`) and hold still when the system asks for reduced motion; a waiting dot pulses orange
  every 3 s.
- **Groups you hide.** A project group's header has a right-click menu with Hide: the group leaves the
  list and its chats stay active, nothing is archived (owner, 2026-10-05: "I don't want to like archive
  because they're meant to be there, but I also don't feel like seeing"). The Filter menu's Show hidden
  groups brings every hidden group back, dimmed with an eye-off mark, and its right-click then says
  Unhide. Both lists hide the same groups; a search still finds their rows, and opening a chat that sits
  in a hidden group turns Show hidden on. Pinned and Archived cannot be hidden. The browser remembers
  both (`web/src/components/sidebar/hidden.ts`).
- **Show only local, and a word on hover.** The Filter menu's Show only local (in the cloud list part)
  keeps just this PC's sessions, the ones synced from the other PC out; the Cloud list heading then reads
  "this PC". It is Computer with only this PC ticked, so either one undoes it. Every Filter menu item
  says what it does when the pointer rests on it (owner, 2026-10-05).
- **CliMayte tasks in the sidebar.** The robot button beside the cloud (blue while on) lists, under each
  chat or session in the sidebar that has CliMayte tasks running, those tasks, one short indented line
  each (status, title, model, how long it has run); a task a manager started sits one step further in,
  under its manager. A task with a session opens it; one without opens it on the CliMayte page of
  AgentHydra's HSwarm tab.
  Each task is listed once: a row that is itself a task (a manager's session in the cloud list) does not
  list its tasks again when they already show under the row that started it. A task sits only under the
  chat that spawned it, never in a list of its own (owner, 2026-10-04: "under the chat which spawned them.
  Not as its own stand alone table"): a task a manager's wave runs, which AgentHydra records with only its
  wave, goes under that manager, and the other PC's tasks (a little cloud, the PC in its tooltip) go under
  their chat when it is in the list, which takes that PC's chat sync and an AgentHydra there new enough to
  share the task's chat. However deep a chain goes, a running task still shows (past three steps in, at
  the third step's indent), and so does every finished task above it: the server keeps those past its
  "20 newest finished" cut. Turning it on while an AgentHydra tab with its own list is open slides back to
  the desk so the tasks show. Every task AgentHydra's CliMayte list shows running is in the sidebar
  (owner, 2026-10-05: "Is one smaller than six?"). Running work that no drawn row lists is added as a row
  in its folder's group, among that group's rows and in the list's order, drawn exactly like them; another
  PC's row differs only by its cloud (owner, 2026-10-05: "inline identical. I shouldn't even be able to
  tell the difference between ones on his computer and mine, besides them having a Cloud icon"). The row
  is the chat that started the work, its tasks one step in, titled and filed as this window knows that
  chat (a synced chat, an outside session or a Desk chat), else as its PC titles it, else after its first
  task; when nothing says which chat started it (a Desk chat run as a worker, a dispatcher that is gone, a
  PC whose AgentHydra is too old), the task is the row (`nestTasks` and `addToDeskGroups` /
  `addToCloudGroups` in `web/src/components/sidebar/tasks.ts`). The other PC shares only the last name of
  a task's folder (and of an HSwarm job's caller's), never its path, so its chat that is not synced here
  goes in the one group here whose folder has that name, else in a group of that name after the list's
  own (two groups with the name are a guess, so it gets its own; owner, 2026-10-06); only work with no
  name at all goes in "No folder". Added rows
  stay out while a search is typed, under the Archived filter and in a hidden group, as the list's own
  rows do; with the cloud off only this PC's are added. A folded group's heading carries a gray dot with
  how many CliMayte tasks run under it, a blue dot with how many HSwarm jobs, and a green dot with how
  many of its chats run (owner, 2026-10-05).
- **HSwarm jobs in the sidebar.** While the robot button is on, a chat's row also lists the HSwarm jobs it
  started, after its CliMayte tasks (owner, 2026-10-05: "ZSwarm threads should also be displayed on the
  HydraDesk 2 sidebar"), placed by the same rules: under the chat's row in either list, else under the
  added row of its caller on the job's PC. A running job with no such row adds one, its caller's row
  (titled from the caller's title, else the job) or the job itself when nothing names the caller; a
  finished job only joins a row that is already there, and a prefix that could be two chats adds a row,
  never a guess. Desk 2's server reads the jobs with the CliMayte workers on
  one poller (`server/src/bridge/poller.ts`, jobs at most every 10 s) and pushes them to every window
  (`swarm.update`); HSwarm stamps each job with its caller's full ids, and a Claude Desktop chat's id
  (`local_...`) is turned into its session and title through AgentHydra's chat list, archived chats
  included (a finished job's chat is often archived by the time it is listed). With the cloud on, the other
  PC's jobs (shared in its queue snapshot) show under that PC's chats or as its added rows. A job
  click opens that job on AgentHydra's HSwarm page.
- **A list or a count per kind.** The Filter menu's Sub-items choose, per kind, whether a row shows its
  CliMayte tasks and HSwarm jobs as lines (List) or as a small badge with the kind's icon and how many run
  (Count: blue for running HSwarm jobs, light gray for running CliMayte tasks, muted when only finished
  ones are left, its icon pulsing while any run) at the row's right edge; defaults: CliMayte List,
  HSwarm Count (owner, 2026-10-05: "just an icon, like a number ... not insanely cluttering up my
  sidebar"). A badge's tooltip names up to eight of them; a click shows that row's lines inline until the
  next click. Kept in `hydra-desk.sidebar.tasks-mode` and `hydra-desk.sidebar.jobs-mode`.
- **The sidebar is there at once.** Opening or reloading the window shows the last known lists straight
  away (kept in the browser), and the server sends a new window every list it has as soon as it joins,
  instead of waiting for the next change.
- **The session header.** Over a session opened from the cloud list (or any session running outside
  Desk) sits one bar, across the whole pane, with what AgentHydra's Sessions tab said about it, each
  fact in its own colour: the product, the short id (click to copy), the instance number and account
  (its address in the tooltip; click to see that account's row in AgentHydra's Instances, the desktop or
  CLI table, marked), the folder (click to open it), the git branch, turns,
  tokens and cost (the breakdown in the tooltip; a "+" when a model has no published price), the model
  and effort, and any credentials the transcript printed (redacted). Its buttons are Find (Ctrl + F;
  Enter and Shift + Enter step through the matches, marked in the transcript), Copy session file
  location, Copy session id and Close, and its ⋯ menu has the account (bring it to the front, copy its
  address), Display (only what I typed, tool activity, reasoning, compact layout), the session file
  (open it, save it as Markdown, a web page or the raw .jsonl, copy the file itself, copy its path), and
  for Claude sessions Reopen in a terminal and Migrate to another account. The title bar's panel icon
  slides it up out of view and back down; it lies over the top of the transcript, so the page never
  re-lays out while it moves. The chat title in the title bar is centred. It reads AgentHydra through
  Desk 2's `/ah/api`.
- **One card for every Instances table** (owner, 2026-10-06). CLI, Desktop and Free each sit in the same
  lighter, rounded card (`InstanceCard.vue`): the header bar is its top, the rows inside it. A table
  that mixes providers (Desktop, Free) has a + menu with one item per provider, from the shared header.
- **The copy's own changes.** Its desktop Instances table keeps its column widths and row order while
  the stats load (fixed columns, placeholders the size of what replaces them; Memory and Tokens re-sort
  on a header click or Refresh, not on every poll), and an HSwarm job opens its summary right under its
  row instead of at the bottom of the page. A CliMayte task's pane shows its whole title and, first in
  its body, the whole brief it was sent (the daemon's `GET /api/corch/workers/:id?prompt=full`; lists
  and MCP still get the first 300 characters). The centred column has no side lines.
- **Every source in the home screen's stats.** The stats card under "What's up next?" counts everything
  AgentHydra knows, not only Desk's own chats (owner, 2026-10-04: "full consolidated stats from all
  sources"): sessions, messages, tokens, active days, peak hour, favourite model, CliMayte's tasks,
  HSwarm's tasks and the cost at API rates (AgentHydra's Analytics also shows it at your bulk rate, labelled
  "at your rate", once a discount is set on the Routing page), then one line per source (Claude desktop, the CLI, CliMayte,
  HSwarm, Codex, OpenCode, DeepSeek) and the activity grid, for All, 30 days or 7 days. Desk's server
  gathers it in one route, `GET /api/stats/home?range=`, from AgentHydra's spend and activity reports,
  CliMayte's totals and HSwarm's stats; a part that does not answer shows a dash saying why, never a 0,
  and with AgentHydra away the card shows Desk's own chats and says so. Each square of the activity grid
  says its day and its number on hover (owner, 2026-10-05), and the Sources list folds up: folded at
  first, then as you last left it. The Models tab lists only the models that matter (owner, 2026-10-05:
  "it gets really, really long"): most sessions first, while each has at least 2% of the sessions and
  those shown cover under 95%, never more than 8, and all of them when there are six or fewer. The rest
  go into one "+N more" row with their combined share, which opens them in place and folds them again
  (`foldModels` in `web/src/components/shell/stats.ts`).
- **Analytics and the Instances landing read top down, in gray** (owner, 2026-10-05: "my eyeballs don't
  know what to focus on ... a ton of blue. And no, adding a thousand colors to it isn't gonna help").
  Analytics (`hydra/src/components/AnalyticsView.vue`) leads with four numbers, each with its comparison:
  tokens in the last 7 days against the 7 before (on a 30-day or All window), cost at API rates with the
  same work at your rate under it once a Routing discount is set, saved by HSwarm in the last 7 days
  against the 7 before (it opens HSwarm; the rest of HSwarm's card is behind its info icon), and the
  busiest model with its share. Then cost over time (bars or calendar in one panel), by model, project
  and account, sessions and tokens, what eats tokens, sessions worth a look, tools, busiest hours,
  sessions at once, recurring mistakes, recent edits and the coding tools here. The Instances landing
  ("At a glance", `hydra/src/components/InstancesHomeView.vue`) leads with how many CLI and desktop
  accounts are usable now (signed in, neither limit used up), the pooled 5h and week bars (the CLI
  table's own gauges, in gray), and the accounts nearest their limit, with one warning rule for both:
  amber from 70% used, red above 90%; then CliMayte's and this PC's session numbers, the 24-hour charts, and
  HSwarm by account. On both, every section has a short title with its explanation behind an info icon,
  long lists show their top 5 behind "+N more", charts are gray, and colour means something: Analytics'
  one blue marks the current period or the top item, the landing's accent marks an account at 70% or
  more of a limit, and warning colours only a real warning.
- **HSwarm's Jobs page is short** (owner, 2026-10-05: "the Jobs tab is way too verbose ... a whole task
  results section ... it doesn't collapse or scroll"). An open job is a one-line summary (label, state,
  done / failed / running counts, cost, how long it ran, and the chat that called it, which opens in
  Desk), then its task results, one line per task (a state mark, id, model, cost, the answer's first
  line). The list starts folded past 5 tasks, scrolls in a box of its own and shows 150 lines at a time;
  a line opens its whole answer in a box that scrolls. What the list is for is behind the info icon on
  its heading (`hydra/src/components/hswarm/HSwarmJobs.vue`). CliMayte's page stays built behind the
  tree's other nodes, so its float window stays open, and its node always shows the task list (a Desk
  task link opens the task).
- **Background tasks, as the real app shows them.** The Background tasks panel works for a session
  running outside Desk too (owner, 2026-10-05: "it currently says, 'No running, no finished,' but there
  actually is one running and one finished"): it lists that session's running and finished background
  tasks, a failed or stopped one with an X, and keeps asking while one runs, even when the session itself
  is idle. The title bar's list button, beside the session header's panel button, opens the panel, for
  Desk's own chats too, with a blue count while tasks run (owner, 2026-10-05: "the one that shows me,
  like, background running tasks. Which I have not been able to figure out how to view").
  A chat's finished tasks count under Finished, in Desk's own chats too. The count lives in one
  place, the muted "1 running task · 2 finished" line under the last message; the agents chip that
  repeated it above the composer is gone. A workflow that finished before the latest turn began (a
  finished background task starts a turn of its own) folds into one muted line, as in the real app,
  instead of keeping its card.
- **Stop a background task, or all of them.** Every running row in the Background tasks panel has a
  Stop square, and the Running header has **Stop all** (owner, 2026-10-05: three background commands
  listed running for hours with no way to stop them). Both ask first. A Desk chat's command is stopped
  through its own Claude Code process (`POST /api/chats/:id/tasks/:taskId/stop`, the SDK's `stopTask`)
  and its turn goes on; a task the process no longer runs is marked stopped at once. A CliMayte chat's
  worker takes no message to stop one command, so its Stop stops that worker, turn and all (the dialog
  says so); CliMayte workers in the list are cancelled through AgentHydra as before.
- **Change project.** For a message sent to, or typed in, the wrong folder (owner, 2026-10-05). A message
  of yours has ⋯ in its hover toolbar: Change project, then a recent folder (all but this one) or Other
  folder…, starts a new chat there that sends the same text and pictures with this chat's model, effort,
  permissions and CliMayte setting, and opens it; this chat stays as it is, reply and all. An unsent draft
  gets a ⋯ on the box's top-right corner: the same menu moves the text and pictures, unsent, into that
  folder's new-session box (below anything already waiting there) and opens it, leaving this box empty.
- **Undo takes a message out.** The ↺ button under a message of yours, and under the reply that ends its
  turn, is Claude Code's rewind (owner, 2026-10-05: "I clicked undo ... it just copied it"; it used to be
  Resend, which sent the prompt again). The chat loses that message and everything after it, a running
  turn is stopped, and the message, pictures and all, goes back in the box above anything typed there
  since (or waits as the chat's draft if another chat is open). The next send resumes the session cut
  just before it (`POST /api/chats/:id/rewind {at}`), so Claude no longer knows what was undone; undoing
  the first message starts a fresh session. A CliMayte chat's worker is cancelled and its next message
  starts a new one. A message Desk cannot find in the session file is refused with nothing changed.
- **A message to a working CliMayte chat goes now.** What you send while its worker is mid-turn stops
  that turn and the same session continues with your message first, as Send now on a held bubble does
  (owner, 2026-10-05: "We still can't send messages by hitting send now"). An AgentHydra with deliver-now
  (`POST /api/corch/workers/:id/deliver-now`) gets a plain send and then deliver-now; one without it
  (v1.10.0) gets the one urgent send every AgentHydra has (`/send` with `urgent: true`), so the message
  goes once and never also waits in the queue. Desk asks which it is once per AgentHydra version. A
  message CliMayte already holds cannot go now on an AgentHydra without deliver-now: its Send now says so
  and names the version. A message that could not go now says why in the chat, and a chat held by a
  restart is released once it is seen working again.
- **A CliMayte move reads as one line.** When CliMayte moves a chat to another account, the chat shows
  "CliMayte moved this chat from #164 to #153." and nothing else for it: the prompt the new session was
  started with (the task again, a note to it and the whole handoff) is never shown as your message. A
  handoff with no move (same account) is one muted "Continued in a fresh session" line; messages you sent
  that the earlier session never got to stay as yours. The prompt a moved session goes on with ("This
  session was moved to another account ...") is not shown either; one that went on after a pause, a
  restart or an overloaded API is one muted line ("Continued after AgentHydra restarted."), and a result
  sent back by a failed verdict is CliMayte's note, never your message. Chats already saved read the same way.
- **A chat moving off a signed-out or full account says so, and sends once.** The sign-in or limit line
  is a warning that says the chat is moving to another account and your message goes again by itself,
  instead of a red dead end. The session copy no longer stops the server while it runs (a 555 MB session
  used to freeze every chat and the window for the whole copy). A message you send during the move waits for it and goes to the new
  account after the one being sent again; the same message sent again by hand goes once, with a line
  saying so (owner, 2026-10-05: a chat moved from #103 to #119 went twice).
- **A chat never claims to be empty when it only failed to load.** A chat whose messages did not load (the
  server restarting or stopped) says "Loading messages…", or why the load failed, and asks again every few
  seconds until they come, instead of "No messages yet" until you opened another chat and came back
  (2026-10-05: "did we delete something?"). A message that cannot reach the server says the server is not
  answering instead of the browser's "Failed to fetch".
- **Restart to update.** When Desk 2's server code changes after it started, the Menu button gets a blue
  dot and Menu has Restart to update: it runs `launcher/restart.ps1` for you, the chats keep running and the
  window reconnects. A button that needs newer server code than the running one says so instead of a bare
  "no route" (2026-10-05: Send now, Fork and the servers pane each looked broken until a restart).
- **Small things that stay put.** Closing the tip over a new chat's composer ends the tips for good
  (owner, 2026-10-05: "Those all need to remember if I close them and stay closed"). Over an outside
  session, the line about continuing it says what happens: it continues as a copy on the account CliMayte
  picks when you send, and the original stays as it is. That line now sits clear of the composer below it.
- **A working Claude Desktop chat stays usable.** Over a Desktop chat that is working or waiting on you,
  the composer stays (owner, 2026-10-05: "don't remove the box and just tell me it's working in the
  desktop ... I need to be able to type in it"), under a line saying what the chat is doing. What you send
  goes into that chat's own queue through AgentHydra (`POST /api/external/sessions/:id/message`, on to
  the daemon's `POST /api/sessions/:id/message`) and runs when its turn ends; until the transcript shows
  it, it is listed as queued. Text only: files, pictures and voice are off there. An idle chat still
  continues as a copy, as above.
- **Its own window, opening where you left it.** Desk 2 opens in its own native window,
  `launcher/HydraDesk2.exe` (WebView2, built from `launcher/host`), instead of an Edge app window
  (owner, 2026-10-05: "It loads and then it auto-adjusts itself on the screen ... I want it to load in
  the position that I last left it"). The window is created hidden at the place saved in
  `~/.hydra-desk-2/window.json` (the rectangle it had on screen, so a snapped window comes back on the
  same spot, and maximized if it was), shown once, and never moved after; a saved place whose title bar
  is no longer on a connected monitor falls back to a default on the main one. Its title bar is drawn in the page's background colour, so
  it no longer shows black above it. Its WebView2 data lives in `%LOCALAPPDATA%\HydraDesk2\webview`; on
  the first run the launcher asks the old Edge app window to close and the host copies the page's saved
  settings (the sidebar order and filters among them) from the old window profile.
- **Desk's chats, brought over.** `POST /api/chats/import-desk` (body `{}` for every chat, or
  `{"ids": [...]}`) copies Hydra Desk's own chats (`~/.hydra-desk`, or the folder `HYDRA_DESK_IMPORT_FROM`
  names) into Desk 2 while both run: each chat Desk 2 does not have yet, as Desk saved it (title, folder,
  account, CliMayte worker, archived), with its transcript and the pictures it names. A chat already here
  is left alone, so running it again adds only the new ones (owner, 2026-10-05: "I would love for all of
  these to be transferred to Hydro Desk 2"). A CliMayte chat is the same worker in both windows, so a
  message from either continues it. A chat Desk moved to a fresh session keeps its earlier sessions as its
  own, so they are not listed again as outside sessions, and a chat changes folder as in Desk: only when
  its session really relocated, never for a moment's cd into the home folder.
- **More in the Filter menu.** The sidebar's Filter button now holds what AgentHydra's Sessions ⋯ menu
  has: Refresh, Only this view, Select multiple sessions, then Source, Instance, Queued work, Usage
  limits, Session shape, Archived, Computer and Time period, Reset, and Session settings (which opens
  AgentHydra). The desk list's own filter is still at the top of the same menu.

The server side is two read-only routes over AgentHydra's: `GET /api/cloud/sessions` (the same scope
parameters as AgentHydra's `GET /api/sessions`) and `GET /api/cloud/instances`.

## Planned next

**Dev servers in the sidebar** (owner, 2026-10-06). To start once AgentHydra 2.0 (Desk 2 taking over from the
old AgentHydra window, which is being retired) has finished consolidating. Today DevWebUI is reached only through
a chat's Browser button, and only for that chat's folder; nothing shows every dev server at once. The plan:

- **A fourth title-bar button, Dev servers,** beside Cloud and CliMayte, working like Cloud. On, the sidebar
  lists DevWebUI's projects with their servers under each: a status dot (`statusDot` in
  `web/src/components/servers/logic.ts`), running ones first, Start / Stop / Restart on hover, Start all /
  Stop all on a project's header. Off, the desk list comes back. Blue while on, like the others.
- **Opening a server uses the servers pane that exists.** A click opens the right pane on that server's project,
  its browser and logs, whatever chat is open. `ServersPane` takes a folder today (`cwd`, the chat's), so the
  sidebar hands it `projectDir(project)`. No new screen in the main area.
- **Desk draws it, from the client it already has.** Desk 2 reaches DevWebUI through `/dw/api`
  (`server/src/plugins/50-devwebui.ts`, types in `shared/devwebui.ts`), and `web/src/components/servers/api.ts`
  and `logic.ts` are its one client. The sidebar and the pane read the same project list through one polling loop,
  only while one of them is on screen and the window is visible, so they never disagree. No iframe and no embed
  messages, unlike the AgentHydra button. Turning the view on starts the server manager when it is not running,
  as the pane does.
- **Maybe later, from the CliMayte button's pattern:** a small dot on a chat whose folder has a server running,
  with the view off.
- **First version:** the project and server list, the dots, Start / Stop / Restart, and opening a server in the
  pane with its logs. DevWebUI's own settings and environment editing stay in DevWebUI.
- **Jacob's DevWebUI work goes into Desk 2,** not the old AgentHydra window (`../web`). The seam is the `/dw/api`
  contract in `shared/devwebui.ts`: if DevWebUI's daemon moves into AgentHydra's, only where the plugin finds it
  changes (`DEVWEBUI_URL`, or `runtime.json` in `DEVWEBUI_HOME`), not the sidebar. Agree that with him before
  building.
- **Checks:** unit tests for the list's order and grouping beside `logic.ts`'s, gesture cases for the new button
  and a server row in `e2e/gestures.e2e.ts`, then `bun run build` and `bun run e2e:gestures`.

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
waits for it to answer, then opens Hydra Desk in its own window (`launcher\HydraDesk2.exe`, which needs
the WebView2 runtime that ships with Windows 11), with its own taskbar entry. Clicking it again just brings the window forward; it
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

`bun e2e/stream-frames.e2e.ts` streams a long reply (an em dash, a 240-line TypeScript block) into the transcript in headless chrome-headless-shell and writes `tmp/stream-frames.json`: frames over the 8.33 ms budget, style recalcs, layouts and DOM mutations per chunk (needs `bun add -d puppeteer`).

`bun run e2e:gestures` (after `bun run build`) starts the built window as a hidden server on 7819 with a
throwaway home and drives headless Edge through CDP input: one fresh page per case, the FIRST gesture (tap,
long-press, press, move-then-press, right-click, Enter, hover, focus) on a never-touched tooltip, menu, popover,
sidebar row or toggle, judged by what the control did. It reads AgentHydra's daemon and acts on no account. 39
cases in about 4 minutes; PASS/FAIL per case, aria-labels only, exit 1 on any FAIL. `GESTURE_ONLY=pane|desk` and
`GESTURE_WHAT=<text>` pick cases, `GESTURE_TRACE=1` prints each case's pointer, focus and click events. Run it after
any change to a tooltip, menu, popover, sidebar row or lazy overlay.

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
  - `window.json` where the window was last left (written by `launcher\HydraDesk2.exe`)
- `%LOCALAPPDATA%\HydraDesk2\webview` the window's WebView2 data (the page's saved settings live here).

## The SDK

Chats run through `@anthropic-ai/claude-agent-sdk` 0.3.288. Each chat is a long-lived SDK session with
your Claude Code settings, CLAUDE.md files, hooks and MCP servers loaded as Claude Code would load them.

## How it plugs into AgentHydra

AgentHydra is the daemon on http://127.0.0.1:7787 (the parent folder of this one). Hydra Desk reads from
it, and works without it:

- **Accounts.** A new chat runs on the signed-in Claude account with the most room left, picked from
  AgentHydra's accounts, or on your default login.
- **CliMayte.** Every chat gets AgentHydra's MCP server, so it can hand work to CliMayte workers on any
  account, and HSwarm sends a tool-using task there by itself when AgentHydra's cost model says the
  subscription is the better buy. The CliMayte page of AgentHydra's HSwarm tab lists the workers, and
  each chat lists its own in the sidebar.
- **Elsewhere.** The chats running in Claude Desktop or the Claude CLI show in their own list with
  their status, and you can adopt one into Hydra Desk.

If AgentHydra is not running, the window says so in a banner and those lists stay empty; your own chats
keep working.

## Free instances

**Instances → Free** is the same card, header, table and rows as the CLI and desktop instances (kind
`free` in `hydra/src/lib/instance-table.ts`; usage in the same 5h and Week cells, sort and filter as
theirs). Its + menu offers Claude or ChatGPT; name the login, and Desk prepares the tools, then opens a
visible window for manual sign-in while the row pulses. Multiple logins to either provider have separate encrypted state. The ClaudFree 0.7 harness
is bundled in `server/src/free-instances/harness`; no external checkout or folder picker is needed.
Python 3.11+, Bun and Node.js must be installed. Dependencies are prepared automatically outside the
repo in `~/.hydra-desk-2/free/runtime`. Instance state lives in `free/instances/{instanceId}` and metadata
in `free/accounts.json`. A previous `free-instances.json` connection is imported once, copying its
encrypted login and registry without removing the original files. Nothing of a login is ever kept in
the repo: the bundled harness keeps its state in the profile even when run by hand, and `*.dpapi` is
ignored.

**The logins reach the other PCs** through AgentHydra's Login sync (owner, 2026-10-06), when it is set
up and on: the same store, key and token, read from the AgentHydra daemon on this PC, in the store's own
`free` table (`server/src/free-instances/sync.ts`, `cloud/login-sync-worker`). Each Free instance is one
row, sealed with the sync key; only its cookies travel (they are the sign-in), sealed again on each PC
for its own Windows user. The newer sign-in wins (the one whose sign-in cookie expires later); an account
another PC added appears here with its number and name and is checked at once; a log out reaches every
PC still on that login. A pass runs 15 s after start, every 2 minutes, and right after a sign-in or a
log out; `GET /api/free/sync` says when it last ran and its last error. A PC takes part once it runs
Desk 2 with this feature and its AgentHydra is joined to the same Login sync.

The table provides login checks, usage, renaming and New private chat. Conversations live under
**HSwarm → CliMayte**, alongside its task list, with their own private-chat detail and transport.
The detail supports UUIDs, reading, follow-up messages, extracted code, citations and opening by UUID.
**Sign in** opens a visible browser; normal messaging uses HTTP, without a browser fallback.
Usage counters that the provider does not expose stay unknown, and
historical usage readings retain their observation and reset times. Free web accounts use their own
allowances and are not Claude Code, Codex CLI, or HSwarm execution accounts.

ChatGPT messages use only **GPT-5.6 Luna Instant** (`gpt-5-6-mini`). Its usage check reads the account
plan and available models over HTTP. When it verifies Free access to this model, the table shows
**Unlimited** for everyday text, as described in [OpenAI's Free plan](https://chatgpt.com/pricing/).
Abuse safeguards and separate limits for uploads, images, voice and other tools still apply. This
is a plan policy, not a measured remaining-message count; unverified accounts stay Unknown.

For local automation, `GET /api/free/status` reports instances and jobs; `POST /api/free/instances`
accepts `{provider, name}` and returns the instance UUID. `PATCH /api/free/instances/{instanceId}`
renames it with `{name}`. `GET /api/free/threads` lists chat metadata including instance, local and
server UUIDs. `POST /api/free/jobs` accepts a unique `requestId` UUID, `instanceId`, matching `provider`
(`claude` or `chatgpt`) and `command` (`auth`, `usage`, `chats`, `read`, `chat`, `resume`, `track`, `login`). Messages
use `prompt`; `read`, `resume` and `track` require an explicit `chatId` UUID. `name` is optional for new
chats and required for tracking. Claude messages also accept `webSearch`. Poll
`GET /api/free/jobs/{requestId}` until `state` is `done`, then inspect `result.ok` and `result.error`.
The job's `phase` distinguishes automatic setup from the operation. `DELETE /api/free/jobs/{requestId}`
cancels its owned process, including a login window. Requests from another browser origin are refused.
Prompts travel to the subprocess over stdin; credentials and filesystem paths never reach the UI.

Only one operation per instance runs at a time. Repeated POSTs with the same request UUID and payload
share the existing job while it remains cached; no operation is automatically resent. Job results live
in memory for at most 15 minutes, bounded to 16 jobs, and disappear on a server restart. A lost job or
interrupted send means refresh the tracked chats and read the relevant UUID before deciding to send
again. The harness's chat handles survive restarts; provider retention still limits their lifetime.
Desk does not write Free transcripts to its normal SDK chat store.

This folder is part of AgentHydra's public repo: everything committed here is published.
