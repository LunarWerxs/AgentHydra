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

- `/api/sessions/:id/migrate`, `import-desktop`, `desktop-archive`, `automation`,
  `launch-terminal` - moving, importing, archiving and visibly launching chats.
- `chat-dossier` (minus its joins into the orchestrator ledger tables), backed by the
  extracted `live-registry.ts`.
- The auto-resume monitor, reduced to its pre-orchestrator shape: scheduled resumes into a
  visible terminal, or a recorded "ready in its app" close-out for desktop threads
  (migrate-on-limit and the proposal-gated native revive went with the reviewer).
- The no-headless and surface-purity owner laws, which are enforced in the primitives, not in
  the orchestrator: they bind the rebuild too.

## What is inert but not deleted

Existing databases keep their `orchestrator_*` tables and `orch_*` settings rows; nothing
reads or writes them anymore, and fresh installs do not create them. Chats seeded by v1 still
carry `[orchestrator]`-prefixed fabricated first messages; the title scanner still recognises
that prefix as replaceable plumbing.

The five `~/.claude/commands` files (`/orchestrate`, `/orcstart`, `/orcstop`, `/orc-dryrun`,
`/orc-move`) are retired with the server surface they called.
