# Urgency Advisor (a background loop)

A local loop in the AgentHydra server (`server/src/urgency-advisor.ts`); never a cloud routine or anything on the
claude.ai account. Default ON. A look runs each minute and measures every chat's busy streak.

- **The clock:** a chat's busy streak runs from when it last sat idle for more than 5 minutes. The owner's messages never
  reset it (one sent mid-turn, or a new turn within 5 minutes of the last one's end). Kept per chat in
  `<data dir>/urgency-advisor.json`, so a restart keeps it.
- **Who is visited:** every Desk 2 chat and Hydra Core seat that is `working` with a streak of 30+ minutes, again every
  interval (30 by default), however many visits it has had; at most one visit per chat per interval. Not idle, stopped,
  waiting-on-owner (`needs_you`) or CliMayte drone-worker chats.
- **A visit:** a TL;DR of the chat (title, the owner's last 3 messages, the AI's last 3 replies, about 4,000 characters, from
  Desk's transcript) goes with Duke's `brief.md` (read at runtime from `people/manager/duke-urgency-advisor/`, never
  copied into the repo) to one short model call that writes his push. A failed call falls back to a `lines` template
  from `persona.json`, else a neutral line. Then he watches for the chat's next AI text (up to 10 minutes) and may reply
  (or answers SKIP when the answer is good), at most 2 replies per visit.
- **Text:** every message is `[Urgency Advisor · <Name>] Sent on the owner's behalf.`, a blank line, then the words.
- **Model route:** Desk 2's `POST /api/advisor/compose` (`desk2/server/src/engine/advisor-compose.ts`): the same route
  as Desk's chat titles, Haiku 5.5, no tools, on the account the chat's worker runs on (or the chat's own login). If that
  fails, one other idle account with room is tried; a failure is logged with its reason. Never HSwarm or another provider for chat text.
- **Delivery:** Desk 2's `POST /api/chats/:id/messages`, the way the owner's own message goes (`manager.send` with
  `now: true`). A plain Desk chat takes it on its open input stream at the CLI's next tool boundary; a worker-backed
  chat has its turn stopped cleanly and the session continues with the message first. Not the ping route (it holds a
  worker's message until the task ends), send-now or interrupt. Only chats that already have a title are visited in
  practice, so the send does not rename one. Desk shows it as the advisor bubble even behind the Send now / urgent preface.
  When AgentHydra delivers it into the running turn, its bubble clears as sent at once (not "Queued"). A carried note
  from a handoff keeps its advisor flag, so its stand-in clears the same way.
- **Setting:** `GET /api/urgency-advisor` and `POST /api/urgency-advisor {enabled?, intervalMinutes?}` (db settings
  `urgency_advisor_enabled`, `urgency_advisor_minutes`; interval 5-720).
- **Log:** one line per message in the server log: `[urgency-advisor] chat=<id> minutes=<n> push|reply=<k> sent=ok|failed`.
