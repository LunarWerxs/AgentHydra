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
