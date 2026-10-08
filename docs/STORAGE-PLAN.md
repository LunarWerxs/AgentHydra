# Storage plan: local stores, sync, and what to build

Owner's ask (2026-10-03): "Look through how we store data, how we locally database and how we sync,
and do your best to simplify, unify, consolidate, compress, speed up, index, all that good stuff."

This is the plan only. Nothing here is built yet. Every number was measured on the owner's main PC
on 2026-10-03, read-only. SQLite files were copied to a temp folder first, and every
`EXPLAIN QUERY PLAN`, timing, `VACUUM` and test index ran on those copies, never on a live file. The
D1 row counts came from the owner's Cloudflare dashboard (given, not re-measured).

The measurement scripts live outside the repo (`%TEMP%\storeplan\`). Each piece below gives its own
before/after command.

## Summary: the top findings

| # | Finding | Measured |
|---|---|---|
| 1 | The login sync reads about 2,600 D1 rows an hour with both PCs "idle", against a target of about 60. The main cause: any live CliMayte worker pins the pass to every 30 s (`climayteBusy()` nudges on every tick), and each pass misses the Worker's head cache on `*.workers.dev`. | 2,600 rows/h; 391/h are `store_rev` head reads |
| 2 | CliMayte stream logs are written plain and packed only 24 h after an attempt ends. | 641 MB in 1,129 plain `.jsonl` files written in the last 24 h; about 58 MB/h in a 7-minute sample; zstd packs them 7.0-7.7x in 21 ms per 9.7 MB |
| 3 | Four managed Claude app copies for native control are kept forever. | `data/claude-native/` = 2.5 GB (4 x ~610 MB) |
| 4 | `~/.hswarm` holds an imported copy of `~/.zswarm`, and the AgentHydra server reads only the `~/.zswarm` copy. Neither ledger rotates. | `ledger.jsonl` 142.7 MB vs 143.0 MB; `routing.jsonl` 2,450,430 bytes in both; old `~/.zswarm/egress.jsonl` 470 MB uncompressed |
| 5 | Unindexed hot queries in `hswarm.sqlite` and `agenthydra.db`. | HSwarm `claude_days` EXISTS: 1,274 ms, and 0.08 ms with a stored `day` column plus index. Next `seq` per machine, run on every record: 24.9 ms, and 0.02 ms indexed. Sessions-list `thread_key` scan: 68.8 ms, and 1.8 ms with a partial covering index |

Also measured: `agenthydra.db` is a 41.2 MB file holding about 17.5 MB of payload. Its free list is
3,330 pages (13.6 MB, 33%), with `auto_vacuum=0`. `search-index.db` is 58.7 MB against the ~12 MB
its header promises (`conv_data` is 51.6 MB in 13,118 blocks). `usage-history.json` (2.2 MB) is
rewritten whole, without a temp file, on every usage sample.

## 1. Local stores: inventory

Roots: `CONFIG_DIR` = `~/.agenthydra`; `DATA_DIR` = `CONFIG_DIR/data`; CliMayte `ROOT` =
`CONFIG_DIR/corch`; `H` = `~/.hswarm`. The orchestrator writes JSON under
`<checkout>/orchestrator/state`. That folder is in the live checkout, which this task must not
touch, so it was not measured.

### 1a. SQLite

| Store | Size | Rows | Journal | Write rate (7-min sample) | Notes |
|---|---|---|---|---|---|
| `DATA_DIR/agenthydra.db` (`db.ts`) | 41.2 MB + 1.0-1.5 MB WAL | session_stats 10,247; session_edits 10,000 (capped); session_scan_cache 3,438; run_events 5,199; skill_listings 838; others under 350 | WAL, `synchronous` default (FULL), `auto_vacuum` 0, `user_version` 0 | WAL +0.37 MB | Free list 3,330 pages (13.6 MB). Payload: scan_cache 5.5 MB (its `*_json` columns are 2.8 MB), session_stats 3.5 MB, run_events 3.4 MB (legacy dispatch), session_edits 3.2 MB (`cache_key` alone is 1.5 MB). Of the session_stats rows, 6,811 (66%) are for files that are gone, which is permanent by design. |
| `DATA_DIR/search-index.db` (`search-index.ts`) | 58.7 MB | doc 3,283; conv_data 13,118 blocks | `delete` (one file on purpose) | not written (last write 2026-10-02 03:48; refreshed only by a search) | Contentless FTS5 with `contentless_delete=1`, never `optimize`d: deletes leave segments behind. Free list 1,216 pages. |
| `H/hswarm.sqlite` (`hswarm/utilization.py`) | 25.7 MB | utilizations 51,841; claude_accounts 568; claude_days 77; profiles 36 | WAL | about 0 | utilizations payload 18.5 MB. `basis` (4.4 MB) and `caller_cwd` (1.9 MB) repeat on every row. Every `connect()` re-runs the schema and `_migrate`: a `seq IS NULL` scan of 21.6 ms. |
| `H/history/tasks.sqlite` (`hswarm/taskstore.py`) | in the 925 MB `history/` | n/a | rollback | daily (`maintain`) | `WHERE status='ok' AND created >= ?` cannot use `tasks_shape`. The result is cached by mtime, so this is low priority. |
| Foreign, read-only: OpenCode `opencode.db`, Hermes, `~/.zswarm/zswarm.sqlite` (26 MB) | n/a | n/a | n/a | n/a | Opened read-only per query (`core/sqlite-worker.ts`). Not ours to change. |

**Query plans that matter** (copies; average of 5 runs; "after" = the same query with the index
added to a second copy):

| Query (file:line) | Runs | Before | Plan | After |
|---|---|---|---|---|
| `thread_key is not null and scan_version >= ?` (`sessions.ts:177`) | every sessions list | 68.8 ms | SCAN session_scan_cache | 1.8 ms, partial covering index `(scan_version, cache_key, thread_key) WHERE thread_key IS NOT NULL` |
| `limit_notice is not null and scan_version >= ?` (`sessions.ts:161`) | every list | 15.4 ms | SCAN | 0.15 ms, partial index |
| session_edits cap delete (`analytics.ts:1393`) | per analytics persist | 37.6 ms | SCAN + temp B-tree | 8.3 ms, index `(ts desc, id desc)` replacing `idx_session_edits_ts` |
| HSwarm `claude_days` EXISTS on `date(ts,'localtime')` (`utilization.py:646`) | summary and report | 1,273.8 ms | correlated SCAN of 51,841 rows per day | 0.08 ms with a `day` column stored at write time plus index `(machine, day)` (`localtime` cannot be indexed) |
| HSwarm `MAX(seq) WHERE machine = ?` (`utilization.py:143`) | every job and ask | 24.9 ms | SCAN | 0.02 ms, index `(machine, seq)` |
| HSwarm migrate probe `seq IS NULL` (`utilization.py:129`) | every connect | 21.6 ms | SCAN | 0 ms when gated by `PRAGMA user_version` |
| `queue_items` scheduler and retry polls (`scheduler.ts:69`, `dispatch.ts:322`) | every 5 s and 2 s | 0.69 / 0.03 ms | SCAN (34 rows) | **Do not index.** At 34 rows an index is useless. |
| `session_stats_gone` index (`analytics.ts:1192`) | per report | 43.5 ms | the planner skips the index (66% of rows match) | The index is dead weight. Drop it, or make it partial on recent rows. |
| search `conv match ?` | per search | 1.4 ms | FTS | fine |

### 1b. JSON stores (whole-file rewrites)

From the code (agent inventory, file:line) and the 7-minute stat sample:

| Store | Size | Write | Read | Problem |
|---|---|---|---|---|
| `DATA_DIR/usage-history.json` (`usage-history.ts:58-89`) | 2.2 MB | Non-atomic full rewrite per recorded sample | full parse per forecast/budget call | Biggest whole-file rewrite; the key count is unbounded |
| `DATA_DIR/usage-cache.json` (`usage-cache.ts`) | 46 KB | Non-atomic RMW per usage check per account | re-read from disk on **every** get, with no memory cache | One of six usage stores (see Overlaps) |
| `DATA_DIR/price-catalog.json` | 2.26 MB | Non-atomic, at most daily | once at boot | fine; could be zstd (JSON) |
| `corch/workers.json` (`save`, `climayte-core.ts`) | 231-270 KB | Atomic rewrite on every `changed(w)`, **no lock** | once at boot | Rewritten on every worker change. The rewrite counter was still queued at writing time (see Open). |
| `corch/live.json` | 6.6 KB | at most once a tick (1-15 s) | at boot | fine |
| `CONFIG_DIR/cli-instances.json` (`json-store`) | 47 KB | lock + atomic, including `lastUsageCheck` on every usage check | per UI poll (~4 s) | A volatile field in a registry file |
| `CONFIG_DIR/login-sync.json` | 14 KB | atomic rewrite on **every pass** (`cli-login-sync.ts:1214`) | **every 30 s tick** | Rewritten even when nothing changed but `lastSyncAt` |
| `CONFIG_DIR/desktop-chat-sync.json` | 12.6 KB | atomic per chat pass | per pass | fine |
| `DATA_DIR/remote-chats/<project>/<session>.jsonl` (the chat viewer, `REMOTE_CHATS_DIR`, since 2026-10-05) | the other PC's transcripts (25 MB in 4 files for 3 chats on MPC-HELL, 2026-10-05) | append-only at the length it has, or rewritten from 0 when the origin starts over | as a Claude store by the session list | fine; read only, never a Claude chat list |
| `instances-cache.json`, `known-accounts.json` (17 KB), `codex-accounts-cache.json`, `instance-*.json`, `ui-prefs.json`, `session-continuations.json`, `reset-watch.json` (41 KB), `keepalive.json`, `quota-calibration.json` | small | RMW, mostly atomic; several without a cross-process lock | n/a | Leftover `instances-cache.json.*.tmp` files from 2026-09-02/05 show interrupted rewrites |
| `H/keys.json` -> `H/keys.sqlite` | was 1.0 MB: 4,464 entries of ~236 bytes, 4,391 of them dead (disabled) keys, none stale (`~/.zswarm` copy 1.6 MB) | one row upserted per rest/recover (~4 KB written, was 1.05 MB) | rows past the last `rev` seen | **Done** (piece 14): `hswarm/keystate.py`; keys.json is imported once, then deleted |
| `H/savings-daily.jsonl` | 7.2 MB | whole rewrite daily | whole | fine |

### 1c. Append logs and folders

| Store | Size | Rate | Retention / compression |
|---|---|---|---|
| `corch/logs/*.jsonl` (CliMayte stream logs) | 809 MB (652 MB plain in 1,141 files + 186 MB zst in 847 files) | **~58 MB/h** in the 7-minute sample; 641 MB in the last 24 h | zstd-packed only 24 h after the attempt ends, ≤32 MiB per hourly pass, at writing. Plain files older than 2 days: 0, so packing does keep up. Since piece 6: 10 minutes after it settles, ≤128 MiB a pass (`packOldLogs` in `climayte.ts`, `planStorage` in `climayte-storage.ts`). |
| `corch/journal.jsonl` + `.1` | 0.2 + 5.2 MB | append per state change | one 5 MiB generation |
| `corch/prompts` 13 MB / 2,164 files; `handoffs` 4.7 MB / 581; `done` 17 MB / 1,059; `hooks`, `signals` | 35 MB | several new files per attempt | **no cleanup** |
| `corch/archive/<stamp>` | 47 MB | on remove | never deleted |
| `data/claude-native/<build>` | **2.5 GB** (4 builds) | one per Claude update | **never deleted** |
| `data/run-logs` (legacy dispatch) | 55 MB / 62 files | none (dispatch banned) | `.stream.jsonl` kept forever |
| `logs/daemon.log` | 1.6 MB | per `console.*` | rotates at 5 MiB **only at boot** |
| `H/ledger.jsonl` | 142.7 MB | one line per task or ask | never rotated |
| `H/jobs/` | 1.4 GB (zip 1.2 GB LZMA, txt 136 MB, 17,318 files) | per job | zipped after 24 h, moved to `history` after 7 d |
| `H/history/*.tar.xz` | 925 MB | daily | kept forever unless `maintain --keep-days` |
| `~/.zswarm/egress.jsonl` (legacy, pre-rotation) | 470 MB plain | none since 2026-10-02 | the newer days are `.jsonl.xz` |

### 1d. Overlaps (one fact, several stores)

- **Usage readings, six places:** `usage-cache.json`, `usage-last-known.json`,
  `usage-history.json`, `cli-instances.json:lastUsageCheck`, `corch/live.json`,
  `quota-calibration.json`. `usage-cleared.json` filters them, and HSwarm keeps its own
  `claude_days`/`claude_accounts` plus `savings-daily.jsonl`.
- **Account identity, four places:** `instances-cache.json`, `known-accounts.json` (mirrors every
  cache write), `codex-accounts-cache.json`, `cli-instances.json` identity fields.
- **Per-transcript freshness `(path, mtime, size)`, three places:** `session_scan_cache`,
  `session_edits`, and `search-index.db doc`. Each walk re-checks it separately.
- **Per-session totals:** `session_scan_cache` analytics columns (a cache, pruned) and `session_stats`
  (permanent).
- **HSwarm cost:** `ledger.jsonl`, `jobs/*/results.jsonl`, `tasks.sqlite`, `utilizations`, and the
  sync shard. Each ask is written to the ledger and to `utilizations` in the same call
  (`mcp_server.py:542-543`).
- **`~/.hswarm` vs `~/.zswarm`:** the ledger, routing and savings files are near-identical copies
  (`import_zswarm.py`). The AgentHydra spend view reads only `~/.zswarm/ledger.jsonl`
  (`zswarm-cost.ts:44-47`).
- **Rate-limit state:** `agent_status` (source `rate-limit`) and `monitor_state`.

## 2. Sync paths

| Path | What moves | How often | Cost |
|---|---|---|---|
| Login sync → Cloudflare Worker + D1 (`core/cli-login-sync.ts`, `login-sync-mirror.ts`, `login-sync-pace.ts`, `cloud/login-sync-worker/worker.js`) | `logins` rows: AES-GCM blobs ≤64 KB plus meta | a pass every 30 s, backing off to 300 s when quiet | most of the 2,600 rows/h |
| CliMayte queue (`climayte-queue-sync.ts`) | one `queues` row per PC: gzip → AES-GCM → base64 inside JSON inside base64 | shape change at once; live/volatile at most every 10 min; heartbeat every 15 min | UPDATE queues ~179/h (re-sent on worker order changes: being fixed elsewhere) |
| Desktop chats (`desktop-chat-sync.ts`, `chat-sync-codec.ts`) | `chats` rows plus append-only `chat_chunks` (zstd-12 + AES-GCM) | at most every 5 min per chat; archived rows deleted after 3 days (each leaves a tombstone) | bytes, plus tombstones |
| Desktop logins (`desktop-login-sync.ts`) | `logins` rows with `meta.kind='desktop'` | same pass | small |
| HSwarm vault (`hswarm/vault.py`) | API key lists only, zlib + AES-GCM, over `ssh://` or a shared `dir:` | every 120 s | no D1; 40 versions kept |
| HSwarm usage shards (`utilization.py:913`) | per-machine JSONL in a private git branch | on `maintain`/`sync`; off unless `HSWARM_SYNC_REPO` is set | git |
| Orchestrator → daemon | HTTP to `127.0.0.1` | per command | local |

### 2a. Why D1 reads 2,600 rows an hour (from the code)

D1 bills the rows each statement looks at. Per request the Worker costs:

- **Idle `GET /v1/changes`, isolate cold or head older than 75 s:** one batch of `store_rev` (1 row)
  plus four `WHERE rev > ?` range reads (`logins`, `queues`, `chats`, `tombstones`). That is 1 row
  plus every row changed since the cursor. The Cache API tier is a no-op on `*.workers.dev`
  (`login-sync-pace.ts:3-5`), and free-plan isolates are short-lived, so most polls pay.
- **Every write** (`storeRow`): `UPDATE store_rev ... AND EXISTS(row)` (2 rows), the row UPDATE
  (1 row), and `HEAD_SQL` (1 row). About 4 rows.
- **Every cold isolate** (`ensureSchema`): four `PRAGMA table_info` calls, `CREATE ... IF NOT EXISTS`,
  `SELECT chars FROM chat_usage`, `INSERT OR IGNORE store_rev`, and **two full scans of
  `tombstones`**: `SELECT MAX(rev) FROM tombstones WHERE time < ?` and
  `DELETE FROM tombstones WHERE time < ?`. Neither can use an index, because `tombstones` is indexed
  on `rev` only.
- **Queue download:** `GET /v1/queues/:pc` goes through `io.call`, not `mirror.getItem`
  (`climayte-queue-sync.ts:300`). That is head plus row: 2 rows per new version.

What drives the volume:

1. **The pace never backs off while CliMayte works.** The tick calls `pace.nudge()` whenever
   `climayteBusy()` (any worker queued, running, waiting or checking; `cli-login-sync.ts:1406`).
   CliMayte workers run most of the day, so each PC passes every 30 s: 120 passes/h instead of 12.
   Two PCs × 120 passes, plus the write batches, matches **store_rev ≈ 391/h**.
2. **Queue uploads** (~179/h). Each costs ~4 rows on write. The changed row is then returned by the
   next `queues WHERE rev > ?` of both PCs and listed again by old clients' `listRows`. That matches
   **queues WHERE rev > ? ≈ 223/h**.
3. **Tombstones ≈ 214/h:** the two unindexed `time < ?` scans per cold isolate (× every tombstone
   kept for 30 days; archived chats add one each), plus the `tombstones WHERE rev > ?` range in every
   uncached changes batch.
4. The 15-minute heartbeat: 2 PCs × 4 uploads/h × ~4 rows, plus downloads at 2 rows each, is about
   50 rows/h on its own. That is close to the whole 60/h budget.

### 2b. The cheaper shape (target ≤ 60 rows/h, idle ≈ 0)

1. **Separate push from pull.** A local change (a login file moved, the queue's *shape* changed)
   triggers an upload at once. Polling for remote changes backs off to 5 min whatever CliMayte is
   doing. `climayteBusy()` nudges only when the snapshot fingerprint changed since the last upload.
   The cost is 120 → ≤12 passes/h per PC.
2. **One change feed instead of four tables.** An append-only
   `changes(rev INTEGER PRIMARY KEY, tbl, id, gone)` is written in the same batch as each write and
   delete. `GET /v1/changes?since=n` is one `SELECT ... FROM changes WHERE rev > ?` (rows = real
   changes, 0 when idle) plus the head. Tombstones become `gone=1` entries, so the `tombstones` table
   and its scans go. The floor is the lowest kept rev.
3. **A rev short-circuit that survives cold isolates.** Put the head in a single Durable Object
   (SQLite-backed DOs are on the free plan). It is the only writer path, so its in-memory head is
   authoritative. The client sends `If-None-Match: "<rev>"`, and an unchanged store answers `304`
   with 0 D1 rows. *Without a DO*, the next best is a custom-domain route, so that `caches.default`
   works and the existing 120 s shared tier stops being a no-op.
4. **Liveness without uploads.** The DO stamps `lastSeen[pc]` on every poll, and
   `/v1/changes` returns it. The other PC reads "alive" from that, and the 15-minute heartbeat upload
   goes (−50 rows/h).
5. **Schema once, pruning on a cron.** Gate `ensureSchema` on `PRAGMA user_version` (or
   `wrangler d1 migrations`). Move tombstone/changes pruning to a daily `scheduled()` handler using an
   index on `time` (or prune `changes` by `rev`).
6. **Batch and slim the payload.** One `POST /v1/batch` per pass carries every upload of that pass
   (queue, logins). Queue blob: zstd instead of gzip (on CliMayte logs zstd measured 7.0x against
   gzip's 2.2x), and drop the inner base64-in-JSON-in-base64 (~33% of the blob). Queue downloads go
   through `mirror.getItem`.

Rough idle budget after 1-5: 2 PCs × 12 polls/h × 0 rows (304) + real changes × ~3 rows. That is
well under 60/h.

## 3. Findings list (each with its number)

1. **D1 pass pinned at 30 s by CliMayte activity**: 2,600 rows/h vs a 60/h target (§2a).
2. **CliMayte logs packed late**: 641 MB/24 h written plain, 7x compressible in ~2 ms/MB.
   Packing ~10 min after an attempt settles instead of 24 h keeps `corch/logs` near 250 MB instead of
   809 MB.
3. **`claude-native` copies never pruned**: 2.5 GB in 4 builds. Keeping the current one and one
   previous frees ~1.2 GB.
4. **`~/.hswarm` duplicates `~/.zswarm`** (ledger 142.7 vs 143.0 MB, routing identical), and the
   server reads the wrong one for HSwarm spend. Neither ledger rotates; the legacy zswarm
   `egress.jsonl` is 470 MB plain.
5. **HSwarm summary query 1,274 ms → 0.08 ms**; per-record `seq` 24.9 → 0.02 ms; per-connect
   migrate probe 21.6 ms (§1a).
6. **Sessions list 68.8 → 1.8 ms** with a partial covering index; `limit_notice` 15.4 → 0.15 ms;
   edits cap 37.6 → 8.3 ms.
7. **`agenthydra.db` is 33% free pages** (13.6 MB of 41.2 MB) with `auto_vacuum=0`. WAL runs at
   `synchronous=FULL`, where `NORMAL` is safe under WAL and cheaper per commit.
8. **`search-index.db` 58.7 MB vs ~12 MB designed**: FTS5 never optimized after contentless
   deletes. The optimize+VACUUM measurement on a copy was still queued (see Open).
9. **Usage in six JSON stores**: `usage-history.json` 2.2 MB rewritten whole and non-atomically per
   sample, and `usage-cache.json` re-read from disk on every get.
10. **`login-sync.json` rewritten on every pass and read every 30 s.** The pass writes even when only
    `lastSyncAt` moved.
11. **Unbounded folders**: `corch/prompts`+`handoffs`+`done` 35 MB / 3,804 files, `corch/archive`
    47 MB, `run-logs` 55 MB legacy, HSwarm `history` 925 MB kept forever.
12. **Useless index**: `session_stats_gone` (66% of rows match, so the planner scans anyway). Missing
    indexes on `queue_items`/`monitor_state` do not matter at 34/51 rows: do not add them.
13. **`daemon.log` rotates only at boot**: a daemon that stays up for weeks grows it without bound.
14. **`H/keys.json` 1 MB rewritten whole on every 429 event.**

## 4. Pieces (build order, biggest measured win first)

Each piece is one session. "Measure" is the before/after command; run it before the change and after
the change.

1. **Login-sync pace: push on change, pull on backoff.** Files: `server/src/core/cli-login-sync.ts`
   (tick, `climayteBusy` nudge), `login-sync-pace.ts`, `climayte-queue-sync.ts` (export the
   fingerprint). Done when a live CliMayte worker with an unchanged snapshot no longer nudges, and a
   queue shape change still uploads within one tick. One regression test in the pace test. Measure:
   D1 dashboard rows read/h (or the passes/h counter logged by the pass) over 1 h with a worker
   running. Expect 2,600 → under 800.
2. **Worker: schema once, pruning on a cron.** Files: `cloud/login-sync-worker/worker.js`
   (`ensureSchema` gated on `PRAGMA user_version`; `scheduled()` prunes tombstones; index
   `tombstones(time)`), `wrangler` config cron. Done when a cold isolate's first request runs ≤2
   statements and the tombstone scans are gone. Measure: D1 "rows read by query" for
   `tombstones` (expect 214/h → ~0) and the Worker test suite.
3. **Worker: one `changes` feed, plus `If-None-Match`/304.** Files: `worker.js`,
   `login-sync-mirror.ts` (send the cursor as an ETag; handle 304). Keep `/v1/changes` answering
   old clients. Done when an idle poll is one statement, or zero on 304. Measure: D1 rows/h idle
   over 1 h (expect under 100).
4. **Worker: Durable Object head plus `lastSeen`; drop the queue heartbeat.** Files: `worker.js`
   (+ DO class), `climayte-remote.ts` (staleness from `lastSeen`), `climayte-queue-sync.ts`
   (`HEARTBEAT_MS` goes). Done when an idle store reads 0 D1 rows per poll. Measure: D1 rows/h with
   both PCs idle (target ≤60).
5. **Queue payload and download.** Files: `climayte-queue-sync.ts` (zstd, single base64,
   `mirror.getItem` for downloads; read both formats for one release). Measure: blob bytes
   (`meta`/log line) and `GET /v1/queues/:pc` count per hour.
6. **Pack CliMayte logs on settle.** Files: `server/src/climayte-storage.ts` (`PACK_AFTER_MS` 24 h → 10 min
   after `logSettled`; raise `PACK_PASS_BYTES` or run every 10 min), plus a retention for
   `corch/prompts|handoffs|signals|hooks` of finished workers (e.g. 14 days) and for
   `corch/archive`. Measure: `du -sh ~/.agenthydra/corch/logs` and plain-vs-zst bytes (the
   python one-liner in §1c's source: sizes by extension and age). Expect 809 MB → ~250 MB.
   **Done.** `packOldLogs` (`climayte.ts`) packs a settled log 10 minutes after it ends, up to 128 MiB a
   pass. The storage pass (`planStorage`, `storagePass` in `climayte-storage.ts`) removes a finished worker's
   prompts, handoffs, signals, hooks and sealed folder (`corch/sealed/<worker id>`, since 2026-10-08, when
   sealed tasks stopped leaving a folder in `%TEMP%`) 14 days after its last attempt ended or the file was
   last written, whichever is later, and a removed task's `corch/archive` folder after 30 days; a dry run
   also lists what would be packed. Pinned by `server/tests/climayte-storage.test.ts`.
7. **Prune old `claude-native` builds.** Files: `server/src/claude-native-launch.ts`. Keep the build
   in use and one previous; never delete one a running Claude holds. Measure:
   `du -sh ~/.agenthydra/data/claude-native` (2.5 GB → ~1.2 GB).
8. **One HSwarm home.** The server half landed with ZSwarm's retirement (2026-10-03):
   `server/src/hswarm-cost.ts` and `server/src/hswarm-sessions.ts` (were `zswarm-*.ts`) read
   `~/.hswarm` only, with no fallback, since `~/.zswarm` is archived. Landed after that:
   `hswarm/ledgerstore.py` rotates monthly to `ledger-YYYYMM.jsonl.gz` (gzip, not xz: Bun reads gzip
   and cannot read xz) with every reader and the kit following, and `import_zswarm.py` is a one-shot. Measure: `du -sh ~/.hswarm ~/.zswarm` and spend totals equal
   before/after.
9. **HSwarm SQLite indexes.** Files: `hswarm/utilization.py`: `day` column filled at write
   (local date), index `(machine, day)`, index `(machine, seq)`, schema/migrate gated on
   `PRAGMA user_version`. Measure: `python eqp.py hswarm-copy.sqlite hq.json` (1,274 ms → <1 ms;
   24.9 ms → 0.02 ms).
10. **`agenthydra.db` indexes and pragmas.** Files: `server/src/db.ts`: partial indexes on
    `session_scan_cache` for `thread_key` and `limit_notice`, `session_edits(ts desc, id desc)`
    replacing `idx_session_edits_ts`, drop `session_stats_gone`, `synchronous=NORMAL`,
    `auto_vacuum=INCREMENTAL` (one `VACUUM` at upgrade) plus `incremental_vacuum` on idle. Measure:
    the `eqp.py` run on a copy (68.8 → 1.8 ms) and the file size against the free list.
11. **Search index upkeep.** Files: `server/src/search-index.ts`: after a refresh that deleted rows,
    `INSERT INTO conv(conv) VALUES('optimize')` when segments exceed N, and `VACUUM` when the free
    list exceeds 25%. Measure: `search-index.db` size, plus the timing of `conv match` on a copy.
12. **Usage samples into SQLite.** Files: `usage-history.ts`, `usage-cache.ts`, `db.ts`: table
    `usage_samples(key, at, session_pct, week_pct, ...)` PK `(key, at)`, retention 90 days;
    `usage-cache` kept in memory with the DB as backing. Retire `usage-history.json` after a one-time
    import. Measure: bytes written/h to `DATA_DIR` (snap.py) and the forecast endpoint's latency.
13. **Quiet rewrites.** `login-sync.json` written only when something but `lastSyncAt` changed (keep
    `lastSyncAt` in memory, flush every 10 min); `cli-instances.json:lastUsageCheck` moves to
    memory/SQLite; `daemon.log` rotates at runtime; `H/keys.json` rest state split from the key
    list. Measure: `rewrites.py 600` (rewrites/h per file).

## 5. What this means for the analytics toolkit (docs/ANALYTICS-PLAN.md)

- **Read SQLite, not JSON.** Per-session facts are already in `agenthydra.db` (`session_stats`,
  permanent; `session_scan_cache`, a cache). HSwarm facts are in `hswarm.sqlite`. One read-only
  connection can `ATTACH` both. Build on `session_stats`, not on the cache columns (they are pruned
  when a file goes).
- **Store local dates at write time.** Every per-day rollup that computes `date(ts,'localtime')` on
  read scans its table (the HSwarm case: 1.27 s). New tables should carry a `day` column.
- **Usage samples are about to move** (piece 12). Analytics should read `usage_samples`, not
  `usage-history.json`.
- **HSwarm spend has one source after piece 8** (`~/.hswarm`). Do not build on `~/.zswarm`.
- **Do not add a seventh usage store.** Extend `usage_samples` or `session_stats` instead.

## Open (not measured, with the reason)

- The FTS5 `optimize`+`VACUUM` and `agenthydra.db` `VACUUM` results on copies, and the
  per-file rewrite counter (`rewrites.py`), were queued behind the shared CPU/memory gate when this
  doc landed. The free-list figures above (13.6 MB and 1,216 pages) are measured. Pieces 10, 11 and
  13 re-measure as their first step.
- `orchestrator/state` sizes: that folder lives in the live checkout, which this task was told not
  to touch.
- The split of the remaining ~1,600 D1 rows/h across statements is reasoned from the Worker code
  (§2a), not read from D1. Take it from the dashboard's per-query view after piece 1.
