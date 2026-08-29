# Moving chats between accounts

Everything in this file was learned the hard way on 2026-08-28, moving 13 chats off an account
whose org had disabled Claude Code. Each section is a trap that produced a wrong result which
*looked* correct at the time. Read this before moving any chat between instances or accounts.

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

After a migrate the chat has a metadata file in **both** profiles: archived in the source, fresh in
the target. That is deliberate - nothing is destroyed - but it has a consequence nobody expects.

AgentHydra's session -> instance map is keyed by transcript id and keeps **one** entry per
transcript, so with copies in two profiles it reports whichever it read last. In practice that was
the stale archived one, which made the dashboard claim a chat was archived on the OLD account while
the live copy sat in the new one. Sessions vanished from `archived=hide` listings entirely.

**Fixed:** `setPreferred` in `instance-sessions.ts` now resolves that collision deterministically -
a live entry beats an archived one, and otherwise the more recently written file wins - and the
migrate route invalidates the 15-second metadata cache so the next read sees the move rather than
the state before it. Pruning duplicates is still tidier, but the dashboard no longer lies while
they exist.

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
  directive, Michael, 2026-08-28: working chats are never couriers). The sanctioned replacement
  is a dedicated orchestrator-owned agent chat per instance; until one exists in the target,
  the delivery parks. Do not substitute your own `send_message` either - it steals the chat
  onto your account (measured, below).
- **Before booting ANY migrated chat, verify its metadata says `bypassPermissions` and re-stamp
  if it does not** (owner rule, restated 2026-08-28: every migrated chat MUST be bypass before
  it starts). `POST /api/sessions/:id/automation` does the stamp; the dossier shows the mode.
- After any delivery, verify **which account actually ran it**, not merely that the transcript grew.

## Archiving a chat in the app you are running in

Disk flags are invisible to a running app until it restarts, and the instance hosting the reviewer
never reaches the zero-live-sessions condition that triggers the restart, because the reviewer is
itself a live session.

- **Other instances:** `POST /api/sessions/:id/desktop-archive` works programmatically, no prompt.
- **Your own instance:** only the app's own archive updates the sidebar immediately, and that tool
  always asks for confirmation. There is currently **no unattended path** for this case.

That gap is worth closing: an endpoint that asks the running app to reload its chat list, or to
archive by id, would make the whole flow scriptable. Until then, expect one confirmation per chat
when tidying the app you are sitting in.

## Checklist for a move

1. Resolve the target account's `accountUuid` / `orgUuid` from `GET /api/instances/:dir/account`.
2. `POST /api/sessions/:id/migrate` with `instance_ref: desktop:<dir>`.
3. Prune duplicate pointers - one metadata file per transcript.
4. Confirm each file sits under the target account's folder; re-file if the instance was re-logged.
5. Set `permissionMode: bypassPermissions`.
6. Write the title to both stores.
7. Restart the target app so it picks up files added while it was running.
8. Deliver only from within the target instance, and verify which account ran the turn.
