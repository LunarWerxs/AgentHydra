"""Fuzzy title matching: how `--title` finds a chat whose exact title the caller only half remembers.
Shared by migrate_chat (the table lookup) and automation_chat (the same rule for its own title match)."""

import difflib
import re

# Fuzzy title matching: every query word must match some title word at least this closely
# (difflib ratio), OR the whole normalized query must match the whole title this closely.
# 0.8 lets one letter-pair slip in a nine-letter word ("arkitecht"/"arkitekt" = 0.82) and
# still rejects "cleanup" against "expansion" (0.25).
FUZZY_WORD_RATIO = 0.8
FUZZY_WHOLE_RATIO = 0.85
# Two candidates whose scores are this close are a tie, and a tie is a refusal, not a pick.
FUZZY_TIE_MARGIN = 0.05


def _norm_title(text: str) -> str:
    """Lower-case, punctuation folded to spaces, whitespace collapsed - the shape both sides
    of a fuzzy comparison are put in, so case and punctuation can never be the difference."""
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def fuzzy_title_score(query: str, title: str) -> float:
    """0.0-1.0: how well `query` names `title`. 1.0 is a normalized substring (the old exact
    rule); below that, the weaker of (a) every query word's best match against a title word
    and (b) the whole-string ratio - whichever criterion the pair clears. A query with a word
    that matches NOTHING in the title ("cleanup" vs "...design critic expansion") scores that
    word's ratio, well under the bar, so a misspelling is forgiven but a different chat is not."""
    q, t = _norm_title(query), _norm_title(title)
    if not q or not t:
        return 0.0
    if q in t:
        return 1.0
    words = t.split()
    per_word = [max((difflib.SequenceMatcher(None, qw, tw).ratio() for tw in words), default=0.0)
                for qw in q.split()]
    word_score = min(per_word) if per_word else 0.0
    whole = difflib.SequenceMatcher(None, q, t).ratio()
    if word_score >= FUZZY_WORD_RATIO or whole >= FUZZY_WHOLE_RATIO:
        return max(word_score, whole)
    return min(word_score, whole)


def _fuzzy_pick(query: str, rows: list[dict]) -> list[dict]:
    """The sessions-table rows `query` names fuzzily: the best-scoring chat alone when it is
    clearly best, every tied chat when it is not (the caller refuses on more than one), and
    nothing when nothing clears the bar. Rows are the daemon's (`title`, `session_id`)."""
    scored = []
    for r in rows:
        s = fuzzy_title_score(query, str(r.get("title") or ""))
        if s >= FUZZY_WORD_RATIO:
            scored.append((s, r))
    if not scored:
        return []
    scored.sort(key=lambda x: -x[0])
    best = scored[0][0]
    top = [r for s, r in scored if best - s <= FUZZY_TIE_MARGIN]
    # The same chat can sit on several rows only through lineage ids; distinct session ids
    # are distinct chats, and one chat at the top is the answer even if it tied with itself.
    if len({r.get("session_id") for r in top}) == 1:
        return top[:1]
    return top
