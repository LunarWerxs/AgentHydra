# AgentHydra

> One local dashboard that unifies Claude Code, Codex, and OpenCode sessions, and can reply into live chats.

<!-- odin:about HAND-OWNED above the GENERATED marker. Edit freely; `odin codex about --ingest` carries it back into Odin's Codex. -->

## What it is

AgentHydra is a local dashboard for AI coding agents that unifies Claude Code, Codex, and OpenCode session history from one machine into a single browser tab. It lets you read and live-tail any session, reply straight into running Claude sessions (singly or in bulk), queue and schedule `claude` CLI runs with automatic rate-limit resume and cross-account failover, see cost/usage analytics, and manage isolated Claude Desktop and Codex Desktop/CLI accounts side by side. There is no cloud service or account signup; it reads the local stores the CLIs and desktop apps already write and talks only to localhost, with a Windows system-tray launcher and an MCP server so agents can drive all of it themselves. Formerly named CC Manager UI.

## Things not to forget

_The intricacies worth remembering: the gotchas, the half-built parts, the decisions whose
reason lives nowhere else. Odin never overwrites this section._

- add_queue_item and launch_terminal_session are refused on every call (HTTP 409) on this machine under the no-headless law - a literal false in headless-policy.ts - so new work on another account has to go through fan_out or spawn_chat as a visible desktop chat instead. anchors: `server/src/mcp.ts:969`
- Rate-limit auto-resume and cross-account failover are both off by default and trust only the CLI's own error report as evidence of a quota stop - model prose or tool output never counts, and a transient 529 that clears on its own is not a stop. anchors: `server/src/rate-limit-signal.ts:143`
- Auto-update is opt-in and git-pull based: a background tick checks origin/main and only pulls, reinstalls, rebuilds and relaunches on the same port if the working tree is clean, so a push to main is effectively the release. anchors: `server/src/updater.ts:38`
- redeem_codex_reset_credit refuses to spend a banked Codex /usage reset credit unless the busiest rate-limit window is already 100% used (force bypasses the guard), so a credit is not wasted redeeming early. anchors: `server/src/mcp.ts:1554`
- Deleting a chat inside Claude Desktop only removes the app's own record, not the transcript; only delete_chat's --released sweep finds and clears the leftover <sid>.desktop-released.json markers left on disk (14 markers / 12 transcripts measured 2026-09-04). anchors: `orchestrator/scripts/delete_chat.py:428`
- UI-automation actuators that hunt for a chat row (archive/rename/delete) must collapse any sidebar project group they expanded, via a finally block that runs whatever the outcome, because earlier versions left the user's sidebar permanently rearranged. anchors: `orchestrator/scripts/actuator/manage_desktop_chat.ps1:419`
- The native tray host wraps its daemon launch command in one extra quote pair and forces null stdio, because cmd.exe otherwise silently swallows the launch (reports success with no daemon running) and inherited terminal pipes can block the daemon before it ever binds its port. anchors: `misc/tray-host-native/src/daemon.rs:126`

<!-- odin:about GENERATED BEGIN - rewritten by `odin codex about --publish`; edit the Codex, not this -->

## What Odin knows about this project

Everything from here down is generated from this project's Codex dossier
(`codex/projects/agenthydra.md` in the Odin clone) and is **rewritten on every publish** -
edit the dossier, not this block. Everything ABOVE the marker is yours.

### At a glance

- **Ships as:** desktop app (Windows/macOS/Linux) - GitHub release installer/ZIP (PowerShell one-liner or direct .exe) with a Windows tray launcher, or run from source with Bun; presents a local web UI at http://localhost:7787
- **Live at:** https://agenthydra.lunarwerx.com
- **Written in:** TypeScript (480 files), Vue (262 files), Python (137 files), JavaScript (25 files)
- **Built with:** Hono, Tailwind, TypeScript, Vite, Vue
- **Package:** `agenthydra` 0.38.3
- **Entry points:** `scripts`, `workspaces`
- **Tests:** 246 test file(s)
- **CI:** `ci.yml`, `release.yml`
- **Domain:** ai coding agents, claude code, codex, opencode, session/transcript management, usage and quota tracking, multi-account isolation, local-first dashboard, rate-limit handling
- **Remote:** https://github.com/LunarWerxs/AgentHydra.git

