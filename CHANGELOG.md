# Changelog

All notable changes to AgentHydra are documented here. Entries up to v0.13.0 were written when the
project was called CC Manager UI and are left in its name, because that is what shipped. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**TL;DR**

- **The Instances page has a search box**
- **Each Instances tab's + creates its own kind**
- **Click to restart and update really restarts**
- **Login sync tells you when it brings in a new account**
- **The CLI Tokens column says it counts this PC, and shows work running from your other PC**
- **The orchestrator's judge is a frontier model, not fixed rules, and you pick which one**
- **The babysitter can wake a Desktop chat a usage limit stopped**
- **Stats count Codex sub-agents, Codex's packed archives and every OpenCode call**
- **A new chat no longer pulls you back into it after you moved on**
- **Chats with long transcripts stop stalling the server on every poll**
- **The timings log records every server stall over 200 ms**
- **One click above the account pill restarts you onto an update**
- **A What's new pop-up lists what changed once the update's restart is done**
- **The New screen shows Connections' logo, and reads a project's logo from its top-level icon too**
- **The New screen highlights the project you picked**
- **The New screen's View options menu shows hidden projects, and Manage folders says where each folder came from**
- **The live browser pane keeps streaming when its Chrome window is covered**
- **Drop any file in a chat: PDFs, notes, emails, zips**
- **Hovering a control shows one tip after a second, not two**
- **Opening a chat lands on its newest message**
- **The folder pill above the message box shows the project's logo**
- **Restart to update takes seconds and shows What's new afterwards**
- **Sending and clicking no longer stall behind the server's background reading of running workers**

**Everything in Unreleased**

- **The Instances page has a search box.** The magnifier at the top right (or Ctrl+F) opens a box that narrows every
  table as you type, by instance number, name, account or plan: "#171" finds #171 and "20x" finds the Max 20× accounts.
  Esc or the X clears it.
- **Each Instances tab's + creates its own kind.** On the CLI tab the + adds a CLI account instead of a desktop
  instance, Desktop offers only the apps, Free only Free accounts, and All lists every kind under its own heading.
- **Click to restart and update really restarts.** The click's update step rebuilt the window, which then reloaded
  itself and dropped the click before its restart, so the server was never restarted. The window now waits for the
  restart, a busy server gets 20 seconds to answer instead of 4, and a restart that never happens says so and can be
  clicked again instead of showing Restarting… for good.
- **Login sync tells you when it brings in a new account.** When a sync from your other PC adds an instance this PC did
  not have, one notification per sync lists them, e.g. "Claude CLI account #7 (Max 20×)". It names instances by number,
  never by email.
- **The CLI Tokens column says it counts this PC.** The header reads Tokens (this PC), and a row shows "3 on other PC"
  when your other PC has CliMayte workers on that account, so an account busy there no longer looks unused here.
- **The babysitter can wake a Desktop chat a usage limit stopped.** Its continue now goes in through the Claude app's own
  chat-to-chat messaging, which starts the chat again by itself, instead of waiting for a running chat that was
  no longer there. Nothing is typed into the window, the message shows as from AgentHydra rather than from you, and a
  chat you stopped yourself stays stopped.
- **A worker transcript is read in slices, so opening a worker chat no longer holds the server.** The first read of a worker transcript parsed the whole file in one run, which held every request for seconds at startup and on the first chat open. It now parses in slices and lets other requests run between them.
- **Your message shows the moment you press Send.** It is drawn in its chat at once, before the server answers, and a new chat appears in the sidebar as soon as you send its first message. A send that fails stays on screen as Not sent, with Retry and the text kept.
- **Restart to update takes seconds and shows What's new afterwards.** A click on the update row could sit for two minutes with nothing on screen, and What's new never appeared. The row now says Restarting… the moment you click, the old server stops within seconds, and What's new opens once the new one is up.

- **Opening a chat lands on its newest message.** Switching to a chat could leave it a screen or more above the latest message while its rows settled. A chat now opens at the bottom and stays there until you scroll up yourself.

- **The folder pill above the message box shows the project's logo.** The pill and its folder menu show the same logo as the project's tile on the New screen, and the folder icon when a project has none.

- **Opening a chat no longer re-reads its whole transcript on every request.** The server keeps a chat's answer as text for as long as its file is unchanged, so an unchanged chat is sent from memory. A worker's sessions are also read one at a time, so a request can run between two of them.

- **Sending and clicking no longer stall behind the server's background reading of running workers.** The server
  re-read and re-matched every worker's transcript and chat link on each poll, so a click's request could wait
  seconds. It now reads only the new lines of a worker's file, matches chats to workers from an index, stops
  searching every folder for a session that has no file yet, and lets other work run between two workers' reads.
  The timings log also records the CPU each stall used, so a stall from the PC being busy shows apart from the server's own work.

- **Stop stops at once.** Stop, Esc and the sidebar's Stop turn the chat to stopped in the same frame, and Send and the message box come back at once. A Stop the server cannot finish is reported, and a CLI that never answers its interrupt is closed after about a second and a half, so the next message still goes through.

- **Hovering a control or text shows one styled tip after about a second.** Controls and text that had a plain browser tooltip now show the same styled tip as the rest of the app, and the browser's own tooltip is gone. The styled tip waits about a second instead of half a second, so a quick pass of the pointer shows nothing and a pause shows exactly one tip.

- **The New screen's View options menu shows hidden projects.** The filter row has a View options button, with "Folders and git status" and "Show hidden projects" (with a count, disabled when nothing is hidden). With hidden projects shown they sit dimmed with a small hidden mark, and right-click offers Unhide instead of Hide. The choice is remembered.

- **Manage folders lists where each folder came from.** Two sections, "From Project Hydra" and "From your chats", each with a count and a collapsible list of names and paths, and a Hide action on each. A project in both sources sits under Project Hydra only. Hand-added folders stay in their own sections.

- **A What's new pop-up lists what changed once the update's restart is done.** After the row restarts onto a newer server, a dialog shows the changelog sections and Unreleased entries added since the last look, read from the CHANGELOG the release ships. Got it, Esc or a click outside clears it.

- **The live browser pane keeps streaming when its Chrome window is covered.** Windows stopped drawing a saved
  Chrome whose window sat behind the Desk, so the pane got no pictures and clicks went nowhere. Every Chrome the
  Desk opens now keeps drawing (about 47 frames a second in a test, from none), and scrolling sends one message per
  frame. A saved Chrome that is already open picks this up once it is closed and opened again.

- **Drop any file in a chat: PDFs, notes, emails, zips.** The chat box took only small PNG, JPEG, GIF and WebP
  pictures. Now any file up to 100 MB attaches as a chip, and Claude gets its path to read it. A file dropped
  anywhere on the chat attaches, and a large or unusual picture goes as a file instead of being refused.

- **The New screen highlights the project you picked.** The tile for the folder your next chat starts in gets a thin accent ring and reads as pressed, however it was picked: a click, the composer's folder pill or New chat here.

