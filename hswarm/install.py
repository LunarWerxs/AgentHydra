"""`hswarm install`: register the MCP server with the agent clients on this machine. The clone (or the package) is
the install; this writes one entry per client and touches nothing else in its file.

  claude-code      ~/.claude.json (and $CLAUDE_CONFIG_DIR/.claude.json): Claude Code in the terminal, the IDEs and the
                   desktop app's Code tab. The one shared HTTP server by default (shared.py), --stdio for a child per chat.
  claude-desktop   claude_desktop_config.json: the Claude desktop app's chat. It launches stdio servers only.
  codex            $CODEX_HOME/config.toml (~/.codex): the Codex CLI, its IDE extension and the Codex app share it.
                   stdio, with tool_timeout_sec raised: Codex cuts a tool call at 60 s by default, and a hswarm_run
                   that waits for its batch takes longer.

`hswarm setup` is the first run in one command (the installers end with it): every client found on this machine,
then the console.

`--instructions` also writes a short "how to use hswarm" block (data/agent-instructions.md) into the global
instruction file each client reads (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md), between markers, so a re-run
replaces it and `--remove` takes it out.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from importlib.resources import files
from pathlib import Path

from . import config, shared
from .claude_env import ensure_cc_config

REPO = Path(__file__).resolve().parent.parent
SAVINGS_TASK = "hswarm-savings-daily"
PACK_TASK = "hswarm-pack-hourly"
CLIENTS = ("claude-code", "claude-desktop", "codex")
SERVER = "hswarm"
CODEX_TOOL_TIMEOUT_S = 900
BEGIN, END = "<!-- hswarm:begin -->", "<!-- hswarm:end -->"


def schedule_savings() -> str:
    """A daily Windows scheduled task running `hswarm maintain` with no window, below normal priority, catching
    up when the machine was off at the scheduled time, and an hourly one that only packs job folders past 24 h.
    Re-running replaces both.

    WHY hourly: with the daily pass alone a job that finished just after its cutoff stayed a raw folder for up to
    48 h; the 24-48 h band measured 408 folders, 1,374 MiB (2026-10-02), and archives store about 3.8x smaller."""
    if os.name != "nt":
        return ("savings schedule: Windows only here; add `hswarm maintain --quiet` (daily) and "
                "`hswarm jobs --archive-hours 24 --apply` (hourly) to cron")
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    exe = pythonw if pythonw.exists() else Path(sys.executable)

    def action(*args: str) -> str:
        argline = " ".join(f'"{part}"' for part in [*config.launcher()[1:], *args]).replace("'", "''")
        return f"New-ScheduledTaskAction -Execute '{exe}' -Argument '{argline}' -WorkingDirectory '{REPO}'"
    script = (
        f"$a = {action('maintain', '--quiet')};"
        "$t = New-ScheduledTaskTrigger -Daily -At 00:20;"
        "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries"
        " -ExecutionTimeLimit (New-TimeSpan -Hours 2) -Priority 7;"
        f"Register-ScheduledTask -TaskName '{SAVINGS_TASK}' -Action $a -Trigger $t -Settings $s -Force"
        " -Description 'hswarm: archive old job folders, delete old archives, record the day, sync the fleet, rewrite the page' | Out-Null;"
        f"$a = {action('jobs', '--archive-hours', '24', '--apply')};"
        "$t = New-ScheduledTaskTrigger -Once -At 00:50 -RepetitionInterval (New-TimeSpan -Hours 1);"
        f"Register-ScheduledTask -TaskName '{PACK_TASK}' -Action $a -Trigger $t -Settings $s -Force"
        " -Description 'hswarm: pack job folders older than 24 hours into one compressed file each' | Out-Null"
    )
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                   check=True, capture_output=True, text=True, creationflags=0x08000000)  # CREATE_NO_WINDOW
    return (f"scheduled task {SAVINGS_TASK}: daily 00:20 (or at next start), log {config.HOME / 'savings.log'}; "
            f"scheduled task {PACK_TASK}: hourly at :50")


def stdio_entry() -> dict:
    cmd = config.launcher()
    return {"command": cmd[0], "args": cmd[1:] + ["mcp"], "env": {}}


def http_entry() -> dict:
    helper = " ".join(f'"{part}"' if re.search(r"[^\w./:=-]", part) else part for part in config.launcher() + ["connect"])
    return {"type": "http", "url": f"http://127.0.0.1:{shared.PORT}/mcp", "headersHelper": helper.replace("\\", "/")}


def claude_code_paths(also: list[str] | tuple = ()) -> list[Path]:
    out = [Path.home() / ".claude.json"]
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        out.append(Path(os.environ["CLAUDE_CONFIG_DIR"]) / ".claude.json")
    return out + [Path(p) for p in also]


def claude_desktop_path() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    if os.name == "nt":
        roaming = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Claude"
        if not roaming.exists():  # the Microsoft Store build keeps its roaming folder inside its package
            local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Packages"
            store = sorted(local.glob("Claude_*/LocalCache/Roaming/Claude")) if local.exists() else []
            roaming = store[0] if store else roaming
        return roaming / "claude_desktop_config.json"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "Claude" / "claude_desktop_config.json"


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def _read_json(path: Path) -> dict | None:
    """The file's object; {} when it does not exist; None when it is not JSON (never overwritten then)."""
    if not path.exists():
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8") or "{}")
    except ValueError:
        return None
    return doc if isinstance(doc, dict) else None


