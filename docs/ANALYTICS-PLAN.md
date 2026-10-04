# One analytics toolkit: plan

Owner's ask (2026-10-03): the Analytics tab, the HSwarm overview and the CliMayte analytics should all
come from **one analytics toolkit** that records everything once and hands it to each UI part that
needs it.

This document is the plan only. Nothing here is built yet. It has five parts:

1. what produces numbers today;
2. what reads them;
3. where they duplicate each other and disagree, with measurements;
4. the design;
5. the build pieces, in order.

Measured on the owner's main PC on 2026-10-03, against the running daemon (`http://localhost:7787`)
and against copies of `agenthydra.db` and `hswarm.sqlite` taken with SQLite's backup API. Nothing
live was written. Line numbers are from `origin/main` at `8270c97e`.

---

## 1. Producers

### 1.1 Shared building blocks (TypeScript)

| Module | What it does |
|---|---|
| `server/src/usage-tokens.ts` | The main per-turn parser. `accumulateUsageLine` (:218) counts each response once. It keys on `message.id\|requestId`, adds only the output delta, and splits cache writes into 5m and 1h, per model. `weighCounts` (:106) produces "weighted" tokens fitted to the subscription meter, not to prices. Wrappers: `sumTranscriptTokens` (:323), `tokensSince` (:417), `forEachTurnSince` (:442). It stores nothing. |
| `server/src/pricing.ts` | The TypeScript price table `PRICES` (:68), dated `PRICES_AS_OF` 2026-09-30. Each entry has five rates: input, output, cache read, 5m write and 1h write. Cache rates are derived as 0.1/1.25/2× input unless stated outright. Has `intro` pricing. Functions: `priceFor` (:253), `priceTokens` (:304). Unknown models come back unpriced and are never guessed. |
| `server/src/price-catalog.ts` | Downloads the LiteLLM catalog daily into `DATA_DIR/price-catalog.json` (2.3 MB). The catalog wins over the bundled table. |
| `server/src/usage-foreign.ts` | Codex rollouts (`CodexUsageReader` :103), OpenCode (which reports its own cost, `openCodeSpend` :200), plus Hermes and DSH. Used only by `analytics.ts`. |

### 1.2 Producers

All storage sizes are on this PC.

