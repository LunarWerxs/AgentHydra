"""approve_prompt.ps1's chat matching is STRUCTURAL - it must find a row on an app in any
language, and must still refuse the things the English matcher refused.

Found 2026-09-09 on instance #56, whose Claude Desktop renders in Spanish: the actuator
matched a sidebar row by stripping the English prefixes 'Idle ' / 'Running ' and comparing
the rest to the title, and matched the conversation pane's receipt by the English literal
'More options for '. Neither exists on that app, so every chat there refused with
"no sidebar row ... (waited 6s for it to render)" - a MATCH failure wearing a timing
failure's words. The fix reads a chat's title off its own row/kebab pair (the two carry the
same title behind two different decorations, in every language) and matches EXACTLY against
the phrase that yields.

This runs the real functions: the region between the STRUCTURAL-MATCH markers in
approve_prompt.ps1 is extracted VERBATIM and executed by pwsh against fake buttons, so the
test cannot pass against a source file that no longer does this. No app is driven and no UI
Automation type is touched - that is exactly why the region is kept dependency-free.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import unittest
from pathlib import Path

ACTUATOR = Path(__file__).resolve().parents[1] / "actuator" / "approve_prompt.ps1"
BEGIN = "# >>> STRUCTURAL-MATCH REGION"
END = "# <<< STRUCTURAL-MATCH REGION <<<"

PWSH = shutil.which("pwsh")

# The harness: plain descriptors in, decisions out as JSON. It knows nothing about the app.
# ⛔ NAME THE PARSED CASES APART FROM THE -CasesPath PARAMETER. PowerShell variables are
# case-insensitive AND a typed param constrains its variable forever, so `$cases = <objects>`
# under a `[string]$Cases` param silently coerces the whole array to one string - the same
# trap approve_prompt.ps1 records against its own $ONCE list.
#
# The verdicts go to a FILE, never to stdout: a console hands PowerShell's output through the
# OEM code page, which mangles the one thing this test is about (the 'ü' in a German label
# came back as byte 0x81 and killed the reader thread).
HARNESS_HEAD = "param([string]$CasesPath, [string]$OutPath)\n$ErrorActionPreference = 'Stop'\n"
HARNESS_BODY = """
$spec = Get-Content -Raw -LiteralPath $CasesPath | ConvertFrom-Json
$out = @()
foreach ($c in $spec) {
  $btns = @()
  foreach ($b in $c.buttons) {
    $btns += [pscustomobject]@{
      Name = [string]$b.name; Left = [double]$b.left; Top = [double]$b.top
      Right = [double]$b.right; Bottom = [double]$b.bottom
      HasExpand = [bool]$b.expand; HasInvoke = [bool]$b.invoke
    }
  }
  $phrase = Get-KebabPhrase $btns
  $use = if ($phrase) { $phrase } else { [string]$c.fallback }
  $pick = Select-SidebarChat $btns ([double]$c.minX) ([string]$c.title) $use
  $out += [pscustomobject]@{
    name     = [string]$c.name
    phrase   = $phrase
    why      = [string]$pick.Why
    row      = $(if ($pick.Row) { [string]$pick.Row.Name } else { $null })
    rendered = @($pick.Rendered)
    pane     = [bool](Test-PaneShows $btns ([double]$c.minX) ([string]$c.title) $use)
  }
}
($out | ConvertTo-Json -Depth 6 -Compress -AsArray) | Set-Content -LiteralPath $OutPath -Encoding utf8
"""

MIN_X = 300.0
EN = "More options for "
ES = "Mas opciones para "


def _row(name, i, invoke=True):
    return {"name": name, "left": 0, "top": 100 * i + 10, "right": 280,
            "bottom": 100 * i + 60, "expand": False, "invoke": invoke}


def _kebab(name, i):
    return {"name": name, "left": 240, "top": 100 * i + 20, "right": 270,
            "bottom": 100 * i + 45, "expand": True, "invoke": False}


def _pane_kebab(name):
    return {"name": name, "left": 400, "top": 12, "right": 430, "bottom": 40,
            "expand": True, "invoke": False}


def _chrome():
    # Sidebar furniture that is neither a row nor a kebab, and must never be mistaken for one.
    return {"name": "New chat", "left": 0, "top": 0, "right": 280, "bottom": 8,
            "expand": False, "invoke": True}


EN_SIDEBAR = [
    _chrome(),
    _row("Idle alpha", 0), _kebab(EN + "alpha", 0),
    _row("Running beta", 1), _kebab(EN + "beta", 1),
    _row("gamma", 2), _kebab(EN + "gamma", 2),          # an undecorated row
    _pane_kebab(EN + "alpha"),                          # alpha is the chat currently open
]

ES_SIDEBAR = [
    _row("Inactivo GlimmerAC todo list", 0), _kebab(ES + "GlimmerAC todo list", 0),
    _row("Ejecutando otro chat", 1), _kebab(ES + "otro chat", 1),
    _pane_kebab(ES + "GlimmerAC todo list"),
]

# The hazard the 2026-09-06 review named: a neighbour whose title ENDS with the one we want.
ES_NEIGHBOUR = [
    _row("Inactivo todo list", 0), _kebab(ES + "todo list", 0),
    _row("Inactivo GlimmerAC todo list", 1), _kebab(ES + "GlimmerAC todo list", 1),
    _pane_kebab(ES + "GlimmerAC todo list"),
]

DE_SIDEBAR = [
    _row("Inaktiv münchen", 0), _kebab("Weitere Optionen für münchen", 0),
    _row("Inaktiv berlin", 1), _kebab("Weitere Optionen für berlin", 1),
]

DUPLICATES = [
    _row("Idle dup", 0), _kebab(EN + "dup", 0),
    _row("Idle dup", 1), _kebab(EN + "dup", 1),
]

KEBAB_WITHOUT_ROW = [_kebab(EN + "orphan", 0), _pane_kebab(EN + "orphan")]

EMPTY_SIDEBAR = [_pane_kebab(EN + "alpha")]

# 2026-09-10: an app-derived, sentence-shaped, non-ASCII title (an imported chat that carries
# no stored title, so the app re-derives one from the transcript's first message). Live
# reproduction: an exact-equality match against a row like this refuses even though 28 rows
# are genuinely rendered - the row is a MATCH failure, not a timing one.
SPANISH_LONG_TITLE = ("Alcancé mi límite de uso mientras trabajabas, pero ya se "
                      "restableció. Continúa donde lo dejaste.")
# What the sidebar actually renders for a title this long: an ellipsis-truncated PREFIX, never
# the full string. This is shape (1) of the two candidate causes - truncation, not encoding.
SPANISH_TRUNCATED_ROW = SPANISH_LONG_TITLE[:42] + "…"
SPANISH_TRUNCATED_SIDEBAR = [
    _row(SPANISH_TRUNCATED_ROW, 0), _kebab(EN + SPANISH_TRUNCATED_ROW, 0),
]
# Shape (2): the same title, visually identical, but the accented characters reach the
# rendered Name in NFD (decomposed: base letter + combining mark) while the wanted title is
# the ordinary NFC (precomposed) Python literal above - two different byte sequences for the
# same text, which plain string equality treats as unrelated.
SPANISH_NFD_ROW = unicodedata.normalize("NFD", SPANISH_LONG_TITLE)
SPANISH_NFD_SIDEBAR = [
    _row(SPANISH_NFD_ROW, 0), _kebab(EN + SPANISH_NFD_ROW, 0),
]
# The exact pass must still win when it can: a row bearing the FULL, untruncated title must
# not be routed through the loosened normaliser at all.
SPANISH_EXACT_SIDEBAR = [
    _row(SPANISH_LONG_TITLE, 0), _kebab(EN + SPANISH_LONG_TITLE, 0),
]
# Two DIFFERENT rows that could each be a truncated prefix of the same wanted title (a real
# fleet shape: more than one chat can auto-derive the identical opening line, e.g. two
# sessions that both hit the same rate-limit message first). The loosened pass must refuse
# exactly like the exact pass already does - never guess between them.
SPANISH_AMBIGUOUS_SIDEBAR = [
    _row(SPANISH_LONG_TITLE[:20] + "…", 0),
    _kebab(EN + SPANISH_LONG_TITLE[:20] + "…", 0),
    _row(SPANISH_LONG_TITLE[:60] + "…", 1),
    _kebab(EN + SPANISH_LONG_TITLE[:60] + "…", 1),
]

CASES = [
    {"name": "en_row", "buttons": EN_SIDEBAR, "title": "beta"},
    {"name": "en_open_chat", "buttons": EN_SIDEBAR, "title": "alpha"},
    {"name": "en_undecorated_row", "buttons": EN_SIDEBAR, "title": "gamma"},
    {"name": "en_absent", "buttons": EN_SIDEBAR, "title": "nope"},
    {"name": "es_filing", "buttons": ES_SIDEBAR, "title": "GlimmerAC todo list"},
    {"name": "es_neighbour", "buttons": ES_NEIGHBOUR, "title": "todo list"},
    {"name": "es_neighbour_long", "buttons": ES_NEIGHBOUR, "title": "GlimmerAC todo list"},
    {"name": "de_row", "buttons": DE_SIDEBAR, "title": "berlin"},
    {"name": "duplicate_titles", "buttons": DUPLICATES, "title": "dup"},
    {"name": "kebab_without_row", "buttons": KEBAB_WITHOUT_ROW, "title": "orphan"},
    {"name": "empty_sidebar", "buttons": EMPTY_SIDEBAR, "title": "alpha"},
    {"name": "es_long_truncated_row", "buttons": SPANISH_TRUNCATED_SIDEBAR,
     "title": SPANISH_LONG_TITLE},
    {"name": "es_accent_form_mismatch", "buttons": SPANISH_NFD_SIDEBAR,
     "title": SPANISH_LONG_TITLE},
    {"name": "es_exact_full_title", "buttons": SPANISH_EXACT_SIDEBAR,
     "title": SPANISH_LONG_TITLE},
    {"name": "es_truncated_ambiguous", "buttons": SPANISH_AMBIGUOUS_SIDEBAR,
     "title": SPANISH_LONG_TITLE},
]


def _region() -> str:
    text = ACTUATOR.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        raise AssertionError(
            f"{ACTUATOR.name} no longer carries the STRUCTURAL-MATCH markers - the matching "
            "logic this test proves has been moved or deleted, and nothing here can vouch "
            "for what replaced it.")
    # Drop the rest of the marker's own line (it is prose, not code) and keep everything up
    # to the closing marker verbatim.
    return text.split(BEGIN, 1)[1].split("\n", 1)[1].split(END, 1)[0]


@unittest.skipUnless(PWSH, "PowerShell 7 (pwsh) is required to run the actuator's own code")
class ApprovePromptMatchingTest(unittest.TestCase):
    """One pwsh run for every case; each test reads its own verdict out of the result map."""

    results: dict = {}

    @classmethod
    def setUpClass(cls):
        region = _region()
        tmp = tempfile.mkdtemp(prefix="approve-match-")
        cls._tmp = tmp
        script = Path(tmp) / "harness.ps1"
        script.write_text(HARNESS_HEAD + region + HARNESS_BODY, encoding="utf-8")
        cases = Path(tmp) / "cases.json"
        cases.write_text(json.dumps(
            [{**c, "minX": MIN_X, "fallback": EN} for c in CASES]), encoding="utf-8")
        verdicts = Path(tmp) / "verdicts.json"
        r = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-File", str(script),
             "-CasesPath", str(cases), "-OutPath", str(verdicts)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        if r.returncode != 0 or not verdicts.exists():
            raise AssertionError(f"harness failed ({r.returncode}): {r.stdout}\n{r.stderr}")
        cls.results = {row["name"]: row
                       for row in json.loads(verdicts.read_text(encoding="utf-8"))}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def case(self, name):
        self.assertIn(name, self.results, f"the harness produced no verdict for {name}")
        return self.results[name]

    # --- it still does what it was built for -------------------------------------------
    def test_english_row_is_found_behind_its_status_prefix(self):
        got = self.case("en_row")
        self.assertEqual(got["phrase"], EN)
        self.assertEqual(got["why"], "ok")
        self.assertEqual(got["row"], "Running beta")

    def test_english_undecorated_row_is_found(self):
        got = self.case("en_undecorated_row")
        self.assertEqual(got["why"], "ok")
        self.assertEqual(got["row"], "gamma")

    def test_pane_receipt_is_only_true_for_the_chat_that_is_open(self):
        self.assertTrue(self.case("en_open_chat")["pane"])
        self.assertFalse(self.case("en_row")["pane"])

    # --- and it stops being wrong about a non-English app -------------------------------
    def test_spanish_row_is_found_without_any_spanish_in_the_matcher(self):
        got = self.case("es_filing")
        self.assertEqual(got["phrase"], ES, "the phrase must be read off the window, not listed")
        self.assertEqual(got["why"], "ok")
        self.assertEqual(got["row"], "Inactivo GlimmerAC todo list")
        self.assertTrue(got["pane"], "the pane receipt must recognise the Spanish kebab too")

    def test_a_third_locale_needs_no_new_strings(self):
        got = self.case("de_row")
        self.assertEqual(got["phrase"], "Weitere Optionen für ")
        self.assertEqual(got["row"], "Inaktiv berlin")

    def test_the_matcher_carries_no_locale_table(self):
        region = _region()
        for word in ("Inactivo", "Ejecutando", "Mas opciones", "Weitere", "Inaktiv",
                     "Idle ", "Running "):
            self.assertNotIn(word, region,
                             f"'{word}' is a per-locale string; matching must stay structural")

    # --- and it still refuses what it always refused ------------------------------------
    def test_a_longer_neighbour_title_never_matches(self):
        got = self.case("es_neighbour")
        self.assertEqual(got["why"], "ok")
        self.assertEqual(got["row"], "Inactivo todo list",
                         "'todo list' must not select 'GlimmerAC todo list'")
        self.assertFalse(got["pane"], "the open chat is the neighbour, not ours")
        long = self.case("es_neighbour_long")
        self.assertEqual(long["row"], "Inactivo GlimmerAC todo list")
        self.assertTrue(long["pane"])

    def test_two_rows_with_one_title_are_a_refusal_not_a_guess(self):
        got = self.case("duplicate_titles")
        self.assertEqual(got["why"], "ambiguous:2")
        self.assertIsNone(got["row"])

    def test_a_kebab_whose_row_takes_no_invoke_is_named_as_such(self):
        got = self.case("kebab_without_row")
        self.assertEqual(got["why"], "no-owning-row")
        self.assertIsNone(got["row"])

    # --- the refusal can tell a match failure from a timing one -------------------------
    def test_an_absent_title_reports_the_rows_that_ARE_rendered(self):
        got = self.case("en_absent")
        self.assertEqual(got["why"], "no-row")
        self.assertEqual(sorted(got["rendered"]), ["alpha", "beta", "gamma"])

    def test_an_empty_sidebar_reports_nothing_rendered(self):
        got = self.case("empty_sidebar")
        self.assertEqual(got["why"], "no-row")
        self.assertEqual(got["rendered"], [])
        self.assertEqual(got["phrase"], "", "no pair on screen means no phrase was measured")

    # --- 2026-09-10: a long, sentence-shaped, non-ASCII title -------------------------------
    def test_ellipsis_truncated_row_matches_by_normalised_prefix(self):
        # Shape (1) of the two candidate causes: the sidebar renders only a truncated PREFIX
        # of a long title, so exact equality can never succeed - this is the one proven live.
        got = self.case("es_long_truncated_row")
        self.assertEqual(got["why"], "ok")
        self.assertEqual(got["row"], SPANISH_TRUNCATED_ROW)

    def test_accent_form_mismatch_still_matches(self):
        # Shape (2): same text, different Unicode normalisation form (NFD vs NFC) - accent-
        # folding must treat them as equal even though plain string equality does not.
        got = self.case("es_accent_form_mismatch")
        self.assertEqual(got["why"], "ok")
        self.assertEqual(got["row"], SPANISH_NFD_ROW)

    def test_exact_match_is_still_tried_first(self):
        # The exact pass must still win when it can: a row bearing the FULL, untruncated title
        # must not need the loosened normaliser at all.
        got = self.case("es_exact_full_title")
        self.assertEqual(got["why"], "ok")
        self.assertEqual(got["row"], SPANISH_LONG_TITLE)

    def test_two_truncated_rows_of_one_title_are_a_refusal_not_a_guess(self):
        # AMBIGUITY MUST STAY A REFUSAL in the loosened pass too - never guess between two
        # rows that could each be a truncated prefix of the wanted title.
        got = self.case("es_truncated_ambiguous")
        self.assertEqual(got["why"], "ambiguous:2")
        self.assertIsNone(got["row"])


if __name__ == "__main__":  # pragma: no cover
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
