# Real Claude Desktop (Code tab) - measured design

Source: Claude Desktop instance `eek` (pid 47660), read-only `getComputedStyle` and CSS custom
properties through `webContents.executeJavaScript`, 2026-10-03. Window 2782x1496 css px,
devicePixelRatio 1, `html` has `data-theme=claude data-mode=dark data-density=comfortable
data-transcript-width=s data-chat-text-size=m`. `tokens.json` in this folder holds the same values
as data (it is the complete copy; this file is the readable summary). No font files were copied.

## Fonts
- Sans stack: `anthropic-sans, system-ui, "Segoe UI", Roboto, Helvetica, Arial, <CJK/Indic fallbacks>, sans-serif, ui-sans-serif, -apple-system`.
  `anthropic-sans` is a proprietary variable web font (300-800), served from Anthropic's asset host; do not copy it.
  Without it Windows renders **Segoe UI** (ships with Windows). Hydra Desk uses `system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Mono: `anthropic-mono, ui-monospace, monospace, "SF Mono", Menlo, Consolas, monospace` (proprietary first; Consolas / Cascadia Mono ship with Windows). Code features: `"calt" 0, "liga" 0`.
- Icons: `Anthropicons-Variable` (proprietary private-use glyph font). Use @lucide/vue instead (map in tokens.json `icons.map`).
- Letter spacing: normal everywhere. Timestamps and counts use tabular-nums.

## Colors (dark)
| Role | Hex |
|---|---|
| Sidebar bg | #111111 |
| Page / pane bg | #151515 |
| Panel | #1a1a19 |
| Deepest surface | #0b0b0b |
| Popover, composer box, tooltip | #20201f |
| Text primary | #f0efec |
| Text secondary | #c3c2b7 |
| Text muted | #898781 |
| Shortcut caps | #a5a49a |
| Border default / strong / stronger | #ffffff1a / #ffffff33 / #ffffff66 |
| Fill hover (ghost) | #ffffff13 |
| Fill selected (ghost) | #ffffff26 |
| Fill 5% (user bubble, strip, mode radiogroup, inline code) | #ffffff0d |
| Accent fill / hover / text / bg | #2a78d6 / #3987e5 / #6da7ec / #032042 |
| Brand | #c6613f (hover #d97757) |
| Success fill / bg | #009300 / #11260f (text #0ca30c) |
| Warning fill / bg | #fab219 / #311a00 (text #db9300) |
| Danger fill / bg | #d03b3b / #3c0e0e (text #ec7e7e) |
| Inline code text | #ec7e7e on #ffffff0d, 1px #ffffff1a border |
| Git +/- | #32d74b / #ff2c56 (modified #ffd014, merged #b796ff) |
| Focus ring | `inset 0 0 0 1px #151515, 0 0 0 1px #2a78d6, 0 0 6px 1px #184f9599` |
| Scrollbar | thin, thumb rgba(225,224,217,.35), transparent track; code/table scroll 8px, track #ffffff0d |
| Selection | native (no custom ::selection) |
| Tooltip | bg #20201f, fg #f0efec, z 50 |

## Window chrome
- Frameless. Custom chrome bar: height 36, padding-left 12, padding-right 137 (room for native min/max/close), gap 4, z 21.
- Buttons 28x28 r7 at x 12, 44, 76, 106: Menu, Hide sidebar, Back, Forward (16px icons). Then Mode radiogroup 70x28 r7 bg #ffffff0d with two 34x26 r5 radios: "Chat and Cowork", "Code".
- Title bar (inside the pane): height 32, top 2, left 297, padding-right 12. Items: Remote Control (24x24), session title button (13px/500, h24), "More options for <title>" (24x24), branch/project pill (h20, px5, 12px, r6). Right buttons 26x26 r6: Terminal, Changes, Browser, View options.

## Sidebar
- Width 288 (resize handle 12px, col-resize, role separator "Resize sidebar"), bg #111111, padding-top 36, body padding 4px 8px, body gap 8.
- Row: height 26, width 269, r6, padding-x 2, gap 4, 13px / 19.5px, weight 400. Leading slot 24, icons 16. Hover #ffffff13, selected #ffffff26. Hover/selected fade mask 24 (44 on hover) behind the row's control.
- Group header: height 34 (pt12 pb4 pl6 pr1), 12px/16px, #898781; header buttons 24x24.
- Status dot: slot 14, dot 6, circle. Idle = 1px ring #898781 at 50% opacity, transparent fill. Running = solid #898781 blinking (opacity .3 to 1, 1.2s). Unread/attention = #2a78d6.
- Nav rows in order: New (Ctrl+N on hover), Projects (Beta chip), Artifacts, Customize, More. Groups: Pinned (hidden when empty), then one per folder.
- Footer: height 44, user button h28, icon button 24.
- Transitions: 0.12s fast, 0.3s slow, `cubic-bezier(.32,.72,0,1)`.

