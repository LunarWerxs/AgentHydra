# Parity harness

Puts the real Claude Code desktop (the captures in `docs/reference/real/`) and Hydra Desk side by side,
pixel for pixel, so every UI fix is checked against the real app instead of memory.

## Run it

From `desk/`:

```
bun run parity <scene> [<scene> ...]      # or: bun run parity all
bun run parity window --crop 0,160,200,240 --zoom 4   # zoom one element (reference pixels)
bun run parity composer-idle --threshold 0.15         # looser colour tolerance (default 0.1)
bun run parity menu-model --dist <built web dir>      # skip the build, reuse a vite build
bun run parity window --keep --verbose                # keep tmp/parity/.runs/<id>/ (build, Edge profile), log each step
```

Each run builds `web/` into its own `tmp/parity/.runs/<id>/dist` (vite `--outDir --emptyOutDir`;
`web/dist` is never touched), serves it on an OS-chosen port, drives a private headless Edge profile over
the DevTools protocol, and removes the server, the browser and the run folder at the end. Several agents
can run it at once; output files are written to a temp name and renamed, so a reader never sees half a file.
It prints, per scene, the mismatch percent and the six worst 64 px tiles, for example:

```
window: 41.2% mismatch (...) -> tmp/parity/window/
  tile x=832 y=192 64x64: 2101 px (51.3%)
```

The route also works in a normal browser on the dev server: `http://localhost:4795/#/parity/window`.
It clears `hydra-desk.*` keys from localStorage (sidebar width/open) so every render starts the same.

## Outputs (`tmp/parity/<scene>/`)

| File | What it is |
|---|---|
| `real.png` | The reference at its own pixel size. |
| `ours.png` | Our render, cropped to the scene's `crop` and scaled into `place`, same size as `real.png`. Reference pixels outside `place` are shown dimmed and are not compared. |
| `side.png` | Real left, ours right, labelled. Look here first. |
| `diff.png` | pixelmatch-style diff: red = a real difference, yellow = anti-aliasing only (not counted), grey = equal. |
| `overlay.png` | Ours at 50% over real: doubled edges show offsets in position or size. |
| `report.json` | The numbers, the worst tiles and the scene definition. |
| `*-zoom.png` | With `--crop`: real, ours, diff and side-by-side of that rectangle, nearest-neighbour `--zoom` times. |

Read a tile as "x,y in reference pixels"; feed it back as `--crop x,y,64,64 --zoom 6` to see that spot.

## Scenes (`docs/reference/real/scenes.json`)

Window 2782x1496 CSS px, DPR 1 for all (the harvested window, `DESIGN.md`).

| Scene | Reference | Route | Our crop (CSS px) |
|---|---|---|---|
| window | user/window.webp | #/parity/window | whole window, placed at -9,8 2000x1076 |
| sidebar-user | user/sidebar-crop.png | #/parity/sidebar-user | 0,89 330x471, placed at 66,30 |
| whole-window | whole-window.png | #/parity/whole-window | whole window |
| sidebar | sidebar.png | #/parity/whole-window | 0,70 288x1276, placed at 0,176 (the list) |
| sidebar-top / sidebar-footer | sidebar.png | #/parity/whole-window | 0,0 200x70 / 0,1452 288x44 |
| sidebar-selected | sidebar-selected-row-and-hover.png | #/parity/whole-window | 0,84 288x140 |
| header, header-left, header-right | top-bar-header*.png | #/parity/whole-window | 288,0 2494x80 / 288,0 312x80 (both placed at 288,0) / 2182,0 600x80 |
| new-session | new-session-screen.png | #/parity/new-session | whole window |
| new-session-sidebar, -stats, -tip | new-session-*.png | #/parity/new-session | 0,70 288x304 placed at 0,176 / 1150,20 550x430 / 1143,1330 784x166 |
| transcript-user | transcript-user-message.png | #/parity/whole-window | 1143,125 784x144 |
| transcript-assistant | transcript-assistant-text.png | #/parity/whole-window | 1143,291 784x76 |
| transcript-inline-code | transcript-inline-code.png | #/parity/whole-window | 1143,399 784x76 |
| transcript-tool-row | transcript-tool-row-collapsed.png | #/parity/whole-window | 1145,257 780x36 |
| composer-idle / -strip / -dock | composer-idle / composer-strip-above-box / composer-dock | #/parity/whole-window | 1143,1413 784x82 / 1143,1367 784x56 / 1143,1367 784x128 |
| menu-mode / -model / -effort / -plus | menu-permission-mode / menu-model / menu-effort / menu-plus | #/parity/whole-window?open=mode / model / effort / plus | 1205,1215 303x281 / 1674,1311 152x185 / 1653,1318 244x178 / 1146,1320 241x176 |
| settings | user/real-settings-claude-code.webp | #/parity/settings | 931,408 920x680 (the dialog), placed at 186,107 1233x925 |
| diff-pane, external-session, accounts-popover, agents-bar-expanded | none yet (ours.png only) | #/parity/<name> | whole window |

Crops come from the capture rectangles in the harvest scripts (`tmp/harvest/s2.js`, the menu scripts'
trigger + menu rects padded 12 and clamped); the new-session crops were found by exact template
match against `new-session-screen.png`.

Query parameters on any route: `open=plus|mode|model|effort` opens that control (synthetic pointer
events on its trigger), `hover=<css selector>` or `hover=text:<label>` moves the real mouse there before the
screenshot, `draft=<text>` replaces the composer text.

## Intentional departures (Jacob, 2026-10-04)

Round 3 removes parts of the real app on Jacob's request ("you can delete Projects, Artifacts, Customize
and More ... Delete the little dots that say Chat and Co-work, we just need the Claude Code side"). The
captures still show them; Hydra Desk does not. A mismatch in these places is not a regression:

