# Orchestrator - babysit every open chat, so you don't have to

You have five Claude Desktop instances open and ten chats working. One by one they finish,
print their recap ("What I did / Am I 100% done? / Do I recommend anything else?"), and sit
there waiting for you to type the same sentence you always type: *"Resume working on whatever
you recommend next."* Meanwhile one account is quietly at 91% weekly, a repo has been dirty
for three hours because nobody committed, and a chat at 800k context should have handed off to
a fresh thread an hour ago.

The orchestrator automates that babysitting. It is **two halves**, split by a hard technical
boundary that was measured, not assumed:

1. **The watcher** (this daemon, `server/src/orchestrator.ts`) - a deterministic 60-second
   pass that reads what is already on disk and decides *what needs attention*. It costs no
   AI tokens, ever. OFF by default.
2. **The reviewer** - an ordinary interactive Claude chat you keep open, running the
   `/orchestrate` loop. It reads the watcher's attention feed and makes the judgment calls:
   nudge, answer, hand off, stop. It is the only half that can talk to your *live* chats.

## Why two halves (the delivery matrix)

Measured on 2026-08-25, Claude Code v2.1.237:

| Channel | Can reach a LIVE desktop chat? | Can reach a closed/finished session? | Available to |
|---|---|---|---|
| Peer messaging (`SendMessage`/`ListAgents`) | **Yes** - arrives as a user turn, renders in the desktop UI, session acts on it; cross-instance | No | **Interactive** sessions only. A headless `claude -p` dispatch has **no** peer tools (verified: probe returned TOOL-UNAVAILABLE) |
| AgentHydra queue dispatch (`--resume`, instance-pinned) | No - appends to the transcript, but the open renderer showing it is *not a stable interface* (see REFERENCE.md) | **Yes** - verified end-to-end, credential-pinned | The daemon |

So: the daemon cannot nudge a live chat, and a live chat's Claude cannot cheaply poll disk
every 60 seconds. The watcher watches; the reviewer speaks. Each half does the thing only it
can do.

The peer-name ↔ transcript mapping that glues them together is deterministic:
`~/.claude/sessions/<pid>.json` is the live registry - `name` is the peer address
(`publicprojects-c5`), `sessionId` is the transcript id, plus cwd and pid. The watcher
validates the pid is alive and joins the two worlds.

## The watcher

Every tick (default 60s, only while `enabled`):

