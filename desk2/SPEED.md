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
