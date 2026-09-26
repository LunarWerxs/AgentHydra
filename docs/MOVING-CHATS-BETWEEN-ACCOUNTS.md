# Moving chats between accounts

Claude Desktop archive and migration-source cleanup now prefer the production native
connection. Enable **Settings → General → Claude native control → Start debugger automatically**
per profile, then use AgentHydra **Open** when that closed account is needed. The debugger starts
on that launch without menus; saving settings does not restart an active desktop. New profiles
need their own setting. See the [native-control operating guide](CLAUDE-DESKTOP-NATIVE-CONTROL.md)
for the equivalent API and exact-profile result checks. General destination import/settings,
unarchive and new/start/stop/resume are still partly legacy/guarded; use the production move
tools below instead of the restricted POC runner or a hand-built UI sequence.

## The fast path: one call

**Use the MCP tool `move_chat`. Do not recon first.** (Owner, 2026-09-04: "slower than I wanted
... I use this function frequently." The move itself had taken ~70 s; the twelve round trips
around it - find which instance "Martin" is, list its chats to find the spelling, load tool
schemas, read `--help`, check quota, run, verify - took minutes.)

```
move_chat { chat: "arkitecht cleanup", from: "Martin" }            # to "here" (this account)
move_chat { chat: "arkitecht cleanup", from: "Martin", to: "best" } # to the emptiest account
move_chat { chat: "...", to: 36, dry_run: true }                    # plan only, moves nothing
```

- `chat` is a title fragment, matched **fuzzily** (case, punctuation, a misspelling: `arkitecht
  cleanup` finds `Arkitekt cleanup`), or a session id. Two different chats that both fit are a
  refusal that names both - never a coin flip.
- `from` is the account it lives on - instance number, name, label or email; a first name
  (`Artem`) or a profile folder label (`temp2`) works when it names exactly one account. It scopes the search
  (a title two accounts share is not ambiguous) and a typo can never select a chat on an account
  you did not name. If only an archived twin is on that account, the tool says where the live copy
  is instead of moving it.
- `to` defaults to `"here"` (the instance the calling process runs as, resolved like `whoami` and
  refused unless that identity is exact - a wrong guess bills the wrong account). `"best"` ranks
  the running desktop instances by real headroom (tier × remaining weekly %, from the usage
  survey; never the source, never a walled 5-hour window). Or a number/name/label/email.