def _json_server(path: Path, entry: dict | None, force: bool) -> str:
    # Client config files hold other MCP servers' env blocks, keys among them: every rewrite of one is owner-only
    # (0600 on POSIX), never the umask's 0644 over a file that was private.
    doc = _read_json(path)
    if doc is None:
        return f"skip {path}: not valid JSON, left untouched"
    servers = doc.setdefault("mcpServers", {})
    if entry is None:
        if servers.pop(SERVER, None) is None:
            return f"{path}: not registered"
        shared.atomic_write(path, json.dumps(doc, indent=2, ensure_ascii=False), private=True)
        return f"{path}: removed mcpServers.{SERVER}"
    if servers.get(SERVER) == entry and not force:
        return f"{path}: already registered"
    servers[SERVER] = entry
    shared.atomic_write(path, json.dumps(doc, indent=2, ensure_ascii=False), private=True)
    return f"{path}: registered mcpServers.{SERVER} -> {entry.get('url') or ' '.join([entry['command'], *entry['args']])}"


_CODEX_TABLE = re.compile(r'^\s*\[\s*mcp_servers\s*\.\s*("hswarm"|hswarm)\s*(\..*)?\]\s*(#.*)?$')
_TOML_HEADER = re.compile(r"^\s*\[")


def _codex_strip(text: str) -> str:
    """The file without its [mcp_servers.hswarm] table (and any [mcp_servers.hswarm.*] sub-table)."""
    out, skipping = [], False
    for line in text.splitlines(keepends=True):
        if _TOML_HEADER.match(line):
            skipping = bool(_CODEX_TABLE.match(line))
        if not skipping:
            out.append(line)
    return "".join(out).rstrip() + ("\n" if out else "")


def _codex_block() -> str:
    cmd = config.launcher()
    args = ", ".join(json.dumps(a) for a in cmd[1:] + ["mcp"])
    return (f"[mcp_servers.{SERVER}]\n"
            f"command = {json.dumps(cmd[0])}\n"
            f"args = [{args}]\n"
            "startup_timeout_sec = 30\n"
            f"tool_timeout_sec = {CODEX_TOOL_TIMEOUT_S}\n")


def _codex_server(path: Path, remove: bool, force: bool) -> str:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    stripped = _codex_strip(text)
    if remove:
        if stripped == text or stripped.rstrip() == text.rstrip():
            return f"{path}: not registered"
        shared.atomic_write(path, stripped, private=True)
        return f"{path}: removed [mcp_servers.{SERVER}]"
    block = _codex_block()
    if block in text and not force:
        return f"{path}: already registered"
    shared.atomic_write(path, (stripped + "\n" if stripped.strip() else "") + block, private=True)
    return f"{path}: registered [mcp_servers.{SERVER}] (tool_timeout_sec = {CODEX_TOOL_TIMEOUT_S})"


def instructions_text() -> str:
    return files("hswarm").joinpath("data", "agent-instructions.md").read_text(encoding="utf-8").strip()


def _instructions(path: Path, remove: bool) -> str:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    start, end = text.find(BEGIN), text.find(END)
    if start >= 0 and end > start:
        text = (text[:start].rstrip() + "\n" + text[end + len(END):].lstrip("\n")).strip() + "\n"
    if remove:
        shared.atomic_write(path, text) if path.exists() else None
        return f"{path}: instructions block removed"
    block = f"{BEGIN}\n{instructions_text()}\n{END}\n"
    shared.atomic_write(path, (text.rstrip() + "\n\n" if text.strip() else "") + block)
    return f"{path}: instructions block written"


