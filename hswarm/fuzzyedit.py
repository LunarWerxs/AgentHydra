"""Tolerant old_string location for edit_file: a line-level edit-distance match plus reindent.

edit_file tries the exact substring first. When that has no hit, the usual cause is drift in a block
the worker copied from read_file - indentation, trailing spaces, an LF old_string against a CRLF file -
and a cheap worker burns turns retrying it. This module finds the block the model meant, line by line,
and reindents new_string to that block. It is deliberately conservative: a short old_string must match
every line (whitespace aside), a longer one tolerates about one wrong line in five, and two equally good
blocks are refused rather than guessed. Idea after Zed's streaming fuzzy matcher (asymmetric line costs,
a similarity bar for "the same line", reindent by the indent delta); written fresh for hswarm.
"""
from __future__ import annotations

import difflib
from collections import Counter
from dataclasses import dataclass

# Lines equal once whitespace runs are collapsed cost 0. A near-equal pair (difflib ratio >= SIMILAR)
# costs 1, a dissimilar pair 2, a file line inside the block that old_string left out 6, an old_string
# line with no file line at all 20: the 1 : 3 : 10 replace/insert/delete ratio, doubled to make room for
# the near-equal step. Leaving lines out, or inventing them, is a stronger sign of the wrong block than a
# line the model half-remembers; and "return 5" against "return 2" is near-equal, never free.
SIMILAR_COST = 1
REPLACE_COST = 2
SKIP_FILE_LINE_COST = 6
SKIP_QUERY_LINE_COST = 20
SIMILAR = 0.8
# A block is accepted only while its cost stays within 2 units (one wrong line) per this many old_string
# lines, so a one- or two-line old_string must match every line bar whitespace.
LINES_PER_COST = 5
# Past this many line pairs the table is too slow for a tool call; the exact-match error stands. It runs
# synchronously on the event loop every api worker shares, so the cap bounds how long one edit can stall
# them all (a 20-line old_string still covers a 10k-line file).
MAX_CELLS = 200_000
# near_line breaks a tie only between candidates this close to it.
NEAR_LINE_WINDOW = 200


@dataclass
class Block:
    start: int  # 0-based index of the first file line in the block
    end: int  # exclusive
    cost: int


def _norm(line: str) -> str:
    return " ".join(line.split())


def _indent(line: str) -> str:
    return line[: len(line) - len(line.lstrip())]


class _PairCost:
    """The cost of aligning two normalized lines, memoized: the same pair recurs across a repetitive file."""

    def __init__(self) -> None:
        self.memo: dict[tuple[str, str], int] = {}

    def __call__(self, a: str, b: str) -> int:
        if a == b:
            return 0
        if not a or not b or 2 * min(len(a), len(b)) < SIMILAR * (len(a) + len(b)):
            return REPLACE_COST  # the length bound alone rules out near-equal; skip building a matcher
        hit = self.memo.get((a, b))
        if hit is None:
            sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
            hit = SIMILAR_COST if sm.quick_ratio() >= SIMILAR and sm.ratio() >= SIMILAR else REPLACE_COST
            self.memo[(a, b)] = hit
        return hit


def find_blocks(file_lines: list[str], query_lines: list[str]) -> list[Block]:
    """Every lowest-cost file block the query lines align to, or [] when none is within tolerance."""
    q = [_norm(s) for s in query_lines]
    f = [_norm(s) for s in file_lines]
    m, n = len(q), len(f)
    if not m or not n or not any(q) or m * n > MAX_CELLS:
        return []
    limit = REPLACE_COST * m // LINES_PER_COST
    pair_cost = _PairCost()
    # Row i holds, for each file position j, the cheapest alignment of q[:i] onto a block ending at j,
    # and where that block starts. Row 0 is free: a block may start anywhere.
    prev_cost = [0] * (n + 1)
    prev_start = list(range(n + 1))
    for i in range(1, m + 1):
        cost = [i * SKIP_QUERY_LINE_COST] + [0] * n
        start = [0] * (n + 1)
        line = q[i - 1]
        for j in range(1, n + 1):
            best, origin = prev_cost[j] + SKIP_QUERY_LINE_COST, prev_start[j]
            left = cost[j - 1] + SKIP_FILE_LINE_COST
            if left < best:
                best, origin = left, start[j - 1]
            diag = prev_cost[j - 1]
            # Costs only grow along a path, so a pair already past the limit never needs comparing.
            if diag <= limit and diag <= best:
                diag += pair_cost(line, f[j - 1])
                if diag <= best:
                    best, origin = diag, prev_start[j - 1]
            cost[j], start[j] = best, origin
        prev_cost, prev_start = cost, start
    best = min(prev_cost[1:])
    if best > limit:
        return []
    return [Block(prev_start[j], j, best) for j in range(1, n + 1) if prev_cost[j] == best]