### Architecture

- `server/` - Bun + Hono daemon: sqlite (queue/dispatch/scheduler/accounts), Claude/Codex/OpenCode/foreign session readers, transcript tail, dispatch of the real claude CLI, scheduler, instance runtime pointer, core/ (Claude+Codex Desktop/CLI instance lifecycle), and the MCP server (mcp.ts) that exposes the whole API to agents
- `web/` - Vue 3 + Vite SPA (Sessions / Queue / Instances / Analytics views) on a shared LunarWerx UI kit (shadcn-vue on Reka UI) and Tailwind v4
- `orchestrator/` - the v3 Python toolbox (stdlib only, orch.py + scripts/) that decides what SHOULD happen to a chat - dry loop, sweep, moving chats between accounts, archiving, naming, tray-icon arm/disarm - talking to the daemon over HTTP only; has its own remote server+web front-end
- `misc/` - Windows launcher toolkit: a native Rust tray host (tray-host-native/) that opens the daemon UI as a portable window and starts/probes/stops the daemon, plus PowerShell daemon-supervisor and shortcut/icon scripts
- `tests/` - the Windows-gated tray launcher guard plus server/instance unit tests
- `scripts/` - repo tooling: the README screenshot generator (fixture-driven, never a live daemon) and scripts/checks/ guardrails, each written from a bug that shipped
- `docs/` - REFERENCE.md (config/MCP/stack/checks), AI_USAGE_SELFCHECK.md, MOVING-CHATS-BETWEEN-ACCOUNTS.md, RELEASING.md, and docs/todo/ (harvested open items)
- `.github/` - CI workflows: ci.yml (ubuntu-latest + windows-latest) and release.yml

### Features

26 recorded - 26 shipped, 0 partial, 0 planned. Each `path:line` is where the feature is DEFINED, checked by `odin codex check`.

**Shipped**

