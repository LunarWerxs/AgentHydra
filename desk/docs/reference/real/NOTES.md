# Harvest notes

## How
`docs/reference/tools/harvest.ts` connects to the Node inspector on 127.0.0.1:19330, checks pid 47660, finds the Code tab webContents and runs a script through `executeJavaScript` (helpers in `page-lib.js`). Run: `bun docs/reference/tools/harvest.ts <script.js> [outfile]`. Screenshots use `capturePage`. The CDP debugger was never attached; the socket is closed in a `finally` on every run.

## Captured (PNG, full resolution, DPR 1)
whole-window, sidebar, sidebar-selected-row-and-hover (selected row; hover read from CSS), top-bar-header (+ -left, -right), transcript-user-message, transcript-assistant-text, transcript-inline-code, transcript-tool-row-collapsed, composer-idle, composer-strip-above-box, composer-dock, menu-permission-mode, menu-model, menu-effort, menu-plus, sidebar-more, new-session-screen (+ -sidebar, -stats-card, -tip-and-composer), restored-check (proof the original chat row is selected again).
Also: tokens.json, dom-outline.json (structure only), DESIGN.md, SPEC.md token table and Sidebar / Transcript / Composer values marked measured.

## Interactions performed
Opened and Escaped the four composer menus and the sidebar More menu. Clicked New, captured, then clicked the originally selected row (same index, same title in memory) and confirmed by screenshot. Nothing typed, sent, archived, renamed, pinned or dragged. The composer draft was untouched (empty before and after).

## Skipped (not on screen and not reachable with the allowed interactions)
transcript-thinking, transcript-tool-row-expanded, transcript-diff-or-code-block (no code block in view), todo/plan card, permission/question card, toast. Hover, active, disabled and focus states of controls could not be produced; hover fill is read from CSS (#ffffff13, selected #ffffff26).

## Surprising / Hydra Desk must match
- The repo strip (branch, +/- counts, Create PR) is a **separate 40px card above the box**, gap 6, not part of the box.
- The toolbar row (+, mic, mode, model, effort, usage) sits **below** the box, not inside it.
- Approval/question cards render in the dock above the strip (from the DOM; not seen live).
- The effort control is a dialog popover (r22) with a 6-stop slider, not a menu.
- The permission menu has a "Mode" header, descriptions, badges (Recommended, Default) and number shortcuts that become a check on the selected item.
- Menus open above their composer triggers; sidebar More opens to the right.
- New session screen has a stats card, a tip banner and env pills (Local, folder, branch + worktree).
- Transcript is virtualized (offscreen rows are removed); message action toolbars are opacity 0 until hover.
- A running chat shows only a blinking status dot in the sidebar (opacity .3-1, 1.2s). Unread/attention dot is #2a78d6.
- Fonts: `anthropic-sans` is proprietary; on this PC the fallback chain lands on Segoe UI.

## Could not measure
Tooltip show delay (JS-set), send-button states and colors (only the idle 24x24 "Send" glyph on the new-session screen; the stop control was never seen), disabled/active/hover states, drag and resize behaviour, running-chat transcript look, toast, diff colors beyond the git palette (#32d74b / #ff2c56), selection color (native). The lucide icon names are my closest guesses from glyph shapes and aria-labels, not an official mapping.