## Transcript
- Scroller at x297,y41. Column 840 wide with 32 gutters, text width 768 (gutter 16 below a 560px container). Turn gap 20 (16 compact). Scrollbar gutter stable both-edges. The list is virtualized.
- User bubble: right aligned, max-width 638, padding 8/12, r10, bg #ffffff0d, text 14/18.
- Assistant text: 14/20, weight 400, #f0efec; strong 600; h3 15.75/20.475 w600 margin-top 21; paragraph padding `0 56px 0 4px`, lists `0 56px 0 28px` (item pl 7); block gap 20.
- Inline code: 12.6px mono, padding 0.7875px 3.15px, r5.04. Code text 13/19.
- Status/tool row ("Ran a command, used a tool"): height 24, margin -4px 0, padding 2px 4px, r6, gap 6, 14px, chevron 12px #898781 (rotates when open).
- Message actions toolbar (opacity 0 until hover; reveal .12s delay .1s, hide 60ms): 24px buttons, 16px icons, r6, #898781 -> #f0efec, hover #ffffff13. Buttons: Copy, Rewind to here (user only), Fork from here, Pin as chapter, Read aloud. Time 13px tabular-nums.
- Scroll-to-bottom button 36px, aria "Scroll to bottom".

## Composer
- Dock 768 wide, children gap 6, over #151515. Order top to bottom: approval/question card (when pending), repo strip, box, toolbar row.
- Repo strip: separate card, height 40, r10, padding 8, gap 5, bg #ffffff0d, buttons h24 r6 px5. Contents: repo/branch controls, "<N> additions, <M> deletions", "Create PR", "More PR options", "Dismiss".
- Box: width 768, min-height 40 (one line; textbox 24 high), textarea max-height 384, r12, padding 8, bg #20201f, shadow `inset 0 0 0 1px #ffffff1a, 0 4px 20px #00000009`, transition `.2s cubic-bezier(.4,0,.2,1)`. Text 14/20, placeholder #898781, caret #f0efec. Send button 24x24 (glyph "Send").
- Toolbar row sits below the box (not inside): height 20, margin-top 6, padding-left 7, right 10, buttons h20 r5 px6 12px #c3c2b7, icon buttons 20, right group gap 4. Items: Add (+), Press and hold to record, Dictation settings, mode name, "Model: <name>", "Effort: <name>", Fast mode, usage ring (20px).
- Placeholder (new session): "Describe a task or ask a question".

## Menus
- Menu: r10, bg #20201f, ring `inset 0 0 0 1px #ffffff1a`, shadow `0 8px 24px #00000052, 0 2px 6px #0003`, padding 4, min 128 / max 320 wide, max-height 480. Item: h24 (40.5 with description), r6, px8, py2.5, gap 6, 13/19. Highlight #ffffff13. Description 13px #898781. Header 13px/500 #898781, h23. Separator 1px, inset 8. Shortcut 13px tabular-nums #a5a49a. Menus open **above** the composer triggers; sidebar More opens to the right.
- Permission mode (role menuitemradio): header "Mode"; Auto (Recommended badge, "Claude handles permission decisions", 1); Manual ("Always ask before making changes", 2); Accept edits ("Automatically accept all file edits", 3); Plan ("Create a plan before making changes", 4); Bypass permissions (Default badge, "Accepts all permissions", 5). Selected item shows a check instead of its number.
- Model (menuitemradio): Opus 5.5 (1), Fable 5.1 (2), Sonnet 5.5 (3), Haiku 4.5 (4), separator, "More models" with right chevron.
- Effort: a `role=dialog` popover (r22, bg #20201f, padding 12, width 220, max 320, shadow `inset 0 0 0 1px #ffffff1a, 0 8px 24px #000`), not a menu. Header "Effort" + current level name + "About effort" (?). 6-stop slider, labels "Faster" (left) and "Smarter" (right), caption under the handle. Slider track #ffffff1a, fill #ffffff59, handle #ffffff, stop dots #ffffff40.
- Plus: Add files or photos (Ctrl + U), Add folder, Slash commands, Connectors (submenu), Add plugins.
- Sidebar More: Routines, separator, "Edit sidebar…".

## New session screen
Greeting "What’s up next, <name>?"; stats card with tabs Overview / Models and ranges All / 30d / 7d (Sessions, Messages, Total tokens, Active days, Peak hour, Favorite model); tip banner with "Try it" and Dismiss; "What’s new" top right; composer with env pills: Local, folder, branch + worktree checkbox, "Add another folder".

## Radii / z-index / motion
Radii: 2, 4, 6 (row/button), 8, 12, 16, 24; 5 small button, 7 chrome button, 10 bubble/menu/strip, 12 composer, 22 popover dialog. z-index: chrome 21, coachmark 35, modal 40, popover 50, tooltip 50, toast 60. Default transition 150ms `cubic-bezier(.4,0,.2,1)`; snap ease `cubic-bezier(.32,.72,0,1)`; ease-out `cubic-bezier(.165,.84,.44,1)`; button paint 60ms. Keyframes (blink, pulse, shimmer, spinner, bubble enter, approval enter) are copied verbatim in `tokens.json` `keyframes`.
Tooltips: bg #20201f, fg #f0efec, z 50; the show delay is set in JS and was not measurable.
