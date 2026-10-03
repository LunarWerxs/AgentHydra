"""Capability files: one reviewable grant per `api` worker - which tools it may call, and which paths they may touch.

WHY: a tool preset (read | edit | all) is all-or-nothing over the whole cwd. A worker told to write one docs page got
write_file over the entire checkout, including .secrets/ and every source file other sessions commit from, and the
only record of what it was allowed was the preset name. A capability says it in one file a reviewer can read:

    {"identifier": "docs-writer",
     "description": "reads the repo, writes only under docs/",
     "permissions": ["read", {"identifier": "write_file", "allow": ["docs/**"]}, "deny-bash"],
     "deny": [".secrets/**", "**/.env"]}

The shape follows Tauri's ACL capabilities (tauri-apps/tauri, crates/tauri-utils/src/acl, MIT OR Apache-2.0; idea
only, written fresh for hswarm): a permission is a preset, a tool, or a generated `allow-<tool>` / `deny-<tool>`
identifier, a permission may narrow its own path scope inline, and deny always beats allow. The Sandbox (tools.py)
enforces it; the resolved grant is stored on the task, so job.json records exactly what each worker could do.
"""
from __future__ import annotations

import functools
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import config
from .toolspecs import PRESETS, SPECS

# Tools that take a path argument. bash takes a command line, which no glob can scope.
PATH_TOOLS = ("read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "outline", "unfold")
WRITE_TOOLS = ("write_file", "edit_file")
# A worker's write tools must never rewrite the grant that a later task will be handed: capability files are written by
# people. Checked under EVERY sandbox root and this machine's own folder, not just the cwd (see grant_dirs).
GRANT_FILES = ".hswarm/capabilities"
_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
_CASELESS = os.name == "nt"


def known_permissions() -> list[str]:
    """Every identifier a capability may name. allow-/deny- pairs are generated from the tool catalogue, so a new
    worker tool gets them the moment it lands in toolspecs.SPECS and nobody writes them by hand."""
    return sorted(PRESETS) + sorted(SPECS) + [f"{verb}-{t}" for t in sorted(SPECS) for verb in ("allow", "deny")]


@functools.lru_cache(maxsize=512)  # permits() runs per hit of glob, list_dir and grep; compile each glob once
def glob_regex(pattern: str) -> re.Pattern:
    """A path glob as a regex over '/'-separated paths: `**` crosses directories, `*` and `?` stay inside one,
    and a trailing `/**` also matches the directory itself (so `docs/**` covers listing `docs`)."""
    pat = pattern.replace("\\", "/").strip()
    out, i = [], 0
    while i < len(pat):
        if pat.startswith("/**", i) and i + 3 == len(pat):
            out.append("(?:/.*)?")
            i += 3
        elif pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif pat[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pat[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    return re.compile("".join(out) + r"\Z", re.IGNORECASE if _CASELESS else 0)


@dataclass(frozen=True)
class Scope:
    allow: tuple[str, ...] = ("**",)
    deny: tuple[str, ...] = ()

    def _hits(self, globs: tuple[str, ...], names: list[str]) -> bool:
        return any(glob_regex(g).match(n) for g in globs for n in names)

    def denies(self, names: list[str]) -> bool:
        return self._hits(self.deny, names)

    def permits(self, names: list[str]) -> bool:
        return self._hits(self.allow, names) and not self.denies(names)  # deny always beats allow


@dataclass(frozen=True)
class Capability:
    identifier: str
    description: str = ""
    tools: tuple[str, ...] = ()
    scopes: dict[str, Scope] = field(default_factory=dict)

    @property
    def scoped(self) -> bool:
        return any(s != Scope() for s in self.scopes.values())

    def grants(self, tool: str) -> bool:
        return tool in self.tools

    def _names(self, path: Path, cwd: Path) -> list[str]:
        """The spellings a glob is matched against: relative to cwd when the path is under it, and always absolute."""
        names = [path.as_posix()]
        try:
            names.insert(0, path.relative_to(cwd).as_posix() or ".")
        except ValueError:
            pass
        return names

    def permits(self, tool: str, path: Path, cwd: Path, roots: list[Path] | None = None) -> bool:
        if tool in WRITE_TOOLS and is_grant_file(path, [cwd] + list(roots or [])):
            return False
        return self.scopes.get(tool, Scope()).permits(self._names(path, cwd))

    def denies(self, tool: str, path: Path, cwd: Path) -> bool:
        return self.scopes.get(tool, Scope()).denies(self._names(path, cwd))

    def as_dict(self) -> dict:
        """The normalised grant: one entry per tool with its full scope. Loading it again yields the same grant."""
        return {"identifier": self.identifier, "description": self.description,
                "permissions": [{"identifier": t, "allow": list(self.scopes[t].allow), "deny": list(self.scopes[t].deny)}
                                if t in self.scopes else t for t in self.tools]}

    @staticmethod
    def from_dict(d: dict) -> "Capability":
        if not isinstance(d, dict):
            raise ValueError("a capability is a JSON object: {identifier, description?, permissions, allow?, deny?}")
        ident = str(d.get("identifier") or "inline")
        unknown = set(d) - {"identifier", "description", "permissions", "allow", "deny"}
        if unknown:
            raise ValueError(f"capability {ident}: unknown fields {sorted(unknown)}")
        base_allow, base_deny = _globs(d.get("allow"), ident, ("**",)), _globs(d.get("deny"), ident, ())
        granted: list[str] = []
        denied: set[str] = set()
        inline: dict[str, list[dict]] = {}
        for p in d.get("permissions") or []:
            _read_permission(p, ident, granted, denied, inline)
        tools = tuple(t for t in granted if t not in denied)  # deny-<tool> beats every grant of it
        scopes = _path_scopes(tools, inline, ident, base_allow, base_deny)
        cap = Capability(ident, str(d.get("description") or ""), tools, {t: s for t, s in scopes.items() if s != Scope()})
        if cap.scoped and "bash" in tools:
            raise ValueError(f"capability {ident}: grants bash alongside a path scope, and a shell command can reach any "
                             "path, so the scope would be a promise the sandbox cannot keep; add \"deny-bash\" or drop the scope")
        return cap


def _read_permission(p, ident: str, granted: list[str], denied: set[str], inline: dict[str, list[dict]]) -> None:
    """Fold one `permissions` entry into the grant being built: its tools, a deny-<tool>, or an inline scope."""
    name = p.get("identifier") if isinstance(p, dict) else p
    if not isinstance(name, str) or name not in known_permissions():
        raise ValueError(f"capability {ident}: unknown permission {name!r}; known: {known_permissions()}")
    if name.startswith("deny-"):
        denied.add(name[5:])
        return
    # `in`, not `or`: the "none" preset is an empty list, and must grant nothing rather than a tool called "none".
    names = PRESETS[name] if name in PRESETS else [name.removeprefix("allow-")]
    granted += [t for t in names if t not in granted]
    if isinstance(p, dict) and (set(p) - {"identifier"}):
        if name in PRESETS or set(p) - {"identifier", "allow", "deny"}:
            raise ValueError(f"capability {ident}: only a single tool takes an inline allow/deny scope, not {p}")
        inline.setdefault(name.removeprefix("allow-"), []).append(p)


def _path_scopes(tools: tuple[str, ...], inline: dict[str, list[dict]], ident: str,
                 base_allow: tuple[str, ...], base_deny: tuple[str, ...]) -> dict[str, Scope]:
    """Each granted path tool's scope: its inline allow (else the capability's), plus every deny that applies."""
    scopes: dict[str, Scope] = {}
    for t in tools:
        if t not in PATH_TOOLS:
            continue
        own = inline.get(t, [])
        allow = tuple(g for p in own for g in _globs(p.get("allow"), ident, ())) or base_allow
        deny = tuple(dict.fromkeys(base_deny + tuple(g for p in own for g in _globs(p.get("deny"), ident, ()))))
        scopes[t] = Scope(allow=allow, deny=deny)
    return scopes


def is_grant_file(path: Path, roots: list[Path]) -> bool:
    """Whether a (resolved) path is inside a folder capabilities are loaded from: <root>/.hswarm/capabilities/ for any
    sandbox root, or ~/.hswarm/capabilities/. Path comparison, so Windows' case-insensitivity is honoured."""
    grant_dirs = [Path(r) / GRANT_FILES for r in roots] + [(config.HOME / "capabilities").resolve()]
    return any(path == d or d in path.parents for d in grant_dirs)


def _globs(value, ident: str, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    if isinstance(value, str) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ValueError(f"capability {ident}: allow/deny is a list of path globs, got {value!r}")
    return tuple(v.strip() for v in value)


def from_tools(tools: str | list[str] | None) -> Capability:
    """The grant a plain `tools` preset or comma list has always meant: those tools, anywhere under the roots."""
    names = tools if isinstance(tools, list) else PRESETS.get(tools or "read", [n.strip() for n in (tools or "").split(",") if n.strip()])
    return Capability.from_dict({"identifier": tools if isinstance(tools, str) else "tools", "permissions": list(names)})


def search_paths(name: str, cwd: str) -> list[Path]:
    """Where a named capability lives: the workspace's own .hswarm/capabilities/ first, then this machine's."""
    return [Path(cwd) / ".hswarm" / "capabilities" / f"{name}.json", config.HOME / "capabilities" / f"{name}.json"]


def resolve(spec: str | dict, cwd: str) -> Capability:
    """A task's `capability`: an inline object, a preset name, a .json path (relative to cwd), or a named file."""
    if isinstance(spec, dict):
        return Capability.from_dict(spec)
    spec = str(spec).strip()
    if spec in PRESETS:
        return from_tools(spec)
    if spec.endswith(".json") or "/" in spec or "\\" in spec:
        candidates = [Path(spec) if Path(spec).is_absolute() else Path(cwd) / spec]
    elif _NAME.match(spec):
        candidates = search_paths(spec, cwd)
    else:
        raise ValueError(f"capability {spec!r} is not a preset, a .json path or a plain name")
    for path in candidates:
        if path.is_file():
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                raise ValueError(f"capability file {path.as_posix()} is not valid JSON: {e}") from e
            return Capability.from_dict({**doc, "identifier": doc.get("identifier") or spec} if isinstance(doc, dict) else doc)
    raise ValueError(f"capability {spec!r} not found; looked in {[p.as_posix() for p in candidates]}")
