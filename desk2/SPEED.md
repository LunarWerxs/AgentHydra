# Desk 2 speed notes

Numbers from `bun e2e/stream-frames.e2e.ts` (see the README): one long reply (an em dash in the prose, a
240-line TypeScript block) streamed into the transcript in chrome-headless-shell, 110 chunks, one per
begin-frame at 120 Hz. Style recalcs, layouts and DOM mutations are counts and repeat exactly; frames over
the 8.33 ms budget come from main-thread timings and move between runs.

## 2026-10-05, rough first look (MPC-HELL: Ryzen 9 7950X, 63 GB, Windows 11; box busy with other agent work)

| metric | value | repeats? |
| --- | --- | --- |
| style recalcs (total / per chunk) | 213 / 2 | identical in 3 runs, chunk by chunk |
| layouts (total / per chunk) | 105 / 1 | identical in 3 runs, chunk by chunk |
| DOM mutations (total / per chunk) | 107 / 1 | identical in 3 runs, chunk by chunk |
| frames over 8.33 ms | 87-88 of 110 | no: 81-88 across 6 runs |
| main-thread ms per chunk | median 16 ms, p90 35 ms, max 134 ms | no |

Most chunks are over the 8.33 ms budget on this first look, so the streaming path is not yet inside a 120 Hz
frame. Early chunks cost about 3 ms and chunks past the middle of the reply 18-23 ms, so the per-chunk cost grows with the reply's length; the single slowest chunk differs from run to run. Read these as a starting point, not a verdict:
the machine was loaded, and the timing rows need a measured band before any change is judged by them.

## 2026-10-06, first gestures and the Instances table (headless Edge through CDP input)

- `bun run e2e:gestures`: 39 cases in 4 min 8 s, 6.4 s a case. The scratch probe it came from took about 9 min
  for 42 cases (about 12.5 s a case), because it slept a fixed 8 to 13 s per page; the check waits for its target
  to hold still for 1.5 s, and on the AgentHydra pane for 6 s after load.
- AgentHydra pane startup JS 388 to 371 KB, Desk window 813 to 819 KB, on e2875fdd.
- The desktop Instances table re-sorts once about 4.2 s after it shows, when the warm data App.vue starts at idle
  arrives: its first row moves (rows are keyed by folder, so it is a move, not a remount), and a row that moves
  loses its focus and its open tooltip. One move in a 40 s watch; warm data refreshes about every 2 minutes.

## 2026-10-06, idle GPU: animations ran while nobody looked

The window's WebView2 GPU process averaged 0.34 of a core over 17 idle hours (1.09 cores in a 5 s sample). Cause:
infinite CSS animations (`animate-spin` / `animate-pulse` on running rows, the dot blink, the transcript's
spinners) kept the compositor drawing 60 frames a second whether or not the window was focused. Now
`src/lib/pause-motion.ts` puts `motion-paused` on `<html>` while the page is unfocused or hidden and
`style.css` pauses every animation under it (they resume where they stopped); `prefers-reduced-motion` drops
the pulses and slows the spinners.

Measured in headless chrome-headless-shell against an isolated server (port 7911, temp data folder), one
spinner, one pulsing dot and one `.run-pulse` dot on screen, 10 s idle, compositor frames counted by a CDP
trace (`DrawFrame`) and by `Page.startScreencast`:

| page | frames drawn in 10 s |
| --- | --- |
| before, focused | 599 |
| before, blurred (the old code never paused) | 600 |
| after, focused | 600 |
| after, blurred | 0 (screencast saw the 1 initial frame) |

Blur was simulated (`document.hasFocus` false plus a `blur` event). Not touched: `useClock`'s 1 s tick for a
working chat's elapsed time (a text update, not a compositor loop) and the AgentHydra pane's iframe (`hydra/`),
which has its own animations and no pause yet.

The launcher (`launcher/host/src/main.rs`) already sets the WebView hidden (`set_visible(false)`, plus low
memory usage) when the window is minimized and visible again on restore, so a minimized window needed no change;
only the unfocused-but-showing window drew frames, which the class above now stops.

## 2026-10-07, health pass: startup, idle and memory on a throwaway Desk

`bun e2e/perf.e2e.ts` (README) starts a throwaway Desk (a temp `HYDRA_DESK_HOME`, a free port, headless Edge
through CDP, never the live window) and reads the bundle, startup, the page's first seconds, 60 s idle in four
states (window visible, hidden, the AgentHydra pane open, no window) and the localhost list. Base: a clean
worktree at 93059069. New: the same commit with the health pass's files (commits 8d22a86d to 05dfb72d). Both were
built, then run interleaved base, new, new, base. Counts and sizes repeat; a timing on this box swings up to 3x
between two runs of the same tree, so a timing is called better or worse only when both new runs fall outside
both base runs.

Counts and sizes (exact or nearly):

| metric | before | after | what moved it |
| --- | --- | --- | --- |
| web startup bundle | 1,096,628 B (353,504 gzip) | 1,048,809 B (342,420 gzip) | the lightbox loads when a picture opens |
| AgentHydra pages startup bundle | 518,574 B (145,265 gzip) | 515,897 B (144,428 gzip) | kit variants instead of class overrides |
| page JS at load | 952 KB | 921 KB | the same |
| server fetches to the daemon per idle minute, window visible | 112 | 90.5 | a poll that just reached AgentHydra skips its ping |
| the same, window hidden | 112 | 18.5 | it rests 30 s while no window is visible |
| the same, AgentHydra pane open | 155 | 107.5 | warm data only for the view on screen |
| the same, no window | 8 | 0 | no window, no polling |
| page requests per idle minute, AgentHydra pane | 58 | 31.5 | warm data only for the view on screen |
| localhost list: scans spawned, cold / three at once / right after | 3 / 3 / 3 | 2 / 2 / 0 | one scan shared, reused 10 s |
| localhost list right after another | 709 / 1,188 ms | 3 / 4 ms | the reused scan |

Memory (two runs a side):

| metric | before | after |
| --- | --- | --- |
| server working set right after start | 103.2 / 104.0 MB | 85.2 / 84.3 MB (the Agent SDK is read on first use) |
| server private bytes right after start | 251.8 / 258.7 MB | 237.9 / 239.8 MB |
| server working set while idle, window hidden | 115.0 / 119.3 MB | 102.3 / 99.1 MB |

Timings (two runs a side; the verdict is the rule above):

| metric | before | after | verdict |
| --- | --- | --- | --- |
| server CPU per idle minute, window hidden | 375 / 594 ms | 266 / 203 ms | better |
| server CPU per idle minute, no window | 219 / 172 ms | 109 / 94 ms | better |
| server CPU per idle minute, window visible | 516 / 438 ms | 734 / 500 ms | inside the noise |
| server CPU per idle minute, AgentHydra pane | 469 / 734 ms | 500 / 359 ms | inside the noise |
| startup to first health answer (median of 5) | 250 / 209 ms | 453 / 177 ms | inside the noise |
| first contentful paint | 464 / 268 ms | 580 / 352 ms | inside the noise |
| style recalcs per idle minute, window visible | 124 / 134 | 276 / 145 | inside the noise |

The dev-servers service used no CPU in any idle state on either side.
