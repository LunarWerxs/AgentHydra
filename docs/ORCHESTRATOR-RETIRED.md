# The v1 orchestrator is retired

**Retired 2026-08-29, by owner order, ahead of a ground-up rebuild.**

AgentHydra shipped an optional orchestrator from 2026-08-25 to 2026-08-29: a deterministic
watcher daemon (60-second pass over live sessions, usage bands, git hygiene and a repo
backlog) paired with an interactive reviewer chat running `/orchestrate`, joined by an
action-gate proposal ledger, a courier delivery ladder, a placement balancer and a self-test.
The owner's verdict after four days of live operation was that it did not reliably do what it
was told, and that incremental fixes had had their chance. The whole subsystem was removed in
one cut, to be rebuilt from nothing, one piece at a time.

## Where v1 lives

- **Branch `archive/orchestrator-v1`** - the complete final state of the code, docs and tests.
- **Tag `orchestrator-v1-final`** - the same commit, annotated with an inventory.

Everything is there: `server/src/orchestrator*.ts`, `codex-orchestration.ts`, `orch-agent.ts`,
`proposals.ts`, `placements.ts`, `backlog.ts`, `new-chat-opening.ts`, sixteen test files, the
`/api/orchestrator/*` HTTP surface, seven MCP tools, `OrchestratorSettings.vue`, and
`docs/ORCHESTRATOR.md` + `docs/ORCHESTRATOR-HANDOFF.md` with the full design rationale and
measured delivery matrix.

## What was deliberately kept on main

General primitives the orchestrator merely used, which stand on their own:

- `/api/sessions/:id/migrate`, `import-desktop`, `desktop-archive`, `automation` - moving,
  importing and archiving chats. `launch-terminal` survives strictly as a USER-EXPLICIT
  primitive: since the no-console ruling (piece 7), no automated path opens a terminal.
- `chat-dossier` (minus its joins into the orchestrator ledger tables), backed by the
  extracted `live-registry.ts`.
- The auto-resume monitor, reduced and then re-lawed: a desktop-living thread's reset is
  recorded ("ready in its app"); a homeless thread is LANDED in a desktop app by import
  (no-console ruling, piece 7 - the old visible-terminal resume is gone, as are
  migrate-on-limit and the proposal-gated native revive, which went with the reviewer).
- The no-headless and surface-purity owner laws, which are enforced in the primitives, not in
  the orchestrator: they bind the rebuild too.

## Archiving under a running app, solved properly (2026-08-29, same day)

V1 papered over "archived but still in the sidebar" with a queued idle-restart. The real
mechanism (owner's call) is driving the running app's OWN archive control, and the final form
is FOCUS-FREE - no foreground steal, no mouse. `misc/Manage-DesktopChat.ps1` wakes the app's
accessibility tree (an MSAA poke - Electron builds the tree lazily), finds the chat row by
title, opens its "More options" menu via `ExpandCollapsePattern.Expand()`, and fires the
"Archive" item via `InvokePattern.Invoke()`. Both are pure UI-Automation pattern calls: no
SetForegroundWindow, no cursor. `Invoke` targets that exact element, so it can never land on
the "Delete" item beneath Archive - safer than the coordinate-click first cut it replaced.
Because the app itself performs the archive, the flag is immediate AND survives the app's
metadata re-saves. Proven live on the 5claude instance (disk flag flipped, verified).

Two honest boundaries, both measured the same day:

- **Reach = rendered rows only.** The accessibility tree contains only sidebar rows the app has
  rendered; a chat in a collapsed group or scrolled out of the virtualized list is not present.
  The tool expands the chat's folder group (focus-free) to help, but a deeply-scrolled row in a
  virtualized viewport cannot be brought in focus-free (Chromium's scroll container is not
  reliably drivable). So this reliably archives a *currently-visible* chat; an off-screen one
  must be scrolled into view first, or archived from its own window.
- **CDP is blocked.** A Chrome DevTools Protocol route (`--remote-debugging-port`) would bypass
  rendering entirely, but Claude Desktop EXITS when launched with a debug port (proven A/B:
  same instance, plain launch runs, debug launch quits). The app refuses remote debugging.

The disk flag remains correct for CLOSED instances; nothing needs a restart.

## What is inert but not deleted

Existing databases keep their `orchestrator_*` tables and `orch_*` settings rows; nothing
reads or writes them anymore, and fresh installs do not create them. Chats seeded by v1 still
carry `[orchestrator]`-prefixed fabricated first messages; the title scanner still recognises
that prefix as replaceable plumbing.

Four of the five `~/.claude/commands` files (`/orcstart`, `/orcstop`, `/orc-dryrun`, `/orc-move`)
are retired with the server surface they called.

## Where the orchestrator lives now

**`/orchestrate` came back on 2026-08-30, and it is the one name that survived the retirement.**
The capability was rebuilt, but not as a subsystem: there is no orchestrator daemon, no reviewer
chat, no proposal ledger, no placement balancer. There is AgentHydra, which now knows how to take
a census, gate every chat deterministically, act on the verdict, and deliver a staged prompt into
a dormant chat by driving that chat's own composer. `/orchestrate` runs that pass through the
daemon's ordinary MCP tools - `prestart`, `chat_sweep`, `chat_act`, `courier` - and holds no state
of its own.

That is the whole difference from v1, and it is why the same command name is not a resurrection:
v1 was a second system with its own opinions, running beside the daemon and disagreeing with it.
The rebuild has exactly one place where a verdict becomes a deed.

Two sibling commands cover the app rather than the pass: `/hydra-status` (read-only fleet, quota,
loop and stuck-work report) and `/hydra-check` (every gate this repo has, including its own CI run
locally). All three ship in this repo under `.claude/commands/` and are also installed globally, so
they work from any directory.
