# orchestrator

The fleet orchestrator: the part of AgentHydra that decides what *should* happen to a chat.

Owner order, Michael, 2026-08-31: every line of orchestration was cut out of the daemon and
rewritten from scratch as this Python toolbox, on the other side of an HTTP boundary. AgentHydra
the daemon knows what instances and chats exist and can act on one when asked; this program
decides what should happen and asks it to. Owner order, Michael, 2026-09-03: it moves back INTO
the AgentHydra repository - as this folder, unchanged in shape - so there is one program to
explain and one MCP surface to use ("so I don't have to explain that you have to use both").
The boundary survives the move: nothing in here imports the daemon, everything in here talks to
it over HTTP, and the daemon drives this toolbox only by running `python orch.py <script>` on a
caller's behalf (`server/src/orchestrator.ts`). Six MCP tools reach it: `orchestrator_menu`,
`orchestrator_run`, `orchestrator_loop`, `orchestrator_switch`, `orchestrator_operation` (poll or
list a detached run's verdict) and `orchestrator_cancel` (stop a run that is still going, added
2026-09-13, which also frees the route lock the daemon keys by script name, so a `409 busy`
refusal now names the operation holding it instead of leaving `taskkill` as the only way out).

## Why the rewrite

This is the third attempt. Both previous ones are kept in full in the archived standalone
repository (`Lunarwerx/orchestrator`, private, under `old/`), because the failures are the useful
part - and the useful part is written down here, so the code did not need to follow into a public
tree.

- **v1** (archive `old/v1/`) - a watcher daemon plus a reviewer chat, joined by a proposal ledger,
  a courier ladder and a placement balancer. Retired 2026-08-29 after four days: *"it did not
  reliably do what it was told."*
- **v2** (archive `old/v2/`) - the rebuild, as AgentHydra's own gate/act/deliver machinery.
  Retired 2026-08-31. It was more honest than v1 and still wrong in the way that matters: it kept
  acting on chats that were not finished.

### What actually went wrong in v2, in one paragraph each

**It archived work that was waiting on a person.** The gate called a chat finished when its recap
said "Am I 100% done? - Yes", and asked only one further question: does the message end in a
question mark? A chat that said *"Say the word and I start burning item 1"* has no question mark,
so it was filed away while it sat waiting for that word. Measured across the fleet: **6 of 29**
chats archived in one day were waiting on the owner, and one was archived twice - the second time
by the very call that was trying to hand it the answer, because acting re-ran the same broken
verdict first.

**It retried things that could never work.** A standing loop ticked every 2 minutes and re-drove
the app's Archive control for any chat the disk called archived while the app still showed it. On
an account with 227 such chats and an app that had been open for a day, no click could ever land -
the app only re-reads those flags at restart. There was no memory of failure anywhere, so it
hammered the same rows forever. The commonest failure was *deterministic* (two sidebar rows sharing
a title, which the UI tool correctly refuses to disambiguate), and it retried that too.

**Both bugs have the same shape, and it is the thing to design against:** a verdict computed from a
cheap proxy (a question mark; a disk flag) and then acted on repeatedly, with nothing anywhere
counting how many times the same act had already failed or measuring whether it achieved anything.

## The rules the rewrite inherits

1. **A chat that offers to carry on is WAITING, not finished.** Never archive one.
2. **Never act on a live turn.** Idle-but-alive is waiting; mid-turn is working.
3. **Count every attempt.** An act that has failed N times stops, loudly, and says why. A
   deterministic refusal stops after one.
4. **Never claim an act landed without checking.** A disk write that a running app will overwrite
   is not an archive.
5. **A person's word is the highest input.** If the owner answered a chat 20 seconds ago, that
   beats any verdict computed 20 seconds earlier. Re-check immediately before acting, not only
   when deciding.
6. **Report what changed, not what exists.** A status recital is a failed run.
7. **Prove you changed nothing else.** An act that verifies only the row it INTENDED cannot see
   what it also did: a move that settled its four chats correctly archived three others in the
   same minutes and reported a clean run (2026-09-16). Every move now reads the whole machine's
   chat records before and after itself and names anything it archived that it was not given.

## Layout

```
scripts/  THE REWRITE - one Python script per functionality, each runnable and testable alone
server/   the remote front-end's gateway (Bun + Hono; a root workspace of the AgentHydra repo)
web/      the remote front-end's dashboard (Vue 3 + the lunarwerx-ui kit; likewise a workspace)
docs/     the v2 retirement note, the courier spec, the old /orchestrate command, to-do harvests
state/    runtime state - ledgers, the tray heartbeat, locks, logs. Never committed.
```

(The retired v1 and v2 trees, and the v2 TypeScript as it was lifted out, live only in the
archived standalone repo.)

## Start here

```sh
cd orchestrator                # this folder, inside the AgentHydra checkout
python orch.py                 # the menu: every script and what it does
python orch.py loop            # DRY: walk the whole orchestration, print what it WOULD do
python orch.py <script> --help # any script explains itself
```

From an agent, the same three are `orchestrator_menu`, `orchestrator_loop` and
`orchestrator_run { script, args: ["--help"] }` on the AgentHydra MCP server; `bun run
orchestrator <script>` from the repo root is the shell equivalent.

For Claude Desktop archive and migration-source cleanup, use the production scripts: they
attempt the exact-profile native route before the legacy actuator. Enable **Settings → General
→ Claude native control → Start debugger automatically** for each profile, or configure
`launchDebugger:true` through `/api/claude-native/settings`. The next AgentHydra **Open** starts
the connection without a Developer-menu click; saving settings does not restart active apps.
Use `native-only` when UI fallback is unwanted. Refused or uncertain native mutations never
fall back to UI/Lua or disk flags. New profiles require an explicit setting. See the
[native-control operating guide](../docs/CLAUDE-DESKTOP-NATIVE-CONTROL.md) before reaching for
the POC runner or desktop controls. Destination migration settings and unarchive still have
legacy/guarded steps; this is not a fully native move implementation.

## Decide how it behaves: `orch.py policy`

**Every knob is in one place with a default, and the default is what used to be hardcoded.**
Before 2026-09-17 there were 138 user-facing policy knobs spread across 18 files as module
constants and unswitchable `always-on` behaviours, and no config file at all - steering the
fleet meant editing Python. Now:

```sh
python orch.py policy                     # what is set, what is not at default, and the rails
python orch.py policy --wizard            # a person: every group, Enter keeps the current value
python orch.py policy --ask > q.json      # an AI: the questionnaire...
python orch.py policy --apply answers.json  # ...and its answers, applied atomically
python orch.py policy --set archive.per_run=5 lanes.deliver=off
python orch.py policy --preset conservative --yes
python orch.py policy --explain gate.signal_no_open_recommendations
```

Your decisions live in `state/config.json` (gitignored, machine-local). Values equal to the
default are not written, so a later default change still reaches a machine that never disagreed
with it. **Precedence is always: a flag you typed > `config.json` > the default.** Turning a
sweep lane off changes what `--all` does; naming that lane explicitly still runs it (the one
exception is `archive.enabled`, the fleet-wide master switch: with it off, no lane archives,
named or not).

