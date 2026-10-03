# HydraSwarm (hswarm)

HydraSwarm is a copy of ZSwarm integrated into AgentHydra, running side-by-side with the original without sharing any state.

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

This copies key files from `<clone>/.secrets/` into `$HSWARM_HOME/secrets/` and prints only counts (never a key).

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
└── hswarm.html               # Console view (auto-generated)
```

## Inside AgentHydra

The AgentHydra daemon starts HydraSwarm by default (`python -m hswarm mcp --http --port 7793`), restarts it with backoff if it exits, and proxies its console API at `/api/hswarm/*` for the HSwarm tab. The log is `<AgentHydra data>/logs/hswarm.log`.

- `AGENTHYDRA_HSWARM_ENABLED=0` keeps it off.
- `AGENTHYDRA_HSWARM_DIR` names the folder holding `hswarm/` when it is not beside the app (a wrong folder is reported in the tab, not replaced).
- `AGENTHYDRA_PYTHON` names the interpreter (default `python`, `python3` off Windows).

## Isolation

- All state is isolated under `HSWARM_HOME` (default `~/.hswarm`)
- Console runs on port 7793 (`--port` or `HSWARM_PORT` to change)
- All environment variables use the `HSWARM_*` prefix
- Keys come from env vars or `HSWARM_HOME/secrets`; nothing is shared with any other install

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
