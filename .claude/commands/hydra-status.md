---
description: Read-only AgentHydra status - fleet, quota, the standing loop, and anything stuck. Touches nothing.
---

Report the state of the fleet. READ-ONLY: do not archive, surface, deliver, rename, or launch
anything, even if something obviously needs it - say what needs doing and stop. Extra focus, if
any: $ARGUMENTS

⚠️ **ONE PROGRAM, TWO HALVES** (owner order, 2026-09-03: the orchestrator moved back into the
AgentHydra repo so nobody has to explain "you have to use both"). The daemon knows what
instances, chats and accounts exist and acts on one when asked. Deciding what *should* happen
to a chat is the **orchestrator's** job - the Python toolbox under `orchestrator/` in this
repo, driven through the SAME MCP server (`orchestrator_menu`, `orchestrator_run`,
`orchestrator_loop`, `orchestrator_switch`). So a full status read still takes both halves,
but both are one tool list away. The v2 single-tool answers are gone: `prestart`,
`sweep_loop`, `deliveries`, `holds`, `chat_gate`, `chat_act`, `chat_sweep` and `courier` **no
longer exist as MCP tools**; if you reach for one you are reading an old copy of this file.

Gather - the daemon half:

- **`list_instances`** - which apps are actually open, and which accounts they are signed into.
  One or zero open instances means detection is broken, not that the fleet is quiet: say so
  rather than reporting a quiet fleet.
- **`list_usage`** - every account's remaining quota, each with its own verdict. Name the
  instance beside every percentage; an unattributed number is worse than none. The weekly
  (all-models) window is the binding cap except on Pro, where the 5-hour window usually binds
  first.
- **`list_rate_limited_sessions`** - anything already parked against a wall, and until when.
- **`check_update`** - whether a newer build is available.
- **`chat_dossier`** - only when a specific chat is in question ("what happened to chat X"); it
  is one query and it beats guessing from a sidebar title.

Gather - the orchestrator half, both read-only (the shell equivalents are `python orch.py armed`
and `python orch.py loop` from `orchestrator/`):

- **`orchestrator_switch {action:"armed"}`** - IS ANYTHING ALLOWED TO ACT AT ALL. Nothing acts
  without the tray icon: every acting script asks for its heartbeat first, and the default on
  any machine is off. Report this FIRST when it is down, because a disarmed fleet looks exactly
  like a healthy quiet one and every lane below will be reporting refusals rather than results.
  Do NOT arm it from here - this command is read-only.
- **`orchestrator_loop {}`** - THE DRY LOOP: census, waiting scan, accounts and bands, the
  sweep's four lanes, naming, reconcile, and the judgment queue, printing what it WOULD do and
  touching nothing. This is where `stalled`, `holds`, `collisions`, `handoffSoon` and the
  pending deliveries live. STOP AND INVESTIGATE if its census sanity rail fails or the plan
  reports INCOMPLETE - a read failed, so every lane is a lower bound, not an answer.
- **the dashboard at http://127.0.0.1:7799** - the same picture in a browser: the accounts strip
  with the usage bands, every configured rule with its live value, and per-chat dry-run
  decisions. Cite it rather than re-deriving it by hand.

Then answer in plain English, worst first: what is broken, what is waiting on a person, what is
merely queued. One line each. If everything is healthy, say so in one line - do not pad it.