**A policy file with any problem stops unattended acting** - unreadable JSON, a value that
fails its check, or a key the toolbox does not know (a typo like `archive.enable` would
otherwise read as "archiving is off" and change nothing). Each of those falls back to a
default, and a lane acting on a default where you wrote the opposite would undo your decision.
`orch.py policy --doctor` names them; `policy --unset <key>` removes an unknown key; `--force`
still runs a single act by hand. Writes are atomic and one at a time, and a note you add by
hand (`"_why": "..."`) survives the next rewrite.

**Groups:** the gate (timings, and its four archive signals with a switch each) · archiving
(master switch, quiet window, caps, knowledge preservation, the grace window) · the sweep's
lanes and its naming/doctrine passes · the doctrine stamps themselves · the groundskeeper's
five duties · the usage bands · waking (including the exact wake prompt) · permission prompts ·
delivery · the judgment queue · the standing manager · all eleven scheduled lanes (on/off and
cadence) · speed.

**⛔ What is deliberately NOT a knob**, and is listed in the menu so its absence reads as a
decision rather than an oversight: the live-writer rule, the hold rail, the T-0 re-check,
post-act verification, the DENY list, the tray-icon switch, and that the shared-cause breaker
fires at all. Those are the reasons this toolbox is allowed to act unattended; a switch for one
of them is a switch for losing work.

## Prove it still works: `orch.py dryrun`

```sh
python orch.py dryrun --runs 50    # 50 dry loops, each a fresh process, all read-only
python orch.py dryrun --matrix     # does flipping a policy knob actually steer the plan?
```

One dry loop tells you it did not crash *that* time. N of them answer what one structurally
cannot: the intermittent-crash rate, where the time goes per stage, and whether the loop agrees
with itself - it fingerprints every chat's decision and reports **flaps**, a verdict that
changed *and changed back*. A flap is a timing-dependent verdict, and on an acting pass that is
the difference between archiving a chat and waking it. (A verdict that moved once and stayed is
just the fleet moving forward, and is reported as such.) A live chat that pauses past
the idle window and resumes flips `leave-alone` <-> `judgment`; that is reported as expected
(both states mean a writer is alive) and never fails the run - every other flap does.

Every run is a fresh subprocess on purpose: looping inside one process would let the
usage-survey cache and every module constant carry over, so runs 2..N would be faster and more
identical than reality - a false green in exactly the place this harness exists to be honest
about. `--matrix` judges each variant against **what it claims to change**, on evidence an inert
knob cannot fake: a cap is checked inside its own run (shown == min(cap, waiting)), and a
switched-off archive signal must release every chat the baseline shows held back by it alone.
When the fleet has nothing that could tell a wired knob from an inert one, the variant says
`INCONCLUSIVE` - not proven, and not a pass. A knob that acts at ACT time and cannot be seen in
a dry loop says `not-visible-here` and names the unit test that covers it. Reports land in
`state/dryruns/`.

## Moving a machine off the standalone checkout (once, per machine)

A machine that ran the orchestrator from its own repo (`D:\PublicProjects\orchestrator` or
wherever it was cloned) still has three things pointing THERE, none of which a `git pull` of
AgentHydra touches: the Windows scheduled tasks (`Orchestrator-*`, registered by absolute path to
that folder's wrappers), the Desktop shortcut for the tray icon, and `state/` (the ledgers, the
tray heartbeat, the usage-survey cache, `mode-confirmed.json`, `chips.json`, the chat journal).
The cut-over, from THIS folder:

```sh
python orch.py disarm                                   # the old icon down (if it was up)
robocopy ..\..\..\orchestrator\state state /E           # the ledgers + journal across, OLD wins
python scripts/schedule_jobs.py --status                # what the OLD folder registered
python scripts/schedule_jobs.py --apply                 # re-register by name -> this folder's wrappers
python scripts/schedule_jobs.py --pause                 # keep the lanes paused if they were
powershell -File scripts\tray.ps1 -InstallShortcut -Startup   # Desktop + login shortcuts -> here
python orch.py arm                                      # the icon, PAUSED, from here
```