| # | Producer | What it records | Storage | How it is computed | Route | UI readers |
|---|---|---|---|---|---|---|
| P1 | `analytics.ts` + `routes/analytics.ts` | Per session: per-model tokens (input, output, cache read, 5m/1h write, weighted, turns), a day histogram, an hour-of-week histogram, tools and errors, edits, compactions, active time, sinks, provider cost. Reports: spend (by provider/model/project/day/account), activity, sinks, concurrency, edits. | `agenthydra.db` (41 MB total): `session_scan_cache` (3,438 rows; analytics columns `tokens_json`, `days_json`, …), `session_stats` (10,247 rows, permanent, priced at write time, `instance` = desktop label), `session_edits`, `skill_listings` | Background warm at boot in 120 s chunks. A file is rescanned when its (mtime, size) or `ANALYTICS_VERSION` changes. Reports are built per request. A time window is applied by scaling each session by its day share (`windowShare` :1623). | `GET /api/analytics/{spend,activity,sinks,concurrency,edits,corrections}`, `GET/DELETE /api/analytics`, `POST /api/analytics/refresh` | AnalyticsView, MCP `get_spend` and the activity/sinks tools |
| P2 | `edit-survival.ts` | Whether written text is still in the files (4-gram), measured 2 h to 14 d after the session | `session_scan_cache.edit_survival*` | Inside the P1 scan | via `/api/analytics/activity` | AnalyticsView |
| P3 | `session-usage.ts` | Tokens and cost of one Claude session, with no subagent files. `runCost` limits it to a queued run's time span. | Memory, LRU of 32 | Reads the analytics kit | `GET /api/sessions/:id/usage`, `GET /api/queue/:id/cost` | SessionsView header chip (`getRunCost` has no UI caller) |
| P4 | `core/cli-instance-tokens.ts` | All-time input/output/cacheRead/cacheWrite per CLI config dir | Memory (per-file cache) | Its **own parser** (`tokensInTranscript` :27, dedupe on `message.id` only). Stale-while-revalidate, refreshed after 60 s. | `tokens` field of `GET /api/cli-instances` | CliInstancesSection Tokens column |
| P5 | `climayte-lib.ts` `attemptSpend` (:1116) → `climayte-core.ts` → `climayte-totals.ts` | Per attempt: tokens and $. Totals add tasks, runs by outcome, CLI sessions, % of a Pro window, reread share, limit hits, per-account 5 h peaks, sizing. | `~/.agenthydra/corch/` (894 MB, mostly logs and transcripts): `workers.json`, `journal.jsonl`, per-task files | `attemptSpend` parses each file twice (start minus end) when an attempt ends and stores the result. Totals are summed per request. | `GET /api/corch/totals` | OffloadStatsCard, InstancesHomeView tokens tile |
| P6 | `climayte-scorecard.ts` | Pass/fail and units per kind × model × effort. Units come from `weighCounts` divided by a fixed `UNITS_PER_PRO_PERCENT` = 320,000. | Verdicts in `workers.json` | Per request | `GET /api/corch/scorecard` | OffloadStatsCard "What works", CliMayteScoreList |
| P7 | `usage-service.ts`, `usage-api.ts`, `usage-refresh.ts`, `usage-live.ts` | Quota percentages: 5 h (`session`), `weekAll`, `weekModel`, extra usage, resets. Live readings come from the CLI stream. | `DATA_DIR/usage-cache.json` (46 KB), `usage-last-known.json`, `usage-history.json` (2.2 MB, ≤500 samples per key), `cli-instances.json` `lastUsageCheck` | Background sweep every 30 min. Forced checks on request. Live overlay. | `GET /api/usage`, `/api/usage/cache`, `/api/usage/survey`, `/api/{instances,cli-instances,codex-instances}/:id/usage` | useUsage, the instances tables, UsageBadge, PooledUsageGauges, QuickInstancesApp |
| P8 | `fleet-usage.ts` | Bands each cached reading at 80/85/90 % | none (pure) | Per request | `usage` field of `GET /api/fleet` | Fleet monitor, desktop landing |
| P9 | `usage-history.ts`, `usage-budget.ts` | Burn rate %/h and forecast. The budget turns `tokensSince(6 h)` into tokens per % and remaining turns. | `usage-history.json` | Per request | `GET /api/usage/budget` | MCP `usage_budget` |
| P10 | `quota-calibration.ts` | $ per quota % (Theil-Sen fit), from `forEachTurnSince` priced per turn | `DATA_DIR/quota-calibration.json` | Per budget request, looking back at most 7 days | via `/api/usage/budget` | MCP |
| P11 | `claude-app-usage.ts` | claude.ai reset grants, Code credit, usage credits | Merged into the usage cache | With a usage check | via `/api/usage*` | UsageBadge |
| P12 | `reset-watch.ts` | Window reset events | `DATA_DIR/reset-watch.json` | Timer | `GET /api/notifications/events` | notifications |
| P13 | `hswarm-cost.ts` (was `zswarm-cost.ts`) | Sums `~/.hswarm/ledger.jsonl` cost by day/model. `deepseekBalance`. | memory | Per request | `deepseekBalance` in `/api/usage/survey` | **`summarizeHSwarmCost` has no caller (dead)** |
| P14 | HSwarm `ledger.py` + `jobs.py` | One line per worker task: model, provider, backend, status, calls, `in_hit/in_miss/out/reasoning` (+`in_write`), `cost_usd` (billed), seconds, caller instance/session/cwd/model. **No account field.** | `~/.hswarm/ledger.jsonl` (143 MB, starts 2026-09-15) | Append when a task finishes | `GET /api/hswarm/api/usage` (`ledger.daily`, a cached tail reader) | HSwarmOverview |
| P15 | HSwarm `model_stats.py` | Per model: tasks, ok, failed, cost, seconds, tokens, success rate, cost per ok, 1-day edit survival | reads `ledger.jsonl` + `survival.jsonl` (0.9 MB) | Per request, cached on file (size, mtime) | `GET /api/hswarm/api/model-stats` | HSwarmModelResults |
| P16 | HSwarm `utilization.py` | One row per job or ask: tasks, ok, failed, `worker_usd`, `worker_tokens`, counterfactual `est_usd`/`saved_usd`, caller account (hashed). Also `claude_days` and `claude_accounts` (Claude $ and tokens per machine and day). | `~/.hswarm/hswarm.sqlite` (25.7 MB): `utilizations` 51,841, `claude_days` 77, `claude_accounts` 568, `profiles` 36. Sync shards on a git branch. | Append on job end. Claude days are written by the savings record. | via `/api/hswarm/api/stats` | — |
| P17 | HSwarm `savings.py` + `claude_usage.py` | **A second Claude transcript scanner and pricer** (global `requestId` dedupe, local-day buckets), the median sub-agent profile, and the day savings range | `~/.hswarm/savings-daily.jsonl` (7.2 MB) | Daily scheduled `hswarm savings --record`. Today is scanned live. | MCP `hswarm_savings`, CLI | via stats |
| P18 | HSwarm `stats.py` | Aggregates P16: total, plan rates, by machine, days, accounts, rule check, recent, today | reads `hswarm.sqlite` | Per request, cached 120 s | `GET /api/hswarm/api/stats` (TS proxy `app.all('/api/hswarm/*')`, `routes/hswarm.ts:138`) | SwarmStatsCard, OffloadStatsCard tiles, HSwarmSavings, InstancesHomeView accounts table |

**Not producers** (checked):

- `compaction-history.ts` is a text search; it produces no numbers.
- `context-size.ts` is referenced only by its own test, so it is dead in production.
- `rate-limit-*.ts` classifies limit stops.
- `extra-usage.ts` is a guard that kills sessions; it records nothing.
- `fleetstats.py` sends anonymous pings and stores nothing locally.
- `session-keepalive.ts` reads the CLI's `total_cost_usd` for keepalive notes only.

### 1.3 Price tables (four)

