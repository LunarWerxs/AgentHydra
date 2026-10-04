# Login sync Worker

The cloud half of AgentHydra's login sync (`server/src/core/cli-login-sync.ts`,
`server/src/core/desktop-login-sync.ts`): a Cloudflare Worker that keeps your CLI and Claude Desktop
logins the same on your PCs, so a login can stay signed in on two PCs at once. When one PC refreshes
a login, it uploads the new one here and the other PC picks it up within about a minute.

The code is public; the store is yours. Each person deploys their own Worker, and nothing reaches it
without its access token, so two people running AgentHydra never share a store.

It never sees a login. Each PC encrypts every login (AES-256-GCM) with a key that stays on your PCs,
and this Worker stores the ciphertext with a version number. It knows only the SHA-256 of its access
token, never the token.

## Deploy your own

1. Create a D1 database (Cloudflare dashboard, Workers & Pages > D1, or `wrangler d1 create
   agenthydra-login-sync`). The Worker creates its table on first use.
2. Make an access token and its hash, and keep the token somewhere private:

   ```bash
   bun -e "const t=require('crypto').randomBytes(32).toString('base64url');console.log('token',t);console.log('sha256',require('crypto').createHash('sha256').update(t).digest('hex'))"
   ```

3. Deploy `worker.js` as an ES-module Worker with three bindings: the D1 database as `DB`, a plain
   text variable `TOKEN_SHA256` set to the hash, and the Durable Object of step 5 as `HEAD`. Turn on
   its workers.dev address (or give it a route).
4. In AgentHydra: CLI tab, the cloud button (Login sync), "Or set up a new store": paste the
   Worker's address and the token. Then "Copy pairing code" and paste it into Login sync on your
   other PC.

5. Add the Durable Object the Worker keeps the store's head in: class `StoreHead` (exported by
   `worker.js`), bound as `HEAD`, created by a migration that makes it SQLite-backed (free plan). With
   wrangler, in `wrangler.toml`:

   ```toml
   [[durable_objects.bindings]]
   name = "HEAD"
   class_name = "StoreHead"

   [[migrations]]
   tag = "v1"
   new_sqlite_classes = ["StoreHead"]
   ```

   Without the binding every authorized route answers 500 (`no HEAD binding`). Deploy the Worker
   before updating AgentHydra on the PCs. If you ever reset or replace the D1 database, delete and
   recreate the Durable Object with it (it holds the old head).
6. Add a Cron Trigger (Worker settings > Triggers, for example `17 3 * * *`, once a day). It prunes
   tombstones older than 30 days (`scheduled()`); a request never does. Without it the Worker still
   works and tombstones only pile up. The schema is checked with one `PRAGMA user_version` per cold
   isolate and migrated only when the database is behind.

`GET /v1/health` answers `{"ok":true}` without a token, to check the address.

## Using it

- **First PC:** set up the store (step 4 above). Every signed-in CLI instance and desktop profile
  uploads within a minute.
- **Each other PC:** update AgentHydra, then CLI tab, the cloud button, paste the pairing code,
  Join. Its logins arrive within a minute: CLI instances under their own names and numbers, desktop
  profiles in a profile of the same name and number (written only while that profile is closed).
- **The pairing code** holds the store address, its token and the encryption key. Move it the way
  you would move a password, never in a chat or a ticket.
- **Leave one login out** on one PC with its switch in Login sync. Logging out leaves it out too, so
  the store does not sign it straight back in.
- **Keep a synced desktop account open on one PC at a time.** One you signed in separately on both
  PCs is left alone, and both stay signed in.
- **Stop syncing on this PC** forgets the store here; the store keeps its copies for the others.

## What it serves

| Route | What |
| --- | --- |
| `GET /v1/logins` | every login's id, version and non-secret meta (instance number, expiry, which PC) |
| `GET /v1/logins/:id` | one login's encrypted blob |
| `PUT /v1/logins/:id` | `{version, blob, meta}`: stored as version+1 when `version` is the current one (0 for new); else 409 with the current version |
| `DELETE /v1/logins/:id?version=n` | removes it at that version |
| `GET /v1/changes?since=<n>` | delta: rows with `rev > n` from each table, tombstones for deleted rows, or `{full: true}` if the cursor is old or the store was reset; also in `x-store-rev` response header on every list route |
| `GET /v1/queues` | each PC's CliMayte queue snapshot: pc id, version, meta (name, time, count) |
| `GET /v1/queues/:pc` | one PC's encrypted queue blob (up to 256 KB) |
| `PUT /v1/queues/:pc` | `{version, blob, meta}`, written like a login (compare-and-swap on the version) |
| `GET /v1/chats` | each synced desktop chat: id, version, meta (no blobs) |
| `GET /v1/chats/:id` | one chat's encrypted blob (up to 256 KB) |
| `PUT /v1/chats/:id` | `{version, blob, meta}`, written like a login (compare-and-swap on the version) |
| `DELETE /v1/chats/:id?version=n` | removes the chat row when `n` is current, else 409; its transcript (the chunks under its session) goes too once no other row shares that session |
| `PUT /v1/chats/:id/chunks/:seq` | `{blob, by}`: an append-only transcript piece (up to 1,048,576 characters), written once; 409 `{error:'taken', next}` if that seq exists; 507 `{error, used, room}` if it would take chats past their room |
| `GET /v1/chats/:id/chunks?from=n` | `{chunks, next, more}`: chunks from seq `n` in order, one page of about 8,000,000 characters |

