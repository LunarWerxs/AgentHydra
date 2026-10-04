# Panes fidelity (Changes pane, Settings dialog, read-only external session)

No capture of the Changes pane or the external session exists in `docs/reference/real/` (Settings has
one now, below), and the live app (instance eek, pid 64264
on 2026-10-04) had no right pane open, so nothing here is compared pixel for pixel. What was read from
the live app, read-only (`tmp/harvest/panes-probe*.js`, CSS rules and computed custom properties only,
no clicks):

| Thing | Real value | Where we use it |
|---|---|---|
| Git add / remove text | `#32d74b` / `#ff2c56` | file-row counts, diff `+`/`-` |
| Git add / remove line bg | `color-mix(in srgb, <git colour> 20%, transparent)` | diff rows |
| Diff text | mono 13 / 19 (`--cds-font-size-code`, `--cds-leading-code`), `calt`/`liga` off | diff table |
| Diff gaps | inline 12 (`pad-md`), block 6 (`pad-xs`) | gutters, hunk rows |
| Switch | h 20, w 36 (h x 1.8), knob 16 white, moves 16; track white 10%, hover 20%, on `#2a78d6` | `PaneSwitch.vue` |
| Segmented control | track white 5%, thumb white 10% | Settings, General > Effort |
| Pane columns | 1px `#ffffff1a` border between columns, 12px resize handle centred on the edge with a pill on hover, 44x8 grip at the top centre | NOT built (see below) |
| Terminal background | `rgb(16,16,16)` | no terminal in Hydra Desk |

Derived from the measured patterns, not seen: pane header (h 32, 13/500 title, branch pill h20 r6 like the
title bar, 24px r6 icon buttons), file rows (the sidebar row: h 26, r6, 24px leading slot, hover 7.5%,
selected 15%), "N files changed" header (the sidebar group header: 34 high, 12/16 muted), selects (menus use the composer's measured menu classes), the external
session's bottom strip (the repo strip: h40, r10, padding 8, white 5%).

## Settings: a dialog shaped like user/real-settings-claude-code.webp, parity UNVERIFIED

Jacob sent the real Settings (2026-10-04, `docs/reference/real/user/real-settings-claude-code.webp`,
2000 wide at 1x) and asked for its look without its clutter ("got a whole bunch of garbage in it"). Read
off that image by eye, not measured with a tool:

- A centred dialog (real 1233x925, rounded, `#20201f`, X at the top right) over the dimmed window. Ours
  is min(920, 100vw - 48) x min(680, 100vh - 48), r12, the popover shadow, the dialog primitive's X;
  Esc or the X selects the view it was opened over (`viewUnder` in `shell/logic.ts`).
- Left nav (real ~185 wide, a shade darker than the content, 1px rule on its right): Search (magnifier,
  "Search") on a lighter field, then 12px muted captions ("Settings", "This computer") over 32px rows,
  16px outline icon + 13px label, `--text-2`; the current row `#ffffff26` and `--text`. Ours: `--bg-panel`,
  160 wide below 1024px of window, 185 above, a scrolling pill row below 640px. General's icon is the
  lucide `Settings` gear (also the sidebar footer's, which was `Cog`).
- Content scrolls, padding 24 (48 on top, clear of the X): 13px semibold group headings, rows of a 13px
  `--text` label over a wrapping 13/19 muted description with the control on the right, 1px
  `#ffffff1a` rules between rows, no cards. Controls: the CDS switch (`PaneSwitch.vue`, blue when on),
  the composer's measured menu for selects on a white-5% bordered trigger, a segmented control for
  effort, a number field, the repo strip's button for Test.
- Search filters every row by label and description (`panes/settings.ts`), shows the hits under their
  section's name, "No settings match" when none. Arrow keys, Home and End move through the nav rows.
- Rows (unchanged data, `PUT /api/settings`): General (default model, effort, permission mode,
  notifications with Test, close idle after), Accounts (the account popup's rows, embedded), CliMayte
  (delegate on/off, workers running now, bridge status and URL), About (version, data folder; the
  folder shows the server's `home` when `/api/health` returns one, else the default path).

Left out on purpose (PARITY.md "Intentional departures"): the guest pass card, Account, Privacy,
Billing, Usage, Capabilities, Memory, Design systems, Reflect, Time and focus, Cowork, Claude in Chrome,
Extensions, Developer, Skills, Connectors, Plugins, and the code appearance / font rows (Hydra Desk has
no such setting). Parity scene `settings` crops our dialog onto the real one; it has not been run.

## Background tasks (round 3): built from real-background-tasks-panel.png, parity UNVERIFIED

`web/src/components/tasks/BackgroundTasksPanel.vue`, opened by `desk.openBackgroundTasks(taskId?)`
(a window event DeskFrame listens to): the inline '1 running task' row under the last message
(`RunningTasksRow.vue`, real-running-task-and-attachments.png) and the composer's agents chip. Parity
scene `background-tasks` (fixtures in `web/src/dev/parity/tasks.ts`: the screenshot's round-2 run).

Measured at 1x on the real capture: panel r8, 1px white-10% border, `--bg-panel`, 2px below the title
bar and 8px from the right and bottom; header 34 high, title `--text-2` at x+8, expand and close
buttons 24px; body padding 20, 'Running' muted, card `--fill-5` r8 padding 8; title, 'Workflow' and
the counts in `--text-2` (label and numbers semibold), units and the description muted (19px lines);
stop button 20px white-10% r4 with a 10px rounded square; 'Phases' semibold `--text` 21px below the
description; the open phase a `--fill-5` row 44 high (name, done/total, chevron down; 6px squares
2px apart, 6px under the name); the agent table 20px rows, columns Model 50 / Tokens 48 / Time 72
right edges at 755/803/867; collapsed phase rows 40 high; 'Finished N >' muted 16px below the card
with a 14px trash at the right.

Progress squares in the real captures (panel and workflow card alike): a dim blue (accent ~73%), a
full accent blue, a white-20% grey and a white-12% outline. Read here as done, running, waiting; a
failed agent is a dim red. Not proven which is which: the two blues might be two running agents in
different blink phases.

Known differences, by design:
- 'Workflow' reads 'CliMayte', and a group's phases are its workers' kinds (code, docs, fix, ...):
  CliMayte has no workflow script, so a phase that has not dispatched any worker yet (the real
  'Reaudit') does not exist and the squares count only dispatched agents.
- An 'All' toggle beside 'Running' lists every worker AgentHydra has, not just this chat's.
- Width 440 (the real panel took 805 of a narrow capture; its width rule is unknown); expand fills
  the main area.
- The parity loop was not run: the builder seat refuses the browser tool, so no zoom-3 comparison.

## Please send screenshots of

1. The Changes pane open with a file list, and with one file's diff open (unified or split?).
2. Hover on a changed-file row and on the pane's header buttons; the pane's close control, if any.
3. The resize handle between the chat and the pane while hovered or dragged.
4. The Terminal and Browser panes (Hydra Desk does not have them).
5. One Settings select open and one switch hovered, to match those states.
6. A Claude Code CLI session opened in the desktop app, if it shows one read-only.

## Owned by others, still differing

- `DeskFrame.vue` hosts the pane in a fixed 380px `aside`: no resize handle, and it does not bind
  `DiffPane`'s `@close` (the close button shows only when the host listens).
- An idle Claude Code session from elsewhere has a "…" menu in the title bar holding only the Account
  submenu (where its next message continues it), and a quiet line over its composer saying so.
