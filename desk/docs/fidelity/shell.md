# Shell fidelity (chrome bar, sidebar, footer, accounts popup)

Rounds 1 and 2 matched the real Claude Code desktop (captures in `docs/reference/real/`). Round 3 departs
from it on purpose where Jacob asked (2026-10-04); see `PARITY.md`, "Intentional departures".

## Removed on purpose

- Sidebar nav rows Projects (Beta), Artifacts, Customize and More, with the More menu (Agents, Routines,
  Edit sidebar) and the full-pane Agents view only it reached. CliMayte stays reachable from the title
  bar's CliMayte pane and the composer.
- The chrome bar's Chat / Code mode switch: Hydra Desk is Code only. With the sidebar hidden the title
  bar starts at x 142 (after Forward) instead of 214.

## Kept as the real app

New row (Ctrl+N on hover), the collapse toggle (Ctrl+B), Back / Forward, the project-grouped list with
the group Filter and Search, outside-session rows, the resize handle, the 44px footer.

## Search

The box filters titles as the real one does; below it Hydra Desk adds "Everywhere" (12px muted caption
like a group header, a 10px spinner while AgentHydra searches), rows of `SearchHitRow.vue`: 13px title
with a 12px muted folder · age at the right, then up to two 12px muted lines of the matching text, the
query's words semibold in `--text` / `--text-2`. The keyboard cursor paints a row `--fill-hover`.
States: "No matches", "AgentHydra search is offline", "AgentHydra search failed: reason".

## Collapsed sidebar flyout

With the sidebar hidden, 120 ms of the pointer on the show-sidebar toggle or a 6px strip at the window's
left edge slides the sidebar in over the content (`DeskFrame`, `SidebarPeek` in `shell/logic.ts`): the
same Sidebar instance, absolute at the window's left, its own width and #111111, `--shadow-popover`,
z 20 (under the chrome bar's 21, under dialogs), 300 ms on the snap ease, no motion under
prefers-reduced-motion. It stays while the pointer is on the toggle, the strip, the flyout, the chrome
bar over it or a menu opened from it, or keyboard focus is inside; it closes 200 ms after that, and at
once on choosing a chat or Escape. It neither opens nor closes while a menu or dialog is open. Clicking
the toggle still pins the sidebar open (no slide then: it is already shown).

## Status dots

One function draws them all (`statusGlyph` + `glyphDotClass` in `sidebar/logic.ts`; ChatRow,
ExternalRow, the outside-session view, the header chip and the gallery use it):

| State | Dot |
| --- | --- |
| starting, working | solid `--status-working` grey, blinking (the real app) |
| idle / stopped, read | 1px grey ring at 50% (the real app) |
| finished turn unread (idle, stopped, closed + unread) | solid orange `--status-needs-you` (the real app: blue) |
| needs_you (question, permission, plan) | orange, pulsing |
| error | solid `--status-error` red |
| limited | hollow 1.5px ring in `--status-limited` pink; "resets ..." and the header's `Limited · resets ...` in `--status-limited-text` |
| closed | the title dims |

Opening a chat clears unread (orange goes back to the ring); a turn that ends while its chat is open in
the focused window clears it too, so only chats that finished while Jacob was elsewhere turn orange.

## Filter and archive

The sliders button's menu: Active (default: everything not archived), Archived (only archived chats, and
outside sessions archived here, by group; empty reads "No archived sessions" with Show active), All (Active plus an
Archived group last). The row menu's Archive / Unarchive moves a chat between them.

## Row menu

Matched to `docs/reference/real/user/real-chat-row-context-menu.png`: Open in >, rule, Pin P, Mark as
unread U, Rename R, Fork F, rule, Move to group >, rule, Archive A, Delete D (red). The letters are
`MENU_SHORTCUT` hints and run their item while the menu is open (a capture-phase keydown clicks the
item, ahead of reka's type-to-find). Right-click, the row's "..." and the title bar's menu render the
same `rowMenu()` list through `RowMenuList.vue`. Stop sits above Pin while a turn runs. Outside sessions
have no Delete; Archive's tooltip says why.

## A started chat lands

`createChat` in the store lists the returned chat and selects it at once (the socket's `chat.upsert` may
come later, and without the chat the view fell back to the new-session screen). The sidebar opens the
chosen chat's group if it was collapsed and scrolls its row (the first of its group) into view.

## Footer

- The profile pill (avatar, `Auto` or the pinned account, `42 accounts` or the plan, chevron) opens the
  accounts popup.
- The gear at the right end (lucide `Settings`, the real settings gear) opens the Settings dialog
  directly (`openSettings()` on the store); the popup's own Settings row stays.

## Accounts popup (Hydra Desk's own; no real capture)

Replaces the tall list of `docs/reference/real/user/ours-accounts-popup.png`. 340 wide, at most 70% of
the window high, the list scrolls inside.

- One 28px row per account: check (the pinned one) or a status dot (filled by the fuller window's tone;
  amber ring = in use by a person or another session; grey ring = signed out), the `#35 sue` name from
  `accountLabel` (never an email), a quiet plan chip, then `5h` and `Wk` bars (28 x 4) with the
  percentage beside each: green under 60, amber 60-85, red over 85, `–` without a reading. Reset times,
  in-use and live chat counts are in the row's tooltip (`rowTip`).
- Order: `Auto (best available)` with `right now: #128` on the same line, `Default login`, then by
  headroom (100 minus the fuller window; unknown after known), signed out last and muted.
- Keyboard: the checked row is the one tab stop; arrows, Home, End move; Enter or Space choose; Escape
  closes (the popover).
- Under the list: Settings, then the shorter hint "Your chat runs here. CliMayte sends sub-agents to the
  others."
- Parity: scene `accounts-popover` renders 14 accounts (`popoverAccounts` in `web/src/dev/parity/fixtures.ts`)
  with Auto saved and `#128` as Auto's pick. No reference exists, so it is ours only.