- **Foreign-tool session reading (Cursor, Windsurf, Zed, Copilot CLI)** - A shared adapter reads and lists session history from other AI coding tools alongside Claude/Codex/OpenCode, read-only. - `server/src/foreign-sessions.ts:39`
- **Reply into live Claude sessions, single or bulk** - Type a message straight into a running Claude session from the browser without finding its terminal, or select several sessions and broadcast the same message to all of them. - `server/src/dispatch.ts:1035`
- **ChatGPT handoff (context pack)** - Turns a task and working directory into a bounded, secret-scrubbed Markdown attachment, downloads it, copies a matching prompt and opens ChatGPT for the user to attach and submit themselves. - `server/src/context-pack.ts:215`
- **Run queue with scheduler** - Queue claude CLI runs, each with its own prompt, cwd, model, effort, permission mode and account; run on demand or let the scheduler drain the queue with spacing, and give any run a start time instead of maintaining a cron job. - `server/src/dispatch.ts:1035`, `server/src/scheduler.ts:43`
- **Runs reattach after restart** - Quitting the app or letting it auto-update does not kill in-flight runs; the daemon picks them back up. - `server/src/dispatch.ts:435`
- **Rate-limit auto-resume & cross-account failover** - Detects a Claude session stopped by a 5-hour rate limit (trusting only the CLI's own error report) and, once the window resets, resumes it on its own, gated on weekly usage; with several accounts signed in it can instead move the run to one with headroom and continue immediately. Both are off by default. - `server/src/rate-limit-signal.ts:143`, `server/src/monitor.ts:359`
- **Chats a usage limit cut off** - Lists conversations a quota wall ended, split into pending (still stopped there) vs. resumed-since, surfaced in the session list as a filter and via the shared limit-stop judgment used by auto-resume. - `server/src/rate-limit-signal.ts:143`
- **Cost & usage analytics** - Cost by day/model/project/account, session and agent-hour tiles, an hour-of-week activity grid, and which sessions are worth a second look; computed while the session list is built (no message text kept), now including Hermes Agent sessions priced through AgentHydra's own model catalog since Hermes totals its own session cost rather than per-event, and also printable via `AgentHydra.exe --spend --json`. - `server/src/analytics.ts:174`, `server/src/analytics.ts:251`
- **Claude Desktop instance management** - Create, open, focus, quit and delete isolated Claude Desktop profiles, each with its own account, custom name, icon and colour; see process, memory and uptime while running, and see its paired isolated CLI login alongside it. - `server/src/core/lifecycle.ts:192`, `web/src/lib/instance-appearance.ts:118`, `server/src/routes/instances.ts:79`
- **Codex Desktop/CLI instance management** - Manages isolated Codex Desktop profiles and CODEX_HOME CLI homes the same way, so separate OpenAI logins run in separate Codex windows; open/focus/quit the desktop and launch/log-in the CLI from the same row. - `server/src/core/codex-instances.ts:314`
- **Quick instance mode** - A compact portable window with just Claude Desktop/CLI and Codex start/focus/stop controls, skipping the session scanner, database, queue, scheduler, monitor and updater; runs its own lightweight daemon on a separate port and can coexist with the full manager. - `server/src/fleet-instances.ts:73`
- **Windows system tray & native launcher** - A native Rust tray host opens the daemon's UI as a portable chromeless window, remembers window placement, and starts/probes/stops the daemon by matching /api/health's own service identity so a neighbouring dev server on another port is never adopted or killed. - `misc/tray-host-native/src/daemon.rs:126`, `misc/tray-host-native/src/main.rs:68`
- **Auto-update (opt-in, git-pull based)** - An opt-in background tick checks origin/main and, only if the working tree is clean, pulls, reinstalls, rebuilds and relaunches itself on the same port; a push to main is effectively the release. - `server/src/updater.ts:38`
- **MCP server exposing the full API to agents** - Sessions, queue, accounts, scheduler, Claude/Codex instances, failure incidents, usage checks (including redeeming a banked Codex rate-limit reset credit) and the orchestrator are all exposed over MCP stdio, so Claude Code, Claude Desktop or Cursor can drive AgentHydra directly; mutating tools are marked MUTATES: in their description and there is deliberately no shutdown tool. - `server/src/mcp.ts:2241`, `server/src/mcp.ts:41`, `server/src/mcp.ts:1554`
- **Agent self-identification & quota self-check** - whoami works out which Claude/Codex account the calling process bills to via layered signal detection with a confidence level; check_usage/check_my_usage read that account's session (5h) and weekly quota before a fan-out, so an agent can pace itself without asking a human. - `server/src/usage-service.ts:66`, `server/src/usage-service.ts:129`
- **Orchestrator: standing decision loop for chats** - A sibling Python toolbox decides what SHOULD happen to a chat - a dry loop, a sweep, moving chats between accounts, archiving, naming, and the tray-icon arm/disarm switch - driven only through the daemon's MCP tools; nothing acts unless the tray icon is armed, and every attempt is counted. - `orchestrator/orch.py:438`
- **Repo guardrail checks** - Standalone Node-stdlib checks under scripts/checks/, each written from a bug that actually shipped (popper-root mispositioning, a self-matching WMI query, kit type drift, console-window spawn flags, untimed test subprocesses, an agent-catalog row whose path was never checked against upstream source), each proven by a guardrail test to fire on the broken shape and stay quiet on the fixed one. - `docs/REFERENCE.md:510`, `scripts/checks/catalog-row-provenance.mjs:1`
- **Email notifications on rate-limit reset / usage events** - Sends an SMTP email (own mailer, no third-party service) when a rate-limited session's window resets or another watched usage event fires, configured from Settings. - `server/src/reset-watch.ts:179`, `server/src/notify-smtp.ts:204`
- **DeepSeek Harness homes as instances** - Every `DSH_HOME` on the machine in one table: launch a
  hidden `dsh web` and its window, see which are serving and on what port, stop one, or give a
  second account its own home. The one-time `?token=` never leaves the daemon. -
  `server/src/core/dsh-instances.ts:1`
- **Unified session browser (Claude, Codex, OpenCode, Hermes, DeepSeek Harness)** - Browse, filter (provider/project/recency), search and live-tail Claude Code, Codex, OpenCode, Hermes Agent and DeepSeek Harness transcripts together in one list, newest first. - `server/src/sessions.ts:832`, `server/src/sessions.ts:1185`
- **Failure incident tracking** - Groups repeated queue-run failures by (scope, key, normalized error signature) into a durable incident instead of raising a fresh alert every time, tracked open -> acked -> resolved with automatic reopening if a resolved signature recurs; ack/list/resolve are exposed over MCP and notify by email/OS notification. - `server/src/incidents.ts:184`
- **Codex rate-limit reset credit redemption** - Spends one banked Codex `/usage reset` credit to restore the full 5-hour and weekly rate-limit windows in one shot; refuses unless the busiest window is already 100% used (bypassable with force) so a credit isn't wasted redeeming early. - `server/src/mcp.ts:1554`, `server/src/core/codex-account.ts:1`
- **Startup-liveness watchdog** - An unref'd timer armed at process entry and disarmed once the daemon's port is bound catches a boot that hangs before ever answering /api/health (a locked sqlite file, a stalled updater step, a port probe that never resolves); on timeout it logs the last phase reached and exits with a distinct code so the tray/service supervisor restarts it instead of it hanging forever. - `server/src/boot-watchdog.ts:1`
- **Move a chat between accounts in one call (move_chat)** - The MCP tool `move_chat {chat, from?, to?, title?, force?, wait_secs?, dry_run?}` fuzzy-matches a chat's title (case, punctuation, a misspelling) and resolves `from`/`to` by instance number, name, label, email, "here" (this process's own identity, exact match only) or "best" (most weekly-quota headroom among running desktop instances) - then drives the orchestrator's `migrate_chat` through every rail (hold, breaker, live-writer refusal, verified landing, source row settled) in one call instead of the dozen manual round trips it used to take. `--now` treats a chat with no outstanding background job as idle after 15s instead of the standing 300s quiet window; every landing is re-stamped to bypassPermissions and the mode reported back is what disk says after the app's boot re-save; `dry_run` plans without moving anything. - `server/src/mcp.ts:1655`, `orchestrator/scripts/migrate_chat.py:1775`, `docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md:3`
- **Fan-out: one task list over other accounts as visible chats (fan_out)** - The MCP tools `fan_out {tasks:[{cwd, prompt, title?}], per_account?, only?, exclude?, exclude_self?, open_closed?, force?, dry_run?}` / `fan_out_status {group?}` / `fan_out_send {group, text}` / `fan_out_delete {group}` wrap the orchestrator's `fan_out.py` the way `move_chat` wraps `migrate_chat`: one chat's task list is spread over OTHER accounts as visible desktop chats, one account each - accounts ranked by real quota room (open instances first, the calling account excluded), each chat spawned through `spawn_chat.py`'s deeplink one window at a time, the group kept in `orchestrator/state/fanouts.json`. `status` reads each member's gate verdict and last words (an unreadable liveness is reported as unknown, never gated into a verdict); `send` stops an idle engine and lets the daemon's message route boot the chat through the app's own composer (the native peer pipe never steers a chat nobody has clicked - measured on the first drill, 2026-09-04); `delete` runs `delete_chat.py` on every member, the cleanup a probe fan-out owes under the owner rule that a ping or account-identification chat is never left in an account. `add_queue_item` and `launch_terminal_session`, which look like this capability, are refused on every call by the no-headless law and now say so. - `server/src/mcp.ts:1884`, `orchestrator/scripts/fan_out.py:341`, `orchestrator/scripts/fan_out.py:557`, `docs/REFERENCE.md:435`
- **Delete a chat everywhere, with undo, and sweep what the app's own Delete leaves behind (delete_chat)** - `orchestrator_run delete_chat <chat> [--stop-idle] [--force]` removes ONE chat from every place it exists - the desktop meta record in every profile, the CLI transcript and every `<sid>.*` sidecar under every projects root - with an undo copy taken first into `orchestrator/state/trash/<sid>/` (`--undo <sid>` restores it and records an `undelete` mutation so `undo.py` can confirm it). Rails in order: one chat (ambiguity refuses), a hold (`--force` is a person's word), a live writer (`--stop-idle` stops only an IDLE engine through enginelib), then the running app's own Delete control (actuator `-Action Delete`: the row menu item by label, the confirm button found by DIFFERENCE - only a Delete-labelled button that appeared after the menu item fired), then the files, then verification through the dossier and the disk. `--released [--yes]` is the sweep of what Claude Desktop's own Delete leaves behind: the app drops the record and writes `<sid>.desktop-released.json` but keeps the transcript, so the chat stays on disk and in AgentHydra's list (12 such transcripts, 8 MB, measured 2026-09-05). - `orchestrator/scripts/delete_chat.py:319`, `orchestrator/scripts/delete_chat.py:428`, `orchestrator/scripts/actuator/manage_desktop_chat.ps1:66`, `server/src/mcp.ts:2073`
- **Actuators leave the sidebar as they found it and never mistake the composer placeholder for a draft** - Every UI-Automation actuator that hunts for a chat row (archive / rename / delete / delivery / the naming pass) used to expand the collapsed sidebar project groups and never fold them back, which is what the owner saw as 'something keeps clicking the repo names' (2026-09-05); the naming pass still expanded every short-named dropdown, model picker included. Now a group is identified positively by its 'New session in <group>' companion, every group a run opens is remembered, and a `finally` collapses them on the way out whatever the outcome. The delivery actuator also recognises the composer's known placeholder text ('Type / for commands', Send disabled) as empty instead of refusing every send into an idle chat as 'a draft that is not ours'. - `orchestrator/scripts/actuator/manage_desktop_chat.ps1:419`, `misc/Deliver-DesktopChat.ps1:474`, `orchestrator/scripts/actuator/rename_first.ps1:86`

