"""The native transcript scanners (Rust and Go) behind claude_usage.collect, and how they are built,
chosen and run.

Why they exist: `hswarm savings` reads every Claude Code transcript on the machine (21 GB, 40k files
here, 2026-09-15) and the pure-Python scan is the one hot loop in this repo. native_ab.py runs
the same window through Python, Rust and Go, checks the three agree on every number, and writes the
winner (language and thread count) to ~/.hswarm/native/winner.json, a measurement of this machine.
`choose()` runs that winner when its binary is built (`python -m hswarm native build`; the sources are
in native/ beside this module) and falls back to Python otherwise, so a clone with no
cargo or go works unchanged. HSWARM_SCANNER=python|rust|go forces an arm; HSWARM_SCAN_THREADS a count.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import subprocess
from pathlib import Path

from . import claude_usage, config

NATIVE = Path(__file__).resolve().parent / "native"
BIN_DIR = NATIVE / "bin"
WINNER = config.HOME / "native" / "winner.json"
LANGS = ("rust", "go")
EXE = ".exe" if os.name == "nt" else ""
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
SOURCES = {"rust": NATIVE / "zscan-rs", "go": NATIVE / "zscan-go"}


def binary(lang: str) -> Path | None:
    p = BIN_DIR / f"zscan-{lang}{EXE}"
    return p if p.exists() else None


def winner() -> dict:
    try:
        return json.loads(WINNER.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def choose(requested: str | None = None) -> str:
    """python | rust | go: the explicit ask, else the env, else the recorded winner if its binary is built, else python."""
    want = (requested or os.environ.get("HSWARM_SCANNER") or "auto").strip().lower()
    if want == "python":
        return "python"
    if want in LANGS:
        if binary(want) is None:
            raise RuntimeError(f"scanner {want!r} requested but {BIN_DIR / ('zscan-' + want + EXE)} is not built; run: python -m hswarm native build")
        return want
    w = winner().get("lang")
    if w in LANGS and binary(w):
        return w
    return "python"


def threads(explicit: int | None = None) -> int:
    if explicit:
        return max(1, int(explicit))
    env = os.environ.get("HSWARM_SCAN_THREADS")
    if env and env.isdigit():
        return max(1, int(env))
    return max(1, int(winner().get("threads") or 1))


def prices_json() -> str:
    """The table on the scanners' stdin. A tiered row adds over_at (the prompt size its long-prompt rates start
    above) and over_in / over_out / over_read_x; a binary built before those fields ignores them."""
    rows = []
    for p, i, o, r, over in claude_usage.PRICES:
        row = {"prefix": p, "in": i, "out": o, "read_x": r}
        if over:
            row |= dict(zip(("over_at", "over_in", "over_out", "over_read_x"), over))
        rows.append(row)
    return json.dumps(rows)


def command(lang: str, root: Path, since: dt.date, until: dt.date, n_threads: int = 1) -> list[str]:
    exe = binary(lang)
    if exe is None:
        raise RuntimeError(f"{lang} scanner not built; run: python -m hswarm native build")
    return [str(exe), "--root", str(root), "--since", since.isoformat(), "--until", until.isoformat(), "--threads", str(n_threads)]


def _round_days(days: dict) -> dict:
    """The binaries emit unrounded floats; rounding happens here, once, so every arm prints the same digits."""
    for d in days.values():
        for k in ("claude_usd", "main_usd", "sub_usd"):
            d[k] = round(d[k], 4)
        d["agents"] = {fam: [round(u, 4) for u in v] for fam, v in d["agents"].items()}
        for entries in d.get("agent_tokens", {}).values():
            for a in entries:
                if isinstance(a.get("usd"), float):
                    a["usd"] = round(a["usd"], 4)
        for m in d.get("by_model", {}).values():
            for k in ("usd", "main_usd", "sub_usd"):
                m[k] = round(m[k], 4)
        for s in d.get("by_session", {}).values():
            s["usd"] = round(s["usd"], 4)
    return days


def log_stale(lang: str) -> None:
    """A built binary older than the fields the Python side now reads: say so once per scan, in the savings log,
    and carry on with Python (claude_usage.collect does the falling back)."""
    from . import savings

    savings.log(f"{lang} scanner is older than this checkout (no token counts or long-prompt tier in its output); scanning with Python. Rebuild: python -m hswarm native build")


def scan(lang: str, root: Path, since: dt.date, until: dt.date, n_threads: int | None = None) -> dict:
    """Run one native arm and return {"days": <collect() shape>, "stats": {...}, "threads": n}."""
    cmd = command(lang, root, since, until, threads(n_threads))
    r = subprocess.run(cmd, input=prices_json(), capture_output=True, text=True, encoding="utf-8", creationflags=CREATE_NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError(f"{lang} scanner failed ({r.returncode}): {r.stderr.strip()[:400]}")
    out = json.loads(r.stdout)
    out["days"] = _round_days(out.get("days") or {})
    return out


# ---- building ------------------------------------------------------------------------------------

def toolchain(tool: str) -> str | None:
    """`cargo` or `go` on PATH, else where its installer puts it: rustup's ~/.cargo/bin and Go's ~/go/bin,
    /usr/local/go/bin, C:/Program Files/Go/bin reach PATH only in a NEW shell, so a long-lived one misses them."""
    found = shutil.which(tool)
    if found:
        return found
    homes = [Path.home() / ".cargo" / "bin"] if tool == "cargo" else [
        Path.home() / "go" / "bin", Path("/usr/local/go/bin"), Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Go" / "bin"]
    return next((str(h / f"{tool}{EXE}") for h in homes if (h / f"{tool}{EXE}").is_file()), None)


def build_commands(lang: str) -> list[list[str]]:
    # rust-ci-speed: ci not applied: no GitHub CI by design, the gate is local (pytest); the only cargo call is this
    # release build and zscan-rs has no Rust tests. If it gains some, run `cargo test --no-fail-fast` here or in the gate.
    src = SOURCES[lang]
    if lang == "rust":
        return [[toolchain("cargo") or "cargo", "build", "--release", "--quiet", "--manifest-path", str(src / "Cargo.toml")]]
    return [[toolchain("go") or "go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(BIN_DIR / f"zscan-go{EXE}"), "."]]


def build(langs: tuple[str, ...] = LANGS) -> dict[str, str]:
    """Build each requested arm whose toolchain is present; returns lang -> where the binary landed (or why not)."""
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    out: dict[str, str] = {}
    for lang in langs:
        tool = "cargo" if lang == "rust" else "go"
        src = SOURCES[lang]
        if not src.exists():
            out[lang] = f"no source at {src}"
            continue
        if toolchain(tool) is None:
            out[lang] = f"{tool} not on PATH or at its installer's home; the Python scanner is used instead"
            continue
        for cmd in build_commands(lang):
            r = subprocess.run(cmd, cwd=src, capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
            if r.returncode != 0:
                out[lang] = f"build failed ({r.returncode}): {(r.stderr or r.stdout).strip()[-800:]}"
                break
        else:
            if lang == "rust":
                built = src / "target" / "release" / f"zscan{EXE}"
                shutil.copy2(built, BIN_DIR / f"zscan-rust{EXE}")
            out[lang] = str(binary(lang))
    return out


def main(argv: list[str] | None = None) -> int:
    """`hswarm native build [--langs rust,go]` and `hswarm native bench ...` (native_ab.py's own flags)."""
    import sys

    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("build", "bench"):
        print("usage: hswarm native build [--langs rust,go] | hswarm native bench [--days N --repeats N --threads N --arms ...]", file=sys.stderr)
        return 2
    if argv[0] == "build":
        langs = tuple(argv[argv.index("--langs") + 1].split(",")) if "--langs" in argv else LANGS
        for lang, where in build(langs).items():
            print(f"{lang}: {where}")
        return 0
    from .native_ab import main as bench_main

    return bench_main(argv[1:])