def install_client(name: str, *, stdio: bool = False, force: bool = False, remove: bool = False,
                   instructions: bool = False, also: list[str] | tuple = ()) -> list[str]:
    """Register (or with remove=True, unregister) hswarm with one client. Returns one line per file touched."""
    lines: list[str] = []
    if name == "claude-code":
        entry = None if remove else (stdio_entry() | {"type": "stdio"} if stdio else http_entry())
        lines += [_json_server(p, entry, force) for p in claude_code_paths(also)]
        if instructions or remove:
            lines.append(_instructions(Path.home() / ".claude" / "CLAUDE.md", remove))
    elif name == "claude-desktop":
        lines.append(_json_server(claude_desktop_path(), None if remove else stdio_entry(), force))
    elif name == "codex":
        lines.append(_codex_server(codex_home() / "config.toml", remove, force))
        if instructions or remove:
            lines.append(_instructions(codex_home() / "AGENTS.md", remove))
    else:
        raise ValueError(f"unknown client {name!r}; choose from {', '.join(CLIENTS)}")
    return lines


def _registered(name: str) -> tuple[Path, bool]:
    if name == "claude-code":
        path = claude_code_paths()[0]
        return path, SERVER in ((_read_json(path) or {}).get("mcpServers") or {})
    if name == "claude-desktop":
        path = claude_desktop_path()
        return path, SERVER in ((_read_json(path) or {}).get("mcpServers") or {})
    path = codex_home() / "config.toml"
    try:
        import tomllib

        doc = tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (ValueError, OSError):
        return path, False
    return path, SERVER in (doc.get("mcp_servers") or {})


def clients() -> list[dict]:
    """Which clients have hswarm registered, and where their config file is. Offline, read-only."""
    out = []
    for name in CLIENTS:
        path, on = _registered(name)
        out.append({"client": name, "config": str(path), "exists": path.exists(), "registered": on})
    return out


def detected_clients() -> list[str]:
    """The assistants installed on this machine, judged by their config folders or their commands on PATH."""
    found = []
    if (Path.home() / ".claude.json").exists() or (Path.home() / ".claude").is_dir() or shutil.which("claude"):
        found.append("claude-code")
    if claude_desktop_path().parent.is_dir():
        found.append("claude-desktop")
    if codex_home().is_dir() or shutil.which("codex"):
        found.append("codex")
    return found


def cmd_setup(a) -> int:
    """`hswarm setup`: the first run in one command, and what the installers end with. Registers hswarm with every
    assistant found here (Claude Code when none is), then opens the console, where the one thing left is a key."""
    from . import keys
    from .console import open_console

    chosen = getattr(a, "client", None) or detected_clients() or ["claude-code"]
    names = list(CLIENTS) if "all" in chosen else list(dict.fromkeys(chosen))
    for name in names:
        for line in install_client(name, instructions=getattr(a, "instructions", False)):
            print(line)
    config.ensure_dirs()
    if "claude-code" in names:
        ensure_cc_config()
    rc = open_console(getattr(a, "port", None), no_open=getattr(a, "no_open", False))
    labels = {"claude-code": "Claude Code", "claude-desktop": "Claude Desktop", "codex": "Codex"}
    print(f"\nConnected: {', '.join(labels[n] for n in names)}. Restart {'it' if len(names) == 1 else 'them'} "
          "(or open a new chat) to pick HydraSwarm up.")
    if not any(keys.pool_for(p) for p in config.PROVIDERS):
        print("Next: paste an API key in the console (Gemini, Groq and Cerebras have free tiers).")
    print('Then ask your assistant: "Use hswarm to ..."')
    return rc


def cmd_install(a) -> int:
    """`hswarm install [--client NAME|all] [--stdio] [--instructions] [--remove]`. Claude Code alone by default."""
    chosen = getattr(a, "client", None) or ["claude-code"]
    names = list(CLIENTS) if "all" in chosen else list(dict.fromkeys(chosen))
    remove = bool(getattr(a, "remove", False))
    for name in names:
        for line in install_client(name, stdio=getattr(a, "stdio", False), force=a.force, remove=remove,
                                   instructions=getattr(a, "instructions", False), also=a.also or ()):
            print(line)
    if remove:
        return 0
    config.ensure_dirs()
    if "claude-code" in names:
        print(f"worker Claude config dir: {ensure_cc_config()}")
    if getattr(a, "track_savings", False):
        print(schedule_savings())
    print("Restart the client (or open a new chat) to pick up the server. Check with: hswarm doctor. "
          "Manage keys and models with: hswarm ui")
    return 0
