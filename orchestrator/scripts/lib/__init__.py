"""The orchestrator's shared libraries - the ONLY things scripts may import from each
other. Everything else in scripts/ is an individual, independently runnable act or
observation, and must not import a sibling script (a review found that coupling and it
was removed; keep it removed).

  hydralib     HTTP to the AgentHydra daemon + chat/instance resolution
  gatelib      THE GATE: what state is a chat in
  ledgerlib    THE ATTEMPT LEDGER: how many times have we tried this
  holdlib      PER-CHAT HOLDS: the owner's hands-off switch
  deliverylib  THE STAGING LEDGER: replies decided but not yet sent

THE CONSOLE IS UTF-8, AND THAT IS A CORRECTNESS RULE, NOT A COSMETIC ONE (2026-09-01).
Windows hands Python a cp1252 stdout. cp1252 cannot encode the glyphs these scripts print
in their WARNING and REFUSAL branches - the checkmark, the cross, the warning triangle, the
no-entry sign - so writing one raises UnicodeEncodeError and kills the process. Twenty
files carried such a glyph, overlord (the watchdog that keeps the loop alive), courier,
census and gatelib among them.

The failure shape is what makes this load-bearing: the crash lands on the REPORT, after
the acts have already run, so the side effects are real and the record of them is gone.
`interview.py --apply` did exactly that - eight decisions executed, the summary died on a
checkmark, and nothing on stdout said which had landed. A report that can vanish while its
work persists is worse than a missing report; it makes a completed pass indistinguishable
from a failed one.

⛔ "`from lib import ...` is the one line every script in the repo executes before anything
else" WAS NOT TRUE, and believing it cost a day (2026-09-02). Five runnable scripts have no
module-level lib import at all - orch.py, THE DRIVER, imports lib only lazily inside its
subcommands - so this guard never ran for them and `python orch.py --help | cat` died on the
no-entry sign in its own docstring, with the repo-wide fix sitting right here looking healthy.
A guard that silently covers a subset is worse than no guard: it stops anyone from looking.

So the rule is now enforced at the place every script really does reach, the first line of its
main(), and the ONE definition lives in clilib.use_utf8_console() with the full story. This
import-time call stays as a belt for library-only consumers (a test importing gatelib, the
server) that never go through a main() - it is the same function, not a second copy.
"""

from __future__ import annotations

from .clilib import use_utf8_console as _use_utf8_console

_use_utf8_console()