| Table | Shape | Cache pricing |
|---|---|---|
| `server/src/pricing.ts` `PRICES` + LiteLLM catalog | exact canonical id, then `provider/model` | five absolute rates (derived or stated) |
| `hswarm/claude_usage.py` `PRICES` (:30) | model-id **prefix**, first match wins; `(in, out, read_multiplier)` | read = multiplier × input; writes hard-coded 1.25× and 2× |
| `hswarm/providers/*.toml` `price = {hit, miss, out, write?}` (+ OpenRouter catalogue) | exact name and aliases | one write rate, no 1 h; DeepSeek `peak` halves off-peak |
| `hswarm/accounts.py` `TIER_USD_MONTH` | plan $ per month | n/a (plan weighting) |

---

## 2. Consumers (web/src)

The UI has three fetch layers: the daemon client `j()` (`web/src/lib/api.ts:183`), the HSwarm client
`apiCall()` (`lib/hswarm-api.ts:23`), and a separate raw fetch in `lib/swarm-stats.ts:47`. **No
component prices anything on the client.** Every dollar figure comes from the server.

| UI part | Shows | Routes | Client-side maths | Refresh |
|---|---|---|---|---|
| `AnalyticsView.vue` (+ charts TimeBars, CalendarGrid, HourGrid, TokenSplit, AreaLine, BarRows, EditsFeed, CommandCorrections) | Total $ or tokens, token split, by provider/model/project/account/day, sinks, calendar, hours, concurrency, tools, edit survival, edits | `/api/analytics/{spend,activity,concurrency,edits,sinks,corrections}`, `/api/agent-tools` | vendor filter, day→month sums | on load and on period change |
| `SwarmStatsCard.vue` (in AnalyticsView and InstancesHomeView) | Saved today / 7 d / all time, tasks, tokens kept, 14-day sparkline | `/api/hswarm/api/stats?days=14` (shared poll) | sum of the last 7 days | 120 s |
| `SessionsView.vue` header chip (`useSessionUsage`) | Session tokens and $ | `/api/sessions/:id/usage` | formatting | on selection |
| `CliMayteView.vue` → `OffloadStatsCard.vue`, `CliMayteScoreList.vue` | CliMayte tasks, sessions, tokens, $; HSwarm tiles; per-model pass/fail | `/api/corch/totals`, `/api/corch/scorecard`, `/api/corch/workers`, stats poll | `tokenTotal`, per-model regroup of the scorecard | 3 s active, 15 s idle |
| `CliMayteWorkerDetail.vue`, `CliMayteJournal.vue` | Per-worker tokens and $, per-event cost | `/api/corch/workers/:id`, `/api/corch/journal` | `tokenTotal` | 10 s (group) |
| `InstancesHomeView.vue` | Pooled quota, CliMayte tokens tile, sessions per hour, model split, headroom, SwarmStatsCard, HSwarm accounts table | `/api/instances`, `/api/cli-instances`, `/api/usage/cache`, `/api/corch/totals`, `/api/corch/workers`, `/api/sessions?period=24h`, stats poll, `/api/hswarm-accounts` | inline token sum, **`est_usd - worker_usd` per account**, its own reset rule | 20 s |
| `HSwarmOverview.vue` | Tokens first, $ as value at list price (since `8270c97e`); spend by day; error rate; money by provider | `/api/hswarm/api/usage?days=14`, `clients` | **sums cost and tasks across days, per-provider sums** | on load |
| `HSwarmModelResults.vue` | Per-model outcomes, cost per ok, survival, daily stack | `/api/hswarm/api/model-stats` | per-day totals | on load |
| `HSwarmSavings.vue` | Saved, tokens, share, cheaper-by ×, machines, accounts, days, recent; list vs plan toggle | `/api/hswarm/api/stats` (**its own fetch, not the shared poll**), `/api/hswarm-accounts` | est/worker ratio | on load |
| `HSwarmJobs.vue`, `HSwarmTools.vue`, `HSwarmRouting.vue`, `HSwarmModels.vue` | Per-job, per-ask and benchmark cost | `jobs`, `job`, `ask`, `select`, `state` | none | on load |
| Instances tables: `InstancesView.vue`, `CliInstancesSection.vue`, `CodexInstanceRows.vue` + `UsageBadge`, `UsageBar` | 5 h / week %, reset countdowns, credits; CLI Tokens column | `/api/usage/cache` (useUsage), `/api/cli-instances`, forced `/api/*/usage` | `usagePctFor` (superseded-window rule) | 4 s hydrate, 5 s list |
| `PooledUsageGauges.vue` | Pooled 5 h / week quota left, weighted by plan size | (useUsage) | `pooledRemaining` | with the tables |
| `QuickInstancesApp.vue` | Usage chips | its **own** `/api/usage/cache` poll | different snapshot precedence from useUsage | 10 s |

---

## 3. Duplicates and where they disagree

### 3.1 Duplicated facts in code

