---
description: RUN THE ORCHESTRATOR - census, gate every chat, act on the verdicts, deliver what was staged
---

THIS IS THE ORCHESTRATOR. It is no longer a separate subsystem: v1 was retired whole on
2026-08-29 and rebuilt as AgentHydra's own gate/act/deliver machinery, driven through its MCP
tools. Same command name as v1 had, deliberately - the thing it does did not change.
Extra instructions, if any: $ARGUMENTS

⛔ **FIRST: if `prestart` is not a tool you can call, STOP AND SAY SO.** The AgentHydra MCP server
is not registered in this session, and the whole command below is written against those tools. Do
not quietly fall back to curling the daemon's REST API: that is what happened silently for weeks,
and nobody found out until a pass went looking. Fix it with
`claude mcp add --scope user agenthydra -- bun run --cwd <path-to-agenthydra> mcp` and start a new
session (a session's tool list is fixed at startup). `bun run smoke:orchestrator` in the repo proves
the whole chain end to end before you trust a pass.

Work in this order and do not skip step 1 - acting on a chat without gating it first is the one
thing this system forbids.

1. **`prestart`** - the census and the pre-check, in the required order: how many instances are
   open, then every chat across them, gated, nothing touched. STOP AND INVESTIGATE if
   `sanity.plausible` is false; one or zero open instances means detection is broken, not that the
   fleet is quiet, and a census that starts wrong poisons every decision after it.

2. **Read every lane before acting.** `nextSteps` is the ordered answer per chat. Also read:
   `stalled` (live chats stuck on a shell command nobody is present to approve - open and LOOK,
   never act), `holds` (chats deliberately off automation, with the reason), `handoffSoon` (nearly
   full context - hand off while they can still summarise themselves), `collisions` (live chats
   sharing one working tree), `suppressed` (the circuit breaker holding back a futile loop), and
   `pendingDeliveries` (staged prompts nobody has sent - these come first).

   Three more that are easy to skip and should not be. **`junk.supersededVisible`** is retired
   lineages still sitting in a sidebar: archive them, but note that `chat_act` and `chat_sweep`
   will both PARK a superseded chat rather than act on it, so the deed is
   `POST /api/sessions/:id/desktop-archive`. **`junk.liveButDoneMarked`** is the opposite and is
   never automation's to resolve: a retired lineage with a LIVE process is a contradiction the
   owner untangles. **`unusableInstances`** must be read BEFORE routing any work - and remember
   closed is not a fault, so what appears there is damage (signed-out, no-config, unreadable
   profile) or an open account at its usage wall.

3. **`chat_sweep`** to act on the verdicts within caps. Then work the two things it hands back to
   you: each `needsJudgment` row is YOUR call (autonomous vs human - the owner prefers autonomous
   whenever the answer is determinable), and each surfaced chat is DORMANT until its prompt is
   delivered.

4. **`courier { run: true }`** to deliver staged prompts by driving each chat's own composer.
   Check `capHit` / `notAttempted` - a capped pass is not a finished queue.

5. Report what changed in plain English. Name any chat you left alone and why.

⛔ **A STATUS REPORT IS A FAILED RUN.** The job is orchestration: every chat, on every open
account, gets a DECISION. Reciting what the fleet looks like is worthless - the owner can see his
own screen. If you finish a pass having changed nothing, either the fleet was genuinely all-clear
(say so in one line) or you skipped work; assume the second and look again.

**Never interrupt a chat with a turn IN FLIGHT.** That is what the live rail means, and it is not
the same as "never touch a live chat": a chat whose process is alive but which FINISHED its turn
and has gone quiet is IDLE, and idle is waiting, not working. The gate now labels those (`idle`
on the gate, `idleSecs` on a needsJudgment row) and they are the bulk of a real fleet - they are
your work, not scenery. Decide each one: answer it, nudge it onward, hand it off if its context is
nearly full, or leave it with a stated reason. **Never archive a chat contradicting a live
process** - read its tail and clear the false mark instead.

**The CATCH-ALL is not optional either.** A needsJudgment row carrying `catchAll` did not reach
you through a verdict - it is unarchived, it moved in the last couple of hours, and no lane could
place it. That is a signal the CLASSIFIER is wrong, not that the chat is nothing. Open it, work
out what it is actually doing, and decide. "The gate had no lane for it" is not a reason to skip
a chat that is plainly part of live work. Repo-level questions ("which PROJECT should I pick up") are not
this tool's job: that is Odin, in its own clone.