- **Live sessions** - reads the registry, tails each live session's transcript (adaptive
  window; some transcripts carry multi-MB single lines), and classifies: how long quiet, what
  ended the last turn (reusing `session-ending.ts` - complete / interrupted / usage-limit /
  overload / refused / error), whether a recap block is present, current context tokens (from
  the last assistant event's usage), any `spawn_task` chips in the tail, and the last real
  human message.
- **Usage** - reads the existing usage cache (`usage-cache.ts`; zero extra network) and bands
  every instance: ok < soft (80) ≤ elevated < warn (85) ≤ high < hard (90) ≤ critical. Flags
  band *crossings*, spikes (weekly % jumping ≥ `spikePct` between reads), and applies the
  reset-soon exemption: an account resetting within `resetSoonMins` is a *dump target*, not a
  problem.
- **Git hygiene** - for each live session's cwd that is a git repo: dirty file count, how long
  it has been continuously dirty (persisted across restarts), current branch, unpushed count.
  A non-main branch or a worktree checkout is flagged immediately (standing owner rule: work
  happens on main).
- **Attention feed** - everything that crosses a threshold becomes an attention item with a
  stable key, a tail snippet big enough to judge from (so the reviewer never has to open the
  transcript), and cooldown tracking. The reviewer acks what it acts on; acked items stay
  suppressed until the cooldown passes *and* the session has moved since.

The watcher **never**: calls Anthropic, messages a session, starts a run, force-pushes,
touches your repos, or resumes rate-limited sessions (that is the existing auto-resume
monitor's job, and they compose fine).

### API

```
GET  /api/orchestrator            settings + attention feed + the instances routing table + holds + tick metadata
POST /api/orchestrator            patch settings ({ enabled: true } is the on switch)
POST /api/orchestrator/ack        { key, action, cooldownMins? } - reviewer marks an item handled
POST /api/orchestrator/check      run one pass now
POST /api/orchestrator/hold       { session_id, held } - park/unpark one thread (/delayo, /resumeo)
POST /api/sessions/launch-terminal  { cwd, prompt, instance_ref?, model? } - open a VISIBLE
                                  terminal running a new interactive session on that account
```

**Parking a thread**: type `/delayo` in any chat and the orchestrator stops prompting it -
no resumes, no handoffs, no hygiene nudges - until you type `/resumeo` there. The watcher
drops a held thread's items entirely and the feed's `holds` list shows what is parked, so a
delayed thread is invisible to the reviewer but never forgotten. Holds persist across daemon
restarts and have no expiry.

The feed's `instances` array is the routing table: every desktop instance with `isRunning`,
account, plan, weekly %, band, reset-soon and staleness. **Open means running, nothing else** -
a running instance with zero chats is open capacity, and a session on a non-running instance is
not resumable and not the orchestrator's to touch (the first live run undercounted the fleet by
inferring openness from which chats existed; this table is the fix).

Same four verbs over MCP: `get_orchestrator`, `set_orchestrator`, `orchestrator_ack`,
`orchestrator_check`.

### Attention item kinds

| kind | meaning | typical reviewer action |
|---|---|---|
| `idle_pending` | live chat quiet ≥ `idleQuietSecs` with a completed last turn; payload says if a recap is present, context tokens, ending | read tail → "Resume working on whatever you recommend next.", answer its question, or leave for the human |
| `handoff_due` | an `idle_pending` whose context ≥ `ctxHandoffTokens` | send the handoff instruction instead of a resume |
| `interrupted` / `errored` | last turn ended by interrupt/API error/refusal | usually leave for the human; overload (529) may simply be re-nudged |
| `usage_alert` | band crossing, spike, or hard breach on an instance | stop routing work there; at `hard`, tell that instance's chats to wrap up now |
| `repo_dirty` | cwd dirty ≥ `dirtyMins` with no commit, all its sessions idle | nudge the owning chat to commit + sync (path-scoped adds, never `git add -A`) |
| `branch_off_main` | a session cwd is on a non-main branch / worktree | nudge back onto main |
| `chip` | a session offered a `spawn_task` chip (title + prompt captured) | queue it via `/api/queue` on the best account, or surface to the human |
| `limit_stopped` | a live chat's last turn ended at a usage limit | none (the auto-resume monitor's jurisdiction; check `/api/monitor`) |

## The reviewer (`/orchestrate`)

An interactive chat - desktop or terminal - because only interactive sessions carry the peer
tools. Open a chat on a **low-usage account**, model **Sonnet**, and start the loop. A plain
`claude` in a terminal works exactly as well as a desktop chat: any interactive session joins
the live registry and gets the peer tools (use a logged-in CLI instance's `CLAUDE_CONFIG_DIR`
to pick which account pays for it).

**The command ships inside AgentHydra itself.** The daemon carries the file's text (bundled
into compiled builds too) and writes `~/.claude/commands/orchestrate.md` on its own the first
time you enable the orchestrator, so a fresh machine needs no manual copy. To (re)install
explicitly - a new machine, or after an update changed the command:

```
POST /api/orchestrator/install-command            installs when absent; reports 'differs' if you edited yours
POST /api/orchestrator/install-command {"force": true}   overwrite your copy with the shipped one
```

(also the `orchestrator_install_command` MCP tool). A copy you have edited is never silently
overwritten - your edits are newer intent, not drift.

What the loop does, per wake:

1. `GET /api/orchestrator` (one call). Nothing pending → subscribe `notify_when_idle` to any
   new busy peers and sleep. Something pending → judge each item by the rubric in the command
   file, act, `ack`.
2. Delivery: live chat → `SendMessage` by peer name. Closed session / new work (chips,
   handoff continuations) → `POST /api/queue` instance-pinned to the account with the most
   weekly headroom (respecting the 80/85/90 bands and the reset-soon exemption).
3. Pacing: it does not poll at a fixed 60s. `notify_when_idle` gives push notifications the
   moment a peer finishes its turn - *faster* than polling - and a long heartbeat covers
   usage/git/chips. Idle cost is a few small requests per hour.

Hard rails written into the command file: never enable or use remote control (everything
stays on this machine); never work in a worktree or branch; a real human message in a chat
pauses orchestration of that chat; never answer a session's question by picking a
destructive or regressive option - skip and surface instead; never push a public repo
without the PUBLIC warning protocol.

## Turning it on

1. Daemon side: `POST /api/orchestrator {"enabled": true}` (or the `set_orchestrator` MCP
   tool). Defaults are sane; tune later.
2. Reviewer side: open a fresh chat on a quiet account and type `/orchestrate`.

Turning it off is the reverse in either order; each half degrades safely without the other
(the feed just accumulates; the reviewer just finds an empty feed).

## Settings (all `POST /api/orchestrator`)

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | master switch for the watcher |
| `tickSecs` | 60 | pass interval (30–600) |
| `idleQuietSecs` | 150 | quiet time before a live chat counts as pending |
| `ctxHandoffTokens` | 700000 | context size that turns a nudge into a handoff |
| `softPct` / `warnPct` / `hardPct` | 80 / 85 / 90 | weekly-band thresholds |
| `sessionHighPct` | 90 | 5-hour band threshold reported alongside |
| `resetSoonMins` | 120 | within this of a reset, a high band is a dump target instead |
| `spikePct` | 5 | weekly jump between reads that flags a spike |
| `dirtyMins` | 60 | continuous dirty time before a repo is flagged |
| `nudgeCooldownMins` | 15 | default ack cooldown for session items |
| `openInstances` | `never` | whether the reviewer may LAUNCH a closed instance; `when-exhausted` allows it only once every running instance is out of headroom |
| `openMinPlan` | `Max 20` | minimum plan an auto-opened instance must have |
| `reviewerReservePct` | 75 | the reviewer's own account stays under this weekly % so it can always keep orchestrating |
| `handoffSurface` | `terminal` | where handoff continuations run: a visible terminal session (orchestratable, on-screen) or the headless queue |

## Where new sessions show up (and where they cannot)

- A **terminal launch** appears as a real window on your screen, joins the live registry, and
  is orchestratable like any chat. This is the default handoff surface.
- A **queue run** is headless: it exists only in AgentHydra's Sessions/Queue tabs (live-tail
  there). It never appears in the desktop app and the orchestrator cannot nudge it mid-run.
- **Nothing can create a chat inside the desktop app itself** - there is no stable external
  interface for that, and the desktop's own archive flag is read-only from outside too (which
  is why a handed-off chat gets AgentHydra's done-mark and a status line asking you to archive
  it in the desktop when convenient).

## Limitations, stated out loud

- The reviewer must be an interactive session; a scheduled task or headless run cannot carry
  the loop (no peer tools there - measured, not guessed).
- Headless continuation of a chat whose window is *open* is deliberately not done: the
  transcript would advance under a renderer that may not show it (REFERENCE.md documents the
  instability). Open chats are nudged through the front door instead.
- Context-size numbers come from the last assistant event's token usage - accurate enough for
  a handoff threshold, not an accounting tool.
- Windows-verified. The registry/transcript formats are the CLI's own and could shift with a
  CLI release; every parser here fails soft (a session it cannot read is reported as
  unreadable, never guessed at).
