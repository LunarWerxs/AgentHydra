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

Timings and page counts (four runs a side, two interleaved rounds; the verdict is the rule above, with every new
run outside every base run):

| metric | before | after | verdict |
| --- | --- | --- | --- |
| server CPU per idle minute, window hidden | 375 / 594 / 594 / 453 ms | 266 / 203 / 219 / 219 ms | better |
| server CPU per idle minute, no window | 219 / 172 / 219 / 328 ms | 109 / 94 / 109 / 94 ms | better |
| server CPU per idle minute, window visible | 516 / 438 / 469 / 844 ms | 734 / 500 / 609 / 531 ms | inside the noise |
| server CPU per idle minute, AgentHydra pane | 469 / 734 / 438 / 578 ms | 500 / 359 / 438 / 547 ms | inside the noise |
| startup to first health answer (median of 5) | 250 / 209 / 320 / 296 ms | 453 / 177 / 253 / 187 ms | inside the noise |
| first contentful paint | 464 / 268 / 296 / 328 ms | 580 / 352 / 484 / 368 ms | inside the noise |
| shell drawn | 257 / 176 / 222 / 198 ms | 485 / 291 / 377 / 297 ms | worse here, not reproduced (below) |
| style recalcs per idle minute, window visible | 124 / 134 / 44 / 163 | 276 / 145 / 390 / 350 | worse: the row glide (below) |
| style recalcs per idle minute, AgentHydra pane | 218 / 148 / 97 / 166 | 458 / 235 / 377 / 400 | worse: the row glide |
| style recalcs per idle minute, window hidden | 59 / 93 / 39 / 110 | 35 / 26 / 39 / 37 | inside the noise (39 on both) |

The dev-servers service used no CPU in any idle state on either side.

The AgentHydra pane rows above show the pane the way the owner's window last left it: the pane's shared preferences
come from the live daemon, and by 2026-10-08 that was the Free view, an empty table on a throwaway Desk (both sides
alike). The meter now answers those preferences as a fresh window's, so the pane shows All (61 rows on this PC), and
a later pane row is not comparable with these.

**What restyles while idle.** A second probe on the same two trees injects counters into every frame before the
page's own scripts (mutations by element shape and attribute, never text; timers; animation frames; WebSocket
message types) and reads 20 s idle with the window visible, then with the AgentHydra pane open. The rise has one
cause: 8df6a007 gave Vue's TransitionGroup a `.v-move` rule, the move transition the Architect's
`transitiongroup-flip-move-integrity` check asks for (it gates a list whose reorders snap). With it, each
outside-session update that reorders the sidebar or the cloud list glides the rows that moved: transform style and
class writes on them (15 to 25 per 20 s here), and a restyle each frame while the 150 ms glide plays. With the rule
taken out of the new tree, its restyles per 20 s matched the base (visible 28 / 66 against 35 / 47, pane 19 / 53
against 50 / 38); with it, the pane read 88 / 119 against 49 / 56. Both trees got the same WebSocket traffic (4 to
7 outside-session updates per 20 s) and ran the same timers. The glide stays, since the check asks for it, and it
only runs while rows move. These counts swing run to run because the sidebar lists the live AgentHydra sessions: how
many rows reorder depends on what the other chats are doing at the time.

The shell-drawn rise did not reproduce. In the restyle probe's runs on the same builds (6 a side, run to the same
point), the shell was drawn in 193 to 693 ms on the base and 195 to 343 ms on the new tree.

## 2026-10-08, the AgentHydra pane again, with its full table

The meter now gives the pane a fresh window's preferences (above), so the pane shows All: the Instances table with
every account (61 rows on this PC) instead of the empty Free view. Same method: a clean worktree at 93059069 (before
the health pass) and one at d545d8df, each built in its own folder, `PERF_ONLY=page,idle`, 60 s idle per state, run
base, new, new, base. Per idle minute:

| metric | before | after | verdict |
| --- | --- | --- | --- |
| server fetches to the daemon, pane open | 153 / 160 | 104 / 108 | better |
| page requests, pane open | 58 / 62 | 31 / 31 | better |
| page KB downloaded, pane open | 336 / 354 | 219 / 219 | better |
| server CPU, pane open | 563 / 719 ms | 516 / 453 ms | better (both new runs under both base runs) |
| server CPU, window visible | 797 / 531 ms | 484 / 422 ms | better |
| server CPU, window hidden | 516 / 672 ms | 47 / 297 ms | better |
| server CPU, no window | 297 / 313 ms | 203 / 63 ms | better |
| server working set, pane open | 116 / 120 MB | 103 / 105 MB | better |
| page main-thread ms, pane open | 533 / 924 | 639 / 565 | inside the noise |
| style recalcs, pane open | 169 / 174 | 318 / 342 | worse: the sidebar row glide (above) |

Server CPU with the window visible and with the pane open read inside the noise in the first round; with the full
table on both sides, every new run came in under every base run, which is this file's rule for "better".

## 2026-10-08, opening and closing the window

The owner asked for the window to open, close and fill in faster. Measured on the live window from the shortcut,
four runs a side:

| what | before | after | how |
| --- | --- | --- | --- |
| launch to a visible window, server already up (median) | 591 ms | 200 ms | `launcher/start.vbs` checks `/api/health` itself (30 ms cold, 2 ms warm, 39 ms to give up on a closed port) and runs `HydraDesk2.exe` directly, then `start.ps1 -NoWindow` hidden for the tray; PowerShell's own startup was about a quarter of a second of every open (c6a778ab) |
| first paint (median) | 1.3 s | 0.9 s | the same change |
| tray check on the way to the window | 463 ms | 0 ms | `start.ps1` starts the window host before the WMI tray query; a `Get-Process` gate (about 80 ms) skips the query when no tray runs; health polled every 100 ms, not 250 ms (b64329ba) |
| close | hidden in 14-22 ms | unchanged | the host's `CloseRequested` hides the window before the event loop exits, so tearing down the WebView2s (about 0.55 s) happens off screen (e9982f31) |

Every new run came in under every old run. What fills in faster, which this table does not time (e9982f31,
b64329ba): a reload draws the chat list from its localStorage copy before the server's hello, every lazy panel and
every AgentHydra-pane tab is fetched one at a time on `requestIdleCallback` once the sidebar has data, and the Home
stats card shows its last answer while the next one is read (its four daemon reads took 3 s cold).

The daemon behind the pane was the other half. Its `STALL` lines (`daemon.log`), which since 57904add and f017a013
carry a profile for a long block (at most one such line every 30 s) and sample from boot, found where the event loop was held: a synchronous chat
list and process queries (31dd5ec8), a `spawnSync` in message delivery that froze it for 18.5 s and got it restarted
by the watchdog, a synchronous agent-catalog walk (19d99db5), CliMayte's boot reading every finished worker
(42c1ed70) and the HSwarm account map read on every ask (a54954be). Seconds blocked went from 40 per 15 minutes
before to none in a 30-minute busy sample after; `/api/health` from 1.8 s on average to 2 ms.
