"""The brace-language half of the outline tools: find declarations in JS/TS, Go, Rust and the C family
without a parser, and the line range each one's `{ ... }` block covers.

Why not tree-sitter: hswarm installs nothing per language and a clone is the install. So each line is
first masked (comments and string literals blanked, so a "}" in a string never closes a block), then
matched against a few declaration shapes, and a declaration's range is its brace-matched block. It is
a heuristic that can miss an exotic declaration; it never invents source, because unfold returns the
real lines on disk. Function bodies are folded (skipped), so a local helper or a call inside one is
never mistaken for a top-level symbol; class-like containers are scanned for their members.
"""
from __future__ import annotations

import re

_MODS = (
    r"(?:(?:export|default|declare|public|private|protected|internal|static|abstract|final|sealed|open|override|"
    r"async|unsafe|const|extern|inline|virtual|partial|readonly|pub(?:\([^)]*\))?|data|suspend)\s+)*"
)
_CONTAINER = re.compile(
    _MODS + r"(?:class|struct|interface|trait|enum|union|record|object|protocol|extension|namespace|module|mod|impl)\b"
    r"(?:\s*<[^{]*?>)?\s+(?P<name>[\w$.:]+)(?:\s*<[^{]*?>)?(?:\s+for\s+(?P<for>[\w$.:]+))?"
)
_FUNCTION = re.compile(_MODS + r"(?:function\*?|fn|func|fun|def)\s+(?:\((?P<recv>[^)]*)\)\s*)?(?P<name>[A-Za-z_$][\w$.]*)")
_TYPE = re.compile(r"(?:export\s+)?(?:declare\s+)?type\s+(?P<name>[\w$]+)")
_JS_CONST = re.compile(
    r"(?:export\s+)?(?:const|let|var)\s+(?P<name>[\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?"
    r"(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+?)?\s*=>)"
)
# A method or C-style function: `[modifiers and types] name(args) [: ret | -> ret | const] {`. It only
# counts when a brace block really follows, which is what separates it from a call.
_METHOD = re.compile(
    r"(?:[\w$<>\[\],.*&?:@~]+\s+)*?[*&]*(?P<name>[A-Za-z_$~][\w$]*(?:::~?[A-Za-z_]\w*)*)\s*(?:<[^()]*?>)?\s*"
    r"\((?:[^()]*(?:\([^()]*\)[^()]*)*)\)\s*[^;{}=]*?\s*\{?\s*$"
)
_CONTROL = {
    "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "using", "lock", "foreach", "synchronized",
    "with", "new", "await", "throw", "case", "sizeof", "typeof", "function", "match", "loop", "defer", "go", "select",
    "when", "guard", "yield", "delete", "in", "of", "fixed", "checked", "unchecked",
}
_RUST_CHAR = re.compile(r"'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'")
_CONT_END = (",", "(", "<", ":", "=", "=>", "->", "|", "&", "where")
_CONT_START = ("{", "extends", "implements", "where", ":", ",", "->", "throws", "|", "&", ")")
_HEAD_LINES = 12  # how far a multi-line signature may run before its `{`
_MAX_LINE = 400  # a longer line is minified code: never a declaration worth listing


def mask(lines: list[str], lang: str) -> list[str]:
    """The lines with comments and string literals blanked out; only code structure is left."""
    out: list[str] = []
    block = False
    quote = None
    for line in lines:
        buf: list[str] = []
        i, n = 0, len(line)
        while i < n:
            c = line[i]
            if block:
                block = not line.startswith("*/", i)
                i += 1 if block else 2
            elif quote:
                if c == quote:
                    quote = None
                i += 2 if c == "\\" else 1
            elif line.startswith("//", i):
                break
            elif line.startswith("/*", i):
                block, i = True, i + 2
            elif c == "'" and lang == "rust":
                m = _RUST_CHAR.match(line, i)  # a char literal; otherwise a lifetime such as 'a
                buf.append(" " if m else c)
                i = m.end() if m else i + 1
            elif c in "\"'`":
                quote, i = c, i + 1
                buf.append(" ")
            else:
                buf.append(c)
                i += 1
        if quote and quote != "`":
            quote = None  # only a template or raw string spans lines; a stray quote must not swallow the file
        out.append("".join(buf))
    return out


def _declaration(s: str, lang: str) -> tuple[str, str] | None:
    """(kind, name) of the declaration a masked, stripped line opens, or None."""
    if not s or len(s) > _MAX_LINE or s[0] in "{}()#@*":
        return None
    m = _CONTAINER.match(s)
    if m:
        return "container", (m["for"] or m["name"]).rstrip(":").replace("::", ".")
    m = _TYPE.match(s) if lang in ("go", "js") else None
    if m:
        return "type", m["name"]
    m = _FUNCTION.match(s)
    if m:
        recv = (m["recv"] or "").split()
        # A Go method is named by its receiver type, so `unfold Server.Handle` finds it.
        return "function", (recv[-1].lstrip("*").split("[")[0] + "." if recv else "") + m["name"]
    m = _JS_CONST.match(s) if lang == "js" else None
    if m:
        return "function", m["name"]
    m = _METHOD.match(s) if lang not in ("go", "rust") else None
    if m and m["name"] not in _CONTROL and s.split(None, 1)[0].split("(")[0] not in _CONTROL:
        return "method", m["name"].replace("::", ".")
    return None


def _match(masked: list[str], j: int, k: int) -> int:
    depth = 0
    for jj in range(j, len(masked)):
        for c in masked[jj][k:] if jj == j else masked[jj]:
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return jj
    return len(masked) - 1  # unbalanced: run to the end rather than hide the tail


def _block_end(masked: list[str], i: int) -> int | None:
    """0-based last line of the block the declaration on line i opens, or None when it opens none."""
    paren = 0
    for j in range(i, min(len(masked), i + _HEAD_LINES)):
        for k, c in enumerate(masked[j]):
            if c in "([":
                paren += 1
            elif c in ")]":
                paren = max(0, paren - 1)
            elif paren == 0 and c in ";}":
                return None
            elif paren == 0 and c == "{":
                return _match(masked, j, k)
        nxt = next((s.strip() for s in masked[j + 1 : j + 4] if s.strip()), "")
        if not (paren or nxt.startswith(_CONT_START) or masked[j].strip().endswith(_CONT_END)):
            return None
    return None


def brace_symbols(lines: list[str], lang: str) -> list[tuple[str, int, int, int]]:
    """(qualified name, start, end, depth) per declaration; lines are 1-based and inclusive."""
    masked = mask(lines, lang)
    out: list[tuple[str, int, int, int]] = []
    stack: list[tuple[int, str]] = []  # (last line, name) of each open container
    i = 0
    while i < len(lines):
        while stack and i > stack[-1][0]:
            stack.pop()
        hit = _declaration(masked[i].strip(), lang)
        if hit is None:
            i += 1
            continue
        kind, name = hit
        end = _block_end(masked, i)
        if end is None and kind == "method":
            i += 1  # no block follows: a call or a prototype, not a definition
            continue
        end = i if end is None else end
        out.append((".".join([n for _, n in stack] + [name]), i + 1, end + 1, len(stack)))
        if kind == "container" and end > i:
            stack.append((end, name))
            i += 1
        else:
            i = end + 1
    return out