### Where to add a new one

- **a new MCP tool exposed to agents** - add a tool definition + handler in server/src/mcp.ts beside the existing ones; label a mutating tool MUTATES: in its description anchors: `server/src/mcp.ts:368`
- **a new session source/provider reader** - implement the Adapter interface (list/listAsync/read) in server/src/foreign-sessions.ts and register it in ADAPTERS, or add a dedicated first-class reader like opencode-sessions.ts anchors: `server/src/foreign-sessions.ts:39`
- **a new queue/dispatch or scheduler behaviour** - extend server/src/scheduler.ts's tick and server/src/dispatch.ts's dispatchItem, which the queue, rate-limit resume and reattach-after-restart all share anchors: `server/src/scheduler.ts:43`, `server/src/dispatch.ts:1035`
- **a new orchestrator act (script)** - add one script under orchestrator/scripts/ following the one-script-per-act pattern with its own rails and tests, and register it in orch.py's menu grammar anchors: `orchestrator/orch.py:438`
- **a new isolated-instance kind (beyond Claude/Codex Desktop+CLI)** - follow server/src/core/lifecycle.ts's createInstance for a Desktop profile lifecycle, or server/src/core/codex-instances.ts for a CLI-home style anchors: `server/src/core/lifecycle.ts:192`, `server/src/core/codex-instances.ts:31`

### Gaps and wants

_Withheld: this repository is public, and the gap list is not published outside the private index._
_Read it with `python odin.py codex brief agenthydra` in the Odin clone._

---

_Generated by `odin codex about --publish agenthydra` on 2026-09-09 from a Codex dossier stamped 2026-09-05. Regenerate after the product moves; `odin codex about` reports drift._
<!-- odin:about GENERATED END sha=0a4126785f97 -->
