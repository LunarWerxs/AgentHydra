# HydraSwarm (hswarm)

HydraSwarm is AgentHydra's swarm. It began as a copy of ZSwarm and replaced it when ZSwarm was retired (2026-10-03); `hswarm import-zswarm` brings a ZSwarm home's history across.

## What is HydraSwarm?

A cheap worker swarm: hands work from Claude Code, Claude Desktop or Codex to many cheap AI models at once, with a flagship orchestrator (MCP server + CLI, costed against the Claude it displaces).

## Running HydraSwarm

```bash
# Start the console (web UI)
python -m hswarm ui --no-open --port 7793

# Run a command
python -m hswarm ask "your question"

# Check status
python -m hswarm status

# Get help
python -m hswarm help
```

## Configuration

### API Keys

HydraSwarm reads API keys from:

1. Environment variables: `<PROVIDER>_API_KEYS` or `<PROVIDER>_API_KEY`
2. Files in `$HSWARM_HOME/secrets/<provider>_api_keys`

For example:
```bash
export DEEPSEEK_API_KEYS="sk-..."
export OPENROUTER_API_KEYS="sk-..."
```

Or import them from a ZSwarm clone:

```bash
python -m hswarm import-keys --from /path/to/zswarm
```

This copies key files from a ZSwarm clone's `<clone>/.secrets/` into `$HSWARM_HOME/secrets/` and prints only counts (never a key).

### Key vault

Keys follow you between machines, encrypted, never through git. `$HSWARM_HOME/secrets/` holds one list per provider
(`openrouter_api_keys`, plus `.dead` and `.unfunded` lists). The vault is one encrypted file on a server only you can
reach, and every paired machine merges its lists with it every two minutes while `mcp --http` runs. It is ZSwarm's
vault (ported from `zswarm/vault.py`): the same file, merge and pairing code, so an HSwarm and a ZSwarm can share one.

```bash
python -m hswarm vault init ssh://user@host/hswarm-vault   # first machine: makes the vault from the keys it has
python -m hswarm vault adopt                               # this machine's ZSwarm is already paired: use its vault
python -m hswarm vault pair                                # prints the pairing code (a terminal only; hand it over directly)
python -m hswarm vault join                                # other machine: paste the code at the hidden prompt
python -m hswarm vault add openrouter                      # keys from stdin or a hidden prompt; synced at once
python -m hswarm vault remove openrouter <fingerprint>     # a rolled key; every machine drops it at its next sync
python -m hswarm vault list [openrouter]  |  status  |  sync [--dry-run] [--allow-removals] [--rebase]
```

- **What is stored.** AES-256-GCM, a random vault key in `$HSWARM_HOME/vault.key` (owner-only). The server holds
  ciphertext only, so a plain SSH box, a shared folder (`dir:<folder>`) or any other backend is a placement choice,
  not a trust decision.
- **What is synced.** The list files in `$HSWARM_HOME/secrets/` and nothing else; the disabled slot (`keys.json`)
  is each machine's own measurement.
- **How two machines agree.** Each key is one entry: the key, a time and who wrote it, or a tombstone when removed.
  The newer entry wins and a removal wins a tie. A write is compare-and-swap on the file's hash, so a writer that
  lost a race re-reads, merges and retries.
- **Safety.** A machine's first sync only adds. A sync that would remove a quarter of the keys or empty a list stops
  and says so (`--allow-removals`; `--rebase` brings everything back from the vault). A server that went back to an
  older vault is refused. The server keeps the last 40 versions. A failed background sync is logged once and the
  next tick retries.
- **`adopt`.** When `~/.zswarm` (or `ZSWARM_HOME`) holds `vault.key` and `vault.json` and `$HSWARM_HOME` has no
  vault, `adopt` copies those two files here owner-only (only once the key opens the stored vault), then runs a
  first sync, which only adds. `vault status` says when it is available.
- **Output.** Every verb prints counts and 8-character fingerprints. `pair` prints the code only to a terminal: the
  code opens every key, so it goes person to person, never into a chat or a ticket.

### Configuration Directory

Default: `~/.hswarm`

Set `HSWARM_HOME` environment variable to use a different location:

```bash
export HSWARM_HOME=/path/to/config
```

The HSWARM_HOME directory structure:
```
~/.hswarm/
├── settings.toml              # Configuration: roles, pricing, routing
├── providers/                 # Provider configurations (TOML files)
├── secrets/                   # API key files (`hswarm import-keys` fills it)
│   ├── deepseek_api_keys
│   ├── openrouter_api_keys
│   └── ...
├── jobs/                      # Job store (execution history)
├── ledger.jsonl               # Usage ledger (one job per line)
├── routing.jsonl              # Routing decisions (one per line)
├── openrouter-models.json     # Model catalog (auto-generated)
├── history/                   # Archived job data (daily archives)
├── spill/                     # Tool output overflow cache
├── skills/                    # Banked procedures (unreviewed .md files)
├── claude-config/             # Claude Code worker configuration
├── native/                    # This machine's scanner winner and A/B reports (`hswarm native bench`)
└── hswarm.html               # Console view (auto-generated)
```

## Inside AgentHydra

The AgentHydra daemon starts HydraSwarm by default (`python -m hswarm mcp --http --port 7793`), restarts it with backoff if it exits, and proxies its console API at `/api/hswarm/*` for the HSwarm tab. The log is `<AgentHydra data>/logs/hswarm.log`.

- `AGENTHYDRA_HSWARM_ENABLED=0` keeps it off.
- `AGENTHYDRA_HSWARM_DIR` names the folder holding `hswarm/` when it is not beside the app (a wrong folder is reported in the tab, not replaced).
- `AGENTHYDRA_PYTHON` names the interpreter (default `python`, `python3` off Windows).

## Free accounts first

A tool-free task (`tools: none`, no images, no `zdr`, `model` auto, profile `routine`, `general`, `research` or
`decision`, purpose not `evaluation`, at most 100,000 characters) may run on the owner's signed-in Free claude.ai and
ChatGPT accounts through AgentHydra (`free_status`, `free_chat`, `free_results` on `POST /api/mcp`) before any paid API
leg, at no cost. A schema's JSON is parsed and checked as on the API route. The daemon being down, no idle account, a
failed, slow or unparseable reply keeps the API route. `selection.route` shows it (`via: free`), the ledger line says
provider `free`. Settings: `route_via_free` (default on), `route_via_free_max` (default 6), `route_via_free_profiles`.

## One tool with CliMayte

Before an agentic task runs, HSwarm asks AgentHydra (`POST /api/routing/decide`, at `AGENTHYDRA_URL`, default
`http://127.0.0.1:7787`) whether the owner's Claude subscription is the cheaper route. The task is asked about when it
has an absolute `cwd`, tools `read`, `edit` or `all`, no `writable` globs, receipts, scripted diff or runtime, and is
not already inside a CliMayte worker (`AGENTHYDRA_CLIMAYTE_WORKER`). On `subscription` it runs as a CliMayte worker
(kind `code` for edit/all, else `review`), polled every 10 s up to the task's `timeout_s`; the worker's report is the
answer. No answer within 2 s, any error, or a failed or cancelled worker keeps the API route (a failed worker falls back
once). The route and the decision's reason are in the result's `selection.route`; the ledger line says provider
`climayte`.

The decision is AgentHydra's cost model (`docs/COST-MODEL.md`), changed on Hydra Desk 2's Routing page (AgentHydra
pane, HSwarm tab, Routing) or with `PUT /api/routing/settings`. AgentHydra's routing switch is the main one;
`route_via_climayte = false` in `settings.toml` (default on) is a local opt-out on this machine. Two more settings
bound it: `route_via_climayte_max` (default 4) caps the routed tasks running at once, and `route_via_climayte_start_s`
(default 90) cancels a routed worker that has not started and falls back to the API. A CliMayte worker's own calls
are never routed (header `x-hswarm-climayte-worker`). The plan prices behind the monthly cost figures are read from
AgentHydra's Routing page when it answers (2 s timeout, cached a few minutes); the built-in list prices and
`~/.hswarm/plan.json` are the offline fallback and the override.

## Isolation

