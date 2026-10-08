"""Command line: help · skill · doctor · web · prefix · ask · run · status · results · jobs · cost · survival · savings · usage · egress · bench · install · mcp,
plus the memory-pipeline tools distill · triage and native · benchdb · filters · comply · skillbench · review · loop · optimize · procedures · replay · scripted, which own their own parsers."""
from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import os
import sys

from . import __version__, clihelp, config
from .commands import COMMANDS
from .install import cmd_install, cmd_setup

# The pipeline commands own their argument parsing, so they are dispatched before argparse sees the line.
PIPELINE = {"distill", "triage", "native", "benchdb", "filters", "comply", "skillbench", "review", "loop", "optimize", "procedures", "replay", "scripted"}
# A pipeline command whose module is named differently from the command.
# (`review` is not review.py: that module holds the MCP review contracts, the verb lives in reviewverb.py.)
PIPELINE_MODULE = {"filters": "outfilters", "review": "reviewverb"}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hswarm", description="HydraSwarm (hswarm): hand work to many cheap AI models at once, from Claude Code, Claude Desktop or Codex. hswarm ui opens the console.")
    p.add_argument("--version", action="version", version=f"hswarm {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    # The self-description (hswarm/clihelp.py): agents read commands, flags and effects here, not from prose.
    hp = sub.add_parser("help", help="every command with its effect (read | write | spend | destructive); `help <command>` for one")
    hp.add_argument("command", nargs="?", help="one command's args, flags, examples, effect and agent guide")
    hp.add_argument("--json", action="store_true", help="data instead of text")
    hp.add_argument("--compact", action="store_true", help="the sitemap only: command, description, effect")
    sk = sub.add_parser("skill", help="the agent SKILL.md telling agents to use `help --json`; --install writes it, --check says if it is stale")
    sk.add_argument("--install", action="store_true", help=f"write it (default {clihelp.SKILL_PATH})")
    sk.add_argument("--check", action="store_true", help="compare the installed copy's stamp with this CLI's; exit 1 if missing or stale")
    sk.add_argument("--path", help="another SKILL.md location")

    sub.add_parser("doctor", help="key present? models? balance? binaries?")

    svc = sub.add_parser("service", help="list or call a provider's speech, image, video, search or application operations")
    svc.add_argument("provider", help="provider name; omit operation to list capabilities and documented endpoints offline")
    svc.add_argument("operation", nargs="?", help="one operation from the provider's list")
    svc.add_argument("--input", help="JSON payload file, or - to read a JSON object from stdin")
    svc.add_argument("--path", dest="path_param", action="append", metavar="NAME=VALUE", help="endpoint path placeholder (repeatable)")
    svc.add_argument("--param", action="append", metavar="NAME=VALUE", help="query parameter (repeatable)")
    svc.add_argument("--file", action="append", metavar="FIELD=PATH", help="multipart file (repeatable)")
    svc.add_argument("--data-body", help="binary request body file for operations with input=bytes")
    svc.add_argument("--content-type", help="media type for a binary request body")
    svc.add_argument("--output", help="response destination; required for binary media")
    svc.add_argument("--key-fingerprint", help="use this provider key's fingerprint (use the same key to poll its generation)")
    svc.add_argument("--timeout-s", type=float, default=120.0)

    # The allow-always / block half of read_url's host gate (web.py); allow-once is web_hosts on the batch.
    w = sub.add_parser("web", help="read_url's standing host policy (allow / block) and which backend serves each channel")
    w.add_argument("--allow", action="append", metavar="HOST", help="allow HOST for every batch from now on (repeatable)")
    w.add_argument("--block", action="append", metavar="HOST", help="admin block: never fetch HOST, whatever a batch lists (repeatable)")
    w.add_argument("--forget", action="append", metavar="HOST", help="take HOST off both lists (repeatable)")
    # The per-spawn prefix a cc worker re-sends (system, context, every tool schema), measured offline.
    px = sub.add_parser("prefix", help="what one cc worker spawn ships before any work: system, context, tool schemas, the heaviest MCP server (local sink, no spend)")
    px.add_argument("--cwd", help="the task folder to spawn in (its CLAUDE.md and .mcp.json count); default the current folder")
    px.add_argument("--tools", default="read", choices=["read", "edit", "all"], help="the worker's tool preset (default read, as a task's)")
    px.add_argument("--model", help="the cc model (default: the cc AUTO model); prices the prefix")
    px.add_argument("--operator", action="store_true", help="measure this machine's own Claude Code setup instead of the isolated worker config "
                                                            "(starts its MCP servers and hooks once): what a Claude sub-agent carries")
    px.add_argument("--timeout-s", dest="timeout_s", type=int, default=120)
    px.add_argument("--top", type=int, default=10, help="how many of the heaviest tool schemas to list")
    px.add_argument("--json", action="store_true")

    k = sub.add_parser("keys", help="the key pools: which are ready, resting, or in the DISABLED slot (out of credit / revoked)")
    k.add_argument("action", nargs="?", default="list", choices=["list", "probe", "enable", "disable", "add", "remove"],
                   help="list (offline, default) | probe (one free GET per key; a topped-up key comes back here) | enable | disable"
                        " | add (reads the key from stdin or a hidden prompt, never the command line) | remove")
    k.add_argument("fingerprint", nargs="?", help="the 8-character fingerprint `hswarm keys` prints; never the key itself (with add: the provider)")
    k.add_argument("--provider", help="deepseek | openrouter | ... (default: every provider that has keys)")
    k.add_argument("--all", action="store_true", help="with enable: empty the disabled slot")
    k.add_argument("--reason", default="disabled by hand", help="with disable: why, recorded in the slot")
    k.add_argument("--json", action="store_true")

    ik = sub.add_parser("import-keys", help="merge alive/dead key exports into the shared encrypted vault")
    ik.add_argument("--from", dest="source_dir", required=True, help="directory of *_alive_keys.txt / *_dead_keys.txt, key lists, or a legacy clone with .secrets/")
    ik.add_argument("--dry-run", action="store_true", help="show additions and explicit dead removals without writing or syncing")
    ik.add_argument("--json", action="store_true", help="print counts only as JSON")

    iz = sub.add_parser("import-zswarm", help="import ZSwarm's stats and history (database, ledger and other logs, jobs, archives) into HSwarm, once (later runs do nothing)")
    iz.add_argument("--from", dest="source_dir", help="the ZSwarm home (default: $ZSWARM_HOME or ~/.zswarm)")
    iz.add_argument("--dry-run", dest="dry_run", action="store_true", help="count what would be imported and write nothing")
    iz.add_argument("--json", action="store_true")

    vt = sub.add_parser("vault", help="the shared key vault: HSWARM_HOME/secrets key lists, encrypted on a server only you can reach, kept in step on every paired machine")
    vt.add_argument("action", nargs="?", default="status", choices=["status", "init", "join", "adopt", "pair", "request", "grant", "accept", "sync", "list", "add", "remove", "leave"],
                    help="status (default) | init <backend> (make the vault from this machine's keys) | join (reads the pairing code from a hidden prompt) "
                         "| adopt (use the vault this machine's ZSwarm is paired with) | pair (prints the code, only to a terminal) "
                         "| request <backend> (new machine: ask the vault for its code, sealed to this machine) | grant [machine] (vault machine: "
                         "seal the code to a request once you confirm its fingerprint) | accept (new machine: open the grant and join) | sync | list [list] "
                         "| add <list> (reads the keys from stdin or a hidden prompt) | remove <list> <fingerprint> | leave (stop using the vault on this machine: removes vault.key, vault.json and the base; the keys in secrets/ and the backend stay)")
    vt.add_argument("target", nargs="?", help="init/request: ssh://[user@]host[:port]/<dir> or dir:<folder>; grant: the requesting machine; list/add/remove: a provider (openrouter) or a list file (cohere_api_keys.dead)")
    vt.add_argument("fingerprint", nargs="?", help="remove: the 8-character fingerprint `hswarm vault list` prints")
    vt.add_argument("--backend", help="join: use this backend instead of the one in the code (an ssh alias this machine has)")
    vt.add_argument("--rebase", action="store_true", help="sync: treat this machine as new: keep its keys, add everyone else's, remove nothing")
    vt.add_argument("--allow-removals", dest="allow_removals", action="store_true", help="sync: allow a sync that removes a quarter of the keys or empties a list")
    vt.add_argument("--dry-run", dest="dry_run", action="store_true", help="sync: say what would change and change nothing")
    vt.add_argument("--force", action="store_true", help="join/request/accept: replace this machine's existing vault; leave: skip the confirmation")
    vt.add_argument("--yes", metavar="FINGERPRINT", help="grant without a terminal: the FULL fingerprint the requesting machine printed (e.g. 3F2A-91C0-77BE-0D14)")
    vt.add_argument("--json", action="store_true")

    md = sub.add_parser("models", help="every model this machine can address; --refresh pulls a provider's live catalogue and prices")
    md.add_argument("--refresh", nargs="?", const="openrouter", metavar="PROVIDER", help="pull PROVIDER's /models catalogue (default openrouter) into ~/.hswarm/openrouter-models.json")
    md.add_argument("--routes", action="store_true", help="the price routes: which provider serves each model right now, and why")
    md.add_argument("--watch", action="store_true", help="scan every chat provider's model list (free GETs) and report new, benchmarked-but-unrouted and unbenchmarked models")
    md.add_argument("--grep", help="filter the listing by substring")
    md.add_argument("--limit", type=int, default=60)
    md.add_argument("--json", action="store_true")

    ix = sub.add_parser("index", help="the benchmark index: add models Artificial Analysis scores in full, or refresh its numbers from the same source")
    ixs = ix.add_subparsers(dest="index_cmd", required=True)
    ixa = ixs.add_parser("add", help="append the named models' points to the index, sourced from their Artificial Analysis model pages")
    ixa.add_argument("slugs", nargs="+", metavar="SLUG")
    ixa.add_argument("--json", action="store_true")
    ixr = ixs.add_parser("refresh", help="rewrite every index point's numbers from Artificial Analysis's model pages")
    ixr.add_argument("--json", action="store_true")

    q = sub.add_parser("ask", help="one tool-free question")
    q.add_argument("prompt")
    q.add_argument("--system")
    q.add_argument("--model", default=config.AUTO, help="default 'auto': cheapest available evaluated configuration meeting the capability profile")
    q.add_argument("--role", help="search | code | judge | summarize | refute | doubt: the model this machine wires for that work ([roles] in ~/.hswarm/settings.toml); judge/refute/doubt add their review contract")
    q.add_argument("--schema", help="JSON schema string; answer comes back as data")
    q.add_argument("--thinking", type=lambda s: s.lower() in ("1", "true", "on", "yes"), default=None)
    q.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    q.add_argument("--profile", choices=["routine", "general", "code", "decision", "research", "critical"], help="published task capability requirements")
    q.add_argument("--no-route", dest="no_route", action="store_true", help="do not price-route: use the model exactly as named")
    q.add_argument("--json", action="store_true")

    pn = sub.add_parser("panel", help="blind panel review: one prompt to 2-5 models, then an anonymised rebuttal round; contested findings first")
    pn.add_argument("prompt")
    pn.add_argument("--models", help="comma list of models, aliases or roles (default: the tool-free and tool-using defaults, or `panel` in ~/.hswarm/settings.toml)")
    pn.add_argument("--system")
    pn.add_argument("--max-findings", dest="max_findings", type=int, default=8)
    pn.add_argument("--effort", choices=["low", "high", "max"], default="low")
    pn.add_argument("--seed", type=int, help="fix the rebuttal-round shuffle (reproducible seating)")
    pn.add_argument("--json", action="store_true")

    r = sub.add_parser("run", help="run a tasks file (JSON list or {defaults, tasks})")
    r.add_argument("tasks")
    r.add_argument("--backend", choices=["api", "cc"])
    r.add_argument("--model")
    r.add_argument("--cwd")
    r.add_argument("--tools")
    r.add_argument("--confirm-write", dest="confirm_write", action="store_true", default=None, help="cc: the second opt-in an edit/all preset needs to bypass permissions")
    r.add_argument("--isolated", action="store_true", default=None, help="cc: load no MCP server and none of the task folder's hooks, settings or CLAUDE.md")
    r.add_argument("--capability", help="a least-privilege grant for every task: a preset, a name under .hswarm/capabilities/, or a .json path")
    r.add_argument("--web-hosts", dest="web_hosts", help="comma list of hosts read_url (the web preset) may fetch for every task")
    r.add_argument("--zdr", action="store_true", default=None, help="only OpenRouter models on its zero-data-retention list may serve every task")
    r.add_argument("--max-turns", dest="max_turns", type=int)
    r.add_argument("--timeout-s", dest="timeout_s", type=int)
    r.add_argument("--redact", choices=["hash", "redact", "mask", "block", "off"],
                   help="strip secrets, emails and card numbers from tool output before the provider sees it (api backend)")
    r.add_argument("--recipe", help="name this recurring job: its last passing run's read-only tool plan is replayed first (api backend)")
    r.add_argument("--escalate", metavar="MODEL", help="re-run a task once on this stronger model when its worker gives up, and bank the fix as a skill")
    r.add_argument("--concurrency", type=int)
    r.add_argument("--budget", type=float, help="USD ceiling for the whole job; pending tasks are cancelled once crossed")
    r.add_argument("--envelope", help='JSON spawn-tree envelope rooted at this job, e.g. \'{"max_depth": 1, "spend_usd": 2, "max_nodes": 20}\'; '
                   "under an inherited HSWARM_ENVELOPE it can only narrow that one")
    r.add_argument("--label")
    r.add_argument("--check", action="store_true", help="validate the tasks file and say whether it can be served, without sending anything: no job, no spend")
    r.add_argument("--unbatched", action="store_true",
                   help="send 8+ small tool-free tasks of one shape anyway (by default they are refused: pack 20-100 items per task)")
    r.add_argument("--resume-from", dest="resume_from", metavar="JOB",
                   help="reuse every ok answer of that earlier job whose task content is unchanged; only the rest run")
    r.add_argument("--out", help="write full job JSON here")
    r.add_argument("--print", action="store_true", help="print answers even when --out is given")
    r.add_argument("--quiet", action="store_true")

    s = sub.add_parser("status", help="summary of a job from disk")
    s.add_argument("job")
    ca = sub.add_parser("cancel", help="cancel a job another process runs (asked, stops within ~10 s) or one nothing runs any more")
    ca.add_argument("job")
    rs = sub.add_parser("results", help="answers of a job from disk")
    rs.add_argument("job")
    rs.add_argument("--id", action="append")
    rs.add_argument("--taint", metavar="LETTERS", help="only results carrying any of these taint letters (F R S T B C), or 'clean' for untainted ones")
    j = sub.add_parser("jobs", help="recent jobs; --prune-days clears the finished ones (a cache, never the numbers)")
    j.add_argument("--limit", type=int, default=20)
    j.add_argument("--prune-days", dest="prune_days", type=int, metavar="N", help="report the job folders older than N days (dry run); the ledger and the synced shard keep every number")
    j.add_argument("--compact", action="store_true", help="losslessly shrink the job records on disk: a long string is stored once per job instead of once per task (dry run)")
    j.add_argument("--archive-hours", dest="archive_hours", type=float, metavar="H", help="pack every job folder older than H hours into one compressed file each; readers fall back to it (dry run)")
    j.add_argument("--apply", action="store_true", help="with --prune-days, --compact or --archive-hours: actually do it")

    mt = sub.add_parser("maintain", help="the daily pass: archive old job folders, record yesterday, sync the fleet, rewrite the page")
    mt.add_argument("--archive-hours", dest="archive_hours", type=float, default=24.0)
    mt.add_argument("--keep-days", dest="keep_days", type=int, default=0, metavar="N", help="delete jobs older than N days; 0, the default, keeps every one (packed into the history by day)")
    mt.add_argument("--backfill", type=int, default=7)
    mt.add_argument("--no-push", dest="push", action="store_false")
    mt.add_argument("--quiet", action="store_true")

    hs = sub.add_parser("history", help="every finished task, one row each: backfill the table, or report how each shape ended and what it cost")
    hs.add_argument("--index", action="store_true", help="add every finished job not yet in the table now (maintain does it daily)")
    hs.add_argument("--days", type=float, default=30.0)
    hs.add_argument("--json", action="store_true")

    es = sub.add_parser("survival", help="per model: how much of what api workers wrote is still in the file (5m / 1h / 1d after the task)")
    es.add_argument("--days", type=float, default=7.0)
    es.add_argument("--json", action="store_true")

    c = sub.add_parser("cost", help="ledger summary + balance")
    c.add_argument("--days", type=float, default=1.0)
    c.add_argument("--no-balance", dest="balance", action="store_false")

    sv = sub.add_parser("savings", help="per day: DeepSeek spend, this machine's Claude usage, and the Claude sub-agent cost the hswarm avoided")
    sv.add_argument("--days", type=int, default=14)
    sv.add_argument("--record", action="store_true", help="measure every completed day not yet on record (the scheduled daily run)")
    sv.add_argument("--backfill", type=int, default=7, help="days the very first --record measures, as the before-hswarm baseline")
    sv.add_argument("--no-today", dest="today", action="store_false", help="skip the live scan of today's transcripts")
    sv.add_argument("--backfill-jobs", dest="backfill_jobs", action="store_true", help="add every finished job on disk and every ask in the ledger that the utilization DB lacks")
    sv.add_argument("--remeasure", type=int, metavar="N", help="re-scan the last N completed days so their rows carry what the scanners record now (per-model split, per-agent detail)")
    sv.add_argument("--profile", action="store_true", help="re-measure the sub-agent profile from the recorded days and price the rows still unpriced")
    sv.add_argument("--sync", action="store_true", help="then sync the utilization shards with the fleet (see `hswarm sync`)")
    sv.add_argument("--list", type=int, metavar="N", help="print the running total and the last N utilizations, nothing else")
    sv.add_argument("--html", nargs="?", const=True, metavar="PATH", help="write the HTML page (default ~/.hswarm/hswarm.html; every savings run and sync refreshes it anyway) and print its path")
    sv.add_argument("--quiet", action="store_true", help="with --record/--profile/--sync: log only, print nothing")
    sv.add_argument("--json", action="store_true")

    sy = sub.add_parser("sync", help="utilization shards: pull the other machines', push this one's, regenerate TOTALS.md on the sync branch")
    sy.add_argument("--no-push", dest="push", action="store_false", help="import and export locally only")
    sy.add_argument("--restore", action="store_true", help="first read THIS machine's own shard back into the ledger (rebuild after a lost ~/.hswarm)")

    u = sub.add_parser("usage", help="who used the swarm (per calling session), and the Claude fan-outs the routing gate saw")
    u.add_argument("--hours", type=float, default=24.0)
    u.add_argument("--json", action="store_true")

    eg = sub.add_parser("egress", help="the egress receipts: what left this machine, where to, as hashes only; verify the chain")
    eg.add_argument("action", nargs="?", default="verify", choices=["verify", "tail", "find"],
                    help="verify (recompute the hash chain, default) | tail (latest receipts) | find (receipts for one sha256)")
    eg.add_argument("sha256", nargs="?", help="with find: the sha256 of the exact request body")
    eg.add_argument("--limit", type=int, default=20, help="with tail: how many receipts")
    eg.add_argument("--json", action="store_true")

    b = sub.add_parser("bench", help="run the benchmark suite (see bench/)")
    b.add_argument("--backend", default="api", help="api | cc | api:flash@high | api:flash@off | comma list (effort: off|low|high|max)")
    b.add_argument("--suite", default="mechanical", choices=["mechanical", "judgment"])
    b.add_argument("--repeats", type=int, default=1, help="run every arm N times on fresh fixtures; reports per-task pass counts and mean/min/max")
    b.add_argument("--model", default=config.DEFAULT_MODEL)
    b.add_argument("--only", action="append", help="task id filter")
    b.add_argument("--burst", type=int, default=0, help="also run an N-wide concurrency burst")
    b.add_argument("--concurrency", type=int)
    b.add_argument("--sequential", action="store_true", help="run arms and repeats one at a time (slower; use when a machine-level measurement must be uncontended)")
    b.add_argument("--out")
    b.add_argument("--fresh", action="store_true", help="re-measure an arm the results DB (bench/results/) already holds for this suite version")
    b.add_argument("--max-age-days", type=float, default=30.0, help="a results-DB row older than this is re-measured")
    b.add_argument("--instructions", action="append", help="A/B an instruction file: every arm also runs with FILE (or NAME=FILE) in its system prompt")
    b.add_argument("--baseline", help="arm the others are compared with (default: the first; an --instructions arm uses itself without the file)")
    b.add_argument("--max-regression", type=float, default=0.05, help="tolerated pass-rate drop (0..1) before the compare step calls an arm worse and exits 1")
    b.add_argument("--judge", help="model for criterion assertions (default: the `judge` role)")
    b.add_argument("--selftest", action="store_true", help="only prove the suite's graders against their good/bad references (offline, no spend; every bench runs it first anyway)")
    b.add_argument("--include-known-gaps", action="store_true", help="also run the tasks a model has a recorded known gap on (to check a re-enable condition)")

    i = sub.add_parser("install", help="register the MCP server with Claude Code, Claude Desktop and/or Codex")
    i.add_argument("--client", action="append", choices=["claude-code", "claude-desktop", "codex", "all"],
                   help="which client to register with (repeatable; default claude-code)")
    i.add_argument("--instructions", action="store_true", help="also write the how-to-use-hswarm block into ~/.claude/CLAUDE.md / ~/.codex/AGENTS.md")
    i.add_argument("--remove", action="store_true", help="unregister instead (and take the instructions block out)")
    i.add_argument("--also", action="append", help="extra .claude.json paths")
    i.add_argument("--force", action="store_true")
    i.add_argument("--stdio", action="store_true", help="register a stdio server per chat instead of the one shared HTTP server")
    i.add_argument("--track-savings", dest="track_savings", action="store_true", help="also schedule `savings --record` daily (Windows Task Scheduler)")

    st = sub.add_parser("setup", help="first run in one command: connect every assistant found here (Claude Code, Claude Desktop, Codex) and open the console")
    st.add_argument("--client", action="append", choices=["claude-code", "claude-desktop", "codex", "all"],
                    help="connect these instead of the ones found on this machine (repeatable)")
    st.add_argument("--instructions", action="store_true", help="also write the how-to-use-hswarm block into ~/.claude/CLAUDE.md / ~/.codex/AGENTS.md")
    st.add_argument("--port", type=int, default=None, help="the shared server's port (default 7793)")
    st.add_argument("--no-open", dest="no_open", action="store_true", help="print the console's address instead of opening a browser")

    u = sub.add_parser("ui", help="open the web console (keys, providers, models, priority, roles, jobs, client setup)")
    u.add_argument("--port", type=int, default=None, help="the shared server's port (default 7793)")
    u.add_argument("--no-open", dest="no_open", action="store_true", help="print the address instead of opening a browser")

    m = sub.add_parser("mcp", help="run the MCP server (stdio; --http = the one shared server every chat connects to)")
    m.add_argument("--http", action="store_true", help="serve streamable-http on 127.0.0.1 instead of stdio (hswarm/shared.py)")
    m.add_argument("--port", type=int, default=None, help="the --http port (default 7793)")
    m.add_argument("--record", metavar="PATH", help="stdio only: also record every JSON-RPC line to PATH (a folder gets one ndjson per session) for `hswarm replay`")
    se = sub.add_parser("serve-ensure", help="keep the shared HTTP MCP server up: return at once if it answers, else start it hidden")
    se.add_argument("--port", type=int, default=None, help="default 7793")
    co = sub.add_parser("connect", help="the chat's headersHelper for the shared server: ensure it is up, print the chat's X-Hswarm-* headers")
    co.add_argument("--port", type=int, default=None, help="default 7793")
    for name, doc in (("distill", "session transcripts -> memory facts, triaged in the same run (plan only by default)"), ("triage", "judge memory candidates against the index; keep saves them tentative to the memory store"),
                      ("procedures", "mine repeated tool procedures from transcripts into staged skill candidates (no model call)"),
                      ("native", "build | bench the Rust/Go transcript scanners"),
                      ("benchdb", "the bench results DB: every model's score on every suite, so nothing is re-measured"),
                      ("filters", "the output filters a worker's bash output passes through, and their inline tests"),
                      ("comply", "measure whether workers obey a rule .md: scenarios on cc, calls labelled, order graded, hook candidates named"),
                      ("skillbench", "run skills' evals/evals.json with and without the skill, graded from the trace (dry run by default)"),
                      ("review", "a specialist reviewer roster over a diff, merged by fingerprint, with a coordinator verdict"),
                      ("loop", "frontier loop: probe for the earliest failing stage, send FIX/PORT workers at it, repeat until none"),
                      ("optimize", "keep-or-revert metric ratchet: one worker, its own worktree and branch, commit only what improves the number"),
                      ("replay", "replay a recorded MCP session (hswarm mcp --record) and ddmin it to the messages that still fail"),
                      ("scripted", "check: replay every 'scripted-diff:' commit in a range and fail on any mismatch")):
        sub.add_parser(name, help=f"{doc}; its own --help follows", add_help=False)
    return p


def main(argv: list[str] | None = None) -> int:
    # A Windows console or redirect defaults to cp1252, which cannot print what workers write (arrows, curly quotes):
    # `run` finished its job and then died printing the answers, and `results` could not print them at all
    # (UnicodeEncodeError on U+2192, 2026-09-25). Print UTF-8 and replace anything that still cannot be encoded.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    argv = list(sys.argv[1:] if argv is None else argv)
    from . import fleetstats

    if argv and argv[0] in PIPELINE:
        fleetstats.send("app_open", cmd=argv[0])
        try:
            return importlib.import_module(f".{PIPELINE_MODULE.get(argv[0], argv[0])}", __package__).main(argv[1:])
        finally:
            fleetstats.flush()
    parser = build_parser()
    a = parser.parse_args(argv)
    fleetstats.send("app_open", cmd=a.cmd)
    try:
        return _dispatch(a, parser)
    finally:
        fleetstats.flush()


def _dispatch(a, parser) -> int:
    if a.cmd == "help":
        return clihelp.cmd_help(a, parser)
    if a.cmd == "skill":
        return clihelp.cmd_skill(a, parser)
    if a.cmd == "mcp":
        if a.http:
            from . import shared

            shared.serve(a.port or shared.PORT)
            return 0
        from .mcp_server import main as mcp_main

        if a.record:
            os.environ["HSWARM_RECORD"] = a.record  # mcp_server.main turns this into a recording relay
        mcp_main()
        return 0
    if a.cmd == "serve-ensure":
        from . import shared

        out = shared.ensure(a.port or shared.PORT)
        print(json.dumps(out))
        return 0 if out["ok"] else 1
    if a.cmd == "connect":
        from . import shared

        return shared.connect(a.port or shared.PORT)
    if a.cmd == "ui":
        from .console import open_console

        return open_console(a.port, no_open=a.no_open)
    if a.cmd == "install":
        return cmd_install(a)
    if a.cmd == "setup":
        return cmd_setup(a)
    return asyncio.run(COMMANDS[a.cmd](a))


if __name__ == "__main__":
    sys.exit(main())
