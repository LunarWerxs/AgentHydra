---
description: Read-only AgentHydra status - fleet, quota, the standing loop, and anything stuck. Touches nothing.
---

Report the state of the fleet. READ-ONLY: do not archive, surface, deliver, rename, or launch
anything, even if something obviously needs it - say what needs doing and stop. Extra focus, if
any: $ARGUMENTS

Gather:

- **`prestart`** - instances open, every chat gated, and the lanes that say what is wrong:
  `stalled`, `holds`, `suppressed`, `collisions`, `handoffSoon`, `pendingDeliveries`, plus `junk`
  (retired chats still on screen, unnamed chats, and live-but-done-marked contradictions).
- **`sweep_loop`** with no arguments - is the standing sweep on, is the courier on, when is the
  next tick due, and what did the last pass actually DO. A timer-driven pass that ran and refused
  every row looks exactly like one that never ran, so read `lastCourierRun`, not just the switch.
- **`list_usage`** - every account's remaining quota, each with its own verdict. Name the instance
  beside every percentage; an unattributed number is worse than none.
- **`deliveries`** - the ledger: what is still pending, deaf, or expired, and since when.
- **`check_update`** - whether a newer build is available.

Then answer in plain English, worst first: what is broken, what is waiting on a person, what is
merely queued. One line each. If everything is healthy, say so in one line - do not pad it.