- All state is isolated under `HSWARM_HOME` (default `~/.hswarm`)
- Console runs on port 7793 (`--port` or `HSWARM_PORT` to change)
- All environment variables use the `HSWARM_*` prefix
- Keys come from env vars or `HSWARM_HOME/secrets`; nothing is shared with any other install unless you pair a key vault (`hswarm vault`, above)

## Worker safety

These match ZSwarm (ported 2026-10-03; ideas from CopilotKit's OpenBot and OpenTag, MIT, no code copied).

- **Key files never reach a worker.** Every path tool refuses `HSWARM_HOME/secrets`, `HSWARM_HOME/providers` and
  any `.secrets` folder, and the walking tools skip them silently; the shell
  policy refuses a command naming one of them or a `*_api_keys` / `*_api_key` file; and every tool result has any
  token equal to a key this process holds replaced by `[hswarm key withheld]`, redaction on or off. No grant,
  capability or preset lifts it (`tools.is_key_path`, `shellpolicy._secrets_access`, `redaction.scrub_keys`).
- **A web fetch connects only to the address its check accepted.** `read_url` resolves a host and refuses a
  private answer; the connection is then pinned to those addresses, so a name that answers differently the
  second time (DNS rebinding to 127.0.0.1 or a cloud metadata address) is never reached (`web.PinnedBackend`).
- **A tool-free `cc` worker gets no built-in tools** (`--tools ""`, Read only when the task attaches files), with
  the read-only denylist kept as a belt.
- **Every worker and ask is told today's UTC date as authoritative**, right after the safety charter
  (`guard.current_date_line`).

## Routing and memory (ported 2026-10-03)

- **AUTO may pick Claude Sonnet; Haiku stays barred.** The Haiku family is rejected on every leg (evaluated, sibling and
  backup) with the reason `family`; naming a model (`model=`) is the explicit override (`selection.AUTO_BARRED_FAMILIES`).
- **A `cc` leg whose key cannot start a worker is listed unavailable and refused.** A headless Claude Code worker's first
  turn is tens of thousands of input tokens (`config.CC_FIRST_TURN_TOKENS`, 40,000). `input_limit.py` records each key's
  input-tokens-per-minute limit per model (Anthropic's header on native calls, or the 429 a cc worker dies of) for 3 days
  in `HSWARM_HOME/input_limits.json`, keyed by fingerprint. A leg whose every live key is under that is kept out of the
  candidates, named under `unavailable` with the reason, refused at submit, and shown in `hswarm_select`'s `input_limit`.
- **`hswarm distill --live` triages its facts in the same run**, and `hswarm triage` saves each `keep` to the Connections
  memory store as a tentative memory (a duplicate, trivial or rejected candidate never reaches it; an existing slug is left
  alone). Nothing is staged on disk. `--dry-run` prints what would be saved. The memory kit checkout (its `global/` and
  `repos/` indexes and `home/tools/memstore.py`) is `HSWARM_MEMORY_REPO`, default `~/claude-memory`.
- `indexdiet` and the hooks module it fed are retired along with the memory index they served.

## Transcript scanners

`hswarm savings` reads every Claude Code transcript on the machine. That scan exists three times with identical
numbers: Python (the reference), Rust (`native/zscan-rs`) and Go (`native/zscan-go`).

- `hswarm native build` compiles the arms whose toolchain is present (cargo, go; also found under `~/.cargo/bin` and
  `~/go/bin` when not on PATH) into `native/bin/`, which git ignores.
- `hswarm native bench` runs the arms interleaved on this machine's transcripts, refuses any arm whose numbers differ
  from Python's, and writes the fastest to `HSWARM_HOME/native/winner.json`. The scan uses that winner from then on and
  falls back to Python when its binary is missing. `HSWARM_SCANNER=python|rust|go` forces an arm.
- `tests/test_native.py` and `tests/test_scanner_parity.py` check each built arm against Python (skipped when unbuilt).

## Development

For debugging, set environment variables:

```bash
# Enable signing in to the UI
export HSWARM_UI_SIGN_IN=1

# Set a custom config directory
export HSWARM_HOME=/custom/path

# Set console port
export HSWARM_PORT=7793
```

Run the tests with `python -m pytest hswarm/tests -q` from the repository root.
