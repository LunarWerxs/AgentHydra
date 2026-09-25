"""livenesslib - WHAT A STOPPED TURN AMOUNTS TO: done, moving, stalled on a plan, or blocked.

WHY THIS EXISTS (2026-09-25). The gate already knows a finished chat is not done - its recap
does not claim it, it asks, it offers, it still recommends - and sends it to the wake lane.
What it could not say is WHICH kind of not-done it is, and the right move differs:

  plan_only       it replied with a plan ("I'll inspect...", "Next steps:") and called no tool
                  in that turn. Nothing happened. One bounded "go ahead" is the cure.
  blocked         it is waiting on something only a person can give: a key, a login, access.
                  Nudging it again is a wasted turn; a human has to act.
  needs_approval  it asked for sign-off or review before going on. A person decides.
  advanced        it did real work this turn (tool calls) but did not claim done.
  completed       its recap claims done and nothing is asked, offered or recommended.
  needs_followup  none of the above: a reply with no work behind it and no claim of done.

Pure functions over text the gate already read, plus one evidence counter (tool calls in the
final turn). No I/O, no daemon, no AI. The idea and the state names follow paperclip's
run-liveness classifier (paperclipai/paperclip, MIT); written fresh for this toolbox.
"""

from __future__ import annotations

import re

# Longest next-action string kept; the evidence it came from is kept whole elsewhere.
NEXT_ACTION_CAP = 200

# ORDER IS PRECEDENCE. A person-shaped wait beats every other reading: calling a chat that is
# blocked on a key "plan_only" would nudge it into asking for the key again.
STATES = ("blocked", "needs_approval", "plan_only", "completed", "advanced", "needs_followup")

# An EXTERNAL blocker, phrased in the first person as a wait on something the chat cannot get
# itself. Bare words ("token", "permission denied", "401") are deliberately NOT enough: a chat
# that FIXED an auth bug describes them in its summary, and reading that as blocked would send
# finished work to a person.
_SECRET = (r"(?:api[- ]?keys?|access keys?|secrets?|tokens?|credentials?|passwords?|ssh keys?"
           r"|permissions?|access|a login)")
BLOCKER = re.compile(
    r"\b(?:i(?:'m| am) (?:currently |still )?blocked|blocked (?:on|until)"
    r"|blocked by (?:a |the )?(?:missing|lack)"
    r"|can(?:not|'t|\s+not) (?:proceed|continue|go (?:any )?further) (?:without|until)"
    r"|unable to (?:proceed|continue) (?:without|until)"
    r"|(?:i|we) (?:still )?(?:need|require) (?:an? |the |your |valid |working )?" + _SECRET +
    r"|need you to (?:provide|add|set|grant|share|log in|sign in|approve access)"
    r"|(?:i'm|i am|the cli is|it is) not (?:logged|signed) in"
    r"|waiting (?:on|for) you to (?:provide|add|set|grant|share|log|sign))\b",
    re.IGNORECASE,
)

# A request for SIGN-OFF, not an offer to carry on (gatelib.OFFER_TO_CONTINUE owns those): the
# chat will not go on until a person approves or reviews what it has.
APPROVAL = re.compile(
    r"\b(?:(?:need|awaiting|waiting (?:on|for)|require|requires|pending) (?:your |an? |the )?"
    r"(?:approval|sign-?off|go-?ahead|confirmation|review)"
    r"|please (?:review|approve|confirm)|ready for (?:your )?review"
    r"|(?:can|could) you (?:review|approve|sign off)"
    r"|(?:ok|okay) to (?:proceed|merge|push|deploy)\?)",
    re.IGNORECASE,
)

# PLANNING-ONLY phrasing: the reply says what it WILL do. Only ever decisive together with zero
# tool calls in the turn - a working chat says "I'll now run the tests" all day long.
# The word boundary sits only on the alternatives that end in a word: the colon-ended ones
# ("Plan:", "Next steps:") are usually followed by a space or a newline, where no \b exists.
PLANNING = re.compile(
    r"(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:(?:i'?ll|i will|i'm going to|i am going to|let me(?! know)"
    r"|first,? i'?ll|my plan|here'?s (?:my|the) plan|#+ *next steps?"
    r"|the approach|i'?d start by"
    r"|i (?:plan|intend) to)\b"
    r"|plan:|next steps?:)",
    re.IGNORECASE,
)

