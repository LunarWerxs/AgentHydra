# Transcript fidelity

Compared against `docs/reference/real/` (DESIGN.md "Transcript", tokens.json `layout.transcript`, `userBubble`,
`assistant`, `statusRow`, `messageActions`, `inlineCode`, dom-outline.json `transcriptTurnTypes`,
`transcript-*.png`, `whole-window.png`). Note the real crops were taken at 125% scaling; our shots are at 100%.

Shots: `shots/transcript-before.png` (start), `shots/transcript-after.png` (whole Gallery section) and
`shots/transcript-after-top.png` (top of the finished turn: images, folded tool run, diffs).

## Matched (measured)

- Column: 840 wide with a 32px gutter, so text runs 768; 16px gutter under a 560px container;
  `scrollbar-gutter: stable both-edges`.
- Turn gap 20px (`groupRows` gives each row its gap; a status row next to another status row takes 4px off each side,
  the real `-4px 0` margin).
- User bubble: right aligned, max 638, padding 8/12, radius 10, fill `#ffffff0d`, 14/18 text, 6px inner gap,
  image attachments as thumbnails above the text (a name chip when history has no bytes), queued state dimmed
  with "Queued, sends when this turn ends".
- Assistant prose: 14/20, paragraphs padded `0 56px 0 4px`, lists `0 56px 0 28px` with 7px item padding,
  h3 15.75/20.475 with 21px top margin.
- Inline code: `#ec7e7e` on `#ffffff0d`, 1px `#ffffff1a` border, radius 5.04, padding 0.79/3.15, 12.6px.
- Status rows: 24px high, padding 2/4, radius 6, gap 6, 14px muted `#898781` text with primary targets,
  12px chevron. Consecutive tool calls fold into one row with Claude Code's own phrases
  ("Ran a command, used a tool", "Read tools.ts, searched 2 patterns, edited 2 files", present tense while
  running, `+added -removed`, "N failed"); agent and CliMayte calls break a run and keep their cards.
  Thinking is the same row ("Thought process" / "Thinking").
- Message actions: `role=toolbar` "Message actions", 24px buttons, 16px icons, radius 6, muted to `#f0efec` on
  `#ffffff13` hover, 13px tabular time, revealed on hover with the measured timings.
- Scroll to bottom: 36px round button.
- Motion: dot blink/pulse, thinking shimmer and the glyph spinner keyframes from the harvest.

## Round 3 (Jacob's own screenshots in `docs/reference/real/user/`)

- **Harness text is never a user bubble** (`ours-transcript-task-notification.png`): one classifier,
  `server/src/engine/system-text.ts`, on the live stream, a session's `.jsonl` and AgentHydra's tail.
  `<task-notification>` updates the task item by task id (kind from its summary: Dynamic workflow, Background
  command, Agent; agents, tokens and time from `<usage>`), never the XML or the result blob; reminders, caveats
  and skill expansions are dropped; `<command-name>` echoes become `/name args`; local command output, CI
  monitor events, hook feedback and wrapper-only messages are one muted line.
- **Tasks in the flow** (`real-running-task-and-attachments.png`, `real-workflow-card.png`, sampled): settled
  tasks fold into their tool run ("Ran 7 commands, read side.png, finished 2 background tasks") or one line in
  secondary text, `#c3c2b7` ("18 background commands completed"); a running workflow is a 318px card, r8,
  1px `#2d2d2d` ring, title 14px, meta 13px, 6px squares 2 apart (`#255da2` done, `#2a78d6` running, `#444`,
  outline `#303030`). "Workflow" is neutral (`#c3c2b7`, 500) in the screenshot, not the accent colour.
- **Pictures**: cached on the server by sha256 and loaded from `/api/media/<sha256>.<ext>` only. The file card
  is sampled off `real-markdown-and-file-card.png` (120x120, `#20201f`, 1px `#4d4d4c`, badge 18 high, name
  13px `#f0efec`, size 12px `#c3c2b7`); inline pictures and markdown images use the live-measured
  `max-h 360, r5, 1px border, zoom-in`. Composer attachments are the real 120px tiles 6 apart, 1px `#444`.
- **Markdown** (measured live, read-only, with `docs/reference/tools/harvest.ts` on the eek window, and on
  `real-markdown-and-file-card.png`): headings render one level down ("## x" is an h3 15.75/20.475 600, 21 above,
  7 below), the first list item has no top margin and the rest 3.4965, li padding-left 7, strong 600, links
  `#6da7ec`. Outside sessions now read their own `.jsonl`, so newlines, lists, headings and fences survive.
- **Not measurable live**: no code block, table or blockquote was on the real window's screen, so code blocks
  (panel surface, ring, 32px header with language and Copy/Copied, 13/19 mono, no wrap, diff tints, capped at
  24 lines with Show more) and tables (bordered, header on white 5%, cells 6/12) follow the tokens. The
  gallery's "Markdown and code" section and the `transcript-markdown` parity scene show them in one place.

## Still different, and why

- **Font**: the real app ships Anthropic Sans; we fall back to Segoe UI (the token layer owns fonts).
- **Code block, table, blockquote, hr, diff, todo list, Output block**: never on the real window's screen
  (round 1 and round 3 both looked), so their look follows the token layer (surface fills, `#ffffff1a`
  borders, r8) rather than a measurement. Code blocks use shiki `github-dark-default`; the real theme is
  unmeasured.
- **Permission / question / plan cards**: the real app renders these in the composer dock and NOTES.md says they
  were never seen live, so labels (Allow / Always allow / Deny, Answer / Skip, Approve plan / Keep planning) and
  layout are ours. They stay in the transcript as amber needs-you cards: a kept Hydra Desk cue. Answered ones
  collapse to a status-row one-liner.
- **Message actions**: only Copy and the time. Rewind to here, Fork from here, Pin as chapter and Read aloud need
  server routes that do not exist yet.
- **Hydra additions kept on purpose**: elapsed time in the working footer and on tool rows, the end-of-turn result
  line ("Done in 1m 12s · $0.42 · 7 turns"), the CliMayte card, sub-agent and background-task cards.
- **Stop button**: removed from the working footer; the composer owns Stop, as in the real app.