- It is `orchestrator_run migrate_chat ... --stop-idle --now --idle-wait 330` underneath, so every
  rail is intact: a hold (`force` is a PERSON's word - pass it only when the human asked), the
  breaker, the live-writer refusal, the verified landing, the source row settled.
- **`--now` is what makes it fast.** The standing 300 s quiet window existed to tell "waiting" from
  "background work" by time alone. `enginelib.background_work` reads the work itself: every
  background job the CLI reported launching (`Command running in background with ID: …`,
  `moved to the background (ID: …)`, `Workflow launched in background. Task ID: …`) against every
  `<task-notification>` that reported one back, ignoring jobs of a previous engine (a resume kills
  them). No job outstanding + a finished turn = idle after 15 s. An outstanding job keeps the
  300 s window even for a person; a working or stuck engine refuses as before.
- **Bypass is verified, not hoped.** After the landing stamps `bypassPermissions` + ultracode, the
  landed record is watched for 8 s through the app's boot re-save; any flip is re-stamped and
  `permissionMode` in the result is what the disk said *last*.

Read `report`; `landed` is the verdict, `timings` says where the seconds went.

### Draining a whole account: move, terminate, resume - one call

```
move_chats { from: "Carlos", all_unarchived: true,
             terminate_live: true,
             resume: "MIGRATION NOTICE: you were moved to a fresh account because the old one
                      was out of quota. Your engine was stopped mid-work, so re-run anything
                      still in flight. Re-read your last message and carry on." }
```

⛔ **"Drain this account" means its UNARCHIVED chats, and nothing else** (owner directive,
2026-09-05, restated angrily on 2026-09-13). An account's archive is usually the overwhelming
majority of what it holds: in the incident that produced this paragraph, 25 chats were 3
unarchived and 22 archived, and an agent that set the old `archived: true` flag for itself
queued all 25. `all_unarchived: true` is the right call here and never needs anything else.

To move archived chats you must have been ASKED for them, and then you pass `archived_count: N`,
the number of archived chats in the batch. The engine refuses the whole batch if that number does
not match what it actually holds, or if archived and unarchived chats are mixed in one call,
because mixing is exactly how 22 rode in behind 3. The old `archived: true` boolean was REMOVED
on 2026-09-13 rather than deprecated: a boolean cannot tell a human's instruction from an
agent's own initiative, and a caller passing it now fails the schema loudly instead of quietly
sweeping an archive.

**A drain of any size answers immediately, not at the end.** Since 2026-09-13 `move_chats`
auto-detaches whenever its own declared length exceeds 120s, which a one-chat batch already does
(its floor is 180s), so the call returns an `operationId` and the per-chat report is read with
`orchestrator_operation {id}`. Before that, a long batch could die on a bare transport timeout
and return nothing at all about work it had in fact done. If a batch is stuck or was launched
with the wrong scope, `orchestrator_cancel {id}` stops it and frees the route lock; that is not
an undo, so read the fleet afterwards to see what had already landed - and since 2026-09-14,
`python migrate_reconcile.py` is how you see it, because a killed batch leaves half-moves that no
fleet read names (below).

**"Kill it and move it" is now one call, and a refused call keeps its resume** (2026-09-14). A
patient move sitting out its `wait_secs` used to refuse the SAME move with `terminate_live` as
`409 busy` - the route is keyed by script name - and the only way through was `taskkill` by hand.
Now a call carrying `terminate_live` PREEMPTS a run whose chats it covers: the holder is
cancelled, and this call does that work itself. A holder naming chats the new call does not is
still refused (cancelling it abandons those chats, which is a person's decision), and that
refusal now STAGES the call's `resume` text against each named chat instead of losing it with the
call - deduped, so re-firing cannot leave two wakes. Read `resumeStaged` in the answer.

What it replaced (2026-09-06, Carlos at 95% of its window and Martin at 88% of its week,
seven chats to Eduardo): ~25 round trips and most of an hour. The four moves were fine; the
rest was learning that a landed chat sits DORMANT until someone types into it, finding the
`stage_reply` -> `courier` path, staging six prompts through a shell loop, parsing delivery
ids out of JSON, six courier runs because `--only` took one id (two of them refused for the
tray icon and the fair share first), then reading two working chats' pids out of a dry run,
`taskkill` by hand, and moving again.

- **`resume`** is phase four of the batch. Every landed chat gets the text staged as a reply
  (stage_reply's own evidence rule, so the courier can still prove it is typing into the right
  chat) and delivered through the courier's **named** path - a person's delivery, so no tray
  icon and no fair-share cap (owner: "the fair share rule is just when you're auto managing;
  I'm manually managing, it does not apply"). A chat whose engine booted on landing and is
  mid-turn keeps its reply staged; its result carries `resume.retry`, the exact command. Read
  each result's `resume` - a landed chat with `resume.delivered: false` is moved but has not
  been told to carry on.
  - ⛔ **LANDING IS ACTIVITY, so the resume gates each chat with the `--now` window, not the
    standing 180s** (2026-09-14). The import stamps `lastActivityAt` with the landing time, so
    under the standing quiet window every chat couriered within 180s of landing read as
    `running`: the delivery went `peer_only`, the peer channel dead-lettered on a chat that was
    not taking turns, and the row was deferred as "mid-turn". Draining #63 to #13 that morning,
    four of five resumes went that way, the one couriered 194s after landing was delivered, and
    the operation sat nine minutes before it had to be cancelled. Phase four now uses
    `migrate_chat.quiet_window`'s fast window when the transcript was scanned and no background
    job is outstanding, and the standing window otherwise (including when the scan cannot be
    read). Only the WAIT is shortened - the tail must still show a finished turn, so a chat that
    really is working after it lands is still left alone.
  - ⛔ **AND THE BOOT ITSELF USED TO LOOK LIKE A TURN.** `claude://resume` appends a user-role
    record when it boots the landed chat, so the gate's "has the turn ended" tests all failed on
    THAT record rather than on the turn - the state stuck at `running, not idle` for as long as
    the landed engine lived, and wakes were refused hours after landing (so this was never only a
    timing window). The gate now sees past trailing records the app marks `isMeta` (a boot hook,
    an injected cross-session message, the local-command caveat); an ordinary user record still
    ends a transcript mid-turn. Separately, the courier now consults the daemon's own
    `limit_stop.pending`: a chat parked at a usage wall cannot be writing, so it is never treated
    as mid-turn - which is exactly the population a drain moves.
  - ⛔ **THE BOOT'S OWN ANSWER LOOKED LIKE A TURN TOO** (2026-09-25). The landed engine answers
    the boot's meta "Continue from where you left off." with a SYNTHETIC "No response requested.",
    which the gate filed as an api error, and the app can then file the old engine's
    stopped-task notification under that same prompt. Either one as the tail read as a turn in
    flight, the peer channel does not wake an idle desktop chat, and the composer was forbidden:
    a chat moved #14 -> #15 sat idle 12 minutes until a person typed into it. The gate now reads
    both as a finished turn; a tool result still reads as in flight. If a landed chat's
    `resume.delivered` is false and its engine shows no CPU, `gate_chat <session id>` says why.
  - Re-firing a batch whose resumes are still staged **re-uses those rows** rather than staging a
    second copy of the same words (2026-09-14: a cancelled batch left two rows each for two
    chats). A staged reply with DIFFERENT text - a person's - is never folded into the resume.
  - A delivery that was ATTEMPTED and FAILED is **retried once automatically** (2026-09-12).
    The retry RE-STAGES first, and that is the whole point: a failed row is no longer
    `staged`, so the retry a person reaches for - `courier --yes --only <id>` - answers
    "nothing staged - the courier has nothing to deliver" and READS AS SUCCESS while doing
    nothing. A row the courier SKIPPED is left alone: a mid-turn chat and a tripped breaker
    are deliberate deferrals, and hammering them is the cycle the breaker exists to end.
  - ⛔ **A COMPILED BUILD COULD NOT DELIVER AT ALL until 2026-09-12**, so `resume` silently
    did nothing on one: the single-file exe embedded the web assets and the tray but not
    `misc\Deliver-DesktopChat.ps1`, and the daemon answered `delivery actuator missing at
    <dist>\misc\...` by BOTH routes (the composer route IS that script, and the peer route
    is refused by the same endpoint first). The build now embeds it or fails. If you meet
    that error, the daemon predates the fix - see `server/src/misc-assets.ts`.
- **A source account at 98% or more is killed without asking** (owner's standing order,
  2026-09-20). When either the 5-hour or the weekly bucket of the chat's source account reads
  98%+, `move_chats` treats `terminate_live` as already given for it; the result's
  `terminated.standingOrder` names the reading. An unreadable usage row never triggers it.
- **A `sourceRow: "flagged"` result is not finished.** The source app's own control was
  unreachable, so only a disk flag was written, and a running app keeps showing the chat. The
  batch report now leads with `NOT FINISHED ON THE OLD ACCOUNT` and lists them in
  `sourceStillShown`; archive them natively once that profile runs with native control.
- **`terminate_live`** is a person's word to KILL the engine of a chat refused for being alive
  (working, or quiet but inside its window) and move it anyway. It is for the account that
  will hit its wall before the turn ends - the turn dies there regardless, holding everything
  it had not saved. The transcript survives; a tool result still in flight does not, so say so
  in `resume`. `force` never implies it: `force` overrides a hold, nothing more. A hold or the
  breaker is never killed through.
- **A detached batch's report does not survive a daemon RESTART** (2026-09-12). Operation
  records live in the daemon process that ran them, while the batch's child process outlives
  a restart and finishes its work orphaned - so the chats move and the report vanishes. A
  poll now answers `reason: 'daemon-restarted'` and names when the daemon started. ⛔ On that
  answer do NOT re-fire the move: read the toolbox's ledger and check `list_chats` for what
  actually landed.
- **Check the account first with `list_chats`**, not `list_sessions` (which missed one of
  Martin's four chats behind its 7-day default) and not a dry-run move. If `list_chats` answers
  with an HTML-instead-of-JSON error, the running daemon is older than the tool: rebuild and
  restart it. Since 2026-09-14 `--all-unarchived` reads that SAME endpoint: the two used to
  disagree, and the one that said "0 unarchived" on an account holding three is the reading that
  silently does nothing. `/api/sessions` resolves a chat to ONE owning account, so a half-moved
  chat - which is on two at once - was invisible to the account it was still sitting on.
- **A KILLED BATCH LEAVES HALF-MOVES, and `python migrate_reconcile.py` is what finds them.**
  Killing the 25-chat batch of 2026-09-13 left 14 chats imported onto the target and still
  unarchived on the source; the fleet read taken straight after showed all 25 on the source, so
  the run read as "nothing landed" and the truth surfaced twenty minutes later by eye. Every
  migrate now journals its phase, and the reconciler re-checks each unfinished one against the
  chat's current state: `unsettled` is that duplicate, `not-landed` means the ledger and the
  machine disagree. `--finish <id>` completes it through the mover's own phases, `--reverse <id>`
  undoes it. Run it after any cancel.
- By hand, the same thing is `courier --yes --only <id> --only <id>` for the replies (several
  ids, one run, no icon needed) and `migrate_batch ... --terminate-live --resume "..."`.

## Moving a CODEX chat: a different mechanism, and not an MCP tool

`move_chat` and `move_chats` are CLAUDE. A Codex chat cannot move that way, and the reason is not
an omission: a Codex thread belongs to the home it was written in, and Codex has no verb that
re-homes one. AgentHydra does it by copy, verify, then archive, driven from the Codex instances
table in the web UI over two routes:

```
GET  /api/codex-instances/:id/move-chats?targetId=<destination>   # plan only, moves nothing
POST /api/codex-instances/:id/move-chat                           # one reviewed chat
```

The plan lists every active chat in the source home with its title, its folder and the account
identity at both ends. The move then copies the rollout under a fresh id, imports it into the
destination, confirms it really landed, and only then archives the source.

**There is deliberately no `move_codex_chat` MCP tool.** The plan exists to be READ by a person
first, and the destructive half only accepts a chat that came back from a plan, carrying its
`updatedAt` and both account ids, so a stale or unreviewed request is refused rather than guessed
at.

### What it refuses, and what an interruption leaves behind

Every refusal happens at planning time, before anything connects:

- an unfinished CLI turn, even with the desktop stopped;
- an unknown process state, or a login that changed under the plan;
- a destination that is the same home as the source;
- a transcript that is archived, edited since the plan, or outside the home;
- a corrupt move history, which prevents any copy rather than being quietly repaired.

The ORDER of the remaining steps is chosen so an interruption is readable rather than lossy:

- a failed import keeps the copy on disk and never archives the source;
- a failed archive retries the SAVED copy instead of copying again, so a repeat cannot create a
  duplicate;
- an edit during the import keeps both chats and refuses the stale retry;
- failed destination verification preserves the original untouched.

The worst case is two readable chats. It is never zero.

### The copy keeps its DISPLAYED history, which is not the same as keeping its messages

`copyCodexTranscript` rewrites the identity in `session_meta` and in every `thread_id`, and carries
paginated ordinals and `item-completed` events across untouched. Downgrading `history_mode` would
be simpler and is wrong: Codex silently drops the displayed items while the model messages sit
intact on disk, so the moved chat opens LOOKING empty and reads as a failed move.

## Reviving a chat Claude Code deleted (`migrate_chat.py --revive`)

Claude Code deletes a transcript once it is older than `cleanupPeriodDays` (30 days by default),
and `claude --resume <id>` then fails. If any copy survives (delete_chat's undo copy, the old
account's projects folder of a moved chat, a file you saved), write it back under the same id:

```sh
python orchestrator/scripts/migrate_chat.py --revive <session id> --dry-run   # the plan
python orchestrator/scripts/migrate_chat.py --revive <session id> [--source FILE.jsonl]
```

It does not copy the file verbatim, because a verbatim copy is what fails on the next turn:

- thinking blocks are dropped: they are signed, a replayed signature that no longer verifies is
  rejected, and nothing can re-sign one;
- every `tool_use` must have its `tool_result` later in the chain, or it is dropped (an unanswered
  call is a 400 on the next request), and a result whose call was dropped goes with it;
- only the active branch since the last compaction is kept, relinked into one chain, and only user
  and assistant turns (summaries, snapshots and progress records are the CLI's own bookkeeping).

An existing transcript is rewritten only with `--force`, which keeps the original beside it as
`.pre-revive-<time>`, and never while it was written in the last 300 seconds. The revive makes no
daemon call and touches no app; land the revived chat in a desktop account with the usual move.

---

Everything below was learned the hard way on 2026-08-28, moving 13 chats off an account
whose org had disabled Claude Code. Each section is a trap that produced a wrong result which
*looked* correct at the time. Read this before moving any chat between instances or accounts
by hand - the fast path above already handles every one of them.

## The account IS the folder. Re-logging an instance orphans its chats.

Claude Desktop stores per-chat metadata at:

```
<user-data-dir>/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
```

That path is the account. Sign the same instance into a different account and the app reads a
*different* folder, so every chat filed under the previous account becomes invisible - still on
disk, still perfectly intact, simply not where the signed-in account looks.

AgentHydra scans **every** folder under an instance, so its dashboard keeps showing those chats,
correctly attributed to the instance, while the app itself shows an empty sidebar. That divergence
is not a bug in either one; it is the two of them answering different questions.

**So a "move to account X" is only finished when the metadata files sit under X's
`<accountUuid>/<orgUuid>` folder.** `POST /api/sessions/:id/migrate` files them under whichever
account was signed in *at the time*; if the instance is re-logged afterwards, they are orphaned
again and must be re-filed. Resolve the target's uuids from
`GET /api/instances/:dir/account` (`accountUuid`, `orgUuid`) rather than guessing.

> **Two of these are now fixed in the app** (see the sections for details): the session map prefers
> a live entry over a stale archived one, and an untitled import is stamped `bypassPermissions` like
> any other. The rest are properties of Claude Desktop's own store that AgentHydra can describe but
> not change, so they remain things a caller has to handle.

## migrate archives the source pointer, it does not remove it

After a migrate the chat has a metadata file in **both** profiles: fresh in the target, and in the
source archived (by its own app when it runs, by the flag when it is closed). The one exception is
a running source whose native archive refused or could not confirm: that record is deliberately
left unarchived, so the store agrees with the screen, and the profile is named in
`sourceStillShown` (see "The web UI's move settles its source the same way" below). Keeping both
records is deliberate - nothing is destroyed - but it has a consequence nobody expects.

AgentHydra's session -> instance map is keyed by transcript id and keeps **one** entry per
transcript, so with copies in two profiles it reports whichever it read last. In practice that was
the stale archived one, which made the dashboard claim a chat was archived on the OLD account while
the live copy sat in the new one. Sessions vanished from `archived=hide` listings entirely.

**Fixed:** `setPreferred` in `instance-sessions.ts` now resolves that collision deterministically -
a live entry beats an archived one, and otherwise the more recently written file wins - and the
migrate route invalidates the 15-second metadata cache so the next read sees the move rather than
the state before it. Pruning duplicates is still tidier, but the dashboard no longer lies while
they exist.

## A move proves it archived nothing else (`collateral`)

Measured 2026-09-16, operation `98008cf6`: a four-chat `move_chats` batch landed and settled every
chat it was given, and in the same two minutes **three chats that were not in it went archived** -
one of them in an account the batch never named. Every rail on the move verifies the row it
INTENDED, so the per-chat results, the exit code and the chat journal all read clean, and the owner
found out by noticing chats missing from his sidebar.

The writer could not be identified from the logs (the daemon's archive paths do not log, the
actuator's menu search is already scoped to the target app's own process, the doctrine lane stamped
two other chats that minute, and the cross-account archive fell inside the batch's IMPORT phase,
not its settle). So the move proves it instead of assuming it:

- Every chat record on the machine is read **before** the first chat moves and **after** the last
  phase (`orchestrator/scripts/lib/archivewatchlib.py`).
- A record that went from visible to archived **without sharing an id with the move** is
  COLLATERAL. Archiving the move's own source rows and its twins in other profiles is the move
  doing its job and is never counted.
- It is named at the top of the report with the account it is in, filed as an incident, put on the
  payload as `collateral`, and the move is **not ok**: `migrate_chat` exits **2** (landed, not
  clean) and `move_chat` / `move_chats` stop answering `ok: true`.

**If you see it:** unarchive each named chat from its own account's app (Archived view ->
Unarchive). A disk write is undone by a running app, which is why the report points at the app.
The move's own chats are unaffected and must not be re-moved.

The wording is "archived **while it ran**", never "archived **by** it" - the watch detects the
outcome whatever caused it, including another lane or another agent acting in the same minutes.

## A session with no Desktop entry can never be archived

`archiveDesktopChat` finds nothing to flag and returns `no-desktop-chat-found` (HTTP 404). These are
plain CLI transcripts, or chats whose entry was never written. They are not in any sidebar, but they
show as **live forever** in AgentHydra's session list, and every archive sweep silently skips them.

That is what "why are there dozens of ancient chats" turns out to be. On this fleet it was 359
sessions, some three weeks old, surviving every sweep because the sweep could only ever touch the
232 that had entries.

**To retire one, write the missing metadata file with `isArchived: true`.** Same shape the app
writes; the transcript is untouched; deleting the file undoes it.

## Titles live in two places and only one of them is durable

| store | read by | durable? |
| --- | --- | --- |
| `custom-title` record appended to the transcript | AgentHydra | yes |
| `title` in the Desktop metadata file | the app's sidebar | **no**, while that app is running |

A running app rewrites a chat's metadata whenever it touches it, wiping a title *and an
`isArchived` flag* written underneath it. Measured: two chats had both silently reverted within a
minute. `session-launch.ts` already reports this honestly as `titleDurable: !running`.

**Write both.** The transcript record is a single appended line:

```json
{"type":"custom-title","customTitle":"...","sessionId":"..."}
```

and re-apply the metadata write after any operation that boots the chat.

⛔ **On a compiled daemon before 2026-09-13, `chat_rename` answered `ok: true` and did nothing,**
and so did archive and unarchive. `ui-archive.ts` located its PowerShell by hopping `..` off
`import.meta.dir`, which inside a `bun build --compile` exe is the virtual embedded root, so it
asked for a path on a drive that does not exist; `powershell -File <missing>` prints its complaint
and EXITS 0, so a `code === 0` check read that as success. Found by exactly the case above: a
migrated chat landed with no title, `chat_rename` reported success three times, and the sidebar
never changed. Fixed in `bd8bba2` (the script is embedded and resolved through `resolveMiscAsset`,
and a missing path now returns non-zero). ⚠ **A SOURCE daemon was never affected** and never is:
it resolves a real `misc\` folder, so the `..` hop landed correctly there. The defect and its
false green belong to COMPILED builds only, so on a compiled install still on 0.41.0 treat a green
`ok: true` from any of those three as no evidence at all; the rendered sidebar row is the proof.
Check which you are on before trusting either answer: `GET /api/health` reports `distribution`.

## Imports land on `acceptEdits`, which deadlocks an unattended chat

`importSessionToDesktop` creates chats as `acceptEdits`. Nobody is watching a migrated chat, so its
first tool call raises an approval prompt into an empty room and the thread hangs, indistinguishable
from one with nothing to say.

**Owner rule (2026-08-28): every new chat starts with `permissionMode: bypassPermissions`.**

**Fixed:** the stamp used to sit behind a title check - `if (!title) return` ran before it - so an
import with no title kept `acceptEdits` and deadlocked on its first shell call. Both import routes
can pass an empty title. The stamping step is now `stampImportedChat`, split out so it is reachable
by a test at all (every existing import test stops at a guard long before it), and the posture is
applied whether or not a title was given.

Restoring `bypassPermissions` on a migrated chat is not an escalation; the thread already ran that
way before the move.

## ⛔ `send_message` always delivers into YOUR app, and steals the chat to do it

The worst trap here, because it looks like it worked.

A session's own session-management tool addresses chats **in the app that session is running in**.
Give it a session id belonging to another instance and it does not route there - it **re-creates a
local pointer for that chat in your own profile, on `acceptEdits`, and boots it on your account.**

Measured: five chats that had just been moved to a fresh account were woken on the *old* account
instead - the one at 71% weekly the move existed to get off. The transcript grew, the chat answered,
every surface said success. It was billing the wrong account the entire time. Removing the pointer
and repeating the test reproduced it exactly: the pointer reappeared within seconds.

**Rules:**

- Only ever `send_message` to a chat in **your own instance**. Confirm ownership first - the chat's
  metadata file must live under your instance's signed-in account folder.
- For a chat in another instance: **you cannot deliver right now - say so and wait.** The relay
  rung (peer-messaging a live working chat there and having it deliver) is BANNED (owner
  directive, Michael, 2026-08-28: working chats are never couriers). Until the owner opens the
  target instance, the delivery parks. Do not substitute your own `send_message` either - it
  steals the chat onto your account (measured, below).
- **Before booting ANY migrated chat, verify its metadata says `bypassPermissions` and re-stamp
  if it does not** (owner rule, restated 2026-08-28: every migrated chat MUST be bypass before
  it starts). `POST /api/sessions/:id/automation` does the stamp; the dossier shows the mode.
- After any delivery, verify **which account actually ran it**, not merely that the transcript grew.

## Archiving a chat in a RUNNING app

A disk flag alone does not update a running app's in-memory list.
`POST /api/sessions/:id/desktop-archive` now attempts configured native control before any
disk flag or UI action. Pass `instance_ref: "desktop:<full profile path>"` to select the exact
source copy. The archive and migration scripts use the same native adapter through
`POST /api/sessions/:id/native-archive`.

- Native success reports `route:"native"`, `ok:true`, `verified:true`; the desktop route also
  returns `uiArchive:[]` and `stillOnScreen:false`. It checks the app's native state and
  bystanders, preserving chat settings and transcript bytes. Duplicate titles and unrendered
  sidebar rows do not require clicks because native control uses exact session identity.
- `native-only` refuses an unavailable connection, including a closed profile. Open that
  profile through AgentHydra when authorized; never turn the refusal into a disk/UI retry.
  `prefer-native` permits the existing guarded fallback only on proven unavailability before
  dispatch. Native refusal or unknown mutation outcome is terminal in either mode.
- The legacy UIA fallback can still report `stillOnScreen:true` when only a disk flag landed,
  such as an unrendered/ambiguous row. That is not verified archive success. Do not restart an
  active app to hide this failure.
- Native unarchive is not integrated. Existing restore handling must be verified separately;
  do not assume a disk flag changed the running app or request a restart to make it appear so.
- Native archive rejects live/pending work, unsafe cascades and affected preview servers;
  `force` does not bypass these native guards.

### The web UI's move settles its source the same way (2026-09-26)

The Instances row menu's **Move chats to account** and the Sessions tab's migrate both call
`POST /api/sessions/:id/migrate`, and until 2026-09-26 that route settled the old copy with the
disk flag alone: every chat moved off an open account stayed in its sidebar, and the store's
"archived" then made a second move from that account answer "No chats to move". The route now
settles each old copy through `settleMovedSource` (`server/src/move-source-settle.ts`): a closed
app gets the flag; a running app is archived natively; a native refusal is final and reported;
only an unavailable native connection takes the legacy path, and there the in-app click runs
FIRST (a flag written first would confirm the click by itself). A click that does not settle
writes NO flag under the running app, because that flag is the reported bug. It hides nothing,
and the next move from that account finds nothing. The old copy is queued in
`move-retire-on-close.ts` and flagged once that app is closed, provided another account still
shows the chat. "Closed" means a fresh process scan that answered: a failed scan waits, since
listInstances' fallback would read it as nothing running. The queue is also run for a profile
right before AgentHydra opens it. A record filed under a previous login of a running profile is
not on screen, so it gets the flag directly. Everything that puts the chat on an account calls
`keepChatOn` there: `/migrate`, `/import-desktop` (the MCP movers), an unarchive through
`/desktop-archive`, and `POST /api/sessions/:id/keep-here`, which `migrate_chat` posts when it
finds the chat already living on the target. `keepChatOn` drops the queued flag and cancels any
archive watcher still running on that account. An account at its usage wall (98% of either bucket on a fresh cached
reading) is archived over other chats' preview servers, each named in `stoppedBystanders`, the
same standing order the MCP mover applies. Read `sourceStillShown` (the profiles still listing
the chat) and `sourceSettle` (each profile's route and `reason`) on the answer; `ok` means
landed and verified, as before.

A BATCH runs in two passes, as `migrate_batch` does: every chat is landed with
`defer_settle: true`, then `POST /api/sessions/:id/settle-source {instance_ref, leaving}` retires
each one's old copies with `leaving` naming exactly the chats that landed. The native archive of
one chat stops a sibling's preview server only when that sibling is named as leaving, so naming
chats that had not landed (or never would) could stop a server that belonged to a chat that
stayed. `/settle-source` refuses unless the target's store holds the chat unarchived.

## Checklist for a move

1. Use `move_chat` / `move_chats` with the requested source and destination. Their production
   pipeline owns identity resolution, landing, source settlement and settings preservation.
2. Preserve the per-profile native configuration. When a closed account needs opening, use
   AgentHydra Open so `launchDebugger:true` takes effect; do not restart active apps.
3. Require verified destination landing before exact-source archive. Read each phase's result;
   an unknown native archive is not permission to retry through a sidebar menu.
4. Verify the destination's title, model/effort, permission modes, working directory and history
   through the existing guarded pipeline. Native source cleanup alone does not prove full
   migration settings parity.
5. Deliver only if requested, using the existing delivery route, and verify which account ran
   the turn. Migration does not submit a prompt by itself.
6. Read `collateral` on the result (and the top of the report). Empty is the normal answer; a
   named chat there was archived while your move ran and needs unarchiving from its own app.
