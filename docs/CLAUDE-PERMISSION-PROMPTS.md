# Claude permission-change prompts

Tool availability and approving a pending operation are separate. Do not add
`mcp__ccd_session_mgmt__set_session_permission_mode` to Claude's `permissions.deny`
to work around a blocked chat. Removing that deny entry makes the tool available;
it does not answer the Claude app's approval card or prove the live mode changed.

Use `unblock_prompts` with `session` set to the **calling chat's CLI session ID**,
whose pane contains the card, not the target chat whose mode is being changed.
Invoke it from a separate manager or use the independent orchestrator unblock lane.
The chat awaiting its tool result cannot service its own card. Existing tray,
hold, caller-mode, profile and pane-identity checks still apply.

The scanner retains unresolved tool calls by ID, including when another parallel
call finishes. Each pending operation is classified separately. A safe sibling
does not grant approval to an unknown or denied operation.

For permission-change cards requesting `bypassPermissions`:

- An automatic approval restores a target's existing bypass configuration in the
  same profile and login. Missing, archived, held or ambiguously named targets do
  not qualify. Explicit operator deny patterns take precedence.
- A new increase requires the existing explicit decision path (`force` for a
  user-directed run, or approval through the interview queue).
- Immediately before acting, the script rechecks the pending calls, policy and
  target metadata. The actuator matches the card's destination and mode and uses
  **Allow once**. It ignores disabled/offscreen buttons and refuses ambiguous cards.
  The card is the first ancestor of the button that carries a mode sentence, so a
  card never borrows another message's sentence or session chip; an ancestor with
  two sentences or two Allow once buttons is refused. A plain tool card has no
  sentence of its own, so the actuator alone cannot tell it from a mode card next to
  an earlier card's leftover text: the pending-call recheck above is what rules it out.
- The actuator checks that the card clears: neither the pressed button nor any
  Allow once that still matches a verified card stays enabled, and a window it can
  no longer read counts as not cleared. Its receipt means one
  approval was answered; check the tool result and live app mode to confirm that
  the requested change actually completed. Unknown card layouts are reported as
  failures, not as a chat that was never stuck.

Implementation evidence on 2026-10-03: Claude Desktop 2.19675.0 renders this card in
`resources/ion-dist/assets/v1/cd5a31703-DiwdunLT.js`, in the
`setSessionPermissionMode` case. Its `Vxe` helper emits the mode explanation used
by the matcher; the card has `clickOnly` set for increases. The tool and its
consent check are in `app.asar`'s `.vite/build/index.chunk-CcQR-bXs.js`. These are
version-specific diagnostic locations, not files AgentHydra patches. AgentHydra
does not generate or redeem Claude's consent tokens.

Regression tests use transcript fixtures, mocked desktop records and the shipped
PowerShell matcher. No permission-change card was pending during this repair,
so end-to-end approval against a live card remains unverified. Existing Claude
chats may retain settings loaded earlier; check tool availability in a new chat.