| Fact | Computed in |
|---|---|
| Tokens parsed out of a Claude transcript | **six** places: `usage-tokens.ts` (main); `cli-instance-tokens.ts` (own parser, `message.id`-only dedupe, no 5m/1h, no per-model split); `climayte-lib.ts` `firstRequest` and `contextTokens`; `context-size.ts` (dead); `hswarm/claude_usage.py` (with native variants under `hswarm/native/`). The dedupe scope also differs: per process, per session or per file. |
| Per-session cost | P1 (stored, includes subagents), P3 (on demand, **no subagents**), P5 (per attempt) |
| Tokens per account | P1 `byAccount` (only sessions this daemon queued; **empty on this PC**), P4 (per CLI config dir), `session_stats.instance` (desktop label), P5 (per attempt account), P16 `caller_account` (hashed). These are four notions of "account" and nothing joins them. |
| Per-model split | P1 `byModel`, P3, P6 (model × effort), P15, P17 `by_model` / `claude_by_family`, P13 (dead) |
| Worker (HSwarm) spend | P14 `ledger.daily`, P15, P16 `worker_usd`, and the UI sums in HSwarmOverview |
| Prices | `pricing.ts`, `claude_usage.py`, provider TOMLs (§1.3) |
| Quota % thresholds and window resets | `fleet-usage.ts` 80/85/90, `extra-usage.ts` 98/99, `cli-reset-sweep.ts` 90; three web reset rules (`isWindowSuperseded` with a 2 min grace, `msUntilReset <= 0`, `resetsAt <= now`) |
| "Weighted units" → % | `weighCounts` with three different scales: P6's fixed 320k per %, P9 calibrated live, P10 $ per % |

### 3.2 Disagreements measured on real data (2026-10-03)

**A. Claude $ per day: Analytics tab (TS) vs HSwarm's own scanner (Python), same PC.**

Compared over 28 complete days (2026-09-05 → 10-02), the daemon's `/api/analytics/spend` `byDay`
against `hswarm.sqlite` `claude_days` for this machine:

| | Analytics (TS) | HSwarm (Python) | Gap |
|---|---|---|---|
| Tokens | 276.6 B | 264.4 B | TS +4.6 % |
| List-price $ | **$136,591** | **$162,375** | Python **+18.9 %** |

- **Before 09-22, Python is lower.** Example, 09-15: TS $6,554, Python $5,913.
- **From 09-22, Python is ~45–95 % higher.** Example, 09-24: TS $9,225, Python $13,191. Example,
  09-28: TS $4,022, Python $7,846.

The cause is pricing. On `claude-opus-5-5`, Python charges **$0.662 per million tokens** and TS
**$0.366**: 81 % more for the same token mix. Python has no `opus-5-5` row, so its prefix match
falls to `claude-opus-5` ($5/$25, cache read 0.1× = $0.50), while TS uses $4/$20 with $0.20 cache
reads.

The ~4.6 % token gap has two parts. TS adds Codex, OpenCode and DSH turns. The two sides also
dedupe differently and cut days at different boundaries.

The running HSwarm price/cache-math worker should close the dollar gap. The token gap stays until
there is one parser.

**B. The Analytics tab does not count CLI accounts at all.**

- The CLI table's Tokens column (P4) sums **5.97 B tokens** (all time) across **38 of 42** CLI
  instances.
- Of the **1,851** top-level transcripts in those instances' `projects/` folders, **0** appear in
  `session_stats` or `session_scan_cache`.
- So everything CliMayte and the CLI accounts burn is missing from the Analytics tab's totals,
  by-model and by-day figures.
- CliMayte's own totals (P5) report **1,078 tasks, 1,562 CLI sessions, 5.43 B tokens, $2,639.47**
  over the same history. That is a subset of the 5.97 B, which is consistent.

**C. HSwarm worker spend, two answers from the same ledger, same PC.**

The ledger starts 2026-09-15, so both routes cover the whole history:

| Route | Tasks | $ |
|---|---|---|
| `model-stats?days=30` (ledger) | 233,253 | $6,165.52 |
| `stats` → `by_machine` for this PC (`utilizations` table) | 233,787 | $5,971.36 |

They differ by 534 tasks and $194. The likely causes are that the `utilizations` rows come from job
records and backfill while model-stats skips cached lines, and that a job's whole cost is attributed
to its most common model.

**D. "Saved" depends on which view you open.**

- `stats` total: **saved $236,437** at list price.
- The same response's plan view: **saved −$5,659**. Plan-weighted Claude value is $1,609 against
  $7,268 of real worker spend.
- SwarmStatsCard and the CliMayte card show the first figure. HSwarmSavings has a toggle between
  the two. InstancesHomeView computes `est_usd − worker_usd` itself.

**E. Account attribution.** `/api/analytics/spend` returns `byAccount: []` on this PC, while the
CLI table, CliMayte peaks and HSwarm's accounts table each show per-account numbers from their own
sources.

---

## 4. Design: the toolkit

### 4.1 Principles

- **One record per model call**, written once by one writer, priced once at ingest with a recorded
  price version. Re-pricing is an explicit rebuild, never a side effect.
- **Every reader is a query.** No UI part and no report keeps its own parser, price table or
  running total.
- **Sources keep their own truth files.** Claude transcripts, `ledger.jsonl` and Codex rollouts are
  the evidence. The toolkit is an index over them and can always be dropped and rebuilt from them.

### 4.2 Record model: `usage_event`

One row per model call (one Claude assistant message id, one Codex turn, one HSwarm worker call or
task line).

