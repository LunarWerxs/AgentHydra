---
description: Park this thread - the orchestrator must not prompt it until /resumeo
---

Mark THIS session as delayed for the AgentHydra orchestrator, then stop.

1. Read this session's id from the `CLAUDE_CODE_SESSION_ID` environment variable
   (`$env:CLAUDE_CODE_SESSION_ID` in PowerShell, `$CLAUDE_CODE_SESSION_ID` in bash).
2. `POST http://localhost:7787/api/orchestrator/hold` with JSON body
   `{"session_id": "<that id>", "held": true}` (curl is fine; if 7787 refuses, read
   `~/.agenthydra/runtime.json` for the real port and retry once).
3. Confirm to the user in ONE line: this thread is parked and the orchestrator will not send
   it any prompts until `/resumeo`.

Do nothing else - no other work, no recap.