**Changes feed.** The `/v1/changes?since=<n>` route carries all rows with `rev > n` from `logins`, `queues` and `chats`, plus tombstones for deleted rows, in one batch. The store tracks a `rev` that increments on every successful write (PUT or DELETE), stamps each row with the rev it was written at, and returns the current `rev` in the response and the `x-store-rev` header on every list route, so a client can update its cursor without missing a write. Cursors older than the stored `floor` (tombstones older than 30 days) get `{full: true}` to resync. The head (the `store_rev` row: rev, floor and one rev per table, `logins_rev`, `queues_rev`, `chats_rev`, bumped in the same batch as every write) is held by the `StoreHead` Durable Object, so a cursor equal to the current rev with a matching `If-None-Match` is answered 304 with no D1 statement at all, from a cold isolate too; an evicted Durable Object restores the head from its own storage. Every write runs inside a durable pending token taken from the Durable Object before its batch and handed back with the batch's post-commit head after it. While any token is pending the Durable Object reads the head from D1 on each request (one statement) and keeps the higher, so a lost or failed hand-back costs one D1 read per poll for at most 2 minutes and never hides a change. Each PC names itself on its changes polls (`x-agenthydra-pc`); the Durable Object stamps it seen (saved at most every 3 minutes) and every `/v1/changes` answer, 304 included, carries the other PCs' stamps in `x-seen: <pc>=<epoch ms>,...`, which is how a PC knows the other is alive. The Worker also keeps each list in isolate memory stamped with its table rev (a changed list is merged by `rev > kept.rev` plus tombstones, and re-read in full every 6 hours), and keeps the last rows served by `GET /v1/<table>/:id` under the same stamp, so an older client that polls the full lists every 30 s, or fetches an item whose version did not change, costs the same one-row head read (or nothing inside the trust window). A chat chunk the store already has is refused after one `SELECT 1` on its `(chat, seq)` key and reads no `chat_usage` row; the Worker remembers which chats it has taken a first chunk of, so `MAX(seq)` runs once per chat per isolate. A refused write (409, 507) changes nothing, rev included. An existing database is upgraded on first use (a `rev` column and index are added; old rows keep rev 0). An older client ignores `/v1/changes` and keeps using the list routes; the Worker must be redeployed for the new clients.

**Client use.** Each PC keeps one mirror of the three lists (`server/src/core/login-sync-mirror.ts`): the first pass reads the full lists and starts the cursor at the lowest `x-store-rev`; later passes ask only `GET /v1/changes?since=<cursor>` (upsert rows, drop `gone`), and a missing route, a list without `x-store-rev` or `{full: true}` means the full lists again. The daemon ticks every 30 s but runs a pass only when one is due: after a pass that found nothing new and had nothing to upload the next waits 30 s, then doubles up to 5 minutes (`IDLE_MAX_MS`, `server/src/core/login-sync-pace.ts`), and it is back to 30 s at once on a local change (a login file, a live CliMayte worker), a manual sync or a launch. An unchanged CliMayte queue is never re-uploaded: the other PC reads this one as alive from its polls (`x-seen`).

The chat routes (desktop chat sync) need this Worker **redeployed** too: paste the new `worker.js` over
the old one. Chats and chunks live in their own `chats` and `chat_chunks` tables.

**Room for chats.** Transcripts take at most 400 MB of the database (a running total in
`chat_usage`), because D1's free plan stops a whole database at 500 MB and the logins live in the same
one: a full chat room never stops a login from syncing. AgentHydra removes a chat from the store three
days after it was archived (each PC keeps its copy). On Workers Paid (10 GB per database) you can raise the
room with an optional plain-text variable `CHAT_STORE_MB`.

The queue routes (the "Share CliMayte queue" toggle in AgentHydra) need this Worker **redeployed
once**: paste the new `worker.js` over the old one. Queues live in their own `queues` table, never in
`logins`. An older AgentHydra never calls the queue routes, and a Worker without them only makes the
toggle report that it has no queue routes yet; logins sync as before.

Every route but `/v1/health` needs `Authorization: Bearer <token>`.