| Column | Meaning |
|---|---|
| `id` | Dedupe key: `source:` + `message.id\|requestId` (Claude), rollout id + turn (Codex), `job/task/attempt` (HSwarm). `INSERT OR REPLACE` keeps the last-written usage, matching `accumulateUsageLine`. |
| `ts` | Call time (epoch ms). Day and hour buckets derive from it in the query, using the asker's time zone. |
| `pc` | Machine id (hostname hash, same scheme as HSwarm's `machine`) |
| `account` | `acct-<sha256(account uuid)[:8]>`, the id HSwarm already uses (`routes/hswarm.ts` `hswarmAccountId`). `NULL` when unknown. The UI maps it to a label through the existing `/api/hswarm-accounts` logic, moved into the toolkit. |
| `instance` | `desktop:<dir>`, `cli:<id>`, `codex:<id>` or `default` (`~/.claude`) |
| `session` | CLI/desktop session id; for HSwarm, the caller session |
| `agent` | `main` or `subagent` (+ subagent type when known) |
| `source` | `cli`, `desktop`, `climayte`, `hswarm`, `codex`, `opencode`, `dsh`, `hermes`. `climayte` is a CLI call inside a CliMayte attempt. `hswarm` is a worker call. |
| `model`, `provider` | Canonical model id (`pricing.ts` canonicalisation) and provider name |
| `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `reasoning` | Tokens by kind (HSwarm maps `in_miss`→input, `in_hit`→cache_read, `in_write`→cache_write_5m) |
| `list_usd` | Value at list price from the shared table (§4.5); `NULL` when unpriced |
| `billed_usd` | What a provider actually charged (HSwarm `cost_usd`, OpenCode). `NULL` for subscription calls. |
| `price_ver` | Price table version used for `list_usd` |
| `weighted` | `weighCounts` units, so quota maths reads the same row |
| `ok`, `seconds` | Worker outcome and duration (HSwarm). `NULL` elsewhere. |
| `ref` | Optional join keys: CliMayte attempt id, HSwarm job/task, queue item id |

Size estimate: this PC made about 0.78 M Claude turns in 30 days and about 0.23 M HSwarm tasks, so
roughly 12 M rows a year. Raw rows are kept for **35 days**, longer than any weekly window plus a
margin. An **hourly rollup** `usage_hour` (same dimensions minus `session`/`ref`, summed measures)
is kept forever. A per-session ledger `usage_session` (keyed by session, ref and the other
dimensions, with first/last timestamps and the same measures) is kept forever too, so a session's or a
CliMayte attempt's total survives raw pruning. Events older than the last prune's cut are not taken
again, so a source re-read from byte 0 cannot double either rollup. All are a few hundred MB a year at most.

### 4.3 Store

- A separate SQLite file, **`DATA_DIR/analytics.db`** (WAL), owned by the daemon.
- It is separate from `agenthydra.db` so a rebuild or drop cannot touch operational tables, and
  ingest writes do not contend with the queue.
- Tables:
  - `usage_event`, indexed on (`ts`), (`account`, `ts`) and (`instance`, `ts`);
  - `usage_hour`;
  - `ingest_cursor` (per source file: path, size, mtime, byte offset, version);
  - `meta` (price version, schema version).
- **Single writer:** the TS daemon.
  - HSwarm does not write the toolkit. The daemon tails `~/.hswarm/ledger.jsonl` by offset, the
    same way `import-zswarm` does.
  - HSwarm keeps running standalone on PCs without the daemon.
- **Session-level facts stay where they are for now.** Tools, edits, sinks, hour-of-week, edit
  survival and corrections are per-session analysis, not per-call usage. `session_scan_cache` keeps
  them. The toolkit owns tokens, $, counts, outcomes and windows.

**Assumption (STORAGE-PLAN).** `docs/STORAGE-PLAN.md` had not landed when this was written (checked
`origin/main` at `8270c97e`). This plan assumes:

1. per-PC SQLite under `DATA_DIR`;
2. cross-PC sync as per-PC export shards (HSwarm's `sync-tree/<machine>.jsonl` pattern), never a
   shared live database;
3. append-only source files stay the evidence.

Where STORAGE-PLAN recommends otherwise (file location, retention, sync transport), it wins. Pieces
4 and 17 are the only ones that change.

### 4.4 Query API

One function in TS, one route, one MCP tool:

```ts
usageQuery({
  window: { from?, to? } | { last: '5h'|'24h'|'7d'|'30d' } | { account: 'acct-…', kind: '5h'|'week' },
  filter?: { account?, instance?, pc?, source?, model?, provider?, session?, agent?, ok? },  // each value or list
  groupBy?: ('day'|'hour'|'account'|'instance'|'pc'|'source'|'model'|'provider'|'session')[],
  measures?: ('tokens'|'list_usd'|'billed_usd'|'weighted'|'calls'|'ok'|'failed'|'seconds')[],
  tz?: string,
}) => { rows, totals, unpriced: string[], priceVer, coverage }
```

- Route: `GET /api/kit/usage?…` with the same fields as query parameters.
- MCP: `usage_query` replaces `get_spend` and wraps the same function.
- **Account windows.** `{account, kind:'5h'|'week'}` resolves to `[resetsAt − 5h, now]` or
  `[resetsAt − 7d, now]`. It uses that account's latest quota snapshot (P7 `session.resetsAt` /
  `weekAll.resetsAt`) and falls back to a rolling window when there is no snapshot. This one
  resolver replaces the three web reset rules: the server returns the resolved window with each
  answer.
- Queries inside the raw retention period read `usage_event`. Older ones read `usage_hour`.
- `coverage` reports which sources have been ingested up to when, so a UI can say a figure is
  partial instead of silently being low.

### 4.5 One price table for TypeScript and Python

- **File:** `hswarm/data/prices.json`.
  - It lives in the HSwarm package because that package is installed standalone (its
    `pyproject.toml` ships only `hswarm/`).
  - TypeScript imports it at build time (`server/src/pricing.ts`; `bun build --compile` bundles a
    JSON import).
- **Shape:** the superset of today's tables, so the TS model wins:
  - per model, absolute `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`
    (optional; derived 0.1/1.25/2× when absent);
  - `intro {until}`, `offpeak {multiplier, utc_hours}` for DeepSeek, `aliases`, `verified_at`;
  - a top-level `as_of` and `version`.
- **TS:** keeps the LiteLLM catalog overlay and exact-then-fallback lookup.
- **Python:**
  - `claude_usage.price_tokens` and `config.cost_usd` read the same file through one helper,
    `hswarm/prices.py`;
  - exact lookup with aliases replaces prefix matching (the opus-5-5 bug in §3.2 A);
  - provider TOMLs keep only routing data, plus prices for models not in the file (OpenRouter
    catalogue entries).
- **Parity test:** one fixture of token mixes priced by both languages must agree to the cent. It
  runs in both test suites.
- **Coordination:** the worker correcting HSwarm's cache pricing is fixing the Python math now.
  Piece 1 starts from its corrected numbers and moves them into the file, not the other way round.

### 4.6 Ingest

| Source | Reader | Attribution |
|---|---|---|
| Claude transcripts: `~/.claude`, every desktop instance dir, **every CLI instance config dir** | Incremental tail by byte offset per file (`ingest_cursor`), parsed by `accumulateUsageLine` only. Subagent files included. | `instance` from the config dir. `account` from the dir's current login (the existing login history maps dir + time → account uuid). `source=climayte` when the session id belongs to a CliMayte attempt (`workers.json`); `desktop` for desktop dirs; `cli` otherwise. |
| Codex, OpenCode, DSH, Hermes | `usage-foreign.ts` readers | `codex:<id>` instances. OpenCode's own cost goes to `billed_usd`. |
| HSwarm | Tail of `ledger.jsonl` | `source=hswarm`. `account` from a new `caller_account` field on ledger lines (HSwarm already computes it for `utilizations`). Caller session and instance are kept. |

Sweep cadence: on boot, then every 60 s plus a filesystem-change nudge. It is cheap because only
appended bytes are read: P4's first full sweep read about 600 MB in 1.3 s.

### 4.7 How each UI part maps onto the toolkit

| UI part | Today | On the toolkit |
|---|---|---|
| CLI / desktop instance tables: token columns, **5 h / week / total per account** | P4 all-time only | `usageQuery({window:{account,kind}}, groupBy:['account'])` + `last:'all'` **(first consumer, piece 9)** |
| AnalyticsView spend: total, by provider/model/project/day/account, unpriced | P1 `spendReport` | `groupBy` day/model/provider/account; project via `session` → cwd join |
| AnalyticsView activity, sinks, edits, concurrency | P1 | unchanged (session-level); concurrency may later count `usage_event` per bucket |
| SessionsView chip | P3 | `filter:{session}` (now including subagents) |
| `getRunCost` / `/api/queue/:id/cost` | P3 `runCost` | `filter:{session}` + time window |
| CliMayte totals tokens / $ / sessions | P5 `attemptSpend` | `filter:{source:'climayte'}` grouped by `ref` (attempt). Outcome counts, peaks and sizing stay in CliMayte; they are task facts. |
| CliMayte scorecard units | P6 | `weighted` from the kit per attempt; the pass/fail data stays in CliMayte |
| OffloadStatsCard, SwarmStatsCard, InstancesHomeView tiles | P5 + P18 | one `useKit()` web poll over `/api/kit/usage` + the savings endpoint |
| HSwarmOverview spend by day / provider, task counts | P14 + client sums | `filter:{source:'hswarm'}`, groupBy day / provider, measures `billed_usd`, `calls`, `failed` |
| HSwarmModelResults | P15 | `filter:{source:'hswarm'}` groupBy model; `ok`, `seconds`, `billed_usd`; survival stays in `survival.jsonl` |
| HSwarmSavings | P16–P18 | Savings stays an HSwarm calculation (counterfactual profile). Its **Claude side** (`claude_usd`, `claude_tokens` per day) comes from the kit, not `claude_usage.py`, when the daemon is reachable. |
| Quota budget, calibration | P9, P10 | `tokensSince` / `forEachTurnSince` → `usageQuery` |
| MCP `get_spend`, `get_run_cost` | P1, P3 | `usage_query` |
| Quota % displays (badges, pooled gauges, fleet bands) | P7, P8 | unchanged readings; the window resolver and thresholds move to one shared module (piece 16) |

---

## 5. Build pieces

Each piece fits one session and lands on its own. The order is dependency order. Proofs assume the
repo root.

1. **Shared price file.**
   - Files: `hswarm/data/prices.json` (new), `server/src/pricing.ts`.
   - Generate the file from today's `PRICES` plus the cache-pricing worker's corrections. `pricing.ts`
     imports it instead of its inline table. Catalog overlay unchanged.
   - Done: TS prices unchanged except where the cache worker corrected them.
   - Proof: `bun test server/tests/pricing.test.ts` green, and `/api/analytics/spend` total unchanged
     ±0.1 % after restart.

2. **Python reads the shared file.**
   - Files: `hswarm/prices.py` (new), `hswarm/claude_usage.py`, `hswarm/config.py`,
     `hswarm/providers/anthropic.toml`, `deepseek.toml`.
   - Exact lookup + aliases + off-peak replace prefix matching.
   - Add one parity fixture used by both `server/tests/pricing-parity.test.ts` and
     `hswarm/tests/test_prices.py`.
   - Done: both suites agree to the cent; opus-5-5 prices at $4/$20/$0.20.
   - Proof: `python -m pytest hswarm/tests/test_prices.py` and
     `bun test server/tests/pricing-parity.test.ts`.

3. **One transcript parser.**
   - Files: `server/src/core/cli-instance-tokens.ts`, `server/src/climayte-lib.ts` (`firstRequest`,
     `contextTokens`), delete `server/src/context-size.ts` + its test (dead), delete
     `summarizeHSwarmCost` in `hswarm-cost.ts` (dead).
   - Every caller goes through `usage-tokens.ts`.
   - Done: `rg "cache_read_input_tokens" server/src` hits only `usage-tokens.ts` (and `usage-foreign.ts`).
   - Proof: that `rg`, plus `bun test server/tests/cli-instance-tokens.test.ts
     server/tests/climayte*.test.ts`.

4. **Toolkit store.**
   - Files: `server/src/kit/store.ts` (new), `server/src/kit/schema.ts`.
   - `DATA_DIR/analytics.db` with the `usage_event`, `usage_hour`, `ingest_cursor` and `meta` tables,
     upsert, the rollup job, 35-day raw pruning, drop/rebuild.
   - Done: a unit test inserts duplicate ids (last write wins) and rolls up and prunes correctly.
   - Proof: `bun test server/tests/kit-store.test.ts`.

5. **Ingest Claude transcripts.**
   - Files: `server/src/kit/ingest-claude.ts` (new), boot hook in `server/src/index.ts`.
   - Every config dir (default, desktop instances, CLI instances), offset tailing, account /
     instance / source attribution (§4.6).
   - Done: the kit's 30-day Claude total on this PC equals P1 plus P4's CLI share within 1 %.
   - Proof: `curl "localhost:7787/api/kit/usage?last=30d&groupBy=source"` (needs piece 7) or the
     test `kit-ingest-claude.test.ts` on fixture transcripts.

6. **Ingest Codex, OpenCode, DSH, Hermes.**
   - Files: `server/src/kit/ingest-foreign.ts` (reuses `usage-foreign.ts`).
   - Done: per-provider totals match P1 `byProvider` for codex/opencode/dsh within 1 %.
   - Proof: `bun test server/tests/kit-ingest-foreign.test.ts`.

7. **Query API, route and MCP tool.**
   - Files: `server/src/kit/query.ts`, `server/src/routes/kit.ts`, `server/src/mcp-session-tools.ts`
     (`usage_query`).
   - Filters, group-bys and measures (§4.4), account 5h/week resolver from P7 snapshots, `coverage`.
   - Done: tests cover every filter and both window kinds.
   - Proof: `bun test server/tests/kit-query.test.ts`, then
     `curl "localhost:7787/api/kit/usage?last=7d&groupBy=day,source"` after the owner's deploy.

8. **Reconcile endpoint (temporary).**
   - Files: `server/src/kit/reconcile.ts`, `GET /api/kit/reconcile`.
   - Prints kit vs P1 / P4 / P5 / P15 totals side by side for the same window. It is the safety net
     for every migration piece below. Removed in piece 18.
   - Proof: `curl localhost:7787/api/kit/reconcile?last=7d` shows each pair and its % gap.

9. **First consumer: per-account token windows in the instance tables.**
   - Files: `server/src/routes/usage.ts` (`/api/cli-instances`, `/api/instances` add
     `tokens: {h5, week, total}` from the kit), `server/src/core/cli-instance-tokens.ts` (retired),
     `web/src/components/CliInstancesSection.vue`, `InstancesView.vue`, `CodexInstanceRows.vue`.
   - **Fold in the parallel token-windows worker.** Its commit had not reached `origin/main` at
     `8270c97e`. If it has landed when this piece starts, keep its UI and response shape and swap
     only its data source for `usageQuery`. If it has not, build to the same shape.
   - Done: each row shows 5 h / week / total; desktop rows too.
   - Proof: a new `server/tests/kit-account-windows.test.ts`, `bun run --cwd web typecheck`.

10. **HSwarm ledger ingest + `caller_account`.**
    - Files: `hswarm/caller.py` / `hswarm/jobs.py` (write `caller_account` on ledger lines),
      `server/src/kit/ingest-hswarm.ts`.
    - Done: kit `source=hswarm` 30-day calls and `billed_usd` equal `model-stats?days=30` (today:
      233,253 tasks, $6,165.52) exactly.
    - Proof: `/api/kit/reconcile?last=30d` hswarm row shows 0 % gap.

11. **Analytics tab spend onto the kit.**
    - Files: `server/src/analytics.ts` (`spendReport` reads `usageQuery`; `windowShare` scaling
      removed), `server/src/routes/analytics.ts`, `web/src/components/AnalyticsView.vue` (adds a
      source filter: cli / desktop / climayte / hswarm / codex).
    - Done: totals now include CLI accounts (§3.2 B); `byAccount` is populated.
    - Proof: `bun test server/tests/analytics*.test.ts`, `bun run --cwd web typecheck`, reconcile.

12. **Session chip and run cost onto the kit.**
    - Files: `server/src/session-usage.ts` (thin wrapper or removed), `routes/sessions.ts`,
      `routes/queue.ts`.
    - Done: the chip includes subagent spend; `GET /api/queue/:id/cost` answers from the kit.
    - Proof: `bun test server/tests/session-usage.test.ts`.

13. **CliMayte totals and scorecard units onto the kit.**
    - Files: `server/src/climayte-lib.ts` (`attemptSpend` → kit query by session + attempt window),
      `climayte-core.ts`, `climayte-totals.ts`, `climayte-scorecard.ts`.
    - Outcome counts, peaks and sizing stay where they are.
    - Done: `/api/corch/totals` tokens and $ within 1 % of today's (5.43 B, $2,639.47, before price
      corrections).
    - Proof: `bun test server/tests/climayte.test.ts server/tests/climayte-scorecard.test.ts` (`climayteTotals` is tested in `climayte.test.ts`).

14. **Quota budget and calibration onto the kit.**
    - Files: `server/src/usage-budget.ts`, `server/src/quota-calibration.ts`; drop `tokensSince` /
      `forEachTurnSince` from `usage-tokens.ts` once unused.
    - Proof: `bun test server/tests/usage-budget.test.ts server/tests/quota-calibration.test.ts`.

15. **HSwarm views onto the kit.**
    - Files: `web/src/components/hswarm/HSwarmOverview.vue`, `HSwarmModelResults.vue` (read
      `/api/kit/usage?source=hswarm`; the client-side sums go away), `hswarm/savings.py` (Claude day
      totals from `GET /api/kit/usage?source=cli,desktop,climayte&groupBy=day,model&pc=self` when
      `AGENTHYDRA_URL` answers, its own scan otherwise).
    - Done: Overview and Model results match the old figures for the same window; HSwarm's
      `claude_usd` equals the Analytics tab's.
    - Proof: `bun run --cwd web typecheck`, `python -m pytest hswarm/tests/test_savings.py`,
      reconcile.

16. **One web analytics layer.**
    - Files: `web/src/lib/kit.ts` (new: one fetch through `j()`, a shared ref-counted poll per query,
      one USD/token formatter set), `lib/swarm-stats.ts`, `lib/hswarm-api.ts` (`fetchStats` uses the
      shared poll), `HSwarmSavings.vue`, `InstancesHomeView.vue` (no own `est − worker` or token sums),
      `OffloadStatsCard.vue`, `QuickInstancesApp.vue` (uses `useUsage`), and one window/reset rule in
      `lib/usage.ts` used by `usage-pool.ts` and `home-charts.ts`.
    - Done: `rg "toFixed\(2\)|formatUSD|formatCost|formatMoney" web/src/components` hits nothing
      money-related; one stats fetch per window.
    - Proof: that `rg`, `bun run --cwd web typecheck`, `bun test web`.

17. **Cross-PC.**
    - Files: `server/src/kit/sync.ts`.
    - Export `usage_hour` as a per-PC shard; import other PCs' shards as rows with their `pc`.
      Transport and location per `docs/STORAGE-PLAN.md`.
    - Done: the Analytics tab can show all PCs or this PC; HSwarm's `by_machine` Claude side reads
      the kit.
    - Proof: `bun test server/tests/kit-sync.test.ts`.

18. **Retire the old producers.**
    - Remove:
      - `session_stats` token/cost columns from reports (the table stays for history until the kit
        has backfilled it);
      - P4 code;
      - `claude_usage.py` pricing (scanner kept only for standalone HSwarm);
      - `/api/kit/reconcile` (done: route, `kit/reconcile.ts`, `kit/reconcile-old.ts` and their test removed).
    - Update `docs/REFERENCE.md`, the routes list, and the MCP tool docs (done: REFERENCE.md documents every
      `/api/kit/*` route, including `POST /api/kit/sync`).
    - Done: `rg "priceTokens\(" server/src` hits only `kit/`.
    - Proof: that `rg`, `bun run typecheck`, `bun test`.

**Order and parallelism:**

- Pieces 1 → 2 and 3 → 4 → 5 → 7 are the spine.
- 6, 8 and 10 can run beside 7.
- 9 to 15 each need only 7 (10 also feeds 15), so they can go in parallel once 7 lands.
- 16 follows 15.
- 17 waits for STORAGE-PLAN.
- 18 is last.
