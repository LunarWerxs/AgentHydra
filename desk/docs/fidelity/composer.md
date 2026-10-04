# Composer fidelity (vs docs/reference/real)

Compared over three rounds of headless Edge captures of `#/gallery` (Vite on :4798, Playwright with
channel msedge, 1500x1000; `?shot=<id>#/gallery` puts one state alone at the bottom of the window).
Final captures: `docs/fidelity/shots/r3-*.png` (composer, menu-mode, menu-model, menu-effort,
menu-plus, slash, mention, plus crops `r3-crop-dock.png` and `r3-crop-model.png`); the round-1 menu
captures `r1-menu-*.png` are kept as the "before". Panes: `PanesSection.png`, `PanelsSection.png`.

## Matched

- Dock: 768 max width, children gap 6, order (Hydra worker dock) > repo strip > box > toolbar row.
- Repo strip: separate 40px card, r10, p8, gap 5, fill 5%. "project branch" is one mono run in muted
  text with a single space. The +N / −N counts chip is sans and tabular, medium weight, with a real minus (U+2212),
  git add/del colours, fill-secondary. Create PR is a split button with More PR options, and there is a Dismiss X.
- Box: #20201f, r12, p8, shadow `inset 0 0 0 1px #ffffff1a, 0 4px 20px #00000009`, text 14/20,
  placeholder #898781 "Describe a task or ask a question", textarea max 384, send 24x24 (return glyph).
- Toolbar row below the box: h20, padding 0 10 0 7, 12px #c3c2b7, buttons h20 r5 px6, icon buttons 20.
  Items: +, hold-to-record mic, dictation chevron, mode name, model, effort, 20px usage ring.
- Mode menu: header "Mode", Auto (Recommended badge) / Manual / Accept edits / Plan / Bypass
  permissions (Default badge), each with its description, check and number key 1-5. It sizes to its content
  so descriptions stay on one line, like the real one.
- Model menu: Opus 5.5 / Fable 5.1 / Sonnet 5.5 / Haiku 4.5 with keys 1-4, the check replacing the key on
  the current model, a separator, then "More models >". Min width 145 (measured from menu-model.png).
- Effort: a dialog popover, not a menu: r22, 220 wide, p12, "Effort" + level name (purple at the top
  stop) + About (?), Faster/Smarter, stop slider with 3px dots, 3x9 pill at the recommended stop,
  16x20 white handle, "Recommended" caption. The chip in the toolbar is plain text (no colour), as in the real app.
  Opening it focuses the slider, so no focus ring is drawn on the ? button.
- Plus menu: Add files or photos (Ctrl+U), Add folder (plain folder), Slash commands, Connectors
  (blocks glyph, submenu). Glyphs read from a zoomed menu-plus.png. The real Add plugins row is left out
  (PARITY.md "Intentional departures"). Connectors lists the MCP servers a chat here loads
  (`McpSubmenu.vue`): name, muted transport on the right, and in a live chat a 6px status dot
  (--success connected, --danger failed or needs auth, muted pending, muted ring off) in a 16px slot;
  a click toggles the server for that session and the menu stays open. Without a live session the rows
  only inform ("Applies to every new chat"); an empty list says "No MCP servers".
- New-session pills: folder, branch with its worktree checkbox, Add another folder. The real Local pill is
  left out (every chat runs on this computer).
- Menus: r10, #20201f, inset ring 10% + popover shadow, p4, items h24 r6 px8 13/19, highlight 7.5%,
  shortcuts 13px tabular #a5a49a; all open above their trigger.
- Keys: Enter sends, Shift+Enter is a newline, Esc interrupts while busy, ArrowUp in an empty box recalls
  the last message, Ctrl+U attaches (unit-tested in web/test/composer/logic.test.ts).
- The mic in the real captures is grey: the blue and orange fringes are ClearType subpixel rendering, not colour.

## Measured / set from tokens (no real capture to copy)

- Diff pane: header h40, rows like menu items (h24 r6 px8 13/19), status letters in git colours,
  counts sans tabular in --git-add/--git-del with U+2212, hunk rows tinted 12% of the git colour, line text
  in normal colour with only the +/- sign coloured, r6 24px refresh button.
- Settings: a dialog on the popover surface (r12, #20201f), no cards; rows py14 split by 1px rules with
  labels 13/20 and wrapping descriptions 13/19 muted, selects h28 r6 13px, buttons fill-secondary r6
  (panes.md "Settings").
- Elsewhere list/view and the CliMayte panel: 13px titles at 500, 12px meta, r6 buttons on fill 5%,
  badges r4 fill-secondary 11px, search field fill 5% with the inset ring.
- Appended tokens: style.css block "Composer, menus and panes" (+ `--radius-4`); icons.ts `composerIcons`.

## Still different, and why

- Font: the real app uses Anthropic Sans, which is not available here. The system fallback (Segoe UI) is wider and
  renders weight 500 as 600, so text runs a little longer and bolder. This is a token-layer choice, not the composer's.
- Auto mode is shown but disabled: shared/protocol.ts has no "auto" permission mode to send.
- Effort has 5 stops (Low, Medium, High, Extra, Max): the real slider has a 6th, Ultracode, which has no
  protocol value. The recommended stop (Medium) is a guess, because the real caption position was not measured.
- Fast mode (a toolbar item in DESIGN.md) is omitted: no protocol field.
- Add folder is informational: Hydra Desk has no backend for it yet.
- The real menus highlight the first item on open; ours open with nothing highlighted in the gallery
  (non-modal demo); in the app, Reka's keyboard focus does the same as the real app.
- Not measured, so best guesses: the focus ring (`--shadow-composer-focus`: ring goes to 20% white), the send button
  disabled/enabled tints, and the stop button (filled square).
- In composer-idle.png the existing chat's text "how we looking" is grey. That is either the real app's
  placeholder for an existing chat or an unfocused window; we show the new-session placeholder everywhere.
- Shift+Tab mode cycling is not added: real/NOTES.md does not say the desktop app does it.
- The open-diff, open-climayte and show-pending window events are dispatched by the composer but nothing listens
  for them yet: App.vue belongs to the shell worker.
- PanelsSection shows the CliMayte panel and Elsewhere views empty or failed, because they call the
  real server and the gallery has none; their fixture plumbing was left for a later pass.

## The send queue (Hydra Desk's own)

The real app has a queued-message UI, but there is no reference screenshot of it here (docs/reference/real
and the user/ captures were searched), so the queue UI is Hydra Desk's own and is drawn with the dock's
existing tokens, MENU classes and chips.
- Visible only on hover or focus: after the pointer rests on the send/stop button for 1 s, or when the
  button gets keyboard focus, a 16x24 up-chevron appears. It is absolutely positioned to the left of the
  button (`right-full`), so it takes no width in the row and the text box keeps its width. While the
  chevron or the popover shows, the button's tooltip is closed.
- Visible only when something is queued: the tray of this chat's queued messages (inside the box, above
  the text), the "Queue" label on an idle chat whose Enter queues, and the dock's "N queued" chip while a
  request card stands in for the box. That chip is separate from the WorkerDock chip of the same name,
  which counts the SDK's own queue.
- The popover opens only on a click, a right-click, Shift+F10 or the Menu key.
- The parity scenes and the Gallery pass `demo`, and their sources have no queue, so they render none of
  this. Every default capture is unchanged; the only DOM change in them is a `role="group"` wrapper
  around the send button, which has the button's size and does not move it.
