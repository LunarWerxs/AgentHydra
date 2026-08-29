# Survey: what other orchestrators do better (and worse), 2026-08-28

Six parallel researchers swept GitHub and public docs (claude-flow/Ruflo, claude-squad,
Tmux-Orchestrator, claude_code_agent_farm, crystal, amux, kage, reshashi/claude-orchestrator,
AWS CAO, diri, LangGraph, CrewAI, AutoGen/AG2, OpenHands, Temporal-style durable execution,
systemd watchdogs, Anthropic's own multi-agent posts) and judged everything against OUR
constraints: visible Desktop app chats, one account per window, zero clicks, the app owns its
own metadata. Owner ask: "see if you can find any better ways to do things we're doing."

## Where we are AHEAD (verified against their own docs - do not regress these)

- **Verification by re-reading the world.** Nobody else claims it. Every surveyed tool either
  trusts the agent's self-report or tracks process/file state; our transcript-moved /
  flag-flipped / title-stuck checks are a stronger correctness bar than anything found.
- **Zero-token liveness.** The 60s transcript tick costs no AI tokens; claude-squad and the
  team-orchestration plugin have NO liveness detection at all, crystal leaves it to the human.
- **Cross-account load balancing.** None of the Claude-specific tools balance across accounts;
  kage is the only one that even tracks per-account health/limits.
- **A judgment layer.** None of the session managers has an equivalent of the one-AI-reviewer
  ruling over a typed worklist; they route messages and detect liveness, a human does the rest.

## Tier 1 - direct hits on our named pains (chips filed) - BOTH SHIPPED 2026-08-28

1. **The reviewer is a ROLE, not a chat** - SHIPPED (orchestrator-reviewer-journal.ts, commit
   20cedde). (claude-flow's oversight decoupled from any worker;
   OpenHands' replay-an-EventLog-into-any-fresh-runtime; Anthropic's memory checkpoint;
   AG2's rehydrate-into-a-new-process). The daemon already holds the ledger and worklist; add
   a compact REVIEWER JOURNAL (decisions made, in-flight items, standing context) that any
   fresh chat can be seeded with, so "revive the reviewer" means replay-into-whichever-window
   -is-free, never resurrect-one-specific-chat. Kills reviewer mortality permanently and
   makes the phantom-archiver class of decapitation a non-event.
2. **Circuit breakers + backoff + stuck-but-alive detection** - SHIPPED
   (orchestrator-breaker.ts: attempt counters at proposal creation, revive-delivery backoff
   per target session, repeat-hash on rulings; docs/ORCHESTRATOR.md "The circuit breaker").
   (systemd restart-storm brake;
   agent_farm exponential backoff 10s..5min; CrewAI max_iterations; Cloudzy's hash-the-
   repeated-action sliding window; Temporal per-activity heartbeat). Measured tonight: the
   same finished chat was re-archived FOUR times and the same idle chat re-proposed three
   times - live loops with no counter. Add per-lineage and per-item attempt caps that trip
   to an owner status line, exponential backoff on revives into the same window, and a
   repeat-hash check that flags an alive reviewer re-litigating one item.

## Tier 2 - cheap wins, roughly ranked

3. **Typed degraded states + account failover table** (Claude Agent SDK error signaling):
   alive / quota-exhausted / no-session / stalled as explicit states, with an ordered
   fallback so a quota-hit window's pending work is reassigned instead of stranded. Half
   exists since the limit-risk flag (8349b9a); the failover table completes it.
4. **Per-item grace windows** (dead-man-switch pattern): size the idle threshold to the item
   kind instead of one global number - a hard refactor mid-reasoning is not "idle 15m".
5. **Agent-authored wake times** (Tmux-Orchestrator's schedule_with_note): let a chat write
   "check me back at T, here's why" into a daemon-readable place; the tick honors it.
6. **Numeric account health score** (claude-flow trust score): success rate + uptime +
   recent errors + quota headroom as one weighted number for placement, degrading flaky
   accounts before they burn quota, instead of band thresholds alone.
7. **Native OS notification for owner-blocked items** (crystal): when the reviewer rejects
   an item as "only the owner can answer", fire a desktop notification - informs without
   requiring a click, so blockers stop hiding in status lines.
8. **Serve the dry run in the web UI** (AWS CAO's second control plane): the daemon already
   has a UI; a read-only worklist/dry-run page gives the owner a glance-view without opening
   any chat. The reviewer stays the only decision-maker.
9. **Task-spec template for every composed nudge** (Anthropic, Building Effective Agents):
   objective / expected output / scope boundary, the way workStart already does - extend to
   resume and answer messages; vague nudges measurably caused duplicated worker output.
10. **Atomic item claims** (amux): a compare-and-swap claim per worklist item so two reviewer
    processes can never both rule the same item during a handoff overlap.

## Ideas judged and NOT adopted

- PTY/tmux ownership tricks (diri, all session managers): no equivalent for a GUI desktop
  app; only the predicate-based status-detection half ports, and our transcript tick already
  is that.
- Multi-dimension scoring per worklist item (Anthropic's judge rubric): real value for evals,
  but per-item scoring quadruples reviewer output for marginal gain at our item volume; the
  usage-risk flag already covers the dimension that burned us.
- Worktree-per-chat isolation (claude-squad, crystal): our chats deliberately share trees
  under path-scoped-commit law; changing that is a fleet-culture decision, not an
  orchestrator patch.