def pick_nearest(lines: list[int], near_line: int | None) -> int | None:
    """Index of the one candidate (by 1-based line) nearest near_line, or None when that is not clear-cut."""
    if len(lines) == 1:
        return 0
    if not near_line:
        return None
    ranked = sorted(range(len(lines)), key=lambda k: abs(lines[k] - near_line))
    first, second = (abs(lines[k] - near_line) for k in ranked[:2])
    return ranked[0] if first <= NEAR_LINE_WINDOW and first < second else None


def _indent_pairs(query: list[str], block: list[str]) -> list[tuple[int, str, str]]:
    """(query line index, its indent, the block's indent) for each line pair that has text; one first-line pair when
    the line counts differ."""
    if len(query) == len(block):
        return [(k, _indent(a), _indent(b)) for k, (a, b) in enumerate(zip(query, block)) if a.strip() and b.strip()]
    first = [next((s for s in lines if s.strip()), "") for lines in (query, block)]
    return [(-1, _indent(first[0]), _indent(first[1]))]


def _mid_line_start(query: list[str]) -> bool:
    """A first line typed with no indent above indented lines: the model started its copy mid-line."""
    return bool(query and query[0].strip() and not _indent(query[0]) and any(_indent(s) for s in query[1:] if s.strip()))


def _shift(new_lines: list[str], from_ws: str, to_ws: str) -> list[str]:
    if from_ws == to_ws:
        return list(new_lines)
    return [to_ws + s[len(from_ws) :] if s.strip() and s.startswith(from_ws) else s for s in new_lines]


def _reindent(new_lines: list[str], query: list[str], block: list[str]) -> tuple[list[str], str, str]:
    """Shift new_string by the indent old_string was off from the block it matched; returns (lines, from, to)."""
    pairs = _indent_pairs(query, block)
    # A first line typed with no indent above indented lines is the model starting its copy mid-line, not
    # a shift of the whole block: judge the shift by the other lines, and give that line the file's indent.
    artifact = _mid_line_start(query)
    if artifact and len(pairs) > 1 and pairs[0][0] == 0:
        pairs = pairs[1:]
    shifts = Counter((a, b) for _, a, b in pairs)
    from_ws, to_ws = shifts.most_common(1)[0][0] if shifts else ("", "")
    out = _shift(new_lines, from_ws, to_ws)
    if artifact and out and out[0].strip() and not _indent(out[0]) and block:
        out[0] = _indent(block[0]) + out[0]
    return out, from_ws, to_ws


def fuzzy_replace(text: str, old_string: str, new_string: str, near_line: int | None = None) -> tuple[str, str]:
    """Replace the one block old_string means; returns (new text, a note for the tool result).

    Raises ValueError when no block is close enough or several are equally close.
    """
    lines = text.splitlines(keepends=True)
    bare = [s.rstrip("\r\n") for s in lines]
    query = old_string.splitlines()
    blocks = find_blocks(bare, query)
    if not blocks:
        raise ValueError(
            "old_string not found in file (no exact match, and no block within whitespace/near-match tolerance); "
            "read_file the region again and copy it exactly"
        )
    chosen = pick_nearest([b.start + 1 for b in blocks], near_line)
    if chosen is None:
        spans = ", ".join(f"{b.start + 1}-{b.end}" for b in blocks[:5])
        raise ValueError(
            f"old_string is not exact and near-matches {len(blocks)} blocks equally (lines {spans}); "
            "include more context, or pass near_line"
        )
    block = blocks[chosen]
    span = lines[block.start : block.end]
    # Write the file's own line ending, whatever the model typed: an LF new_string in a CRLF file must not mix them.
    eol = next((s[len(s.rstrip("\r\n")) :] for s in span if s.endswith("\n")), "\r\n" if "\r\n" in text else "\n")
    new_lines, from_ws, to_ws = _reindent(new_string.splitlines(), query, bare[block.start : block.end])
    replacement = eol.join(new_lines)
    if new_lines and span and span[-1] != bare[block.end - 1]:
        replacement += eol  # the block ended with a line break; keep the line after it on its own line
    note = f"near match at lines {block.start + 1}-{block.end}"
    if from_ws != to_ws:
        note += f", new_string reindented {from_ws!r} -> {to_ws!r}"
    if block.cost:
        # A non-zero cost means more than whitespace differed and was replaced unseen; name where, so the worker checks it.
        matched = bare[block.start : block.end]
        if len(query) == len(matched):
            off = [str(block.start + 1 + k) for k, (a, b) in enumerate(zip(query, matched)) if _norm(a) != _norm(b)]
            note += f"; file line{'s' if len(off) > 1 else ''} {', '.join(off)} differed from old_string beyond whitespace, check the result"
        else:
            note += f"; old_string had {len(query)} lines against {len(matched)} in the file, check the result"
    return "".join(lines[: block.start]) + replacement + "".join(lines[block.end :]), note
