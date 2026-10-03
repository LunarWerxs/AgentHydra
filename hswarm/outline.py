"""The `outline` and `unfold` worker tools: a folded symbol map of a code file, and the source of one
named symbol, so a worker stops paying for a whole-file read to find one function.

The idea is claude-mem's smart_outline / smart_unfold (Apache-2.0), written fresh without tree-sitter:
Python is parsed exactly with the stdlib `ast`, Markdown by its headings, and the brace languages by
braces.py. Nothing is installed per language.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import NamedTuple

from .braces import brace_symbols

LANGS = {
    ".py": "python", ".pyi": "python", ".md": "markdown", ".markdown": "markdown", ".go": "go", ".rs": "rust",
    **dict.fromkeys((".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"), "js"),
    **dict.fromkeys((".java", ".kt", ".kts", ".scala", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh",
                     ".swift", ".php", ".dart"), "c"),
}
MAX_BYTES = 5_000_000  # outline is the tool for big files, so it reads past read_file's whole-file limit
_SIG_CHARS = 160
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")


class Symbol(NamedTuple):
    name: str  # the dotted name unfold matches, e.g. "Sandbox.t_read_file"
    start: int  # 1-based, inclusive; a Python decorator counts as the start
    end: int
    depth: int


def language_of(path: str | Path) -> str | None:
    return LANGS.get(Path(path).suffix.lower())


def symbols(text: str, lang: str) -> list[Symbol]:
    lines = text.splitlines()
    if lang == "python":
        return _python(text)
    if lang == "markdown":
        return _markdown(lines)
    return [Symbol(*s) for s in brace_symbols(lines, lang)]


def _python(text: str) -> list[Symbol]:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError) as e:
        raise ValueError(f"cannot parse as Python ({e}); use grep and read_file slices") from None
    out: list[Symbol] = []

    def walk(body: list[ast.stmt], prefix: str, depth: int) -> None:
        for node in body:
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                start = min([node.lineno] + [d.lineno for d in node.decorator_list])
                out.append(Symbol(prefix + node.name, start, node.end_lineno or node.lineno, depth))
                if isinstance(node, ast.ClassDef):  # a function body stays folded, as in the brace languages
                    walk(node.body, prefix + node.name + ".", depth + 1)

    walk(tree.body, "", 0)
    return out


def _markdown(lines: list[str]) -> list[Symbol]:
    heads: list[tuple[int, int, str]] = []
    fence = None
    for i, line in enumerate(lines, 1):
        m = _FENCE.match(line)
        if m:  # a `# comment` inside a fenced code block is not a heading
            fence = None if fence == m.group(1) else (fence or m.group(1))
        elif not fence and (h := _HEADING.match(line)):
            heads.append((i, len(h.group(1)), h.group(2)))
    top = min((level for _, level, _ in heads), default=1)
    out = []
    for k, (i, level, title) in enumerate(heads):
        end = next((j - 1 for j, lv, _ in heads[k + 1 :] if lv <= level), len(lines))
        out.append(Symbol(title, i, end, level - top))
    return out


def _signature(lines: list[str], sym: Symbol, lang: str) -> str:
    """The declaration line itself: for Python the `def`/`class` line, not the decorator above it."""
    i = sym.start - 1
    if lang == "python":
        while i < sym.end - 1 and lines[i].lstrip().startswith("@"):
            i += 1
    return lines[i].strip()[:_SIG_CHARS] if i < len(lines) else sym.name


def _tokens(chars: int) -> str:
    return f"~{max(1, round(chars / 4))} tokens"


def render_outline(rel: str, text: str, lang: str) -> str:
    lines = text.splitlines()
    syms = symbols(text, lang)
    head = (f"{rel}: {len(lines)} lines, {_tokens(len(text))} read whole ({lang}); {len(syms)} symbols. "
            "unfold takes a name (dotted when nested, e.g. Class.method).")
    if not syms:
        return head + "\n(no symbols found; use grep and read_file slices)"
    return head + "\n" + "\n".join(f"{'  ' * s.depth}L{s.start}-{s.end} {_signature(lines, s, lang)}" for s in syms)


def _lead_start(lines: list[str], start: int, lang: str) -> int:
    """Pull the doc comment, attribute or annotation lines directly above a symbol into its unfold."""
    prefixes = {"python": ("#",), "markdown": ()}.get(lang, ("//", "/*", "*", "#[", "@"))
    i = start
    while prefixes and i > 1 and lines[i - 2].strip().startswith(prefixes):
        i -= 1
    return i


def render_unfold(rel: str, text: str, lang: str, symbol: str) -> str:
    lines = text.splitlines()
    syms = symbols(text, lang)
    want = (symbol or "").strip()
    low = want.lower()
    hits = ([s for s in syms if s.name == want] or [s for s in syms if s.name.endswith("." + want)]
            or [s for s in syms if s.name.lower() == low or s.name.lower().endswith("." + low)])
    if not hits:
        names = ", ".join(s.name for s in syms[:40]) or "(none)"
        raise ValueError(f"no symbol {want!r} in {rel}; symbols: {names}")
    sym = hits[0]
    lo = _lead_start(lines, sym.start, lang)
    body = "\n".join(f"{i}\t{lines[i - 1]}" for i in range(lo, min(sym.end, len(lines)) + 1))
    more = "; ".join(f"L{s.start}-{s.end} {s.name}" for s in hits[1:11])
    return f"{rel} L{lo}-{sym.end} {sym.name}\n{body}" + (f"\n(also: {more})" if more else "")