- **The New screen shows Connections' logo, and reads a project's logo from its top-level icon too.** Connections
  had a second Project Hydra entry for its repo with no logo, so its row showed none. A logo-less entry now takes the
  logo of another entry for the same repo, and a project with no launch row reads its top-level `icon` (a launch
  row's icon still wins), only from Project Hydra's icons folder.

- **The server stops re-reading a CliMayte chat's transcripts on every poll.** A chat whose sessions added up to
  more than the 64 MB cache held was read again in full on each window poll, blocking the server for one to
  several seconds every time. Each session's file check is now kept with its items, so an unchanged session costs
  one stat however large the chat is.

- **The timings log records every server stall over 200 ms.** When the server's thread is blocked that long, a
  "Server event loop blocked" line goes into Speed with its length, so the next slowdown is measured, not guessed.

- **A restart that updates you is one click, above the account pill.** When a newer AgentHydra is waiting or the
  window's server is older than its files, a row says "Click to restart and update" (with the version when known).
  It shows without opening AgentHydra, and your chats keep running while it restarts.

- **A new chat no longer pulls you back into it after you moved on.** Sending the first message of a new chat
  and opening another chat before it answered used to switch you back to the new one a few seconds later. It
  now opens only if you are still on the screen you sent it from; otherwise it just appears in the sidebar.
  Forks work the same way.

- **Stats count Codex sub-agents, Codex's packed archives and every OpenCode call.** Work a Codex sub-agent did
  was left out, and so were the rollouts Codex packs into monthly zips. Codex is now counted call by call, so a
  chat moved to another account or split into pages counts once. OpenCode was booked as one call per session at
  its last write; it now counts each model call at its own time. Old totals are replaced, not added to.

- **A frontier model judges each running chat and each stopped one.** The orchestrator asks the model set in
  Settings > General > Watching chats (Opus by default, the newest one) what each chat needs next: nothing, a
  check-in note, a continue, or a person. Its limits stay in code, and a failed call sends nothing. It reads the
  newest slice of a chat first (about 1% of it) and asks for a bigger one (3%, then 5%) only when it cannot tell.
  It signs in with any of your accounts that has room, an idle one first, so it keeps working whichever account
  the chats it watches run on.

## [2.0.3] - 2026-10-09

**TL;DR**

- **A babysitter continues chats a usage limit stopped, once the limit resets**
- **Moving chats between accounts is about ten times faster, and the old account's copies are archived again**
- **The orchestrator gets a switch beside the babysitter's, and a foreman that checks in on running chats**
- **Usage cards in the accounts table open on a click, not on hover**
- **The Dev servers page shows its last list at once and refreshes behind it**
- **New's project grid: shorter tiles without details, six rows and Show all**
- **Sidebar group headings show their project's icon**
- **Sidebar: groups in A-Z order, + on every group, Search and Filter beside New**
- **A chat started from another chat's chip sits under that chat in the sidebar**
- **Background work reaches the Free accounts, and their answers count tokens**
- **Open brings the account's Claude window to the front**
- **The Free accounts' list keeps a backup, so a power cut cannot wipe it**
- **A chat can move to another working folder on its own account**

**Everything in 2.0.3**

- **Moving chats between accounts is about ten times faster, and the old account's copies are archived
  again.** Claude Desktop 2.31226.0 moved a helper AgentHydra reads, so every move left the chat showing on
  the old account and its effort unconfirmed on the new one. That works again. A move also now lands each
  chat and sets Bypass permissions inside the target app directly, instead of starting a second Claude
  process per chat and clicking the permission picker on screen: about 10 seconds a chat saved.

- **A babysitter continues chats a usage limit stopped, once the limit resets.** Every 5 minutes AgentHydra
  checks which chats, in its own window or in Claude Desktop, a usage limit stopped, and continues each one
  when its limit resets, with a note that says it came from the babysitter. Settings > General shows what is
  stopped on each account and when it resets, and turns it off.
- **The orchestrator gets a switch beside the babysitter's, and a foreman that checks in on running chats.**
  Settings > General > Watching chats has both switches. Turned on, the orchestrator continues chats an error
  stopped, and every 10 minutes peeks at running chats: one that keeps failing the same step or sits in one
  command for 45 minutes gets a short check-in note.
- **Usage cards in the accounts table open on a click, not on hover.** Only one is open at a time.
- **The Dev servers page shows its last list at once and refreshes behind it.** It also reads the list once
  shortly after the window starts, so the first open is already filled.
- **New's project grid: shorter tiles without details, six rows and Show all.** Filtering still shows every match.
- **Sidebar group headings show their project's icon** when the group is one of your Project Hydra projects.
- **Sidebar: groups in A-Z order, + on every group, Search and Filter beside New.** Every folder group has its
  own + for a new chat there, and the New button is a quieter colour.
- **A chat started from another chat's chip sits under that chat in the sidebar,** indented, as Claude
  Desktop shows it. A chat whose parent is not shown stays an ordinary row.
- **Background work reaches the Free accounts, and their answers count tokens.** Asks made by CliMayte workers,
  most of the background work, never went to an idle Free account; now they do. A Free answer also records an
  estimate of its tokens instead of zero.
- **Open brings the account's Claude window to the front.** It could open behind AgentHydra's own window and
  look like nothing happened. AgentHydra also waits at most 3 seconds for login sync before launching.
- **The Free accounts' list keeps a backup, so a power cut cannot wipe it.** If the list is ever found empty or
  unreadable, it comes back from a backup at most 10 minutes old, with its chats and token counts.
- **A chat can move to another working folder on its own account.** It keeps its history, name, model, effort
  and permissions under a new ID, and the old copy is archived, never deleted. A chat that is working, has a
  background task, or was used in the last 10 minutes is left where it is.

## [2.0.2] - 2026-10-08

**TL;DR**

- **AgentHydra 2.0 comes to installed copies**
- **A power cut no longer takes the window or the Free accounts down**
- **Drag the window from its empty top row; the pane buttons sit beside minimize, maximize and close**
- **The working line says what the turn is doing, with a timer since your last message**
- **The working mark picks its own look every five minutes, and moves more slowly**
- **Background tasks slides in and out, opens narrower and drags to any width**
- **Thinking folds into the tool runs around it in outside chats too**
- **With the cloud off, every local Desktop chat is listed, and row menus can move a chat to another account**
- **New shows your projects at once, open-chat projects first, each with its git state**
- **Right-click a project to open its folder; choose which folders New shows**
- **Desktop accounts open faster, several at once, and stay signed in**
- **The Free accounts: usage history, honest red marks, ChatGPT pacing, and HSwarm uses every idle one**
- **Moving several chats moves the ready ones first, and a restart waits for a move**
- **Archiving from a chat's menu works in any language and never picks the wrong item**
- **Updates install on a PC that is never idle, and never stop half-way on a running program**

**Everything in 2.0.2**

- **AgentHydra 2.0 comes to installed copies.** 2.0.1 was a preview that installed copies were not offered;
  2.0.2 is the 2.0 they update to. What 2.0 brings is in 2.0.1's notes below.
- **A power cut no longer takes the window or the Free accounts down.** A Free accounts list that a crash left empty
  is set aside and rebuilt from the accounts' own folders, and each account takes its name back at its next check.
  Every saved list is now on the disk before it replaces the old one, so a crash leaves the old copy or the new one.
- **Drag the window from its empty top row.** AgentHydra draws its own title bar: the empty top row moves the
  window, Maximize offers Windows 11's snap layouts, and the pane buttons sit beside minimize, maximize and close.
- **The working line says what the turn is doing now.** It is larger, counts the time since your last message,
  and its ">" opens the step it names.
- **The working mark picks its own look every five minutes, and moves more slowly.** The Working animation
  picker is gone from Settings -> General -> Appearance: every mark in the window shows the same randomly chosen
  look and swaps to another every five minutes, never the same one twice in a row. The marks move more slowly,
  keep moving while the window is on screen but not focused, and the sidebar slides smoothly.
- **Background tasks slides in and out, opens narrower and drags to any width.** The panel slides in from the
  right instead of appearing at once, opens narrower, and its left edge drags it to the width you want, which is
  remembered. What a task was told is no longer a paragraph in its card: hover its name to read it.
- **Thinking folds into the tool runs around it in outside chats too.** A Claude Desktop or terminal session
  open in AgentHydra showed each thinking block as its own row between the commands; it is one row again, as in
  AgentHydra's own chats.
- **With the cloud off, every local Desktop chat is listed.** Active only also keeps a reply you have not read
  and a chat that hit an error, and clicking one app while all are shown shows just that one. A row's menu names
  the chat and its account, and offers Move to account.
- **New shows your projects at once.** Clicking New opens a grid of the folders you work in, each with its logo,
  its path and whether its git checkout is up to date, behind, ahead or has uncommitted changes, without waiting
  for every folder's git state first. Projects with chats that are not archived come first, with a count; a
  project reached through a junction is one tile. A chat started in a folder of several projects is filed into
  the project it worked in.
- **Right-click a project to open its folder; choose which folders New shows.** A tile's right-click menu opens
  its file location or starts a new chat there. The folder button by the filter adds a project folder, or a folder
  whose subfolders each become a tile, and Manage folders lists what is shown and hidden.
- **Desktop accounts open faster, several at once.** The checks AgentHydra runs before starting Claude run side
  by side, and every file is still checked on every Open. Opening a second account no longer waits for the first,
  and the Open button spins while it works.
- **A linked CLI login stays signed in while its desktop app is closed.** AgentHydra renews a closed profile's
  Claude Code login before it runs out, without opening a window. A closed profile its app shows signed out takes
  its account's signed-in copy from another PC; a profile still signed in is never replaced.
- **A CliMayte worker's folder moves its chat.** When AgentHydra gives a worker a new folder, the chat moves
  there at once and stays there after a restart.
- **Usage history shows what the Free accounts did, and Tokens per day opens at once.** With the Free rows on
  screen, the card gives the Free totals, the tokens of Claude and of ChatGPT, and the messages each model
  answered. The Free numbers card keeps the totals instead of a row per account.
- **A Free account wears a red mark only when it is really failing, and shows its plan.** Another tool's refused
  message no longer marks a working account, and a paid plan the site reports, such as ChatGPT Go, is a badge
  beside the name.
- **ChatGPT Free accounts slow down before ChatGPT locks them out.** AgentHydra spaces each ChatGPT account's new
  chats under the rate at which ChatGPT starts refusing them, and a task waits for a paced account instead of
  failing. A new ChatGPT chat can ask for GPT-6 or Luna Thinking mini where the account offers them.
- **HSwarm uses every idle Free account at once.** It sent at most six tasks to the Free accounts at a time, so
  the rest went to paid models while accounts sat idle.
- **The Free tab's + menu offers only Free accounts, and a slow check no longer looks like a dead login.**
- **Moving several chats moves the ready ones first.** A chat still finishing its turn no longer holds the
  others back: it is tried again after them. A restart of AgentHydra waits while chats are being moved, since one
  cut short leaves a chat on both accounts; the reply to a move lost that way says how to finish it.
- **Archiving from a chat's menu works in any language and never picks the wrong item.** On a Korean app no
  chat could be found to archive or rename; now it can. Without a known label, only the item directly above
  Delete is taken, and any other menu shape is refused. A busy refusal now says what held the chat, and
  archiving a chat that has a copy on several accounts can name the account.
- **Updates install on a PC that is never idle.** Auto-update waited for every run and CliMayte worker to
  finish, which never happened on a busy PC. It now waits at most an hour, then installs, and the work that was
  running carries on after the restart.
- **An update no longer stops half-way on a program that is running.** On Windows a running program file cannot
  be replaced, so an update that changed one stopped half done. The update now moves the running copy aside and
  installs the new one.

## [2.0.1] - 2026-10-08

**TL;DR**

- **AgentHydra 2.0: the new window (it was Hydra Desk 2) now comes in the download on Windows, Linux and macOS**
- **Opening AgentHydra always reaches the new window, and starts it when it is down**
- **Updates install, update and repair the new window, and an install without it fixes itself**
- **Dev servers run once for every chat: AgentHydra reuses one that runs instead of starting a second**
- **A Dev servers button lists your projects and their servers in the sidebar, with a page of their own**
- **The Dev servers list is grouped by company, folded until you open it, and shows what runs**
- **Chats in the sidebar show their account number and when they were last active**
- **Free accounts get a Tokens column and keep their readings current in the background**
- **Free accounts show their email: hover the name to see it, click to copy it**
- **HSwarm's tables look like the Instances tables, and popups close when you look away**
- **HSwarm can use Jina, Pinecone and StepFun**
- **HSwarm keeps each key under its provider's rate limit and moves past keys that are out of credit**
- **HSwarm offers Claude Haiku 5.5 and more Together models for tool work**
- **CliMayte tries Claude Haiku 5.5 first and never uses Haiku 4.5**
- **The download is about 12 MB instead of about 200 MB**
- **AgentHydra 2.0 does much less in the background while you are not looking at it**
- **The new window opens sooner, closes at once and fills in faster**
- **AgentHydra no longer freezes for seconds at a time**
- **CliMayte's sealed tasks no longer leave a folder behind in your temp folder**
- **HSwarm's Claude Code workers keep their turns when a key runs out of credit**
- **HSwarm's decide no longer pays a fallback model when you asked for Jev alone**
- **HSwarm's decisions keep working when every TypeSafe key is refused: Cloudflare's free Clef stands in**
- **A Jev key that runs out of credit shows as disabled and is no longer asked first on every call**
- **HSwarm's nightly upkeep finishes again instead of stopping at its two-hour limit**
- **The old window is gone: the new window is AgentHydra's only one**
- **A Codex chat moved to another account shows up in that account's Codex app**

**Everything in 2.0.1**

### Added

- **AgentHydra 2.0: a new window, in the download on every platform.** The window that was Hydra Desk 2 is now
  AgentHydra's, and the download carries everything it needs to run: on Windows it opens in its own window from
  the AgentHydra shortcut or the tray icon, on Linux and macOS in your browser. It brings every chat from this PC and your other PC into one sidebar, AgentHydra's accounts,
  CliMayte, HSwarm and Analytics pages beside the chat with one Settings dialog, dev servers and a small browser,
  Free claude.ai and ChatGPT accounts, and pictures and videos in the chat.
- **A Dev servers button in the title bar.** It lists your projects and their servers in the sidebar, where you can
  start, stop and open them. A click on one opens the Dev servers page, which slides in the way AgentHydra's pages
  do, with its status, CPU and memory charts, errors, alerts and logs.
- **The Dev servers list is grouped by company and starts folded.** A project shows only its running servers until
  you open it, and Expand all opens everything. Other servers and the folders a scan found are grouped by company
  too, and the list remembers what you opened.
- **Chats in the sidebar show their account number and when they were last active**, as the Cloud list does,
  without turning Cloud on. Clean sidebar hides them, for titles only.
- **Chats share dev servers instead of starting their own.** Every chat, and every other Claude session on the PC,
  gets tools to start a project's dev server through AgentHydra: when that server already runs, whoever started it,
  they get its address instead of a second copy fighting the first for its port.
- **Forget a Free thread.** A thread can be removed from AgentHydra's Free list. The chat itself was private, so the
  site never kept it.
- **The Free table has a Tokens column, like the CLI and desktop tables.** Neither claude.ai nor ChatGPT reports
  tokens, so AgentHydra estimates them from the text each message sent and got back. The header switches between
  the current 5-hour window, the week and all time.
- **Free accounts show their email.** Hover a Free account's name to see the email it is signed in with, and click
  the name to copy it, as on the desktop and CLI tables. Accounts added before this fill in on their own within
  about 15 minutes, or at once with Refresh.
- **HSwarm can use Jina, Pinecone and StepFun.** Jina reads and searches the web and makes embeddings, Pinecone
  stores and searches vectors, and StepFun's chat models can be named directly. A StepFun key issued in China works
  once its China address is set in your own provider settings.
- **A Codex chat moved to another account shows up in that account's Codex app.** On Windows, a move
  opens the chat in the destination's Codex app and files it under a Migrated chats section, and only then
  archives the original. A new command moves every active chat of one account in one go.

### Changed

- **The AgentHydra Instances shortcut opens the new window's account chooser.** The small window it opens is now
  AgentHydra 2.0's, and the new Settings (Instances, Desktop) has the button that adds the shortcut to your Desktop.
- **Undo asks before taking out more than your last message, and offers Fork instead.** Undo under an earlier message now shows how many of your messages and replies it would remove, and Fork instead keeps this chat and opens a new one from just before that message.
- **CliMayte workers are stopped by the same command guards as your own chats.** Every Bash and PowerShell call a
  worker makes now goes through the guard hooks in your Claude profile that refuse destructive commands and force
  pushes, when you have them installed. Workers run with permissions skipped, so before this nothing stopped one
  from wiping the uncommitted work in a shared checkout.
- **CliMayte tries Claude Haiku 5.5 first and never uses Haiku 4.5.** Every kind of task now starts on
  Haiku 5.5, about a fifth of Sonnet 5.5's price on CliMayte's own work, and a task it cannot do goes straight back
  on the setting that would have run it. Asking for Haiku 4.5 is refused, and the Claude Code sessions
  AgentHydra starts make their own small background calls on Haiku 5.5 too.
- **The download is about 12 MB instead of about 200 MB.** AgentHydra no longer packs Bun or Claude Code inside the
  download: the small `AgentHydra.exe` fetches Bun the first time you run it (and keeps it up to date), and the new
  window fetches Claude Code when it needs it. Updates are quicker too, and an install on 1.13 updates itself to
  2.0 the usual way.
- **Opening AgentHydra always leads to the new window.** The tray, the shortcut and every AgentHydra page open
  it. When it is not running, AgentHydra starts it and shows a short "Starting AgentHydra" page that moves on by
  itself, instead of a page that never loads.
- **Updates carry the new window.** An update installs, updates and repairs the new window along with the app, and starts the window again afterwards. An install that is missing the window, such
  as one updated by an older version or the single `.exe` download, puts it back by itself when it starts.
- **HSwarm's key and model tables look like the Instances tables.** They use the same rows, controls and cards.
- **HSwarm keeps each key under its provider's rate limit.** Where a provider publishes a limit per key, a request
  waits for a key with room instead of piling onto one, and searches run side by side spread over your keys
  instead of all starting on the first. A key the provider turns away as invalid, out of credit or rate-limited is
  set aside, and the same request goes to another key.
- **HSwarm offers Claude Haiku 5.5 and more Together models for tool work.** Haiku 5.5 is now ranked on independent
  scores at each effort level, and the Together models whose documentation says they can call tools are offered for
  tool work, so more low-cost models can take a task.
- **The Free table no longer spins its 5-hour and week cells every time you open it.** AgentHydra now keeps the
  Free accounts' readings current in the background, one account at a time, and the table only shows what changed.
- **Dev servers are part of AgentHydra now, not a separate program.** They run in AgentHydra's own small background
  process, which you can restart or stop from Settings without touching AgentHydra, and which keeps your servers
  running when AgentHydra restarts. A server that already runs on its port is used as it is, never killed to make room.
- **Every change to the new window is tested.** Its own test suite now runs with the rest on every change.
- **AgentHydra 2.0 does much less in the background while you are not looking at it.** With its window hidden or
  closed it stops asking for updates nobody would see, its pages refresh only what the page on screen shows, and a
  list of local servers asked for twice in a row is scanned once. It also starts with less in memory and loads a
  little less code when it opens.
- **The new window opens sooner, closes at once and fills in faster.** When AgentHydra is already running, the
  shortcut opens the window straight away instead of starting a script first, and the window no longer waits for
  the tray icon check. Closing hides the window at once instead of leaving it on screen while it shuts down. A
  reload shows your chat list right away, Settings and the other panels load while the window is idle so they
  open without a wait, and Home shows its last figures while it reads new ones.
- **Sidebar rows glide to their new place when the list reorders.** A chat that moves up or down slides there
  instead of jumping, unless your system asks for reduced motion.

### Fixed

- **Running AgentHydra from source, an update can no longer overwrite your Bun.** A source checkout has no
  launcher of its own, so the release updater used to fall back to the program running it, which is the machine's
  Bun, and could have put a release download in its place. It now refuses and says a source checkout updates
  through git. Installed releases update exactly as before.
- **Moving chats off an account archives the old copies again on Claude Desktop 2.26454.0.** That build moved an
  internal check AgentHydra relies on, so every archive was refused and the moved chats' old copies stayed in
  the source account's sidebar.
- **A Free account no longer shows as signed out after a check that merely failed.** Only the site saying the login
  is gone signs it out; being offline for a moment does not.
- **Tooltips and usage popups no longer pile up while the window is not focused.** Hovering AgentHydra while another
  app had focus left every popup the pointer passed on screen.
- **The keepalive dot on the 5-hour counter is quieter.** It is half as bright and sits a little further in.
- **Dev servers start on every PC.** They failed to start where another copy of Bun was found first; they now run
  on the window's own.
- **The new window's pages no longer go blank when a rebuild of them fails.** New pages replace the old ones only
  once they have built, so a failed build leaves the window as it was.
- **Refreshing one provider's model list in HSwarm keeps the others.** It used to replace the whole saved list,
  prices included, with that one provider's models.
- **AgentHydra no longer freezes for seconds at a time.** Listing your chats, sending a message to a chat and
  starting CliMayte could each hold the whole app still, and a long freeze made the tray restart it. They now
  happen without stopping everything else, and checking which programs run takes much less time, so pages and
  tools answer at once.
- **CliMayte's sealed tasks no longer leave a folder behind in your temp folder.** Each one used to leave an
  empty folder there that nothing removed. They now live with CliMayte's other files and are cleared with them,
  two weeks after the task last ran.
- **HSwarm's Claude Code workers keep their turns when a key runs out of credit.** A key that ran dry used to cost
  the task a turn even when it had done nothing, so a short task could reach the next key with too few turns left
  and stop at its limit. Now only the turns a key really ran are taken off.
- **HSwarm's decide no longer pays a fallback model when you asked for Jev alone.** With the escalation threshold
  at 0, a question Jev could not answer, for example because it was out of credit, still went to a paid model. It
  now comes back unanswered with Jev's error, so your own fallback can answer it.
- **Cloudflare's Clef stands in for Jev.** When no TypeSafe key works, HSwarm asks Clef on Workers AI
  instead, free up to Cloudflare's daily allowance. Clef's answers are held to its own confidence scale,
  and its cost is booked under Cloudflare. It needs no Cloudflare API token: a small Worker that ships with
  HSwarm can reach Clef for you, and the key list carries it to your other PCs.
- **A Jev key that runs out of credit shows as disabled and is no longer asked first on every call.** `hswarm keys`
  used to list such a key as ready, so nothing showed that Jev was down. Now it is marked out of credit, every
  later call skips it, and it gets one try a day so a topped-up key comes back by itself.
- **HSwarm's nightly upkeep finishes again.** While indexing finished jobs it reopened a day's compressed history
  once for every job in it. With a few weeks of history it hit its two-hour limit every night, before it packed old
  jobs, recorded the day or rewrote its page. It now reads each day once, and a night with nothing new reads
  nothing. `hswarm doctor` also says when the upkeep has fallen behind.
- **Running from source, the live checkout installs and builds the new window too.** `scripts/live-checkout.ps1
  -Apply` pointed the AgentHydra shortcut at the live checkout's new window but never installed or built it there,
  so the shortcut could open nothing.

### Removed

- **The old AgentHydra window, and its portable window setting.** The new window is the only one now, and
  the download no longer carries a copy of the old one.
- **The separate DevWebUI copy.** Its own background program, tray and settings are gone; its projects carry over.

## [2.0.0] - 2026-10-08

- **Tagged, never published.** Its release build stopped before publishing, so nothing was
  downloaded from it. Everything meant for it ships in 2.0.1.

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

- **Per-instance routes only act on known instances.** Opening, quitting or deleting an instance by a bare name now resolves against the instance list instead of the daemon's working directory.

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
- **Copy, move and sync CLI logins between two PCs**

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

- **CliMayte shows what every run cost.** Each run of a task keeps its own cost, requests, and tokens, including stopped runs, so you see how much restarts cost.

- **Token budget matches the plan meter.** Weights are now fitted to how the plan meter actually charges tokens, so budget estimates are more accurate.

- **CliMayte workers use the 5-minute prompt cache.** Workers switched from the 1-hour cache to save on cache-write costs.

- **CliMayte workers carry a short rule set.** Workers get a small system prompt and skill list (about 3 KB and 12 skills instead of 44 KB and 84), cutting tokens per step.

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

- **The session index costs a eighth of the CPU.** Only transcripts modified in the last hour are re-checked on refresh.

- **The background daemon no longer spikes CPU every five minutes.** Chat-title scanning now remembers records instead of re-reading all of them.

- **Claude Desktop updates again.** The version check now runs Claude's own updater so the app stays current.

- **Claude from the Start menu is no longer stuck on an old build.** The shortcut is updated to point at the real install.

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

- **Deleting a Codex instance no longer fails with "resource busy".**

- **Claude Desktop updates again.** AgentHydra's copy of Claude can download and run updates.

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

**TL;DR**

- **DeepSeek Harness and DeepSeek zswarm chats now list, search, export and show their cost beside Claude and Codex**
- **A new table manages DeepSeek Harness homes: launch, open, stop, one per account**
- **Codex chats can move between accounts, and the copy is verified before the original is archived**
- **Codex accounts show their own remaining quota**
- **Clicking a weekly quota cell copies the exact date and time it resets**
- **A stuck run can be cancelled, and a "kill and move" request no longer needs a hand-kill**
- **A killed batch move leaves findable, repairable half-moves instead of silent duplicates**
- **Many fixes for moving chats, usage readings, compiled builds and the daemon's start and crash behaviour**

**Everything in 0.42.0**

### Added

- **DeepSeek Harness chats are a full session source.** They list, search, follow, export and are priced from
  DeepSeek's published rates, read straight from the Harness folder with nothing to set up. Archived chats and
  per-turn spend are shown, and the transcript hides the harness's own bookkeeping.
- **DeepSeek zswarm jobs are a session source too.** Each job reads as a chat, daily cost is summed by model, and the
  live DeepSeek balance appears next to the Claude and Codex quotas. Usage advice now points batch work at it
  once every Claude account is at or above 90% of its week.
- **DeepSeek Harness homes can be managed.** A new table lists every home with whether it is serving, on which port
  and how many chats it holds. You can launch, open and stop one. The sign-in link never leaves the daemon, and the
  default home can never be deleted.
- **Codex chats move between accounts.** The chat is copied with its visible history, imported, confirmed, and only
  then archived at the source, so an interrupted move leaves two readable chats rather than none. Every safety
  check runs before anything connects.
- **Codex quota is read per account.** A signed-in Codex home reports its own remaining quota, and a signed-out one
  stops showing an old reading.
- **Copy a reset time.** Clicking a weekly quota cell copies the date and local time it resets, such as
  09/18/2026 9:59 AM. A cell with no known reset time is not clickable.
- **Cancel a running operation.** Agents can stop an orchestrator run that is still going. Cancelling is not an undo:
  what already finished stays finished, so read the fleet afterwards.
- **Repair half-moves.** A new tool finds batch moves that were killed part-way, says which chats are half-moved,
  and can finish or reverse them.
- **Kill-and-move.** A move that asks to end the live engines now takes over from a patient move of the same chats,
  instead of being refused as busy.
- **Safer pushes to a public repo.** A push now announces that the repo is public and stops unless you confirm, a
  release tag is refused while open work remains, and a bundled commit must list every file it swept.
- **Restart the daemon on demand.** The daemon can relaunch itself gracefully, and refuses while runs are in flight
  unless forced.

### Changed

- **Moving archived chats needs an exact count.** A batch now states how many archived chats it holds, and they must
  be the whole batch. The old yes/no option is gone, so an agent cannot decide on its own to move archived chats.
  Moving one named archived chat is unchanged.
- **Long names are cut to 18 characters in the Name column** with the full name on hover, so tables stay aligned.
- **"Open the transcript file" is hidden** for sessions whose file is not readable text.
- **The dispatched and rate-limited filters switch off for every non-Claude source**, not a hand-kept list.
- **Dead code for background queue runs was removed.** Behaviour is the same: such runs were already always refused.

### Fixed

- **Moves no longer lose or mislabel chats.** Title mismatches between the list and the app no longer block a move,
  half-moved chats on two accounts are counted from the account itself, landed chats are named before anything
  tries to find them by name, and a duplicate sidebar row no longer blocks archive or rename.
- **Resume after a move no longer hangs.** A freshly landed chat was wrongly read as mid-turn, a chat cut off
  mid-turn read as working forever, and a refused move now keeps the resume message. Staged replies expire after
  two days or when their chat changes accounts, and a delivery that only has to wait is retried, not failed.
- **Move reports are honest.** A one-chat move that ran for fifteen minutes now stops each phase on time, moves run
  in the background so a client timeout cannot cancel them, and the headline says how many chats are still dormant.
- **A working account no longer reads as rate limited.** The usage check now tries the app's own sign-in first and
  falls through when one login was revoked, and a refused usage request is obeyed instead of retried every
  half minute.
- **Usage no longer borrows another account's numbers.** A failed check can no longer fill in a different login's
  percentages.
- **Compiled builds work.** They now refresh their bundled scripts when rebuilt, can archive, unarchive, rename and
  message chats, and ship their tray icon, and the "is the tray running" check no longer answers backwards.
- **The daemon is easier to trust.** A crash or any exit now leaves a log line, a stale pointer file no longer makes a
  second daemon, a scratch daemon no longer takes over the real one's pointer, and a missing operation id says
  whether the daemon restarted.
- **Fan-out is honest.** It no longer says "ok" while members are still unfinished, survives a client timeout, lets
  status reads through, skips an account someone is actively using, and drops a revoked login's old usage.
- **A failed run can be retried.** A failed or cancelled operation no longer blocks the same request from starting.
- **Accented and non-Latin chat titles survive** the scripts that rename and archive chats.
- **Long runs keep their report.** A run over two minutes now returns an id to check instead of timing out.
- **Release and test fixes.** The release smoke test no longer fails on cleanup, and several tests that only failed on
  build machines are fixed.

## [0.41.0] - 2026-09-08

**TL;DR**

- **"Move chats to account" now moves every chat on the account, and never leaves one archived but not landed**
- **AgentHydra adds itself to Claude Code as an MCP server by default**
- **A Chats item in each row's menu lists the chats on that account**
- **"here" can no longer send chats to the wrong account because of a stale identity**
- **A broken install can be repaired from Settings without waiting for a new version**
- **Archive works in a non-English Claude Desktop**

**Everything in 0.41.0**

### Added

- **AgentHydra registers itself with Claude Code.** On every start it writes one HTTP entry into Claude Code's
  settings, leaving every other server and key alone, and refuses to touch a settings file it cannot read. Turning
  the switch off removes the entry, and the panel shows what the file really says.
- **A Chats item in a row's menu.** It lists every chat on that account with its project, last activity and whether
  an engine is running, plus an option to include archived ones.
- **Move confirmations name the account.** A move now states the instance number, name, plan and email before
  anything is imported, and a dry run reads the same as the real move.

### Changed

- **The move submenu is shorter.** It lists running accounts only, with a "Show not running" switch, and the item is
  now called "Move chats to account".
- **A moved chat's old record is renamed out of the way** instead of only flagged, so later scans stop finding the
  stale copy.

### Fixed

- **Moving all chats really moves all of them.** The plan now reads the account's own chat list, a chat is archived
  at the source only after it is confirmed at the destination, either of a chat's two names is accepted, and a
  copy already at the destination is recognised. Chats that cannot be moved are left in place and the reason is
  stated.
- **A stale identity cannot send chats to the wrong account.** A daemon tied to an archived chat no longer claims to
  know who is asking, and "here" is refused until you name the account.
- **Archive is limited to one account** and refuses to hide a chat that has a running engine unless forced.
- **Archive works in a non-English Claude Desktop**, found by the menu's danger styling rather than its text.
- **An install missing a folder can be repaired.** A "Repair install" button in Settings reinstalls the current
  release when a part is missing, and never downgrades.
- **The regular Claude Desktop install answers chat lists** instead of "no instance matched".
- **Update checks no longer offer an update they cannot apply** when your checkout has diverged from the remote.
- **The MCP docs and a Linux path bug are fixed**, along with a flaky registration test.

## [0.40.0] - 2026-09-07

**TL;DR**

- **The Instances filter now also filters by open or closed status and by plan**
- **The two 5-hour quota cells are grey so the weekly cells stand out**
- **AgentHydra no longer runs git on its own**
- **Bypass permissions can be set on minimized windows and through its confirmation popup**
- **Moves report chats that landed but did not finish, and stale locks no longer block retries**

**Everything in 0.40.0**

### Added

- **A three-way Filter.** "Usage filter" is now "Filter" and asks about quota, open or closed status, and plan. A row
  whose fact is unknown is never hidden, so rows stop blinking in and out, and the Codex table joins it.

### Changed

- **The 5-hour quota cells are grey.** Colour is kept for the weekly cells, because a spent week matters more than a
  spent session.

### Removed

- **Automatic git checks.** AgentHydra no longer runs git on every fleet request, which was slow in large
  repositories and fed nothing. Git only runs when you ask for it.

### Fixed

- **Replies are delivered again.** A path mistake made every courier reply fail as "delivery actuator missing".
- **The permission picker opens on minimized or background windows**, the confirmation popup is now found and
  clicked, and chats set to Auto or Manual can move to Bypass. The old failure messages now say what really
  went wrong.
- **A move can no longer claim confirmation another account earned**, and a chat that landed a second ago is waited
  for instead of reported missing.
- **Automation aims by exact identity.** Windows are matched by exact instance name, a blank name is refused, a
  sidebar row must match the title exactly, and keys are sent only to the proven target.
- **A crashed run no longer blocks retries forever,** and a lock held by a live run is never taken over by age.
- **Batch moves report a chat that landed but did not finish** as such, not as "not moved", and say which phase is
  slow.
- **The naming step uses the shared window lock** and restates the app's own title, so renamed chats are accepted.
- **A compiled build run from the repository finds the toolbox**, and a tray check that could crash the daemon is
  now guarded.

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

- **Orchestrator moved to a separate program: AgentHydra is back to being a pure fleet daemon**
- **Chats stay held off automation one at a time, never auto-archived when waiting for a person**
- **The daemon can put a message in a dormant chat, press Send, and get the answer, end to end**
- **Delivery ledger tracks every staged prompt through delivery or expiry, nothing vanishes silent**
- **Pre-start check reports all instances, chats, and next step in one read-only call**
- **Fleet shows one verdict per account, whether it can work, instead of one surprise per failure**

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

### Fixed

- **Tooltips work on a phone.** On touch-only devices tooltips used to be dead, including the info icons that hold a setting's description. Info icons now open on a tap, and other tooltips open on a press-and-hold, so a plain tap still runs the control. Mouse and pen behavior is unchanged.

## [0.19.2] - 2026-08-10

### Changed

- **The update check now doubles as an anonymous install ping.** The periodic check for a newer release goes through a relay that returns the same release data and records a random install id, the app version, an OS tag and a coarse location. It never records an IP address, username, file path, account or email. Setting the no-ping option turns it off and the check then asks GitHub directly. The README's old "no telemetry" claim now describes this.

## [0.19.1] - 2026-08-10

**TL;DR**

- **The system-tray icon is back in the Windows download**
- **The tray icon survives a Windows Explorer restart**
- **A tray icon that fails to appear at startup now retries**
- **A packaged build no longer tries to run a dependency install on itself**

**Everything in 0.19.1**

### Fixed

- **The system-tray icon is back in the Windows download.** Packaged builds had shipped without the tray toolkit since 0.12.0, so nothing could draw the icon. The download carries it again, and the READMEs now say the icon comes from the shortcut, not from the executable.
- **The tray icon survives an Explorer restart.** The launcher now re-adds its icon when the Windows shell restarts, instead of leaving it gone for the rest of the session.
- **A tray icon that fails to appear at startup now retries.** If the taskbar was not ready at logon, the launcher used to assume the icon was showing and never tried again.
- **A packaged build no longer tries to install dependencies on itself.** The first-run setup is meant for a source checkout and no longer runs in a release bundle.

## [0.19.0] - 2026-08-10

**TL;DR**

- **Every remembered layout choice now survives a port change**
- **The usage filter stops forgetting whether it was on**

**Everything in 0.19.0**

### Changed

- **Every remembered layout choice now survives a port change.** The tab you were on, the collapsed state of the Instances tables, the sessions filters, transcript verbosity, search case sensitivity and the sidebar width used to reset whenever the app had to start on a different port. They are now saved through the app itself, and anything already set in your browser is carried over. The theme and language are not included.

### Fixed

- **The usage filter stops forgetting whether it was on.** Three ways of losing the setting are closed: a click made while the saved value was still loading no longer undoes itself, a failed first read is retried instead of failing for good, and a change made just before closing the window is no longer lost.

## [0.18.1] - 2026-08-09

### Fixed

- **A detached launch no longer breaks on a folder name containing `&`, `|`, `^` or a space.** The fallback used when Windows launches that must outlive the app (a desktop shortcut, the relaunch after an update) could re-split such paths and fail. It now passes each argument safely. The usual launch route is unchanged.

## [0.18.0] - 2026-08-07

**TL;DR**

- **Quick Instances gets the quota columns and the usage filter, and remembers how you left them**
- **The app checks for updates on its own and shows a dot on Settings**
- **Updating shows real progress**
- **Updating no longer spins forever after it already succeeded**
- **Toasts have a close button**
- **Opening the app is faster: fewer network lookups and quota checks**

**Everything in 0.18.0**

### Added

- **Quick Instances gets the quota columns and the usage filter.** The compact window now shows both the 5-hour and weekly readings behind the same usage toggle and the same "set aside accounts I've used up" filter as the full Instances tab. Both windows share one state, and it is saved through the app so it is remembered even when the compact window runs on its own.
- **The app checks for updates on its own.** Checking and applying are now separate: it always checks, applying stays opt-in, and a newer version puts a dot on the Settings button.
- **Updating shows what it is doing.** A downloaded release reports real download progress, then extraction, verification and install. A source install names its current step. The update request now ends after at most 20 minutes, so the spinner never turns forever.

### Fixed

- **Clicking update no longer spins forever after the update has succeeded.** The app restarted itself too quickly for the page to read the answer. It now waits a little, and the page also checks the app's health and reports the new version either way.
- **Toasts have a close button.** Until now a toast could only be dismissed by waiting.
- **Opening the app no longer looks up every instance over the network.** Chips that label instances now read saved identities, and only the Instances tab checks for real.
- **The Instances tab no longer checks every account's quota at once on open.** It uses the saved readings and re-checks only the stale ones, two at a time.
- **A crashed app starts faster next time.** It now recognizes a leftover record of a process that no longer exists instead of probing three times.

## [0.17.0] - 2026-08-07

**TL;DR**

- **Every instance now has a permanent number you can use in the MCP server**
- **The usage filter can set aside an account for its 5-hour window on its own threshold**
- **The usage flyout is laid out as labelled cards**

**Everything in 0.17.0**

### Added

- **Every instance now has a permanent number.** One sequence covers Desktop, CLI and Codex instances, and a number is never reused, so "instance 7" keeps meaning the same account. A `#N` chip shows on every row and in each row's menu, and it copies on click.
- **MCP tools accept instance numbers.** Every tool that addresses an instance takes a number, a folder or id, a reference or an unambiguous name. Three new tools list the numbered fleet, confirm which account a reference means, and tell a process which numbered instance it is. Usage results now name the instance, and the usage budget works for CLI and Codex logins too. A queued run pinned to a number is resolved when it is queued, so it cannot fail later.
- **The usage filter can set aside an account for its 5-hour window as well.** Weekly and 5-hour usage are now separate switches with their own thresholds, and a row is set aside when either is crossed. Weekly stays on by default and 5-hour is opt-in. Older choices carry over unchanged, and the toolbar button states the whole rule.

### Changed

- **The usage flyout is laid out as labelled cards.** Each window has its own card with its switch, a readable threshold and a slider for values beyond the presets.

### Fixed

- **The "every instance is filtered" message no longer tells you to lower the threshold,** which would hide more rows, not fewer.

## [0.16.2] - 2026-08-06

**TL;DR**

- **A Codex Desktop you did not create through the app is now listed**
- **Codex instances show account, plan and quota**
- **A 5-hour reset no longer notifies for an account you have filtered out**
- **A free account no longer shows as "Max 20×"**
- **A usage reading whose window already reset no longer looks current**

**Everything in 0.16.2**

### Added

- **A Codex Desktop you did not create through the app is now listed.** The default Codex install is always shown, running or not, and a Codex Desktop running from any other profile is shown too. Both are marked external and offer no actions.
- **Codex instances now show account, plan and quota.** The Codex table gets Account, Usage and Plan columns like the Claude tables, and Codex quota feeds the same chips, countdowns and usage filter. An API-key login is labelled "API key" instead of looking like a broken login.

### Changed

- **A 5-hour reset no longer notifies for an account you have filtered out.** Reset notifications skip a 5-hour rollover when that account's weekly usage is at or above a threshold (80% by default), since weekly is what actually blocks it. Weekly resets are never skipped, and the threshold has its own control in Settings > Notifications.

### Fixed

- **A free account no longer shows as "Max 20×".** The plan now comes from the account's live organization type instead of a stale sign-in grant, with the grant used only as an offline fallback. The same answer is cached so it holds offline.
- **The account one-liner no longer shows a raw tier name.** The Quick view now shows the same plan label as the Plan column.
- **A usage reading whose window already reset no longer looks current.** A limit that reset more than a couple of minutes ago shows as no data, its countdown goes blank instead of saying "now", and the usage filter treats it as unknown so the account is not hidden.

## [0.16.1] - 2026-08-06

### Fixed

- **A paid account no longer shows as "Free".** Two faults are fixed: a specific plan tier now wins over the generic one wherever it comes from, and a generic tier is no longer taken as proof of a free account. An account only shows as Free when nothing indicates a subscription.

## [0.16.0] - 2026-08-06

**TL;DR**

- **A usage filter dims or hides accounts above a percentage you set**
- **Expanding and collapsing a section is animated**
- **Reset toasts no longer jump around, and a backlog becomes one toast**
- **The Instances tab no longer starts a background shell every few seconds**
- **The Account column fills at page load**
- **The Instances tab opens on the quota columns**
- **The app serves its own font and works offline**
- **Settings that belong to a screen now live on that screen**

**Everything in 0.16.0**

### Added

- **Usage filter.** With the quota columns on, a funnel button in the Instances toolbar dims instances at or above a percentage you set, and a switch hides them instead. Headings then read like "4 of 11 · 7 hidden" so a missing row is never a mystery. You pick whether it measures weekly, 5-hour or whichever is closer to its cap (weekly by default), and an instance that was never checked is never filtered.
- **Expanding and collapsing a section is animated.** The instance tables, the Codex table and the queue run viewer now open and close smoothly, respect the reduced-motion setting, and keep their sticky headers.

### Changed

- **The Instances tab opens on the quota columns.** The question the table is opened for is how much is left. The toolbar toggle still switches back in one click.
- **The app serves its own font instead of fetching it from Google.** The first screen no longer waits on the internet, and the app renders correctly offline.
- **Settings that belong to a screen now live on that screen.** Usage auto-refresh moved into the usage flyout, and the provider switches moved into a Sections flyout. They are the same settings shown in both places.

### Fixed

- **Reset toasts no longer jump around.** Several toasts raised together are now placed correctly and no longer jitter under the pointer.
- **A backlog of resets is one toast, not ten.** More than three at once collapse into a single "N quota windows reset" toast, and every event is still in the list the header badge counts.
- **The Instances tab no longer starts a background shell every few seconds.** Process lookups are shared and reused, which makes the list far faster. Actions such as launching, quitting and deleting still check for real.
- **The Account column fills at page load.** Saved identities show immediately and live results follow a few at a time.

## [0.15.0] - 2026-08-05

**TL;DR**

- **Notifications tell you the moment a quota window resets**
- **Usage mode swaps process columns for quota bars**
- **A CLI instance no longer loses its login after the app rename**

**Everything in 0.15.0**

### Added

- **Reset notifications.** The app now tells you at the exact moment a quota window rolls over, even while it sits in the tray. Notifications are native on Windows, macOS and Linux, can repeat until you acknowledge them, and can optionally be sent by email through your own mail server (the password is stored encrypted). Pending resets survive a restart, and Settings > Notifications has a button to send a test.
- **Usage mode.** One toolbar toggle swaps the process columns for quota bars across the Instances tab. Each bar's length and color both show how much of the window is still to run, with the time remaining written inside, and the burn percentage sits under it.

### Changed

- **The usage badge opens on hover.** Its breakdown also shows live "resets in" countdowns.
- **Usage chips read `92%` instead of `92% wk`.** The column heading already names the window.
- **An instance's folder moved into the row tooltip.** Rows are about half as tall.
- **The last tab you used is remembered across reloads.**

### Fixed

- **A CLI instance carried across the rename no longer loses its login.** Its saved folder is now found at the new location and any credentials left at the old one are moved across.
- **The CLI instances heading no longer shows a bare `(0)`.** It reads "(0 of 1)" when every CLI instance is linked to a desktop instance.

## [0.14.0] - 2026-08-04

**TL;DR**

- **CC Manager UI is now AgentHydra, with a new logo**
- **Deleting an account cleans up everything kept under its name**
- **An instance signed into a different account shows the new account**
- **Codex and OpenCode sessions explain why they have no reply box**

**Everything in 0.14.0**

### Changed

- **CC Manager UI is now AgentHydra.** The upgrade is designed to be uneventful: your settings, run queue, instance labels, accounts cache, database and saved interface preferences are carried over, and older update paths keep working. The Windows executable, tray script and icon are renamed, so desktop shortcuts to the old executable need re-creating once.
- **New logo.** A three-headed hydra replaces the old mark. The accent color and theme are unchanged.

### Fixed

- **Deleting an account no longer leaves CLI instances pointing at it.** Instances that used it are detached and show as unassociated instead of failing their usage check. Its last usage reading, usage history and auto-resume setting are also removed.
- **An instance signed into a different account no longer shows the old account.** Identity is checked against the current login, stale identities are discarded, a sign-in change is picked up within seconds, and email, name and plan changes catch up without a restart.
- **Codex and OpenCode sessions now say they are read-only here.** They name the tool to continue in, instead of leaving a gap where the reply box would be.

## [0.13.0] - 2026-07-30

**TL;DR**

- **Quick instance mode opens a compact launcher without the heavy background services**
- **The Sessions list no longer stalls on first load**
- **Sessions list speed no longer depends on transcript folder size**

**Everything in 0.13.0**

### Added

- **Quick instance mode.** A compact Claude and Codex instance launcher opens without starting the session scanner, queue, scheduler, usage refresh, settings sync or updater. Start it from the Instances shortcut or the shortcut action in Settings.

### Fixed

- **The Sessions list no longer stalls the app on first load.** Parsed transcript details are cached on disk, so a restart is warm and memory stays bounded.
- **Sessions list speed no longer depends on the size of your transcript folder.** The file index is served from a snapshot and refreshed in the background, while a newly created transcript is still found straight away.

## [0.12.2] - 2026-07-28

**TL;DR**

- **Resuming a chat now uses the desktop instance that owns it**
- **Archived conversations are shown by default**
- **Weekly quota walls are recognized as rate limits**

**Everything in 0.12.2**

### Changed

- **Resuming a chat uses the desktop instance that owns it.** A Claude Desktop conversation no longer falls back to an unrelated CLI login. The composer shows this default and lets you pick another instance, the ambient login or a saved account.
- **Archived conversations are shown by default.** Session source badges are easier to tell apart, and scheduling is now the main Queue action in the composer, with immediate queueing one click away.

### Fixed

- **Weekly quota walls are recognized as rate limits.** Affected runs are parked as rate-limited and can be resumed after the reset instead of being reported as failures.
- **Option menus no longer show empty entries.** The composer and queue builder no longer list blank model, effort or permission choices.

## [0.12.1] - 2026-07-26

**TL;DR**

- **Codex Desktop instances can run side by side**
- **Provider settings and a manual ChatGPT handoff**
- **Codex sessions match the chats Codex Desktop shows**
- **Windows gets a single-file executable with an icon**

**Everything in 0.12.1**

### Added

- **Codex Desktop instances can run side by side.** Each managed Codex instance has its own login and local state, so work, personal and client accounts get independent windows. The Instances view shows which are running and can open, focus or quit each one.
- **Provider settings and a manual ChatGPT handoff.** Claude Desktop, Claude CLI, Codex Desktop and Codex CLI can each be shown or hidden. An opt-in composer action builds a size-limited, secret-screened repository summary, copies the task prompt and opens ChatGPT, without automating your account.

### Changed

- **Windows releases include an icon-bearing single-file executable.** A compact ZIP is kept for automatic updates, and the web interface is built in.
- **Settings sync is safer across several devices.** First-account setup is atomic, nested changes no longer conflict, and a stuck network request can no longer delay shutdown.

### Fixed

- **Codex sessions match the chats Codex Desktop shows.** Titles come from Codex's own sidebar, and subagent files no longer appear as separate duplicate sessions.

## [0.11.1] - 2026-07-23

### Fixed

- **Session-sharing notes were folded into the main reference.** The standalone notes were removed, and one slow-startup case on Windows no longer fails a correct run.

## [0.11.0] - 2026-07-23

**TL;DR**

- **Claude, Codex and OpenCode conversations share one Sessions view**
- **Codex CLI instances can be managed alongside Claude instances**
- **Codex and OpenCode stay read-only, so they cannot affect Claude runs**
- **OpenCode search is far lighter on memory**
- **Security hardening: loopback-only access, bounded inputs, safer searches**
- **A failed account lookup now fails the run instead of using another login**

**Everything in 0.11.0**

### Added

- **Claude, Codex and OpenCode conversations share one Sessions view.** Every row shows its source, and search, transcript view, done marks and the MCP session tools all understand it. Codex active and archived chats and OpenCode CLI and Desktop chats are covered, and injected runtime blocks stay out of the transcript.
- **Codex CLI instances can be managed alongside Claude instances.** Create an isolated Codex home, open its login, launch it in a terminal, rename it, or delete it with an exact-name confirmation.

### Changed

- **Codex and OpenCode are read-only conversation sources.** Queue and session composers, rate-limit discovery and instance filtering stay Claude-only, and OpenCode's database is never offered as a download.
- **OpenCode full-text search uses far less memory.** Large tool output is no longer loaded just to search it.
- **Manually added account credentials stay portable.** A short-lived encryption step that tied them to one machine and user was reverted, and any affected entries convert back.

### Fixed

- **Session details are cached once per transcript.** An active transcript no longer keeps one cache entry per new turn.
- **Scheduler and monitor numbers are bounded.** Changing the scheduler poll interval takes effect immediately instead of after a restart.
- **Folder checks are stricter.** A sibling folder with a similar name is no longer treated as inside the instances folder.
- **Queue writes reject malformed values.** Bad statuses, positions, account references and launch options can no longer create invalid saved state.
- **A selected account that cannot be read now fails the run.** It no longer silently falls back to the ambient login.

### Security

- **The passwordless app now refuses any non-loopback address.** Sign-in callbacks are limited to the same addresses, and request bodies are capped.
- **Session-search patterns are checked before they run.** Overly long or dangerous regular expressions can no longer stall the search.
- **Terminal launch model and effort values are validated.**

## [0.10.0] - 2026-07-23

**TL;DR**

- **Copy a session's file location as text**
- **Shut down the whole app from Settings**
- **Settings puts everyday controls up front**
- **The version number shows update status and applies updates**
- **Generic Anthropic tiers are shown as Free**
- **README screenshots regenerate and match the interface**

**Everything in 0.10.0**

### Added

- **Copy a session's original file location.** The transcript header and the session row's right-click menu now offer to copy the exact location of the session's file to the clipboard.
- **Shut down the whole app from Settings.** A two-click power control beside the Settings close button exits the app and tells the tray to quit too. Before, stopping it from the web UI left the tray free to start it again straight away.
- **Scoping notes for Codex, ChatGPT and OpenCode support.** A research note records what was found about their session storage and what a future implementation would need.
- **README screenshots regenerate on demand.** They are rebuilt from invented data, so no real chats or accounts appear in a public image, and a missing fixture fails the run instead of leaking live data.
- **The tray launcher can forward dropped files and folders.** Apps that want dropped paths can opt in; ordinary launches are unchanged.

### Changed

- **Settings puts the everyday controls up front.** Theme selection moves to the panel header, and tooltip and transcript-editor options sit under an Advanced section in Appearance.
- **The version number is the update status and control.** It is green when current, amber when an update can be applied, and red when checking is blocked. Hover to see why; click to check again or apply the update.
- **Generic Anthropic tiers are shown as Free.** An expired paid plan no longer keeps showing as Pro or Max in the Plan column.
- **README screenshots match the current interface.** Sessions, Instances and Queue were recaptured on the current theme.

## [0.9.0] - 2026-07-21

**TL;DR**

- **The interface follows Claude's own surfaces, with three distinct grounds**
- **The accent is no longer used as a background wash**
- **Text fields paint a real surface and outline**

**Everything in 0.9.0**

### Changed

- **The interface follows Claude's own surfaces.** The window was one near-black sheet. It now has three grounds: darkest chrome for the top bar and session list, a lighter working area, and raised cards, popovers and table headers. The accent moves from magenta to a dusty rose, and the greys are neutral with no brown cast.
- **The accent is no longer a background wash.** The selected session row and your own chat bubbles were tinted with the accent, which looked like muddy maroon. They are now a neutral raised grey, and the accent stays for Send, Queue and checked states.
- **Text fields paint a real surface and outline.** Search and composer boxes had come out too dark with no visible edge. They now have a solid surface and a clear outline.

## [0.8.0] - 2026-07-21

**TL;DR**

- **The Instances table has a sortable Plan column**
- **Usage refreshes as soon as you open Instances**
- **The account cell shows a short name, not an email**
- **The README now shows the app**

**Everything in 0.8.0**

### Added

- **A Plan column in the Instances table.** The account type (Free, Pro, Max, Max 20×) has its own sortable column next to Usage. When the plan cannot be determined it shows a dash rather than an internal label.

### Changed

- **Usage refreshes on load.** Opening Instances re-checks every desktop and CLI instance right away instead of showing old numbers until you press refresh. Reading quota costs none.
- **The account cell shows a name, not an address.** It shows the account's short name, reveals the email on hover, and leaves the plan to the new column.
- **The README now shows the app.** It gained three screenshots, one per view, made from invented data so nothing private is in a public image, and its text is organised around those views.
- **Version history is filed under the right releases.** Entries for 0.5.0 had been written into 0.6.0; each now sits under the release that shipped it, and two changes that had never been recorded are listed.

## [0.7.0] - 2026-07-18

**TL;DR**

- **The session list has a time window (24 hours by default)**
- **Finished runs can be cleared from the queue**
- **Scheduler indicators are clickable and lead to the scheduler settings**
- **Instances and CLI sections are collapsible**
- **Queue scheduling uses the same date picker as the composer**
- **The session list shows real conversations, not quota checks and warnings**
- **The auto-resume monitor only lists work that still needs attention**
- **The instance editor applies as you type**

**Everything in 0.7.0**

### Added

- **A time window on the session list.** It defaults to the last 24 hours, and the list menu offers 7 days, 30 days and all time. The window applies before the newest-sessions cap, so widening it really reaches further back. If the window leaves the list empty, it offers a one-click switch to all time.
- **Clear finished runs from the queue.** The finished-runs section has a Clear button with a two-click confirm, so you no longer delete completed, failed and cancelled runs one by one.
- **Scheduler indicators lead somewhere.** The on/off indicator in the queue drawer and the header chip both open Settings at the scheduler section, which pulses briefly so you can see where you landed.
- **Collapsible Instances and CLI instances.** Each heading is now a toggle and the choice is remembered.
- **Queueing a run for later uses the composer's picker.** It offers in 5 hours, tomorrow at your configured time, hour and 10-minute steps, or an exact date, and has moved up beside Account.

### Changed

- **The instance editor applies as you type.** Name, icon and colour update the table live; the preview is gone and the button says Done.
- **The transcript editor setting stays out of the way.** The row says which editor will open a transcript, and the path field appears only if you want to override it.
- **The create buttons are icons until you hover.** They show a plus and expand to their label on hover or focus.
- **Settings no longer has an Accounts section.** It only redirected to the Instances tab; accounts are still managed there, and per-account auto-resume overrides still list them.

### Fixed

- **Sessions were named after a warning notice.** Many sessions showed the CLI's own caveat text as their title. Titles now skip it, and a session whose prompt arrives wrapped in a tag, such as a scheduled task, shows that task's name.
- **The list was full of sessions that were never conversations.** Quota checks created empty throwaway sessions. Such sessions are no longer listed, quota checks run in their own folder, and they clean up after themselves.
- **The auto-resume monitor listed finished work.** Finished, cancelled or deleted resumes kept showing as scheduled. The list now reflects what actually happened, keeps failed resumes visible, and ignores archived sessions.
- **Advanced options in the queue builder were broken.** The Model, Effort and Permission dropdowns failed on their Default entry and took the rest of the section down with them.
- **Settings spacing.** The auto-resume monitor sat flush against the scheduler card and lost its row dividers; both are fixed.
- **One instance could occupy several usage cache rows.** On Windows, different spellings of the same folder missed the cache and re-ran the check. They are now treated as one.

## [0.6.0] - 2026-07-17

**TL;DR**

- **"Filter by instance" no longer opens off-screen and freezes the app**
- **"Open the session file" opens an editor instead of asking which app to use**
- **Right-click menu on sessions**
- **Mark a session as done**
- **Archived sessions are recognised and hidden by default**
- **One list-options menu replaces the toolbar icon row**

**Everything in 0.6.0**

### Added

- **Right-click a session.** The list has a context menu to mark as done, open the transcript, open or copy the session file, and copy the title, folder or id. It acts on the row under the pointer without selecting it.
- **Mark a session as done.** The row keeps its place but is dimmed with a check and a struck-through title. Marks are stored by the app, not the browser, and a menu item clears them all.
- **Archived sessions are recognised.** The app reads Claude's own archive flag and hides archived sessions by default. A three-way control (Hidden, Shown, Only archived) lets you find them, and hiding still returns a full list of live sessions.
- **One list-options menu.** Refresh, multi-select, the instance filter and the archive scope now live in one menu that lights up whenever something is narrowing the list.

### Fixed

- **"Filter by instance" opened nothing and froze the app.** The menu rendered off-screen and blocked clicks on the page until you pressed Escape. The advanced-search popover next to it had the same fault and is fixed too.
- **"Open the session file" asked which app to use.** The app now picks an editor itself (VS Code, Cursor, Notepad++, Sublime, else Notepad), so Windows' picker never appears. A new Transcript editor setting overrides it, and a bad path falls back to auto-detect.

## [0.5.0] - 2026-07-16

**TL;DR**

- **Console windows no longer flash during ordinary operations**
- **Runs no longer get stuck after crashes, and Cancel can't kill unrelated programs**
- **Temporary server overloads are retried instead of failing the run**
- **The composer no longer falsely claims the session is busy**
- **Auto-resume finds quota stops in sessions you started yourself**
- **Downloaded transcripts are named after the session title**
- **Copy the session file to the clipboard as a real file**
- **A 10-minute stepper in "queue for later"**

**Everything in 0.5.0**

### Added

- **Copy the session file to the clipboard.** A button beside "save a copy" puts the actual file on the clipboard, named after the session, so you can paste it into a folder, chat or email. Windows and macOS only.
- **A 10-minute stepper for "queue for later".** It sits beside the hours stepper, and one button queues the combined delay. The fixed 15-minute and 1-hour presets are gone; In 5 hours and Tomorrow remain.
- **The scheduler chip in the header is a link** to the setting it reports on.

### Changed

- **Pink means "you can click this now".** Queue for then, and the hours/minutes button, stay grey until they can do something.

### Fixed

- **Stray console windows flashed on ordinary clicks.** Background programs now start without a visible window however the app was launched, including the periodic usage check that could blink a window on a schedule.
- **A run could be stuck "running" forever after a crash.** After a restart the app trusted a stale process number that could belong to another program, so a session showed busy with nothing running and Cancel could have killed that program. Such runs now fail cleanly with the work already done kept on disk.
- **A temporary server overload was treated as your rate limit.** The run died and was parked against a reset that did not apply. Overloads are now told apart from quota limits and retried automatically, three tries over about 35 seconds, only when the run had produced no output. If it still fails it gets its own Overloaded status, and runs wrongly filed before are corrected.
- **The composer claimed the session was busy right after you hit send.** The hint now appears only while there is a draft it could apply to.
- **Auto-resume was blind to sessions it had not launched.** It now also finds sessions that stopped at a 5-hour limit in the last 12 hours, including ones you started in a terminal or the desktop app. They go through the same safety checks and carry a Found badge. It is still off by default.
- **A downloaded transcript was named after the session id.** It is now named after the session title, with unsafe or reserved characters removed and non-Latin titles supported.

## [0.4.0] - 2026-07-16

**TL;DR**

- **The portable window opens at a usable size instead of filling the screen**
- **Launching onto an already-running portable window sizes it correctly too**
- **The local-only request guard is one shared, audited implementation**

**Everything in 0.4.0**

### Added

- **The portable window opens at a usable size.** A first run used to open at roughly the whole screen. It now opens at a comfortable size and then follows the placement you saved, so a size you chose yourself always wins.
- **A launch onto an already-running portable window sizes correctly.** The new window used to inherit the running window's geometry. The page now corrects itself once at startup, and only inside a real app window; a maximized window is left alone.

### Changed

- **The local-only guard is shared with the other LunarWerx apps.** The protection that stops a malicious web page from driving the local app now lives in one reviewed place. Browsers behave as before; tools that send no host header are now also allowed.

### Fixed

- **A release build could fail while checks passed.** An out-of-date copy of a shared helper broke the packaged build; it is back in sync.

## [0.3.0] - 2026-07-16

**TL;DR**

- **Quota percentages become forecasts you can plan with**
- **Usage checks work with the app closed and are 25-50x faster**
- **Every usage check carries an advice verdict**
- **CLI instances are managed, linked to desktop instances, and usable for usage checks**
- **Usage refreshes in the background by default**
- **The auto-resume monitor (opt-in) catches rate limits and resumes after the reset**
- **The run builder leads with essentials; Settings is one page; finished runs fold away**
- **Fixes for false rate-limit detection, stray console windows and quitting your real Claude Desktop**

**Everything in 0.3.0**

### Added

- **Quota forecasts.** "98% used" is not enough to plan with, so the app turns saved readings into a burn rate, hours of headroom, and whether you will run out before the reset. It also estimates the size of one percent as a number of assistant turns. A new usage budget tool exposes this.
- **Usage tools work with the app closed.** Checking your own usage, listing usage and the budget run on their own when the app is not running. Queue tools still require the app, so two programs never manage runs at once.
- **Much faster usage checks.** Usage is now read straight from Anthropic instead of launching the Claude program, about 25 to 50 times faster. It also gives exact reset times, a severity level and per-model weekly limits. The old method remains as a fallback when there is no usable sign-in, and the app never refreshes your login itself.
- **Link a CLI instance to a desktop instance.** When both are the same account, each can stand in for the other when a usage check cannot use its own sign-in.
- **Background usage refresh, on by default.** A staggered sweep keeps every instance's usage current without a manual refresh. The toggle and interval are in Settings, beside toggles to show or hide the desktop and CLI tables.
- **An advice verdict on every usage check.** Results include severity, the binding percentage, whether to offload work, and whether it is safe to fan out.
- **Self-check works from a normal Claude Code session.** It falls back to your default login, and a new list tool surveys every managed instance so you can pick an account with headroom.
- **A CLI login is a usage-check source on its own.** A CLI instance that has logged in provides what is needed without any desktop instance.
- **CLI instances.** The Instances view now manages command-line instances next to desktop ones: create, open a terminal, a one-click Log in helper, link to an account, rename, and a guarded delete. No tokens are stored.
- **Usage checks per instance.** Check an account's session, weekly and per-model quota. It works for a desktop instance on its own sign-in, a registered account, or a logged-in CLI instance. Results appear as a colour-coded cell in the Instances table with a hover breakdown, and agents can use a self-check tool.
- **Guidance for AI agents.** A short guide and README note explain how agents can read their own quota and that the weekly all-models percentage is the cap to pace by.
- **Auto-resume monitor (off by default).** A session killed by a 5-hour rate limit can resume after the window clears, unless the weekly cap is maxed. It has a per-session attempt cap, a global switch with per-account overrides, and a status chip.

### Changed

- **Finished runs fold away in the queue.** They sit behind a "Show N finished" section, and the header counts only pending work.
- **The busy warning says what will happen to your message.** It now says whether the message will start on its own or wait for you to press Run.
- **Resume a session from a searchable list.** The run builder replaces the pasted id with a picker showing title, folder, branch and last activity, and several sessions can be picked at once to queue one run each.
- **The run builder leads with three fields.** Model, effort, permission, account and other options sit under Advanced options. Long prompts no longer push the dialog off-screen.
- **Settings is one scrolling page.** The tabs are merged, the table toggles moved to Appearance, monitor tuning sits under Advanced, and the monitor's empty state explains itself.
- **The queue's scheduler indicator is an icon with a hover.** It shows on and off at a glance, and the redundant Queue resume button is gone.

### Fixed

- **Quitting could kill your real Claude Desktop chat.** The regular, non-isolated Claude Desktop row now needs an explicit confirmation to quit, and the wording tells you to keep it open.
- **The MSIX warning banner could be wrong.** It now recognises a working classic install, re-checks after opening or creating an instance, and clears once you install the classic build.
- **A run pinned to an account could silently run as another.** Expired, deleted or malformed pins now fail loudly, and auto-resume keeps the pin.
- **A queued run's account was not shown.** The card shows the instance it will run as, and editing a run whose account was deleted no longer quietly changes it.
- **Deleting a desktop instance could orphan its CLI login.** Both that and a failed CLI sign-in leaving a stray instance are cleaned up.
- **A recovered run could be dispatched twice after a restart.** The scheduler and monitor now wait until surviving runs are re-adopted.
- **A run that merely talked about rate limits was marked rate-limited.** Only the CLI's own error reports count now, and past mislabelled runs are repaired on startup.
- **Auto-resume did nothing unless you had added an account.** Runs that use your existing login are now resumed like any other.
- **Sending a message opened a console window for the whole run.** Closing it killed the run. The window is now hidden.
- **The session view showed the CLI talking to itself.** Canned "Continue from where you left off" turns are filtered out; the rate-limit notice still shows.
- **"exit -1" now explains itself.** The badge reads "interrupted", and a failure while recording an event no longer takes down the run.

## [0.2.0] - 2026-07-13

**TL;DR**

- **Instances show a customizable icon and colour**
- **Instances are named after the account, not the folder**
- **Accounts resolve on their own; the Resolve button is gone**
- **Quota numbers stay current while you watch the table**
- **Renaming is instant and works while the instance is running**
- **Running rows lead with Focus**
- **The burn-rate forecast no longer gives a false "safe" signal**
- **Rebuilds no longer leave a stale app running**

**Everything in 0.2.0**

### Added

- **Per-instance icon and colour.** Each row shows a customizable glyph instead of the green dot, chosen from the row's menu with a live preview. A running instance gets a pulsing badge and a stopped one dims. Uncustomized instances get a stable default of their own.

### Changed

- **Instances are named after their account.** The account's profile name, or the start of its email, is the default name ahead of the folder name, and a label you set still wins. Sessions and the Instances table now always agree on a name.
- **Accounts resolve themselves.** Stopped instances resolve as well as running ones, instances with no identity yet are retried once a minute, and the Resolve button is removed. Refresh re-resolves everything for the rare stale case.
- **Quota numbers stay current while you watch.** The open Instances tab now follows the app's cache every few seconds instead of freezing on its first reading. This costs no quota.
- **Fewer divider lines on the Instances screen.** The two tables are separated by space, and the redundant toolbar borders are gone.
- **Renaming is instant and works while running.** The name is now a display label, so it no longer needs the profile folder to be renamed, which Windows blocks while Claude Desktop is open.
- **Running rows lead with Focus.** Focus brings the window forward, and Quit moves into the menu so it is deliberate.
- **Header cleanup.** The redundant New run button is gone from the header, two divider lines were dropped, and the sessions list and filter show each instance's display name.

### Fixed

- **A burn rate of "zero" no longer means "work freely".** Because the percentage is a whole number, a slow burn looked like none and the forecast said you would never hit the cap at 98% used. The forecast is now deliberately pessimistic, and says unknown when it cannot tell.
- **Rebuilding could leave a stale app serving old code.** The restart now finds the app even when its record is missing, stops only processes that identify as this app, and checks that the new one actually started after the restart.
- **Odd request bodies no longer cause server errors.** Creating an instance also starts it with a clean appearance, so a reused name never revives an old label, icon or colour.

## [0.1.0] - 2026-07-13

**TL;DR**

- **Warns when only the unusable Microsoft Store build of Claude Desktop is installed**
- **Portable mode opens the app in its own window**
- **An MCP server exposes sessions, queue and instances to Claude**
- **Optional background auto-update**
- **Quitting no longer closes the Claude Desktop instances it launched**
- **Queue moved to a slide-in drawer and Settings split into tabs**
- **Instance discovery, menus, toasts and drawers fixed**
- **The default port moved to 7787**

**Everything in 0.1.0**

### Added

- **Warning for the Microsoft Store build of Claude Desktop.** That build cannot be launched with separate profiles, so the Instances tab shows a banner with a link to the classic installer when only it, or nothing, is installed.
- **Portable mode.** A setting opens the app in its own chromeless browser window instead of a tab. The window has its own profile, so it remembers its size and position, and both the in-app toggle and the tray launcher use it.
- **An MCP server.** It exposes the sessions, queue and instances to Claude Code and Claude Desktop.
- **Background auto-update.** Off by default, it checks on a schedule and updates and relaunches unattended, but never touches a working copy with local changes.

### Changed

- **The queue is a slide-in drawer.** It opens from a header button with a running-count badge and sits beside Sessions or Instances. Only one drawer is open at a time.
- **Settings is split into tabs.** General, Scheduler and Accounts replace one long scroll, and the save button stays visible on every tab.
- **One Updates group that explains itself.** Auto-update is merged into it, and when updates cannot be checked it says why and greys out the related options.
- **Queue resume lives in the queue drawer.** The transcript header button opens the drawer, and Show tool activity became an icon toggle.
- **The multi-select banner shows only a count.**
- **Cleaner chrome.** The composer, drawer headers and footers lost their divider lines, the scheduler pill left the top bar, New run became an expanding icon button, and the Queue page explains itself.
- **The default port moved to 7787.** The old one clashed with other local dev servers. The app still hops to a free port if it is busy.

### Fixed

- **Quitting closed the Claude Desktop instances it launched.** Instances now start outside the app's process tree and survive Quit.
- **The Instances "More actions" menu opens again.** A nested tooltip had swallowed the click.
- **The refresh icon no longer spins on every poll.** It spins only on first load or when you ask.
- **Instance discovery handles profile paths with spaces.** Such instances no longer show as stopped or as stray external rows.
- **Toasts render as real toasts.** The queued-message confirmation had lost its card, border and shadow.
- **Open drawers no longer cover the header buttons.** They shift left to stay clickable.
- **Push panels no longer crush the centred layout.** The shift now matches the real overlap, so opening Settings no longer squeezes the Instances table.
- **The app keeps working when its port changes.** The page now talks to the app by relative address instead of a fixed port.
- **The free-port check no longer picks a port held on another interface.** This closes a race with other local tools.