- Sidebar nav: only New is left. Projects (Beta), Artifacts, Customize and More (with its menu: Agents,
  Routines, Edit sidebar) are gone, so everything below New sits 106 px higher than in the captures
  (4 rows of 26 + 4 gaps of 0.5). `sidebar`, `sidebar-selected`, `sidebar-user` and
  `new-session-sidebar` shift their crop by that much (`place` puts it back on the reference); the
  `sidebar-more` scene was removed with the menu.
- Chrome bar: the Chat / Code mode switch (x 210-280 in the captures) is gone; Hydra Desk is Code only.
  `sidebar-top` stops at x 200, `header` and `header-left` start at the pane (x 288). With the sidebar
  hidden the title bar starts at x 142 instead of 214.
- Sidebar footer: the profile pill opens the accounts popup and the gear opens Settings directly; the
  accounts popup is Hydra Desk's own compact list (no real capture exists).
- Settings is cleaned of the real app's account/billing/connector sections ("got a whole bunch of
  garbage in it"): no guest pass, Account, Privacy, Billing, Usage, Capabilities, Memory, Design
  systems, Reflect, Time and focus, Cowork, Claude in Chrome, Extensions, Developer, Skills,
  Connectors or Plugins. The dialog keeps the real shape (nav with Search and captions, rows of label,
  description and control) and holds only what Hydra Desk has: General, Accounts, CliMayte, About.
- New-session pills: no Local/Cloud pill ("All chats start on this computer always"), so the folder pill
  starts where Local sat and every pill after it sits one pill width further left than in the captures.
- Plus menu: no Add plugins row ("you can delete the weird connectors and plugins"), so `menu-plus` is one
  24px row shorter. Connectors stays, but lists the chat's real MCP servers instead of the real app's
  connector catalogue.
- Status dots: a finished, unread chat is orange (`--status-needs-you`), not the real app's blue ("it
  needs to go orange when it's done ... when it's waiting for attention"), so every unread row in the
  sidebar scenes differs in hue. A usage-limited chat is a pink hollow ring (`--status-limited`), its
  own colour, with the "resets ..." label in `--status-limited-text`.
- Sidebar filter: Active (default), Archived, All instead of a "Show archived" toggle.
- Usage limits: a chat placed by Auto does not stop at its account's limit ("why didn't it already swap"):
  it continues on another account, and its transcript gets a line such as "#128 hit its 5-hour limit.
  Continuing on #94." The real app has one login and only waits.
- Collapsed sidebar: pointing at the show-sidebar toggle or the window's left edge slides the sidebar in
  over the content (as the real app does); no capture of it exists, so it has no scene.
- Sidebar search ("make that use the Agent Hydra's search"): under the title matches an "Everywhere"
  section lists AgentHydra's transcript search hits (two-line rows: title, folder and age, the matching
  line). The real search box only filters titles; no capture exists of the added section.
- Row menu: Open in lists File Explorer, Copy resume command and Copy session ID (the real submenu was
  not captured); Stop is added above Pin while a turn runs; outside sessions (Claude Desktop, CLI) get
  the menu without Delete, since their files belong to the app that ran them, and their pin, archive,
  unread, title and group live in Hydra Desk's own session meta.
- Whole-window scenes (`window`, `whole-window`, `new-session`) cannot crop these regions out: read their
  sidebar column as different on purpose and judge the pane from `side.png`.

## What the page renders (`web/src/dev/parity/`)

`ParityPage.vue` mounts the real `DeskFrame` (sidebar, chrome, header, transcript, composer, panes) with
a fixture `ShellSource`, `ComposerApi` and `PaneApi` (`scenes.ts`), and the clock frozen (`clock.ts`).
`fixtures.ts` holds the visible content of the references: the sidebar groups, titles and dot states
(solid grey = running, blue in the references / orange here = unread, amber = needs you, ring = idle), the transcripts word for word, the
repo strip numbers and the drafts. `agents-bar-expanded` renders `Composer` alone with CliMayte worker
fixtures, because `DeskFrame` does not pass worker or dock state to its composer.

## Assumptions

- `user/window.webp` (2000x1079) is a downscaled screen capture of the same 2782x1496 window: scale
  2000/2782 = 0.719, window at x -9 (left edge off-screen), y 8 (another window's strip above), bottom
  4 px cut. Measured from the sidebar border (x 197.5), the right edge (x 1991) and the top edge (y 7.5).
  The native minimise/maximise/close buttons and the other windows around it are not ours to draw. Its
  lossy, scaled pixels mean the percentage stays high even when the layout matches: use side/overlay.
- `user/sidebar-crop.png` is 1:1 (the sidebar is 287 px wide in it); the 66 px left of the window are
  ignored. Its y offset (165) lines up the 'connections' header (crop y 45) and first row (crop y 72) with their CSS y 210 / 237 in `sidebar.png`.
- The first lines of the long user message in `window` are scrolled out of view in the reference; the
  opening sentence in the fixture is invented, the visible lines are copied.
- Tool runs: the real "searched code" phrase is produced by Hydra Desk as "searched 2 patterns" from two
  Grep calls; that difference is the transcript's to fix, not the fixture's.
- The composer text in both references is drawn in the muted colour; the fixture types it as a draft.
- Blinking/pulsing status dots are captured after a fixed 2 s of virtual time, so their phase is stable
  run to run but not necessarily the reference's phase.
- Fonts: Segoe UI on this PC, as in the real app without `anthropic-sans`.
- WebP and PNG decoding, scaling and diffing run inside the same headless Edge (canvas), with a port of
  pixelmatch 5 (`docs/reference/tools/parity-page.js`): no sharp, no native modules, no installs.