# "Next step: X", "**Next action** - X", "## Next steps" followed by a bullet. A plain line
# needs its colon or dash (or a heading/bold marker): "Next steps are unclear" is prose.
_NEXT_HEADER = re.compile(
    r"^[ \t]*(?:#+[ \t]*(?:\*\*)?next (?:steps?|actions?)(?:\*\*)?[ \t]*(?:[:\-][ \t]*(?:\*\*)?)?"
    r"|\*\*next (?:steps?|actions?)[ \t]*:?\*\*[ \t]*(?:[:\-][ \t]*)?"
    r"|next (?:steps?|actions?)[ \t]*[:\-][ \t]*(?:\*\*)?)[ \t]*(.*)$",
    re.IGNORECASE | re.MULTILINE,
)
# "Let me know if..." is a sign-off, not a plan, so it is excluded here and in PLANNING.
_WILL_SENTENCE = re.compile(r"\b(?:i'?ll|i will|i'm going to|let me(?! know))\b[^.\n]*",
                            re.IGNORECASE)


def turn_tool_calls(records: list[dict]) -> int:
    """Tool calls the assistant made since the last prompt a person (or a lane) sent: the
    durable evidence that the turn DID something. Tool results and app plumbing are user-role
    records too, so they do not end the walk. A tail read that never reaches the prompt gives a
    lower bound, which only ever errs towards "advanced" once any call is seen."""
    calls = 0
    for r in reversed(records):
        if r.get("type") == "user":
            if r.get("has_tool_result") or r.get("meta") or r.get("local_command"):
                continue
            break
        if r.get("type") == "assistant":
            calls += len(r.get("tool_names") or [])
    return calls


def next_action(text: str, open_recommendations: list[str] | None = None) -> str | None:
    """The run's own stated next action: a "Next step(s):" line (or the first line under such a
    header), else the first "I'll ..." sentence, else the recap's first open recommendation."""
    m = _NEXT_HEADER.search(text)
    if m:
        found = m.group(1).strip()
        if not found:
            rest = text[m.end():].split("\n")
            found = next((re.sub(r"^[-*\d.)\s]+", "", ln).strip() for ln in rest if ln.strip()), "")
        if found:
            return found[:NEXT_ACTION_CAP]
    w = _WILL_SENTENCE.search(text)
    if w:
        return w.group(0).strip()[:NEXT_ACTION_CAP]
    if open_recommendations:
        return open_recommendations[0][:NEXT_ACTION_CAP]
    return None


def classify(text: str, *, tool_calls: int, done_claim: str = "unknown",
             open_recommendations: list[str] | None = None, offers_to_continue: bool = False,
             ends_with_question: bool = False) -> dict:
    """{state, why, nextAction} for one finished turn. `text` should be the recap view
    (gatelib.recap_view) so a quoted or fenced "I'm blocked" from another chat cannot count."""
    recs = open_recommendations or []
    nxt = next_action(text, recs)
    # A recap that claims done with nothing left open is not waiting on anyone: "we need access
    # control on X" in its summary is a design note, not a wait on a person.
    settled = (done_claim == "yes" and not recs and not offers_to_continue
               and not ends_with_question)
    m = None if settled else BLOCKER.search(text)
    if m:
        return {"state": "blocked",
                "why": f"it says it is blocked ('{m.group(0)}') - a person has to unblock it",
                "nextAction": nxt}
    m = APPROVAL.search(text)
    if m:
        return {"state": "needs_approval",
                "why": f"it asks for sign-off ('{m.group(0)}')", "nextAction": nxt}
    if tool_calls == 0 and done_claim != "yes" and PLANNING.search(text):
        return {"state": "plan_only",
                "why": "it replied with a plan and called no tool this turn - nothing was done yet",
                "nextAction": nxt}
    if settled:
        return {"state": "completed", "why": "its recap claims done and nothing is left open",
                "nextAction": None}
    if tool_calls > 0:
        return {"state": "advanced",
                "why": f"it made {tool_calls} tool call(s) this turn but did not claim done",
                "nextAction": nxt}
    return {"state": "needs_followup",
            "why": "a reply with no tool calls behind it and no claim of done", "nextAction": nxt}