`--apply` registers every task with `/F`, so the same-named tasks simply point at the new
wrappers - nothing to unregister in the old folder. The `robocopy` has no `/XO` on purpose: the
old tree's ledgers are the history, and the few files the new tree wrote before the cut-over
(a unit-test run's fixtures, a first attempt or two) are exactly what should lose. Adjust the
source to where the old checkout really is. The old folder can then be deleted; its repo stays as
the archive of v1/v2.

`orch.py` is the one entry point. The dry loop walks all seven stages (census, gate, accounts
and balancing, the sweep's four lanes, the naming pass, reconcile, the judgment queue) and
touches nothing, so you can see exactly what a real pass would do before arming it.
`python orch.py loop --live` is the acting version, and is identical to `sweep.py --all --yes`
- there is no third behaviour hiding in the driver.

THREE WAYS IT RUNS: (1) BY ITSELF - Windows scheduled tasks every few minutes (dashboard,
reconcile, chat-journal, todo-sweep, saturate, unblock, stall-watch, twins, chips,
groundskeeper, overlord, doctrine; `python scripts/schedule_jobs.py --status` is the live list);
(2) A PERSON - `orch.py` above, or the dashboard
at http://127.0.0.1:7799; (3) AN AI - the `/orchestrate` command (canonical copy in this repo's
`.claude/commands/orchestrate.md`, mirrored to `~/.claude/commands/`), which drives the toolbox
through the AgentHydra MCP server's `orchestrator_*` tools: dry loop -> acting sweep -> the
interview protocol. The judgment queue only drains when (3) runs.

⛔ NOTHING ACTS WITHOUT THE TRAY ICON (owner order, 2026-09-01: "it should never just do
whatever it wants without at least some occasional instruction... it can't be running without
the status bar icon, so I can terminate it if I want"). The icon (`orchestrator/scripts/tray.ps1`;
`python orch.py arm` starts it) comes up PAUSED and writes a heartbeat every 15 seconds; every
acting script asks `lib/armlib` for that heartbeat before it moves, wakes, archives, presses,
stamps or writes, and prints DISARMED instead; observing is never gated. Exit the icon, kill
it, or pick Pause in its menu and everything stops. The default on any machine is OFF.
`python orch.py arm` is HALF the start, deliberately: it registers any lane missing on the
machine and puts the icon on screen silent (owner, 2026-09-02: "so I don't have to find the
script", and "it should probably launch on pause so that it doesn't just immediately start
working"). Throwing the switch is a second, deliberate act - `python orch.py resume`, Resume on
the icon's menu, or `arm --now` for both in one command. A `/orchestrate`
the owner TYPES runs it first; a pass that is not his hand (the standing manager's own loop,
a cron-fired pass, a watchdog wake-up) never arms - a down icon there means he switched it
off, and the pass says so in one line and stops.

⛔ NEVER MOVE A WORKING CHAT (same order: "only chats that are stopped, waiting, chilling"). A
chat that is mid-turn or STUCK is never migrated by any lane: the balancer skips running
chats, the overlord's quota handoff refuses while a process is working the chat, and the
groundskeeper NAMES a live chat that is stuck or stranded instead of moving it. A chat that
is merely IDLE - its turn finished, quiet for five minutes, engine still alive only because
the desktop never stops one on its own - is "chilling": `migrate_chat --stop-idle` (which the
sweep's move and land lanes pass) stops that engine deliberately through `lib/enginelib`,
confirms through the daemon that it is gone, and only then moves the chat. Without that, no
desktop chat could ever move (live smoke, 2026-09-01: every one had a "live writer" forever).

A chat parked at a USAGE WALL needs no quiet window at all (2026-09-04): the wall is the
transcript's last record and the engine cannot write until the account resets, so `enginelib`
reads the daemon's `limit_stop.pending` (set only from the CLI's own error record) and calls it
idle at once. Before that, moving the one chat you most want off an exhausted account waited
180s for the gate to read the tail plus 300s for the window - five minutes for a state that was
already certain. Every migrate report now ends with per-phase seconds, so a slow move names
its slow phase instead of just being slow.

`--idle-wait N` (added 2026-09-03, opt-in, capped at 360s) covers the ONE refusal that time
actually cures: the turn is finished but the five minutes are not up yet. The refusal already
computed the exact deficit ("quiet 253s, needs 300s") and used to throw it away, so a caller
re-ran the command on a guess - moving four chats cost ~20 minutes of wall clock, of which the
mechanical moves were about a minute. The wait is the same 300 seconds either way; the flag
just stops paying a round trip to discover it has not elapsed, and because quiet is wall-clock
age, waiting out one chat ages the rest of a batch on the same clock. ⛔ It sleeps ONLY on
`enginelib.R_TOO_SOON`: a WORKING engine, a STUCK engine and a live writer each still refuse
in about a second, verified live. It is deliberately NOT passed by the 5-minute scheduled
lanes - they hold a lock, and a blocking wait there would starve everything behind a skipped
tick (a test asserts none of them mention the flag).
The doctrine lane (bypass-permissions enforcement, every 2 minutes) and the dashboard are the
two lanes exempt from the icon; they only ever change configuration or look.

⛔ THE APP IS THE TRUTH FOR A RUNNING APP (owner, 2026-09-01: "I have a ton of chats set to
manual or accept edits"). A running desktop app holds every chat's permission mode - and its
whole chat list - in memory and never re-reads the files. So a disk stamp the doctrine lane
writes is invisible in the app, and a disk flag the twins lane flips leaves the row on screen.
Both lanes now go through the app's own controls: the doctrine lane selects each chat in a
running app and sets its permission picker, a few per tick, keeping a per-chat confirmation in
`state/mode-confirmed.json` that is dropped the moment the disk reads anything but bypass
again - BUT ONLY WHILE THE ICON IS UP: driving a window is an act on the owner's screen like
any other (owner, 2026-09-01, after the pass flipped his windows with the icon down: "I
didn't authorize you to start one yet"). Without the icon the doctrine lane writes the disk
stamp and nothing else; the twins lane archives stale copies and GHOST rows (archived on disk, still rendered)
through the production archive route, preferring configured native control, and renames different chats that wear one title so the
owner (and the app's own row matching) can tell them apart. The legacy UIA archive path cannot
reach an unrendered row in the virtualized sidebar; native archive instead addresses its exact
session ID and does not depend on row rendering. Every legacy window driver passes
through `windowlib.instance_lock`, which now also captures and restores the window's
placement, and an app the toolbox opens that comes up maximized is put back to normal.

THE ENGINE-SIDE HALF, the one that works without a window (owner, 2026-09-02: "regarding the
manual mode - no, I am quite certain you can figure it out"). The desktop launches every
chat's engine with an explicit `--permission-mode` from its in-memory record and
`--setting-sources=user,project,local`, so the app's label decides the MODE but the user
settings still decide the RULES: permission ALLOW rules pre-approve a tool before any prompt,
in every mode. `stamplib.ensure_allow_all` keeps `~/.claude/settings.json` covering every
built-in tool and every MCP server (the ones in `~/.claude.json` plus the desktop's own), and
the doctrine lane re-asserts it every two minutes as its ungated, invisible half. A chat the
app still labels 'Accept edits' stops stalling on prompts; the label changes only through the
icon-gated picker pass.

THE PICKER, AS IT REALLY IS (measured live, 2026-09-01): the permission button beside the
composer exposes ExpandCollapse but nothing opens it except what a person does - focus it and
press Space (`approve_prompt.ps1 -SetMode` posts VK_SPACE to the render widget; no
foreground change, no cursor). The menu is five radio buttons whose names START with the mode
label and carry a description; `SelectionItem.Select` switches it. The first time a chat is
switched to bypass the app can raise a confirmation dialog: it is answered positively by
name (`Yes, I accept`, `Enable`, `Confirm`, ...), never by position, and if the mode still
did not take the lane's log lists every button on screen so an unknown label can be added.

THE CHIPS (owner, 2026-09-01: "always Start locally, never in a worktree"). The desktop plants
a `Suggested task` card in a chat's pane - title, description, branch tags, `Dismiss
suggestion`, `Start with worktree` and a `More start options` menu (`Start locally`, `Send to
cloud`, `Fix in this session`). Starting one creates a NEW chat for that task, running at once,
in the parent's folder and permission mode. `orchestrator/scripts/chips.py` (a gated 5-minute lane) does
what the owner asked instead of driving that menu: it creates the chat through the toolbox's
own spawner from the card's title and description, in the parent chat's folder, on the
parent's instance - so the duplicate guard on that exact prompt, bypass from birth,
registration and a confirmed first turn all apply - and then presses `Dismiss suggestion`
(`scripts/actuator/chip.ps1`) so nobody starts it a second time by hand. A task already open
is not started again; its chip is dismissed. Never past the running cap, never on a held
chat, never without the parent's folder. Chips are visible only in the open chat, so the lane
scans each window's open chat and the doctrine lane records any chip it sees while
confirming pickers (`state/chips.json`). The app's own `Start locally` stays in the actuator,
proven live, as the route of last resort.

Two same-titled rows in ONE window cannot be told apart by the app's controls; the twins lane
renames the top one (a rename is harmless if it lands on the other twin), reads through the
dossier which chat took the name, and corrects - after which the other row is unique again.

Layout: runnable scripts sit in `scripts/`, the seven shared libraries in `scripts/lib/`
(imported as `from lib import hydralib`), the UIA actuator in `scripts/actuator/`, tests in
`scripts/tests/`. Scripts import the libs and never each other - a review found that coupling
and it was removed.

## The remote front-end (`web/` + `server/`) - the dashboard from a phone

Built 2026-09-02, owner ask: "a front-end for the orchestrator I can access remotely using a web
URL and Cloudflare, the same tech we use for RepoYeti". So it IS RepoYeti's remote-access stack,
vendored: a **Bun + Hono gateway** (`server/`) that opens a **cloudflared tunnel** - a NAMED one
on our own zone, which is the setup here (see below); a rotating Quick Tunnel announced to
**app.repoyeti.com** is the fallback when no named tunnel is configured - gates every request
that arrives over it behind **Sign in with Connections** (public OIDC, PKCE, the id_token verified
against the IdP's public JWKS), plus a
**Vue 3 + Tailwind v4 + lunarwerx-ui** dashboard (`web/`) built on the shared kit (accent:
amber; `bun run check:kit`).

**What it can do, exactly:** everything `orchestrator/scripts/dashboard.py` answers (the plan, waiting-on-you,
every chat, instances, holds and the breaker, the accounts strip and balancing plan, the rules,
the scripts, the logic tree), and **THE SWITCH** - turn the tray icon on or off from the phone
(`python orch.py arm` / `disarm`, run on the machine). Nothing else. The Python data layer is
read-only by construction and the gateway proxies only its named `/data/*` routes; every other act
stays in the toolbox's own rails. Loopback stays open (the Python dashboard already is); only
tunnel traffic needs the owner.

```sh
bun install && bun run remote:build     # once (and after web/ changes)
python scripts/remote.py --start        # start it detached; prints the addresses
python scripts/remote.py                # status: serving? tunnel? permanent address? owner claimed?
python scripts/remote.py --open         # open it (the permanent address when known)
bun run remote                          # the same gateway, in the foreground
bun run remote:test                     # the gateway's own tests (auth gate, CSRF guard, relay, switch)
```

### The permanent addresses

Each machine gets ONE named Cloudflare tunnel on `lunarwerx.com`, provisioned by
`orchestrator/scripts/remote_tunnel.py`. Named, not quick: the hostname never rotates, it resolves on
networks that DNS-block `trycloudflare.com`, and sign-in completes on the daemon's own
`/oauth/callback` with no relay hop.

| machine | address | tunnel |
| --- | --- | --- |
| Michael | `https://orch-michael.lunarwerx.com` | `orch-michael` |
| Jacob | `https://orch-jacob.lunarwerx.com` | `orch-jacob` |

```sh
python scripts/remote_tunnel.py --status                          # what this machine is set to
```

**Setting up the second machine, start to finish.** Both tunnels and both DNS records already
exist, and both callbacks are already registered on the OAuth app, so nothing here touches
Cloudflare's configuration - the machine only needs its own connector credential.

```sh
git clone https://github.com/LunarWerxs/AgentHydra.git && cd AgentHydra/app
bun install && bun run --cwd orchestrator remote:build
cd orchestrator
python scripts/remote_tunnel.py --install-token --name orch-jacob   # needs CLOUDFLARE_API_TOKEN
powershell -File scripts\tray.ps1 -InstallShortcut -Startup         # the icon, and at every login
```

(The orchestrator is a folder of the AgentHydra repo since 2026-09-03; a machine that still has
the old standalone checkout follows "Moving a machine off the standalone checkout" above instead
of cloning anything.)

`--install-token` needs a Cloudflare API token in the environment (Account:Cloudflare Tunnel:Edit).
Through the Connections MCP it can be leased without anyone seeing it:

```sh
connections_execute { local: true, tool_name: "shell", params: {
  command: "python scripts/remote_tunnel.py --install-token --name orch-jacob",
  secrets: [{ service: "cloudflare", as: "CLOUDFLARE_API_TOKEN" }] } }
```

With no Cloudflare access on that machine, run `--export-token <file> --name orch-jacob` here,
hand the file over out of band, and `--import-token <file>` there - it shreds the file after
reading it. Then start the icon and sign in at `https://orch-jacob.lunarwerx.com`; the first
verified sign-in claims that install. Until a connector runs there the hostname answers
Cloudflare 530, which is the correct "provisioned, nobody home" state and not a fault.

⛔ **One label only.** `lunarwerx.com` is on Cloudflare's free plan, whose Universal SSL
certificate covers `lunarwerx.com` and `*.lunarwerx.com` and nothing deeper (verified: those are
the cert's only SANs). `michael.orch.lunarwerx.com` would resolve and then fail the TLS
handshake in every browser, which reads as "the site is broken". `remote_tunnel.py` refuses a
two-level name rather than shipping one that cannot serve.

⛔ **One connector per tunnel.** Two machines running the same tunnel is a load-balanced pair,
not a failover - Cloudflare splits requests between them and half the dashboard hits land on the
wrong computer. That is why each brother gets his own tunnel and `--provision --no-install`
exists for setting up the other machine's without stealing its token.

The connector token is a credential and never leaves the machine that runs it: `remote_tunnel.py`
fetches it inside its own process, writes it to the gitignored, ACL-restricted
`state/remote/config.json`, and prints only a sha256 prefix. Hand-delivery between machines goes
through `--export-token` / `--import-token`, which shreds the file after reading it.

### The tray icon owns it

There is deliberately **no scheduled keepalive**. One existed for a few hours on 2026-09-02 and
was a false kill switch: the lane was ungated, so closing the icon stopped the lanes and a task
quietly restored remote access five minutes later - and this gateway can throw the arm switch
from a phone, so that is a route to arming the machine with no kill switch on screen.

`orchestrator/scripts/tray.ps1` starts the gateway when remote access is enabled, watchdogs it every 15
seconds (stopping after three failed starts rather than hammering a broken one), and closes it
on Exit. `python orch.py disarm` closes it too - it kills the icon with `/F`, which skips the
tray's own shutdown path, so disarm stops the gateway itself.

**Every gateway supervises itself, however it was started**, reading the same heartbeat and
exiting once it goes stale. On a hard kill of the icon the stale beat has to age out first
(60 s) and the watchdog wants two consecutive stale reads 15 s apart, so the real worst case is
about **90 seconds**, not 30. A developer can opt out with `ORCH_NO_TRAY_SUPERVISION=1`, which
logs a loud warning. **Pausing the eyes does not close the tunnel** - a paused icon still beats -
because otherwise pausing from your phone would cut the connection you need to un-pause.

⛔ **Ownership can only be claimed at the machine.** While an install is unclaimed, `/oauth/login`
is necessarily outside the auth gate (a sign-in cannot require a session), so plain first-use
ownership would hand the install - and the arm switch - to whoever reached the URL first. A URL
is not a secret: it is in DNS, in certificate-transparency logs, in browser history, in any link
ever pasted. A remote sign-in against an unclaimed gateway is refused; claim it once from
`http://127.0.0.1:7790` on the machine, after which remote sign-in is ordinary.

Auth covers **`/api/*`**, not the whole surface: the static dashboard shell, `/assets/*` and the
`/oauth/*` routes are public by necessity, and `/api/health`, `/api/auth/status` and
`/api/auth/me` are deliberately public so the sign-in screen can render. Everything that reads
fleet data or throws the switch is behind the session.

The icon's menu adds: open the remote dashboard, copy the remote address, `Remote access: on/off`,
and `Restart remote access`. The shortcut runs `scripts/tray-launch.vbs` under `wscript`, which
never creates a console - a shortcut straight to `powershell -WindowStyle Hidden` still makes one
and hides it a beat later, which is the black flash on every login.

```sh
powershell -File scripts\tray.ps1 -InstallShortcut   # Desktop shortcut (add -Startup for login)
powershell -File scripts\tray.ps1 -SelfTest          # prove the wiring, arm nothing, show no icon
```

**Security model, in one breath.** No OIDC config, no tunnel - the gateway refuses to open one
(a public URL with no auth is the machine on the open internet). The first verified Connections
sign-in **claims the install** (TOFU) and is persisted to `state/remote/config.json`; after that
it is locked to that identity. Sessions are signed cookies (per-install HMAC key in
`state/remote/session.key`, ACL-restricted); "sign out everywhere" rotates the key. The relay
sees the OAuth code in transit but cannot redeem it (PKCE verifier lives only in gateway memory).
`state/` is gitignored, so nothing of this ever lands in the repo. The OAuth client is the
registered "Orchestrator" app (public, client id in `server/src/config.ts`; redirect allow-list =
the relay callback + loopback :7790).

**A stable address on your own domain** (optional): create a Cloudflare named tunnel, point its
public hostname at `http://localhost:7790`, put `{"tunnel":{"hostname":"orch.example.com","token":"..."}}`
in `state/remote/config.json` (or `CF_TUNNEL_TOKEN` in the env), and add
`https://orch.example.com/oauth/callback` to the OAuth app's redirect URIs. `ORCH_NO_TUNNEL=1`
serves loopback only; `ORCH_REMOTE_PORT` moves the port.

The Python toolbox stays stdlib-only; `web/` + `server/` are the ONE TypeScript surface, because
the auth stack (jose, hono, cloudflared) is RepoYeti's and lives there.

## The rewrite: one script per functionality (Python, stdlib only)

Decision 2026-08-31: the rewrite happens in Python, as individual scripts - one functionality
per file, so each piece can be smoke-tested and unit-tested alone and changing one thing cannot
break everything. No third-party dependencies anywhere; any Python 3.9+ runs them.

Three tiny shared libraries carry the things that MUST stay identical across scripts (transport,
the gate verdict, the attempt count) - duplicating those per script is how v2's bugs multiplied,
so the split is: judgment shared, actions individual.

| script | kind | what it does |
| --- | --- | --- |
| `hydralib.py` | lib | HTTP to the daemon + chat resolution (ambiguity = typed, deterministic refusal) |
| `gatelib.py` | lib | THE GATE: running / crashed / finished + lanes, ported from v2's chat-gate |
| `ledgerlib.py` | lib | THE ATTEMPT LEDGER: rule 3, the memory of failure v2 lacked (`state/attempts.json`) |
| `clilib.py` | lib | `capture(fn, argv)` - the one way a lane script runs another script's main() as a step (was six identical lines pasted in seven scripts) |
| `archivewatchlib.py` | lib | THE COLLATERAL WATCH: every chat record on the machine, read before a move and after it. A record that went from visible to ARCHIVED without sharing an id with the move is named in the move's report, filed as an incident, and makes the move not-ok. Built 2026-09-17, after a four-chat batch settled every chat it was given while three chats outside it went archived in the same two minutes - one in an account the batch never named - and every rail, exit code and journal read clean |
| `stamplib.py` | lib | the on-disk AUTOMATION STAMP: sessionSettings.ultracode=true + effort=xhigh written into a desktop chat's meta record - the MECHANICAL half of the doctrine (prompt words cannot set harness parameters; owner correction 2026-08-31). Model never touched |
| `census.py` | observe | fleet census, parity port of orchestrate.mjs (same fields, same exit codes) |
| `waiting_scan.py` | observe | waiting-on-a-person over REAL transcript tails - the census's admitted blind spot |
| `gate_chat.py` | observe | gate ONE chat, print verdict + evidence |
| `dossier.py` | observe | everything the daemon knows about one chat |
| `list_instances.py` | observe | every instance with account/usage |
| `attempts.py` | observe | what the breaker is holding back, and why; `--clear` on a person's word |
| `smoke.py` | observe | READ-ONLY smoke against the live daemon - proves the whole observe chain |
| `archive_chat.py` | act | archive/unarchive one chat - gated, breakered, re-checked, verified |
| `migrate_chat.py` | act | land one chat in an instance - verified landing (the source row is re-read after the settle and must be gone), superseded = deterministic stop; `--stop-idle` stops an IDLE engine first through `lib/enginelib` (never a working or stuck one) so the desktop's never-exiting engines cannot pin a chat forever; every verified landing then stamps bypassPermissions via the daemon AND ultracode into the meta record (the automation doctrine, applied mechanically at the one moment it is durable - before first boot; a failed stamp is reported, never hidden). Every move also runs the COLLATERAL WATCH (`archivewatchlib`): exit **2** means the chat landed AND a chat outside the move went archived while it ran - `collateral` names each one and the account to unarchive it from, and the move is reported not-ok rather than clean |
| `automation_chat.py` | act | enforce the automation doctrine on ONE existing chat, or FLEET-WIDE with `--all [--yes]` (enumerates the disk stores, lists every chat missing a stamp; held chats are stamped too - a hold covers a chat's work, not its permission mode): bypassPermissions (daemon primitive) + ultracode (stamplib), both verified on disk, with the honest running-app caveat. Proven live 2026-08-31 - single chat and a 26/26 fleet sweep |
| `compact_chat.py` | act | COMPACT one console/CLI chat's context instead of abandoning it: there is no headless /compact, so it resumes the session with a small --autocompact window + a do-nothing prompt and the engine's own pass fires; verified from the transcript's own usage numbers (before/after + compact marker). Console-only - a desktop chat is refused (resuming it outside its app would fork behind the app's back); full rails (floor, quiet, hold, breaker) |
| `rename_chat.py` | act | rename through the app's own control, driven from `misc/Manage-DesktopChat.ps1` - the ONE actuator since 2026-09-17, shared with the daemon (the second copy that used to live under `scripts/actuator/` had drifted; its InPrimaryPane fix, which stops the open chat's header menu being counted beside its sidebar menu and every open chat reading as ambiguous, is in the one file now) - hold-aware, verified through the dossier |
| `open_instance.py` | act | start an instance (idempotent) |
| `quit_instance.py` | act | stop an instance - refuses while chats have live writers |
| `drill.py` | act | REVERSIBLE live proof of the act chain (archive round-trip, UI rename round-trip) |
| `dashboard.py` + `.html` | observe | the DECISION DASHBOARD in a browser: accounts strip (5-hour + weekly per account, who's next, the balancing plan), the logic tree drawn, the configured rules listed with their LIVE values, and buttons that dry-run the plan for every chat (`python scripts/dashboard.py --open`, read-only by construction - the server has no POST handler) |
| `balance.py` | observe | LOAD BALANCING as a plan, under THE USAGE BANDS (owner, 2026-08-31): keep every account at or under 85% on BOTH windows; 90% is the HARD GATE (evacuation mandatory); under the target, DELIBERATE FILL - accounts with room take migrations and simpler new chats up to a plan-sized ceiling (target minus leeway: Max 20x -2, Max 5x -5, Pro -10) so paid capacity is never wasted. Usage comes only from AgentHydra's own survey |
| `sweep.py` | act (batch) | ONE command executes the whole predetermined mechanical plan within caps (`--all --yes`), through each act script's own rails - and lists the judgment queue it will never touch |
| `audit_archived.py` | observe (+`--restore`) | were recently-archived chats really done? Enumerates the DESKTOP CHAT STORES on disk (not /api/sessions - that surface misses them), gates each archived chat's real tail, and names every one where work remained; `--restore` unarchives them. Born restoring v2's mis-archives, 2026-08-31 |
| `fan_out.py` | act | DISSEMINATE one task list into N visible desktop chats, ONE ACCOUNT EACH, and manage them as a group (owner ask, 2026-09-04: "lint six or seven planes from one chat, orchestrated into other accounts"). Ranks accounts by real room the way balance.py does (open first; unknown is never room), spawns through `spawn_chat.py` one window at a time, refuses a task whose prompt already runs in the fleet while letting one spec share a prompt across its own tasks, reports an unassigned task instead of dropping it, keeps the group in `state/fanouts.json`; `status` = every member's gate verdict + last words, `send` = one follow-up into all of them through the daemon's message route, holds respected. A person's act - no tray icon needed. MCP: `fan_out` / `fan_out_status` / `fan_out_send` |
| `delete_chat.py` | act | DELETE one chat everywhere it exists, with an undo copy (owner rule, 2026-09-04: "all ping requests or account identification requests must be deleted after they are created and not left in the account" - archiving a probe still leaves it in the account). Rails in order: one chat (ambiguity refuses), hold (`--force` is a person's word), live writer (`--stop-idle` stops an IDLE engine through enginelib, never a working or stuck one), the undo copy into `state/trash/<sid>/` FIRST, then the running app's own Delete control (the actuator's `-Action Delete`: row menu Delete + the app's confirm button, both by label), then the meta record in every profile and the transcript; verified through the dossier and the disk, anything left named. `--undo <sid>` restores; `undo.py` knows the kind. `fan_out delete` runs it per member. `--released [--yes]` is THE SWEEP of what the app's own Delete leaves behind: deleting a chat in Claude Desktop removes its record and writes `<sid>.desktop-released.json`, but the TRANSCRIPT stays (12 of them, 8 MB, on the owner's machine 2026-09-04) - listed by default, deleted with `--yes` |
| `chats.py` | observe (+`--move-to`) | every chat grouped by ACCOUNT (email, plan, app open?), filterable by account/instance/title/console-only, and the easy way to move chats between accounts - each move goes through migrate_chat's own rails, capped, plan-first. Reads each child's JSON payload rather than guessing from its exit code, so "already lives there" (a no-op that also exits 0) is never counted as a landing, and the headline counts what LANDED (it used to print the PLANNED count in the past tense, so a fully-refused run announced "3 chat(s) moved" above three refusals). Forwards `--idle-wait`; deliberately has NO `--force`, because that is a person's word for ONE act and would otherwise be spent on every chat a substring selected |
| `migrate_batch.py` | act (batch) | MOVE MANY CHATS IN ONE RUN, the engine behind MCP `move_chats`: migrate_chat's own pipeline inside ONE interpreter and ONE route-lock acquisition, BY PHASE (move all, settle all, stamp all), so the fleet/session/usage reads and the 8s bypass watch are paid once for the batch instead of once per chat. Since 2026-09-13 each post-landing phase runs bounded on a worker thread (`_run_bounded`) and a phase over budget is ABANDONED with the timeout NAMED on every chat left without a verdict, rather than the whole call dying with no report. ⛔ ARCHIVED CHATS: `--archived` alone is REFUSED. It needs `--archived-count N` MATCHING the archived chats the batch actually holds, and they must be the WHOLE batch, never mixed with unarchived ones - a boolean an agent set for itself is how 22 archived chats were queued behind the 3 a human asked for (2026-09-13). `migrate_chat.py` remains the way to move ONE named archived chat |
| `migrate_reconcile.py` | observe (+`--finish`/`--reverse`) | WHICH MOVES STOPPED HALF-WAY? A move is four acts (import, verify, settle the source, stamp the mode) and only the first pair was ever written down, so the 25-chat batch killed on 2026-09-13 left 14 chats imported onto the target and STILL unarchived on the source - duplicates, not moves, with nothing on the machine saying which. Every migrate mutation now carries a PHASE (`mutationlib.advance_phase`), and this re-checks each unfinished row against the chat's CURRENT state: `unsettled` (the half-move), `not-landed` (the ledger and the machine disagree - the loudest row), `settled` (advances the journal so it is never re-read), `gone`, `unknown` (a failed read, counted WITH the unsettled ones). `--finish` re-drives migrate_chat's own `phase_settle`/`phase_stamp`; `--reverse` hands the row to `undo.py`. It owns no actuator of its own |
| `deliverylib.py` + `stage_reply.py` + `courier.py` | lib + act | THE COURIER, the last manual lane: an AI stages a decided reply (`stage_reply.py`), the courier types it into the chat through the app's own composer and proves the chat MOVED afterwards. Rails in order: held? breaker? resolves to one? never mid-turn? verify-snippet proves the right chat? then send, then confirm. Also `sweep.py --deliver` |
| `schedule_jobs.py` | act (machine config) | run the recurring jobs on a timer via WINDOWS TASK SCHEDULER, registered from this repo, ALL EVERY 5 MINUTES (owner order) and windowless (VBS shim + pythonw): dashboard keepalive (starts it only if the port is dead), reconcile (observe only), to-do sweep (`odin discover` + `odin loki --file --apply`). Every tick logs to `state/logs/<job>.log` (rotated ~2MB). Dry-run by default; `--status` / `--pause` / `--resume` / `--remove` to inspect, silence or undo. **AgentHydra's own queue cannot host these** - headless runs are hard-refused (`headlessRunsAllowed()` returns literal false; owner law, "there is no setting for this"), and that queue launches chats, not scripts |
| `holdlib.py` + `hold_chat.py` | lib + act | PER-CHAT AUTOMATION OPT-OUT: "leave this one to me". Demands a reason, outranks every gate verdict and the breaker, keeps the chat visible (held, not hidden), never blocks a deed a person asks for directly (`--force`). The safety valve the postmortems argue for - in place BEFORE anything runs unattended |
| `reconcile.py` | observe (+`--retry`) | did every past archive attempt actually SETTLE? Re-reads each recorded attempt: landed (clears the ledger), REVERTED (the running app re-saved the flag away - a real silent failure), unconfirmed-on-screen, or gone; `--retry` settles the open ones through the app's OWN control (the owner never restarts the apps, so nothing here waits for one). Closes rule 4's other half: the write was honest, but nothing ever went back to check |
| `overlord.py` | act (watchdog) | THE MECHANICAL RE-ARM (owner, 2026-09-01: a chat that armed nothing sat dead 48 minutes): every 5 minutes, if the standing /orchestrate chat (titled 'Orchestrate', `--claim <chat>`, or born from its own MANAGER_PROMPT - the app titles a reborn one itself; THERE IS ONE, a second is never spawned while any exists, and spares are named every tick, protected from every other lane and never woken) has been quiet >=5 min while work waits (staged deliveries, lanes, judgment questions, or LONG-RUNNERS - turns in flight past 30 min, surfaced in the wake-up for review), wake it through the engine and CONFIRM a fresh process hosts it. Holds and the breaker still gate it; the 18-cap deliberately does not (a system at cap with a dead manager stays dead). THE QUOTA HANDOFF: before a wake, an overlord sitting on an over-target account is relocated to the open account with the most fill-room (daemon-atomic migrate) and woken there - an honest self-halt at 85% is the AI's whole job, immortality is the machine's. Proven live: a 59m-dead chat woken and confirmed, twice, across two accounts |
| `tray.ps1` | human switch | THE STATUS-BAR ICON (owner ask, 2026-08-31): green dot = the eyes are firing, gray = paused, and it comes up PAUSED. Right-click: open the local dashboard, open/copy the REMOTE address, remote access on/off, restart remote access, what is running now, pause/resume the eyes, STOP EVERYTHING NOW, open the logs, stop the dashboard server, exit. **Exit is not just "close the icon"**: it removes the heartbeat, disables every gated lane, and closes remote access. `powershell -File scripts\tray.ps1 -InstallShortcut` puts "Orchestrator" on the Desktop (`-Startup` too, `-SelfTest` proves the wiring without arming anything) |
| `name_chats.py` + `actuator/rename_first.ps1` | act | THE NAMING PASS: fresh imports land nameless and render generic; this names them LIVE (no restart) via the probe technique - rename one indistinguishable row to a unique probe name, learn which chat took it from the app's own re-save, then set its real title through the daemon. Runs automatically after every `sweep.py --land-console`; chats with no known real name are quarantined for an AI to name, never guessed |

Testing is three tiers - unit (stub daemon, every script covered), smoke (read-only against
the live daemon), drill (reversible live acts). Configured archive/source cleanup uses the
native main-process connection; remaining desktop operations use guarded UI-Automation.
**`orchestrator/scripts/TESTING.md`** distinguishes the native inspector from the older renderer
CDP experiments and explains why a disk flag is not proof of an in-app result.

Every act script enforces the six rules below mechanically: gate first, count the attempt,
re-check the dossier immediately before the POST, verify after, and say what changed. Archiving
under a RUNNING app must verify native state or the guarded legacy result. A disk-only outcome
exits 7 ("flag written, NOT claiming success") because the app holds its chat list in memory
and can re-save the flag away. A verified native result needs no UI retry or disk polling.

```sh
python scripts/smoke.py       # read-only, safe any time: proves the observe chain end to end
python -m unittest discover -s scripts/tests    # the unit suite (stub daemon, no fleet needed)
#   ^ THE runner, here and in CI: stdlib unittest, no third-party test dependency, on purpose. A
#     pytest-style module (bare test_ functions, pytest fixtures) is imported by it and then runs
#     NOTHING - a green import of zero cases. tests/test_collection_guard.py fails the suite on
#     any committed test module that yields no unittest cases, and names it; write TestCase classes.
python scripts/census.py      # what the fleet looks like right now
python scripts/waiting_scan.py  # who is waiting on a person, over full transcript tails
```

First live run of `waiting_scan.py` (2026-08-31): the preview census reported 0 waiting chats,
the full-tail scan found 15 - the exact truncated-preview hole orchestrate.mjs documents.

`orchestrate.mjs` stays until the Python census has run in anger for a while; it is superseded
by `orchestrator/scripts/census.py` and adds nothing the port lacks.

### How this is meant to be run (the operating model, owner-set 2026-08-31)

The orchestrator drives; the AI is consulted like a subroutine. Scheduled jobs run the
mechanical lanes on their own. When judgment items exist, the orchestrator EMITS the
questions - `python orch.py interview --ask` prints one self-contained block per waiting
chat (its own last words + the exact answer format) - and an AI answers with a small JSON of
decisions, no fleet context needed. `interview.py --apply answers.json` then executes every
decision through the rails: replies are staged for the courier, holds are placed, archives
run with the person-level word the gate wanted. The AI never starts bespoke-coding
functionality that exists, never gets a don't-list, and never needs more context than the
question itself.

**Ask_user cards: a chat asks the human a typed question instead of prose.** A supervised
chat that needs a person decides something can END its turn with one fenced block whose info
string is `ask_user` and whose body is JSON: 1 to 3 questions, each with an `id`, `question`
text (at most 300 characters), 2 to 3 `options` (`label` at most 80 characters, optional
`description` at most 240) and `allow_other` (free text allowed; default false):

````
```ask_user
{"questions": [{"id": "db", "question": "Which store should the cache use?",
  "options": [{"label": "SQLite", "description": "one file, already a dependency"},
              {"label": "JSON file", "description": "simplest, no locking"}],
  "allow_other": true}]}
```
````

`interview.py --ask` hands the card out parsed (`ask` on the question, printed as numbered
options) and the answer is `{"sessionId": ..., "decision": "answer", "askKey": "<ask.key>",
"choices": {"db": 1}}`: an option number, an option label, or `{"other": "text"}`. The card is
re-read from the chat at apply time (an answer for an older card is refused as stale), the
reply is composed as one readable line per question plus an `ask_user_answer` JSON block the
chat can read without parsing prose, and it is staged for the courier like any reply. A card
is answered ONCE: `state/asks_answered.json` records it, and a second answer is refused as
already answered. A card that breaks the limits is shown as MALFORMED with the reason, never
trimmed to fit (`scripts/lib/asklib.py`).

### Touching the app: the route hierarchy (owner rule: no clicking around the screen)

1. **⛔ There is NO native delivery route** (corrected 2026-09-01, the hard way): the
   daemon's /migrate delivers no prompt - its own comment says so, and treating it as
   delivery KILLED and reimported every target chat dormant (message lost, zombie twin,
   "Claude has crashed"). `/migrate` is for MIGRATIONS only.
2. **The COMPOSER actuator is the one delivery channel** (accessibility-API control
   invocation: no cursor, no coordinates, no focus steal; the verify snippet proves the
   right chat before a character is typed). The composer send also BOOTS a dormant or
   crashed chat and runs the turn - delivery IS the revive. It reaches RENDERED rows only;
   a virtualized/collapsed row refuses honestly, and the cure is a real migration to an
   open instance (fresh imports render at the top of the sidebar).
3. **Native control first for archive and migration-source cleanup.** The production
   scripts call `/api/sessions/:id/native-archive`; the ordinary `desktop-archive` route
   also tries native first. `native-only` never falls back. An unknown/refused mutation is
   terminal in every mode. Rename/naming and other unconverted steps retain the existing
   accessibility actuator; do not substitute a POC import/settings call for general migration.
4. **No coordinate clicks or focus-dependent hotkeys.** Earlier stock renderer-CDP startup
   experiments failed; that is separate from the now-tested managed main-process inspector.
   Enable automatic startup centrally and use AgentHydra Open, not Developer-menu clicks.

**Do not restart active apps to enable native control** (owner standing order). Configure a
closed profile and use its next authorized AgentHydra Open. Saving configuration is not a
launch. An already-running stock process is not retroactively given an inspector by saving;
`native-only` reports an unavailable connection instead of silently using disk/UI fallback.

### The division of labor (owner directive, 2026-08-31)

**Code decides state and executes batches; the AI keeps only judgment.** The gate computes every
chat's state deterministically; `sweep.py` then executes the mechanical lanes (archive
candidates, balancing moves, console landings) in ONE deliberate invocation with flags and caps -
an AI calls it and waits, instead of driving each act by hand. What stays the AI's: the judgment
queue (chats waiting on a person, idle live chats) - those need someone to read the evidence and
write an answer, and the sweep never touches them. Usage numbers are always obtained THROUGH
AGENTHYDRA (`/api/usage/survey`) - never scraped, never re-derived, and never read off fleet
rows (which carry no usage at all). That survey measured ~80 s on the real fleet and every
planning lane paid it separately every 5 minutes, so `hydralib.usage_survey` shares one copy
across processes for 4 minutes (`state/usage-survey.json`, labeled `cachedAgeSecs`; pass
`max_age_secs=0` for a fresh read).

### Residence (owner directive, standing; tightened 2026-08-31)

A chat with a desktop home stays in the desktop - nothing here ever moves a chat out of it
(import-desktop, the only mover, lands INTO desktop instances only). Console-only chats are a
MANDATE, not a suggestion: every one gets landed in a desktop instance (`sweep.py
--land-console`), then dispositioned there - archived if done, noted for resume if crashed,
answered if waiting. The one structural exception: opencode sessions cannot land in the Claude
desktop app and are named as such. Handoffs use OPEN accounts with headroom first; a closed
account is the last resort and is explicitly marked as needing to be opened. Pressure on a
CLOSED account is the orchestrator's own do-not-open note, never something to surface to the
owner.

### Not this program's job

**Repo-level questions belong to Odin**, in its own clone: which codebases exist (`odin
discover`), what state each is in (`odin scan`), and the cross-repo to-do lists (`odin loki
--file`, which writes one markdown to-do per open finding into each codebase's `docs/todo/`
and never re-files one whose file has been deleted - a deleted to-do reads as done). The
orchestrator decides what happens to CHATS; Odin decides what happens to REPOS. Neither
duplicates the other.

### The CLI contract (owner rule: every script takes arguments)

Every runnable script answers `--help` / `-h` with its own docstring and exit 0, offline -
no daemon, no state, no fleet. Every one documents a `Usage:` line and its `Exit:` codes, and
takes `--json` where it returns data. `test_cli_contract.py` enforces all of that across the
whole folder, so a new script cannot ship undocumented or unrunnable from a terminal (or as
an MCP tool backend).

**Still to migrate** (the v2 reference under `src/` is the map): collisions (live chats
sharing a worktree), zombie-rows, name-untitled. Each becomes its own script behind the same
shared libraries.

`src/` does **not run as-is**: it was written as modules inside AgentHydra's server and still
imports things like `./db`, `./live-registry` and `./session-launch` that live over there now. That
is deliberate - it is reference material for the rewrite, at the exact state it was cut.

## What AgentHydra still gives you

The daemon on `http://127.0.0.1:7787` keeps every primitive; only the judgment left. The ones this
program needs:

| endpoint | what it gives |
| --- | --- |
| `GET /api/health` | is the daemon up |
| `GET /api/fleet` | instances, per-account usage, git hygiene |
| `GET /api/sessions` | every chat, with `archived`, `instance`, `last_activity_at` |
| `GET /api/chats/dossier?q=` | one chat: its instance, archive flag, lineage, live process |
| `POST /api/sessions/:id/desktop-archive` | archive / unarchive a chat; archive prefers configured native state before any disk/UI path. Pass `instance_ref: desktop:<full profile path>` and inspect `verified`, `route` and `stillOnScreen` |
| `POST /api/sessions/:id/native-archive` | exact-profile native archive attempt, used by archive and migration-source cleanup; no UI act is dispatched by this endpoint |
| `GET /api/claude-native/settings`, `PUT /api/claude-native/settings` | per-profile port, routing mode and `launchDebugger`; automatic startup applies on the next AgentHydra Open |
| `POST /api/chats/:id/rename` | rename through the running app's own control |
| `POST /api/sessions/:id/import-desktop` | land a chat in an instance |
| `POST /api/sessions/:id/message` | deliver text into a chat: the daemon picks the channel, preferring the native peer pipe and using the composer only for a dormant chat. This is `courier.py`'s PRIMARY route; a 404 from an older daemon is what drops it back to driving the actuator itself |
| `POST /api/instances/:dir/{open,quit}` | start or stop an instance; URL-encode the full profile path. Open honors its automatic-debugger setting |

The legacy archive fallback, rename and message routes use PowerShell helpers under `misc\`;
verified native archive skips those helpers entirely. A compiled build embeds
`Deliver-DesktopChat.ps1` and `Manage-DesktopChat.ps1` (`RUNTIME_MISC_FILES` in
`server/src/misc-assets.ts`) and writes them out of the binary; before 2026-09-13 both were
located by hopping `..` off `import.meta.dir`, which inside a compiled exe points at the virtual
embedded root, so all three routes were silently dead there and rename still answered `ok: true`.

Everything else - gating, deciding, delivering, holding, the ledger - is gone from there and is
this program's to rebuild.

## Run it

```sh
python scripts/census.py       # census: what the fleet looks like right now (--json for JSON)
python scripts/waiting_scan.py # the real waiting-on-a-person answer, over full transcript tails
```

The acting half now exists as individual scripts (`archive_chat.py`, `migrate_chat.py`, ...) -
each one act, fully rail-guarded, run deliberately by a person or an agent. **The sweep loop now
exists**: `sweep.py --all --yes`, which `python orch.py loop --live` is identical to, executes the
whole mechanical plan across the fleet within its caps and through each act script's own rails,
and `schedule_jobs.py` runs it on a timer. What has NOT changed is the reason this paragraph used
to say there was none: nothing acts unattended without the tray icon up, every act keeps its own
refusals, and the loop is dry by default. Shipping a half-built unattended actuator is how the
last two versions went wrong; the rails are the answer to that, not the absence of a loop.
