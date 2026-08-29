# /orc-dryrun - show the owner what the orchestrator WOULD do, without it acting

Canonical copy of the `~/.claude/commands/orc-dryrun.md` command (shared to both machines via
the claude-memory repo's `home/commands/`). Owner ask (Michael, 2026-08-28): before the
orchestrator "just goes and runs", he wants to see the plan - every open window, every chat,
and every action it would take - so he can veto what is wrong.

Do exactly this:

1. Ensure the daemon is up (fix, don't report):
   `powershell -NoProfile -ExecutionPolicy Bypass -File "D:\PublicProjects\AgentHydra\app\misc\Ensure-Daemon.ps1"`
2. Fetch the rendered plan - this endpoint is READ-ONLY (no acks, no cooldowns, no reviewer
   stamp), so running it repeatedly is always safe:
   `curl -s "http://localhost:7787/api/orchestrator/dryrun?format=text"`
3. Show the output to the owner VERBATIM in a fenced code block. Do not summarize it away, do
   not act on any item in it, and do not start a reviewer loop from this command.
4. After the block, add at most three short lines flagging anything in the plan that looks
   wrong or stale (e.g. an archive item whose done-mark no longer holds), so his veto has
   somewhere to land. Then stop and wait for his word.
