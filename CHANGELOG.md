# Changelog

All notable changes to AgentHydra are documented here. Entries up to v0.13.0 were written when the
project was called CC Manager UI and are left in its name, because that is what shipped. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**TL;DR**

- **AgentHydra 2.0: the new window (it was Hydra Desk 2) now comes in the download on Windows, Linux and macOS**
- **Opening AgentHydra always reaches the new window, and starts it when it is down**
- **Updates install, update and repair the new window, and an install without it fixes itself**
- **Dev servers run once for every chat: AgentHydra reuses one that runs instead of starting a second**
- **A Dev servers button lists your projects and their servers in the sidebar**
- **Free accounts get a Tokens column and keep their readings current in the background**
- **HSwarm's tables look like the Instances tables, and popups close when you look away**

**Everything in 2.0.0**

### Added

- **AgentHydra 2.0: a new window, in the download on every platform.** The window that was Hydra Desk 2 is now
  AgentHydra's, and the download carries everything it needs to run: on Windows it opens in its own window from
  the AgentHydra shortcut or the tray icon, on Linux and macOS in your browser. It brings every chat from this PC and your other PC into one sidebar, AgentHydra's accounts,
  CliMayte, HSwarm and Analytics pages beside the chat with one Settings dialog, dev servers and a small browser,
  Free claude.ai and ChatGPT accounts, and pictures and videos in the chat.
- **A Dev servers button in the title bar.** It lists your projects and their servers in the sidebar, where you can
  start, stop and open them.
- **Chats share dev servers instead of starting their own.** Every chat, and every other Claude session on the PC,
  gets tools to start a project's dev server through AgentHydra: when that server already runs, whoever started it,
  they get its address instead of a second copy fighting the first for its port.
- **Forget a Free thread.** A thread can be removed from AgentHydra's Free list. The chat itself was private, so the
  site never kept it.
- **The Free table has a Tokens column, like the CLI and desktop tables.** Neither claude.ai nor ChatGPT reports
  tokens, so AgentHydra estimates them from the text each message sent and got back. The header switches between
  the current 5-hour window, the week and all time.

### Changed

- **Opening AgentHydra always leads to the new window.** The tray, the shortcut and every AgentHydra page open
  it. When it is not running, AgentHydra starts it and shows a short "Starting AgentHydra" page that moves on by
  itself, instead of a page that never loads.
- **Updates carry the new window.** An update installs, updates and repairs the new window along with the app, and starts the window again afterwards. An install that is missing the window, such
  as one updated by an older version or the single `.exe` download, puts it back by itself when it starts.
- **HSwarm's key and model tables look like the Instances tables.** They use the same rows, controls and cards.
- **The Free table no longer spins its 5-hour and week cells every time you open it.** AgentHydra now keeps the
  Free accounts' readings current in the background, one account at a time, and the table only shows what changed.
- **Dev servers are part of AgentHydra now, not a separate program.** They run in AgentHydra's own small background
  process, which you can restart or stop from Settings without touching AgentHydra, and which keeps your servers
  running when AgentHydra restarts. A server that already runs on its port is used as it is, never killed to make room.
- **Every change to the new window is tested.** Its own test suite now runs with the rest on every change.

### Fixed

- **A Free account no longer shows as signed out after a check that merely failed.** Only the site saying the login
  is gone signs it out; being offline for a moment does not.
- **Tooltips and usage popups no longer pile up while the window is not focused.** Hovering AgentHydra while another
  app had focus left every popup the pointer passed on screen.
- **The keepalive dot on the 5-hour counter is quieter.** It is half as bright and sits a little further in.
- **Dev servers start on every PC.** They failed to start where another copy of Bun was found first; they now run
  on the window's own.

### Removed

- **The old AgentHydra window.** Where the new window is installed, AgentHydra no longer shows the old one.
- **The separate DevWebUI copy.** Its own background program, tray and settings are gone; its projects carry over.

## [1.13.0] - 2026-10-06

**TL;DR**

- **CliMayte workers wake the chat that dispatched them when their work finishes**
- **Workers' time estimates are now calibrated by estimate size for better predictions**
- **CliMayte tracks and reviews all worker time estimates to improve future accuracy**

**Everything in 1.13.0**

### Added

- **A chat that dispatched CliMayte work is notified when it finishes.** When a worker completes its task, the chat that sent it is woken and shown the results, rather than waiting until you check on it manually. Multiple workers finishing around the same time notify you once instead of interrupting repeatedly.

### Changed

- **Worker time estimates are calibrated by their size, not one flat multiplier.** Estimates under 10 minutes ran accurately; 10-to-20-minute estimates actually took 60% of the time predicted; 40-minute and longer estimates took only 20-25% of the predicted time. The system now adjusts differently for each band based on actual performance.

- **Every worker time estimate is logged and reviewed.** The system tracks every estimate alongside how long work actually took, and when an estimate misses badly (over 50% off either way), it asks why and uses that feedback to improve future predictions.

- **The time-estimate prompt helps workers be more accurate.** Instead of rounding estimates to the nearest 10 minutes, workers now count tool calls at 10 seconds each, add the real time for slow commands, and write the unrounded sum.


## [1.12.0] - 2026-10-06

**TL;DR**

- **Send work to Free accounts (Claude.ai and ChatGPT free web logins)**
- **Free accounts check themselves on load and can be deleted**
- **Free accounts can keep their 5-hour window running between sessions**

**Everything in 1.12.0**

### Added

- **Chats can send work into Free accounts.** You can now dispatch CliMayte work to your free Claude.ai or ChatGPT.com web accounts in addition to your CLI and desktop accounts. Work spreads across all idle free accounts and both providers, and threads in those accounts remember what you told them across messages.

- **Free accounts self-check on open.** Each free account is checked when you open the Free table if it hasn't been checked in the last 15 minutes.

- **Free accounts can be deleted.** A free account's login, chat list, and chat handles are removed from AgentHydra and synced off your other PCs. The account's chats remain on Claude or ChatGPT.

- **Free Claude accounts can stay signed in.** When a free account's 5-hour window ends, a brief keepalive chat is sent to hold it open so it doesn't sign out. You can turn this on per account and set a threshold (like 85%) to stop sending keepalives if usage is already low.

### Changed

- **CliMayte hands work to a fresh session at 200k tokens instead of 150k.** Measured testing showed that 200k was the most efficient point to hand off conversation context, saving token cost without losing performance.

- **Analytics shows where weight goes.** A new row breaks down replies and thinking separately from cached context reads, so you can see what is actually expensive.

- **CliMayte's Waves are their own section.** Waves now appear in a dedicated subsection below CliMayte instead of on the same page.

- **CliMayte grades how bad a failure was.** Failures are now scored as small fixes (slight rework), rework (substantial changes needed), or truly failed (doesn't work at all). Trust scores now reflect these grades instead of treating all failures the same.

- **Free accounts name themselves.** After signing into a free account, its display name is pulled automatically from the account name or email instead of you having to type one.

- **Free sign-in runs on your installed browser.** Free accounts now sign in through installed Chrome or Edge instead of downloading a separate browser, saving disk space.

### Fixed

- **Free threads' "last used" time is accurate.** The chat list no longer resets all thread timestamps whenever it loads.

- **Every Free account can chat again.** Fixed issues where some ChatGPT accounts and free Claude accounts couldn't send messages properly.

- **HSwarm instructions fit.** Instructions were too long and got cut off; they've been shortened while keeping all the important guidance.

- **A second free Claude login no longer fails.** The login process now handles multiple free accounts correctly.

- **HSwarm daily stats stay organized.** Per-day stats no longer group incorrectly.


## [1.11.0] - 2026-10-05

**TL;DR**

- **CliMayte tasks are sealed: they run with only the servers they need**
- **HSwarm jobs show in your sessions and folders alongside CliMayte tasks**
- **Sub-items in the sidebar can be shown as a list or as a count badge**
- **API keys and subscriptions can be compared for cost**
- **Desktop chat sync is view-only from other PCs**
- **CliMayte uses cheaper models for read-only work**

**Everything in 1.11.0**

### Added

- **A sealed CliMayte task runs with only what it needs.** You can now lock a worker's system prompt, MCP servers, tools, and prompt, and it launches with nothing else. This cuts startup overhead and tokens spent on unnecessary servers.

- **HSwarm jobs appear next to your sessions.** Jobs show in your sessions list and sidebar, grouped under their calling chat, so you see all your work in one place.

- **Filter sidebar items by type or count.** CliMayte tasks and HSwarm jobs can each show as a list (one line per item) or a count badge, so you control how much space they take.

- **Cost model compares API keys and subscriptions.** A new Routing page shows which provider is cheapest for your work: measured subscription cost versus your own API key rate, with a configurable split and discount when you have a bulk rate.

- **HSwarm can run work on a Claude subscription when that's cheaper.** A tool-using task runs on your subscription if it costs less than your API key, and the result shows which provider was used.

### Changed

- **Desktop chat sync is now one-way and view-only.** Chats from another PC sync down so you can watch them, but can't continue them or send messages back. If you start a two-way sync and turn on view-only mode, existing chats are archived on that PC and moved to a viewer folder on yours.

- **CliMayte reads cheaper models for read-only work.** Inspection, review, and similar read-only work now runs on a cheaper model pick instead of always using Opus, and the system learns which models work best for each kind of work.

- **CliMayte uses measured plan sizes.** Max accounts are now sized at 4.75 and 19 Pro windows, not 5 and 20, based on real measurements.

- **Running work shows inline in folders.** A running CliMayte task or HSwarm job now appears as a row in the folder where its chat lives instead of in a separate list.

- **Running tasks pulse slowly in the sidebar.** Pulsing animation is slower and uses less power.

### Fixed

- **Hydra Desk 2's server tests no longer touch your real project folder.** Tests now use a temp folder so your chats aren't affected.

- **A CliMayte wave that finished without reporting is reported anyway.** Waves that got stuck `running` are now forced to report their results.

- **Sidebar rows no longer pop in and out by themselves.** HSwarm jobs no longer bounce in and out of the recent chats list as they run.

- **Workers have the Connections MCP server again.** Workers now get the Connections server so they can use memory tools and boards like the owner's chat can.


## [1.10.0] - 2026-10-05

**TL;DR**

- **Auto-update is on by default**
- **Desktop chat sync is on by default for all PCs**
- **Another PC's CliMayte tasks appear under their chat**

**Everything in 1.10.0**

### Changed

- **AgentHydra auto-updates by default.** New installs now have auto-update enabled, so you stay current automatically instead of having to manually click Update.

- **Desktop chat sync is on by default.** All PCs in a login sync now share their visible desktop chats by default, rather than requiring each PC to opt in.

- **Another PC's CliMayte tasks appear under their chat.** When syncing CliMayte queues between PCs, tasks now show under the chat that dispatched them instead of in a separate list.

### Fixed

- **A restarted daemon keeps its own identity.** Restarts no longer lose the daemon's unique id.

- **A daemon that dies at startup says why.** The log now records why the daemon exited instead of leaving no record.


## [1.9.2] - 2026-10-04

**TL;DR**

- **CliMayte workers use 1 MB native runner instead of 175 MB Bun per worker**
- **Daemon no longer re-reads transcripts every 12 seconds**
- **Process scanning is in-process instead of spawning PowerShell**
- **Hydra Desk reads fewer files and polls more intelligently**

**Everything in 1.9.2**

### Changed

- **CliMayte workers use a lightweight native runner.** Each worker's CLI now runs under a 1 MB Rust program instead of a 175 MB Bun runtime, cutting memory per worker from 175-191 MB to under 1 MB.

- **The daemon stops re-reading the same transcripts.** Session searches no longer re-read all 425 MB of old transcripts on every 12-second pass when looking for links.

- **Process table reads are now in-process.** The daemon no longer spawns PowerShell to scan processes; it reads them natively in about 13 ms instead of multiple seconds.

- **Hydra Desk works lighter while chats run.** The composer's git poll is now one command instead of six, and transcript reads start from where they left off instead of re-reading the last 8 MB every 3 seconds.

### Fixed

- **A moved chat continues its work mid-turn.** Moving a chat to another account while it's running now continues properly instead of stopping.

- **Big sessions hand off cleanly.** Sessions over 150k tokens are now condensed to 16k for handoff instead of being copied in full.


## [1.9.1] - 2026-10-04

**TL;DR**

- **Workers can ask their parent chat a question and wait for the answer**
- **Workers get the owner's MCP servers and Connections again**

**Everything in 1.9.1**

### Added

- **Auto-resume throttles back when it produces nothing.** After two empty resumes in a row, the next resume waits 2 minutes, doubling up to 30 minutes per further empty one; a real turn or typed message resets it.

### Changed

- **CliMayte chat workers** are now a first-class feature: a task with `chat: true` runs one of your own interactive chats headless, keeping your full skills and MCP servers, with your own system prompt instead of the lean worker one, and Opus xhigh effort unless you name something else.

### Fixed

- **CliMayte workers no longer see the wind-down signal inside sub-agents.** Wind-down signals now only fire in the worker itself, not inside sub-agent calls.

- **Workers get the owner's MCP servers, including Connections.** Workers now receive stdio servers and the Connections MCP, fixing a 15-minute cache that was blocking them.

## [1.9.0] - 2026-10-04

**TL;DR**

- **Send work to a worker or move it to another folder**
- **CliMayte learns which model works for each task kind**
- **Chats can run as CliMayte workers keeping their full skills**
- **Workers wait for memory before starting**
- **HSwarm ledger rotates monthly**

**Everything in 1.9.0**

### Added

- **A worker can be moved to another folder.** Dispatch a task to a new folder and the worker's session moves there on its next launch, carrying its progress.

- **A CliMayte worker can ask its origin a question.** Workers can call `climayte_ask` to post questions to the chat that dispatched them and wait for answers, instead of guessing.

- **CliMayte chat workers.** A task with `chat: true` runs one of your own interactive chats headless, keeping your system prompt, all your skills and MCP servers, and high reasoning effort.

- **CliMayte starts a worker only when the machine has memory.** Work waits to start if RAM falls below 8% or commit below 5%, with workers counted as 0.75 GB each. Linux reads MemAvailable; macOS is not gated.

- **HSwarm's ledger rotates monthly.** Old months move to gzipped archives; stats read the archives they need, so totals stay the same.

- **All of a PC's ZSwarm history moves into HSwarm.** A one-shot import copies stats tables, ledger, routing decisions, and job records; keys and secrets stay behind.

- **HSwarm overview shows model results.** A new section shows pass/fail per model, cost per successful task, edit survival rate, and tasks per day.

- **One CliMayte + HSwarm stats card.** CliMayte and HSwarm results appear together on one card so you see your total progress.

- **Every signed-in CLI account shows whether it has a limit reset.** A daily background check runs `/limit-reset` on accounts not checked in 24 hours.

### Changed

- **A CliMayte worker starts far fewer processes.** The wind-down hook is now an http hook on the runner, cutting processes per call from 6.7 to none. The edit-claims hook runs as a direct Python call instead of through a shell.

- **ZSwarm is retired; HSwarm replaces it.** All references to ZSwarm now point to HSwarm. The session source id stays `zswarm` for compatibility.

- **The wide toggle is one setting for every page.**

- **Waves stay closed until opened.**

- **Sessions and CliMayte share one sidebar.**

### Fixed

- **A worker dispatched from a CLI instance is tied to that chat.** Caller lookup now searches every CLI instance's config dir.

- **The nearest chat in the calling process chain is the caller.** The chain is now matched nearest process first across every home.

- **Login sync no longer scans every process each pass.** Scans only run on first need, at most once per pass.

- **A browser page cannot read a CliMayte worker's wind-down signal.** The runner's loopback server refuses browser Origins.

- **A stalling daemon names the functions that stalled it.** Sampling profiler output is added to SATURATED lines.

- **The switch-card watchers stay small.** Watchers no longer walk every UI element constantly; they now ask only for button names and garbage-collect past 400 MB.

- **A switch-card watcher presses only a card's own Allow once.** The climb to find a card stops at containers with more than 8 buttons.

- **CliMayte workers' shells start faster.** Workers start with `TERM=dumb` so Git Bash doesn't run expensive aliases.

- **The daemon no longer freezes while killing processes.** `killProcessTrees` now runs async instead of blocking.

- **HSwarm's fast transcript scanners are back.** Native scanners in Rust and Go are restored with A/B bench.

## [1.8.0] - 2026-10-03

**TL;DR**

- **Dispatching chat is pinged when work settles**
- **Login sync store uses 95% fewer reads on idle PCs**
- **Shared desktop chats no longer fill the login-sync store**
- **Two PCs can share visible desktop chats privately**

**Everything in 1.8.0**

### Added

- **Chats are pinged when their work settles.** A chat that dispatches CliMayte work is notified when tasks finish, fail, get verdicts, or move accounts. Notifications batch in groups and retry for 2 hours, then reach the composer or a toast, with counts in the next status check.

- **Login sync store reads plummet on idle PCs.** A new changes-since route means idle PCs read one row instead of three lists. The store increments a revision on every write, and PCs track the latest, so they only fetch what changed since last check. On a simulated idle hour with two PCs, reads went from 5,400 to 61.

- **Desktop chats sync privately between two PCs.** A new chat-sync toggle sends this PC's visible chats encrypted through login sync. The other PC sees them with that PC's name, compressed and encrypted under the sync key.

- **Archive old shared chats to free space.** Chats archived 3 days ago leave the login-sync store (both PCs keep their local copies). The store caps at 400 MB; when full, chats stop syncing with a "no more room" message.

- **Clear usage stats from any account's menu.** A new action blanks the 5-hour and weekly numbers on a row (sign-out), with no deletion from history.

- **Fixer functions that only tests call fail CI.** Functions like `sweep*`, `reassert*`, or `run*Once` that appear in no production code are caught by a new guardrail.

### Changed

- **CliMayte never waits more than 5 minutes for room or reset.** A limited task moves to another account unless its own resets within 5 minutes. Rooms or pace holds last only if a reset is within 5 minutes. When no account has the needed room, work starts on the one with the most space (if at least 10 Pro-points are left), then hands off at the stop line. Accounts run 4 workers per Pro window up to 8.

- **Release tag push takes seconds, not 25 minutes.** The pre-push hook now checks for a successful CI run on the commit instead of running the full check suite again.

### Fixed

- **Chat titles are kept when moved.** A chat moved to a running target now has its title reasserted.

- **Per-instance routes only act on known instances.** Routes like `/api/instances/:dir/open` now resolve against the instance list, not the daemon's working directory.

- **Two daemons no longer run on one store.** A frozen daemon is no longer replaced; the MCP reads which daemon serves it.

- **Dispatch is idempotent.** The same group sent twice within 10 minutes returns the existing workers.

- **Workers have the Connections MCP.** CliMayte workers get the owner's MCP servers (minus AgentHydra's), so `connections_execute` works.

- **Worker settings never carry credentials.** Secrets in URLs or header literals are filtered out, and the MCP files are cleaned up when the worker ends.

## [1.7.0] - 2026-10-02

**TL;DR**

- **Two PCs can share their CliMayte queue with encryption**
- **Reset notifications for CLI accounts are gone**
- **CliMayte re-reads account usage before placing new work**
- **CliMayte starts work on accounts with available capacity**
- **Restart no longer waits for running work**

**Everything in 1.7.0**

### Added

- **Two PCs can share their CliMayte queue.** Enable a new toggle to sync your work queue between PCs with encryption, so both machines see running tasks and don't duplicate work.

### Changed

- **CLI account reset notifications are turned off.** You no longer get notifications every time a CLI account's usage window resets, since CliMayte runs dozens of accounts around the clock.

- **CliMayte re-reads usage before placing work.** Before sending a task to an account, the system checks its current usage to avoid overloading it mid-task, and an account with a fresh read takes only one worker until results come back.

- **Work placement on full accounts is reported separately.** When a task starts on an account already past the usage ceiling, it now shows as "placed past ceiling" instead of as a failed stop.

- **Restart no longer waits for running work.** CliMayte's checks now run detached, so restarting AgentHydra doesn't block on them; any running work continues in the background.

- **The CliMayte list shows active time, not queue time.** Each task displays how long it's been actively running instead of how long it waited for an account.

- **CliMayte balances work between 85% and 90% of usage.** At 85% an account takes no new work; at 90% running work is stopped to prevent overages.

- **CliMayte starts work on accounts with room.** Instead of waiting on one account, the system tries each account in order and starts work as soon as one has capacity, so tasks don't sit idle while other accounts have space.

### Fixed

- **Every quota check shows available CliMayte capacity.** The usage API now returns how many accounts are idle and available, so agents can see the room before dispatching work.

- **Cancel in a task's first second stops its CLI.** A task cancelled immediately after starting now properly kills the worker instead of letting it run.

- **Detached checks are safe if the daemon crashes.** Check results are saved before execution starts, so work and results survive daemon restarts.

- **CliMayte knows every account's reset times.** Accounts' weekly reset times are now tracked accurately so pacing decisions are correct.

- **CliMayte refuses tasks that could never run.** Tasks with invalid account IDs or malformed lists are rejected upfront instead of waiting forever.

- **The CLI tab keeps its usage current.** Usage numbers update on their own instead of waiting for a manual check.

## [1.6.0] - 2026-10-02

**TL;DR**

- **CliMayte skips accounts someone else is actively using**
- **Tokens are tracked by the account that did the work**
- **One sign-in works for both desktop and CLI accounts**
- **Desktop logins sync between two PCs**
- **Finished work can be reviewed and judged in one go**

**Everything in 1.6.0**

### Added

- **CliMayte avoids accounts in active use.** Before starting a task, the system checks if anyone is using an account's desktop app in the last ten minutes or running other chats there, and skips it in favor of idle accounts.

- **Tokens belong to the account that earned them.** Usage is now credited to the account signed in when the work happened, so moving an account to sign in as someone else moves the token count with it.

- **One sign-in for both desktop and CLI.** Signing in a desktop account on the CLI tab gives you a linked CLI instance straight away, with no separate login needed.

- **Desktop logins sync between two PCs.** A Claude Desktop login on one PC automatically signs in on the other PC's matching profile, keeping both in sync without needing to sign in twice.

- **Review and judge finished work in one view.** A report shows each finished worker in one row: its status, what it used, how it ran, its verdict and what it did, and you can give several workers the same verdict in one call.

- **A demo of the app with invented data.** The built web app runs over made-up data so you can click around without a daemon, useful for testing.

### Changed

- **The CLI accounts table is as long as its rows.** Instead of scrolling inside a third of the window, the table grows to fit its content and the tab scrolls instead.

- **The Login sync dialog is one switch.** Turn sync on or off for all logins at once, with a simple view of which are syncing and when they last synced.

- **Descriptions are hidden behind info bubbles.** Long explanations moved into the (i) bubble beside headings instead of taking up page space.

- **The CLI table header is icons.** Login sync, Keep windows running, and other controls are now icon buttons in the header with tooltips.

- **Each page's settings live on that page.** Settings specific to Sessions, the CLI, or CliMayte are now on those pages instead of in the main Settings panel.

### Fixed

- **A failed desktop-to-CLI login feed no longer stops the daemon.**

- **Dialogs are as wide as they ask to be.** Ten dialogs that set their own width now display correctly instead of being forced to 384 px.

- **The create button on instance tables no longer flickers.** It's now an icon with a tooltip instead of a label that causes layout jumps.

- **The Instances table no longer scrolls sideways.** Layout adjusted so the table fits at normal window width.

- **Escape closes dialogs on the Sessions page.** The page no longer captures Escape when a dialog is open.

## [1.5.0] - 2026-10-01

**TL;DR**

- **CliMayte learns which model works best for each task type**
- **Restarting AgentHydra no longer stops CliMayte workers**
- **One unified Instances table for all account types**
- **Paid extra usage is blocked by default**
- **Tasks split across accounts automatically**
- **Quick sign-in by email without needing a terminal**
- **Keep idle CLI accounts in their 5-hour window**
- **Copy or move logins between PCs with encryption**
- **Sync CLI logins between two PCs automatically**

**Everything in 1.5.0**

### Added

- **CliMayte learns which model each task type needs.** Give work a thumbs up or down to teach the system which model works best for that kind of task. Tasks with "auto" model now run on the cheapest setting that keeps passing, with occasional tries at cheaper models, and "What works" shows pass rate and cost.

- **Restarting AgentHydra no longer stops CliMayte workers.** Each worker's CLI runs under its own runner outside AgentHydra, so workers keep running through restarts and updates.

- **One Instances table for all account types.** Claude Desktop, Codex, and DeepSeek accounts are now in one table with a Provider filter, and the new CLI tab holds Claude CLI instances alongside CliMayte.

- **Paid extra usage is blocked by default.** Some Claude accounts have "extra usage" billing on. A new Settings switch "Allow paid extra usage" is off by default, and AgentHydra stops sessions before they can bill when it's off.

- **CliMayte splits tasks across accounts automatically.** Tell CliMayte a task and it splits the work across your CLI accounts and checks the results, moving workers to another account when one hits its limit.

- **Quick add: sign in by email with no terminal.** Type an email, confirm the sign-in in your browser, and you have a ready CLI instance. No typing into a terminal or running a login command.

- **Keep idle CLI accounts in their 5-hour window.** Turn on "Keep windows running" to send a tiny keepalive message to idle accounts so their 5-hour usage window is already counting down when you need it.

- **Copy or move CLI logins to another PC.** Save a login to an encrypted file with a passphrase, or move it (signing this PC out) so one login isn't refreshed on two machines.

- **Sync CLI logins between two PCs automatically.** Connect both PCs to a small Cloudflare Worker, and when one PC refreshes a login, the other picks up the new one within a minute instead of signing out hours later.

- **Each instance shows every account it's been signed into.** A history button lists accounts in order of last use, showing which instance each is signed into now and which ones it's passed through.

### Changed

- **A signed-out account keeps its last usage numbers.** Instead of blank, a signed-out row shows the last reading dimmed, so you remember how much of that account's window was used.

- **CliMayte starts tasks where they can finish.** Before sending work, the system counts what's left on each account and what similar tasks usually cost, so tasks don't start mid-fill and move partway through.

- **CliMayte sizes tasks before sending.** Tasks bigger than half a window are sent back with how many pieces to split into; smaller ones wait for room instead of starting and moving mid-work.

- **The CLI tab fits the window.** On a wide screen, the accounts table folds away and CliMayte's task list fills the space, each scrolling inside itself.

- **CliMayte tasks no longer leave programs running.** Developers servers and watchers that a worker started are stopped when the task ends.

- **CliMayte's cost estimates learn from every finished task.** Instead of counting only tasks with a thumbs vote, the estimates blend in all finished work, pulling predictions closer to reality.

- **CliMayte works each account between 85% and 90%.** At 85% an account takes no new work and running tasks are asked to hand off; at 90% they're stopped.

- **CliMayte stops accounts at 85% and never runs into limits.** Tasks start only where they're expected to finish under 85%, avoiding overages.

- **CliMayte shows what every run cost.** Each run of a task keeps its own cost, requests, and tokens, including stopped runs, so you see how much restarts cost.

- **Token budget matches the plan meter.** Weights are now fitted to how the plan meter actually charges tokens, so budget estimates are more accurate.

- **CliMayte workers use the 5-minute prompt cache.** Workers switched from the 1-hour cache to save on cache-write costs.

- **CliMayte workers carry a short rule set.** Workers get a small system prompt and skill list (about 3 KB and 12 skills instead of 44 KB and 84), cutting tokens per step.

- **Every account row looks the same.** Codex and DeepSeek rows now show the same layout as Claude rows, with consistent icons and labels.

- **The orchestrator's remote dashboard moved to port 7793.** The old port conflicted with ZSwarm's MCP server, so it was moved and centralized.

- **The chat journal no longer re-reads every chat every five minutes.** Only chat records are scanned and they're reused if unchanged, cutting CPU use from 3.7 seconds to 0.2 per pass.

- **Accounts are remembered after moving instances.** Older entries in login history now show the account name straight away instead of "(unknown account)".

- **The daemon stops re-reading whole chats.** Only new content is read when transcripts change, cutting CPU use per new turn from 93 ms to 0.8 ms.

### Removed

- **The "Startup cost per new chat" panel.** This panel added no value since nothing used its numbers.

### Fixed

- **The CLI tab no longer scrolls as a page.** Task row labels no longer extend the tab height to 4,777 px.

- **CliMayte stops every worker on an account at the same moment.** Workers now see the newest usage reading for their account across all workers, not just their own.

- **A new or silent account gets one task first.** An account with no usage reading takes only one worker until that worker's first request reads it.

- **CliMayte's numbers for a night are that night's.** Totals now cover only runs since the requested time, not the whole record.

- **Workers take part in shared edit warnings.** Each worker runs the edit-claims hook, so you're told if another task touched a file.

- **CliMayte's token count is right and says what it counts.** Each run now records its own session so totals are accurate.

- **CliMayte no longer bounces tasks between nearly-full accounts.** Handed-off tasks wait for real room instead of hopping between accounts that are about to run out.

- **An account whose org turned Claude Code off is left alone.** The system stops retrying such accounts and stays out until they sign in with another login.

- **Accounts at their limit read "Limit".** The UI now shows the right usage percentage for accounts at their ceiling.

- **Usage numbers no longer lag behind busy CLI accounts.** Accounts with running CliMayte tasks show live readings instead of data from 30 minutes ago.

- **Deleting a Codex instance no longer fails with "resource busy or locked".**

- **Auto-resume picks sessions back up after weekly limit resets.**

- **Auto-resume times desktop chats by their own account's window.**

- **Sonnet 5 is costed at $2/$10 after September 1.** Pricing was corrected to match Anthropic's actual rates.

- **README screenshots show the current app.** Capture script fixed so images show the latest UI and models.

- **The session index costs a eighth of the CPU.** Only transcripts modified in the last hour are re-checked on refresh.

- **The background daemon no longer spikes CPU every five minutes.** Chat-title scanning now remembers records instead of re-reading all of them.

- **Claude Desktop updates again.** The version check now runs Claude's own updater so the app stays current.

- **Claude from the Start menu is no longer stuck on an old build.** The shortcut is updated to point at the real install.

- **`claude://` links and the browser extension find Claude after updates.**

- **Archiving a chat inside running Claude Desktop works again.**

- **`archive_desktop_chat` works on closed or signed-out accounts.**

- **A move clears old copies of chats.** Chats left under a previous login are now archived by flag on disk.

## [1.4.0] - 2026-09-28

**TL;DR**

- **See the number of active chats for each account**
- **The judgment queue can use your own judgment rules**
- **Search sessions with fuzzy matching like a code editor**
- **Supervised chats can end on structured answer forms**

**Everything in 1.4.0**

### Added

- **See active chat count in the account menu.** Right-click or click the menu button on an account to see how many chats are active there (not archived), so you know at a glance if there's anything to do.

- **Use your own rules for the judgment queue.** A new policy knob names a command that answers the judgment queue instead of using generic doctrine, like a brain trained on your own judgment style. The system runs your command and applies it to every waiting chat.

- **Fuzzy session search like a code editor.** Search your sessions by any part of the title or working directory. Matches at word starts and camelCase humps score higher, space-separated terms must all match, and the best match sorts first.

- **Structured answer forms for supervised chats.** A chat can end on a structured form with numbered options instead of asking in prose, and the judgment queue shows and answers the form with one click per question.

### Fixed

- **Various UI improvements and bug fixes** to dialogs, tables, and layout behavior throughout the app.

## [1.11.0] - 2026-10-05

### Added

- **A sealed CliMayte task** (2026-10-05). `climayte_run`'s task option `sealed` (`systemPromptFile`, `mcpConfig`, `allowedTools`, `prompt`) launches the CLI with that system prompt in place of its own, only that MCP config, no built-in tool and no settings source, in an empty temp folder. A visitor run as an ordinary worker carried 38,700 tokens before its first move; a sealed one carries only what it was given. See `docs/CLIMAYTE.md`.
- **HSwarm and CliMayte are one tab in Hydra Desk 2's AgentHydra pane** (2026-10-05, owner: "move what is currently on the CliMayte tab into HSwarm ... and have it be on the sidebar as CliMayte"). The CliMayte tab is gone: on the HSwarm tab Desk's sidebar is HSwarm's tree alone, with Routing and CliMayte as two of its nodes (owner: "HSwarm should pretty much just show the HSwarm sidebar"), and CliMayte's node is a compact manager list in the pane, one line per task, a click opening the task. Only the tab on screen decides Desk's sidebar, and the pane sends it again whenever it is shown, so another tab's rows are never left behind.
- **HSwarm jobs show in Hydra Desk 2's sidebar under the chat that started them** (2026-10-05, owner: "ZSwarm threads should also be displayed on the HydraDesk 2 sidebar"). Each chat's row lists its HSwarm jobs after its CliMayte tasks, under the same rules: in either list, else under a row added for its caller in that chat's folder group, and with the cloud on the other PC's jobs too (its queue snapshot now carries its HSwarm jobs: ids, label, state and counts only). HSwarm's jobs list gives each job its caller's full ids (`caller_ids`) and always lists running jobs; a Claude Desktop chat's `local_...` id is turned into its session through AgentHydra's chat list, so a job from a desktop chat finds its row (before, 14 of 23 live jobs carried only a two-character key). Desk 2's server reads workers and jobs on one poller and pushes both to every window; a job click opens that job on AgentHydra's HSwarm page.
- **A list or a count for the sidebar's sub-items** (2026-10-05, owner: "just an icon, like a number ... not insanely cluttering up my sidebar"). The Filter menu's Sub-items set CliMayte tasks and HSwarm jobs, each, to List (a line each) or Count (a badge with the kind's icon and how many run; its tooltip names them, a click opens that row's lines). Defaults: CliMayte List, HSwarm Count.
- **A cost model for API keys against Claude subscriptions** (2026-10-05, owner: "calculate the actual cost of API usage on a CliMayte account as opposed to an API"). `GET /api/routing/cost-model` prices a task both ways from this PC's own measurements (a full Pro 5-hour window does about $20.70 of work at Anthropic list prices, so at full use a subscription costs about 2 to 3% of list: Pro 2.0%, Max 5x 2.6%, Max 20x 2.9% as measured on 2026-10-05, recomputed live) and from `hswarm/data/prices.json`; `POST /api/routing/decide` picks the route, and `PUT /api/routing/settings` sets the API preference (default 60%, used when the two costs are within 3x of each other), per-provider discounts for a bulk rate, and the switch. The method and the numbers are in `docs/COST-MODEL.md`.
- **HSwarm can run a tool-using task on a Claude subscription when that is the better buy** (2026-10-05, owner: "a split ... on how much we prefer one or the other, if the cost is even remotely close"). Before a task with tools and an absolute folder runs, HSwarm asks `POST /api/routing/decide`; on "subscription" it runs the task as a CliMayte worker and uses its report, and the result and ledger say so (`selection.route`, provider `climayte`). A CliMayte worker's own HSwarm calls are never routed (it says so in a header, since one shared HSwarm server serves every chat), at most 4 routed tasks run at once (`route_via_climayte_max`), a routed worker that has not started within 90 s is cancelled and the task runs on its API route (`route_via_climayte_start_s`), and an unpriced model is never guessed at. AgentHydra's switch on the Routing page is the main one; `route_via_climayte` in HSwarm's settings is a local opt-out.
- **A Routing page in Hydra Desk 2's HSwarm tab**: the switch, the API-or-subscription split (default 60 / 40 to API keys), the close band, a bulk-rate discount per provider, and tables of each plan's measured worth and each model's list price, price at your rate and subscription equivalent. The settings are synced to the other PC by login sync.
- **Costs at your bulk rate in Analytics** (2026-10-05, owner: "I have bulk rate that doesn't quite match what you see"). Analytics answers carry, beside each list cost, the cost after the discount set for its provider on the Routing page; Desk 2's Analytics shows it as "at your rate", with the list figure in the tooltip, once a discount is set.
- **An orchestrator can settle a CliMayte wave's key** (`climayte_wave_resolve`, `POST /api/corch/waves/:id/tasks/:key/resolve`), and a `climayte_verdict` on a wave worker settles its key. A task's commits are found on the branch by patch-id after another session's landing rebased them, and its paths are judged on its net diff, so a reverted edit outside them no longer fails it (field notes 93 and 94).

### Changed

- **AgentHydra's own window has CliMayte inside the HSwarm tab too, with the Routing page's cost routing** (2026-10-06, owner: "the CLI mate page that now lives inside HSwarm, also going to the standalone web app"). The window gets what Hydra Desk 2's copy got on 2026-10-05: the CliMayte tab is gone, HSwarm's tree always has Routing and CliMayte nodes (CliMayte's with how many tasks run), and CliMayte is the compact manager list, a click opening a task and a click on its node going back. A window last left on CliMayte opens on the HSwarm tab, and mod+2, the home page's CliMayte link and Analytics' savings card open their node. The Routing page carries API keys or subscriptions (the split, the close band, a bulk-rate discount per provider, the plan and model tables) below HSwarm's own routing; the discount's note says how to choose one (a free-tier key is 100% off, credit that is never refilled is best left at 0). Fixed on the way, in both apps: "Show older" during a read no longer gets the shorter list, an emptied daily cap removes the cap instead of being ignored, the load-bias slider goes back after a failed save, and a saved routing setting stays shown when the read after it fails. In the window, CliMayte keeps reading while its float is open on another tab, and goes back to the newest 150 finished tasks when left.
- **Desktop chat sync is view only** (2026-10-05, owner: "I don't want them to actually sync back and forth. I just want to view the ones running on his computer, and he can view the ones running on mine"). Each PC sends only the chats it started. Another PC's chats come down into AgentHydra's viewer folder (`remote-chats` in the data folder) and show in Sessions and Desk 2's cloud list with that PC's name, title and archive state, never in a Claude Desktop chat list or `~/.claude`, so nothing on one PC can continue the other's chat and send turns back. A chat the two-way sync landed is taken back out on the next pass: its desktop copies archived and every copy of its transcript moved into the viewer (a chat moved to another folder on its own PC had been written again under each folder), or left where it is when someone on that PC went on in it. A chat whose shared copy another PC wrote into (the two-way sync's "diverged" chats, or a PC still on that version) goes up again from the start, from the transcript of the PC it started on. A quiet hour's store reads fell from 61 rows to 9 in the simulation, since no copy of the other PC's chat is offered any more.
- **CliMayte sizes Max accounts at the measured 4.75 and 19 Pro windows, not 5 and 20** (2026-10-05). Placement and the cost model each parsed the plan label and used different sizes; both now read `server/src/plans.ts`. Routing settings reject junk (a null or negative price, a boolean for a percent) instead of storing it as 0.

- **Running work no row lists sits inline in its folder group in Hydra Desk 2** (2026-10-05, owner: "inline identical. I shouldn't even be able to tell the difference between ones on his computer and mine, besides them having a Cloud icon"). A running CliMayte task or HSwarm job whose chat the sidebar does not draw adds a row in that chat's folder group, among its rows and in the list's order: the chat that started it (titled as this PC knows it, else as its own PC titles it, else after its first task), or the task itself when nothing says which chat. The "On <PC>" headings, stand-in rows, "No chat" and "Unknown chat" are gone. The other PC's queue snapshot carries no folders, so its chat that is not synced here goes in "No folder". The queue snapshot shares a worker's earlier session ids and the dispatching chat's title, looked up at most 10 a pass and never holding a pass more than 2 s.
- **In Hydra Desk 2's sidebar nothing spins, and blue is HSwarm's alone** (2026-10-05, owner: "instead of being blue spinning icons, ... a slow blue pulsing icon ... for chats that are remote ... gray pulsing"). A running HSwarm job's mark pulses slowly in blue; a running CliMayte task and a chat working on the other PC pulse gray, on the working dot's 2.4 s blink.
- **The cloud icon in Hydra Desk 2 means the other PC, and apps toggle in one click** (2026-10-05, owner: "why chats on my computer are considered cloud ... it's a different app, sure, but it's not cloud"; "I don't necessarily want to see open code or ChatGPT in my sidebar by default, but I want to be able to"). This PC's Codex and OpenCode chats lead with a muted mark for their app, not a cloud. The Filter menu opens with Apps, one checkbox per app, starting at Claude alone; a filter saved before comes back at Claude alone with the rest of it kept.
- **Hydra Desk 2 is easier to read** (2026-10-05, owner: "my eyeballs don't know what to focus on ... a ton of blue"). The home stats card's Models tab shows only the models that matter (at least 2% each, at most 8) and folds the rest behind "+N more". Analytics leads with four numbers and their comparisons, then charts in gray with one blue for the current period or top item, long lists folded to their top 5. The Instances landing leads with how many accounts are usable now and those nearest their limit. HSwarm's Jobs page is a one-line summary per job and a task list that folds past 5 and scrolls.
- **Pushing is no longer blocked by another session's unfinished kit edit** (2026-10-05). The pre-push kit drift check ran over the whole working tree, so one session's uncommitted edit to a kit-synced file refused every other session's push. `.githooks/check-kit-sync-pushed.mjs` now refuses only drift in files the push itself changes, and names the rest.

- **Hydra Desk 2's sidebar rows fade out and fold shut when they go, and the cloud list's dots move** (2026-10-05, owner: "if a chat gets removed in the sidebar, instead of disappearing, it should, like, fade out and then slightly animate closed"; "the gray dots in the sidebar should pulse when they're working"). A row leaving the desk list or the cloud list, a CliMayte task line, or a folder whose last row left fades for 160 ms and then closes over 180 ms, so the rows below slide up. Rows a search or filter hides still go at once, as does everything in a hidden window or with reduced motion asked for. In the cloud list a row the desk list shows had a still gray dot whatever the session was doing; it now pulses like the desk list's, gray while the session works and orange while it waits on you.
- **Hydra Desk 2 opens in its own window, where it was left** (2026-10-05, owner: "It loads and then it auto-adjusts itself on the screen ... I want it to load in the position that I last left it"). Desk 2 ran in an Edge app window that a separate keeper script moved to the saved place about two seconds after it appeared, and its title bar was black above a lighter page. It now opens in `desk2/launcher/HydraDesk2.exe`, a small native WebView2 host: the window is created hidden at the place saved in `~/.hydra-desk-2/window.json`, shown once and never moved after, with its title bar in the page's own background colour. On its first run the launcher asks the old Edge window to close and the host copies the page's saved settings (sidebar order, filters) across; the keeper script is gone.
- **Hydra Desk 2's sidebar rows can be dragged and pinned, and move more calmly** (2026-10-05, owner: "items in the sidebar need to be draggable to rearrange order ... I need to be able to right-click on one and select pin"; "slow down the pulsing and slow down the blue spinny icon"). A row in either list drags to another place in its group, into the one order both lists share. The cloud list's rows have a right-click menu (Open, Pin, Copy session ID, or the desk row's own menu), and a pinned outside session stays listed however long it has been idle. An idle row shows the dimmer hollow ring in the cloud list too, a working dot blinks every 2.4 s instead of 1.2, a waiting one pulses every 3 s instead of 2, and the sidebar spinner turns once in 2.5 s.
- **Hydra Desk 2's AgentHydra pane is ready when you open it** (2026-10-05, owner: "remove the header bar ... and remove the logo"; preload it so clicking it does not load from scratch). The strip above the copy (title, "Desk 2's copy", reload, ← Desk) is gone, and so are the copy's own logo and title and its Queue button; Escape or the AgentHydra button closes the pane. The copy loads in the background once Desk is idle, keeps the tabs it has opened, and keeps one shared store per kind of data (CLI and desktop instances, analytics, HSwarm, CliMayte), refreshed about every 2 minutes while the window is visible and as soon as a page is shown.
- **A Claude Desktop chat that is working keeps its composer in Hydra Desk 2** (2026-10-05, owner: "don't remove the box and just tell me it's working in the desktop ... I need to be able to type in it"). The composer over such a chat had been replaced by a "Working in Claude Desktop" line. It now stays under that line, and what you type goes into the chat's own queue through AgentHydra (`POST /api/sessions/:id/message`) and runs when its turn ends, shown as queued until the transcript has it; text only. A Background tasks button now sits in the title bar beside the session header's button, with a count while tasks run, and the "Continues as a copy" line has room above the composer.

- **CliMayte no longer runs a task on Opus just because the chat that sent it named Opus** (2026-10-05, owner: "the whole point of this was to offload [work] to moderate models"; on another PC every running task was on Opus 5.5). A named model or effort at or above the scorecard's pick for the task's kind now holds only with `ownerWords`, the owner's own words asking for it (per task or per run, at most 2000 characters). A `modelWhy` holds only a setting cheaper than the pick, and anything else runs on the pick. In 72 hours here, 286 tasks had been pinned to Opus by their senders, each with some `modelWhy`. While a kind's pick is an Opus setting, every 2nd auto pick tries a cheaper rung that is still learning (every 4th otherwise). That way review, which sat on Opus high because Sonnet had only 2 review verdicts, earns the samples to move down. HSwarm now sends a read-only task to CliMayte as `sweep`, keeping `review` for judgment work (profile critical or decision, role review or judge). Before, every read-only task went as `review`, onto its Opus pick. Chat tasks are unchanged. The rule is in `docs/CLIMAYTE.md`.
- **In Hydra Desk 2's sidebar, another PC's rows differ only by their cloud, and the Apps ticks filter the desk list too** (2026-10-05).
  - The gray chip with the other PC's name is gone. The name stays in the cloud's tooltip.
  - A row added for the other PC's running work pulses its cloud: gray, or blue for a running HSwarm job. Before, it sat still.
  - With the cloud list off, this PC's Codex and other apps' chats show only when their app is ticked under Filter, Apps. They carry the same muted app mark as in the cloud list. Desk's own chats are never filtered.
- **Hydra Desk 2's AgentHydra pane opens on HSwarm without flashing the cloud list, and its counts agree** (2026-10-05).
  - When the pane last stood on HSwarm, Desk draws HSwarm's last tree from the first frame, dimmed until the pane sends its live one.
  - The tree's CliMayte count is the CliMayte page's, including other PCs' tasks while sharing is on.
  - Jobs draws a muted line for each queued task its summary counts.
  - The Instances landing uses the CLI table's pooled gauges, in gray. It has one warning rule for the pool and the account rows: amber from 70% used, red above 90%. Its bar tracks show in dark mode.

### Fixed

- **Hydra Desk 2's server tests no longer write chats into the real `~/.claude/projects`** (2026-10-05). A test chat with no account folder was seeded under the real home folder, so a fork test's chat turned up in the owner's sidebar. `ChatManager` now takes a `claudeHome`, which production leaves unset so it uses the home folder, and every test passes its temp folder.
- **A CliMayte wave whose manager finished without calling `wave_report` is reported anyway** (2026-10-05, found by a RustTor session: waves wv-42c178 and wv-5a5bbc sat `running` for hours with every task passed, so `climayte_wait --wave` never woke and `climayte_wave_verify` refused them). The daemon reports such a wave itself (its table, then the manager's last answer), as the manager's turn ends or on the 5-second wave check for one that ended earlier. A manager that ends a turn with nothing running, keys pending and no report now gets the documented "report or dispatch" message, and fails on a second such turn, instead of waiting forever. A wave no longer running never wakes its manager again.
- **Rows in Hydra Desk 2's desk list no longer pop in and out by themselves** (2026-10-05, owner: "things just keep kind of, like, popping in and popping out for no reason"). Besides the live chats and sessions, the desk list showed any transcript written in the last 30 seconds. HSwarm's jobs write theirs in bursts, so each job appeared with every burst and vanished 30 seconds into every pause. HSwarm's jobs are now left out of the desk list, as the cloud list already left them out (HSwarm has its own tab), and another session only the transcript index knows (a Codex session, a CLI outside `~/.claude`) stays listed, idle, for 10 minutes after its last write instead of 30 seconds.
- **`unblock_prompts.py --min-wait 0` no longer misses a chat whose transcript was just written** (2026-10-05). A floor of 0 is meant to switch the quiet gate off, but on Windows a fresh write can be stamped a moment after the scan's clock, which made the chat's quiet time negative and skipped it. A negative quiet time now counts as 0. It turned up as a flaky orchestrator test on CI.

## [1.10.0] - 2026-10-05

### Changed

- **AgentHydra installs its own updates by default** (2026-10-05, owner: "we should have it default that AgentHydra auto-updates if there's a new version"). Auto-update was opt-in, so a PC ran an old build until someone opened Settings and clicked Update. The `auto_update_enabled` setting is now seeded on: an install that never chose gets it on its first start of this build, and one turned off in Settings stays off. Nothing else about applying changes: it still waits while work a restart would stop is running, never touches a checkout with local changes, and a packaged build still checks the release's SHA-256 before swapping.
- **Desktop chat sync is on by default on every PC in a login sync** (2026-10-05, owner: "sync desktop chat should be default on"). Setup used to write `shareChats: false` into `login-sync.json` on every PC, so the switch read as a choice nobody made. The file now records only a PC turned off (`chatsOff: true`), and the old field is not read, so every PC already in a sync starts sharing its visible desktop chats on its first pass after updating. Login sync tests now run against a PC with no desktop chats (`server/tests/no-chats.ts`), since the chat half runs from setup and the real one reads this PC's own Claude Desktop profiles.
- **Another PC's CliMayte tasks can sit under the chat that started them** (2026-10-04). The queue snapshot each PC shares through login sync now carries ids only for a task's session, the chat or worker that dispatched it, and its wave (never a prompt, path or Claude home), so Hydra Desk 2 on the other PC draws each task under its chat instead of in a list apart. A PC still on 1.9.x sends none of these, so its tasks stay unplaced until it updates.

### Fixed

- **A daemon that restarts itself keeps its own identity, and one that dies at startup says why** (2026-10-05). A relaunched daemon loaded its config before applying the identity it was handed, so a side-run's successor read the machine's own store; the identity now applies first. An exit or a throw before file logging starts now leaves a line in `daemon.log` (code, pid, arguments): on 2026-10-05 four revives of a stalled daemon each exited within 0.4 s and wrote nothing.

## [1.9.2] - 2026-10-04

### Changed

- **A CliMayte worker's runner on Windows is a 1 MB native program instead of a 175-191 MB Bun process** (2026-10-04). Every worker's CLI runs under its own runner, outside the daemon, so restarts leave workers running; that runner was AgentHydra itself in `--climayte-runner` mode, a whole Bun runtime per worker (about 3 GB with 20 workers) to wait on one process. It is now `misc/climayte-runner.exe` (Rust, no dependencies, source in `misc/climayte-runner-native/`, rebuilt and checked for machine paths by its `build.ps1`), and it keeps the same contract: the spec claim, the pid and exit files, the kill-on-close job with its 400-process ceiling, `left` and `peakProcesses`, and the wind-down hook answered over loopback http (sub-agents get `{}`, browser origins are refused). Measured on the same stand-in CLI: 0.9-1.0 MB private against 175-191 MB, the same exit file and the same process tree. One runner per worker stays, so a runner that dies takes only its own worker. The daemon starts a content-named copy from CliMayte's `bin` folder, so a `git pull` or a release's `misc/` reconcile can replace the runner while workers run; leftover command lines are read natively instead of by a PowerShell per exit, and a check command such as `taskkill /IM bun.exe` no longer kills its own runner. macOS and Linux keep the Bun runner (`server/src/climayte-runner-posix.ts`). A single-file build embeds the exe (it joins `RUNTIME_MISC_FILES`, so the build fails without it); the runner's hook server refuses a chunk size past its 64 MB cap rather than overflowing on it.
- **The daemon no longer re-reads the same transcripts on every index sweep** (2026-10-04). A session-continuation search that hit its per-pass cap started over on the next sweep, so on the owner's PC four unresolved links re-read about 425 MB every 12 s, roughly 2 GB of disk reads a minute and the biggest reader on the machine. Each transcript read without the uuid is now remembered with its size, so the next pass reads the next 24 and the search ends exhaustive and memoized.
- **The Windows process table is read in-process instead of by a PowerShell + WMI spawn per scan** (2026-10-04). The Claude.exe, ChatGPT/Codex, tray-host, CliMayte runner, ancestry, dispatch, CLI-in-use and managed-copy scans use Toolhelp32 plus per-pid `NtQueryInformationProcess`, with PowerShell kept as the fallback. On the owner's PC that was 9-14 powershell + conhost + WmiPrvSE rounds a minute (WmiPrvSE at p95 81% of a core); the native read takes 13 ms.
- **Hydra Desk is much lighter while chats work** (2026-10-04). The composer's git poll is one `git status --porcelain=v2 --branch` instead of six git processes every 5 s, with the repo root and line counts reused while nothing changed, and no poll at all while Desk is hidden. A working chat's transcript is followed from where the last read stopped instead of its last 8 MB being re-read every 3 s; its Desk file is read once instead of at every poll; a chat's past sessions (a handoff adds one) stay remembered instead of being evicted and re-read in turn; and a screenshot a transcript names is read and hashed once per change instead of at every re-read. With two long CliMayte chats working that was about 34 MB of reads every 3 s.

### Fixed

- **A Hydra Desk chat moved to another account mid-turn continues its work, and a big session moves as a fresh one** (2026-10-04). A turn the CLI started itself (a background task finished) had no unanswered message, so a move replayed nothing and the new account ended at once; a move now tells a turn that had replied to continue, once per move. A session over 150k tokens of context is no longer copied: the chat starts a fresh session whose first message is a condensed handoff (goal, later instructions, done, in progress, to-dos, last exchanges, where the old transcript is), at most 16k characters.

## [1.9.1] - 2026-10-04

### Fixed

- **A chat worker is no longer stopped as "Not converging" or held for room** (2026-10-04). The owner's own chat (`chat: true`) ran at 96% of a Pro window, over 3 times a task estimate it never had, and CliMayte stopped it. A chat now skips the convergence stop (`notConverging`) and has no cost estimate, so nothing holds it for room or counts it in other tasks' estimates; it still moves accounts at a usage limit and hands off as before.
- **A CliMayte worker's sub-agents no longer see its wind-down signal** (2026-10-04). The worker's PostToolUse hook fires inside its Agent-tool sub-agents too, so when the signal was up every sub-agent was told to write the handoff: in one SUE run every visitor quit mid-visit and overwrote the worker's own handoff file. The runner's signal server (`climayte-signal.ts`) now answers `{}` to a hook call whose input carries `agent_id`, which the CLI sends only inside a sub-agent.
- **CliMayte workers get the owner's stdio MCP servers, and `climayte-worker` connects instead of showing "needs authorization"** (2026-10-04). A Hydra Desk chat worker on account #35 saw only `climayte-worker`, flagged as needing sign-in, and no `connections`. Two causes. (1) `--mcp-config` carried only the owner's URL servers, and the owner's `connections` is stdio, so a worker had it only when its account's own `.claude.json` had a copy (accounts #23 and #35 list no servers). `ownerMcpServers` (`climayte-owner-sync.ts`) now carries stdio servers (command, args, env, cwd) too, leaving one out whole when an env key or flag is named like a secret or a value looks like a key (`sk-`, `ghp_`, `xoxb-`, a long token-shaped word); the log names the server and the key, never a value. `CONNECTIONS_ELICITATION` carries. (2) The ask endpoint answered 403 while the attempt's pid was still unread (the CLI connects a second or two after it starts, before the daemon's poll), and Claude Code 2.1.286 treats both 401 and 403 as "needs authorization" and caches that per account for 15 minutes, so every worker on that account skipped the server. The ask and manager endpoints now read the runner's pid file when the attempt has no pid yet (`attemptCliPid`), refuse with 404 instead of 403, and each launch takes `climayte-worker` and `climayte-manager` off the account's `mcp-needs-auth-cache.json`. Checked with a real `claude -p` against a probe server: the 403 one showed `needs-auth` and was cached, the 404 one showed `failed` and was not.

### Added

- **Auto-resume holds back re-wakes that produce nothing** (`server/src/rewake-cooldown.ts`,
  `server/src/monitor.ts`, `server/src/db.ts`). After two resumes of a session in a row that added
  no real turn, the next scheduled resume waits an extra 2 minutes, doubling per further empty
  resume up to 30 minutes; a model turn or a typed message resets it. The idea comes from
  paperclipai/paperclip's re-wake throttle (MIT).

- **`unblock_prompts` answers Claude's permission-change card when it only restores a bypass a chat
  already had** (`orchestrator/scripts/unblock_prompts.py`, `orchestrator/scripts/lib/approvallib.py`,
  `orchestrator/scripts/actuator/approve_prompt.ps1`). A chat that calls
  `set_session_permission_mode` stopped on that card and the unblock lane could not answer it. A
  card restoring a target's configured `bypassPermissions` mode, in the same profile and login, is
  approved with **Allow once** after a recheck right before the press; anything else escalates, and
  operator deny patterns win. The scan also keeps every unresolved tool call of the turn, so a
  parallel sibling's result no longer hides a call still waiting. See
  `docs/CLAUDE-PERMISSION-PROMPTS.md`; approval against a live card is not yet verified end to end.

### Fixed

- **The CliMayte list no longer throws on a manager wave's verdicts** (`web/src/lib/climayte-status.ts`).
  A verdict recorded by a manager wave (`by: 'wave'`) had no line in the row's verdict mark or the
  failure story, so vue-i18n threw `SyntaxError: 17` for each such row (53 errors in the live
  list's console, 2026-10-04). Wave verdicts now read "Its wave manager accepted / rejected the
  result", and a recorder this build does not know reads as plain "Passed" / "Failed".

## [1.9.0] - 2026-10-04

### Added

- **A worker can be moved to another folder** (owner, 2026-10-04: Hydra Desk moves a chat when Claude cd's out of its folder). `climayte_send` and `POST /api/corch/workers/:id/send` take an optional `cwd` (absolute, existing, local; a relative, missing, UNC or device path is refused). From the worker's next launch its session is copied into that folder's project dir on the account it runs on (the original stays) and resumed there; the change is journaled (`cwd-changed`) and `climayte_status` shows `cwd` and `pendingCwd`. See docs/CLIMAYTE.md, Moving a worker to another folder.
- **A CliMayte worker can ask its origin a question** (owner, 2026-10-04: "all the CLI mates can ask questions themselves properly; those questions should be handled by the AI that started them, not me"). A headless worker used to guess. Now it calls `climayte_ask { question, options?, context? }` on a per-worker MCP server (`climayte-worker`, `/api/corch/ask/<id>`, the caller's pid must be the worker's own CLI); the question is stored on the worker (`question` in `climayte_status` and reports, an "Asking" block in the CliMayte view), the worker ends its turn without holding the CLI open, and the chat or parent worker that dispatched it gets an `asking` ping with the question. The answer is the existing `climayte_send`, which resumes the session and clears the question. The orchestrator-facing text says to answer it from the task context and ask the owner only for a decision only they can make. See docs/CLIMAYTE.md, Questions from a worker.
- **CliMayte chat workers** (owner, 2026-10-04). A task with `chat: true` (`climayteRun`, `POST /api/corch/workers`, the `climayte_run` MCP tool; default false) runs one of the owner's own interactive chats headless, launched like his own `claude` in that folder: no worker brief (only a one-line note that it runs headless), his `~/.claude/CLAUDE.md` instead of the account's lean worker CLAUDE.md (left out with `claudeMdExcludes`, so the shared account file is never swapped), his full skills (`--add-dir` home), all his MCP servers and claude.ai connectors with no worker denials, a 1-hour prompt cache, and Opus xhigh unless the task names its own (the scorecard never picks for it, sizing never splits it). The flag lives on the worker, so it holds through moves, resends and revives; workers a chat dispatches are ordinary. An ordinary worker's launch is unchanged. Measured: a first request of 28,844 tokens against 27,864 for an ordinary worker. A chat worker used to be framed as a delegated task and, asked to answer a company, drafted the email and handed it back instead of sending it. See docs/CLIMAYTE.md, Chat workers.
- **CliMayte starts a worker only when the machine has the memory for it** (owner, 2026-10-04: the same progress with less memory and CPU). On 2026-10-04, 33 workers ran at once on a 63 GB PC with 0.5-5.8 GB of RAM free and commit at 96% of its limit, and Windows spent about 5 of 32 threads compressing and paging. Now a start waits ("Waiting for memory: ...") while it would leave free RAM under 8% of the machine or, on Windows, commit under 5% of its limit, counting workers started in the last 2 minutes as full grown (0.75 GB each, measured), and goes on the first tick with room. Nothing running is stopped; `climayteCapacity` reports no idle account meanwhile. Linux reads MemAvailable; macOS is not gated. See docs/CLIMAYTE.md, Memory.
- **HSwarm's ledger rotates monthly** (docs/STORAGE-PLAN.md piece 8). `~/.hswarm/ledger.jsonl` keeps only the current month; each finished month moves to `ledger-YYYYMM.jsonl.gz` (gzip, which Python and Bun both read; xz was in the plan but Bun cannot read it). Appends and the rotation share one lock, and rotation is journaled so a crash between the archive and the truncate loses and doubles nothing. Model stats, the day chart, spend caps, savings and the usage report read the archives their window needs, so totals are the same before and after; the analytics kit ingests each archive once and `hswarm-cost.ts` sums them too. `import-zswarm` is now a one-shot (it records that it ran; the daemon stops scheduling it after a successful run).
- **All of a PC's ZSwarm history moves into HSwarm** (owner, 2026-10-03: "I'm retiring ZSwarm, so all stats from ZSwarm need to be imported into HSwarm"). `python -m hswarm import-zswarm [--dry-run] [--json]` copies the four stats tables (run records, profiles, Claude days and accounts), the task ledger, edit-survival scores, routing decisions, daily savings and the job records and day archives from `~/.zswarm` into HSwarm's home; keys, secrets, vault files and egress logs never move. It is re-runnable (keyed rows, line hashes, a byte offset per file), and while `~/.zswarm` exists the daemon runs it 30 s after the HSwarm sidecar starts and then hourly. HSwarm's stats now read its own database (source `hswarm`) instead of pointing at ZSwarm's.
- **HSwarm overview: model results** (owner, 2026-10-03: "which models were thumbs up and thumbs down, which models were the most efficient per cost"). A new `model-stats?days=N` route (`hswarm/model_stats.py`, cached on the ledger's size and time) and a section on the overview: passed vs failed per model, cost per successful task, how much of each model's code edits survive a day, and tasks per day by model, over 14 or 30 days.
- **One CliMayte + HSwarm stats card** (owner, 2026-10-03: "CliMayte is essentially the same as HSwarm now; we offload to either"). The CliMayte tab's right column opens with one card: CliMayte's tasks, runs, tokens and cost beside HSwarm's savings, and "What works" as one green/red pass/fail bar per model (click for the per-kind list). The left header keeps only the title, Hide finished and Waves.
- **Every signed-in CLI account's row shows whether it has a limit reset** (owner, 2026-10-03). A daily background check (`core/cli-reset-sweep.ts`: first pass 10 minutes after start, then hourly, one account at a time) runs `/limit-reset` as a check for each signed-in account not checked in 24 hours, and only while its 5-hour usage reading is under 90% and under 30 minutes old: the weekly session reset is claimed only at the 5-hour limit, so a check there could spend it. Each run starts no MCP servers. An `unavailable` answer now draws a muted "No limit reset" icon. See docs/CLI-LIMIT-RESET.md.

### Changed

- **A CliMayte worker starts far fewer processes per tool call, and one runaway can no longer take the PC** (owner, 2026-10-04: "I want to be able to run more, not less ... make each worker cheaper"). Measured the same day, a worker started about 6.7 processes per tool call and AgentHydra's own two hooks were 1.6 of them: the wind-down hook ran `cat <signal file>` through Git Bash after every call (a shell and a `cat`), and the edit-claims hook ran `python` through the same shell on every edit. The wind-down hook is now an http hook answered by the worker's own runner on a loopback port (`climayte-signal.ts`: the runner serves the signal file, rewrites the worker's `--settings` to point at itself before the CLI starts, and falls back to the `cat` form if it cannot), so a tool call starts no process for it, and a daemon restart or port change cannot reach it. The edit-claims hook runs as `python -S` directly, with no shell in front, through a one-line launcher that does nothing when the script has gone (an interpreter that cannot open its script exits 2, and an exit 2 from that hook would deny every edit). There is still no limit on how many workers run; each worker's job (`climayte-job.ts`) now holds a ceiling of 400 live processes (`WORKER_MAX_PROCESSES`; the busiest measured worker had 48), because on 2026-10-03 one worker's self-calling shell function started about 3,000 processes and froze the desktop, and each exit file records the worker's `peakProcesses`, and `climayte_status` shows it on the attempt, to tune it by
- **ZSwarm is retired; HSwarm replaces it wherever AgentHydra reads or names the swarm** (owner, 2026-10-03: "Whatever you recommend, go for it. Do all of it."). Swarm jobs in Sessions, swarm spend and the `deepseek` balance read HSwarm's home (`~/.hswarm`, where `import-zswarm` merged ZSwarm's jobs and ledger): `server/src/zswarm-sessions.ts` and `zswarm-cost.ts` are now `hswarm-sessions.ts` and `hswarm-cost.ts`, and `config.ts`'s `ZSWARM_HOME` is gone. The balance key is found where HSwarm finds its own DeepSeek keys (`DEEPSEEK_API_KEYS`, `DEEPSEEK_API_KEY`, then `~/.hswarm/secrets/deepseek_api_keys`) before `~/.dsh/.credentials.yaml`. The MCP instructions, `list_usage`, `fan_out` and `climayte_run` send mechanical work to `hswarm_run`, and the agent catalog's row is named HSwarm. The session source id and each job row's tool id stay `zswarm`: the source is a frozen MCP API value, and the tool id is part of every job's done-mark key and locator, so a mark set on a swarm job before the switch is still read. What a person reads says HSwarm.
- **The wide toggle is one setting for every page** (owner, 2026-10-03). HSwarm forced the shell wide when opened and narrow when left; now the header button is the only thing that sets it.
- **Waves stay closed until opened** (owner, 2026-10-03: "they keep auto-expanding ... wrapping on the narrow design"). The Waves box and each wave start collapsed, remember being opened, keep their header on one line, scroll inside a set height, and say what a wave is.
- **Sessions and CliMayte share one sidebar** (owner, 2026-10-03: "the sidebar for sessions running the same code as the sidebar in CliMayte"). `side-list/SideBar.vue` owns both: collapse, drag-resize with a remembered width per view, grouped rows. Sessions rows take the CliMayte row layout (status icon, a small source icon instead of the coloured pill, model and effort, time) and group by project.

### Fixed

- **A worker dispatched from a chat on a CLI instance is tied to that chat** (owner, 2026-10-04: "if you dispatched agents, why don't I see them in our viewer"). The caller lookup walked the right engine pid but only searched `~/.claude` and the caller's detected config dir; an engine started by another program (a desktop app that runs chats through the Agent SDK on a CLI instance) keeps its live registry in that instance's dir, which detection missed, so `climayte_run` answered `ping: off` and the worker had no origin. It now also searches every CLI instance's config dir.
- **The nearest chat in the calling process chain is the caller, whichever home registered it** (2026-10-04, found by the test above failing on a dev PC). The caller lookup searched `~/.claude`'s registry along the whole chain before any CLI instance's, so a chat on an instance that a `~/.claude` session had started (a desk app launched from a chat) was reported as that session, and its workers' pings went to the wrong chat. The chain is now matched nearest process first across every home; the instance dirs are still read only when one could hold a nearer engine.
- **Login sync no longer scans every process each pass when there is no desktop login to decide** (2026-10-04). The desktop half of each 30 s pass started a fresh process scan (a PowerShell CIM query, about 0.7-1.1 s) before looking at anything, even with no Claude Desktop profile signed in and nothing in the store to land. It now scans on first need, at most once a pass; the two-PC login-sync test went from 24.8 s to 1.2 s.
- **A browser page cannot read a CliMayte worker's wind-down signal** (2026-10-04). The runner's loopback signal server (`climayte-signal.ts`) answered any request; it now refuses one carrying a browser Origin (exact-origin loopback guard, empty allowlist), as the daemon and the instances window already do (audit AH-11). The CLI's http hook sends no Origin and is unaffected.
- **A stalling daemon names the functions that stalled it** (owner, 2026-10-04: "shit's still fucking up my CPU"). On a loaded PC the tray watchdog reaped the daemon four times between 08:30 and 08:33 UTC, and every SATURATED line blamed "(no request: timers/background work)". The first time the loop runs 1 s late in a 10 s window, `stall-sentinel.ts` starts Bun's sampling profiler (`bun:jsc`), drains it into counts every 2 s, and each SATURATED line then adds `profile: N samples; on top: ...; innermost daemon frame: ...; outermost daemon frame: ...`, heaviest first. A daemon that never stalls never samples.
- **The switch-card watchers stay small** (2026-10-04). `orchestrator/scripts/actuator/approve_switch_card.ps1` walked every UI Automation element of a Claude window every 2 s while no card was up, and the six resident watchers had grown to 4.6 GB between them (1.0-1.3 GB each). Each tick now asks only for the buttons' names, in one cached call that keeps no element alive, and walks the window only when one starts with an Allow name, while a card is up, and once a minute; it collects garbage each tick and starts a fresh copy of itself past 400 MB. Measured beside an old watcher on the same window: 72-85 MB flat against 1,239 MB, the same CPU. The watcher, its supervisor `watch_switch_cards.ps1` and `install_switch_card_watchers.ps1` had been running from the dev checkout uncommitted since 2026-10-03; they are in the repo now.
- **A switch-card watcher presses only a card's own Allow once** (2026-10-04, found in review). From text that starts with a card phrase, the watcher climbed up to 12 ancestors and pressed the Allow once of the first ancestor holding exactly one. A chat message quoting "This one switches" could therefore climb to the chat pane and press a different permission card's lone Allow. The climb now stops, and logs `REFUSED: ... reached a container of N buttons`, at an ancestor with more than 8 buttons of any kind: a card holds a handful, a chat pane dozens.
- **CliMayte workers' shells start faster** (owner, 2026-10-04: "are we unnecessarily spinning up a billion bashes?"). Claude Code saves a shell snapshot once per session with a 10 s limit; when that times out, every Bash command after it runs as a login shell. On 2026-10-04, 94% of snapshots took longer than 10 s, so workers paid a full Git Bash login per command. Workers have no terminal, so TERM was unset, Git Bash made it xterm-256color, and every login ran aliases.sh's seven `$(type -p X.exe)` subshells. Workers now start with `TERM=dumb`: a login shell measured 1.8 s before and 1.1 s after (median of 5 each, same box).
- **The daemon no longer freezes while it kills a process tree** (2026-10-04). The stall profiler added above named it: 87% of a 7.6 s stall was `killProcessTrees` waiting on `taskkill /T /F` through `spawnSync`, reached from `closeResetCli` in `cli-limit-reset.ts`, and `capturePipedProc` and `awaitExitBounded` in `core/process.ts` made the same blocking call from their timeout timers. On a loaded PC one taskkill takes seconds, and the whole daemon (API, tray health probe, schedulers) waited on it. Those three paths now call `killProcessTreesAsync`, which runs taskkill with `Bun.spawn` and waits at most 30 s without blocking; the synchronous `killProcessTrees` stays for shutdown paths that must finish before the process exits.
- **HSwarm's fast transcript scanners are back** (2026-10-03). The port from ZSwarm brought `hswarm/native.py` but not the Rust and Go sources it builds or the A/B bench that chooses between them, so `hswarm native build` had nothing to compile and every savings scan ran the Python arm (about 13x slower on a 14-day window). The sources are now in `hswarm/native/` beside the module, the bench is `hswarm/native_ab.py` (`hswarm native bench`), and the winner, a measurement of one machine, is written to `~/.hswarm/native/winner.json` instead of the repo. `hswarm/tests/test_native.py` checks each built scanner against the Python reference. See hswarm/README.md "Transcript scanners".

## [1.8.0] - 2026-10-03

### Added

- **A chat that dispatches CliMayte work is pinged when it settles** (owner, 2026-10-03: "when a chat finishes, it pings the orchestrator that started it"). `climayte_run`, `climayte_manage` and `climayte_status` are now caller-aware: the daemon resolves the calling chat and stores it as the worker's `origin` (an `origin` a client writes into its own arguments is ignored; the route checks the session id and Claude home before storing). The daemon starts the ping outbox with CliMayte: finishes, verdicts needed, failures, cancels, a settled group, and a worker that was 5-hour or weekly limited and moved go back to that chat in batches, through its peer pipe, then a retry for 2 hours, the composer for a desktop chat, and last a toast plus `unreadPings` on its next `climayte_status`. A task a manager worker dispatches reports to that worker. The dispatch answer says `ping: on` or `ping: off (<why>)`; `notify: false` opts out; `climayte_status {group, ping: true}` adopts a group already running; the file `~/.agenthydra/climayte/ping-off` turns pings off. See docs/CLIMAYTE.md "Pings to the dispatching chat".
- **A fixer that only its test calls now fails the build** (2026-10-03). New guardrail `scripts/checks/fixer-only-called-by-its-test.mjs`, its own CI step: an exported `sweep*`, `reassert*` or `run*Once` that no production code names fails. `reassertAutomationStamps` and `sweepUntitledDesktopChats` each shipped unit-tested, documented as running on a timer, and called from nowhere but their own test. `tests/guardrails.test.ts` plants a `sweepX` only a test imports and proves the check fires.
- **A quiet login-sync store reads about 60 rows an hour, not 7,000** (owner, 2026-10-03: "if each side kept a copy and all you had to check for was if there were changes"). The Cloudflare D1 reads of that day were not the list routes any more but item reads: this PC re-fetched ten chats that could not land and logins that could not land on every 30 s pass, and re-uploaded the first chunk of twin-session chats, which made the Worker read `chat_usage` and `MAX(seq)`. Now a fetched chat or login is kept per version in the mirror and never fetched again until its version changes, a chat this PC was refused is not offered again for an hour, and the Worker keeps lists and rows in isolate memory behind per-table revs and a one-row head it trusts for 75 s (`HEAD_TRUST_S`), reads no `chat_usage` for a refused chunk, and runs `MAX(seq)` once per chat. A simulated hour with two PCs (the older one polling the lists every 30 s): 5,400 rows before, 61 after with no heartbeats; 6,200 before, 380 after with both PCs heartbeating a queue every 60 s. 1,400 a day is only reachable while no PC writes: each queue heartbeat costs about three reads. **Redeploy the login-sync Worker.**
- **A PC asks the login-sync store only for what changed** (owner, 2026-10-03). One shared mirror per store (`login-sync-mirror.ts`) feeds the logins, CliMayte queue and desktop chat parts of a pass: the first pass reads the three lists, later passes read `GET /v1/changes?since=<cursor>` (one request when nothing changed, against three list reads before). A Worker without the route, a list without `x-store-rev` or `{full: true}` falls back to the full lists. A refresh younger than 20 s is reused. Needs the redeployed Worker; an older Worker keeps working on the lists.
- **The login-sync Worker's D1 reads drop 95%+ on idle PCs** (owner, 2026-10-03: "each side kept a copy and all you had to check for was if there were changes"). Every write (PUT or DELETE) on `logins`, `queues` or `chats` now increments a one-row `store_rev` table and stamps the row with it, and a new `GET /v1/changes?since=<n>` route returns only rows changed since cursor `n`, plus tombstones (so a PC that missed the delete still learns about it). Each PC gets the current `rev` in the `x-store-rev` response header on every list route, so it can start its cursor there without missing a write (an idle call reads one row). A write is one atomic batch, a refused write (409) leaves the rev alone, an existing database gets its `rev` column on first use, and tombstones older than 30 days are pruned at Worker start. An older AgentHydra keeps using the list routes; the Worker must be redeployed for the new clients. **Redeploy the login-sync Worker.**

- **Shared desktop chats can no longer fill the login-sync store** (owner, 2026-10-03: "How much space are we storing on the server ... what's that going to cost me"). Nothing ever left the store before, and on Cloudflare's free plan its database stops at 500 MB with the logins inside it. Now a chat archived three days ago leaves the store (both PCs keep their copies), chats stop at 400 MB of the store with a plain "no more room" note in Login sync while logins keep syncing, and deleting a chat removes its transcript too (it was left behind). **Redeploy the login-sync Worker.**

- **Two PCs can share their visible Claude Desktop chats** (owner, 2026-10-02: "sync all desktop instance chats/threads ... Compressed ... We keep track of which computer it came from"). A new switch in the Login sync dialog (off by default, set on each PC; `POST /api/cli-instances/sync/chats`) sends this PC's visible chats, not the archived ones, and takes the other PCs', compressed and encrypted under the sync key, and the dialog lists each chat with the PC it came from. Chats ride a pass of their own beside the logins, and a chat that cannot sync shows as `chatsError`, never as a login error. **Redeploy the login-sync Worker** if it predates the chat routes.
- **Clear usage stats, on every account row's ⋯ menu** (Instances, CLI and Codex; owner, 2026-10-02:
  "clear the like old 5hour and usage stats in the ui", "not like delete the stats"). A signed-out
  account keeps its last reading on its row, dimmed, and until now nothing took it off. The item
  blanks the row's 5-hour and weekly numbers until its next reading: a signed-in account fills in
  again at its next check, a signed-out one stays blank. Nothing is deleted: the stored readings and
  the usage history keep every number, and CliMayte, fan_out and the account survey read them as
  before (`POST /api/usage/clear`; the tables' routes serve no reading taken before a row's clear).

### Changed

- **CliMayte: the five-minute rule** (owner, 2026-10-03: "when a worker hits a five-hour or weekly limit, CliMayte moves it to another account and resumes it, unless the limit resets in under five minutes; distribute the load"). Priority-1 tasks sat waiting while accounts had room: a flat 4 workers per account (a Max 20x the same as a Pro), and waits for home and for room with no time bound. Now a task never waits more than 5 minutes (`RESUME_WAIT_MS`) while an account admits it: a limited session moves unless its own account frees within 5 minutes, a room or pace hold lasts only for a reset within 5 minutes, and with no such reset a task starts short on the account with the most room when at least 10 Pro-points are left (`MIN_START_ROOM_PCT`), then hands off at the stop line. An account runs 4 workers per Pro window up to 8 (`ACCOUNT_WORKERS_CEILING`), a group's default share is no longer halved on an account ahead of its weekly pace, and `per_account` spills to an account past it when nothing within it fits (`per_account_strict: true` on `climayte_run` keeps the hard cap). Moves after a limit and usage wind-down handoffs no longer count toward the "not converging" caps. A waiting row names the accounts with room that are at their worker cap. Field note 78.

- **Pushing a release tag takes seconds once CI is green on its commit** (811552a). The pre-push
  hook ran the whole `check:deep` lane, about 25 minutes, on every `v*.*.*` tag, although
  docs/RELEASING.md already makes green CI the step before tagging and ci.yml runs every one of
  those lanes on that commit. It now asks `gh` for a successful ci.yml run on the tagged commit and
  then runs only the kit check GitHub cannot run (2.8 s measured); when it cannot confirm green CI it
  says why and runs the full `check:deep` as before.

### Fixed

- **A chat moved by `migrate_chat.py` keeps its name on a running target too** (2026-10-03). The `/migrate` route fired `reassertChatTitle` after a hot landing; the Python mover lands through `/import-desktop` and stopped at verifying the instance, so the running app's re-save could blank the title to "General coding session" until the title sweep caught it. After a verified landing whose title is not durable it now calls the new `POST /api/sessions/:id/reassert-title`, which starts the same bounded watch keyed by the session id (never the rendered title) and refuses a generic title or a chat the target does not hold. Best effort: a refusal never unlands the chat.
- **A per-instance route only acts on an instance it can list.** Every `/api/instances/:dir/...`
  route (account, login-history, open, quit, logout, focus, reveal, shortcut, delete, meta, usage,
  and the quick daemon's account/open/focus/quit) used `:dir` as a path as given, so
  `POST /api/instances/thomas/open` - a bare name, the MCP `dir` argument's natural spelling -
  resolved against the daemon's working directory (System32's driver store for the installed
  service) and launched claude.exe there, and any other folder on the disk could be named the same
  way. `:dir` now resolves against the instance list: the full dir in any spelling, or a bare folder
  name that names exactly one instance; anything else is 404 `{ ok: false, error: 'unknown instance' }`
  before the action runs. The fix was written 2026-09-03 and never reached main; it is ported here,
  with `scripts/checks/instance-dir-route-gate.mjs` in CI holding every such route to the gate.
- **A frozen daemon no longer gets a second daemon started beside it, and the MCP reads the daemon
  that serves it.** On 2026-10-02 the daemon froze for 25 s; the tray started another, which found
  no answer, hopped to port 7788 and took `runtime.json`. Two daemons then ran one store: each
  resumed the other's running CliMayte workers (two copies on two accounts), and the MCP tools,
  which followed `runtime.json`, answered `[]` and "worker not found" for 16 workers posted to
  7787, so an orchestrator sent them twice more. Now a start whose health probes all time out while
  the recorded daemon is still alive and holding its port ends instead of hopping; tools served at
  `/api/mcp` read their own daemon; and a daemon that finds another on its store says `TWO DAEMONS`
  in its log, in `/api/health` (`peer`) and on every MCP answer (`peerWarning`, lists and errors
  included).
- **CliMayte returns the workers it already made when a dispatch is sent again.** The same group,
  titles, prompts and folders within 10 minutes answer with the existing workers (`repeat: true`)
  and start nothing; `copies: true` makes new ones.
- **CliMayte workers have the Connections MCP (connections-local) again, on every account.** A
  worker is given the owner's own MCP servers on its command line (`--mcp-config`: a URL and at
  most the headersHelper command that signs in at connect time, so no credential is written to a
  file), less agenthydra and magnific, instead of
  whatever its account's `.claude.json` was seeded with when the account was made; one of 33
  accounts listed none. 1.7.0 denied connections-local to save tokens, and a worker asked to use
  connections_execute (memory tools, the fourman board) had no such tool.
- **A worker's `--mcp-config` file never carries a credential, and its files no longer pile up.**
  A server is left out (and logged by name only) when its URL holds a key in a path segment, host
  label or fragment, or its headersHelper holds a header literal or a token-shaped word; a
  [`~/.claude.json`](docs/CLAUDE-CONFIG-LAYOUT.md) that does not parse is logged without the parser's quote of it; AgentHydra's
  own server is left out under any name (by its `/api/mcp` endpoint). A worker's settings and MCP
  files are removed when its CLI ends or it is removed, and a daemon start sweeps those of workers
  that are gone or finished.
- **A worker never loads AgentHydra's own MCP server from its account under another name.** Its
  settings now also deny the endpoint by URL (`*://*/api/mcp*`, any host and port) beside the name
  denies, so an account's `.claude.json` listing a second PC's daemon as, say, `hydra-elsewhere` no
  longer gives the worker AgentHydra's tools.

## [1.7.0] - 2026-10-02

### Added

- **Two PCs can share their CliMayte queue** (owner, 2026-10-02: "so that if I have my two computers running they can see the CliMayte queue and not override each other"). A new toggle beside login sync (off by default; `POST /api/cli-instances/sync/queue`) shares this PC's queue, encrypted, through the same store; `GET /api/corch/remote` lists the other PC's workers for the view's cloud-icon rows. This PC counts the other PC's running work toward each account's cap and takes its newer usage readings, and never changes or judges its workers. **Redeploy the login-sync Worker once** (paste the new `cloud/login-sync-worker/worker.js`): until then the toggle reports that the Worker has no queue routes, and logins sync as before.

### Changed

- **No more reset notifications for CLI accounts** (owner, 2026-10-02): a CLI login's 5-hour or weekly rollover no longer raises a toast in the app or a Windows notification, and the ones already waiting are cleared. CliMayte runs dozens of those accounts around the clock, so they were a stream of "100 quota windows reset". Desktop accounts announce their resets as before.
- **CliMayte reads an account's usage again before placing work on a reading over 10 minutes old**, and an account so placed takes one worker until that worker reads it. The background check reads accounts only every 30 minutes: on 2026-10-02 #118 was placed at 82% and read 95%, and #119 at 79% and read 100%, both used outside CliMayte in between. These reads go one account at a time, like the background check (`/api/oauth/usage` answers a burst with a 429 that silences every account for tens of minutes), and a read hung for over two minutes no longer holds the others.
- **A run placed on an account already past CliMayte's 90% ceiling is reported apart** (`placedPast` in the totals), not as a ceiling stop or as CliMayte's peak: the 129% peak on #120 was an account with no reading whose first request was refused, not a stop line that failed. Its notice and journal line say it was found past the ceiling on its first request. Stops recorded before this are sorted the same way at the next start.

- **Restart is no longer held back by work that survives it** (owner, 2026-10-02: "I thought we were supposed to have decoupling from tasks running and my ability to restart"). CliMayte checks now run under a detached runner like the workers' own CLI, so a restart neither kills nor waits for them and the next daemon reads them on; the header's Restart refuses only for a pre-runner CliMayte worker inside the daemon. Dispatch runs, which reattach at boot, no longer refuse a manual restart; the unattended auto-update still waits for them. Two megarun checks of up to 20 minutes each had kept the button refused.
- **The CliMayte list shows how long each task has been active**, not how long ago it was queued: time waiting for an account or a reset no longer counts (owner, 2026-10-02).
- **In a week's last five hours an account works up to 89% of its week**, not 85%, one point under the 90% ceiling so a session can still write its handoff; up to 5 points of every account-week expired unused (owner, 2026-10-02: "Up to 90% near reset").
- The CLI tab's plus button says "Add account", what it does since the create-by-name dialog went.

- **CliMayte starts work on accounts that have room** (measured live 2026-10-02: 31 tasks waited 776 task-minutes while the capacity hint said 9 accounts sat idle):
  - CliMayte no longer holds a task for the 5-hour reset of an account that already has room for it: on 2026-10-02, 31 tasks waited 776 task-minutes that way and only 5 started at dispatch; a replay of that 04:36 tick now starts 21 of 31 (19 for a group dispatched with per_account 2).
  - When an account refuses a task (no room, or a reset worth waiting for), CliMayte tries the task's next account and waits only when every account refuses; before, 8 tasks waited on #90 while #95 and #94 ran no worker.
  - Accounts behind their weekly pace are used first, most behind first; an account counts as ahead only past 5 points, so '3% used with 3% of the week gone' no longer holds work (19 holds of about 23.5 minutes each).
  - The owner's ruling stays: a Max 5x ahead of its weekly pace still waits for a low Pro that refills within 30 minutes instead of taking everything.
  - A group with no per_account now runs 2 workers per Pro window of the account (up to 4 on a Max 5x that is not ahead of pace) instead of a flat 2; a per_account the dispatcher set is kept as given.
  - A failed check's follow-up goes back to its own account even when the group's slots there were taken meanwhile (one such move cost about 170k extra cache-write tokens).
  - Tasks of one dispatch start largest expected cost first, so a big task gets a fresh window before small ones fill it.
- **CliMayte handoffs say what really happened, and a long conversation hands off before it gets expensive:**
  - a session whose conversation reaches 150k tokens is asked to hand off to a fresh session, whatever its account's usage (37% of requests, 3,135 of 8,370, ran over 150k and carried 61% of cache-read tokens; expected saving is small, about 7% of a Pro window since 2026-10-01 15:00Z with a 30k re-read allowance). These handoffs do not count towards the 3-handoff cap.
  - the wind-down message names the window that is at its line (weekly or 5-hour) instead of always saying 5-hour, and a continuation is told whether the earlier session ran on this account or another and why it handed off (2 of 36 continuations ran on the same account and were told 'another account').
  - a continuation after a chain of handoffs is given every earlier session's transcript, newest first, not only the last (18 of 36 continuations were second or later in a chain).
  - a handoff on conversation size (150k) counts towards neither the handoff cap nor the moves cap, and its next session is no longer pushed off the account it left; a long task is bounded by 8 attempts and the spend cap.
- **CliMayte writes less to disk:**
  - CliMayte no longer rewrites every finished task on each change: workers.json holds only work in flight (about 75 KB for 17 workers, was 2.8 MB about every 40 s, roughly 4.7 GB of disk writes a day) and each finished task is its own file under corch/done. The first start carries every task of the old single file over.
  - A CliMayte dispatch of N tasks saves the store once instead of N times (21 tasks blocked the daemon for about 0.3 s).
  - CliMayte packs a finished attempt's log with zstd a day after it ended (corch/logs was 429 MiB in 813 files, growing 170 MiB a day); climayte_status reads packed logs the same as plain ones. A cancelled attempt whose runner may still be alive is left unpacked.
  - After a daemon restart, a usage reading replayed from a running worker's log keeps the time it was taken instead of being stamped as fresh, so it no longer outranks newer readings for the same account (18 of 27 restarts with runner workers had two or more on one account).
  - CliMayte workers no longer load the claude.ai-synced humanizer plugin (one account listed it in every request, 3 of 14 starts, and no worker ever invoked it).
- **CLI tab: pooled usage gauges on the folded table, and Add account on request:**
  - the folded accounts table now shows two gauges in its header, 5-hour and Week, each the share left across all signed-in CLI accounts weighted by plan size (a Max 5x counts as five Pros); hover gives how many accounts are counted and how many are signed out or unread.
  - the Add account email row is no longer always on the page. The header's plus shows it with the email field focused, an X closes it, it closes itself once the account is added, and it starts open on an empty table. A sign-in still waiting on the browser keeps its card when the row is closed.
  - the 'New CLI instance' name dialog is gone; the plus adds an account by email instead. Rename is unchanged, and the create_cli_instance route and MCP tool stay.
- **CliMayte: a failed task says what failed and what happened next:**
  - hovering a failed task's red cross now says what failed, how its attempts ended, what happened next (accepted or rejected and by whom, started again and on which model, follow-up messages waiting) and the end result.
  - the same four lines show under the title when a failed task is open.
  - In the task list, a failed verdict on a task that is still working shows as an amber 'on another round' arrow instead of a red cross, and the mark's hover says who judged it and what they said (on 2026-10-02 ten running rows each showed a red cross after their own check said no, and read as failed work).
- **CliMayte spends less, from a stress run on 2026-10-02** (eight Opus reviews of its own code,
  dispatched through CliMayte to the idle accounts, $5 in all):
  - **A task that is not converging stops and asks.** Past 8 attempts, 4 moves between accounts,
    3 handoffs, or 3 times its size estimate (at least half a Pro window) in one turn, it fails with
    why and what to do (split it, or continue it with climayte_send). Nothing capped this before;
    the worst task on record ran 12 attempts and 6 moves for $18.77. Retries no longer reset at a
    limit or a handoff, which made "3 per turn" into "3 between limits".
  - **A broken check fails at once** (could not start, exit 126 or 127) instead of sending the task
    back one rung up, twice, for something the worker cannot fix.
  - **climayte_status answers in a few KB, not about 96 KB.** Its default rows are the report row
    without the report text, with empty values left out, and finished work a verdict already
    covers is left out unless `all: true`. climayte_log prints a worker's title once per answer and
    returns 30 lines by default instead of 100 (it was 42% repeated titles).
  - **Workers carry about 5k fewer tokens on every request:** no magnific or connections-local MCP
    server, no claude.ai-synced skills (docx, pptx, computer-use and the rest), no auto-memory.
  - **A handoff is written before the step is finished**, since the 90% stop is about 30 seconds
    of heavy work away; a task two or three calls from done finishes instead; the note carries
    forward what the earlier handoff knew, and the next session checks it with cheap commands
    instead of re-running suites it reports passing.
  - **The engine reads the account pool at most every 3 seconds** (it rebuilt it from disk every
    second while work ran, about 15 file reads a second), and the live-session scan only counts.
  - **A wait for a busy account no longer rewrites the store every minute** (its reason carried the
    minutes since the desktop app was used).
  - **A session stopped at its own account's limit waits for that account** when it resets within
    30 minutes ("Waiting for its own account #N to reset at HH:MM: cheaper than moving"), and
    resumes there once it has room, instead of moving: a move re-writes the whole conversation
    into a cold cache (median 219k tokens against 49k for a resume at home). Priority work never
    waits.
  - **A restart cannot start a duplicate attempt.** After a restart the daemon asks Windows which
    runners are still CliMayte's; a failed or empty answer used to count as "gone", and the
    attempt was resumed while its first CLI still ran. It now means "unknown, still running" and
    is asked again; all unconfirmed runners go in one query with a 10-second timeout instead of
    one untimed query each, which could freeze a freshly started daemon.
  - **A restart or an auto-update waits for a running check.** A check is a plain child of the
    daemon, so a restart killed it and it ran again from scratch, up to 20 minutes each.
  - These two were written by CliMayte workers in the same stress run and reviewed before landing.

### Added

- **Every quota check says how much CliMayte room sits idle** (`climayteCapacity`,
  `GET /api/corch/capacity`). check_my_usage and list_usage add `climayte: {idleAccounts, hint}`
  when CLI accounts are signed in, free (not walled, not in use by someone else, under the
  wind-down line) and running nothing, so an agent deciding how to do its work sees the room. Ten
  accounts had sat idle for six hours while every chat did its own work (owner, 2026-10-02).

### Fixed

- **A cancel in a task's first second stops its CLI** (`voidSpec` in `server/src/climayte-core.ts`). Until the runner had written its pid, a cancel or urgent message only marked the attempt stopped and the runner started the CLI anyway; three such cancels each ran a whole task, $0.145-0.150 charged to nothing. The spec is now a single-owner claim: a stop voids it before the runner takes it, or marks the runner to be killed the moment its pid appears.
- **A detached check is safe at every point a daemon can die** (review of the change above): its record is saved before its runner starts, its verdict before its files go; a runner that died is told apart before the 20-minute timeout (an outage no longer reads as a failed check); the exit file is read again before a runner is called dead; a check whose runner keeps dying is judged after 3 tries instead of running forever; a stop keeps the check on record until its runner is confirmed and killed; a pid file vouches for its runner only while fresh, and a runner that already wrote its exit file is never killed (its pid may be a stranger's); Remove leaves a task whose stop is still under way.
- **A new round's check always starts**: an earlier round's check still being stopped is set aside and stopped on its own (`staleChecks`), where the new round used to go unjudged; and one task's unreadable check record no longer stops every task's tick.
- **A stop that could not confirm its runner tries again** (second review cycle): killAttempt marks such a runner to be killed once confirmed, and the identity check asks about every runner a stop is waiting on, not only a running worker's newest; a broken check's 'failed' and its verdict land in one save.
- **What a worker's session left running is in the orchestrator's report** (`leftRunning`) and on its attempt in the view, not only the journal: a worker's background deploy ended with its session while its turn said "still waiting on the deploy" (Odin mega-run, 2026-10-02).
- **Each task shows its id** (detail header, click to copy; the list's hover) and **each round in "Accounts tried" says why it started**: its check failed and how, a verdict sent it back, or a follow-up arrived.
- **A check written for Git Bash runs under the runner**: an append-only output handle swallowed everything Git Bash wrote and failed `sleep`, so a check's log is opened for writing.
- **CliMayte knows every account's reset times** (`withResetTimes` in
  `server/src/climayte-core.ts`). A reading from the CLI's own `/usage` keeps each reset as the CLI
  printed it ("Oct 4, 1am"), and CliMayte read only the parsed field, so four of ten accounts,
  the Max 5x among them, had no weekly reset: the weekly pacing could not judge them, and an old
  percentage outlived its window. The text is now parsed against when the reading was taken.

- **CliMayte refuses a task that could never run** (`POST /api/corch/workers`, a fuzz pass on
  2026-10-02). An account id that is not a CLI instance made a task that waited forever; a list
  with an entry that was not an id was trimmed to nothing, which means "any account". Both are
  refused now with what to give instead, and the route takes the cap as `per_account` too, the
  MCP tool's spelling, instead of ignoring it.

- **The CLI tab keeps its usage current by itself.** It only read the usage a row carried from a
  manual check, never the server's usage cache, so a 5-hour window Keep windows running had just
  started showed blank until something else on the page asked. It now reads the cache every few
  seconds, as the Instances tab does.

- **The CLI table's count counts the CLI table.** A CLI instance linked to a desktop account lives
  on that account's row, and the heading said "10 of 11" for it with no filter on, which read as a
  lost account. It says "10" now; the count's hover still names the linked one, and "x of y" means
  the filter set some rows aside.

## [1.6.0] - 2026-10-02

### Added

- **CliMayte goes around accounts someone else is using** (`server/src/core/hands-on.ts`,
  `accountInUse` in `server/src/climayte-lib.ts`). Before it places new work it checks every
  account: one whose desktop app a hand used in the last ten minutes (that app's own log, the check
  fan_out already makes), or one with Claude sessions running that are not CliMayte's (the chat
  that sent the work among them), takes no new work. A session already living there carries on,
  and a task that names the account still goes there. When only such accounts have room, the task
  waits and its row says which accounts are in use and why.

- **Every AI connected to AgentHydra knows CliMayte is there.** Its instructions name climayte_run
  as the Claude-quality tier beside the zswarm, for work the zswarm cannot do well, and the "you
  are about to run out" advice hands what is left to it; choosing the account stays AgentHydra's
  job. The instructions block got shorter while gaining it (1,991 characters against a 2,200 cap),
  which every request pays for.

- **Tokens belong to the account signed in, for CLI and desktop** (`server/src/core/account-tokens.ts`;
  `tokens` of `GET /api/cli-instances`, `GET /api/desktop-instance-tokens`). A reply's usage is
  credited to the account signed in to its instance when it was written (CLI), or to the account the
  desktop chat record is filed under, so signing an instance in to another account moves the figure
  with it. Each row shows its current account's tokens for the current 5-hour window, current week or
  all time on this PC (a 5h / Week / Total switch in each table's header, remembered per table), with
  input, output, cache read and cache write on hover. One usage per reply, and a transcript is
  re-read only when it changed. Another PC's work is not counted.

- **One sign-in for desktop and CLI** (`server/src/core/desktop-cli-feed.ts`). "Add a CLI login…"
  on a signed-in desktop instance now gives the CLI instance that desktop login straight away: no
  terminal, no second sign-in. A linked CLI instance with no login of its own keeps following the
  desktop's as it renews; one you signed in separately is left alone, and logging it out unlinks
  it. It works one way only: a CLI login cannot sign a desktop instance in.

- **Login sync carries desktop logins too** (`server/src/core/desktop-login-sync.ts`). A Claude Desktop
  account signed in on one PC is signed in on the other, in a profile with the same name and
  number, without the browser sign-in there. A newer login is written only while that desktop
  instance is closed (AgentHydra does it just before it opens one), so keep a synced desktop account
  open on one PC at a time. An account you signed in separately on both PCs is left alone, and a
  Log out leaves it out of sync on that PC. Windows only. Both PCs need this version.

- **An orchestrating chat can read and judge finished CliMayte work in one go**
  (`server/src/climayte-lib.ts` toReport, `climayte_status { report }`, `climayte_verdict { ids }`).
  A report view gives each worker in one short row: its status, what it used, how its runs ended,
  its verdict and the recap of what it did; several workers can get the same verdict in one call;
  and every worker says whether a verdict already covers its newest work, so the orchestrator's
  waiter only wakes it for results nobody has judged. On 2026-10-01 each finished worker cost the
  orchestrator about eight model requests at its full context.

- **A demo of the app over invented data** (`scripts/sue-demo`, `bun scripts/sue-demo/serve.ts`). The
  built web app with every answer made up in the page and no daemon behind it: six invented CLI
  accounts with token figures, and a Login sync that remembers a join, in two seats (`?seat=main`,
  `?seat=second-pc`). It is what simulated visitors (SUE) walk, so nothing they press can sign a
  real account out.

### Changed

- **The CLI accounts table is as long as its rows** (`web/src/components/CliInstancesSection.vue`).
  Unfolded, it no longer scrolls inside a third of the window; the tab scrolls instead. Its Tokens
  column sorts, and hovering a figure gives the exact total and the split (output, input, cache
  read, cache write). Launch moved from a button on every row into the row's ⋮ menu.

- **The Login sync dialog is one switch** (`web/src/components/CliLoginSyncDialog.vue`). "Sync
  all" is on by default, beside how many logins are in sync, when the last sync ran and Sync now;
  the list of logins stays away. Turn it off and every login is one line with a state of a word or
  two (hover for the sentence) and its own switch, with what the last passes did under it; turn it
  back on and every login syncs again. A login that cannot sync is listed either way. The store,
  Copy pairing code, Pause and Stop syncing sit at the bottom, and every explanation (what Login
  sync is, what a pairing code is) is behind an info bubble.

- **Descriptions are behind info bubbles, not paragraphs on the page.** The sentence under the
  CliMayte heading, the notes under the Analytics sections, the hints in the instance filter, the
  bodies of the link, associate, limit-reset, move-chats and secrets dialogs and the login history
  footnote each moved behind the circle-i beside their heading. Empty states, errors and the
  warning before a destructive action stay visible.

- **The CLI table's header is icons.** Login sync is a cloud; Keep windows running is a setting
  behind the table's gear, on the page it affects, with its weekly floor beside it; the "+ N on a
  desktop row" sentence beside the title is now the hover text of the count.

- **Each page's settings live on that page.** The Instances tab has a gear for which tables it
  shows, Allow paid extra usage and Claude native control. The Sessions list's ⋯ menu opens
  Session settings: the transcript editor, what Copy session file location copies, the search
  index and the ChatGPT handoff. The queue drawer's scheduler button (and the header's scheduler
  chip) opens the scheduler and auto-resume settings, which were Settings' Automation tab; their
  numbers save as soon as they lose focus. Usage auto-refresh stays in the Instances filter menu
  only. The Settings panel keeps what belongs to the whole app (appearance, the MCP server,
  notifications, updates, cloud sync), has no tabs, and lost its Save button: everything in it
  saved as it changed already.

- **What simulated visitors tripped on in the CLI tab** (a SUE round on `scripts/sue-demo`, the built
  app over invented data). While
  logins are still arriving the dialog says so ("5 of 10 in sync, 5 on the way", "First sync is
  running…") instead of a count that read as stuck. The Account column is left out when no instance
  uses a pasted credential, so rows stop saying "No account" beside a name that is an email, and
  names get the room. A row's ⋮ menu names the account under its number. The Keep windows running
  switch is drawn once its setting is known, so it no longer flips by itself after the page loads.
  Sortable headers in the instance tables are real buttons (the keyboard reaches them) that show a
  faint pair of arrows on hover, and Tokens sorts biggest first. A login still arriving
  reads "On the way"; no count shows before the list has loaded; the weekly usage header says so
  beside the 5-hour one. Four rounds, four visitors each: 4.0, 4.0, 4.25, then 4.5 stars of 5.

- **No function is over the complexity gate** (the Architect's cognitive and cyclomatic limits).
  Twenty-six functions were split into named steps with the same behaviour and the same order of
  side effects, CliMayte's `tick`, `launch` and `finish` and Login sync's `pass` among them; the
  tests that cover them pass unchanged (322). `server/src/climayte.ts` had grown past 3,600 lines
  and is now five files that import one way, each part moved as written: `climayte-core.ts` (the
  store, the journal, reading an attempt's log), `climayte-launch.ts`, `climayte-schedule.ts` and
  `climayte-totals.ts` over it, and the engine (the tick, the end of an attempt, the API) on top.

- **Login sync says why a login is left as it is in two words** (`server/src/core/cli-login-sync.ts`,
  the `note` field: `own`, `waiting`, `fed`). The sentence that used to fill the state column is the
  hover text now; `problem` carries only real errors.

- **Wall-clock reset times no longer depend on an English locale** (`server/src/usage.ts`): the zone
  formatter asks for Latin digits and the Gregorian calendar itself instead of pinning `en-US`.

- **CliMayte paces each account's week instead of draining the biggest one**
  (`server/src/climayte-placement.ts` paceGap, waitsForCooldown). An account that has used more of its
  week than the week has run ranks behind the others, and a task waits up to half an hour for
  another account that refills its 5-hour window soon rather than piling onto it. So when the Pro
  accounts run low, the Max 5x account is not handed everything at once. Priority work never waits.

- **The running-sessions count in the CLI table is green** (`web/src/components/CliInstancesSection.vue`),
  the colour of running, instead of blue.

- **CliMayte workers no longer explain deploying.** A worker is told not to deploy unless its task
  says so, and to answer a repository's deploy reminder in one line. On 2026-10-01, 22 of 47 reports
  carried a second turn about why the worker had not deployed.

### Fixed

- **A failed pass of the desktop-to-CLI login feed can no longer stop the daemon.** Its timer left
  a failure unhandled; it is now caught and logged, like every other repeating timer in the server.

- **Dialogs are as wide as they ask to be.** Ten dialogs that set their own width (Login sync, moving
  logins, limit reset, an instance's chats, moving all chats, the queue builder, the bulk-move and
  secrets dialogs in Sessions, the Codex move, the shortcut sheet) were all 384 px wide on any
  window from 640 px up: the width they passed did not replace the dialog's own.

- **The create button on an instance table no longer flickers under the pointer.** It widened on
  hover to show its label; in a full header that wrapped it onto the next line, out from under the
  pointer, so it shrank, came back and widened again many times a second. It is an icon with a
  tooltip now, like the buttons beside it: on the CLI, Codex and DeepSeek tables, and on the
  Instances tab's create menu, which had the same flicker.

- **The Instances table no longer scrolls sideways at the normal window width.** The sort arrows
  shown on every header, and the longer "Usage week" heading, made the narrow number columns wider
  than their numbers, and the table overflowed its frame by 19 px. The idle arrows now sit in the
  gap after the heading and take no width; the table fits in both column modes.

- **Escape closes a dialog on the Sessions page again.** The page's own Escape shortcut (close
  Find, clear the selection) ran first and marked the key as handled, and a dialog only closes on
  an Escape nothing has handled, so the keyboard-shortcuts sheet and every other dialog there
  stayed open and the session behind it was deselected. Page shortcuts now stand down while a
  dialog, popover or menu is open.

## [1.5.0] - 2026-10-01

### Added

- **CliMayte learns which model each kind of task needs** (`server/src/climayte-scorecard.ts`).
  Give a finished task a thumbs up or down in the CliMayte view (or the orchestrating chat does it
  after checking the work). A thumbs down asks what was wrong and sends the task back, one step
  up from Sonnet at low thinking towards Opus at max. Tasks sent with model "auto" get the
  cheapest setting that keeps passing for their kind of work, and now and then try one step
  cheaper. "What works" shows the passes, the fails and what each costs as a share of a Pro
  account's 5-hour window. A task can also carry a check command (a test, a
  type check): CliMayte runs it when the worker finishes and judges the result itself.

- **Tidier, more consistent instance screens** (`web/src/components/InstanceSectionHeader.vue`,
  `InstanceMenuHeader.vue`, `DeleteInstanceDialog.vue`). Every table's ⋯ menu opens with the
  instance number and its quick actions as icons (refresh, rename, log out, copy); Claude CLI
  instances can now log out too, and show their plan (Pro, Max 5×, Max 20×). The delete dialog's
  name to type copies itself on click. "Last running" (now, or how long ago) replaces "Last
  launched". Quick add results close by themselves. The CliMayte list is one line per task: a status
  icon, the title and the time, in a list about 24 rows tall that scrolls by itself. A task's
  header shows its status, account, working time and tokens with cost; the rest is one hover away.
  Background refreshes only redraw what actually changed.

- **Restarting AgentHydra no longer stops CliMayte tasks** (`server/src/climayte-runner.ts`). Each task's
  Claude CLI now runs under a small runner started outside AgentHydra's own process, so a restart or
  an update leaves it working; the restarted AgentHydra picks every running task up again from its
  files instead of redoing its current step.

- **One Instances table, and a CLI tab** (`web/src/components/InstancesView.vue`,
  `web/src/components/CliView.vue`). Claude desktop, Codex and DeepSeek instances are listed in one
  table, each row with its provider's logo, and a Provider filter picks which to show. The new CLI
  tab holds the Claude CLI instances and CliMayte together; each CLI row shows how many sessions run
  on that account, and its Log in signs that same account in again through Quick add. CliMayte keeps
  the tokens every session ran and shows the totals it has taken off your chats.

- **Paid extra usage is never billed unless you allow it** (`server/src/extra-usage.ts`). Some
  Claude accounts have claude.ai "extra usage" switched on: past their limits they keep working
  and bill you instead of stopping. The new Settings switch "Allow paid extra usage" is off by
  default, and while it is off AgentHydra stops every Claude session on such an account (desktop
  Code chats and CLI sessions alike) as the account reaches 98% of its 5-hour window or 99% of its
  week. The chat is kept and can carry on after the reset or on another account. The usage popover
  now says when an account can bill, and its "Turn off extra usage" button switches it off at
  claude.ai for that account, so it simply stops at its limits from then on. CliMayte uses the same
  switch and the same line for its workers.
  CLI instance rows now show the same credit-card icon when an account has extra usage on.

- **CliMayte: hand a task's pieces to your CLI accounts; each worker moves to another account by
  itself when one hits its usage limit** (`server/src/climayte.ts`, `web/src/components/CliMayteView.vue`).
  Tell a chat to climayte a task and it keeps only the orchestration: it splits the task, gives each
  piece to a Claude Code CLI session on one of your signed-in CLI accounts, and checks the results.
  Work is spread across the accounts by how much of their limit is left. When an account reaches
  its limit, the worker continues on another one from where it stopped, so you no longer move the
  thread by hand. Workers have no console window, but every one can be watched and steered in the
  new CliMayte view, and chats drive them with the MCP tools `climayte_run`, `climayte_status`, `climayte_send`
  and `climayte_cancel`. See [docs/CLIMAYTE.md](docs/CLIMAYTE.md).
  Each task shows its working time, cost and turns, the messages still waiting to reach it, why a
  queued task is queued again (moving accounts, retrying, resuming after a restart), and a banner
  when AgentHydra cannot be reached instead of a list that only looks alive.

- **Quick add: type an email, confirm in the browser, and the account is a signed-in CLI instance**
  (`server/src/core/cli-quick-add.ts`, `web/src/components/CliInstancesSection.vue`). The Instances
  view has one email box at the top. Press Enter, confirm the sign-in page that opens in your
  browser, and the account is ready for CliMayte, with no naming, terminal or `/login`. The box clears
  and keeps focus for the next account. If the browser page does not open, you can open it again
  or paste the code it gives you. Entering the email of an instance whose sign-in went stale signs
  that instance in again instead of making a new one.
  The sign-in window now does the typing (`server/src/core/signin-window.ts`,
  `orchestrator/scripts/lib/signin_window.py`): you pass Claude's human check if it shows one and
  open the sign-in link from your email in that window; it fills in the email you typed, moves the
  six-digit code to the waiting form, and authorizes only the request it was opened for. On Windows,
  a code or a Claude sign-in link you copy while it waits is picked up as well. Codes never leave
  the throwaway browser, and the window opens where you last left it.

- **Keep windows running: idle CLI accounts start their 5-hour window on their own**
  (`server/src/session-keepalive.ts`, `web/src/components/CliInstancesSection.vue`). With the CLI
  tab's "Keep windows running" switch on, a signed-in CLI account with no 5-hour window running
  gets one tiny request (Haiku, low effort, one turn, no tools, nothing saved), so its window is
  already counting down when you need it. Accounts that are signed out, at a limit, busy, or past
  85% of their weekly usage are left alone. A timer icon marks a row whose window the nudge started
  or whose last nudge failed, and every nudge is listed in the CliMayte journal. A nudge costs about
  two cents at list price. The weekly line it stops at moved from 80% to 85%.

- **Copy or move CLI logins to another PC** (`server/src/core/cli-login-move.ts`,
  `web/src/components/CliLoginMoveDialog.vue`). "Copy login to another PC" in a CLI row's menu saves
  the login to a file encrypted with a passphrase the page makes and shows you; tick "Also sign this
  PC out" to move it instead, so one login is not refreshed on two PCs. "Import logins" in the
  header of the other PC shows which logins the file holds before it opens it, puts each one on the
  instance with the same number or account, and checks that it is signed in. The file only opens
  with the settings AgentHydra itself writes, and only when the list it shows matches what is
  inside; a move signs this PC out only if nothing refreshed the login while the file was being
  made; and an account already signed in on the other PC is replaced only by a newer login of the
  same account, so importing the same file twice, or an older one, changes nothing.

- **Login sync: keep your CLI logins the same on two PCs** (`server/src/core/cli-login-sync.ts`,
  `cloud/login-sync-worker/`, the cloud button in the CLI tab). Point AgentHydra at a small
  Cloudflare Worker of your own and both PCs can stay signed in to the same accounts: when one PC
  refreshes a login, the other picks up the new one within about a minute, instead of being signed
  out a few hours later. The Worker only stores logins encrypted with a key that stays on your PCs.
  The second PC joins by pasting a pairing code from the first. Each login has a switch to leave it
  out on one PC, and logging out on a PC leaves it out there.

- **Each instance shows every account it has been signed into** (`server/src/core/login-history.ts`,
  `web/src/components/LoginHistoryPopover.vue`). A history button beside the account in the
  Instances table lists the accounts that have used that profile: the signed-in one first, then the
  rest by when each was last busy there, with how many chats each left, which instance each one is
  signed into now, and which others it passed through. When a row reads "(not logged in)" or
  "(unknown account)", the top entry says which account it was on and where it went. It is always
  shown on those rows and appears on hover everywhere else. The list comes from the chats each
  account filed in the profile, so it already goes back before this release.

### Changed

- **A signed-out account keeps its last usage numbers** (`server/src/usage-cache.ts`,
  `web/src/composables/useUsage.ts`). When an account goes yellow (signed out, or its login was
  rejected), its row keeps showing the last session and weekly numbers, dimmed, and the usage
  popover says "Last reading before it signed out". Accounts that were already blank get theirs
  back from the usage history. Those numbers are for reading only: fan-out, CliMayte and the usage
  survey still treat a signed-out account as having no room.

- **CliMayte starts a task where it can finish** (`server/src/climayte-placement.ts`). It counts what
  each account has left, what the tasks already running there will still use, and what this
  kind of task usually costs, so tasks no longer pile four to an account and run out halfway
  (the first real run moved tasks between accounts 48 times).

- **CliMayte sizes a task before it sends it** (`server/src/climayte-placement.ts`). From what that
  kind of task cost before, it estimates how much of a 5-hour window the task will use, and weighs
  that against each account's plan (a Max 5x window holds five Pro windows, a Max 20x twenty). A
  task bigger than half the biggest window it may use is sent back as "split needed", with how
  many pieces, before anything starts; `size: whole` runs it anyway. A task that would fit a fresh
  window but not what any account has left now waits for room, while smaller tasks take that room,
  instead of starting where it would run out partway and move.

- **The CLI tab fits the window** (`web/src/components/CliView.vue`). On a wide screen the page no
  longer scrolls: the accounts table folds away to its add-account row (and, open, scrolls inside
  itself), and CliMayte's task list and task fill the rest, each scrolling inside itself. The task
  list has a "Hide finished" switch that leaves only what is still queued, running or waiting.

- **A CliMayte task no longer leaves programs running** (`server/src/climayte-job.ts`). On Windows
  everything a worker's session starts runs in one container that ends with its run, so a dev
  server or watcher it left behind stops when it finishes; the task's log says what was stopped.

- **CliMayte's cost estimates learn from every finished task** (`server/src/climayte-placement.ts`).
  They used to count only tasks someone had judged, so Sonnet tasks costing 4-6% were still
  estimated at 14%. A setting with a few finished tasks now blends in, pulling the estimate
  toward its own record, instead of being ignored until it has enough.

- **CliMayte works each account between 85% and 90%, on its 5-hour and its weekly usage**
  (`server/src/climayte-lib.ts`). At 85% of either an account takes no new work and its running
  task is asked to hand off (the weekly line was 95%); at 90% a task still running there is stopped
  on the spot and the account rests until that window resets. Those stops show as "stopped at 90%",
  never as a limit hit. Allowing paid extra usage in Settings lifts both lines.

- **CliMayte stops each account at about 85% and never runs it into its limit**
  (`server/src/climayte.ts`). A task now starts only where it is expected to finish under 85% of
  the 5-hour window, and a running task that reaches 85% writes a handoff even when no other
  account has room; it then waits for the first account to reset. Before, with nowhere to go, it
  worked on until the account hit its limit. The totals report limit hits, each account's peak per
  window and estimated against actual cost, to test it.

- **CliMayte shows what every run cost, and what restarts cost** (`server/src/climayte-lib.ts`).
  Each run of a task keeps its own cost, requests and tokens, stopped runs included, and the
  first request of a run that picks a conversation up again (after a move, a limit, a handoff or a
  gap) counts as re-reading, apart from the work. A task shows both, the counter's hover says what
  share of everything went to re-reading, and what a kind of task costs counts only the work.

- **The token budget weighs tokens the way the plan meter does** (`server/src/usage-tokens.ts`,
  `scripts/quota-weights/`). `usage_budget` turned tokens into one unit using list-price ratios,
  but the meter charges output and cache writes far more than that relative to cache reads, and
  Fable 2.5x Opus where the budget charged them the same. The weights are now fitted to the meter
  on 47 accounts: per cache read, a cache write counts 32 (51 for a 1-hour write) and an output
  token 310; Opus counts 2x Sonnet, Fable 5x, Haiku 0.5x. Tested on accounts the fit never saw, the
  budget's typical miss on the weekly meter fell from 3.6 to 2.7 points per 6 hours (on the 5-hour
  meter from 3.1 to 1.7 points per hour). Analytics totals for old chats, including ones whose
  transcripts are deleted, are recalculated with the new weights, and the token-sink panel
  rescans once to match.

- **CliMayte workers use the 5-minute prompt cache** (`server/src/climayte.ts`) instead of the 1-hour one,
  whose writes cost more. Workers almost never pause that long (9 times in 2,105 steps), so
  this cuts the cost of cache writes by about a quarter.

- **CliMayte workers carry a short rule set** (`server/src/climayte-owner-sync.ts`). When
  `~/.claude/climayte-worker/` holds a `CLAUDE.md` and a `skills.txt`, workers get those instead of
  your full instructions and every skill: about 3 KB and 12 skills instead of 44 KB and 84, which
  added 24-33k tokens to every step a worker took.

- **Every account row looks the same** (`web/src/components/InstanceGlyph.vue`, `InstanceAccountBadge.vue`). Codex and
  DeepSeek rows now show the instance's own icon beside its number and the same email-handle pill as a Claude row,
  instead of a full name over an email or a folder path under the name (DeepSeek's folder and chat count moved
  into the name's hover). All three kinds of row draw these cells from one component each, so they cannot drift
  apart again.
- **The orchestrator's remote dashboard moved from port 7790 to 7793** (`orchestrator/package.json`
  `config.remotePort`). The zswarm MCP server listens on 7790, so the remote gateway could not
  start on a machine running both, and the phone dashboard stayed down. The port is now written in
  one place that the gateway, `remote.py`, the tray icon, the tunnel setup and the dev server all
  read, and `ORCH_REMOTE_PORT` still overrides it. The tray and `remote.py` now accept a server on
  that port as the gateway only when its health answer says it is the gateway. When another
  program holds the port, `remote.py --start` names it (process id and program) and exits with
  code 4 instead of retrying, and the tray's give-up message repeats that reason. The named tunnels' Cloudflare
  routing has to point at the new port: run `remote_tunnel.py --provision` for each of them.

- **The chat journal no longer re-reads every chat every five minutes**
  (`orchestrator/scripts/chatwatch.py`). Each pass walked every instance's whole profile folder
  (about 20,000 directories) to find the chat records, then parsed all of them again. It now looks
  only where the records are kept and reuses any record whose file has not changed: a pass takes
  0.2 seconds of CPU instead of 3.7, and archives, renames and moves are journalled as before.

- **An account is remembered after the instance it was on moves to another one**
  (`server/src/core/known-accounts.ts`). AgentHydra forgot who an account was the moment its
  instance signed into someone else, so older entries in the history above had no name, and an
  account signed into a second instance showed "(unknown account)" there until it could be checked
  online. Every account it identifies is now kept by account, so both show the address straight
  away.

- **The daemon no longer re-reads a whole chat every time it grows**
  (`server/src/sessions.ts`). Each time a transcript changed, the sessions list parsed all of it
  again, up to 12 MB, to learn about the last few lines. On a busy PC that was 186 MB of reads a
  minute and a quarter of a CPU core, all day. It now reads only what was added since the last
  read and checks that the file was not rewritten in between. A 10 MB chat that gains a turn now
  costs 0.8 ms of CPU instead of 93 ms. The usage-limit monitor also stops re-reading chats that
  have not changed since its last pass, and the dashboard stops polling while its window is
  hidden, then catches up as soon as you look at it again.

### Removed

- **The "Startup cost per new chat" panel** and `agenthydra --prefix-tax`. Nothing used its numbers, and every row
  read "not measured" until you clicked it.

### Fixed

- **The CLI tab no longer scrolls as a page** (`web/src/components/CliMayteStatusBadge.vue`). Every
  task row in the CliMayte list carries a status label for screen readers, and those labels were
  placed against the page instead of their row, so a long task list made the whole tab 4,777 px
  taller at 1920x1080. They stay in their rows now: at 1920x1080 and 3840x2112 the tab is exactly
  the window's height, the accounts table still folds away, and Hide finished still works.

- **CliMayte stops every worker on an account at the same moment** (`server/src/climayte.ts`). Each
  worker used to go only by the usage its own session reported, which says nothing while it sits in
  a long command. The night of 2026-10-01 three workers on one account were asked to hand off at
  85%; the fourth heard about it six minutes later, at 87%, and hit the 90% ceiling. Now each
  worker goes by the newest reading for its account from any of its workers.
- **A new or silent account gets one task first** (`server/src/climayte-lib.ts`). An account with no
  usage reading since its last reset takes one worker until that worker's first request reads it.
  One tick had sent four tasks to an account whose sign-in was broken, and all four failed together.
- **CliMayte's numbers for a night are that night's** (`GET /api/corch/totals?since=`). Every figure
  (runs, tokens, cost, the re-read share) now covers only the runs since that time, not the whole
  record; the totals list each ceiling stop (the reading, when it was asked to hand off, and how
  many workers were on the account); the journal shows a ceiling stop even when its handoff got
  written, and a waiting task's journal line says until when.
- **Workers take part in the shared edit warnings.** Each CliMayte worker runs the owner's
  edit_claims hook before it edits, so a chat about to edit a file a worker touched in the last half
  hour is told which task did it, and a worker is told when a chat did.
- **CliMayte's token count is right, and says what it counts** (`server/src/climayte.ts`). Work done
  before a task was handed to a fresh session counted as 0 tokens, so the total showed 289M where
  the real figure was 337M. Each run now records its own session, and the counter says "runs"
  (every start of the CLI) with how they ended and how many separate conversations they were.
- **CliMayte no longer bounces a task between nearly-full accounts** (`server/src/climayte-lib.ts`). An
  account past 85% of its window takes no new work, so a handed-off task waits for real room
  instead of hopping onto one account after another that is about to run out (20 such hops in 4
  minutes in the first real run).
- **An account whose organization turned Claude Code off is left alone** (`server/src/climayte.ts`).
  CliMayte retried it every 30 minutes with every waiting task at once; it now stays out until it
  signs in with another login, and the CLI list says why.
- **Accounts at their limit read "Limit"** (`server/src/usage-live.ts`, `web/src/lib/usage.ts`).
  An account CliMayte saw hit its limit no longer shows the lower number from before (43-50% while it
  could not run anything), and one past 100% no longer reads "104%".
- **Usage numbers no longer lag behind busy CLI accounts** (`server/src/usage-live.ts`). The
  usage check runs every 30 minutes, so an account CliMayte was working hard showed a number up to
  half an hour old (34% on an account really at 88%). Accounts with a CliMayte task running now show
  the live reading that task receives with every request.

- **Deleting a Codex instance no longer fails with "EBUSY: resource busy or locked"**
  (`server/src/core/codex-instances.ts`). Codex's Windows sandbox service keeps one empty lock file
  open in every Codex folder it has set up, for as long as it runs, so the folder could never be
  removed. The delete now removes everything else (the login and its sessions), finishes, and
  removes the leftover empty folder once the service lets go of it.

- **Auto-resume picks a session back up after its weekly limit resets** (`server/src/monitor.ts`,
  `rate-limit-discovery.ts`). A chat you started yourself that stopped at the weekly limit was
  checked again only while its transcript was less than 12 hours old, and a stopped chat's
  transcript never changes. So it was never resumed after the reset, and the resume list showed it
  as blocked for good. It is now checked again when the reset comes, however long that takes.
- **Auto-resume times a desktop chat by that chat's own account** (`server/src/monitor.ts`,
  `usage-service.ts`). A stopped chat from a desktop instance was timed by the plain Claude Code
  login's usage instead of its own account's, so it could resume hours early or late, or wait on
  another account's weekly limit. It now reads the usage of the instance the chat lives in. And a
  chat whose 5-hour window had already reset by the time it was checked waited another five hours;
  it now resumes right away.
- **Sonnet 5 is costed at $2/$10, not $3/$15, after September 1** (`server/src/pricing.ts`).
  Anthropic kept Sonnet 5's launch price as its standard price and never made the planned rise to
  $3/$15. The built-in price list still made that switch on September 1, so on a first run, an
  offline machine or a failed price download, every Sonnet 5 turn since then read 50% too
  expensive. Every Anthropic price was re-checked against Anthropic's pricing page on 2026-09-30.
- **The README screenshots show the current app and current models** (`scripts/screenshots/`).
  The capture had been failing since several views changed, so the images still showed August's
  app with Opus 5 and Sonnet 5. It now runs cleanly again, and the images show Opus 5.5 and
  Sonnet 5.5 and the Codex table on the Instances view.
- **The session index costs about an eighth of the CPU it did** (`server/src/transcript.ts`). Every
  refresh of the session list looked up the size and date of every transcript on the machine (4,910
  here), about 10 seconds of CPU spread over every core, and a refresh ran whenever the list was
  more than 10 seconds old: every few seconds while the web UI was open. It now re-checks only
  transcripts written in the last hour on each refresh and the rest every ten minutes, so a refresh
  costs about 1.3 seconds of CPU. New chats and active ones still show up at once; a chat reopened
  after more than an hour of quiet moves up the list within ten minutes.
- **The background daemon no longer spikes two to three CPU cores every five minutes**
  (`server/src/session-launch.ts`). The sweep that gives untitled desktop chats their real names
  read and parsed every chat record on the machine on every pass (3,494 files, 166 MB here) to
  find the few with no name. It now remembers each record until the file changes, so a pass costs
  about 0.12 s of CPU instead of 1.1 s, reads nothing it has already read, and a chat the app
  re-saves without its title is still renamed on the next pass.
- **Claude Desktop updates again** (`server/src/version-drift.ts`, `desktop-install-lock.ts`).
  AgentHydra opens every account from its own copy of Claude, which has no updater beside it, so
  Claude's update check failed with "Can not find Squirrel" and the real install was never run to
  update itself: it sat on 2.9939.2 for two days while 2.9939.4 was out. The 10-minute version
  check now asks Claude's own update feed and, when a newer build is out, runs the install's own
  updater, the same step the app would have taken. Nothing open is closed; each account moves to
  the new build the next time it is opened through AgentHydra, and the Incidents panel names the
  open ones still on the old build. A build the updater has not finished writing (or was stopped
  while writing) is never launched, and the next check finishes it. `check_versions` now shows
  the newest build on offer.
- **Claude opened from the Start menu is no longer stuck on an old build**
  (`server/src/claude-start-shortcut.ts`). Claude started from AgentHydra's own copy writes a
  "Claude" Start-menu shortcut aimed at that copy, which has no updater, so Claude opened from it,
  or from a taskbar pin made from it, stayed on 2.9939.2 and said it could not update. AgentHydra
  now points that shortcut back at Claude's real install after every launch and on every version
  check, keeping its notification id, and leaves a shortcut aimed anywhere else alone.
- **`claude://` links and the browser extension find Claude after an update**
  (`server/src/version-drift.ts`). Claude points both at the build it runs from each time it starts
  from its install, which under AgentHydra it never does, so both were still on 2.7032.0, a build
  the update then deleted, leaving sign-in links nothing to open. The version check now moves them
  onto the newest installed build when they name an older one, and flags it if it cannot.

- **Archiving a chat inside a running Claude Desktop works again on 2.9939.4**
  (`server/src/core/claude-native/native-program.ts`). That build moved the list of chats that are
  still starting to a new place inside the app, and every native archive, including the step of a
  move that retires the old copy, failed with "Cannot read properties of undefined (reading
  'has')". AgentHydra now finds the list in either place, so older builds keep working too.
- **`archive_desktop_chat` can retire a chat on an account whose app is closed or signed out**
  (`server/src/routes/desktop-sessions.ts`). An account set to native-only refused with "profile is
  not running" when its app was closed, and "account is unavailable" when the app was signed out.
  In both cases the app holds no chats in memory, so the old copy of a moved chat could not be
  retired by any tool. Both cases now write the archive flag on disk, as a move already does for a
  closed app. A scoped call is also no longer refused because the moved chat is running on its new
  account.

- **A move clears the old copy of a chat left under an account's previous login**
  (`orchestrator/scripts/migrate_chat.py`). An account's app shows only the chats of the login it
  is signed into now, so its own archive control cannot reach a chat still filed under an earlier
  login. Every such move landed the chat, then reported the old copy "NOT confirmed settled"
  (found 0) and left it unarchived on disk, where AgentHydra kept counting it as an active chat.
  The move now archives that copy by its flag on disk, as it already did for a closed app, and no
  longer calls the result provisional, because the app never loads that copy and cannot bring it
  back. `migrate_reconcile --finish` also stopped refusing such a copy as "source-writing" when the
  only running engine was the new account's own: the two copies can share one chat id, so the
  old copy borrowed the new one's `live`, and the move could never be finished.

## [1.4.0] - 2026-09-28

### Added

- **The number of active chats beside "Chats" in each Instances row menu** (right-click or ⋮).
  It counts the chats on that account that are not archived, so 0 means nothing is active there,
  and it is the same number the "Chats" dialog lists (`GET /api/chats/counts`, one store scan
  keyed by instance folder, read when a menu opens).

- **A machine's own brain for the judgment queue** (`orchestrator/scripts/lib/configlib.py`
  `interview.brain`, `interview.py`, `.claude/commands/orchestrate.md`). The chat running a pass
  answered every waiting chat on the generic doctrine. A new policy knob names a command that
  answers instead, such as a brain trained on the owner's own replies: `interview --ask` names it
  on its first line and in its JSON, and `/orchestrate` step 3 runs `<brain> ask` and
  `<brain> apply <file>` (which applies through `interview --apply`, so every rail still runs).
  A brain treats every pass as unattended unless `--by-hand` says the owner typed it, so a
  forgotten flag fails safe. Empty, the default, changes nothing. `policy` shows an unset text
  knob as "unset" and takes `null` to clear it. `hold_chat.py <session id> --release` now lifts a
  hold on a chat the fleet cannot resolve (a console chat a pass held by id), which had no way out.

- **Fuzzy, ranked session search** (`web/src/lib/fuzzy.ts`, `web/src/components/SessionsView.vue`,
  `web/src/components/SessionPicker.vue`). The sessions sidebar search and the session picker
  used a plain substring test, so `cdxsess` found nothing and hits came back in list order. They
  now use a port of fzf's v2 scorer: the query only has to be a subsequence of the title, working
  directory (or a substring of the id), matches at word starts, camelCase humps and in runs score
  higher, space-separated terms must all match, and the best match sorts first (ties keep recency
  order). The matched title characters are bolded in the sidebar. Ported from junegunn/fzf and
  microsoft/terminal (both MIT; notices in `THIRD-PARTY-NOTICES.md`).

- **Ask_user cards in the judgment queue** (`orchestrator/scripts/lib/asklib.py`,
  `orchestrator/scripts/interview.py`). A supervised chat can end its turn on a fenced
  `ask_user` JSON block (1-3 questions, 2-3 labelled options each, optional free text) instead
  of asking in prose. `interview.py --ask` shows it as numbered options, and the new `answer`
  decision picks an option per question, stages the composed reply (readable lines plus an
  `ask_user_answer` JSON block) for the courier, and marks the card answered once: a second or
  stale answer is refused (`askKey` is required), and an answer whose delivery expired, failed
  or was cancelled leaves the card open again. The archive gate counts a turn that ends on a
  card as a question, through an `ask_card` signal no policy switch can turn off, so a waiting
  card is never archived. Idea from Open WebUI's ask_user tool; nothing copied.

- **Fan-out members report a typed progress beacon** (new MCP tool `report_progress`,
  `orchestrator/scripts/fan_out.py` `beacon`, `server/src/mcp.ts`, `server/src/orchestrator.ts`,
  `orchestrator/scripts/lib/gatelib.py`). `fan_out_status` could only infer a member's state from
  its transcript, and a chat waiting on a person's answer read as `finished`. Each member's first
  prompt now ends with a `[fan-out beacon]` line naming its group and index, and the member calls
  `report_progress` with its mode (planning / execution / verification), a cumulative summary, its
  next step, and on hand-back the paths to review, a confidence with its reason, and
  `blocked_on_user`. `fan_out_status` carries each member's latest beacon, lists blocked members
  first, and never calls a group with a blocked member ok. Beacons keep their own file
  (`state/fanout-beacons.json`) and take no route lock, so a member can report while later members
  are still spawning; the fleet duplicate check ignores the footer.

- **`fan_out` proves each prompt landed and started (task receipt)** (`orchestrator/scripts/lib/receiptlib.py`,
  `orchestrator/scripts/fan_out.py`, `orchestrator/scripts/lib/gatelib.py`, `server/src/mcp.ts`).
  A spawned chat could hold its prompt as an unanswered turn and still read `spawned`. Every
  fan-out prompt now ends with a short receipt (token, repo, task id, expected artifact) that the
  chat is asked to echo first. `fan_out_status` classifies each member from its transcript:
  delivered, no-echo, wrong-task, never-started, wrong-chat or pending. After the last spawn,
  `fan_out` waits `receipt_secs` (default 180) for every echo and nudges a never-started chat
  once through the composer. It never types into a wrong-chat member, and a misdelivered
  member makes the fan-out partial. `receipt: false` (CLI `--no-receipt`) sends the bare
  prompt. The fleet duplicate check ignores the receipt. Idea adapted from
  ultraworkers/claw-code's prompt-misdelivery check (MIT).

- **`history_search` / `history_read`: search what compaction dropped from your own session**
  (`server/src/compaction-history.ts`, `server/src/mcp.ts`). The calling Claude Code session's
  transcript is resolved from the caller's process chain and the live registry, and the text
  before its last compaction (user/assistant text, tool calls, tool results) is searched
  lexically: up to 8 excerpts of 600 characters with stable source ids, read back exactly in
  4,000-character pages, marked as historical data. Idea from bytedance/deer-flow (MIT).

- **Revive a chat Claude Code deleted** (`orchestrator/scripts/migrate_chat.py --revive`, new
  `orchestrator/scripts/lib/revivelib.py`, `docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md`). Claude Code
  deletes transcripts past `cleanupPeriodDays`, after which `--resume` fails. `--revive <id>`
  rewrites a surviving copy (`--source`, another account's projects folder, or delete_chat's undo
  copy) under the same session id, keeping only what a replayed request accepts: thinking blocks
  dropped (their signatures cannot be rebuilt), every `tool_use` paired with a later
  `tool_result` or dropped, orphan results dropped, and only the active branch since the last
  compaction, relinked into one chain. An existing transcript is rewritten only with `--force`
  (original kept as `.pre-revive-<time>`) and never one written in the last 300s. Rules adapted
  from LobeHub's Claude Code transcript rebuild (ideas only). Tests: `tests/test_revivelib.py`.

- **Pi sessions are readable** (`server/src/foreign-sessions.ts`, `server/src/agent-catalog.ts`).
  Pi was detected but unread. Its sessions (`~/.pi/agent/sessions`, or
  `PI_CODING_AGENT_SESSION_DIR`) now list, search, tail and export beside the other foreign
  tools. A Pi file is a tree whose branches share one file, so the reader follows the last
  entry's parent chain rather than the file order, and every branch left behind with /tree lists
  as a fork of the session. The catalog row now names the variable Pi actually reads; the old
  `PI_DIR` was not one. Pi's recorded usage is not priced yet.

- **Working, waiting on you, or done: a live status per Claude Code session** (new
  `server/src/agent-status.ts`, `server/src/status-hooks.ts`, `server/src/routes/agent-status.ts`,
  MCP tools `agent_status` and `status_hooks`, a badge in the session list). The session list could
  say a chat was recently active or cut off by a usage wall, never that Claude is working right now
  or sitting on a permission prompt. Claude Code's own hooks say exactly that; `status_hooks
  { install: true }` writes them (opt-in, touching only its own hook groups) and they post to the
  daemon. The rate-limit scan writes into the same store, and releases a row once its stop is no
  longer found, so a resumed session never stays "waiting on you". One row per session, precedence decided
  once at write time with its provenance on the row; a row read back after a daemon restart is
  `restoredUnconfirmed` and never shows as live; and the lead's own state is kept beside the folded
  one, so a finished lead with a running sub-agent reads working. Design follows stablyai/orca's
  agent status store (MIT), written fresh. See docs/REFERENCE.md "Working, waiting on you, or done".

- **Box select, Ctrl+A and Escape in the session list** (`web/src/composables/useMultiSelect.ts`,
  `web/src/lib/session-multiselect.ts`). Choosing bulk-reply or bulk-move targets no longer means
  ticking rows one by one: drag a band over the rows in select mode (Ctrl/Cmd/Shift-drag adds to the
  selection and also works outside select mode; holding it at the list's edge keeps scrolling), press Ctrl/Cmd+A with the list focused to select
  every visible Claude row, and Escape with the list focused clears the selection before it closes
  the open session (an Escape that dismisses a menu or dialog leaves the selection alone).
  Shift-click, Ctrl+A and the box all end as one of two requests (set all, set a range) applied to
  the checked set, an idea taken from Dear ImGui's multi-select API.

- **Recurring mistakes: fail-then-fix command pairs mined from transcripts**
  (`server/src/command-corrections.ts`, `server/src/routes/analytics.ts`, `server/src/mcp.ts`,
  `server/src/opencode-sessions.ts`, `web/src/components/CommandCorrections.vue`). The same agent
  mistakes kept coming back, and each time the fix sat two commands later in the transcript where
  nobody would look. The Analytics tab's new **Recurring mistakes** panel reads the newest Claude,
  Codex and OpenCode sessions on demand, pairs each shell command that failed with a recognisable
  error (unknown flag, missing argument, wrong path, command not found, permission denied) with the
  similar command that then succeeded, and groups the pairs by error kind and base command with
  occurrence and session counts. **Copy as rules** puts them on the clipboard as a rules file such
  as `.claude/rules/cli-corrections.md`. A failing test run followed by a passing one, or an
  identical retry, is not counted. Read-only, bounded by a session limit and a time budget, nothing
  stored; commands are secret-redacted. Also `GET /api/analytics/corrections` and the MCP
  `get_command_corrections` tool. Idea from rtk's `rtk learn` (rtk-ai/rtk, Apache-2.0), written
  fresh.

- **`fan_out` spreads load before an account saturates, and a spawn tree can only narrow**
  (`orchestrator/scripts/fan_out.py`, `server/src/mcp.ts`, `docs/REFERENCE.md`).
  - Load bias: every chat the fan-out ledger spawned into an account in the last 20 minutes (about
    the usage reading's lag) lowers that account's place in the ranking by 15 points. Usage readings
    lag the work, so back-to-back fan-outs used to both drain the roomiest account first. The bias
    moves the order only: an account's reported room and whether it may take a chat at all are
    still the reading's own, and with no recent spawns the order is exactly the room order.
  - Narrow-only envelope: a member that fans out again is bound by its group. It may name its
    parent (`--parent`, MCP `parent`: a group id or a member sessionId); when it does not, the MCP
    passes the calling chat's own session ids (`--caller-session`) and a caller that is a ledger
    member is narrowed by its group, while any other caller starts a new tree. Its envelope comes from the parent's by narrowing only
    (depth + 1 toward a cap of 2, accounts intersected, exclusions united, chats per account, node
    cap and quota ceiling the smaller, closed apps opened only if both allow it), so a delegated
    chat can never reach more accounts or budget than the group it belongs to.
  - Tree ledger: the whole spawn tree holds at most 12 chats, a brand-new root included, so a large
    `per_account` fan-out leaves tasks past 12 unassigned (`--max-nodes`, MCP `max_nodes`, can only
    lower it; `--max-depth`, MCP `max_depth`, likewise for the depth cap); a group's planned members are counted and recorded under the ledger lock before
    anything spawns, and members past the cap are reported unassigned with the reason.
    `--ceiling-pct` (MCP `ceiling_pct`) keeps accounts at or over that peak usage out of the tree.

- **MCP answers can be projected and are held to a byte cap** (`server/src/mcp-output.ts`,
  `server/src/jmespath.ts`, `server/src/mcp.ts`, `server/src/index.ts`). Every read tool takes an
  optional `jmespath` argument applied server-side, so an agent takes one field instead of a whole
  session list; a bad expression refuses before the tool runs, and a miss or type error answers
  with the payload's top-level keys. Every answer is then measured in UTF-8 bytes and, over
  `AGENTHYDRA_MCP_MAX_RESULT_BYTES` (default 80000), cut in five named phases with the tool's own
  narrowing arguments, keeping a write's `ok` / `verdict` / `operationId` and per-item outcomes so
  an oversized write answer never reads as a failure. Before this a big transcript or list either
  flooded the agent's context or was cut silently by the client.

- **The open transcript keeps its place: older turns page in, new ones wait below**
  (`web/src/composables/useChatScroller.ts`, `web/src/composables/useOpenSession.ts`,
  `server/src/transcript.ts`). One headless scroller now owns where the transcript sits, instead
  of a hand-rolled "within 120px, then jump" check in the tail loader:
  - **Load older turns** at the top pages 40 more turns in, up to the daemon's 200-turn cap, and
    the turn you were reading stays where it was. `/api/sessions/:id/tail` answers `has_more`, so
    the button shows only when an older kept turn really exists.
  - A live poll follows the reply only while you are at the bottom. Scrolled up, you stay put
    and a **Jump to latest** button appears (**New turns below** once something arrived).
  - Opening a body-search hit lands on the newest loaded turn that holds the searched text,
    not at the end.
  - The pane is `role="log"` with `aria-relevant="additions"`, and carries `data-pending-scroll`
    until its opening position is applied.

- **Prefix tax per spawn** (`server/src/prefix-tax.ts`, `server/src/routes/prefix-tax.ts`,
  `web/src/components/PrefixTaxSection.vue`, `agenthydra --prefix-tax`). Measures what each Claude
  CLI and Codex home re-ships on every spawn: tool count, MCP tool count, schema kB and the
  heaviest MCP servers, so a bloated MCP loadout is visible before a fan-out multiplies it. The
  harness is started once against a loopback sink that speaks anthropic-messages and
  openai-responses and answers "DONE", so no model runs and no quota is spent; Claude runs with
  `--no-session-persistence` and Codex in a throwaway `CODEX_HOME`, so no chat is saved. Runs only
  on a click or the CLI flag, never on a timer. Idea from JuliusBrussee/caveman's subagent-tax.

- **The orchestrator says WHICH kind of not-done a stopped chat is** (`orchestrator/scripts/lib/livenesslib.py`,
  `orchestrator/scripts/lib/gatelib.py`, `orchestrator/scripts/dashboard.py`,
  `orchestrator/scripts/fan_out.py`, `orchestrator/orch.py`). A finished or idle chat's last
  assistant turn is classified as `completed`, `advanced` (tool calls, no claim of done),
  `plan_only` (a plan and no tool call: "I'll inspect...", "Next steps:"), `blocked` (waiting on
  a key, login or access only a person can give), `needs_approval` or `needs_followup`, with the
  run's stated next action. The `wait-on-person` decision names it, `orch.py loop` counts it
  under the gate stage, and `fan_out status` reports `liveness` and `nextAction` per member, so
  a fanned-out chat that came back with a plan is no longer read as a result. Informational:
  no lane or archive signal changes. Idea after paperclip's run-liveness classifier (MIT).

- **A chat's standing goal is continued, and audited while it moves** (new lane
  `orchestrator/scripts/goal_watch.py`, `lib/goallib.py`, scheduled as `goal-watch` every 5
  minutes, policy group `goalwatch`). The /goal command keeps a goal in `tmp/handoff/GOAL.md`
  (STATUS: IN PROGRESS, a NEXT checklist), but nothing outside the chat read it back: a chat that
  stopped at a milestone sat idle with its goal open. The lane finds each live chat's goal file
  from its working folder (up to the repo root), continues only a chat whose transcript has named
  that file, and only once its turn has been over 15 minutes. The continuation asks for a
  one-line audit of the last turn (PROGRESS, VERIFIED WAIT on a named live handle, or NO
  PROGRESS: a status restatement is no progress, a repeated blocker is one blocker, a timeout is
  not an ending) and a per-requirement completion audit before DONE, never shrinking the goal to
  what passes. From outside, a continuation that leaves the file byte-identical counts as no
  progress and the next one says so; after 3 in a row the goal is filed as an incident and the
  chat is left alone until the file changes. When the chat's account reaches 80% of its usage
  window it gets a wrap-up instead (no new work, leave the file resumable, keep IN PROGRESS),
  once per climb over the line, which sits below the courier's 85% delivery gate so it can still
  arrive. A chat waiting on its person (its turn ended on a question, or the goal holds an open
  `NEED:` item) is never nudged, and when a swap leaves two live owners of one goal only the one
  that spoke last gets a continuation or a wrap-up. A continuation the courier would refuse
  (account over its soft target) is skipped, not failed. Plan-only unless the tray icon is up,
  skips held chats, `goalwatch.enabled` off in the
  observe-only preset. Idea from OpenAI Codex's goal continuation prompts (Apache-2.0), wording
  written fresh. Tests: `tests/test_goal_watch.py`.

- **Frozen MCP API levels** (`server/src/mcp-api-levels.ts`, `server/mcp-api-levels/1.2.0.json`,
  `server/mcp-api-levels/1.3.1.json`, `scripts/mcp-api-level.ts`, `server/tests/mcp-api-levels.test.ts`). Each release commits its MCP
  tool surface (names, `since`, input schemas without prose), generated from `TOOLS`, and `bun test`
  replays every level against the live tools: a removed tool or argument, an optional argument made
  required, a dropped enum value or a narrowed type now fails the suite instead of silently breaking
  an agent's saved prompt. A version bump with no frozen level fails too; `bun run mcp:api-level
  --write` freezes it (docs/RELEASING.md). Idea from Neovim's API levels.

- **Recovery recipes with a ledger** (`orchestrator/scripts/lib/recoverylib.py`,
  `orchestrator/scripts/fan_out.py`, `orchestrator/scripts/stall_watch.py`,
  `orchestrator/scripts/attempts.py`, `server/src/mcp.ts`). A closed table of known failures
  (delivery-failed, account-at-cap, chat-stalled, tray-not-armed), each with one fixed automatic
  step, at most one automatic attempt, and an escalation policy (alert-human files an incident,
  abort, log-and-continue). The new `fan_out recover` / MCP `fan_out_recover` meets each failed
  member of a group with its recipe; `fan_out_status` shows each member's recipe and the group's
  recovery ledger, and `attempts.py --recoveries` prints the whole table and ledger. A failed send
  is re-sent only when the message route refused it before typing (400/404/409), never after a
  422 or an unconfirmed one; a stalled chat is asked once and not again until it has stopped
  being stalled.
  Idea from ultraworkers/claw-code's recovery recipes (MIT), written fresh.

- **Token sinks: why sessions were expensive** (`server/src/analytics.ts`,
  `server/src/routes/analytics.ts`, `server/src/mcp.ts`, `web/src/components/AnalyticsView.vue`).
  A "Where the tokens went" panel on the Analytics tab, `GET /api/analytics/sinks` and the
  `get_token_sinks` MCP tool rank five sinks against one weighted total, each tagged structural or
  behavioral, measured or estimated, with a one-line fix:
  - skills and MCP servers loaded into every prompt but never used, ranked by the prefix tokens
    they carried (the injected text's length at four characters a token, re-read on every call);
  - calls whose prompt was past 150k tokens of context;
  - subagent spend, and cache writes (each session's first, unavoidable write included), plus
    the share of prompt served from cache per account.
  The scan keeps skill and MCP server names with counts, never text; a skill listing is stored
  once per distinct listing. `ANALYTICS_VERSION` is now 8, so the background warm rescans every
  transcript once. Idea from the learn report in JuliusBrussee/caveman; no code copied.

- **Quota windows calibrated into dollars** (`server/src/quota-calibration.ts`,
  `server/src/usage-budget.ts`, `server/src/mcp.ts`). `usage_budget` now returns
  `budget.dollars`: what 100% of the weekly and the 5-hour window is worth in list-price dollars
  of Claude Code work, and about how many dollars are left. Readings are grouped into windows
  keyed by their reset time rounded to the minute; each clean window gives one (percent moved,
  dollars spent) pair and a Theil-Sen median turns them into dollars per percent. Windows that
  hit a cap, were cut short by the weekly cap, fell back, rose with no recorded turn, held an
  unpriced model or moved under 3 points are left out and counted. `check_my_usage` carries the
  last calibration re-priced to the current reading as `dollars`. Only the account's own config
  dirs are priced (a CLI instance's, or a passed `configDir`); Codex accounts and the [`~/.claude`](docs/CLAUDE-CONFIG-LAYOUT.md)
  fallback stay uncalibrated with a caveat, since another login's turns would overstate what is
  left. The store is written by rename after a fresh re-read, and a first walk reaches back at
  most a week. Figures are null until `usage_budget` has seen a clean window. Idea from lobehub/lobehub's
  quota calibration, written fresh.

- **Behavioural eval for the MCP server** (`scripts/mcp-eval/`, `bun run eval:mcp`). Checks that an
  agent can still reach a known answer through the tools, which a lint of the tool definitions
  cannot see. Read-only questions ("which instance has the most weekly quota left?") are answered
  over the real stdio server against a frozen fixture fleet. The report gives accuracy, tool calls,
  tools used and time per question. A scripted reference agent runs in the test suite. `--serve`
  and `--score` let an agent in a visible chat take the same eval, with its feedback on each tool.
  Idea from the mcp-builder evaluation harness in anthropics/skills (Apache-2.0).

- **Edit survival: did the code a session wrote stay written?** (`server/src/edit-survival.ts`,
  `server/src/analytics.ts`, `server/src/routes/analytics.ts`, `web/src/components/AnalyticsView.vue`).
  Two hours or more after a Claude session's last Edit/Write (and a Codex session's structured edit
  tools), the analytics scan re-reads the files it edited and scores the share of the text it wrote
  still present, by 4-gram overlap. The session's own later rewrites do not count as losses; deleted
  files and relative paths are skipped; sessions first seen more than 14 days after their last edit
  are left unscored. "Worth a look" flags a session that kept under half its code, and shows the
  period's average. Only the number is stored. Opening the analytics tab rescans sessions whose
  measurement has come due. Idea after VS Code's Copilot edit-survival tracker (MIT); written fresh.
  `ANALYTICS_VERSION` is now 8, so the store is rescanned once in the background.

### Fixed

- **Listing one Codex account's sessions takes a fraction of a second, not a minute**
  (`server/src/sessions.ts`). `list_sessions` scoped to an account the Desktop origin join cannot
  name, a Codex account above all, still kept every Claude chat Desktop had no record for and read
  each one before throwing it away: 68 seconds to return nothing over 2,511 transcripts. Those
  chats are now kept only for a scope the join can actually place them in. The same call takes
  182 ms.

- **An update can no longer leave you with no AgentHydra running** (`server/src/relaunch-handoff.ts`).
  After applying an update, AgentHydra started its replacement and quit 0.8 seconds later
  without checking that the replacement had actually started. On 2026-09-25 it had not, and
  nothing answered for 90 minutes. The running copy now keeps serving until the new one reports
  in, and if none does within a minute it stays up on the current version and says so in the log.
  The in-app Restart answers only once the new copy has reported in.

- **Moving chats no longer kills AgentHydra** (`server/src/core/chat-store-scan.ts`). Every
  read of the desktop chat stores (the live-chat index, the per-account chat list, the chat
  dossier) re-read and re-parsed every chat record on the machine, 3,395 files and 1.3 seconds
  in which the server answered nothing. A `move_chats` batch asks for those in a loop, so the
  tray's watchdog saw three unanswered health checks in a row and restarted AgentHydra, taking
  the batch with it: eight restarts in nine minutes while moving three chats off a full account.
  A record is now read again only when its file changed, so a repeat read takes about a sixth of
  the time and a moved or archived chat still shows its new state at once. Measured under the
  same load, health checks went from about one miss in two to about one in twelve.

- **AgentHydra no longer freezes at startup or under a busy session list** (`server/src/core/`,
  `opencode-sessions.ts`, `zswarm-sessions.ts`, `instance-sessions.ts`, `edit-survival.ts`). The
  new stall log caught two freezes on the first day: 3.7 seconds at startup and 4.7 seconds while
  the chat list was being polled, each long enough for the tray to count missed health checks.
  Profiling named every cause, and each one now either runs without blocking or stops repeating:
  - Startup added up the size of every OpenCode chat by reading all 8 GB of its database; it now
    reads the stored sizes (2.5 s down to 0.1 s). OpenCode sizes are now bytes rather than
    characters, so those chats are re-counted once in the background after updating.
  - Counting an OpenCode chat's replies read every message in full (up to 160 MB each); that
    count now runs on a separate thread.
  - Every refresh of the session list re-read all 625 zswarm job files (279 MB); now only the jobs
    that changed are read.
  - Each account's chat lookup re-read all 3,397 desktop chat records every 15 seconds, and the
    once-a-minute permission check read them all again; both now reuse the records already read
    and refresh in the background. The live-chat and chat-list reads check the records without
    holding up anything else.
  - The code-survival score now pauses between chunks instead of scoring a whole file in one go.
  - The health check itself read git's files to tell whether the code on disk had changed, and
    during a commit that took 0.8 s. It now answers from memory and re-reads in the background.
  Measured on a test copy of AgentHydra with the same load that froze the real one: missed health
  checks went from 38 of 121 (up to 8 in a row) to none of 121, and the slowest health answer
  took 69 ms.

- **AgentHydra's log now says why it was restarted** (`server/src/stall-sentinel.ts`). When the
  tray restarts an unresponsive AgentHydra it force-kills it, and nothing was written: the log
  showed only the next start. A background watcher now writes `STALL` lines to `daemon.log`
  while the server is stuck, naming the requests it was serving, and a line when it recovers;
  a server kept busy by many short stalls gets a `saturated` line naming what the time went to.

- **"Which account am I" no longer tells a Claude Code agent it is not running under Claude
  Code** (`server/src/mcp-self.ts`). When AgentHydra could not tell which process had called it
  (seen on the first call after a restart), it described its own process instead, found no
  Claude Code above it, and said so, which refused `move_chats` with `to: "here"` for a
  reason that was false. It now says the caller could not be traced and suggests calling again
  or naming the instance number.

- **Setting a chat's effort and ultracode inside a running app works again**
  (`server/src/core/claude-native/native-program.ts`). The installed Claude app no longer has
  `startingSessionIds`, and the ultracode action read it through the archive snapshot, so every
  call failed with "reading 'has'" before anything changed. It now reads only the chat's effort
  and ultracode flag.

- **Turning `doctrine.stamp_ultracode` off no longer reports every chat as missing ultracode**
  (`orchestrator/scripts/lib/stamplib.py`, `migrate_chat.py`). With the knob off, your own chats
  keep the effort and ultracode they were given, the doctrine pass leaves them alone, and a move
  no longer says it stamped ultracode. The stamplib tests now run on the shipped policy rather
  than the machine's own `state/config.json`.

- **"Move chats to account" takes the chats off the old account's screen, not just its disk**
  (`server/src/move-source-settle.ts`, `server/src/routes/desktop-sessions.ts`). The Instances
  menu and the Sessions migrate settled the old copy with a disk flag alone, which a running app
  ignores and saves over: every moved chat stayed in the old sidebar, and because the store then
  said "archived", moving it again from there answered "No chats to move" for a chat on screen.
  The old copy is now archived by its own app (native control), the way the MCP mover and the
  Archive action already did; a closed app still gets the flag, which it reads when it starts.
  A chat the old app would not archive is named in a warning with the reason, and stays listed on
  both accounts where a later move can still find it. Nothing writes the flag under a running app
  any more. On an account without native control whose own Archive click did not take, the old
  copy is queued instead and archived as soon as that app is closed
  (`server/src/move-retire-on-close.ts`), judged by a fresh process scan (a failed scan waits)
  and also checked right before AgentHydra opens that account. A chat moved back to an account
  it left, unarchived there, or found already living there by the MCP movers cancels anything
  still queued for it there. An account at its usage limit that stopped another chat's preview
  server says so in the move's warning.
- **The "Chats" dialog on an account that has never held a chat says so** instead of "Couldn't
  read the chats" (`GET /api/chats` no longer 404s an instance the registry resolves).
- **A just-opened Claude Desktop app shows its banked reset and credit within seconds**
  (`server/src/usage-service.ts`, `server/src/routes/instances.ts`). Those facts are read only
  from a running app, and only the usage sweep read them, at most every 30 minutes: an app
  opened between two sweeps showed no reset icon until the next one, or never if it closed
  first (instance #15, 2026-09-25). An Open now asks the app itself a few seconds later. It
  makes no quota request, so an Open never adds an unattended quota check, and the reading is
  kept only while the cached one is still this profile's account.
- **A chat moved off a usage wall gets its resume typed instead of sitting idle**
  (`orchestrator/scripts/lib/gatelib.py`). The landed engine answers its boot prompt with a
  synthetic "No response requested.", and the app can then file the old engine's stopped-task
  notification under that same prompt. The gate read either one as a turn in flight, so the
  courier never typed the resume and the peer channel does not wake an idle desktop chat: a
  chat moved #14 -> #15 on 2026-09-25 sat idle 12 minutes until a person typed into it. Both
  now read as a finished turn; a tool result still reads as in flight.
- **`move_chat`, `move_chats` and `list_chats` take a profile's folder label or a first name**
  (`server/src/core/instance-ref.ts`). The tools promise "number, name, label or email", but a
  name had to be the full account name and only `list_chats` took the label, so `temp2` and
  `Artem` were refused. Both resolve now, under the same exactly-one-row rule as a name.

### Changed

- **The Discord link now opens AgentHydra's own channel and gives you the AgentHydra role** on joining,
  instead of dropping you in the server's general room to find it yourself.

## [1.3.1] - 2026-09-25

**TL;DR**

- **Opening and closing a Claude Desktop instance is much faster**
- **A fan-out that cannot press Send clears its prompt from the composer**
- **Chats far down a long sidebar or inside a collapsed group are reached**
- **A spawn whose new chat opened empty is retried once**
- **Console chats start at high effort instead of max**

**Everything in 1.3.1**

### Fixed

- **Opening and closing a Claude Desktop instance no longer waits on AgentHydra's own checks.** An
  Open or a Close used to take several times longer than Claude itself needs. Every check still
  runs, but faster and without blocking the app's startup, and the Instances tab and the quick
  window show a confirmed open or close on the row at once.
- **A fan-out that cannot press Send no longer leaves its prompt typed in the composer.** It waits
  a few seconds for Send to become available; if it still cannot send, it empties the composer, but
  only when the text there is its own prompt. The member's record says whether the text is gone.
- **A chat far down a long sidebar is scrolled to, not refused.** Sending to a chat the sidebar had
  not drawn yet used to fail. The courier now scrolls the sidebar to find it and puts the scroll
  back if the chat never appears.
- **A stuck permission prompt in a chat inside a collapsed sidebar group is reached.** Collapsed
  project groups are opened to find the chat and folded back afterwards.
- **A spawn whose new chat opened empty is sent once more.** A new chat sometimes opened with no
  prompt typed, and the fan-out member ended unbound. The spawn now tries once more in exactly that
  case, never when a prompt may already have been typed.

### Changed

- **Console chats start at high effort, not max.** Chats the fleet starts or wakes run at the more
  efficient effort, and your own chats keep theirs. Set the console effort back to max in the
  orchestrator policy if you want the old launch.

## [1.3.0] - 2026-09-25

**TL;DR**

- **Each Claude Desktop account shows its banked resets, Claude Code credit and usage credits**
- **Usage advice tells an agent near its limit that the account holds a reset**
- **The instance tables stop re-sorting on every usage reading**
- **fan_out on a busy PC answers with a refusal instead of failing silently**
- **A failed process scan no longer reads as "nothing is running"**

**Everything in 1.3.0**

### Added

- **What only claude.ai knows about each Claude Desktop account.** The usage check reads it from
  each running Claude app; a closed app keeps its last reading, dated. Banked usage-limit resets
  show as a reset icon beside the account name, the one-time Claude Code & Cowork credit as a coin
  icon (amber when unclaimed or held back), and usage credits as a card icon while they are on. The
  usage chip's popover lists all of it, with this week's usage split by Claude Code, Chats and Cowork.
- **Usage advice names a banked reset near the limit.** When an account is at warning or critical,
  the usage tools tell an agent that the account holds a reset and how it can be spent.

### Fixed

- **The instance tables no longer re-sort on every usage reading.** Rows move only once the
  readings have settled. A header click still re-sorts at once.
- **fan_out on a busy PC answers instead of dropping silently.** A run that would be refused as
  busy is refused at once, and fan_out returns that refusal with the operation holding the PC. A
  fan-out that dies early leaves a failed group record saying why, and a placeholder or failed
  group never reads as ok.
- **A failed process scan no longer reads as "nothing is running".** The instance list falls back
  to the last scan that answered, at most a few minutes old. Destructive actions still refuse.
- **launch_instance answers "launched" only when the app stays up.** An app that exits within
  seconds is reported as a failed launch.

## [1.2.0] - 2026-09-24

**TL;DR**

- **A chat whose background task hung is asked whether it is stuck**
- **Chats the toolbox launches can run at their own effort**
- **unblock_prompts is an MCP tool and can target one chat**
- **Opening a Codex Desktop instance works again**
- **A fan-out never adopts or types into somebody else's chat**
- **A moved chat keeps its name**
- **The "Move chats to account" menu says it lists accounts**

**Everything in 1.2.0**

### Added

- **A chat that left background work hanging is asked whether it is stuck.** A new orchestrator
  lane finds chats whose sub-agent, workflow or background command has gone silent after the chat's
  turn ended, and asks the chat once which task it is and how to stop it. It never stops anything
  itself, asks at most three times and then files an incident. It runs only while the tray icon is
  up, skips held chats, and is off in the observe-only preset.
- **Chats the toolbox launches itself can run at their own effort.** Every fan-out member, chip,
  manager and console chat the toolbox starts is recorded, and new policy settings decide their
  ultracode and effort. The defaults keep the old behaviour, and your own chats keep theirs.
- **unblock_prompts is an MCP tool, and it can be aimed at one chat.** A chat stuck on an Allow,
  Accept or Continue prompt can be cleared by naming it, without waiting for the fleet-wide sweep.
  Naming a chat narrows the sweep but keeps every safety check, a named chat that is not waiting is
  reported as such, and a mistyped option is refused instead of turning into a fleet-wide press.
- **AgentHydra can be pointed at a specific Claude CLI.** A new setting names the Claude CLI to run,
  for machines where a global npm install would otherwise win.

### Fixed

- **Opening a Codex Desktop instance works again, and never claims a launch that did not happen.**
  After a Codex Desktop update Windows refused the plain start while AgentHydra still said
  "launched". Packaged Codex now starts inside its package on the instance's own profile, and
  success is reported only once its process appears.
- **The Codex terminal launch runs the newest Codex CLI the desktop app installed.** After an update
  it could pick the older copy left beside it.
- **A new CLI instance copies MCP servers from the same Claude config Claude Code reads.** On Linux
  it could read a different home folder.
- **A fan-out never adopts somebody else's chat.** A chat a person started on the same account
  during a spawn could be taken as a member and typed into. A new chat is now bound only when its
  first message is the spawn's prompt, sending and deleting refuse a member whose chat opens with
  someone else's words, and the prompt is no longer sent twice.
- **A moved chat keeps its name.** Moved chats could arrive on the new account as "General coding
  session" because the running app overwrote the title. AgentHydra now restores the title for a
  while after a landing, unless you rename the chat yourself, and the title repair that had stopped
  running is scheduled again, closed accounts included.

### Changed

- **The "Move chats to account" submenu says it lists accounts.** It is headed "Move to which
  account?", the switch reads "Show accounts that are not running", and the confirm dialog says
  every chat moves, running or not. Which chats move did not change.

## [1.1.0] - 2026-09-22

**TL;DR**

- **AgentHydra says when it runs older code than its folder, and restarts in one click**
- **The Instances table shows each account's last launch and remembers its sort**
- **Native control no longer breaks when Claude Desktop updates**
- **move_chats can stop a live chat itself when the source account is nearly out of usage**
- **Claude Code sessions keep AgentHydra's tools when another Claude app rewrites its config**
- **The permission picker no longer reports working chats as unapproved**

**Everything in 1.1.0**

### Added

- **The app says when AgentHydra is running older code than its folder, and restarts it in one
  click.** After a commit or a pull, a source install kept serving its old code, so new tools went
  missing silently. The header now shows "Restart to load new code", MCP tool results flag it, and
  the restart keeps the same port.
- **The Instances table shows when each account was last launched on this PC**, and sorts by it. It
  counts launches through AgentHydra and, on Windows, launches from anywhere else, kept per machine.
  An account shows a dash until it is next seen starting.
- **The Instances table remembers how it was sorted** across reloads and restarts.

### Changed

- **Native control no longer pins a Claude Desktop version, so a Claude update stops breaking it.**
  Everything it needs is read from the installed app, with the same safety checks, and anything
  ambiguous refuses. A new account gets native control, with its debugger on its own port, when it
  is created or next opened; choosing "Use standard controls" is remembered.
- **move_chats stops a live chat itself when the source account is at 98% or more** of its 5-hour
  or weekly usage. Below that, ending a live chat still needs a person's word, and an unreadable
  usage reading never triggers it.
- **A move whose source row was only flagged on disk is reported as not finished**, because the
  running source app still shows it.

### Fixed

- **The permission picker reported working chats as unapproved.** After a Claude Desktop layout
  change it took the open chat's own header button for a second sidebar row. It now finds the
  sidebar's edge from its chat rows, in any language and layout.
- **Claude Code sessions lost AgentHydra's tools when another Claude app rewrote its config.** The
  registration is now re-checked every minute and restored if it drifted, and the health check says
  whether it points at this daemon.
- **A table sort put missing values first when descending.** Stopped and never-launched instances
  now sort last both ways.
- **A managed Claude copy made during a Claude update is no longer trusted.** A copy made while the
  update was still installing could be missing files. Copies are checked against the install on
  every use and rebuilt when incomplete.
- **Native archive checks the Claude code it relies on first.** It refuses a Claude build whose
  archive could remove a checkout's files or whose preview cleanup changed.

## [1.0.0] - 2026-09-20

**TL;DR**

- **Sign-in, settings sync and update checks work again after the old domain went offline**
- **The version line moves to 1.x**
- **Chats hidden by a re-login are flagged and moved correctly**
- **In-app archive and rename work again on a menu's first open**
- **Archiving under a running app removes the row itself, and unarchiving sticks**
- **Hangs on helper processes are gone: every wait has a deadline**
- **Finished orchestrator runs end on time and keep their output**
- **Moves re-check source rows a running app brought back**

**Everything in 1.0.0**

### Added

- **Archive every chat that shares one title.** The chat actuator can archive every row with the
  same title in one run, up to 25. Rename and unarchive still act on one chat.

### Changed

- **The version line moves to 1.x.** This release is 1.0.0 rather than another 0.x.
- **The chat actuator is one copy again.** AgentHydra was running an older copy that lacked window
  activation, exact account matching, the last-moment row check and support for non-English apps, so
  archive and rename could fail or reach the wrong account. All of it now runs from one copy.

### Fixed

- **Sign-in, settings sync and update checks reach Connections' new hosts.** The old domain was
  suspended by its registry on 2026-09-18, and every call to it failed without a word. Settings sync
  needed its own fix in the Connections library, which this release takes. The website's analytics
  moved too.
- **A re-login no longer hides chats while every tool says they are there.** The desktop app shows
  only the chats of the account it is signed into. Chats filed under a previous login are now flagged
  in list_chats and shown in red in the Instances Chats panel, moves count only chats the app really
  shows, and moving such a chat to the same instance brings it back into view (the old record is
  backed up, never deleted).
- **The console chat list no longer includes headless jobs.** Only Claude Code sessions with no
  desktop home are listed; swarm and bench runs are grouped separately.
- **An in-app archive or rename no longer fails every time.** The app rebuilds a row's menu button
  when the menu first opens, and the actuator lost track of it, refused and left the menu open. It
  now finds the row by identity, acts only through the menu it opened, and always closes it. This
  was not yet proven end to end when it shipped.
- **A refused archive reports the real reason**, not its tidy-up note.
- **Waits on helper processes have deadlines.** Many places waited on a child process with no limit:
  reading saved account keys on Windows could deadlock, the clipboard copy could never answer, and
  quitting an app could hang on a stuck kill. All of them now share one bounded helper that stops the
  whole process tree at the deadline and keeps what was already read. The shared tray kit got the
  same fix.
- **Unarchiving a chat right after archiving it sticks.** The watcher that defends an archive against
  a running app's re-save kept undoing the unarchive for ten minutes while reporting success. It now
  runs only for an archive, an unarchive cancels any watcher still running, and the answer says
  whether the flag stuck.
- **Archiving a chat under a running app removes the row.** The archive used to write the flag and
  tell the caller to run a script; it now clicks Archive in the app itself, with a time limit, and
  says when the click did not settle. Its answer no longer claims a click that did not happen.
- **A finished orchestrator run is reported finished.** A run whose helper kept its output open stayed
  "running" until its deadline and lost its report. It now ends when its process does, keeps every
  line it printed even when cancelled, and can no longer stay "running" forever.
- **Moves re-check source rows a running app brought back.** A source row settled under a running
  app could reappear later. Moves now re-check and re-settle such rows after resuming, and keep
  checking them afterwards.
- **One stuck delivery no longer eats a whole courier run.** Each row has its own time budget, so
  the rows after it still get their turn.
- **A freshly launched app's chats are read correctly.** The actuator now wakes the app's
  accessibility tree on a cold start and after opening a row menu, and says when nothing was readable
  instead of blaming the sidebar.
- **A row menu left open no longer breaks later archives of that chat.**

## [0.43.0] - 2026-09-17

**TL;DR**

- **The orchestrator has a policy file: set it by wizard, by an AI, or one setting at a time**
- **A broken policy file stops unattended actions until it is fixed**
- **A dry-run tool runs the dry loop many times to prove it works**
- **Fleet liveness is one daemon call, so planning is much faster**
- **AI answers no longer override a hold you placed by hand**
- **A move reports chats that went archived while it ran**
- **Replies are no longer deferred on a turn that has already ended**

**Everything in 0.43.0**

### Added

- **The orchestrator has a policy file.** Most of what the orchestrator does (archiving, sweeps,
  doctrine stamps, waking, delivery, usage bands, scheduled lanes and more) can now be switched and
  tuned in one place, and every default equals the old behaviour. Set it with a step-by-step wizard,
  with a questionnaire an AI can answer, or one setting at a time; it can also list, explain and
  check settings and offers four presets. A lane switched off is unscheduled, not merely skipped.
- **A broken policy file stops unattended actions.** An unreadable file, an invalid value or an
  unknown key refuses every unattended act until it is fixed, so a typo can never quietly undo your
  choice. A forced act by hand still runs, and edits from two places at once both land.
- **A dry-run tool runs the dry loop many times and proves it works.** It reports crashes, verdicts
  that flip back and forth, and time per stage, and can check that each policy setting really
  changes the plan, saying "not proven" when the fleet cannot show it.

### Changed

- **Liveness for the whole fleet is one daemon call, not one per chat.** Planning makes the same
  decisions many times faster, and a chat whose session id changed still counts as live. It can be
  turned off in the policy.
- **The dry loop names the console strays the land lane left out.**

### Fixed

- **The orchestrator no longer force-archives over a hold you placed by hand.** An AI's archive
  answer used to lift your hold. That is now a policy setting, off by default, and a held chat is
  reported as your word kept.
- **A move now says so when a chat it was never given went archived while it ran.** Such a chat is
  named at the top of the report with the account to unarchive it from, and the move is not reported
  as clean. The actuator also re-checks the row under its open menu before archiving or deleting,
  and a lookup for one account can no longer return a similarly named account's chat.
- **A reply is no longer deferred on a turn that has already ended.** The busy check is re-read at
  the moment of delivery; if it cannot be read, the chat is still treated as busy.
- **A sidebar pass that sees nothing now says which window it read and what it saw**, and the
  archive actuator reads the app's biggest visible window.
- **A chat waiting on a person is explained by the signal that actually held it.**
- **The land-console lane no longer queues sessions that are not Claude chats**, and reports how
  many it left out.
- **Four policy settings that did nothing are now wired up.**
- **The dry-run tool treats a live chat crossing the idle threshold as expected**, not as a defect.
- **The policy wizard with no one to answer says nothing was written**, and showing a preset with
  an uncapped setting no longer crashes.

## [0.42.0] - 2026-09-15

### Added

- **The DeepSeek zswarm is now a seventh session source, plus its own cost source and routing advice**
  (`server/src/zswarm-sessions.ts`, `server/src/zswarm-cost.ts`, `server/src/config.ts`'s
  `ZSWARM_HOME`, `'zswarm'` joining `SessionSource` in `server/src/types.ts`, and every non-compiler-
  enforced site DSH's own addition documented needing one). `~/.zswarm/jobs/<id>/job.json` reads as a
  session (a task's prompt/result standing in for a turn, since the zswarm has no back-and-forth
  conversation of its own), listable, searchable, exportable and tailable exactly like every other
  source - and unlike DSH's zstd log, job.json is plain JSON, so it opens in an editor same as a
  Claude transcript would. `~/.zswarm/ledger.jsonl` is summed by day/model/backend
  (`summarizeZswarmCost`), and the account's live DeepSeek balance (`deepseekBalance`, key read from
  `~/.dsh/.credentials.yaml` at runtime, 3s timeout, 5-minute cache, degrades to `status: 'unknown'`
  rather than ever throwing) now rides beside the per-account Claude/Codex quotas in `list_usage`'s
  `deepseek` field. `list_usage` and `fan_out`'s own descriptions, and the MCP server's standing
  instructions, now name `zswarm_run` as where mechanical/checkable batch work belongs once every
  Claude account reads at or above 90% weekly, rather than queuing it behind N account resets.

- **`migrate_reconcile.py` - the half-moves a killed batch leaves, found and repairable**
  (`orchestrator/scripts/migrate_reconcile.py`, `lib/mutationlib.py`'s `advance_phase`,
  `migrate_chat.py`'s three phases, and two suites). A move is FOUR acts - import, verify, settle
  the source row, stamp the mode - and only the first pair was ever written down. So when the
  25-chat batch of 2026-09-13 was killed mid-flight, 14 archived chats sat imported onto the
  target and still unarchived on the source (duplicates, not moves) with nothing on the machine
  saying which of the 25 were which; the fleet read taken right after even showed all 25 still on
  the source, so the run was honestly reported as "nothing landed" and the truth surfaced twenty
  minutes later, by eye.

  Every migrate mutation now carries a PHASE, advanced by the phases themselves, and the new
  script re-checks each unfinished row against the chat's CURRENT state rather than trusting the
  journal: `unsettled` (the half-move), `not-landed` (the ledger and the machine disagree - the
  loudest row here), `settled` (the journal is advanced so it is never re-read), `gone`, and
  `unknown` for a failed read, which is counted WITH the unsettled ones because ignorance is not
  a pass. `--finish` re-drives `migrate_chat`'s own `phase_settle`/`phase_stamp`; `--reverse`
  hands the row to `undo.py`. It owns no actuator of its own.

- **"Kill it and move it" no longer needs a `taskkill`: a `terminate_live` move preempts a patient
  move of the same chats** (`server/src/orchestrator.ts`, `server/tests/orchestrator-preempt.test.ts`).
  The route lock is keyed by SCRIPT NAME, so on 2026-09-12 a patient `move_chats` sitting out its
  300s wait refused the same move with `terminate_live` as `409 busy`, and the only way through
  was to find the engine's pid by hand and kill its tree - outside every rail these tools exist to
  provide. Two conditions, both necessary: the incoming call carries `--terminate-live` (a
  person's word, overriding the very wait it is queued behind), and its chats COVER the holder's,
  so nothing the kill strands is left un-redone. A holder naming chats the new call does not is
  still refused, with `orchestrator_cancel` named - that abandonment is a person's decision, and
  `migrate_reconcile.py` now exists to find what it leaves.

- **Clicking a Weekly cell copies the date and time that window resets, as `09/18/2026 9:59 AM`**
  (`web/src/components/CopyResetDate.vue`, the three instance tables, `web/src/lib/usage-reset.ts`,
  `web/tests/usage-reset.test.ts`). The bar says `4d 9h`, which is the right thing to READ and the
  wrong thing to paste into a calendar or a message; working the date out of a countdown is
  arithmetic nobody should do by hand. Owner request, 2026-09-14; the local time was added
  2026-09-15, because "the 18th" alone does not say whether the quota is back at breakfast or at
  midnight. A cell with no ISO reset instant
  (the `claude -p "/usage"` fallback prints a YEARLESS "Sep 18, 9:59am") is not a button at all,
  rather than copying a date whose year was guessed.

- **`orchestrator_cancel { id }` - a run that is still going can be stopped, without finding a pid**
  (`server/src/mcp.ts`, `server/tests/orchestrator-mcp.test.ts`). The daemon has had
  `cancelOrchestratorOperation` and `POST /api/orchestrator/operations/:id/cancel` all along; only
  the MCP surface was missing, and `orchestrator_operation`'s own description says it "starts
  nothing and cancels nothing", so every agent that read it correctly concluded no cancel existed.
  On 2026-09-12 that sent a stuck one-chat batch to a hand-run `taskkill /PID <pid> /T /F`, which is
  outside every rail these tools exist to provide.

  Two things are in the description because both bite. ⛔ **Cancel is not an undo:** whatever the
  run already did stays done, chats a `migrate_batch` already landed stay landed, and it stops only
  the remainder. ⛔ **The per-item report dies with the process,** so what actually happened is
  established by READING THE FLEET afterwards, never by assuming the run had not got that far.
  Cancelling also frees the route lock the daemon keys by script name, which is what lets a
  corrected call run at once instead of being refused `409 busy`. A finished operation is a safe
  no-op that answers with the status it already had.

- **The public-push rule has teeth: a pre-push hook announces a PUBLIC remote and refuses the push
  unless told to, refuses a release tag while the local work queue has an open section, and a
  bundle commit must name every file it swept** (`.githooks/pre-push`, `check-public-push.mjs`,
  `.githooks/commit-msg`, `check-bundle-message.mjs`, `scripts/save-bundle.ts`, `bun run
  save:bundle`, two suites under `.githooks/tests/`). This repository is public and a push to
  `main` is a release for every source install, so the standing rule was "check visibility,
  announce it with an unmissable heading, let the owner decide". It lived only in memory, and on
  2026-09-11 a session that had not read it pushed a peer's half-finished work unannounced. Now:

  - **`git push` looks the remote up on GitHub** (stripping `.git`, which reads as 404 for a public
    repo too) and, when it is public or cannot be proven private, prints
    `# WARNING: THIS REPOSITORY IS **PUBLIC**` with the refs and stops. `AGENTHYDRA_PUSH_PUBLIC=1`
    on that one command prints the heading again and proceeds: the rule is announce-then-do.
    Fail-closed on purpose: a non-GitHub remote, a timeout or a rate limit all read as public.
    With neither node nor bun on PATH it refuses rather than guesses.
  - **A `v*.*.*` tag is refused while `docs/todo/TODO.md` has a section below its Contents**,
    naming them. No override: the item gets done or the owner deletes it (nothing pending ships
    past a release). The queue is local and gitignored, so a clone without it has nothing to gate
    on and passes.
  - **A `wip: bundle` commit carries `Mine:` and `Swept:` blocks** listing every path in the
    commit, checked against the index by the commit-msg hook so a stale list cannot pass. `bun run
    save:bundle -- --mine <paths>` sweeps the tree and writes the message from what is actually
    dirty; a `--mine` path that is not dirty is refused. Bundling a peer's work is legitimate when
    the owner asks for it (2026-09-12); publishing it without the author being able to find it in
    the log was the hazard.

- **A Codex chat moves between accounts, and the copy is verified before the original is archived**
  (`server/src/core/codex-chat-move.ts`, `core/codex-transcript-copy.ts`, `core/codex-rpc.ts`, the
  routes `GET /api/codex-instances/:id/move-chats` and `POST /api/codex-instances/:id/move-chat`,
  and four suites). Codex itself has no move: a thread belongs to the home it was written in. So
  this copies the rollout under a fresh id, imports it into the destination, confirms it really
  landed, and only then archives the source, which means an interrupted move leaves two readable
  chats rather than none.

  - **The copy keeps its DISPLAYED history, not merely its model messages.** Paginated ordinals and
    `item-completed` events are carried across untouched, because downgrading `history_mode` makes
    Codex silently drop the items from view while the model messages sit intact on disk: a chat that
    looks empty and is not.
  - **Every rail refuses BEFORE it connects.** An unfinished CLI turn, an unknown process state, a
    changed login, a destination that is the same home, an archived or out-of-home transcript, and a
    corrupt move history each stop the move at planning time. A failed import keeps the copy and
    never archives the source; a failed archive retries the saved copy instead of copying again; an
    edit during the import keeps both chats and refuses a stale retry.

- **Codex usage is read per instance, through the same paths that read Claude's**
  (`server/src/usage-service.ts`, `usage-refresh.ts`, `routes/usage.ts`, `core/codex-account.ts`,
  `web/src/components/UsageBadge.vue`). `checkUsageForCodex` is shared by the manual refresh, the
  fleet sweep and the instance routes, so a ChatGPT-authed Codex home reports its own remaining
  quota instead of nothing at all. A home that is not ChatGPT-authed drops its cached reading rather
  than serving a stale one, and a logout clears it.

- **DeepSeek Harness homes are managed instances: launch, open, stop, and one home per account**
  (`server/src/core/dsh-instances.ts` + its suite, `server/src/config.ts`, `server/src/routes/
  instances.ts`, `server/src/core/instance-numbers.ts`, `server/src/transcript.ts`,
  `web/src/components/DshInstancesSection.vue`, the API client and the locale). A "DeepSeek
  instances" table now sits under the Codex one, listing every `DSH_HOME` on the machine - the
  default `~/.dsh` first, then any created here - with whether a server is serving it, on which
  port, and how many chats are in it. Launching starts `dsh web` HIDDEN and opens its chromeless
  window; stopping kills the listener; the home, its chats and its credentials are untouched by
  either.

  - **⛔ THE SERVER'S URL NEVER LEAVES THE DAEMON.** `dsh web` prints a one-time `?token=` that IS
    the session. So the daemon reads it out of the harness's own log, opens the window itself, and
    answers with an outcome - no route returns it, the SPA never holds it, and "open" is an action
    rather than a link. For the same reason there is no login verb and nothing here opens
    `.credentials.yaml`: signing in is the user's own step.
  - **It sees a server it did not start.** The harness's own desktop wrapper records its port in
    `launcher.json` and its address in `.web-url`, so a harness the user launched from their own
    shortcut shows as Serving, and "open" reuses it instead of starting a second one. Proven against
    the live one on this machine: `#62 DeepSeek Harness · Serving port 3080 · 2 chats`.
  - **Every home is indexed, not just the default** (`dshInstanceStores()`, the DSH twin of
    `codexInstanceStores()`). A second account's conversations would otherwise be invisible to
    listing, search and analytics - the exact hole config.ts's CODEX_HOME comment warns about, which
    is why `deepseek-harness` joins BUILT_IN_TOOL_IDS: the indexer asks the registry, once.
  - **The default home is listed but never managed.** It is the machine's own install: it can be
    read, launched and stopped, and delete refuses unconditionally - no confirm string unlocks it.
    Deleting a home AgentHydra did make needs the name typed back AND the path to be inside our own
    instances directory, so a hand-edited registry cannot be turned into a delete of somewhere else.
  - Numbers come from the one sequence desktop, CLI and Codex instances already share (`dsh` is its
    fourth kind), so `#62` means the same thing in the table, the API and the MCP tools.

- **DeepSeek Harness (`@deepseek-ai/dsh`) is a first-class session source** (`server/src/
  dsh-sessions.ts` and its suite, plus `agent-catalog.ts`, `types.ts`, `transcript.ts`,
  `sessions.ts`, `session-search.ts`, `session-export.ts`, `analytics.ts`, `pricing.ts`, `mcp.ts`
  and the web's label/filter/chart maps). Its chats now list, search, tail, export and PRICE
  alongside Claude, Codex, OpenCode and Hermes - read straight off `~/.dsh` (or `$DSH_HOME`, the
  harness's own override precedence), with nothing to configure and nothing written back.

  It is a sixth reader rather than a catalog row claiming someone else's format because the store is
  a third shape: one file per session like Claude's, but the bytes are **multi-frame Zstandard**, so
  every generic path that opens a transcript and reads lines would have got binary and silently
  found nothing - `Bun.file().text()` on those bytes does not throw, it returns mojibake, and the
  session would have listed with a garbage title and an empty transcript rather than erroring. Read
  out of the harness's OWN shipped source (0.1.5-rc.1), not inferred from one transcript:

  - **The listing is cheap because the harness already did the work.** `storages/session_projcache/`
    is its own materialized view of each log - title, cwd, created-at, token totals, last prompt  - 
    so listing N sessions costs N small JSON reads instead of N decompressions. It is treated as the
    cache it is: every field re-derives from the log, and a session with no projection still lists
    by decoding its header.
  - **A torn tail does not hide a live session.** The log is appended as independent frames and the
    backend documents crash recovery, so the last frame on disk can be half-written; a failed decode
    falls back to the longest prefix that ends on a frame boundary, which costs nothing in the
    normal case because the normal case succeeds first time.
  - **Archived state is real**, read from the harness's own `workspace.json` - the thing the
    `foreign` lane structurally cannot do, where every adapter hardcodes `archived: false`.
  - **The transcript shows the conversation and not the bookkeeping.** Fifty-odd event types exist;
    four carry who-said-what. The harness's injected runtime-context snapshots arrive as user
    messages with `source.kind: 'plugin'` and are dropped - showing them would put "Current DSH file
    policy: workspace-write…" on screen as though the user had typed it.
  - **Spend is per TURN, a first for a non-Claude source.** OpenCode and Hermes hand back one
    aggregate and land a whole session on one day; DSH timestamps every assistant message, so its
    turns are apportioned to the days and hours they happened in. ⛔ Its counts are DISJOINT
    (`inputTokens` is uncached input only, cache reads reported separately), which its own type
    documents and which this reader relies on - folding cache reads back into input would
    double-count most of a long session.
  - **`deepseek-flash` and `deepseek-v4-pro` are priced** from DeepSeek's published rates (checked
    2026-09-12), because the downloaded LiteLLM catalog has no `deepseek-flash` key at all and every
    harness session would otherwise have read UNPRICED forever. Cache rates are absolute, not
    derived: DeepSeek's cache hit is 2% of its input rate against Anthropic's 10%, so the derived
    ratio would have overstated a cached token fivefold. The peak (list) rate is used and the
    off-peak halving is deliberately not applied per turn - read the figure as an upper bound. This
    also prices the OpenCode sessions that route to the same model, which were unpriced before.
  - **Presence counting looks at `sessions/`, not the whole home** (a new `detectSubdir` on a
    catalog row). A harness launched as a desktop app keeps a 216 MB Chromium profile under
    `~/.dsh`, and a detection walk over the root reported the browser's files as the harness's.

  Verified end to end against a real harness install: the chat lists with its title and workspace,
  the transcript renders (reasoning included), body search hits it, and it appears in Tokens-by-tool
  priced at published rates. One caveat, unfixed on purpose: "open the transcript file" hands an
  editor a `.zstd`, because that IS the session file - the in-app transcript and the exporter are
  the readable paths.

- **`POST /api/daemon/restart` - the daemon relaunching itself, gracefully, on demand**
  (`server/src/index.ts`). `relaunchDaemon()` has always existed and every auto-update exercises
  it - the successor is spawned first, waits for the port, takes over the SAME port, and the
  predecessor exits only once a replacement exists - but the only door to it was
  `/api/update/apply`, gated on `IS_COMPILED`. A SOURCE build (what this fleet runs) therefore had
  no graceful restart at all, so a change under `server/src/` sat inert until someone remembered
  `misc/Restart-Daemon.ps1`. That script is NOT replaced and is not the same act: it is the
  rebuild sledgehammer that kills the daemon AND the tray host from outside when you do not trust
  the running process. This is the in-process one, and it refuses while dispatch runs are in
  flight (`force: true` to override) for the same reason the auto-update loop already does.
  Verified live: 53468 → 70080 on port 7787, hidden, healthy.
### Changed

- **The unreachable headless-queue run path is deleted from `dispatchItem`** (`server/src/dispatch.ts`).
  Everything after the `headlessRunsAllowed()` guard - the spec write, the detached-runner launch,
  the log tail - could never execute, because that function is a hardcoded false and nothing overrides
  it (owner, 2026-08-31: headless is never used). Behaviour is unchanged: every dispatch still ends in
  the same refused `failed` row carrying the same `no-headless` event. The helpers and imports that
  only that path used went with it - `buildArgv`, `launchDetachedRunner` and its
  `AGENTHYDRA_RUNNER_LAUNCH` spawn methods.

  Two more files were only reachable through that deleted spawn and are now gone too:
  `server/src/dispatch-runner.ts` (the detached per-run supervisor, launched only by
  `launchDetachedRunner`) and `server/src/fake-claude.ts` (the `AGENTHYDRA_FAKE` stand-in
  `buildArgv` built its argv for). Their `server/src/main.ts` subcommands (`__dispatch_runner`,
  `__fake_claude`) went with them, and so did every doc mentioning `AGENTHYDRA_FAKE` or
  `AGENTHYDRA_RUNNER_LAUNCH` (`README.md`, `docs/REFERENCE.md`, `.env.example`) - trying AgentHydra
  no longer needs a fake-CLI flag, since headless dispatch never spends real quota either way now.
  `server/src/detached-spawn.mjs` stays: other callers (`core/instances.ts`, `core/codex-desktop.ts`,
  `index.ts`, and others) still use it for real detached spawns unrelated to dispatch. `specPathFor`,
  `tailRun`, `reattachRuns` and `finalize` stay too - a `queue_items` row already marked `running`
  from before this ban can still be reattached and finished from its on-disk log, so that machinery
  still has a live caller. `server/tests/dispatch.test.ts` is trimmed to match: its header and a
  handful of comments that described the deleted pipeline are rewritten, and the tests that remain
  are the refusal law plus the reattach/finalize machinery, both still reachable.

- **⛔ BREAKING: `move_chats` no longer accepts an `archived` boolean at all. It takes
  `archived_count: number`, and there is no shim** (`server/src/mcp.ts`,
  `orchestrator/scripts/migrate_batch.py`, `server/tests/move-chat-mcp.test.ts`). A caller still
  passing the boolean fails the schema loudly, which is the intent: a silent fallback is what this
  change exists to remove.

  A boolean could not tell a human's instruction from an agent's own initiative. Asked to migrate
  an account holding 3 unarchived and 22 archived chats, an agent set `archived: true` for itself
  and queued all 25; the owner stopped it twice. `archived_count` must EQUAL the archived chats the
  batch actually holds, and those chats must be the WHOLE batch, because archived chats riding
  along with unarchived ones is exactly how 22 rode in behind 3. Counting them first is the point.
  `all_unarchived` is unarchived by definition and drops the count rather than forwarding a
  contradiction.

  **`move_chat`, the singular, is UNCHANGED and still takes `archived: true`.** It goes through
  `migrate_chat.py`, which has refused archived chats per chat with exit 7 since 2026-09-05, and it
  remains the way to move one archived chat that a human named.

  ⚠ **A daemon whose two halves are different ages refuses every archived batch**, and that is the
  stopgap working rather than a fault: python is read from disk, so the gate that demands the count
  goes live immediately, while a `move_chats` older than 2026-09-13 still emits a bare `--archived`
  and the gate answers `REFUSED: --archived needs --archived-count to MATCH ... the count given was
  not stated`. A source daemon restarted after this commit has both halves and is fine. On a
  compiled install still on 0.41.0, the route for a named archived chat is `move_chat`, one at a
  time, until it is rebuilt.

- **"Open the transcript file" is no longer offered for a session whose file is not prose**
  (`web/src/lib/session-labels.ts`, `web/src/components/SessionsView.vue`, `server/src/routes/
  sessions.ts`). A DeepSeek Harness log is a real file worth copying and locating, and it is
  Zstandard frames - so handing it to an editor produced a screen of binary that reads as a
  corrupted session. The action is hidden for those sources and the route says why in its 409,
  pointing at the readable exports that sit beside it. A second compiler-checked capability map
  (`SOURCE_FILE_IS_TEXT`), because "has a file" and "that file is text" have different answers:
  OpenCode and Hermes have no file at all, DSH has one that simply is not prose.

- **The dispatched and rate-limited filters disable themselves off CLAUDE-ONLY, not off a list**
  (`web/src/components/SessionsView.vue`). Both facts exist only for Claude sessions, and the
  hand-written "codex or opencode" list had gone stale twice as sources were added - Hermes in
  September, DeepSeek this week - leaving two filters enabled that could only ever return nothing.

- **A long name no longer stretches the Name column - it is cut to 18 characters and the whole of
  it is one hover away** (`web/src/lib/instance-appearance.ts`, `web/src/components/
  InstancesView.vue`, `CliInstancesSection.vue`, `CodexInstancesSection.vue`,
  `web/src/shell/IconTooltip.vue`, plus tests). The Name column started naming a row after the
  ACCOUNT behind it earlier the same day, and an Anthropic profile name is a person's real name:
  "LUIS FERNANDO LOPEZ ESPINOZA" on a column that is 176px wide. Table layout is auto, so `w-44` is
  only a hint a long cell overruns - one such row widened Name and pushed the desktop, CLI and
  Codex tables out of the alignment their fixed widths exist to guarantee. `shortDisplayName()`
  does the cut for all three tables, counting CODE POINTS so it can never split a surrogate pair
  and leave a replacement glyph on the row, and charging the ellipsis to the budget so the result
  is never wider than asked for. ⛔ It is a DISPLAY cut only: sorting, filtering, the move submenu
  and every dialog keep the full `displayName()`, because a truncated name is not an identifier.
  The desktop table reveals the full name in the rich tooltip it already had (the name takes the
  first line and pushes the folder and the focus hint down one each - hence `detail`, a third line
  on IconTooltip); the CLI and Codex tables, which have no such tooltip, use a native `title` that
  is undefined when nothing was cut, so a whole name never sprouts a hover repeating itself.
### Fixed

- **A COMPILED BUILD RAN THE PREVIOUS BUILD'S SCRIPTS: the version is a label, not a content hash**
  (`server/src/misc-assets.ts`, `server/tests/misc-assets.test.ts`). A single-file build writes the
  `misc\` actuators it needs out of itself into `<data>\misc\<version>\`, and reused whatever was
  already there. Every rebuild of the SAME version therefore kept running the copy the first build
  had written: found 2026-09-15 while proving this release, when an actuator fix sat in the binary,
  in the repo and in the changelog, and the compiled daemon went on refusing the very thing it
  allowed - silently, and with a plausible-looking refusal from the stale script that sent the
  reader hunting somewhere else entirely. The materialized copy is now compared BYTE FOR BYTE with
  the embedded one and replaced when they differ (`reason: 'refreshed'`); an unreadable comparison
  keeps the old copy rather than churning it.

- **Duplicate rendered chat rows no longer block archive or rename.** The actuator checks the store itself and only refuses when two unarchived chats share the exact title.

- **Release smoke test no longer fails on cleanup delays.** Scratch directory removal now retries briefly on Windows EBUSY errors.

- **Chat title mismatches no longer block moves.** The move route now accepts either the session title or the desktop meta title, matching whichever the chat is currently known by. Batch moves can now specify titles per chat.

- **Idempotency keys no longer keep failed operations stuck.** A failed or cancelled operation frees the key, so retry with the same key can start fresh. Running or succeeded operations stay protected against retries.

- **Daemon crashes now write a single-line record** with reason, exit code, uptime and stack. Handlers for `uncaughtException`, `unhandledRejection`, `SIGBREAK`, `SIGHUP` and normal exits all log before exit.

- **Fan-out now reports true status per member** (finished, planned, unassigned, refused, etc.) instead of false "ok" when some members are stuck. It auto-detaches past 120s and keeps spawning even if the client times out; status reads no longer block behind the lock. Revoked tokens drop their cached usage immediately. Accounts with hands-on keyboard activity inside 10 minutes are skipped from spawns.

- **Landed chats are now named before anything tries to use their title.** The naming pass checks what the app is rendering, not just what the disk says, and re-runs per instance if needed.

- **Bypass remedy now works on the exact chat it names.** `automation_chat` accepts `--title` to use the batch's verified title instead of re-reading a possibly-stale disk copy. Chat rename uses fuzzy matching to discover rendered rows when disk and app disagree.

- **Landed chats no longer block resume indefinitely.** A freshly landed chat updates its `lastActivityAt`, so the 180s quiet-window gate was treating it as in-flight. Resume now uses a shorter window for recently imported chats. App-injected meta records (boot hooks, cross-session messages) are skipped when judging idle status. Usage walls are also checked via the daemon's `limit_stop` state. Duplicate resumes are deduped if already staged.

- **Test isolation now stubs all daemon paths correctly** so suite tests don't accidentally read the real chat store or leave locks behind. Test cleanup clears route locks and operation records properly.

- **Mid-turn deliveries defer instead of failing,** staying staged for retry. Courier now reports the actual state of each delivery (failed, deferred, expired, delivered, etc.) and never falsely claims "nothing staged".

- **Refused moves stage their resume messages** so they're not lost. The refusal comes back as a structured object naming the operation ID and remedy, not a bare string.

- **Chat enumeration now asks the account itself**, not the session list. Half-moved chats exist on two accounts; the per-store scan sees them both. Archive gate includes all archived chats in its census.

- **Accounts read as "rate limited" when one of multiple OAuth grants was revoked.** Grants are now ordered (app session first, then by expiry) and tried in order. Readers fall through to the next grant when one is refused, and backoff is keyed by label AND token digest. The reported failure is from the preferred grant, not whichever was tried last.

- **Usage checks no longer fall back to spawning CLI with an instance token,** preventing cross-contamination of account numbers. Config-dir tokens still can spawn, as that CLI owns its login.

- **Compiled daemons can now archive, unarchive and rename chats.** Missing PowerShell scripts were returning success (exit 0) even when they never ran. Scripts now embed in the binary and are resolved through `resolveMiscAsset`, returning non-zero on missing paths.

- **Long moves now timeout per phase with timeouts named on incomplete work.** Post-landing phases (settle, stamp, resume) have per-chat-scaled ceilings on worker threads. Moves auto-detach when they exceed the blocking timeout, keeping work alive even if the client gives up. Archived-chat gate now takes a count that must match the actual archived chats.

- **CI failures on GitHub legs fixed.** Tray tests now declare their environment state. DeepSeek paths work cross-platform. Search index uses 30-second cooldown instead of permanent latch after transient failures.

- **Stale `runtime.json` no longer triggers daemon duplication.** Clients now check the default port if the pointer is dead, announce stale pointers explicitly, and refuse to start a second daemon. Daemon rewrites the pointer once per minute if stale. Side-runs announce themselves and write to their own state dir, not the machine-wide pointer.

- **All hook test suites now live under `tests/githooks/`** instead of `.githooks/tests/`. Test discovery is anchored by `tests/repo-root.ts` not hop count.


- **Compiled installs can now deliver messages.** The build embeds all required `misc\` files or fails. `resolveMiscAsset` extracts them on first run beside the app state, so the single-file exe stays portable.

- **Rate-limited accounts now respect their Retry-After windows.** The server's 429 Retry-After is recorded per label and honored at a single chokepoint, so all pollers back off together. The UI shows countdown and reuses cached readings rather than showing false 0%.

- **Orphaned operation IDs now say whether the daemon restarted.** Polling an operation after daemon restart now returns `daemon-restarted` instead of "no such operation", letting callers check the ledger instead of re-firing.

- **The compiled executable ships the tray icon and can manage itself.** The host, icon and config extract on first run. Process detection returns tri-state (running/absent/unknown) instead of guessing.

- **Chat identity now answers for the caller, not the daemon.** `whoami` uses the loopback socket to get the caller's PID and walks its ancestry, per-request and uncached. `move_chat to: "here"` now works correctly.

- **Chats cut off mid-turn no longer read as busy forever.** If the last record predates the engine, that engine has produced nothing since boot, so it can be moved without `--terminate-live`.

- **Person-requested actions no longer skip if younger than the unattended window.** Interview now counts and reports failures when reaching a pane.

- **Long `orchestrator_run` calls no longer lose their report.** Runs over 120s now auto-detach with an operation ID to poll.

- **Non-ASCII chat titles now survive PowerShell pipes.** Scripts now force UTF-8 on their console output to prevent encoding mangling. Regression tests cover Spanish, em dash, CJK and Cyrillic.

- **Landed chats are named before permission pickers or matching attempts.** Permission picker gets the rendered name from the daemon if the disk record has none. Sidebar matching uses fuzzy prefix comparison, normalizing accents and whitespace. Bypass remedy prints the correct path from the orchestrator directory.

- **The courier now marks mid-turn chats `peer_only` and delivers them through the peer channel** instead of refusing them upfront. The mid-turn rail is enforced downstream where the channel is picked, so live chats get delivered via queue rather than rejected.

- **Staged replies now expire after 48 hours** if not delivered. Replies to chats that moved accounts are expired since their premise is void. Transient refusals defer up to 12 times before expiring.

- **Move reports now show which chats are dormant.** The headline shows the tally; dormant chats didn't receive resume messages yet.

- **`rename_chat` can now rename freshly imported chats** by falling back to "Untitled" when the disk has no name. Write failures are caught and retried once; the script never guesses names.

## [0.41.0] - 2026-09-08

- **Self-updater now checks fast-forward viability before offering updates** instead of failing repeatedly on diverged or missing remote branches.

- **"Move chats to account" now moves all chats** and reports which were skipped with reasons. It reads the account store (not session list), verifies landing before archiving source, accepts either current title name, and reads both target and source stores to avoid losing chats to residency checks.

- **Dead host sessions no longer cause `to: "here"` to land chats on the wrong account.** Frozen daemon sessions now check for archived state and refuse "here" in favor of explicit instances.

- **Archive is now instance-scoped** and refuses to hide chats in use with live engines. Uses `instance_ref` and `desktopChatCarriers` primitive.

- **`manage_desktop_chat.ps1` now archives on non-English apps.** Menu items are matched by CSS class (non-localizing), not by localized text.

### Added

- **Move confirmations now show name, tier, email and instance number**, built before the run is posted, so `dry_run` and real move read identically.

- **AgentHydra auto-registers as an MCP server on every daemon start.** The HTTP endpoint writes one entry into Claude Code's config, preserving all other servers and keys. The entry carries the bound port so it never goes stale on a hop.

- **Account rows show a "Chats" menu** listing every chat with last-active time and engine status. Reads `/api/chats` not the session list, so quiet chats show up.

### Changed

- **Moved chats are tombstoned on disk**, renaming the source record with `movedTo`, so stale twins aren't re-discovered on later scans.

- **"Move chats to account" menu lists only running accounts by default**, with a "Show not running" toggle. Closed accounts show they land in their store ready for next start.

- **Menu label is now "Move chats to account"** (not "Move all chats..."), matching the new "Chats" item below it.

### Fixed

- **`chatStoreLabel` now handles both path separators** so it works cross-platform on Linux CI legs.

- **MCP registration race test now detects byte changes** by padding output instead of relying on filesystem clock ticks.

- **Missing components can now be repaired** without upgrading the version. A "Repair install" button reinstalls the current release to fill gaps in `orchestrator/` or `misc/`.

- **MCP docs now lead with auto-registration** and mention that moving chats needs the toolbox.

- **Default Claude Desktop install now answers `/api/chats?instance=`** by mapping the literal `default` label correctly.

## [0.40.0] - 2026-09-07

### Added

- **The Instances toolbar's "Usage filter" is now just "Filter", and it asks three questions
  instead of one** (`web/src/lib/instance-filter.ts`, `web/src/composables/useInstanceFilter.ts`,
  `web/src/components/InstanceFilterMenu.vue`). Alongside the two quota windows it now filters by
  STATUS (open / closed) and by PLAN (Max 20×, Pro, Free, … - the list is built from the accounts
  actually on screen, so it names your plans rather than a guessed catalogue). The three facets are
  OR-ed: picking two narrows the tables rather than cancelling out. Both new facets are true
  whichever columns are showing, so the button no longer appears only in usage mode - only the
  QUOTA half stands down with the percentages it measures, and the flyout says so in place rather
  than silently ceasing to apply. Existing settings are untouched: the storage keys keep their
  `usageFilter` spelling (a preference key is a wire format, not a label), status defaults to
  "any" and no plan is picked, so an upgraded install filters exactly as it did.
- **A row whose fact is not KNOWN is never filtered out.** An unlinked CLI login has no window to
  be open or closed and no account record of its own, and a desktop instance's plan arrives a beat
  after its row does. Both were already the rule for an unread quota reading; extending it is what
  stops rows blinking out of the table and back on every refresh, and what stops "show me the open
  ones" emptying the CLI table. The Codex table joins the filter on the same terms.

### Changed

- **The two 5-hour quota cells are grey now; colour is spent on the weekly ones**
  (`web/src/components/UsageBar.vue`, `UsageBadge.vue`). A usage-mode row carried four coloured
  cells, and four hues side by side average out to "busy" - the eye had to read each one to find
  the alarming one. The 5-hour window is the one that gives its colour up, because it refills the
  same afternoon: a spent session means "not right now", a spent week means "not at all", and only
  the second is worth an alarm. Both 5-hour cells keep their number, their length and their
  popover; the Session bar simply reads in the same neutral grey the Plan chip does.

### Removed

- **`fleet-git.ts`, and with it every git call AgentHydra made on its own initiative**
  (`server/src/fleet-git.ts` and `server/tests/fleet-git.test.ts` deleted, the `git` key dropped
  from `GET /api/fleet`). That section ran `rev-parse --show-toplevel` per live session cwd, then
  `rev-parse --abbrev-ref` + `status --porcelain` + `rev-list --count` per repo - concurrently,
  uncapped, uncached, on EVERY request. Against a 22.7k-file checkout that is a full status walk
  each time, and anything calling the endpoint in a loop buries the machine; the owner watched
  exactly that happen. Nothing consumed the result: no web code, no orchestrator code and no
  Python read `git`, `offMain`, `dirtyCount`, `notRepo` or `aheadCount`, and the module's own
  header said what to DO about a dirty or off-main repo was "a later piece's business" - a piece
  never built. A producer with no consumer paying the most expensive read in the process.
  Cross-repo git state is Odin's job, and Odin only does it when a person runs a scan. Standing
  rule (owner, 2026-09-07): **nothing runs git unless it was explicitly asked for, for a specific
  reason.** `path-key.ts` stays - `desktop-landing` and `codex-desktop` still use it - with its
  header de-referenced. The five remaining git callers are all explicitly triggered and untouched:
  the source-mode version stamp, the updater's own `git pull`, the ChatGPT context pack's
  `ls-files`, and the tunnel's `check-ignore`.

### Fixed

- **Every reply the courier tried to deliver failed with "delivery actuator missing"**
  (`server/src/routes/session-message.ts`). The message endpoint resolved its PowerShell actuator
  from `process.cwd()`, which is wherever the daemon happened to be started, not where the file
  is: a daemon launched in `server/` looked for `server/misc/Deliver-DesktopChat.ps1` and refused
  every delivery. It resolves from `APP_ROOT` now, like the rest of the codebase's `misc/` lookups,
  which is also what makes it land beside the executable in a compiled bundle. Found when a batch
  move's `resume` notes staged and then could not be delivered.
- **The tray-invariant poll could take the whole daemon down, and the guardrail that exists to
  catch exactly that could not see it** (`server/src/tray-invariant.ts`). Its tick was an arrow
  assigned to a const, so `timer-callback-can-kill-the-daemon` - which only reads `function NAME()`
  declarations - fell through to "unguarded" and gated CI red on `main`. The tick is a declaration
  whose body opens with `try` now, so the protection is one the check can actually verify rather
  than one it has to take on trust; the overlap guard keeps its old meaning, with `running` still
  cleared only by the tick that set it.
- **The permission picker never opened on a window that was minimized or not in front, so a chat
  that moved accounts had to have "Bypass permissions" clicked by hand**
  (`orchestrator/scripts/actuator/approve_prompt.ps1`). `Press-Space` posts `WM_KEYDOWN`/`WM_KEYUP`
  straight at the render widget; such a window drops the key with no error, and the function
  returned true anyway because all it checked was that `PostMessage` had been called. Measured on
  one live window with the picker forced closed and verified closed before each attempt:
  **minimized 0/2, background 1/2, foreground 2/2**. Background is a coin flip because UIA
  `SetFocus()` only sometimes activates the window as a side effect - which is why this read as
  intermittent rather than broken, and why an earlier fix went after a confirmation dialog that
  was never the problem (the dialog is raised BY the menu, and the menu was not opening). The
  window is now restored and activated once, before the first read of the accessibility tree
  rather than at the keypress - doing it at the keypress still failed one rail earlier, on
  `selected the row but the pane still does not show '<title>'` - and the previous foreground
  window is handed back on every exit path. Only a by-hand act reaches this: the picker stays
  gated behind `--force` and the fleet pass behind the tray icon, so no background lane pulls a
  window onto your screen.
- **A chat sitting in "Auto" or "Manual" could never be moved to bypass at all.** The composer
  button is matched against a name list that had gone stale: the app renders Auto / Manual /
  Accept edits / Plan / Bypass permissions, while the list carried three names that exist nowhere
  in the app and still called Plan "Plan mode". A non-matching chat reported "no permission picker
  is showing".
- **"opened the picker but no item appeared" was printed for a picker that had never opened**,
  which sent two separate investigations after an imaginary locale/label problem. The two failures
  are now told apart and named, and the never-opened branch says so explicitly.
- **`manage_desktop_chat.ps1` had the same defect, with two confidently wrong diagnoses.** Against
  a minimized window the kebab hunt reported `not rendered in any searched running instance
  (collapsed group or virtualized out)` and the archive path reported an EMPTY `menu opened but no
  'Archive' item matched a known label. Menu showed: .` - neither naming the real cause. It now
  restores and activates before searching (`-List` stays passive and never pulls a window
  forward), and the header no longer promises "zero focus theft", because that promise was costing
  correctness. `chip.ps1` carried a byte-for-byte copy of the broken `Press-Space` and is fixed the
  same way.
- **`automation_chat.py` reported `APP-CONFIRMED via its own picker` for runs whose picker had
  just REFUSED**, quoting the refusal inside the confirmation. It computed the verdict from
  `state/mode-confirmed.json` - a persistent ledger answering "has this chat ever been confirmed" -
  *after* driving the picker, so any chat confirmed once claimed confirmation forever. A verdict
  about this run now comes from this run, via an allow-list of the actuator's success lines so that
  a new failure string reads as not-confirmed rather than silently as success; the ledger is
  consulted only when no picker ran. Verified live from a fully minimized window: 5/5 mode flips
  both directions, the archive and rename paths, and the full `--force` chain.

- **The "Bypass all permissions?" popup is finally clicked - it was an in-page modal all along**
  (`orchestrator/scripts/actuator/approve_prompt.ps1`). Every previous fix here assumed the
  confirmation owned its own top-level HWND. Measured live 2026-09-07: it does not. It renders as a
  `ControlType.Window` element INSIDE the main window's tree (name `Bypass all permissions?`, a
  `Cancel` and a confirm named for the mode), and while it is up the composer toolbar leaves the
  tree entirely - which is what every failing run reported as "the picker now reads 'gone'". The
  hunt did see the confirm and threw it away: a modal is CENTRED, so its confirm sat at x=1312
  while the `Model: ...` anchor put the pane guard at 1586, and `-ge $minXm` rejected the one button
  it came for - the same defect this file's own header records for `Find-ModeBtn`, repeated one
  function down. In-page modals are now handed to the confirm hunt as non-main roots (no positional
  guard, since inside a modal there is nothing to confuse the confirm with) and scanned first; the
  deny list and the must-be-new rail are unchanged. Proven on two chats in two workspaces:
  `MODE SET 'Accept edits' -> 'Bypass permissions' ... (confirmed the app's 'Bypass permissions' prompt)`.
- **A move can no longer claim `app-confirmed` on a confirmation the OTHER account earned**
  (`orchestrator/scripts/migrate_chat.py`). `mode-confirmed.json` is keyed by session id alone, so
  a chat confirmed long ago in the app it just LEFT still answered yes for the app it just joined.
  Measured on the six-chat Andreea drain of 2026-09-07: all six reported `app-confirmed` while
  their own evidence string began `REFUSED`, and the four nobody checked were sitting on
  `acceptEdits`. The adjudicator now voids any prior confirmation before driving the picker, so the
  only entry that can exist is the one this run's actuator earned.
- **A chat that landed a second ago is no longer "not here"** (same actuator). The sidebar row is
  rendered on the app's own clock, and one instant look turned that delay into `no sidebar row`,
  losing the whole permission stamp - five of six chats in the same drain. It polls for 6s now; an
  absent row still refuses, and a row already on screen costs the same single scan as before.
- **A crashed orchestrator run no longer blocks every retry forever** (`server/src/orchestrator.ts`,
  `server/tests/orchestrator-stale-lock.test.ts`). The daemon-side `inFlight` map held only a start
  time, and the `finally` that clears it runs on every normal path - so the one way an entry could
  survive was a spawn promise that never settles, and then the lock was **immortal**, because
  nothing else ever removed it. Measured 2026-09-07: a `migrate_batch` died with no python process
  left anywhere on the machine, and the retry still returned `409 already running (started 85s
  ago)`. That is the worst shape a lock can take - it turns a CRASH into a HANG, reports a dead run
  as healthy, and the caller believes it. An entry now carries a `deadline` of its own
  `timeoutMs` plus a 60s grace, which is a fact rather than a heuristic: `realSpawn` enforces that
  timeout by killing the child, so a lock outliving it cannot have a live run behind it. Past the
  deadline the entry is reaped and its kill switch fired defensively first; `orchestratorBusy()`
  reaps too, so an immortal lock cannot wedge an update either. **Releasing is now an identity
  check, not a name check** - once a lock can be replaced, an abandoned promise settling late would
  otherwise delete the SUCCESSOR's entry and hand out the concurrent acting pass this map exists to
  prevent. Four tests, verified to fail (3 of 4, including the successor case) against the old
  never-reap behaviour before being accepted.

- **The permission-mode confirmation is hunted in every window the app owns, not just its main
  one** (`orchestrator/scripts/actuator/approve_prompt.ps1`). ⚠ **This did NOT fix the by-hand
  clicking, and the commit that landed it claimed a root cause that was wrong.** The real cause,
  measured separately the same day, is the background-window swallow now documented in that
  script's header: `Press-Space` posts its key at the render widget, a BACKGROUND window never
  opens the picker menu at all, and `Press-Space` returned `$true` regardless because it only
  ever checked that `PostMessage` was called - so the confirm hunt found nothing to click because
  **there was never a dialog** (background = 0 picker items, foreground = 5, on one live window).
  What is retained here is a narrower, still-true improvement: the hunt and its diagnostic no
  longer assume a dialog must be a descendant of `MainWindowHandle`. The old diagnostic scanned
  only the main window, so its "buttons on screen" list printed the frame's own Minimize/Maximize
  and read as "no dialog appeared" - which is equally consistent with "looking in the wrong place"
  and with "nothing was ever raised", and that ambiguity is what sent the investigation at the
  search root instead of at focus. `Get-ProcRoots` now returns the main window plus every visible
  top-level window of the same process, used in all three places - the pre-invoke RuntimeId
  snapshot, the confirm poll, and the diagnostic (buttons outside the main window are tagged
  `[dialog]`). Nothing widens about WHAT may be pressed: `DENY_NAMES` is still never pressed and
  the must-be-new rail is intact, strictly so because the snapshot now covers the same roots the
  hunt does. The pane/position guards that separate the dialog's confirm from the composer's
  picker and the sidebar chips apply only in the main window, since those live there and requiring
  a separate dialog's button to sit right of the pane would reject the very button wanted.
  `Get-ProcRoots` is deliberately defined above its first caller: PowerShell binds functions as
  the script runs, and a definition further down left the snapshot call in its `catch{}` with an
  EMPTY set, silently disarming must-be-new. Not yet exercised against a live dialog - and with
  the foreground fix in place the dialog now appears where the old code was already looking, so
  this widening is defence against a shape that has not yet been observed, not a proven path.

- **The window actuators aim by identity, never by substring or position** (every
  `orchestrator/scripts/actuator/*.ps1`, plus `spawn_chat.py` and `migrate_chat.py`), after the
  owner watched one click the project selector in the wrong account's window. A bare `-Instance`
  now matches the profile dir's leaf name EXACTLY (`pap3r rotate` no longer also matches
  `pap3r rotate2`), a blank `-Instance` is refused for anything that clicks or types (it used to
  scan every running account), zero or several matching windows is a refusal that names every
  candidate, a sidebar row must equal the title exactly rather than end with it, a key is never
  posted until the focused element is proven to be the target, and a dialog's confirm button must
  be NEW since the action that opened it rather than any enabled button named OK/Continue/Yes
  anywhere on screen. `trust_dialog.ps1` finally takes an `-Instance`. Python callers hand the
  actuators the unique profile DIR rather than the fleet name. Proven live: the rename drill on
  the hardened scripts round-trips a real chat by bare instance name in 9.4s.
- **A batch move no longer reports a chat that landed and then crashed in a later phase as "NOT
  moved"** (`orchestrator/scripts/migrate_batch.py`). Phases two and three only run on a verified
  landing, so a settle or stamp that raises keeps `landed: true`, marks the chat `ok: false` with
  what did not finish, keeps its OTHER tidy-up running, and the report gets a distinct
  "LANDED but not finished" bucket instead of the re-run advice. Per-chat `secs` also stops
  charging the first chat with every later chat's stamping.
- **The naming door restates the daemon's own title** (`migrate_chat.py`). A chat renamed in the
  app whose index row still carried its first message was refused twice with "confirm_title does
  not match" - the second time through the breaker. The door compares against the ROW, so the row
  is what is restated now, via the per-id route.
- **A compiled `dist/AgentHydra.exe` run from the repo finds the orchestrator one level up**
  (`server/src/orchestrator.ts`). Launched as the daemon it looked for `dist/orchestrator`, and
  every orchestrator-backed tool (`move_chats`, `orchestrator_menu`) died with "no orch.py" while
  the tree sat beside it. A release zip with no toolbox still reports honestly.
- **The migrate stopwatch now splits the two slow phases** into `settle-drive` / `settle-confirm`
  and `stamp-doctrine` / `stamp-picker`, so a slow move says which half is slow. First measurement:
  7.8s driving the source app's archive control, 8.0s for the single-move bypass watch, 5.2s
  driving the target app's picker.
- **The per-window UI lock is reclaimed on proof of death, not on age** (`orchestrator/scripts/
  lib/windowlib.py`). `instance_lock` deleted any lock directory older than 15 minutes without
  checking who held it, so a lane that legitimately ran long had its lock taken mid-gesture and
  two lanes then drove one Electron window: the interleaved sidebar click the lock exists to
  prevent. The actuator alone runs up to 240s per press and `spawn_chat` stacks several behind a
  120s wait, so the ceiling was reachable in normal work. The lock now carries an owner record
  (pid plus that pid's OS creation time, so a recycled pid cannot impersonate the holder) and
  reuses `joblocklib`'s proof-of-death check: a provably live holder keeps its lock at any age, a
  provably dead one is reclaimed at once instead of waiting the clock out, and age remains only
  where liveness cannot be determined so a crash still cannot wedge a lane. Release is
  token-checked, closing the second half of the same defect, where the original holder removed
  the directory unconditionally on exit and deleted its successor's lock.
- **The naming pass now takes that same lock instead of a private one it alone respected**
  (`orchestrator/scripts/name_chats.py`). It kept its own `state/naming-<instance>.lock`, which
  excluded a second naming pass and nothing else, so it could drive a window while the courier,
  `archive_chat`, `migrate_chat` or `spawn_chat` was already driving it. The private copy carried
  both age-reclaim defects above. Its non-blocking posture is unchanged (`wait_secs=0`): a pass
  that finds the window busy steps back and says so.

## [0.39.1] - 2026-09-06

### Added

- **Log out of an instance from its row.** The three-dot menu signs the account out of that one
  instance and leaves its chats, settings and folder alone, so it asks for a sign-in on its next
  start. It names the account and asks first, and it refuses while the instance is running,
  because the app would overwrite the change or corrupt the profile.


## [0.39.0] - 2026-09-06

**TL;DR**

- **Analytics keeps every chat's totals for good, even after Claude Code deletes old transcripts**
- **Analytics can show tokens instead of money, adds a calendar view and slices time periods fairly**
- **Each chat and instance row shows which account it is really signed into**
- **The orchestrator is back inside AgentHydra, with undo for its chat actions and safer prompt approval**
- **Hermes Agent chats can be listed, searched and exported**
- **Repeated failures are grouped into incidents, and runs are only "completed" once their reply is seen**
- **Redeem a banked Codex reset credit, and optionally keep an idle account's 5-hour window running**
- **A long list of reliability fixes: safer updates, deletes, moves, locks and outage messages**

**Everything in 0.39.0**

### Added

- **A permanent record for every chat.** Claude Code deletes old transcripts after about a month,
  and Analytics lost their tokens, cost and time with them. Each chat's totals are now kept for
  good, so "all time" means all time and a total no longer shrinks when a file is cleaned up.
- **Money or tokens across Analytics.** One switch changes every panel between dollars and tokens,
  with token splits per day, project and account. A panel with no token figures says so.
- **A calendar view of when the work happens.** One square per day, months across the top, with
  the hour-of-week grid one click away.
- **Keep the 5-hour window running.** An opt-in setting, off by default, that starts an idle
  account's 5-hour quota window so it is already counting down when you need it. It skips accounts
  whose window is running, accounts near their weekly limit, and any account it cannot read.
- **See which account a chat uses.** The open transcript shows the account under its title, and its
  menu can open that account or copy its address. Clicking an account in the Instances, Codex and
  quick-instances lists copies the full address.
- **Hermes Agent chats.** AgentHydra now lists, follows, searches and exports Hermes Agent sessions,
  including named profiles, and prices them from its own catalog. It only reads them.
- **Incidents for failed runs.** Runs that fail the same way are grouped into one incident with a
  count, so twenty overnight failures read as one problem. You are notified on the first failure
  and when a resolved incident comes back, and an Incidents panel above the queue can acknowledge
  or resolve them.
- **Runs are checked before they count as completed.** A run that exits cleanly but left no reply
  in its transcript now shows as "unverified" instead of "completed", and a run whose outcome is
  unknown is never retried without saying so.
- **The orchestrator is part of AgentHydra again.** The Python toolbox ships as a folder beside the
  app in the Windows zip, the daemon runs its scripts, and the MCP server can list, run, loop and
  switch them. The `/orchestrate` command is back.
- **Undo for the orchestrator's chat actions.** Archiving, renaming, moving, holding and compacting
  a chat now record what it looked like before and after. You can list those actions and undo one
  through the same guarded script, except compaction, which cannot be reversed.
- **Safer approval of stuck permission prompts.** The orchestrator approves clearly safe commands,
  refuses destructive ones, and puts everything else in a queue for a person to decide. Unattended
  runs only press the safe ones.
- **The orchestrator's own incident list.** Repeated orchestrator failures with one cause become a
  single incident, and three in a row stop that lane for the pass instead of repeating the failure
  chat by chat.
- **The orchestrator can deliver staged replies.** A decided reply is typed into the right chat
  through the app's own composer, only after the chat is confirmed and idle, and the delivery is
  checked afterwards.
- **Redeem a banked Codex reset credit.** A Codex row's menu can spend a saved reset credit to
  restore the full 5-hour and weekly windows. It refuses until the window is used up unless you
  force it, and says why when it is disabled.
- **A daemon that hangs while starting restarts itself.** If start-up stalls, it logs the step it
  was stuck on and exits so the tray restarts it, instead of sitting idle with nothing logged.

### Changed

- **Instance rows are named after their login.** Rows show the account's email handle instead of
  the profile's display name, and a name that no longer matches its account is flagged with a
  one-click rename. The Focus button shows the running dot on both the Claude and Codex tables.
- **Analytics time periods mean what they say.** Every panel takes the same day-by-day share of
  each chat, so a chat that only partly overlaps the period counts only for that part.
- **The settings dot explains itself.** With an update waiting, the gear scrolls to the Updates card
  and highlights it, then the dot stays quiet until the next launch.
- **The release notes say what the single Windows download lacks.** The standalone executable has
  no tray icon and no orchestrator, and the downloads table now says so instead of calling the two
  files otherwise identical.

### Fixed

- **A compacted desktop chat no longer shows up two or three times.** The desktop app gives a chat
  a new id when it compacts; the sessions list now folds those ids back into one chat, so its
  instance, archive and queue links keep working.
- **"default" and "other" are refused as instance names**, since both already mean something else
  in AgentHydra. The regular Claude Desktop install is now recognised everywhere, and on Linux and
  macOS a folder with different capitals no longer looks like it.
- **Updates are checked before they run.** A download must match the release's published checksum
  before anything is extracted, and a release without one is refused. An update now replaces the
  orchestrator and tray files together with the app and rolls all of them back on failure, without
  losing the orchestrator's saved state.
- **A failed self-update from source keeps your edits.** Changes made while it ran are stashed
  before the checkout is reset, and the message says how to get them back.
- **A damaged instance list is never silently replaced.** A corrupt or unreadable list is left as
  it was and changes are refused, instead of one new instance wiping every saved login.
- **Deletes no longer claim more than they did.** If AgentHydra cannot tell whether an instance is
  running, it refuses to delete it, and a delete whose folder could not be removed keeps its row
  and shows the real error.
- **Moving a chat creates it once**, even when two requests import it together. Delete and undo of
  one chat can no longer interleave and lose the undo, and twin cleanup re-checks that a chat is
  not live right before it acts.
- **Shared orchestrator files no longer lose each other's changes**, and its locks no longer crash
  on Windows when several lanes wait on the same one.
- **An outage no longer looks like an empty account.** When the server cannot be reached, sessions,
  the scheduler and the queue show "unavailable" with a Retry, or keep the last good data marked
  stale, and the incidents panel no longer reads a failure as "no incidents". Failed queue actions
  and sends show the server's real reason and keep your prompt.
- **The remote app recovers and explains itself.** It retries a failed start, tells a sign-in
  refusal from an unreachable gateway, reports a failed sign-out, and shows a tunnel that died
  with its reason.
- **Old responses no longer overwrite new ones.** A slow reply can no longer bring back a deleted
  queue row or show the previous filter's transcript.
- **The queue cannot be given a false history.** Only the runner can set a run's status and
  results, and a running row cannot be deleted. The web no longer offers queue controls the server
  always refuses, and the scheduler panel says plainly when unattended runs are unavailable.
- **Very large transcript exports are refused up front**, pointing to the raw download instead.
- **Only AgentHydra's own pages can drive it**, not any page on another local port.
- **Cancelling a run on Linux or macOS stops everything it started**, not just the first process.
  Linux also no longer needs the ps tool to find running apps.
- **Kilo, MiMo Code and IcodeMate chats open, search and count correctly** from their own stores,
  and stores or Hermes profiles sharing a session id no longer mix up their chats. Hermes Agent,
  OpenClaw and aider chats are looked for where those tools really keep them.
- **Token budgets include delegated work.** Subagent and workflow transcripts now count toward an
  account's quota window.
- **Orchestrator fixes.** Long runs can be retried, polled and cancelled without doing the work
  twice, and other MCP calls are no longer stuck behind them. It finds the daemon on the port it
  really uses, a chat that ended on `/compact` or stopped at a usage limit is no longer treated as
  busy, and each script's help shows that script's own manual.

## [0.38.3] - 2026-09-03

### Added

- **A moved chat keeps its settings.** Model, effort, ultracode, the Chrome permission mode and the
  chat's own permission grants now travel with it. On a running account they are put back whenever
  the app overwrites them, until its next start makes them stick.
- **Move chats to a closed account without starting it.** The chat is written into that account's
  store and is there, settings intact, when the app next starts. The menus label a closed target
  as "Not running - lands in its store, ready when it starts".

## [0.38.2] - 2026-09-03

**TL;DR**

- **The move dialogs group chats by project**
- **Click a chat in a move dialog to open it**
- **Moving chats from the web UI works again**
- **A failed move says why**

**Everything in 0.38.2**

### Added

- **The move dialogs group chats by project.** "Move all chats to another account" and "Migrate N
  chats" list the chats under a header per project, largest first, with a count.
- **Click a chat in either list to open it.** Sessions opens with that chat alone in the list and
  selected, widening the time window if it needs to.

### Fixed

- **Moving a chat from the web UI works again.** Every move started from the UI had been refused
  because it did not confirm the chat's title. A chat with a generic title is still refused on
  purpose, and the message says so: give it a real name first.
- **A failed move says why.** The bulk messages now carry the server's first reason, and show as an
  error when nothing moved at all.

## [0.38.1] - 2026-09-03

### Fixed

- **Move destinations use the names the Instances table shows**, not the folder names.
- **The daemon says why it did not start the tray**, such as the tray already running or being
  hidden in settings.

## [0.38.0] - 2026-09-03

**TL;DR**

- **Move many chats at once, from Sessions or from an account's row**
- **Move a chat from the right-click menu, including to an account that is not running**
- **Starting AgentHydra from the zip now shows the tray icon**
- **Moved chats stay in bypass permissions mode for good**
- **Check for updates really checks every time**

**Everything in 0.38.0**

### Added

- **Move chats in bulk.** In Sessions, Ctrl/Cmd-click or Shift-click several rows and right-click
  to copy their ids or move them to another account. In Instances, each row's menu can move all of
  that account's active chats. Both ask first, move one chat at a time, and report how many landed.
- **Move a chat from the right-click menu.** A session row's menu has the same move option as the
  open chat's menu, so you no longer have to open the chat first.
- **Right-click an instance row** to get its menu.
- **Move to an account that is not running.** Targets are grouped as Running and Not running; a
  closed one offers "Start X and move there", which opens that account and then moves the chat.
- **The tray icon starts with the app.** Starting AgentHydra from the Windows zip now starts the
  tray too, unless it is hidden in settings or already running, and the Start Menu shortcut
  launches through the tray as well.

### Fixed

- **Moved chats stay in bypass permissions mode.** The desktop app used to switch a moved chat back
  to accept-edits when it first woke; AgentHydra now puts it back every minute for as long as it
  runs. Chats you created in the app yourself are never touched.
- **Check for updates always asks GitHub** instead of answering from a cached result, and a
  GitHub rate limit is reported as one.
- **The single-file download says once that it has no tray icon.**
- **Quick Instances' success notice can be dismissed.**
- **A run's live output says "Reconnecting…"** when its stream drops, instead of looking frozen.

## [0.37.0] - 2026-09-02

**TL;DR**

- **Orchestrator moved to a separate program—AgentHydra is back to being a pure fleet daemon**
- **Chats stay held off automation one at a time, never auto-archived when waiting for a person**
- **The daemon can put a message in a dormant chat, press Send, and get the answer, end to end**
- **Delivery ledger tracks every staged prompt through delivery or expiry, nothing vanishes silent**
- **Pre-start check reports all instances, chats, and next step in one read-only call**
- **Fleet shows one verdict per account—whether it can work—instead of one surprise per failure**

**Everything in 0.37.0**

### Removed

- **Orchestrator moved out.** The orchestration logic now lives in a separate program that talks to the daemon over HTTP. AgentHydra is a fleet daemon: it knows what instances and chats exist and acts on them when asked.

### Added

- **Fleet health: one verdict per account.** The daemon reports why an account cannot work in one call. It detects hung apps despite their process still running, distinguishes damaged profiles from forgotten sign-ins, and knows whether the app answers requests.

- **Chat holds: one chat off automation, one reason.** A hold silences automation for exactly that chat while direct requests still run. It survives restarts, never expires, and the reason is quoted everywhere the hold appears.

- **Stuck chats told apart from busy ones.** A chat frozen waiting on an unapproved command now shows as stuck, not running. Reported advisory only; nothing acts on it.

- **Delivery actuator: type into sleeping chats.** The daemon puts a prompt in a dormant chat and presses Send through UI Automation, with safety rails that verify the right chat and confirm the text landed.

- **Delivery ledger: track every prompt.** Every staged prompt is a tracked row: delivered (transcript moved), deaf (started but never answered), or expired (unclaimed). The first thing any orchestration sees.

- **Courier: automated delivery.** The daemon registers a task in a dormant app's scheduler; the app fires a session with the prompt baked in, talks through MCP only, and the daemon settles the ledger with the receipt.

- **Pre-start check: read-only fleet report.** Census, then every chat with its next step, then junk lanes (leftovers, naming violations, contradictions). No acts, no side effects.

- **Gate: what state is this chat.** Running (leave it), crashed (with resume), or finished (archive / needs review / human-interrupted). One deterministic answer before any action.

- **Act on gate verdicts.** The act call re-runs the gate, archives durably, surfaces crashed chats with resume prompts, or waits for quota reset. Needs-input carries the one AI judgment.

- **Context handoff for long chats.** Chats past warn threshold surface for proactive rotation before they crash.

- **Circuit breaker: cap repeat attempts.** Unattended attempts now capped per chat per six-hour window, cleared when the action sticks.

- **Collision detection within one repo.** Two live chats in one tree overwrite each other; they are now reported in the pre-check. Report-only: deliberate when the owner asked for it.

### Changed

- **Tests run in parallel locally (1.6x faster), CI stays serial.** Real-process tests timed out under full saturation and credibility cannot depend on machine busyness.

### Fixed

- **Held chats no longer show as actionable.** A hold's reason is now the next step everywhere.

- **Impossible pre-check advice never comes back.** Gate and pre-check now agree about done-marks; superseded chats get told to archive with a reason.

- **Closed accounts near quota no longer show as broken.** Closed is this fleet's resting state; a quota wall only matters if open.

- **Delivery works on non-English apps.** Composer and chat row found structurally, not by text name. Verified live.

- **Dual-composer bug fixed.** Window showing two conversations no longer types in the wrong one.

- **Seven adversarial-review defects fixed:** delivery gate lost offscreen filter; scheduler and monitor callbacks had no exception handling; deaf rows never expired; courier had no attempt cap; delivery rows merged by millisecond; archive was English-only; path comparison was case-sensitive under Bun.

- **Cascade crashes fixed with guardrails.** Timer callbacks that throw are now caught before the process handler.

- **Rename works on non-English apps.** Found structurally after two accessibility pokes. Verified live.

- **Courier delivery hardened:** proof skips synthetic preambles; proof must be on-screen; title matches refuse ambiguity; re-stage supersedes deaf rows; send cooldown added; FIFO prevents starvation.

- **Archive click works on non-English apps.** Menu identified structurally; items matched against known-label table refusing ambiguity.

- **Three lost capabilities restored:** context handoff for long chats, circuit breaker for repeat attempts, collision detection for two chats in one tree.


## [0.36.0] - 2026-08-26

**TL;DR**

- **Every automatic action is now a proposal the orchestrator AI checks first**
- **Desktop chats stay desktop chats: no more hidden headless continuations**
- **A self-test and a screenshot tool to check the orchestration on the real machine**
- **Codex threads appear in the same attention feed**
- **A finished thread writes down what it knows before it is archived**
- **Archiving works for chats started in the app, and says when a chat is still on screen**
- **One database for every way AgentHydra starts**
- **The sidebar restart can no longer close an app under a live chat**

**Everything in 0.36.0**

### Added

- **An orchestration self-test.** It runs the real safety checks against the real machine and
  reports what held, touching nothing it did not create itself. An optional deep mode also creates
  and archives one real chat to prove the app side works.
- **A screenshot tool.** AgentHydra can take a screenshot so a claim about what is on screen can be
  checked. The reviewer uses it after archives and migrations.
- **Codex threads in the attention feed.** Codex threads that stopped mid-work are classified the
  same way as Claude chats. They are marked observe-only, because Codex has no way to receive a
  message.
- **A retired thread writes its knowledge down first.** Before a finished chat is archived, it gets
  one last turn to bring the repository's notes up to date, and may answer that nothing is worth
  keeping. Migrated threads are not asked, and the wording is an editable prompt.

### Changed

- **Nothing acts without a check.** Revives, archives, imports and resume nudges are now proposals
  with their evidence. The orchestrator AI rules on each with a recorded reason, carries out the
  approved ones and reports the outcome.
- **Desktop stays desktop, CLI stays CLI.** The automatic revive that ran a desktop chat headlessly
  and imported it back is removed. Desktop chats now get their turns through the desktop app's own
  message channel, visibly and with no clicks, and new work starts as a real desktop chat.
- **A simpler reviewer playbook.** One order for delivering messages, proposals decided first on
  every wake, and the old queue-based flows removed.
- **Much faster housekeeping.** The chat store is scanned once into a shared index instead of six
  separate times.

### Fixed

- **New chats no longer keep a generic title.** A newly created chat showed "General coding session"
  because the app overwrote its title. The reviewer now renames it through the app right after
  creating it.
- **Archiving no longer claims success while the chat is still on screen.** It now says when the
  chat is still visible and queues a restart of that app for when it has no live chats.
- **Archiving works for chats started in the app.** Only imported chats were found before; the rest
  were silently skipped.
- **A chat stuck at a permission prompt is diagnosed as that.** It was mistaken for a chat waiting
  on dead background tasks. Imported chats now ask for the unattended mode, and the suggested fix is
  to revive with file tools only.
- **Desktop chats can no longer be continued by a headless run.** The guard now sits in the one
  place every headless run passes through, so no route can get around it. New chats are exempt, and
  a deliberate override is recorded.
- **Moving a chat between accounts no longer spends a hidden turn.** A move archives the old entry
  and imports the chat into the new account, with no headless turn in between and no click needed.
- **The sidebar restart can no longer close an app under a live chat.** Its live-chat check never
  matched before. It now refuses to restart when any live chat might belong to that app, or when it
  cannot tell.
- **"Revive:" no longer sticks to chat titles.** A re-imported thread shows its real name.
- **One database for every way AgentHydra starts.** A source checkout and an installed build kept
  separate databases, so settings, the queue and orchestrator state silently diverged. Both now use
  the same per-user data folder, an existing checkout database moves there on first run, and the
  health check says which database is in use.
- **OpenCode sessions written twice in quick succession are picked up.** The second write could be
  missed by the cache.

## [0.35.4] - 2026-08-26

### Fixed

- **Renamed chats show their new name right away.** A running app kept showing the old name until it
  restarted. Renames now trigger the same restart the archive flow uses, as soon as that app has no
  live chats.

## [0.35.3] - 2026-08-26

### Changed

- **Nothing waits on a click from you.** Task chips and handoff continuations are started by
  AgentHydra itself instead of waiting for you to click them. Only real blockers are shown, as
  status text rather than buttons.

## [0.35.2] - 2026-08-25

### Fixed

- **A just-revived chat is no longer flagged as unresponsive again minutes later.** A chat must now
  sit quiet for a while before it counts as unresponsive, so revives happen only when a chat has
  really stalled.

## [0.35.1] - 2026-08-25

### Added

- **Archived chats leave the sidebar right away.** A running app only refreshes its sidebar at
  startup, so every archive now queues a restart of that app as soon as it has no live chats, at
  most once an hour. Your main, non-isolated Claude profile is never restarted.

## [0.35.0] - 2026-08-25

### Changed

- **Auto-revive runs through the queue instead of the keyboard.** Typing into the app failed over
  Remote Desktop and on a locked screen. A revive now runs one resume turn through the queue and
  lands the chat back in its desktop app, with no screen or keyboard needed.

## [0.34.4] - 2026-08-25

### Fixed

- **A visible chat is no longer re-imported over and over.** A desktop chat that continues moves to
  a new session id while its sidebar entry keeps the old one, so the visibility sweep kept
  re-importing and renaming it. Visibility is now judged by the sidebar entry itself, revive checks
  follow the move, and the overwritten title was restored.

## [0.34.3] - 2026-08-25

### Fixed

- **Auto-revive waits for the app to be ready before looking for the chat.** The first attempt on a
  fresh window often could not find the chat's row and gave up. It now retries for a few seconds,
  and the visibility sweep logs each chat it imports.

## [0.34.2] - 2026-08-25

### Fixed

- **Auto-revive never types into the wrong window.** Nothing is typed unless the target window
  verifiably has focus, the chat's own sidebar row has been found and clicked, and the message box
  has been found. Otherwise the attempt stops and retries later.
- **Scratch runs stay out of the sidebar.** Temporary working sessions are no longer imported into
  the app.

## [0.34.1] - 2026-08-25

### Fixed

- **Acknowledging an item no longer stops a dead chat from being revived.** The reviewer's
  acknowledgements hid dead chats from auto-revive too. Auto-revive now sees every dead chat, and
  the feed shows how many revives are pending.

## [0.34.0] - 2026-08-25

**TL;DR**

- **Auto-revive: AgentHydra restarts dead desktop chats itself**
- **Chats whose engine never started are detected**
- **Every chat AgentHydra starts ends up visible in a desktop app**

**Everything in 0.34.0**

### Added

- **Auto-revive.** On Windows, AgentHydra opens a dead chat in its app, sends the revive message and
  counts it a success only once the transcript grows. It never acts while you are typing, over a
  chat that is working, on a finished thread or on a closed account. On by default, with a switch in
  Settings.
- **Unresponsive chats are detected.** A chat process that never ran a turn is flagged for
  auto-revive, and the reviewer stops sending it messages that go nowhere.
- **No invisible chats.** A finished queue run from the last two days with no desktop entry is
  imported into its account's running app, where detection and auto-revive take over.

## [0.33.0] - 2026-08-25

**TL;DR**

- **Edit every message the orchestrator sends into chats**
- **Settings split into General and Automation tabs**
- **Remove and disable the orchestrator with one button**
- **Chats left mid-turn by a normal restart are found**
- **New work is spread across accounts' 5-hour windows**
- **The "Max running chats" setting now saves**

**Everything in 0.33.0**

### Added

- **Editable orchestrator prompts.** Every message the orchestrator sends into a chat is a named
  template under Settings → Automation → Orchestrator → Prompts. Clear one or press Reset and the
  shipped text returns, so later improvements still reach you.
- **General and Automation tabs in Settings.** The scheduler, orchestrator and auto-resume monitor
  moved to Automation, and links into those sections still land in the right place.
- **Remove & disable.** One button turns the orchestrator off and removes its slash commands;
  Reinstall puts them back.
- **Stranded chats are found.** A normal restart left no trace for the crash detector, so a chat
  could sit unfinished out of sight. Desktop chats from the last two days that stopped mid-turn are
  now reported too.
- **5-hour load balancing.** Accounts are ranked so new work goes to the ones with the most 5-hour
  headroom, and several placements at once are spread across them.

### Fixed

- **"Max running chats" now saves.** Changes made in Settings were accepted and then forgotten.

## [0.32.0] - 2026-08-25

### Added

- **A limit on how many orchestrated chats run at once.** Set it under Settings → Orchestrator →
  "Max running chats"; it is unlimited by default. Past the limit, idle chats take turns fairly,
  while answers to questions, handoffs and crash revives never wait.

## [0.31.0] - 2026-08-25

**TL;DR**

- **Chats killed by a restart or crash are found and revived**
- **A finished thread can no longer be continued twice**
- **Finished chats are archived and untitled chats named automatically**
- **Parked threads are listed in Settings, with an Unpark button**
- **A chat whose app was closed is delivered once the app is running**

**Everything in 0.31.0**

### Added

- **Restart recovery.** A chat whose process died mid-work in a restart, crash or kill is reported
  and revived in its own surface, with a prompt to check half-finished work first. Leftovers from
  finished or archived chats are cleaned up instead.
- **No duplicate continuations.** A thread marked done (handed off, migrated or closed) gets no
  nudges, and every revive path refuses it unless forced on purpose. Handoffs mark the old thread
  first, so a crash cannot leave two copies running.
- **The archive janitor.** Chats marked done are archived from the desktop sidebar every few
  minutes. A running app shows this after its next restart.
- **The title janitor.** Imported or migrated desktop chats with no title get their real one
  automatically, and your own renames always win.
- **Waking a chat that stopped listening.** Migrating a chat can now carry a message, so the
  reviewer can wake an imported chat by running that message as a real turn on its own account.
- **Minimum plan is a dropdown** in the orchestrator settings.
- **Parked threads in Settings.** Each thread parked with /delayo is listed with its name,
  repository and age, with an Unpark button.

### Fixed

- **Deliveries to a closed app are retried.** A finished run whose desktop app was closed used to be
  silently lost. It is now retried every minute for up to a day, and the queue shows a badge until
  the chat appears.

## [0.30.0] - 2026-08-25

### Added

- **Chats stuck on dead background tasks get a nudge.** When a chat and its background tasks have
  all been silent for a set time (two hours by default), the reviewer tells it to check, restart or
  stop the tasks and carry on, instead of leaving it waiting forever.
- **Limit-migrated chats appear in the other account's desktop app.** A run moved to another account
  at its 5-hour limit now lands there as a visible chat, and its title no longer stacks up repeated
  prefixes.

## [0.29.0] - 2026-08-25

**TL;DR**

- **The orchestrator: a watcher that looks after every open Claude chat (off by default)**
- **Handoff continuations open in a visible terminal window**
- **/delayo and /resumeo park and unpark a thread**
- **Archive desktop chats, and imported chats keep their titles**
- **Migrate a chat to another account from its menu, or automatically at the 5-hour limit**
- **An Orchestrator section in Settings**
- **Instance detection survives unusual characters in process arguments**

**Everything in 0.29.0**

### Added

- **The orchestrator.** A watcher checks every live Claude chat each minute and lists what needs
  attention: idle chats waiting for input, chats near their context limit, jumps in account usage,
  repositories left dirty, off-main branches and offered task chips. A reviewer chat running the
  shipped /orchestrate command makes the decisions; the command installs itself when you turn the
  orchestrator on.
- **Visible handoff continuations.** A new session can open as an interactive Claude in a real
  terminal window, tied to an account, where it shows on screen and can still be steered. It starts
  from a clean environment so it uses the right account.
- **Account routing for the orchestrator.** The feed lists every desktop account with its state,
  plan and usage. New settings decide when closed accounts may be opened, the minimum plan, a usage
  reserve for the reviewer's own account and where handoffs go.
- **/delayo and /resumeo.** /delayo parks a chat so the orchestrator leaves it alone until /resumeo.
  Holds survive restarts and are shown in the feed.
- **Desktop chat archiving.** Archives a chat in every desktop profile that holds it; a running app
  shows the change after its next restart. Handoffs archive the old chat too.
- **Imports keep their titles.** Imported chats used to land as "Untitled"; they now get the
  original thread's title.
- **Migrate to another account.** A chat's "…" menu lists the running accounts. Picking one stops
  the chat, archives its old entry, runs one turn on the new account and imports it there under its
  real title.
- **Migrate-on-limit** (off by default). A run that hits its 5-hour limit with weekly headroom left
  continues right away on another running account, and falls back to the scheduled resume when none
  fits.
- **An Orchestrator section in Settings** with the master switch, a live status line, new-chat model
  and effort, handoff and account-opening policy, and advanced tuning.
- **New-chat defaults.** Chats the orchestrator starts use Opus 5 at max effort with ultracode by
  default, all adjustable.
- **Imports refuse closed accounts.** Importing into a closed instance would have started that app,
  so it is now refused.

### Fixed

- **Instance detection survives unusual characters.** One process with a character such as an arrow
  in its command line made every instance read as not running.
- **Empty number settings use their default.** An unset number setting used to fall to its minimum.

## [0.28.0] - 2026-08-20

### Added

- **"Copy session file location" can include a prompt and the session's name.** Two switches under
  Settings → Appearance → Advanced, both on by default, with an editable prompt and a live preview.
  With both off you get the bare path, as before.

### Fixed

- **The usage-limit badge clears once a session is past the limit.** It now shows only while the
  session is still stopped at the limit; the Usage limits filter still finds sessions that ever hit
  one.

## [0.27.0] - 2026-08-20

### Added

- **A split conversation says why it split.** The "part 1 of 2" chip now names the cause, such as
  "you stopped it", "server was overloaded" or "a safety filter refused it", with the full sentence
  on hover. The cause is taken only from the CLI's own record.

## [0.26.0] - 2026-08-20

### Added

- **A conversation saved as several transcripts is labelled as one.** Interrupting and resuming a
  session makes the CLI start a new transcript, which looked like duplicate chats. Those rows now
  carry a "part 1 of 2" chip. They are labelled rather than merged, because each older copy holds
  messages the newer one lacks.

## [0.25.2] - 2026-08-20

### Fixed

- **Most "Unknown account" rows now show their account.** Many were a second copy of a chat already
  in the list, stored with no account link. They are now matched to an account by working folder and
  start time, within a margin checked so it never contradicts a known account.

## [0.25.1] - 2026-08-20

**TL;DR**

- **Sessions with no known account say "Unknown account"**
- **More sessions are matched to their account**
- **The instance filter and the instance chip always agree**

**Everything in 0.25.1**

### Fixed

- **"Unknown account" instead of nothing.** Sessions launched from Desktop with no account record
  now say so, with a tooltip explaining why. The size chip explains on hover that it is a size and
  not a name.
- **Some unknown accounts are recovered.** A session is matched to its account by working folder and
  exact start time, but only when exactly one account fits.
- **The instance filter and chip agree.** Both use the same lookup, so a filtered row always shows
  the account it was filtered by.

## [0.25.0] - 2026-08-20

**TL;DR**

- **List the sessions a usage limit stopped, with a badge on each**
- **MCP clients can read all chat history, not just the last day**
- **Body search finds conversations from Cursor, Windsurf, Zed, Copilot and others**
- **Each session shows where its title came from**

**Everything in 0.25.0**

### Added

- **A usage-limit list.** List options → Usage limits shows the sessions a usage limit stopped, or
  only those still stopped, each with a badge showing the provider's notice on hover. It works over
  MCP too and uses the same judgment as auto-resume.
- **Full chat history over MCP.** Listing sessions over MCP now takes a time range, paging, and
  project, instance and archive filters, and says up front that it defaults to the last day.
  Conversations from other tools can be listed, and a new project list shows every folder that has
  conversations.

### Fixed

- **Search covers other tools' conversations.** Body search silently skipped conversations from
  Cursor, Windsurf, Zed, Copilot and similar tools; it now reads them the way the transcript view
  does.
- **Each session says where its title came from.** The title's tooltip names its source, and a title
  taken from a wrapper tag, such as a scheduled task's name, shows that tag beside it.

## [0.24.3] - 2026-08-18

### Fixed

- **Two AgentHydra windows can sit on different tabs.** Switching tabs in one window used to switch
  the other too. Each window now remembers its own tab across reloads, and a brand-new window still
  opens where you last were.

## [0.24.2] - 2026-08-15

### Fixed

- **Quitting from the tray during an update no longer leaves no app running.** The new daemon was
  started as a child of the old one, so Quit closed both. It now starts independently.
- **The relaunch after an update keeps its settings on Windows.** The port and the handoff signal
  now reach the replacement, so it no longer exits thinking it is a second copy.

## [0.24.1] - 2026-08-15

**TL;DR**

- **Updates keep AgentHydra on the same port, so the open tab keeps working**
- **Dropdown menus fit their items**
- **A chat's toolbar is four buttons, and composer settings are icons until you change them**

**Everything in 0.24.1**

### Fixed

- **Updates no longer move AgentHydra to another port.** After an update the new daemon could start
  on a different port, so the open tab lost its connection. It now takes over the port actually in
  use.
- **Dropdown menus are as wide as their widest item.** Menus opened from small buttons were squeezed
  and wrapped their labels; they now size to their content.

### Changed

- **A simpler chat toolbar.** Find, copy path, copy session id and close stay on the toolbar, and
  the rest moved into a ⋯ menu that still shows when display filters are on. The path and session-id
  buttons now have different icons.
- **Composer settings are icons until you change them.** Model, effort and permissions show as icons
  at their defaults and gain a label once overridden, and the row adapts to the width of its pane.
  The queue builder keeps full labels.

## [0.24.0] - 2026-08-15

### Added

- **One conversation is one row, however many files it was split into.** When Claude Code compacts a
  session it continues in a new file, which showed up as several rows with the same title. They are
  now linked and the row opens the latest part. Earlier parts are still counted in costs, and a part
  whose continuation is missing stays listed.

## [0.23.1] - 2026-08-14

### Fixed

- **Opening a chat is near instant.** It took many seconds whatever the chat's size, because the
  transcript index always counted as stale and rebuilt itself while blocking the app. The index now
  stays fresh, rebuilds in the background, and re-reads VS Code Copilot and OpenCode chats only when
  they change.
- **The chat pane and session list no longer pile up requests.** Each waits for its previous request
  before sending another, a filter change still takes effect right away, and a failed read no longer
  blanks the chat you moved to.

## [0.23.0] - 2026-08-13

**TL;DR**

- **An agent can tell which account it is spending, including in Claude Desktop**
- **Usage checks work for Desktop accounts**
- **Every agent gets AgentHydra's operating rules automatically**
- **Usage budget works with no arguments and for the default login**
- **Every instance shows its rate-limit tier**

**Everything in 0.23.0**

### Fixed

- **Agents can tell which account they are using.** Claude Desktop sessions reported no account and
  then checked the wrong one. AgentHydra now tries several signals in order, and each answer says
  how sure it is, which signal decided it and what was ruled out, with a warning only when it is
  unsure.
- **Usage checks read Desktop credentials.** Checking usage from a Desktop instance now reads that
  instance's own login instead of failing.

### Added

- **Operating rules for every agent.** An agent connecting over MCP receives a short set of rules up
  front, such as checking quota before expensive work and saving before being cut off. Every usage
  answer also carries one line naming the next step, and leaves out the account name when it is not
  confirmed.
- **Usage budget without arguments.** With no arguments it budgets the calling agent's own account
  and says which account it measured.
- **Usage budget for the default login.** The plain Claude login, which belongs to no instance, can
  get a burn rate too.
- **Rate-limit tier on every instance.** Each instance shows Pro, Max 5× or Max 20× beside its plan
  name, because the plan name does not tell you the quota.

## [0.22.0] - 2026-08-13

### Fixed

- **OpenCode subagents are no longer listed as separate chats.** They are hidden from the session
  list but still counted in costs, and still open, export and delete normally. Older OpenCode and
  Kilo stores keep working.

### Added

- **A row says how many subagents it ran.** Sessions that spawned subagents carry a chip such as "5
  subagents".

## [0.21.0] - 2026-08-13

**TL;DR**

- **Spend totals corrected for Claude, Codex and OpenCode**
- **More tools read: Claude Cowork, Grok, Kimi, VS Code Copilot, Copilot CLI and Zed**
- **About forty more agent tools detected and listed**
- **Prices downloaded daily, and OpenAI models priced**
- **Analytics shows the token split, tokens by tool and a provider filter**
- **The background scan now covers the whole store**
- **Better charts: accurate hover cards, expandable lists, monthly bars for long ranges**

**Everything in 0.21.0**

### Added

- **The background scan finishes.** It now continues in chunks until the whole store is covered, so
  Analytics no longer stays partial.
- **Prices are downloaded.** AgentHydra fetches LiteLLM's public price list daily, covering
  thousands of models, and falls back to its built-in table offline. Analytics says which prices are
  in use and how old they are.
- **OpenAI models are priced.** The GPT-5 to GPT-5.6 families are priced, with cached input and
  cache writes handled correctly, so Codex spend shows in dollars.
- **Routed model names are priced.** A model recorded as provider/model, as OpenCode does, is priced
  as the model behind it.
- **More tools are read.** Claude Cowork runs appear as full Claude sessions with costs. Grok, Kimi,
  VS Code Copilot, Copilot CLI and Zed conversations are listed, readable, searchable and
  exportable, without spend because those tools do not record it. Each row names the product that
  wrote it.
- **Wider agent support.** OpenClaude, TraeX, Kilo, MiMo Code and IcodeMate are read in full, since
  they use formats AgentHydra already knows. About forty more tools, from Gemini CLI to Cursor, are
  detected and listed with where they keep their data, marked as not yet readable.
- **Where the tokens went.** Analytics splits tokens into fresh input, cached input, cache writes
  and output.
- **Tokens by tool,** showing how much of the work Claude, Codex and OpenCode did.

### Fixed

- **Codex spend filed under the wrong model.** Turns that spent tokens before naming their model are
  now credited to the right one.
- **Claude subagent spend was missing.** Subagent transcripts now count as part of the session that
  spawned them, without being listed as rows.
- **Claude spend was counted several times per request.** Each request is now counted once, which
  corrects session costs, analytics totals, the hour grid and quota calibration. A resumed session
  can still repeat some of its parent's requests.
- **Codex spend was hugely overstated.** A conversation's rollout files all repeat the same running
  total, so a conversation now counts as its largest file, not the sum.
- **Statistics cover Codex and OpenCode.** Their sessions no longer show zero tokens.
- **Unpriced models are not shown as free.** The cost chart lists only what it can price and names
  the rest with their token counts.
- **Long ranges chart by month** when a day-by-day chart would be unreadable.

### Changed

- **Chart hover lands where you point.** The concurrency chart's hover was offset; both time charts
  are now drawn at their real width.
- **Instant hover cards on charts** with useful context, such as share of the week or the busiest
  day. Cells keep accessible names.
- **"N more" rows expand** without resizing the bars already shown.
- **Filter Analytics by provider,** such as Anthropic, OpenAI or DeepSeek.
- **A square hour-of-week grid** that fills its card.
- **A readable recently-edited feed** that leads with the file name, tags the type, groups repeated
  edits and says how long ago.

## [0.20.0] - 2026-08-13

**TL;DR**

- **An Analytics tab: cost, activity, tool use and concurrency across your sessions**
- **The cost of each queued run and each open session**
- **Export a session as Markdown or a single HTML file, with secrets removed**
- **Transcripts render markdown with highlighted code, plus display filters and find in session**
- **Instant content search from a small index that stores none of your text**
- **Agents can search transcripts over MCP and tell a miss from a timeout**
- **Reopen a finished session in a terminal, and see which overnight runs died**
- **Keyboard shortcuts with a ? sheet, and a verified one-line Windows install**

**Everything in 0.20.0**

### Added

- **An Analytics tab.** Cost by day, model, project and account; when in the week the work happens;
  how many sessions ran at once; the tool mix; recently edited files; and sessions worth a second
  look. Costs are API list prices, agent hours count engaged time rather than wall clock, and no
  message text is stored. Also available over MCP and from the command line.
- **The cost of a queued run.** Because AgentHydra dispatched the run, it can price exactly the
  turns inside it.
- **Session export.** Save a whole session as Markdown or as one self-contained HTML file.
  Recognisable secrets are replaced, and the document says so.
- **Leaked secrets are counted.** The session header shows how many recognisable keys or tokens a
  session printed, with a redacted list. There is no way to reveal them.
- **Reopen a finished session in a terminal.** Where no terminal can open, the resume command is
  copied to your clipboard instead.
- **Queued or by hand.** Each row says whether AgentHydra queued it or you ran it yourself, and the
  list can filter to either.
- **A liveness dot** on each session: working, idle or stale, based on file activity.
- **Session shape.** Quick, standard, deep, marathon or automation, worked out from message count
  and elapsed time together; also a filter.
- **Keyboard shortcuts and a ? sheet** that lists them: find in session, jump to the filter, switch
  tabs and back out.
- **Version as JSON.** The command line can print the version, commit and build time, so two
  machines on the same version can be told apart.
- **A one-line Windows install** that checks the download's checksum and refuses a mismatch. It does
  not need Administrator.
- **Display options and find in session.** A Display menu shows only your own messages, tool
  activity, reasoning or a compact layout, and filters apply before the turn window so you still see
  enough turns. Find in session searches the open transcript with next and previous.
- **The cost of an open session.** The session header shows tokens and dollar cost, with cache reads
  and writes priced separately and unpriced models marked. Claude sessions only.
- **Markdown transcripts with highlighted code.** Replies render headings, lists and code blocks
  with syntax highlighting, with no new dependency. Transcript text cannot inject markup, and only
  safe link types are clickable.
- **See which overnight runs died.** The finished list can show only runs that did not complete, the
  run viewer shows how a run ended, and agents reading a run's events get its outcome.
- **Instant content search.** A small word index of what was said, skipping tool output and storing
  no text, makes searches near instant across the whole store. Without it the full scan answers as
  before, and Settings shows its size and can delete it.
- **Agents can search transcripts.** A new MCP search tool exposes body search, and every search
  says when it ran out of time or hit its limit, so a partial answer is not mistaken for a complete
  one.

### Fixed

- **Content search no longer says "session not found".** Every advanced search in the web UI failed
  this way.

## [0.19.3] - 2026-08-11

**TL;DR**

- **Tooltips are reachable on a phone.**

**Everything in 0.19.3**

### Fixed

- **Tooltips are reachable on a phone.** Reka UI ignores touch pointers on hover, so on a touch-only
  device every tooltip here was dead, including the toolbar labels `IconTooltip` puts on icon-only
  controls and, worst of all, the info icons: a setting's description lives behind that icon and
  nowhere else, so on mobile the text simply did not exist. Info icons now disclose on a single tap
  and close on a tap outside, a second tap, or a scroll. Every other tooltip opens on a
  press-and-hold, so a plain tap still runs the control's action exactly as before, and the click
  ending a hold is swallowed so nothing fires behind the tooltip. Sliding a finger abandons the
  hold, leaving scrolling alone. Mouse and pen behaviour is untouched: the gestures key off the
  event's own pointer type, not a device media query, so a touchscreen laptop keeps hover and merely
  gains them. From the shared UI kit; reported against RepoYeti as
  [#16](https://github.com/LunarWerxs/RepoYeti/issues/16).

## [0.19.2] - 2026-08-10

**TL;DR**

- **The periodic update check now doubles as an anonymous install ping.**

**Everything in 0.19.2**

### Changed

- **The periodic update check now doubles as an anonymous install ping.** The compiled distribution
  already hit `api.github.com/repos/LunarWerxs/AgentHydra/releases/latest` on a timer to look for a
  newer release. That call now goes to Studio's app-ping proxy instead, which relays the same GitHub
  JSON back verbatim (so every reader of the response is unchanged) and logs one row per hit: a
  random per-install id, the app version, and a coarse OS tag. Update-checking itself adds zero
  extra network traffic to get fleet-wide install/version telemetry out of it, the same wiring
  QuickDictate and AnatomyOf already run in prod. From that request the server also derives and
  stores a coarse location (country, region, city, timezone), the network's ASN, locale, and a
  truncated user agent, never an IP address, hostname, username, file path, account, or email.
  `AGENTHYDRA_NO_PING=1` (also the default for dev/test/CI runs) opts out; the update check then
  falls back to asking GitHub directly, carrying no install id and no telemetry params, so
  update-checking never depends on the ping being allowed. README's old "no telemetry" claim is
  replaced with this disclosure.

## [0.19.1] - 2026-08-10

**TL;DR**

- **The system-tray icon is back in the Windows download.**
- **The tray icon survives an Explorer restart.**
- **A tray icon that fails to appear at startup now retries instead of giving up.**
- **A packaged build no longer tries to run `bun install` on itself.**

**Everything in 0.19.1**

### Fixed

- **The system-tray icon is back in the Windows download.** Packaged builds have shipped without it
  since 0.12.0: the 0.11.2 release prep trimmed "sidecars" from the bundle and took the `misc\` tray
  toolkit with them. The daemon contains no tray code at all, so with those files gone there was
  nothing left to draw an icon, and no combination of settings could bring one back. The ZIP carries
  the toolkit again, the release smoke test now fails if it ever goes missing, and both READMEs say
  plainly that the icon comes from the shortcut rather than from `AgentHydra.exe`.
- **The tray icon survives an Explorer restart.** When the Windows shell restarts it destroys every
  tray icon and expects each app to add its own back. The native launcher never listened for that
  broadcast, so the icon disappeared for the rest of the session while AgentHydra kept running
  normally, and relaunching the shortcut only re-opened the UI. It listens now, and re-adds the icon.
- **A tray icon that fails to appear at startup now retries instead of giving up.** The launcher
  assumed its first attempt had worked. If it had not (most often because the taskbar did not exist
  yet, on a launcher started at logon), the five-second health tick believed the icon was already
  showing and never tried again. It records the real result and retries.
- **A packaged build no longer tries to run `bun install` on itself.** The launcher's first-run
  bootstrap is meant for a source checkout; in a release bundle none of the files it looks for exist,
  so every step fired, on the one layout guaranteed to have no Bun.

## [0.19.0] - 2026-08-10

**TL;DR**

- **Every remembered layout choice now survives a port change, not just the usage filter.**
- **The usage filter stops forgetting whether it was on.**

**Everything in 0.19.0**

### Changed

- **Every remembered layout choice now survives a port change, not just the usage filter.** The tab
  you were on, the three Instances tables' collapse states, the sessions period / provider /
  archived filters, transcript verbosity, body-search case sensitivity and the sidebar width all
  lived in browser storage only, so they reset on any launch where the daemon had to hop to another
  port. They go through the same daemon-side store as the usage filter now. Values still paint from
  the browser cache first, and a key the store has never seen is seeded from whatever this browser
  already had, so nothing anyone has already set is lost on the way in.
  - The mirror carries short strings as well as switches and numbers, and a string preference
    declares its own value set. The store is a plain file, and an unrecognised value reaching a tab
    strip or a filter dropdown would render a control with nothing selected.
  - These preferences moved out of the components that read them and into one module
    (`composables/useUiPrefs.ts`). A mirrored ref has to outlive its component: registration is
    keyed, so only the first mount's ref is the mirrored one, and views behind a tab unmount every
    time you switch away.
  - Not included, deliberately: the theme (owned by the shared kit under its own un-namespaced key,
    which this store does not accept) and the locale (English is the only catalog that ships).

### Fixed

- **The usage filter stops forgetting whether it was on.** The cross-window store added in 0.18.0 is
  the only memory the app has on a hopped port (the daemon moves to 7788/7789/… whenever its
  preferred one is busy, and a new port is a new browser origin with an empty `localStorage`), so
  every way of losing a write to it shows up as "my filter is off again". Three were open, and each
  one is silent by nature: nothing throws, nothing logs, the switch is just back where it started.
  - **A choice made while the first read was still in flight was dropped, then overwritten.** The
    window paints from `localStorage` (defaults, on a port it has never seen), so the filter reads as
    off; clicking it on in those first moments hit a watcher that deliberately pushes nothing before
    the store has been read, and then hydrate applied the stored value on top. The click undid itself
    a beat after it was made. Such a change is now recorded the instant it happens, hydrate leaves it
    alone, and it is sent as soon as the read lands. The rule it was protecting is untouched: a
    window still never pushes before it has read the store.
  - **A read that failed once failed forever.** A window opened by a daemon that is still starting
    can ask before the socket answers, and there was no retry and no second hydrate, so that window
    ran on its local cache for the rest of its life, which on a fresh origin means defaults.
    It now retries three times over ~750 ms, which nothing waits on.
  - **A push cancelled by the closing window was silently reverted.** Toggling something and closing
    the window straight after killed the request along with the document, and since the store is
    authoritative the next launch handed the old value back. Unconfirmed changes are now queued
    rather than assumed sent: the next change carries them, and `pagehide` hands whatever is left to
    `sendBeacon`, which outlives the page.
  - A preference registered *after* the store is read (a lazily-loaded view) now receives it too.
    Nothing is loaded that late today, but hydrate runs once per window, so the failure mode was one
    import away and would have looked exactly like the bugs above.

## [0.18.1] - 2026-08-09

**TL;DR**

- **A detached launch no longer breaks on a path containing `&`, `|`, `^`, or a space.**
- **The console-window guardrail no longer reads prose as code.**

**Everything in 0.18.1**

### Fixed

- **A detached launch no longer breaks on a path containing `&`, `|`, `^`, or a space.** Windows
  launches that must outlive the daemon (a desktop shortcut, the relaunch an auto-update performs on
  itself) go through the shared kit's detached-spawn helper. It prefers WMI, and when WMI refuses it
  fell back to handing an already-quoted command line to `cmd.exe /c start ""`. That put a *second*
  parser in the path, and cmd re-parses `&`, `|` and `^`, all of which are perfectly legal in an
  NTFS path. A repo or profile directory containing one was re-split on its way to `CreateProcess`,
  so the fallback that exists to keep a launch working was the thing that broke it. The fallback is
  now `Start-Process -FilePath … -ArgumentList @(…)`, which never involves cmd.
  - **Each argument is pre-quoted, because `Start-Process` does not do it for you.** Windows
    PowerShell space-*joins* `-ArgumentList` without quoting elements that contain spaces, so a
    plain `C:\Program Files\…` element reached the child as three separate arguments, corrupting
    the successor daemon's own arguments, which is precisely the failure this fallback is for.
  - Nothing here changes the WMI path, which is what almost every launch actually takes; this only
    repairs the branch taken when WMI is unavailable or blocked.

### Internal

- **The console-window guardrail no longer reads prose as code.** `scripts/checks/spawn-console-window.mjs`
  is a text scan, and it had no notion of comments, so a *sentence* naming a spawn counted as one.
  The fix above ships a header explaining which shell `spawn("powershell")` resolves to, and that
  alone turned CI red against a file containing no spawn call at all. Comments are now blanked
  before the scan, index-for-index so reported line numbers still line up. Regex literals are
  tracked too, and that half is not optional: a `"` inside a character class (`!/[ \t\n\v"]/`, in
  the very file being scanned) opened a string that never closed, which inverts code and string for
  the rest of the file and produces false positives rather than misses.

## [0.18.0] - 2026-08-07

**TL;DR**

- **Quick Instances gets the quota columns and the usage filter, and remembers how you left them in
  the full manager.**
- **The app checks for updates on its own, and says so where you can see it.**
- **The update tells you what it is doing.**
- **Clicking update on a downloaded release no longer spins forever after the update has already
  succeeded.**
- **Toasts have a close button.**
- **Opening the app no longer resolves every instance over the network.**
- **The Instances tab no longer probes every account's quota at once on open.**
- **A crashed daemon no longer costs half a second on the next boot.**

**Everything in 0.18.0**

### Added

- **Quick Instances gets the quota columns and the usage filter, and remembers how you left them in
  the full manager.** The compact window showed a single weekly badge and no way to act on it. It
  now carries both readings (5h and week) behind the same usage-mode toggle the Instances tab uses,
  and the same "set aside the accounts I've used up" filter, with dim/hide and per-window
  thresholds. It is the same state, not a copy: both surfaces read one shared singleton, and the
  filter rule itself has only ever had one implementation.
  - **The state is mirrored through the daemon**, which is what makes "remembers" true. Quick
    Instances normally opens on the running daemon's port, but with no daemon it starts its own
    server on a *different* port, and a browser scopes `localStorage` per origin, port included. So
    the window that ran standalone landed on a blank slate every time. A small store
    (`~/.agenthydra/ui-prefs.json`, served by both daemons) now holds the handful of keys; the
    server wins on load and `localStorage` stays as the instant-paint cache. A first run seeds the
    store from whatever the browser already had, so existing settings carry over rather than
    trickling in as controls are touched.
- **The app checks for updates on its own, and says so where you can see it.** Auto-*apply* is off
  by default because it restarts the daemon, but that flag also gated the *check*, and the only
  other code that ever asked was the Settings screen's own mount. Run an older build and never open
  Settings, and nothing ever told you. Checking and applying are now separate: the loop always
  checks, applying stays opt-in and unchanged, and a newer version puts a dot on the Settings
  button. A manual check feeds the same signal, so the hint is never staler than what you have
  already been shown.
- **The update tells you what it is doing.** Clicking the version to update bound a spinner to one
  request that legitimately covers minutes on a source checkout (a pull, then a dependency reinstall,
  then a web build), and reported nothing until it finished, so a healthy slow update and a hung one
  looked identical. The compiled path now streams its download and reports real progress
  (`Downloading v0.17.0… 62% (22/36 MB)`), then extraction, verification and install; the source
  path reports its phase and says why it takes a few minutes. The apply request is also bounded at
  20 minutes, so the spinner always ends: a daemon that restarts itself mid-apply (which a compiled
  apply does on purpose) used to leave it turning until the user reloaded the page.

### Fixed

- **Clicking update on a downloaded release no longer spins forever after the update has already
  succeeded.** This was the actual cause, and it is not slowness: a compiled apply is only a few
  seconds of work (measured on the real v0.17.0 asset: 2.3 s to download, 0.5 s to extract). But the
  daemon deliberately restarts itself afterwards, and it began that restart 250 ms after writing the
  response, exiting about a second later. A browser that had not finished reading by then lost the
  socket, the request failed, and the spinner turned on an update that had in fact completed. The
  restart now waits three seconds, and the page independently recovers by polling the daemon's
  health and reporting the version that comes back, so the outcome is reported either way.

- **Toasts have a close button.** `<Toaster>` was mounted without `close-button`, and vue-sonner
  defaults it off, so no toast in the app could be dismissed except by waiting. It showed worst on
  the plain ones ("Auto-updates enabled"), which carry no action button either and so had no
  controls at all. The kit's wrapper already shipped the glyph and pinned it top-right; it was
  simply never switched on.
- **Opening the app no longer resolves every instance over the network.** The sessions list, the
  queue drawer and the composer all pull the shared instance singleton just to put a name on a chip,
  and each one triggered a full identity resolve of every instance. Measured on a 15-instance
  install: 15 profile calls, 4-wide, ~1.4 seconds of continuous requests, to label chips the on-disk
  cache answers in about 25 ms. Those callers now read the cache; only the Instances tab, the
  screen that is *about* accounts, resolves for real, and a login that provably changed is still
  corrected immediately. Now 1 network resolve, done in under 0.6 s.
- **The Instances tab no longer probes every account's quota at once on open.** It fired one forced
  probe per instance from a single unbounded `Promise.all` the moment the lists arrived. Measured
  at 14 simultaneous requests, the slowest taking 8.8 seconds, on every open. The server already
  keeps a usage cache that survives restarts and re-sweeps on its own timer, so the table has
  numbers immediately; only readings that have aged out are re-checked now, two at a time with a
  stagger. Now 2 probes instead of 14.
- **A crashed daemon no longer costs half a second on the next boot.** The single-instance guard
  re-probes three times before concluding nothing is running, which is right when a daemon might be
  alive but busy, and pointless when `runtime.json` names a process that no longer exists. The
  tombstone case is now detected directly. Boot after a hard kill: ~1,420 ms → ~920 ms.
- The full manager's toast stylesheet loaded on its own round trip after the app and i18n chunks,
  rather than alongside them.

## [0.17.0] - 2026-08-07

**TL;DR**

- **Every instance now has a permanent number, and you can talk to the MCP server in numbers.**
- **The usage filter can now set aside an account for its 5-hour window as well, on its own
  threshold.**
- **The usage flyout is laid out as labelled sections over cards**

**Everything in 0.17.0**

### Added

- **Every instance now has a permanent number, and you can talk to the MCP server in numbers.**
  Until now nothing an instance carried was usable as a spoken or written handle: a Claude Desktop
  instance is identified by its folder path, a Claude CLI or Codex instance by a random uuid. Worse,
  the folder name is not even reliable: sign a profile into a different account than the one it was
  named after and it keeps showing the old name (this machine has exactly that, the folder
  `3claude` is signed into the account labelled `4claude`, and vice versa). So "check instance 7's
  usage" was a sentence with nothing behind it. Now `#7` is a real identifier.
  - **One sequence across all three families** (Desktop, CLI, Codex), so a bare `7` never needs a
    kind beside it. Assigned on first sight and **never reused**: a number retired by a deleted
    instance stays retired, because the whole value of the handle is that a note saying "instance 7"
    still means the same account next month. A cold start numbers the fleet in sorted-ref order, so
    the same set of instances numbers identically on any machine.
  - **Visible where you read it**: a `#N` chip on every row of all three instance tables, and a
    header on every row's ⋯ menu naming which instance the menu belongs to. Both copy on click.
  - **Accepted where you act**: every MCP tool that addresses an instance takes `instance`, which
    accepts the number (`7`, `#7`), the dir/id, a `desktop:<dir>`/`cli:<id>` ref, or an unambiguous
    name. The legacy `dir` / `id` parameters are unchanged, so nothing that already worked broke.
  - **Three new MCP tools**: `list_instance_numbers` (the whole fleet, one flat numbered list with
    each account's email and plan), `resolve_instance` (confirm which account a reference means
    before spending its quota; its errors distinguish an unknown number from a retired one),
    and `whoami` (which numbered instance THIS process is, matched from its own
    `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
  - `check_my_usage` now reports `instance` alongside the numbers, so an agent can say "instance #7
    is at 84% weekly" instead of an unattributed percentage. `list_usage` rows carry `num` too.
  - `usage_budget` gained the `instance` form, which incidentally **fixes a gap**: it previously
    only accepted a desktop dir or a dispatch account, so a CLI or Codex login could not get a
    budget at all. A CLI instance's token spend is now measured against its own config dir rather
    than defaulting to the [`~/.claude`](docs/CLAUDE-CONFIG-LAYOUT.md) login, which belongs to a different account.
  - A queue item's `instance_ref` accepts a number too; it is expanded to a real ref before the item
    is stored, so a pinned run can never fail to resolve later, at dispatch time, with nobody
    watching.
  - New REST routes: `GET /api/instance-numbers`, `/api/instance-numbers/resolve?ref=`,
    `/api/instance-numbers/whoami?configDir=`, plus `instance=` on `/api/usage` and
    `/api/usage/budget`.
- **The usage filter can now set aside an account for its 5-hour window as well, on its own
  threshold.** A spent 5-hour session means you cannot use an account *right now*; a spent weekly
  cap means you cannot use it *at all*. Those are different questions, and the filter could only ask
  one of them at a time: the old "Measure against Weekly / 5h / Either" tri-toggle shared a single
  number across both windows, so "set it aside at 80% of the week, but already at 50% of this
  session" was not expressible (owner-reported).
  - Each window is now its own switch with its own threshold, and a row is set aside when **either**
    line is crossed. **Weekly** stays on by default; **Also 5-hour usage** is opt-in, because that
    window refills the same day and filtering on it by default had rows leaving the table and coming
    back over an afternoon.
  - A stored `Weekly` / `5h` / `Either` choice carries over to the pair of switches that behaves
    identically, so nobody's filter silently re-points at a different window on upgrade. An
    unreadable or missing threshold lands on the default rather than on 0, which as a threshold
    would have meant "set aside every account that has any reading at all".
  - The toolbar button says the whole rule (`80% · 5h 65%`), so a dimmed table explains itself
    without opening the flyout.
  - **Fixed**: the "every instance is filtered" empty state told you to *lower* the threshold, which
    hides more rows, not fewer.

### Changed

- **The usage flyout is laid out as labelled sections over cards** rather than one run of
  hairline-divided rows. With two windows, each carrying a switch and a threshold, an
  undifferentiated list left no way to see which threshold belonged to which switch. Each window is
  now a card that visibly contains its own controls, its threshold reads as a value display, and a
  slider sits beside the presets for setting a figure that isn't one of the four.

## [0.16.2] - 2026-08-06

**TL;DR**

- **A Codex Desktop you didn't create through this app is now listed.**
- **Codex / ChatGPT instances now have a real identity, a plan, and a quota reading.**
- **A 5-hour reset no longer notifies for an account you have filtered out.**
- **A free account no longer shows as "Max 20×".**
- **The account one-liner no longer leaks a raw tier string.**
- **A usage reading whose window has already reset no longer poses as current.**

**Everything in 0.16.2**

### Added

- **A Codex Desktop you didn't create through this app is now listed.** The table only ever showed
  instances created here, so someone running a perfectly normal Codex Desktop saw "No Codex
  instances found" (owner-reported). The default install is now always listed, running or not,
  because its identity lives in CODEX_HOME on disk and is readable either way; a Codex Desktop found
  running from any other unrecognized profile is listed too. Both are flagged external and offer no
  actions, mirroring `isExternal` on the Claude side, since they have no store row to act on.
  - The default install could never have matched before: its profile is the shipped app's own
    Electron path (`%APPDATA%\Codex\web\Codex` on Windows), not the `<CODEX_HOME>/desktop` layout
    this app imposes on instances it creates. A running instance is matched on the path its own
    process announces, so no platform guessing is involved when it counts.
- **Codex / ChatGPT instances now have a real identity, a plan, and a quota reading.** Until now a
  Codex row carried exactly one identity signal, `loggedIn`, which was literally "does auth.json
  exist", so every row looked alike no matter which account or plan was behind it. The table now
  has **Account**, **Usage** and **Plan** columns, matching the Claude tables.
  - Identity comes from `<CODEX_HOME>/auth.json`, which is plain JSON rather than a safeStorage
    blob, so there is no decrypt step: the email, name, plan, account id, org and subscription end
    date are read straight from the id_token's claims. That read is cheap enough to attach to every
    row on every list, so the Account column fills in on first paint with no per-row request.
  - Quota comes from the endpoint the Codex CLI's own status screen uses
    (`GET /backend-api/codex/usage`), which answers identity AND rate limits in one call. The
    windows are mapped onto the SAME `UsageSnapshot` the Claude rows use, so Codex inherits the
    whole existing quota surface: the chip, the countdowns, the usage filter, the superseded-window
    rule below. Windows are filed by their reported LENGTH, never by primary/secondary: a Plus
    account reports its single 7-day window as `primary_window`, so position would have mislabelled
    an entire plan tier as a 5-hour session.
  - The live `plan_type` wins over the token's `chatgpt_plan_type` claim, which is a mint-time
    snapshot. This is the same evidence rule the Claude-side fix below arrives at, applied from the
    start rather than after a regression.
  - An `OPENAI_API_KEY` login is labelled "API key" rather than rendered as a broken ChatGPT login:
    it is a valid Codex auth with no subscription and therefore no plan or quota to report.

### Changed

- **A 5-hour reset no longer notifies for an account you have filtered out.** The weekly cap is what
  actually blocks an account, so a session window coming back while weekly is still spent announces
  a change you cannot act on. Reset notifications now skip a 5-hour rollover when that account's
  weekly usage is at or above a threshold, defaulting to 80, the same line the Instances usage
  filter uses to set a row aside. Weekly resets are never skipped, an unknown weekly figure never
  silences anything, and the threshold is its own control in Settings › Notifications.

### Fixed

- **A free account no longer shows as "Max 20×".** Owner-reported: an account that is
  `organization_type: "claude_free"`, `billing_type: "none"`, `has_claude_max: false` was labelled
  Max 20×. The cause was the previous release's own fix, which promoted the OAuth grant to top
  evidence on the premise that Anthropic re-mints it on every token refresh. It does not. Measured
  by decrypting all eleven local token caches and diffing each against its live profile, the grant
  is a snapshot from whenever it was minted and is stale in **both** directions: the free account
  carried three unexpired grants all still claiming `subscriptionType: "max"` /
  `rateLimitTier: "default_claude_max_20x"`, while two genuinely-paid accounts carried a `max_5x`
  grant tier against an org reporting `max_20x`.
  - The plan now comes from `organization.organization_type`, which the profile API recomputes on
    every call. It settles the plan family outright; the rate-limit tier only refines a `claude_max`
    family into 5× or 20×, and the grant is demoted to an offline fallback.
  - Both prior findings still hold and are still respected: a paid Pro account really does report
    the generic `default_claude_ai` tier (0.16.1), and `has_claude_max` / `has_claude_pro` really do
    stay true after an account lapses (2026-07-22). Neither can decide the label any more, so
    neither can be wrong about it.
  - `organization_type` is cached alongside the rest of the identity, so the offline/no-network path
    reaches the same answer instead of falling back to the stale grant.
- **The account one-liner no longer leaks a raw tier string.** The Quick view showed
  `Michael <someone@example.com> · default_claude_ai` for any account whose tier is the generic
  value. It now shows the same reconciled label the Plan column does.
- **A usage reading whose window has already reset no longer poses as current.** The same instance
  sat at "100% · resets now" from an eleven-day-old cached snapshot: the countdown said *now*
  (formally true, the instant had passed) and the percentage kept asserting a window that had rolled
  over days earlier. A limit whose reset is more than a couple of minutes past is now treated as
  superseded: the chip reads as no-data, the countdown blanks rather than saying "now", and the usage
  filter counts it as unknown so a fully-reset account can never stay hidden behind a number that no
  longer applies. This is distinct from the existing 30-minute "stale" dimming, which still shows
  the last known reading because it is still a reading of the current window.

## [0.16.1] - 2026-08-06

**TL;DR**

- **A paid account no longer shows as "Free".**

**Everything in 0.16.1**

### Fixed

- **A paid account no longer shows as "Free".** Two independent faults in the same evidence chain,
  both owner-reported and both verified against real accounts:
  - The rate-limit tier was read from the profile's ORGANIZATION (`organization.rate_limit_tier`),
    which for a personal org is routinely the generic `default_claude_ai` even on a paid plan. That
    generic value was preferred unconditionally over the OAuth grant's own tier, so a Max 20x
    account whose grant plainly said `default_claude_max_20x` had its only specific answer thrown
    away and rendered as Free. A specific tier now wins wherever it comes from, and the generic
    value is only settled for when nothing better exists.
  - A generic tier was itself treated as proof of a free account. It is not: an actively-paid Pro
    account reports `default_claude_ai` on its grant too (confirmed by decrypting the token cache:
    subscriptionType `pro`, unexpired). A generic tier now means "this signal knows nothing" and
    falls through to the grant's subscription type; it only resolves to Free when there is no
    subscription evidence behind it at all, which is the genuine free-account shape.
  - The 2026-07-22 finding that motivated the old behaviour still stands, because it was about a
    different field: the profile's `has_claude_max` / `has_claude_pro` booleans stay true for an
    account that lapsed back to free. Those are entitlement history rather than current state, and
    they can no longer overwrite a grant that says otherwise; they are consulted only when there is
    no grant to ask.

## [0.16.0] - 2026-08-06

**TL;DR**

- **Usage filter.**
- **Expanding and collapsing a section animates.**
- **Reset toasts fixed and batched.**
- **Instances tab performance improved.**
- **The Instances tab opens on the quota columns by default.**
- **Inter is served by the app, not fetched from Google.**
- **Settings that belong to a screen now live on that screen.**
- **Account column fills at page load.**

**Everything in 0.16.0**

### Added

- **Usage filter.** With the quota columns on, a funnel button appears in the Instances toolbar:
  set a percentage and the instances at or above it are dimmed, so the accounts you can still work
  on are the ones that read clearly. A **Hide instead of dim** switch drops them from the table
  outright; both tables then say "4 of 11 · 7 hidden" in their heading, because an instance that
  silently stopped being listed reads as a bug rather than as the filter working.
  - **Measure against** picks the window the threshold applies to. It defaults to *Weekly*, the
    Usage column: that is the cap that decides whether an account is worth starting on. *5h* reads
    the shorter session window and *Either* takes whichever of the two is closest to its cap, both
    of which are opt-in, since a 5-hour reading comes back the same day and would otherwise have
    rows dropping out and back in over an afternoon.
  - An instance that has never been checked is never filtered. An unknown reading is not a full one,
    and treating it as one would quietly remove a perfectly usable account from the table.
  - The filter lives and dies with usage mode: switching back to the process columns restores a
    plain table, so a dimmed row always has the control that explains it visible in the same toolbar.
- **Expanding and collapsing a section animates.** The two instance tables, the Codex table and the
  queue card's run viewer used to appear and vanish between frames, with a rotating chevron as the
  only sign anything had happened. They now open and close over 0.22s, matching the speed the kit's
  collapsibles already used elsewhere in the app, and honour `prefers-reduced-motion`.
  - This needed a component of its own rather than the kit's `ExpandTransition`, which keeps
    `overflow: hidden` on its wrapper permanently. An element with a non-visible overflow becomes
    the scrollport that `position: sticky` resolves against, so wrapping a table in it silently
    stops the header sticking, which is exactly why these tables had no animation to begin with.
    The local one clips only while the transition is actually running, i.e. the one moment nothing
    is being scrolled. Popovers and focus rings inside an expanded block stop being cut off at its
    edge as a side effect.

### Fixed

- **Reset toasts no longer deal themselves into the wrong slots, or jitter under the pointer.**
  vue-sonner (2.0.9, the current release) positions its stack from a heights array it keeps beside
  the rendered toasts, and each toast measures itself in an effect that awaits a tick. Raise two in
  the same tick and those measurements come back in the reverse of the raise order while the array
  blindly prepends each one, so every card's offset is attributed to a different card. Measured
  here with three at once: the front toast got the middle card's offset and the middle one got zero.
  With a backlog of ten it threw the front toast ~817px up, past the top of the window and out from
  under the pointer, which collapses the stack, puts the toast back under the pointer and re-expands
  it: the up-down-up-down jitter, at hover speed. Toasts are now raised one macrotask apart, which
  is enough for each measurement to land before the next card mounts.
- **A backlog of resets is one toast, not ten.** Above three at once (the window was closed while
  several accounts rolled over) they collapse into a single "N quota windows reset" card whose
  action acknowledges the batch. Ten 20-second cards timed out before they could be read, and the
  stack's expanded height is the sum of all of them, so a hover unfurled something taller than the
  window. Every event is still in the list the header badge counts.
- **The Instances tab stopped starting a PowerShell process every few seconds.** Listing instances
  needs each Claude process's command line, which on Windows means
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process ..."`: measured here at ~490ms, of
  which ~130ms is the shell starting and ~260ms is the WMI query. That ran per request, and the tab
  polls every 4 seconds, with the Codex table running a near-identical second query on its own 5s
  timer. So for as long as the app was open it was starting shells, forever, and every one of those
  half-seconds sat on the request path, first paint included. `GET /api/instances` went from ~490ms
  to ~5ms on the same machine and the same data.
  - The scan is now one shared snapshot. Concurrent callers join a single in-flight query instead of
    each starting a shell; a result under 3s old is reused outright; an older one is returned
    immediately while a refresh runs behind it, so the tick that pays for the scan is never the tick
    that waits for it. Nothing here holds a timer, so closing the UI stops the scanning dead.
  - Everything that ACTS on the answer still enumerates for real: launching, quitting, focusing, and
    the guard that refuses to delete a running instance. Launching and quitting also drop the
    snapshot, so the row you just clicked updates on the next poll rather than when a TTL expires.
- **The account column fills at page load instead of a second and a half later.** Every instance's
  identity was resolved over the network, one strictly after another, and on a fresh load nothing is
  resolved yet, so eleven accounts meant eleven serial round trips. The locally cached identity is
  now painted first (25ms for all eleven, against ~1.5s for the same eleven over the network) and
  the live resolve follows behind it, a few at a time, correcting anything that has changed.

### Changed

- **The Instances tab opens on the quota columns.** "How much have I got left" is the question the
  table gets opened for; PID, uptime and memory answer "is the process healthy", which is the rarer
  follow-up. The toolbar toggle still swaps back in one click. This is a genuine default change
  rather than a flipped flag: `useStorage` writes its default on first read, so every install that
  had ever rendered the tab already carried an explicit `false` on disk and changing the default
  alone would have reached nobody. The mode moved to a new key, leaving the old one as a dead
  entry, on the same reasoning as the usage filter's `scope2`.
- **Inter is served by the app, not fetched from Google.** The shared kit's base stylesheet opens
  with an `@import` of `fonts.googleapis.com`, and a remote `@import` at the head of a
  render-blocking stylesheet blocks first paint on a round trip to the internet. Free on a warm HTTP
  cache, which is why it went unnoticed, but dead time on a first run or after a cache eviction and
  an outright stall with no network, on a local desktop app that otherwise never needs to be online.
  The two Latin subsets of Inter's variable woff2 now ship under `web/public/fonts/`. Same typeface,
  no flash of fallback text, and the app renders offline.
  - The kit copy is left byte-identical (its sync tool compares and rewrites synced files as text,
    so it cannot carry font binaries without being reworked first); the remote import is stripped
    from this app's CSS at build time instead. Any sibling app can adopt the same two files and
    stylesheet block, and if they all do, that is the point to teach the kit about binaries.

- **Settings that belong to a screen now live on that screen.** Usage auto-refresh (and its
  interval) moved into the new usage flyout, and the provider switches that decide which instance
  tables are drawn moved into a **Sections** flyout beside them. Both are still in Settings; these
  are the same components rendered twice over the same state, not copies, so flipping either surface
  moves the other. A setting nobody can find is a setting nobody knows exists.

## [0.15.0] - 2026-08-05

**TL;DR**

- **Reset notifications.**
- **Usage mode**
- **A CLI instance carried across the CC Manager UI rename lost its login.**

**Everything in 0.15.0**

### Added

- **Reset notifications.** The app already kept every instance's quota percentage warm; it now
  tells you the moment a window rolls over. The detection does not poll for a percentage that
  dropped: the usage endpoint reports the reset instant *in advance*, so a rollover is a wall-clock
  comparison against a timestamp already on record, and a timer is armed for that exact instant
  rather than waiting on the next 15-minute sweep. Percentages are integers and can sit still for
  an hour, which is why a delta-based detector would be both late and ambiguous here.
  - Native OS notifications (a Windows toast under AgentHydra's own registered app identity, so it
    appears in Windows' Notifications settings like any other app; `osascript` on macOS,
    `notify-send` on Linux). These fire from the daemon, so they reach you with the app in the tray.
  - **Keep reminding me** re-raises an unacknowledged reset on an interval and makes the toast
    sticky instead of letting it fade after a few seconds. Bounded by a repeat cap and a hard
    expiry, so a forgotten toggle cannot outlive its usefulness.
  - Optional **email**, through your own SMTP server (implicit TLS or STARTTLS, AUTH LOGIN/PLAIN).
    The password is DPAPI-sealed at rest and is never returned by the settings API.
  - Pending resets survive a restart. The one notification most worth having is the one that fires
    at 3am, which is exactly when an auto-update restart is most likely to have cycled the process.
  - Settings → Notifications, with a **Send a test notification** button so the plumbing can be
    proven now rather than five hours from now.

- **Usage mode** in the Instances tab. One toolbar toggle swaps the process columns (PID, uptime,
  memory) for the quota ones across every table on the tab. Each window renders as a bar of the
  WAIT: its length is how much of the window is still to run, its colour bands that same fraction
  (green, amber, red), and the time remaining is written inside it. Length and colour are one number
  rendered twice, so a short green bar reads as "nearly back" without being decoded. The bands are
  proportional rather than absolute: on the weekly window they land where the intuitive day
  boundaries are (under a day green, one to two days amber, beyond that red), and the 5-hour session
  window gets the same scale instead of reading green throughout and carrying no signal. The burn
  percentage keeps its own column and rides under each bar as a caption. The per-model weekly
  sub-limit is not given a column of its own (it shares the weekly reset instant, so its bar would
  be a copy of the weekly one); it is still in the usage badge's breakdown.

### Changed

- The usage badge now opens its breakdown on **hover** as well as on click, and the breakdown
  carries live "resets in" countdowns alongside the raw reset times. Hovering never steals focus.
- Usage chips in the instances tables read `92%` rather than `92% wk`: the column heading already
  names the window, so the suffix was repeating it once per row. The quick-instances window keeps
  its suffix, having no headings to carry it.
- An instance's folder moved out of a permanent second line under its name and into the row's
  tooltip, halving the height of every row. The tooltip is now on every row rather than only
  running ones, since the folder is what it is mostly for.
- The Instances/Sessions tab you were last on is remembered across reloads.

### Fixed

- **A CLI instance carried across the CC Manager UI rename lost its login.** Each record stored its
  `CLAUDE_CONFIG_DIR` as an absolute path written once at creation. The rename moved the folder but
  nothing rewrote that string, so the record pointed at a directory that no longer existed: it read
  as permanently signed out, and a re-login would have written fresh credentials back under the dead
  `~/.ccmanagerui` folder. The path is now re-derived on read, persisted once at startup, and any
  credentials still sitting at the old location are carried across.
- The CLI instances heading showed a bare `(0)` when every CLI instance was linked to a desktop
  instance and therefore rendered on that account's row instead. It now reads `(0 of 1)`, so the
  shortfall explains itself even while the section is collapsed.

## [0.14.0] - 2026-08-04

**TL;DR**

- **CC Manager UI is now AgentHydra.**
- **New logo.**

**Everything in 0.14.0**

### Changed

- **CC Manager UI is now AgentHydra.** The old name described a Claude Code manager, and the app
  has read Codex and OpenCode sessions for several releases. The upgrade is designed to be
  uneventful:
  - `~/.ccmanagerui` is moved to `~/.agenthydra` the first time the new build starts, carrying the
    run queue, settings, instance labels and the accounts cache. The move only runs when the new
    directory does not exist yet, and any failure (a pre-rename daemon still holding the pointer
    file, a permission problem) falls back to reading the old directory where it stands rather than
    starting from empty state.
  - `server/data/ccmanagerui.db` is renamed to `agenthydra.db` in place, with its `-wal`/`-shm`
    sidecars, and falls back to the old filename if the file is locked.
  - Every `CCMANAGERUI_*` environment variable is still accepted as a fallback for its
    `AGENTHYDRA_*` replacement. This is load-bearing for exactly one upgrade: the last CC Manager UI
    release spawns its successor with `CCMANAGERUI_RELAUNCH=1`, and without the fallback that
    auto-update would land in the zero-daemons race the relaunch flag exists to prevent.
  - Saved UI preferences (`ccmanagerui.*` in localStorage) are copied to the `agenthydra.*`
    namespace before the app mounts, so sidebar width, provider scope, collapse state and locale
    all survive.
  - The Windows executable, tray script and icon are renamed to `AgentHydra.*`. Release archives
    keep their existing wrapper-directory layout so the updater in older builds still recognises
    them. Desktop shortcuts pointing at the old exe need re-creating once.
- **New logo.** A three-headed hydra replaces the figure mark, on a tile split between the existing
  orange and a new sage green. The app's accent colour and the rest of the theme are unchanged.

### Fixed

- Deleting a dispatch account no longer leaves CLI instances pointing at it. The association is a
  copy of the account's id and label kept in the CLI instances file rather than a database link, so
  removing the account left both behind: the instance kept showing a badge naming an account that
  was gone, and its usage check quietly failed because the id no longer resolved to anything. The
  account is now detached from every CLI instance that used it when it is deleted, and any instance
  already pointing at a missing account is shown as unassociated the next time the list loads.
- Deleting a dispatch account now also clears the rest of what was kept under its name: its last
  usage reading, its stored usage history, and its per-account auto-resume setting. Only the queue's
  reference to an account was ever cleaned up automatically, so the others accumulated with every
  account removed and could be re-applied to a new account that happened to reuse the same id.
- An instance signed into a different account kept showing the previous account's email, name and
  plan. Resolved identities were cached per instance folder and treated as final: nothing compared
  them against the account the profile was actually signed into, and nothing re-checked them once
  resolved, so the old identity survived every offline read and every poll until someone pressed
  Refresh. Identity is now checked against the instance's current login, a cached identity that
  belongs to another account is discarded rather than displayed, and a sign-in change is picked up
  on its own within seconds. A resolved identity is also re-checked periodically, so an email, name
  or plan changed at claude.ai catches up without a restart.
- An open Codex or OpenCode session showed no reply box and no reason for it. Only the `claude` CLI
  can be handed a prompt, so the composer is deliberately dropped for the other two sources, but
  nothing stood in its place and the gap read as a failed render rather than a boundary. Those
  sessions now say they are read-only here and name the tool to carry the conversation on in.

## [0.13.0] - 2026-07-30

**TL;DR**

- **Quick instance mode**

**Everything in 0.13.0**

### Added

- **Quick instance mode** opens a compact Claude/Codex instance launcher without starting the
  session scanner, database, queue, scheduler, monitor, usage refresh, settings sync, or updater.
  Launch it with `CCManagerUI.exe --instances`, `bun run instances`, the generated
  **CCManagerUI Instances** shortcut, or the shortcut action in Settings.

### Fixed

- The Sessions list no longer stalls the app on first load. Every transcript it showed was being
  read and parsed from scratch on each daemon start, all of them at once. On a store of ~1,100
  transcripts that meant a 4.6-second wait for the first list and a jump from 101 MB to 3.1 GB of
  memory. Parsed transcript metadata is now cached on disk, so a restart is warm; the list reads at
  most a dozen transcripts at a time instead of two hundred; and the daemon warms the newest ones in
  the background at startup. Same store, same list: 0.35 seconds and a bounded footprint.
- Sessions list latency no longer grows with the size of your transcript folder. Building the file
  index globs the whole store and stats every file, and that ran inside requests, so each refresh
  paid a folder-sized tax (145 ms for 1,255 transcripts, and rising). The index is now served from
  the last snapshot and re-swept in the background, which takes routine refreshes from ~150 ms to
  ~3 ms. Looking up a session that is genuinely missing still re-sweeps, at most once every two
  seconds, so a newly created transcript is still found straight away.

## [0.12.2] - 2026-07-28

**TL;DR**

- **Resuming a chat now uses the desktop instance that owns it**
- **Archived conversations are shown by default**
- **Weekly quota walls are recognized as rate limits**

**Everything in 0.12.2**

### Changed

- **Resuming a chat now uses the desktop instance that owns it.** When you resume a Claude Desktop conversation, it automatically uses the desktop instance associated with that chat instead of an ambient CLI login. The composer shows this default and lets you choose other instances or saved credentials.
- **Archived conversations shown by default.** Archived sessions are now visible in the Sessions view by default, and session source badges are easier to distinguish. The composer makes scheduling the primary Queue action.

### Fixed

- **Weekly quota walls recognized as rate limits.** Weekly Claude quota walls are now recognized from rate-limit events and human notice, so affected runs are marked as rate-limited and can be resumed after reset.
- **Option menus no longer show empty entries.** Composer and queue-builder option menus no longer render empty model, effort, or permission entries.

## [0.12.1] - 2026-07-26

**TL;DR**

- **Codex Desktop instances can now run side by side.**
- **Provider settings and manual ChatGPT handoff.**

**Everything in 0.12.1**

### Added

- **Codex Desktop instances can now run side by side.** Each managed Codex instance launches the
  desktop app with its own `CODEX_HOME` and `CODEX_ELECTRON_USER_DATA_PATH`, so work, personal, and
  client OpenAI logins have independent windows and local state. The Instances view reports which
  desktops are running and can open, focus, or quit each one; CLI launch/login remains available on
  the same row.
- **Provider settings and manual ChatGPT handoff.** Claude Desktop, Claude CLI, Codex Desktop, and
  Codex CLI surfaces can be shown independently. An opt-in composer action creates a bounded,
  secret-screened repository context attachment, copies the task prompt, and opens ChatGPT without
  automating the user's account or submission.

### Changed

- Version tags now publish their tested platform bundles automatically using the matching
  versioned changelog section. Release retries update the existing release in place instead of
  deleting it or leaving another unpublished draft.
- Windows releases now expose an icon-bearing, single-file GUI executable while retaining a
  compact ZIP for automatic updates. The web UI is embedded, so no loose `web` or `node_modules`
  folders are needed beside the executable.
- Connections settings sync now uses the multi-device-safe 1.2 engine, with atomic first-account
  seeding, conflict-safe nested patches, token-isolated caching, and a five-second final flush that
  cancels a stuck token or network request instead of delaying shutdown indefinitely.

### Fixed

- Codex sessions now match the chats shown by Codex Desktop: canonical sidebar titles come from
  `session_index.jsonl`, while subagent rollout files no longer appear as separate sessions with
  duplicated titles and forked chat history. Child-agent rollouts remain implementation details of
  their parent chat.
- Release builds now honor both spaced and `--option=value` arguments, so every platform compiler
  writes into the versioned one-executable bundle that the smoke and publication jobs validate.

## [0.11.1] - 2026-07-23

### Changed

- Completed session-sharing research and the obsolete CLI/monitor handoff were consolidated into
  the live reference and source safety comments; their standalone Markdown notes were removed.

### Fixed

- The Windows shortcut integration test now allows cold PowerShell/COM startup the same bounded
  time as the equivalent launcher test, preventing a correct run from failing at the five-second
  default by a few milliseconds.

## [0.11.0] - 2026-07-23

**TL;DR**

- **Claude, Codex, and OpenCode conversations now share one Sessions view.**
- **Codex CLI instances can be managed alongside Claude instances.**
- **Provider browsing cannot leak into Claude execution.**
- **OpenCode full-body search now filters and extracts text inside SQLite.**
- **Development now uses Bun's native parallel workspace runner.**
- **Manually added dispatch credentials remain portable SQLite values.**

**Everything in 0.11.0**

### Added

- **Claude, Codex, and OpenCode conversations now share one Sessions view.** Every row is
  source-tagged and the list, full-body search, transcript tail, done marks, REST API, and MCP
  session tools all understand provider identity. Codex reads active and archived rollout JSONL;
  OpenCode CLI and Desktop are both covered through the SQLite store they share. Injected Codex
  runtime blocks and provider reasoning records stay out of the human transcript.
- **Codex CLI instances can be managed alongside Claude instances.** Create an isolated
  `CODEX_HOME`, open `codex login` for the user, launch it in a terminal, rename it, or delete it
  with exact-name confirmation. The REST API and MCP expose the same lifecycle.

### Changed

- **Provider browsing cannot leak into Claude execution.** Queue/session composers, rate-limit
  discovery, and Desktop-instance filtering remain explicitly Claude-only, while Codex and
  OpenCode are read-only conversation sources. OpenCode's database is never offered as a raw
  transcript download.
- **OpenCode full-body search now filters and extracts text inside SQLite.** Large tool payloads
  are no longer loaded and parsed in JavaScript; against the 260 MB local store this reduced the
  measured search allocation from roughly 49 MiB to 5 MiB.
- **Development now uses Bun's native parallel workspace runner.** Removing `concurrently`
  eliminates a redundant dependency and its shell-command dependency chain. Biome, Hono, Vue,
  Tailwind, Lucide, and other compatible dependencies move to their current non-breaking releases.
- **Manually added dispatch credentials remain portable SQLite values.** The app briefly sealed
  this one column with Windows DPAPI during the pre-release hardening pass, but that added
  machine/user coupling without changing the local database threat model enough to justify it.
  A compatibility migration converts any such rows back when the same Windows user can decrypt
  them; the per-user state directory and database still receive restrictive filesystem modes.
- The completed Codex/ChatGPT/OpenCode research note and the original merge plan were removed after
  their work was implemented and verified.

### Fixed

- Session metadata caching now replaces an active transcript's previous parse instead of retaining
  one cache entry for every appended turn.
- Scheduler and monitor numeric settings are finite and bounded, and changing the scheduler poll
  interval now updates the live timer immediately rather than waiting for a restart.
- Filesystem containment uses resolved path components instead of string prefixes, preventing a
  sibling such as `instances-elsewhere` from being treated as a child of `instances`.
- Queue writes reject malformed statuses, booleans, positions, account references, and launch
  options before they can create invalid persisted state or reach a terminal command.
- A selected dispatch account that cannot be read now fails the run instead of silently falling
  back to the ambient login.
- Child-process tests use the exact Bun executable running the suite, avoiding Windows `bun.cmd`
  quote loss in updater fixtures.

### Security

- The passwordless daemon now refuses every non-loopback bind host, and OAuth callback origins are
  restricted to the same loopback set. API bodies are capped at 2 MiB.
- User-supplied session-search regular expressions are length-bounded and structurally checked
  before execution, preventing synchronous catastrophic backtracking from bypassing the search
  deadline.
- Terminal launch model and effort values are allowlisted before crossing the shell boundary.
- GitHub Actions defaults to read-only repository contents; only the release job receives write
  access.

## [0.10.0] - 2026-07-23

**TL;DR**

- **A session's file location can be copied as text.**
- **Settings can shut down the complete app.**
- **Codex, ChatGPT and OpenCode support has a scoping document.**
- **README images now auto-regenerate and match the interface.**
- **The shared tray launcher can forward dropped files and folders.**
- **Settings puts everyday controls up front.**
- **Version number shows update status and control.**
- **Generic Anthropic tiers are treated as Free.**

**Everything in 0.10.0**

### Added

- **A session's original file location can be copied as text.** The transcript header and the
  session row's right-click menu now include **Copy the session file location to the clipboard**.
  It resolves the original file server-side, so the copied value is the exact absolute `.jsonl`
  path rather than a path reconstructed from the session id.
- **Settings can shut down the complete app.** A two-click power control beside the Settings close
  button exits the daemon and signals the tray host to quit too. Previously, stopping the daemon
  from the web UI left the tray watchdog running, so it could immediately start the daemon again.
- **Codex, ChatGPT and OpenCode support has a concrete scoping document.** The new research note
  records the session-store formats found on this machine, the Claude-specific seams in the current
  architecture, the feasibility of Codex transcript support, and the remaining OpenCode storage
  blocker so future implementation can start from verified evidence.
- **`bun run screenshots` regenerates the README images.** They used to be taken by hand against a
  throwaway daemon, which is why they sat two releases out of date showing a theme the app no longer
  had. The command starts its own web server on a private port, drives headless Chrome, and writes
  one PNG per view at a viewport sized to that view's shell. Since the images are public, it does
  not point a daemon at a synthetic home directory; it replaces `fetch` before the SPA boots so every
  `/api/` response is invented and no daemon runs at all. A request that finds no fixture is
  recorded and **fails the run**, so a fixture gap cannot quietly put live data into a committed
  image, and each shot carries a predicate that must hold before the shutter fires, so a stale
  fixture fails loudly instead of producing a screenshot of empty loading skeletons.
- **The shared tray launcher can forward dropped files and folders.** Paths dropped onto a shortcut
  are passed to adapters through an opt-in environment variable, without changing ordinary launches
  or breaking apps whose adapters do not consume drops.

### Changed

- **Settings puts the everyday controls up front.** Theme selection moves into the panel header,
  beside the new shutdown control. Tooltip visibility and the transcript-editor override move under
  an Appearance **Advanced** disclosure, leaving portable mode, tray visibility and instance-table
  visibility as the immediately visible choices.
- **The version number is now the update status and control.** It is green when current, amber when
  an update can be applied, and red when checking is blocked or no update source exists. Hovering
  explains the state; clicking checks again or applies an available update. This replaces the
  separate status rows and update buttons.
- **Generic Anthropic tiers are treated as Free.** `default_claude_ai` is the active free/default
  tier even when historical `has_claude_max` or `has_claude_pro` flags remain true after a paid plan
  expires. The Instances Plan column now trusts a specific live tier first, treats a generic tier as
  Free, and uses the historical plan flags only when no tier is available.
- **The README screenshots now match the current interface.** Sessions, Instances and Queue were
  recaptured against synthetic data on the Claude-aligned theme; their captions now include the
  Plan column and the finished-run state actually shown.

## [0.9.0] - 2026-07-21

**TL;DR**

- **The interface follows Claude's own surfaces.**
- **The accent is no longer used as a background wash.**
- **Text fields paint their own surface.**

**Everything in 0.9.0**

### Changed

- **The interface follows Claude's own surfaces.** The window used to be a single near-black sheet:
  every region painted the same token and leaned on hairline borders for structure, so there was
  effectively one shade on screen. There are now three grounds, using Claude's values directly: the
  top bar and session list as the darkest chrome, the working area a step above it, and cards,
  popovers and table headers raised above that. The accent moves from magenta to Claude's dusty rose.
  The greys are deliberately neutral; an earlier revision of this work derived them and landed a
  visible brown cast on every surface instead.
- **The accent is no longer used as a background wash.** The selected session row and your own chat
  bubbles were tinted with the accent at 10–15%, which composites over a dark ground into a muddy
  maroon rather than reading as a highlight. Both are the neutral raised grey now, and the accent is
  kept for things that are actually accents (Send, Queue, checked states).
- **Text fields paint their own surface.** The kit draws them at 30% alpha, so the token never
  reached its real value: the search and composer boxes came out darker than intended and had no
  visible edge, and the composer additionally drew a filled field inside its own filled box. Text
  fields now paint the surface outright and carry a real outline, while outline buttons and badges
  keep the translucent fill that suits them.

### Fixed

- The release workflow no longer trips GitHub's Node 20 deprecation warning: `upload-artifact`,
  `download-artifact` and `setup-qemu-action` move to their current majors.

## [0.8.0] - 2026-07-21

**TL;DR**

- **The Instances table has a Plan column.**
- **Usage refreshes on load.**
- **The account cell shows a name, not an address.**
- **The README now shows the app.**
- **0.5.0 has its own section again.**

**Everything in 0.8.0**

### Added

- **The Instances table has a Plan column.** The account type (Free, Pro, Max, Max 20×, …) now has
  its own sortable column to the right of Usage, instead of being tucked on the end of the account
  cell. The value is worked out server-side from two signals, because neither is reliable alone: an
  account's rate-limit tier is sometimes a generic passthrough even for a paid plan (a real Max
  account can arrive labelled `default_claude_ai`), so the normalized plan is used as the fallback
  and a raw internal string is never shown; the column reads as a bare dash only when the plan
  genuinely can't be determined.

### Changed

- **Usage refreshes on load.** Opening the Instances view now re-checks every desktop and CLI
  instance's usage right away, instead of showing the last cached numbers until you pressed "Refresh
  all usage". Reading quota does not consume any, so this costs nothing.
- **The account cell shows a name, not an address.** It used to print the full email (and the tier);
  it now shows the account's short name, reveals the email on hover, and hands the tier to the new
  Plan column.
- **The README now shows the app.** It had no screenshots at all, so the only way to find out what
  the thing looked like was to install it. There are now three, one per view, captured from a
  throwaway daemon pointed at a synthetic home directory so no real session titles, account
  addresses or filesystem paths ship in a public image. The surrounding copy is organised around
  those views rather than around the architecture.
- Biome no longer walks `.claude/`, which holds generated local artifacts, the same exclusion
  `.arkitect/reports` already had. A stale codemap stamp file could fail `bun run lint` locally
  while CI, which checks out fresh, stayed green.
- **0.5.0 has its own section again.** Its entries had been written into 0.6.0's, so the changelog
  described two releases as one and no `[0.5.0]` heading existed. Each entry is now filed under the
  tag that actually shipped it, checked against the commit that introduced the code rather than
  against where the prose sat. Wording is unchanged; two changes that had never been recorded at all
  (the scheduler status chip becoming a link, and the vendored-library export-drift guard) are now
  listed.

## [0.7.0] - 2026-07-18

**TL;DR**

- **Session list now filters by time window (last 24h, 7d, 30d, all).**
- **Finished runs can be cleared from the queue.**
- **Scheduler indicators are now clickable and accessible.**
- **Instances and CLI sections are collapsible.**
- **Queue scheduling uses the same date picker as the composer.**
- **Session list shows actual conversations, not quota checks and warnings.**
- **Auto-resume monitor and UI layout fixed.**
- **Editor settings now hide complexity until needed.**

**Everything in 0.7.0**

### Added

- **The session list now has a time window, set to the last 24 hours.** This list answers "what am
  I working on", and a transcript store that has been filling up for months answers that question
  worse the further back it reaches. The `...` menu gains a **Time period** filter (24 hours, 7
  days, 30 days, all time). Like the instance and archived filters, it is applied before the
  newest-N cap rather than after, so widening the window genuinely reaches further back instead of
  reshuffling the same rows. If the list comes up empty because of the window, it says so and
  offers a one-click switch to all time, rather than looking broken.
- **Finished runs can be cleared out of the queue.** The queue accumulated every completed,
  failed and cancelled run forever, and the only way to get rid of them was to delete each card by
  hand. The finished-runs disclosure now carries a Clear button, with a two-click confirm (the
  same pattern Settings uses for Disconnect) since it is a bulk delete.
- **The scheduler indicators are now the way to reach the scheduler.** The on/off indicator in the
  queue drawer was the one place you would notice the scheduler was off, and it was not clickable.
  Both it and the header chip now open Settings at the scheduler section, and the section pulses
  briefly on arrival, because a scroll that lands mid-page on a column of near-identical cards
  otherwise leaves you guessing which one you were sent to.
- **Instances and CLI instances are collapsible.** Plenty of people use only the desktop app or
  only the CLI, and had to keep scrolling past the other table. Each heading is now a toggle, and
  the choice is remembered.
- **Queueing a run for later uses the same picker as the chat composer.** "Run at" in the queue
  builder was a bare date-and-time box, so saying "in a few hours" meant working out and typing a
  full wall-clock date. It now opens the composer's picker (in 5 hours, tomorrow at your configured
  time, hour and 10-minute steppers, or an exact date), and the two surfaces share one component
  instead of two copies of the same idea. It has also moved out of Advanced options and up beside
  Account, for the same reason Account sits there: when a run happens is a decision people make up
  front, not a tuning knob.

### Changed

- **The instance editor applies as you type.** It used to show a miniature preview of the row
  inside the dialog, which is a worse answer to "what will this look like" than the real row
  sitting right behind the dialog. Name, icon and colour now persist as you change them and the
  table updates live; the preview and its explanatory paragraph are gone, and the button says Done
  rather than Save, because there is nothing left for it to save.
- **The transcript editor setting hides its input until you want it.** Auto-detect already picks
  the right editor for anyone with VS Code, Cursor, Notepad++ or Sublime installed, so the setting
  showed an empty box asking for an absolute path to solve a problem most people did not have. The
  row now states which editor will actually open a transcript; the path field, a Custom badge and a
  "back to auto-detect" action appear only if you go looking.
- **The two create buttons are icons until you hover them.** "Create instance" in both tables now
  shows a plus and expands to its label on hover or focus, matching the queue drawer's New run
  button, so one long label no longer sets the width of a toolbar of icons.
- **Settings no longer has an Accounts section.** It only ever listed leftover manually pasted
  credentials, which is nobody's normal path since accounts arrived by signing an instance in, so
  in practice it rendered as an empty box telling you to go to the Instances tab. A section whose
  content is a redirect is not a setting. Accounts are still managed on the Instances tab, and the
  per-account auto-resume overrides still list them where they mean something.

### Fixed

- **Most sessions were named after a warning notice instead of their contents.** The list showed
  the same string over and over: "&lt;local-command-caveat&gt;Caveat: The messages below were
  generated by the user while running local commands. DO NOT respond...". On this machine that was
  103 of the newest 200 sessions. A session's title falls back to its first user message, and
  nothing checked whether that message was the CLI talking to itself. Claude Code writes that
  caveat as an ordinary user turn flagged `isMeta`, and the code that knows how to drop such turns
  was already there, applied to the transcript preview but not to the title. The title now goes
  through the same filter. A session whose real prompt arrives wrapped in a tag, such as a
  scheduled task, is unwrapped to its name rather than dropped.
- **The list was full of sessions that were never conversations.** Checking your remaining quota
  sometimes has to launch the real `claude` binary to ask, and that launch opens a session and
  writes a transcript: roughly 3 KB holding a caveat, a `/usage` command line and nothing else. On
  this machine 127 of the newest 300 sessions were these. Three fixes, because one was not enough:
  transcripts with no substantive turn are no longer listed at all; the quota probe now runs in a
  directory of its own so its transcripts never land among real work; and it deletes them after
  itself. Sessions with real content are unaffected, whatever their size.
- **The auto-resume monitor listed work that was long finished.** Rows were written when a resume
  was scheduled and then never revisited, so a resume that had completed, been cancelled, or whose
  queue entry had since been deleted still reported "Scheduled, resumes ~09:14" indefinitely, and
  the Done state the interface could display was one the daemon had no way to reach. Rows are now
  reconciled against what actually happened to the resume, and the list shows only what still needs
  something to happen. A failed resume is kept and asks for attention, rather than being quietly
  filed away. Sessions you have archived are also excluded, and auto-resume no longer picks them
  up at all: archiving is you saying you are finished with it.
- **Advanced options in the queue builder was quietly broken.** Each of the Model, Effort and
  Permission dropdowns offered a "Default" entry with an empty value, which throws in the
  underlying component, and the failure took out everything rendered after it in that section. It
  went unnoticed because the visible casualties were the very dropdowns causing it, so the section
  looked sparse rather than broken. The account picker beside them had hit this same trap earlier
  and been fixed; the other three had been missed.
- **Settings had one seam with no gap, and one list with no separators.** The auto-resume monitor
  sat flush against the scheduler card above it, because a wrapper element added to support a deep
  link broke the page's spacing chain. The per-account rows inside the monitor lost their dividing
  lines for a closely related reason. Both are fixed, and the rest of the app was swept for the
  same pattern.
- **A single instance could occupy several rows in the usage cache.** The cache keyed each entry
  by the instance's directory as spelled by the caller, and on Windows one folder can be spelled
  several ways, so `C:\Users\...`, `c:\users\...` and `C:/Users/...` each opened their own entry. A
  reading stored under one spelling was invisible to a lookup using another, so a warm cache still
  missed and re-ran the check. Keys are normalized now.

## [0.6.0] - 2026-07-17

**TL;DR**

- **"Filter by instance" opened nothing and froze the whole app.**
- **"Open the session file" asked which app to use instead of just opening.**
- **Right-click a session.**
- **Mark a session as done.**
- **Archived sessions are recognised, and hidden by default.**
- **One list-options menu.**
- **A CI guard against vendored-library export drift**

**Everything in 0.6.0**

### Fixed

- **"Filter by instance" opened nothing and froze the whole app.** Clicking it appeared to do
  nothing, and then no other control responded until you pressed Escape. Both halves were the same
  bug. reka positions a popup by walking the Vue component tree for the nearest popper root, and the
  menu was wrapped AROUND its own tooltip, so the tooltip claimed the anchor and the menu's popper
  never got one. The menu really did open; it just rendered at floating-ui's unpositioned
  `translate(0, -200%)`, which is off-screen above the window. Being a modal menu, it also set
  `pointer-events: none` on the page while it was "open", which is what made everything else stop
  responding. The popper root now lives inside the tooltip, so each anchors to its own element. The
  advanced-search popover next to it was broken in exactly the same way and had simply been failing
  in silence, because a popover is not modal and so froze nothing; it is fixed too. A repo guardrail
  now fails the build on that nesting, and it is tested against both the broken and the fixed shape,
  because the previous guard for this encoded the wrong cause and crashed on import without ever
  running.
- **"Open the session file" asked which app to use instead of just opening.** `.jsonl` has no file
  association on a stock Windows machine, so handing the path to the OS default handler made Windows
  pop its "How do you want to open this file?" picker. The app now names an editor itself: it uses
  the first one it finds (VS Code, Cursor, Notepad++, Sublime) and falls back to Notepad, which
  always exists, so the picker can never appear. macOS opens the default text editor. A new
  **Transcript editor** setting overrides the choice, and a path that points at nothing falls back to
  auto-detect rather than leaving the button silently dead.

### Added

- **Right-click a session.** The sidebar list now has its own context menu: mark as done, open the
  transcript, open or copy the session file, and copy the title, folder or id. Right-clicking acts
  on the row under the pointer without selecting it, so it never loads a transcript you did not ask
  for.
- **Mark a session as done.** A way to say "I have dealt with this" without losing it: the row keeps
  its place in the list and just stops competing for attention (a check, a struck-through title, and
  dimmed). Marks are stored by the app itself rather than in the browser, so they survive a cleared
  browser store. Deliberately not a filter. "Clear all done marks" appears in the list menu once
  anything is marked.
- **Archived sessions are recognised, and hidden by default.** The app now reads Claude's own archive
  flag. Archived is the large majority of a real transcript store, so including them buries the live
  work; that same ratio is why the control is three-way (Hidden, Shown, Only archived) rather than a
  checkbox, since finding one archived session in a mixed list is hopeless. The scope is applied
  before the newest-N cap, so hiding archived returns a full list of live sessions instead of the
  handful that survived the cap.
- **One list-options menu.** The sessions toolbar had grown a row of icon buttons, and each new
  toggle squeezed the search field. Refresh, multi-select, the instance filter and the archive scope
  now live in a single "⋯" menu, which lights up whenever something is narrowing the list, so a
  filter set once and forgotten can no longer read as an empty list with no visible cause.
- **A CI guard against vendored-library export drift**, so the break this release had to
  fix cannot recur silently.

## [0.5.0] - 2026-07-16

**TL;DR**

- **Console windows no longer flash during ordinary operations.**
- **Runs no longer get stuck after crashes or kill unrelated programs.**
- **Transient server overloads are now retried instead of failing.**
- **Composer no longer falsely claims session is busy.**
- **Auto-resume now finds quota walls in existing transcripts.**
- **Transcripts download with session titles, not UUIDs.**
- **Session file can be copied to clipboard as a real file.**
- **Scheduler UI improved with time steppers and link controls.**

**Everything in 0.5.0**

### Fixed

- **Stray console windows could flash on an ordinary click.** Spawning a console program on Windows
  allocates a console unless the spawn says otherwise, and nothing here said otherwise. It stayed
  invisible only because the tray happens to launch the daemon with a window-less console that child
  processes inherit; started any other way (from a terminal, from Explorer, as the portable exe) the
  same clicks flashed a real window. Every such spawn now states the intent explicitly, so the
  outcome no longer depends on how the app was started. The worst of them was the periodic usage
  check: it runs `claude` on a timer, and where the packaged `claude.exe` is missing that resolves to
  a `.cmd` batch file, which runs through `cmd.exe`. On those machines it was a CMD window blinking
  on a schedule with no click to blame it on. A guardrail now enforces both directions of the rule,
  since hiding a *graphical* program instead hides the window it was supposed to open.
- **A run could be stuck "running" forever after a crash, and cancelling it could kill an unrelated
  program.** When CC Manager UI restarts, it re-adopts runs that outlived it, and it is careful not
  to trust a dead runner's recorded process id (Windows recycles those numbers, so it may now belong
  to something else entirely). That care never actually happened: the liveness probe searched running
  processes for the run's spec file *by command line*, and the search itself carried that text in its
  own command line, so it always found itself and always answered "still alive". Every Windows
  reattach therefore trusted a stale id. If that id had been recycled by a live program, the run
  waited on it forever (a session stuck "busy" with nothing running), and pressing Cancel would have
  killed that innocent program. The probe now excludes itself, and the tail loop no longer re-adopts
  the id the reattach deliberately refused; it fails the run cleanly instead, with the work it did
  manage still on disk.
- **A 529 overload was treated as your rate limit, so the run died instead of retrying.** `529
  Overloaded` means Anthropic's servers are saturated and it clears in seconds; a session limit
  means your own 5-hour allowance is spent and only time fixes it. Both wear the word "limit", and
  `dispatch.ts` matched them with ONE pattern list, so a run killed by a few-second server hiccup
  was filed `rate_limited` and parked against a reset that had nothing to do with it, while the same
  message sent from the desktop app (which just retries) went straight through. They are now told
  apart (`rate-limit-signal.ts`), and a transient overload is **retried automatically**: three
  tries over ~35s, backing off, before it gives up as its own new `overloaded` status, which is
  neither `failed` (nothing is wrong with the run) nor `rate_limited` (your quota is fine). The
  retry only fires when the run produced no output first, so it can never silently re-do work you
  already paid for; it is DB-backed, so a daemon restart mid-backoff resumes rather than forgets;
  and it is deliberately not behind the scheduler or monitor switches, which are off by default and
  govern hours-scale autonomy, this just finishes the run you started ten seconds ago.
  Ambiguous text still classifies as a quota wall, the conservative default. A migration relabels
  rows already mis-filed by the old detector. The auto-resume monitor now only ever sees a genuine
  quota stop, so it can no longer park a 529 against a five-hour reset that was never coming.
- **The composer claimed "this session is busy" the moment you hit send, with nothing running.**
  `submit()` awaits a queue refresh, and the server doesn't answer until the run is already marked
  `running`, so sending a message flipped the banner on within the very same click, and it then
  announced that the message "will queue and start on its own" about one that had just started
  running immediately. The hint now only shows while there is actually a draft it could apply to,
  which is the only time it says anything useful.
- **The auto-resume monitor was blind to every session it hadn't launched itself.** It only ever
  looked at `queue_items` rows with status `rate_limited`, and the only thing that can set that
  status is a run the daemon spawned and tailed, so a session you started yourself (a bare `claude`
  in a terminal, or the desktop app) that died on a 5-hour limit had a transcript on disk, no queue
  row, and no path to the resume list at all. The list said "Nothing to resume right now" while real
  sessions sat at the wall, and hand-queueing them was the only recourse. The monitor now also
  *finds* stops on disk (`rate-limit-discovery.ts`): it checks transcripts touched in the last 12
  hours for the CLI's own limit notice sitting at the tail with nothing after it, which is exactly
  what "still stopped" looks like. Found stops go through the same rails as any other, the weekly
  usage gate, the per-session attempt cap, the resume buffer, the idempotency check, and carry a
  **Found** badge so a session the app went looking for never reads as one you queued. Detection
  reuses `dispatch.ts`'s existing `isApiErrorEvent` gate unchanged, so the 2026-07-15 false-positive
  class (a run that merely *mentions* "quota" or "529") cannot come back at machine scale. Still
  behind the monitor's off-by-default switch.
- **A downloaded transcript was named after the session's UUID, not the session.** `Save a copy` now
  writes `<session title>.jsonl`, falling back to the id only when a title has nothing
  filesystem-safe left in it. One shared `safeTranscriptFilename` (new
  `@ccmanagerui/server/filenames` export) backs both the download link and the server's
  `Content-Disposition`, because the browser honours the link's name only same-origin and the header
  only cross-origin, so fixing one alone would have left the other broken. It strips the characters
  Windows rejects, refuses the reserved device names (`CON`, `COM1`…), trims the trailing dots
  Windows drops silently, and sends the header as RFC 5987 `filename*` so an emoji or non-Latin
  title names the file properly instead of throwing on an invalid header value.

### Added

- **CI actually typechecks now, and it covers the tests too.** The job had been named
  "lint · typecheck · build · test" since day one while never running a typecheck, and something
  had already slipped through: the portable-window exports (`appWindowPlacementKey`,
  `hasRememberedBounds`, `quoteWinArg`) went undeclared for two commits, which nothing noticed
  because nothing looked. `tests/` was outside every tsconfig for the same reason, so a test could
  only fail at runtime; wiring it in immediately caught a real error in a new fixture. All 34 test
  files across the three test directories are covered now.
- **Copy the session file to the clipboard.** A new button beside "save a copy" puts the `.jsonl`
  FILE on the clipboard, not its text, so Ctrl+V into a folder, a chat or an email pastes the
  actual file, named after the session rather than its uuid. A web page cannot do this at all (no
  clipboard type maps to a native file-drop, by design), so the daemon does it; Windows and macOS
  only, since Linux has no cross-desktop convention for it.
- **A 10-minute stepper in the composer's "queue for later".** The hours stepper now sits next to a
  minutes one that steps in 10s, and a single button queues the combined delay ("In 1h 30m"). With
  both, the fixed **In 15 min** and **In 1 hour** presets were redundant, 1h is the stepper's
  default and anything shorter is a couple of taps, so they are gone; **In 5 hours** and
  **Tomorrow** remain.
- **The scheduler status chip in the header is now a link** to the setting it reports on.

### Changed

- **Pink means "you can click this now".** In the composer's "queue for later" popover, **Queue
  for then** was pink even before a date was picked, when it did nothing. It is now grey until
  you pick one. The hours/minutes button beside it had the same flaw at 0h 0m and follows the
  same rule.

## [0.4.0] - 2026-07-16

**TL;DR**

- **The portable window opens at a usable size instead of filling the screen.**
- **A launch onto an already-running portable profile now sizes correctly too.**
- **The loopback guard is now one shared, audited implementation.**
- **The release build was broken while the typecheck passed.**

**Everything in 0.4.0**

### Added

- **The portable window opens at a usable size instead of filling the screen.** A window the
  dedicated Chromium profile had never seen opened at roughly the whole work area, about
  1905x2092 on a 4K display. Both open paths, the daemon and the tray, now ask for 1060x800 on a
  first run and yield to the profile's saved placement ever after, so a size you picked yourself
  always wins. The width is measured rather than guessed: the binding constraint is not the
  1000px shell but the sessions sidebar, which rail-collapses below a 1024px viewport, so
  1024 plus about 16px of window frame is the floor and 1060 clears it with slack.
- **A launch onto an already-running portable profile now sizes correctly too.** Chromium ignores
  both `--window-size` and the saved placement when an instance is already running on that
  profile: the forwarded `--app` window simply inherits the running window's geometry. The daemon
  cannot fix that from outside, so it now tags the window's URL with the size it should have
  (`POST /api/portable-window`) and the page corrects itself once at startup, before first paint.
  Gated to real `--app` windows and a no-op on an un-hinted URL, so an ordinary browser tab is
  untouched. A maximized window deliberately sends no hint.

### Changed

- **The loopback guard is now one shared, audited implementation.** The guard that stops a
  malicious web page from driving the local API was the app's own copy. It now consumes the same
  primitive as the other LunarWerx daemons, so a security-critical decision lives in one reviewed
  place instead of four drifting ones. Behaviour is unchanged for real clients. The shared version
  additionally allows a request carrying no `Host` header, which a browser always sends, so this
  only affects non-browser tools.

### Fixed

- **The release build was broken while the typecheck passed.** The vendored copy of the
  portable-window helper was a stale snapshot missing an export that the code importing it already
  declared, so `tsc` was satisfied and `bun build --compile` failed with "No matching export". The
  vendored file is back in sync, and the window-size applier now has behavioural test coverage
  rather than type-only coverage.

## [0.3.0] - 2026-07-16

**TL;DR**

- **Quota percentages quantified into actionable forecasts.**
- **Usage checks work offline, 25-50x faster, with advice verdicts.**
- **CLI instances managed, linked to desktop, and fully integrated.**
- **Background usage auto-refresh keeps numbers current by default.**
- **Auto-resume monitor catches rate limits from any session source.**
- **Run builder focuses on essentials; settings and queue redesigned.**
- **Console windows, message handling, and exit codes fixed.**
- **Rate limit detection improved to avoid false positives.**

**Everything in 0.3.0**

### Added

- **A quota percentage is now quantified into something you can plan with.** "98% used" is not a
  decision: 98% with a reset in 20 minutes is fine, while 98% with a reset in four days at 1%/hour
  means being cut off mid-task in about two hours. Same number, opposite action. Anthropic publishes
  no quota size (`limit_dollars` / `used_dollars` / `remaining_dollars` are all null on a
  subscription, and there are no token counts anywhere in the response), so the numbers are derived
  instead. `server/src/usage-history.ts` keeps the readings the background sweep already takes and
  differentiates them into a burn rate, an hours-of-headroom figure, and `exhaustsBeforeReset`, the
  one field that actually decides anything. `server/src/usage-tokens.ts` counts what was really spent
  from the Claude Code transcripts (which do carry exact per-turn token counts and the model), and
  `server/src/usage-budget.ts` divides one by the other to MEASURE the size of one percent in tokens,
  reported as "~N more assistant turns" because an agent can reason about turns but cannot predict its
  own raw token totals. New `usage_budget` MCP tool and `GET /api/usage/budget`.
- **The usage MCP tools now work with the app closed.** `check_my_usage`, `list_usage` and
  `usage_budget` need nothing the daemon uniquely owns (the OAuth tokens are files on disk, the quota
  endpoint is a plain HTTPS GET, the transcripts are local JSONL), so when the daemon is not running
  they execute in-process instead of failing. The queue and dispatch tools deliberately do not get
  this: they mutate shared sqlite state and supervise real processes, where a second uncoordinated
  executor would be a correctness bug, so they still fail loudly and say why.
- **Usage checks now hit the quota endpoint directly instead of spawning `claude`.** The CLI's own
  `/usage` screen is just a GET against `https://api.anthropic.com/api/oauth/usage`, Bearer-authenticated
  with an OAuth access token; calling it ourselves (`server/src/usage-api.ts`) skips booting the
  ~250 MB Bun-compiled `claude` binary entirely. Measured on one machine: the old spawn path took
  9,353 / 9,262 / 9,218ms per check, the direct GET took 372 / 424 / 169ms, roughly 25 to 50x faster.
  It is also richer than the text screen: `resets_at` is a real ISO-8601 timestamp (the text screen
  prints a yearless human string like "Jul 19, 3:59am"), `severity` (normal/warning/critical) is
  computed server-side instead of guessed from a threshold, and a per-model weekly sub-limit carries
  its own name via `scope.model.display_name`. Reading usage costs no quota: it is a read, not an
  inference call. The `claude -p "/usage"` spawn remains as a fallback for the cases the direct path
  can't serve: no OAuth token in hand, an account configured with an API key instead (the endpoint is
  OAuth-only), or the server rejecting the token with 401 (expired); the daemon deliberately does not
  refresh the token itself, since rotating the user's refresh token could break their real login, so an
  expired token falls back to the CLI's own refresh instead.
- **CLI instances can be linked to a desktop instance.** `CliInstance.associatedDesktopDir` records
  that a CLI instance and a desktop instance are the same Anthropic account under two independent
  logins, so each can serve as the other's usage-check fallback when one token is expired or missing:
  a desktop instance's chain is its own token, then a linked CLI instance's login, then a dispatch
  account matching the email; a CLI instance's chain is its own login, then an associated dispatch
  account, then a linked desktop instance's token. New `link_cli_instance_to_desktop` MCP tool.
- **Background auto-refresh of usage, on by default.** A staggered sweep keeps every instance's usage
  number warm without a manual refresh, skipping any instance with no usable credential up front. Each
  check costs about 300ms and no quota, so polling on a loop is no longer the liability it was when it
  meant spawning `claude`. Toggle and interval live in Settings → General, alongside separate toggles to
  show or hide the desktop and CLI instances tables.
- **Usage responses carry an `advice` verdict.** Every usage check (`check_usage`, `check_my_usage`,
  `list_usage`, the UI's usage cell) now includes `{ severity, bindingPct, shouldOffload, safeToFanOut,
  advice }` alongside the raw percentages, so a caller does not have to re-derive "is this bad" from
  thresholds itself. `shouldOffload: true` means the caller is close to being cut off mid-task.
- **`check_my_usage` now works from a normal Claude Code session, not only a CLI instance.** It falls
  back to the default [`~/.claude`](docs/CLAUDE-CONFIG-LAYOUT.md) login when `CLAUDE_CODE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` is unset,
  which previously made the self-check error out for the everyday case of the session the user is
  actually talking to. New `list_usage` MCP tool surveys every managed instance (desktop and CLI) at
  once, each with its own `advice` verdict, for picking an account with headroom before routing heavy
  work.
- **A CLI login is now a usable usage-check source in its own right.** `<CLAUDE_CONFIG_DIR>/.credentials.json`
  is plain JSON (`claudeAiOauth.accessToken` plus `.scopes`, no DPAPI/safeStorage layer), so a CLI
  instance that has run `/login` gives a usage-capable token directly, independent of any desktop
  instance.
- **CLI instances.** A CLI instance is a `CLAUDE_CONFIG_DIR` associated with an account and logged in
  once, the command-line counterpart to a desktop instance (which isolates via `--user-data-dir`).
  The Instances view now manages them alongside desktop instances: create one (the app makes its
  config dir), open a terminal to use it, a one-click "Log in" helper that opens a terminal for you to
  run `/login` (the app never performs the login itself), associate it with a dispatch account, rename,
  and a guarded delete. Persisted as plain JSON under `~/.ccmanagerui`, never a token.
- **Usage-check subsystem.** Read an account's remaining Claude subscription quota (session 5-hour %,
  weekly all-models %, and per-model weekly %) by running `claude -p "/usage"` with the account's auth
  injected. A DESKTOP instance is polled using its OWN decrypted OAuth token (never persisted), so it
  works with no dispatch account and no CLI login; a registered dispatch account or a logged-in CLI
  instance also work. The desktop token cache holds two grants (a full CLI grant and a profile-only
  grant); the usage path deliberately selects the `user:inference`-scoped grant, since the profile
  grant runs `/usage` but returns no numbers. The probe also sets `CLAUDE_CODE_OAUTH_SCOPES` from
  that grant: without it `claude` quietly stops treating `/usage` as a command and prints a cost
  summary with no percentages, which only shows up when the daemon runs outside a Claude Code
  session (for example the tray, launched from Explorer). Surfaced three ways: a per-row usage cell in the
  Instances table (the binding weekly % color-coded, with a hover breakdown), a `check_usage` MCP
  tool, and a `check_my_usage` self-check any agent can call. Checks are on demand (each spawns a real
  `claude`) and cached with an age; a no-data result shows ", " with a reason rather than silently.
- **AI self-check guidance.** `docs/AI_USAGE_SELFCHECK.md` plus a README note teach agents that they
  can read their own quota and that the weekly all-models % is the binding cap to pace by.
- **Auto-resume monitor (opt-in, off by default).** A session killed mid-work by a 5-hour rate limit
  can auto-resume once the window clears, gated on the weekly cap not being maxed. Detection reuses the
  existing structured `rate_limited` run status; a resume is a normal queued `--resume` run scheduled
  for just after the reset. Safety rails: a per-session resume cap, idempotent scheduling, a global
  switch plus per-account overrides, and a status chip ("resumes ~HH:MM" / "blocked: weekly maxed" /
  "needs human"). Settings and `get_monitor` / `set_monitor` MCP tools expose it.

### Fixed

- **Quitting could kill your real Claude Desktop chat.** The External row (the regular,
  non-isolated Claude Desktop) can no longer be quit with one click: the server refuses the
  default profile dir without an explicit confirmation (`confirmExternal`, the quit-side analog
  of Delete's existing guard), and the UI routes it through a warning dialog. The "Browser
  Dance" copy now names ISOLATED instances and says outright that your regular Claude Desktop
  should stay open, the old "quit every other running instance" wording steered a user into
  closing a real conversation.
- **The MSIX warning banner could be flat wrong.** `manageable` now also accepts a LIVE running
  Claude process (carrying `--user-data-dir`) as proof of a working classic install, the
  authoritative `Get-AppxPackage` probe runs (and overrides) when filesystem leftovers from an
  uninstalled MSIX would otherwise pin the verdict forever, the classic binary resolves via the
  stable Squirrel stub first (versioned `app-<ver>` dirs are replaced on every update), and the
  banner re-verifies fresh after any successful open/create and every 60s while visible, so
  "install the classic build" actually clears it once you do.
- **A run pinned to a specific account could silently run as the wrong one.** A queued run pinned to
  an instance whose sign-in had expired, been deleted, or whose reference was malformed used to fall
  back to the ambient login without a word; auto-resuming such a run dropped the pin entirely. Both
  now fail loudly (or carry the pin forward) instead of quietly using different credentials.
- **A queued run's account wasn't shown on its card**, and editing a run whose pinned account had been
  deleted silently reverted it to ambient on save. The card now shows the instance it will run as (or
  "deleted instance"), and the editor shows a clear disabled "deleted instance" option instead of
  quietly changing the run.
- **Deleting a desktop instance could orphan its linked CLI login** into an invisible, unmanageable
  state; a failed "Sign in CLI" left a stray CLI instance behind. Both are cleaned up now.
- **A run recovered after a restart could briefly be double-dispatched**: the scheduler and
  auto-resume monitor could fire before the daemon finished re-adopting runs that survived the
  restart. They now wait for that to complete.

- **A run that merely TALKED about rate limits was marked rate-limited.** The detector matched its
  patterns against every event of a run, tool inputs and tool results included, so an agent that
  grepped for "session limit", or read a file whose line 529 scrolled past, finished as
  `rate_limited` despite exiting 0 with the job done. (Both such rows in the shipped database were
  this; `\b529\b` had matched a line number.) Only the CLI's own report counts now: a synthetic
  API-error message, an errored terminal `result`, or stderr, never model prose, tool inputs, or
  tool results. Runs already mislabeled this way are repaired on startup, along with the auto-resume
  bookkeeping that existed only to babysit them.
- **The auto-resume monitor did nothing at all unless you had added an account.** A run with no
  dispatch account, the default, since the accounts table is empty until you paste a token in, was
  parked at "needs you, no dispatch account on the run" on sight, on the grounds that its usage
  couldn't be gated and its auth couldn't be injected. Neither was true: an ambient run uses the
  login `claude` already has, which needs no injection to resume and whose quota reads straight from
  its config dir (the same read `check_my_usage` already did). Ambient runs now go through the usage
  gate like any other, so the monitor actually resumes them.
- **Sending a message opened a console window that stayed on screen for the whole run.** The detached
  runner is created through WMI, which applies default startup info, so `bun` (a console app) got a
  real, visible window; the daemon's own `windowsHide` only ever covered the short-lived PowerShell.
  Beyond the eyesore, closing that stray window killed the runner and `claude` mid-turn, and the run
  then finalized as a bare "failed, exit -1". It is created hidden now.
- **The session view showed conversation the CLI was having with itself.** Resuming a session whose
  last turn died on an API error makes `claude` append a canned "Continue from where you left off." /
  "No response requested." pair, same millisecond, no model call. Rendered as real turns they read
  as though a prompt had been sent and refused. They're filtered; the rate-limit notice, the one
  synthetic message that explains anything, still shows.
- **"exit -1" now says what it means.** It is our own code for "the process vanished before it
  finished", never something `claude` reported, and the paths that produce it recorded nothing to
  say so. They now explain themselves, and the badge reads "interrupted" instead of a number nobody
  can look up. Transcribing an event can also no longer throw and take the tail loop down with it.

### Changed

- **Finished runs fold away in the queue.** Completed, failed, canceled, and rate-limited items move
  behind a "Show N finished" disclosure instead of crowding the list, and the header counts what is
  still pending rather than the all-time total. The per-item card moved to `QueueItemCard.vue`.
- **The composer's busy warning says what will happen to your message.** It stated a rule ("a session
  with a run in progress gets its message queued instead of sent") and left you to guess whether the
  message was about to run or stuck. It now says which, start on its own when the current run
  finishes, or wait for you to press Run when the scheduler is off, and why two runs can't share a
  session.
- **Queuing a run resumes a session from a searchable list instead of a pasted UUID.** The run
  builder's "session to resume" field is now a searchable picker over the same session list the
  sidebar shows (sorted most-recently-active first), each row carrying the friendly title, its
  folder/branch/last-activity, and the opaque id tucked to the side (click it to copy). It supports
  multi-select: pick several sessions and one queued run is created per session, sharing the same
  prompt and options. A new `SessionPicker.vue` backs it.
- **The run builder leads with three fields, not thirteen.** Model, effort, permission, account,
  run-at, fork, and the resume title/folder overrides now live behind an "Advanced options"
  disclosure; the common path is just the session (or new-chat title + folder) and the prompt. The
  "New chat from scratch" toggle is hidden when editing an existing item (editing never converts a
  run's kind). Long prompts no longer push the dialog off-screen, the prompt box caps its height and
  every dialog now scrolls instead of overflowing the viewport.
- **Settings is one scrolling page.** The General / Scheduler / Accounts tabs were merged: Accounts
  is now a section rather than a tab, and Scheduler folds in with everything else. "Show desktop /
  CLI instances" moved from Usage to Appearance (it's a display choice). The auto-resume monitor's
  tuning numbers (max attempts, resume buffer) moved behind an Advanced disclosure and, along with
  the monitored-runs list and per-account overrides, collapse away entirely when the monitor is off.
  The monitor's empty state now explains that a run only appears there after it stops on a rate limit
  (an empty list doesn't mean monitoring is off). A deep link (the composer's "tomorrow" gear) now
  scrolls to the Scheduler section instead of switching a tab.
- **The queue toolbar's scheduler indicator is an icon with a hover, not a text pill**, and shows
  both on and off states at a glance. The redundant "Queue resume" button was removed, "New run"
  already opens the builder in resume mode.

## [0.2.0] - 2026-07-13

**TL;DR**

- **Instance icons, colors, and names now reflect the account, not the folder.**
- **Accounts auto-resolve without manual buttons.**
- **Quota numbers update live while you watch the table.**
- **Renaming instances is instant and works while running.**
- **Focus button leads running instance rows.**
- **Burn rate forecasting fixed to avoid false "safe" signals.**
- **Daemon rebuilds no longer serve stale code.**
- **API error handling improved.**

**Everything in 0.2.0**

### Added

- **Per-instance icon and color.** Every row in the Instances table now shows a customizable glyph
  in place of the old green status dot. An "Edit" action (in the row's ⋮ menu) lets you pick an icon
  from a curated set and a color from a fixed palette, with a live preview; a running instance keeps
  a small pulsing badge on the icon's top-right corner, and a stopped one dims. Instances you have
  not customized get a stable, distinct default derived from their folder, so the table reads at a
  glance.

### Changed

- **An instance is named after the account it is signed into, not the folder it lives in.** The
  folder name was only ever a guess at the identity, and it stops being true the moment a profile is
  signed into an account other than the one it was named after, nothing prevents that drift and
  nothing corrects it. On the machine this was built against, the folder called `claude` was signed
  into the `6claude` account and had been reading as "claude" the whole time, while two other
  instances had been hand-relabelled to their accounts precisely to paper over the same problem. So
  the resolved account's name (its profile name, else the local part of its email) is now the
  default, ahead of the folder name; an explicit label you set still wins over both, and the folder
  name remains the last resort for an instance with no resolved identity. The dir is still shown
  under each name, so two profiles on one account stay distinguishable. `SessionsView` reads the
  same shared instance list rather than fetching its own, so a session's instance chip and the
  Instances table can no longer disagree about what the same instance is called.
- **Accounts resolve themselves; the "Resolve" button is gone.** Resolving reads `config.json` and
  the token cache off disk, so a stopped instance resolves exactly as well as a running one, but
  auto-resolution was gated on `isRunning`, which meant a stopped instance sat there offering a
  button that would have worked on the first click, every time. That is a chore, not a choice. Every
  instance now resolves on its own, running or not, and an instance with no identity yet (logged
  out, offline) is retried once a minute so signing one in surfaces without a restart. The inline
  button and its ⋮ entry are both removed; the toolbar's Refresh now force-re-resolves every account
  live, which is the only case a manual action was ever good for (a stale cached identity). Resolving
  no longer marks the row busy, it changes nothing about the instance, and flagging it made the
  row's buttons flicker un-clickable whenever a background resolve was in flight.
- **The Instances table's quota numbers stay current while you watch them.** The background sweep
  refreshes the server's usage cache every 15 minutes, but the UI only ever pulled that cache once,
  on mount, so an open Instances tab kept showing its first reading and went quietly stale for as
  long as you left it open. It now pulls on the same 4-second cycle the instance list already
  refreshes on, measured firing in lockstep with it. This is a read of the server's own cache: no
  probe, no `claude`, no request to Anthropic, and no quota spent, so there was no reason to do it
  once and hope. The "Refresh all usage" tooltip no longer claims each check "spawns a real claude
  process", which stopped being true when checks became a direct ~300ms API read.
- **Fewer rules on the Instances screen.** The two tables abutted, separated only by a hairline
  sitting flush against the desktop table's last row, which read as one continuous table whose last
  rows happened to have different columns. They are now separated by space instead, and both section
  toolbars lost their bottom border, the sticky table header immediately below each one already
  draws that line, so the second rule was weight for nothing. This matches Sessions, Queue, and the
  app header, which were borderless already. The row separators stay; they are the ones doing work.
- **Renaming an instance is now instant and works while it is running.** A rename used to move the
  instance's on-disk profile folder, which Windows will not allow while Claude Desktop holds it open.
  The name is now a display label kept as UI metadata (`~/.ccmanagerui/instance-meta.json`, never a
  secret) that overlays the folder name wherever it is shown; the folder keeps its original name as
  the stable id that sessions are tagged by. The old `POST /api/instances/:dir/rename` folder-rename
  route was replaced by `POST /api/instances/:dir/meta` (display label, icon, and color in one call).
- **A running instance's row leads with Focus.** For a running instance the primary button is now
  "Focus" (bring its window to the front); "Quit" moved into the ⋮ menu, so the common action is one
  click and the destructive one is deliberate. The ⋮ menu was widened so "Create desktop shortcut"
  no longer wraps.
- **Header and panel cleanup.** Removed the redundant "New run" button from the app header (it
  already lives in the queue drawer), and dropped two divider lines (below the queue drawer's toolbar
  and below the sessions search box). The sessions list and its instance filter now show each
  instance's display label.

### Fixed

- **A burn rate of "zero" no longer means "work freely".** The reported percentage is an INTEGER, so a
  burn of 0.8%/hour does not tick the number for over an hour. The first cut of the forecast measured
  that flat stretch, concluded the burn was zero, and reported "you will never hit the cap" while
  sitting at 98% used. That is a false green light, the single most expensive way the feature can be
  wrong, since an agent keeps working and is cut off mid-task holding unsaved context. The burn rate is
  now a RANGE: a measured delta of `d` could truly be as much as `d + 1` given integer rounding, so the
  upper bound is `(d + 1) / hours`, which is always above zero. Every derived figure (`headroomHours`,
  `exhaustsAt`, `exhaustsBeforeReset`, and the token budget's denominator) is computed from that upper
  bound, making the forecast deliberately pessimistic. The asymmetry is the point: a needless warning
  costs a moment of caution, a false green light costs the whole task. The measurement floor also rose
  from a 20-minute to a 45-minute span, below which an integer percentage simply cannot resolve a slow
  burn and the answer is honestly reported as unknown rather than as zero.
- **Rebuild.bat could leave a STALE daemon serving old code while reporting success.** It found the
  daemon solely by the port recorded in `~/.<app>/runtime.json`; with that pointer missing it printed
  "App does not appear to be running", killed nothing, and relaunched the shortcut, which no-ops
  against the tray's single-instance mutex. Nothing then checked the outcome, so the build was fresh on
  disk while the process serving it was hours old (found in the wild at 10h39m). The pointer is now
  only a hint: `misc/Restart-Daemon.ps1` probes every bun/node listener's `/api/health` and stops only
  processes that identify themselves as this app (`service` === package.json `name`, the same contract
  the single-instance guard uses), which both finds an orphan the pointer forgot and cannot kill a
  sibling app. `misc/Wait-Daemon.ps1` then asserts the daemon now answering actually started AFTER the
  restart, because "the daemon is up" proves nothing when the stale one was up the whole time.
- **Mutating API routes no longer 500 on an odd request body.** A body that is valid JSON but not an
  object (a bare `null`, a number, or a string) used to crash the handler with a 500; every mutating
  route now runs the body through a shared object guard and degrades gracefully. Creating a new
  instance also starts it with a clean appearance, so reusing a name never resurrects a deleted
  instance's old label, icon, or color.

## [0.1.0] - 2026-07-13

**TL;DR**

- **MSIX detection with link to classic Claude Desktop.**
- **Portable mode and MCP stdio server.**
- **Background auto-update loop.**
- **Instance management and discovery fixed.**
- **Queue moved to a slide-in drawer.**
- **Settings reorganized into tabs.**
- **Drawers and composer UI improved.**
- **Port, refresh timing, and layout improvements.**

**Everything in 0.1.0**

### Added

- **MSIX install warning (Instances tab)**: the daemon now detects which Claude Desktop build
  is installed on Windows (`GET /api/desktop-install`, `server/src/core/desktop-install.ts`).
  Anthropic's current download page ships a ~7 MB `ClaudeSetup.exe` bootstrapper that installs
  the MSIX package under the ACL-locked `C:\Program Files\WindowsApps`; that build can't be
  launched with `--user-data-dir`, so instance create/open can't work with it. When only the
  MSIX build (or no Claude Desktop at all) is present, the Instances tab shows a warning
  banner linking the classic ~217 MB Squirrel installer
  (`https://claude.ai/api/desktop/win32/x64/exe/latest/redirect`).
  `CCMANAGERUI_FAKE_DESKTOP_INSTALL` (msix-only | none | ok) forces the detection result for
  dev/testing.
- **Portable mode**: a server-persisted setting (Settings → Appearance → Portable window) that
  opens CC Manager UI in its own chromeless Chromium app window (`msedge`/`chrome --app=`, no
  tabs or address bar) instead of a browser tab. Applies both to the in-app toggle (`POST
  /api/portable-window`) and the desktop tray launcher, which now opens the UI through the
  portable-mode-aware `Open-AppUi` helper. The window gets its own dedicated Chromium profile
  (`~/.ccmanagerui/portable-profile`, `--user-data-dir`) so it remembers its size/position
  across launches instead of sharing the main browser profile; both open paths derive the same
  profile dir from `runtime.json`'s location.
- **MCP stdio server** (`server/src/mcp.ts`, `bun run mcp`), exposes CC Manager UI's
  sessions/queue/instances API over MCP stdio for use from Claude Code / Claude Desktop.
- **Background auto-update loop**: an opt-in daemon-wide timer that checks the update remote on
  a schedule and, when a newer commit is available and the working tree is clean, pulls +
  reinstalls + rebuilds + self-relaunches so the running daemon stays current unattended. Off by
  default; never touches a dirty working tree.
- Repo hygiene pass to bring the tree up to the standard of its LunarWerx siblings: CI
  (`.github/workflows/ci.yml`, lint + typecheck + build + test on ubuntu/windows), an Architect
  config (`.arkitect/`) with a gating bundle-weight-budget check, an MIT `LICENSE`,
  `.editorconfig`, `bunfig.toml`, and a documented `.env.example`.

### Fixed

- **Quitting CC Manager UI no longer closes the Claude Desktop instances it launched.** The
  Windows tray host quits by tree-killing the daemon's whole process tree
  (`taskkill /PID <daemon> /T /F`), and instances were spawned as direct children of the daemon,
  so Quit dragged every open Claude instance down with it. Neither `.unref()` nor Bun's
  `detached: true` breaks the Windows process tree; the launch now goes through a `cmd /c start ""`
  hand-off that re-parents the instance out of the daemon's tree, so it survives Quit
  (`server/src/core/instances.ts` `buildInstanceLaunch`, `server/tests/instances-launch.test.ts`).
  macOS already detached via `open`; Linux now spawns with `detached: true` (setsid).
- **The Instances ⋮ "More actions" menu opens again.** Its trigger had been wrapped in a
  tooltip, and the nested `TooltipTrigger`/`DropdownMenuTrigger` (both `as-child`) swallowed the
  click so the menu never opened, while the zero-delay tooltip itself was intrusive. The kebab
  is now a bare dropdown trigger with an `aria-label`, it opens on click, with no tooltip.
- **The Instances refresh icon no longer spins on every poll.** The list silently re-polls every
  4 s and the spinner was tied to that `loading` flag, so it flickered constantly and read as a
  constant spin. Background poll ticks are now silent; the icon spins only on a first load or a
  user-initiated refresh.
- **Instance discovery no longer breaks on profile paths that contain a space.** When an
  instance's `--user-data-dir` has a space (a space in the Windows user name, or a space in the
  instance name itself), `Bun.spawn`/libuv wraps the whole `"--user-data-dir=C:\a b\c"` token in
  quotes, and the previous command-line parser truncated the path at the first space, so the
  running instance was mis-matched (it showed as "stopped" or as a stray external row). The
  `core/process.ts` parser now handles all three quotings (unquoted, value-quoted, and
  whole-token-quoted), see `tests/process-parse.test.ts`.
- **Composer toasts render as real toasts.** The "Queued N message(s)" confirmation showed as
  bare unstyled text lines: vue-sonner v2 ships its styling as a separate stylesheet that was
  never imported. `main.ts` now imports `vue-sonner/style.css`, so every toast gets its card,
  border, and shadow back.
- **Open drawers no longer cover the header buttons.** The top bar now shares the push-panel
  padding shift with the main content (plus its own 16px), so New run / Queue / theme /
  Settings slide left to stay clickable instead of disappearing under the settings or queue
  drawer.
- **Push panels no longer crush the centered shell (kit-wide).** The settings/queue drawers
  dock to the viewport's right edge, but the content shift now equals only the panel's
  actual overlap with the centered app shell (zero on a wide monitor) instead of the full
  panel width. This removes the dead band that squeezed the Instances table to half size
  and nudged the Sessions placeholder left whenever Settings was opened.
- Built SPA now talks to the daemon over same-origin relative URLs instead of a hardcoded
  `http://localhost:7787`, so the UI keeps working when the daemon port-hops off its preferred
  port. Dev (Vite) behavior is unchanged; `VITE_API_BASE` still overrides both.
- Free-port probe (`find-free-port`) is now loopback-aware: it no longer picks a port that's
  only bound on another interface, closing a race where the daemon could report itself bound to
  a port a different loopback-only process (e.g. `wrangler dev`) was already holding.

### Changed

- **The composer lost its top divider line** (the transcript column stays borderless).
- **Queue moved from a tab to a slide-in drawer.** The queue now opens as a right-side push
  drawer from a header button (with the running-count badge), so the list rides alongside
  the Sessions or Instances view instead of replacing it. Only one drawer (queue or
  settings) is open at a time.
- **Settings split into tabs.** The Settings panel now groups its sections under three tabs
  (General / Scheduler / Accounts) using the shared kit's segmented tab bar, instead of one
  long scroll. General holds appearance, updates, and auto-update; the "Save settings" footer
  stays visible on every tab and still flushes the scheduler form.
- **One Updates group, and it explains itself.** The separate Auto-update section merged into
  the Updates group (the auto-check toggle and interval sit right under the manual check).
  The cryptic "No update source" row now reads "Updates can't be checked" with a visible
  explanation (no Git remote linked; add one or set `CCMANAGERUI_UPDATE_REPO`), and the
  auto-update rows gray out while there is no source to check.
- **Queue resume lives in the queue drawer.** The transcript header's primary button now
  opens/closes the queue drawer; the "Queue resume" action (builder in resume mode) moved
  into the drawer's toolbar next to New run. "Show tool activity" shrank from a labeled
  switch to an icon toggle (pressed = tool events shown), matching the ID button beside it.
- **Multi-select banner is count-only.** "Sending to N sessions" no longer tries to list every
  target's title (they always truncated into noise).
- **Drawer headers/footers lost their divider lines (kit-wide).** The shared panel shell no
  longer draws a border under its title bar or above its footer.
- **Header cleanup**: the scheduler pill left the top bar (its toggle plus counts and interval
  controls already live in Settings → Scheduler); the Queue page now shows a small "Scheduler
  on" chip whenever it's enabled, so auto-dispatch is still visible where it matters. The
  "New run" header button is now a compact plus icon that expands on hover/keyboard focus to
  reveal its label (same pattern as DevWebUI's top bar), and the Queue page title gained an
  info hint explaining what the queue is and that nothing runs by itself while the scheduler
  is off.
- **Default port moved 8787 → 7787.** 8787 collided with both another local dev server and
  `wrangler dev`'s default. Set `PORT` to override; the daemon still hops to the next free port
  if its preferred one is busy and records where it landed in `~/.ccmanagerui/runtime.json`.

