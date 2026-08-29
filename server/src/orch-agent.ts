// server/src/orch-agent.ts — the ORCHESTRATOR AGENT CHAT: its marker, and nothing else's.
//
// WHY THIS EXISTS (owner directive, Michael, 2026-08-28): the relay rung — commandeering an
// awake WORKING chat in another instance as a courier — is banned ("remove the relay task
// functionality... don't just message other chats"), and its removal honestly parked every
// delivery into another instance's dormant chats. The sanctioned replacement is a dedicated,
// system-owned chat per instance whose ONLY job is deliveries: the server composes the exact
// send, the agent chat performs it inside its own instance (the one place a dormant chat can
// be booted from), and reports. Nobody's thread of work is ever the errand runner again.
//
// THE MARKER IS THE LAW. Everything that treats this chat specially — the courier rung
// composing to it, the monitor excluding it from idle/nudge/handoff detection, the janitor
// refusing to retire it while its instance has chats — keys on the TITLE marker below, never
// on heuristics (cwd shapes, transcript content, "looks like plumbing"). A heuristic admits
// working chats sooner or later, and one admitted working chat is the banned relay back under
// a new name. This module has ZERO imports on purpose: orchestrator.ts, the worklist and
// session-launch.ts all need the marker, and a dependency-free module can sit under all three
// without closing a cycle.

/** The title every seeded agent chat gets. Starts with the marker prefix below; the "do not
 *  use" half is for the OWNER's eyes in the sidebar — this chat is system plumbing. */
export const ORCH_AGENT_TITLE = 'Orchestrator agent - do not use'

/** The marker itself. Prefix-matched case-insensitively so an owner tweak to the suffix
 *  ("Orchestrator agent (Martin)") keeps the chat recognized, while no working chat's name
 *  starts with these words by accident. */
const ORCH_AGENT_TITLE_PREFIX = 'orchestrator agent'

/** THE admission test. Everything agent-chat-shaped goes through here so the marker cannot
 *  drift into per-call-site variants. */
export function isOrchAgentTitle(title: string | null | undefined): boolean {
  return !!title && title.trim().toLowerCase().startsWith(ORCH_AGENT_TITLE_PREFIX)
}

/** The orchestrator_kv key remembering which session was seeded as an instance's agent chat.
 *  Exists for ONE failure the marker alone cannot survive: a running app wiping the seeded
 *  title (measured on every seed under a running app). The kv record lets the janitor see
 *  "the agent chat lost its marker" and park a rename that restores it, instead of seeding a
 *  duplicate courier beside the amnesiac one. */
export function agentChatKvKey(instanceRef: string): string {
  return `agentChat:${instanceRef
    .slice('desktop:'.length)
    .replace(/[\\/]+$/, '')
    .toLowerCase()}`
}

/** The boot turn for a freshly seeded agent chat — its standing brief. Delivered like any
 *  other message (own-instance send_message, or a peer send once it is live). */
export const ORCH_AGENT_BOOT =
  "[orchestrator] You are this instance's ORCHESTRATOR AGENT CHAT — system plumbing, not a " +
  'working chat. Your only job, ever: when a message marked DELIVERY STEP arrives, perform ' +
  'exactly the send_message call it specifies and report the outcome in one line. You never ' +
  'start work, never touch files, never message any chat on your own initiative, and never ' +
  'answer anything except delivery steps. Reply "ready" and stop.'

/** One courier instruction: deliver `payload` into the dormant chat `targetChatId` (the app's
 *  own `local_*` id, read from metadata — never constructed) and report. The payload rides
 *  between fence lines so the agent can hand it over byte-for-byte; the fences are chosen to
 *  be nothing a composed orchestrator message ever contains. */
export function composeAgentDelivery(targetChatId: string, payload: string): string {
  return (
    "[orchestrator] DELIVERY STEP — you are this instance's orchestrator agent chat, and " +
    'delivery is your only job. Call your send_message session tool ONCE with session_id ' +
    `"${targetChatId}" and, as the message, EXACTLY the payload between the BEGIN and END ` +
    'lines below — everything, verbatim, fence lines excluded; add nothing, drop nothing, ' +
    'reflow nothing. Then reply with one line — "delivered", or the tool\'s error verbatim — ' +
    'and stop. Never do the work yourself, never message any other chat, never start ' +
    'anything else.\n' +
    '===== BEGIN PAYLOAD =====\n' +
    `${payload}\n` +
    '===== END PAYLOAD ====='
  )
}
