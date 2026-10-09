"""The locale-independent Archive pick takes the item directly above Delete, or refuses.

Found 2026-10-08 on a Korean app: archiving the chat open in the window's primary pane made an idle
'<title> (fork)' chat one second before the archive landed. No label in $ACTION_LABELS is Korean, so
the pick fell to the CSS-palette rule, which then took "the last non-destructive, non-submenu item":
whenever the entry above Delete was skipped (an unreadable name, a submenu), that reached up to Fork.

The rule now: exactly one item carries the danger palette, it is the LAST entry, and the entry right
above it is a plain item. Anything else refuses, because a refusal costs a retry and a wrong pick
costs a chat. The decision is `StructuralPick` in misc/Manage-DesktopChat.ps1, free of UI
Automation; this test parses the SHIPPED script and runs that function's own text, never a copy.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import clilib  # noqa: E402

APP = Path(__file__).resolve().parents[3]
ACTUATOR = APP / "misc" / "Manage-DesktopChat.ps1"

HARNESS = r"""
param([string]$Script, [string]$Cases)
$ErrorActionPreference = 'Stop'
try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding } catch { }
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errs)
if ($errs.Count) { throw ("the shipped actuator does not parse: " + $errs[0].Message) }
$out = [ordered]@{}
$fns = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
$need = @('IsDangerItem', 'IsSubmenuItem', 'StructuralPick')
$out.definitions = [ordered]@{}
foreach ($name in $need) { $out.definitions[$name] = @($fns | Where-Object { $_.Name -eq $name }).Count }
$menuItem = @($fns | Where-Object { $_.Name -eq 'StructuralMenuItem' })
$out.menuItemCallsPick = [bool]($menuItem.Count -eq 1 -and @($menuItem[0].Body.FindAll({ param($n)
  $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'StructuralPick' }, $true)).Count -ge 1)
if (@($need | Where-Object { $out.definitions[$_] -ne 1 }).Count -eq 0) {
  foreach ($name in $need) { . ([ScriptBlock]::Create((@($fns | Where-Object { $_.Name -eq $name })[0]).Extent.Text)) }
  $res = [ordered]@{}
  foreach ($c in (Get-Content -Raw -Encoding UTF8 $Cases | ConvertFrom-Json)) {
    $v = StructuralPick @($c.Entries) ([string]$c.Action)
    $res[[string]$c.Name] = [ordered]@{ Index = [int]$v.Index; Why = [string]$v.Why }
  }
  $out.picks = $res
}
$out | ConvertTo-Json -Depth 6 -Compress
"""

# The app's own class shapes, as dumped from a pt-BR app (see the comment above MenuEntries).
PLAIN = "text-primary hover:bg-fill-hover"
SUBMENU = "text-primary data-[popup-open]:bg-fill-hover"
DANGER = "menu-danger text-danger hover:bg-fill-danger"


def item(name, cls=PLAIN):
    return {"Name": name, "Class": cls}


#: The pt-BR menu as measured: Open in / Pin / Mark unread / Rename / Fork / Move to group / Archive / DELETE.
PT_BR = [item("Abrir em", SUBMENU), item("Fixar"), item("Marcar como não lida"), item("Renomear"),
         item("Bifurcar"), item("Mover para grupo", SUBMENU), item("Arquivar"), item("Apagar", DANGER)]
#: The Spanish menu as read live 2026-09-09.
ES = [item("Abrir en", SUBMENU), item("Renombrar"), item("Vista de transcripcion"), item("Estilo de salida"),
      item("Bifurcar"), item("Archivar"), item("Eliminar", DANGER)]


def case(name, entries, action="Archive"):
    return {"Name": name, "Entries": entries, "Action": action}


CASES = [
    case("pt_br_measured", PT_BR),
    case("es_measured", ES),
    case("delete_is_the_danger_item", PT_BR, action="Delete"),
    # ⛔ THE BUG'S SHAPE: the Archive entry is not there to read, so a submenu sits above Delete. The
    # old rule skipped the submenu and took Fork.
    case("archive_missing_submenu_above_delete", [e for e in PT_BR if e["Name"] != "Arquivar"]),
    # An entry after Delete: the menu no longer has the measured shape, so nothing in it is trusted.
    case("danger_not_last", PT_BR + [item("Something new")]),
    case("no_danger_item", [e for e in PT_BR if e["Class"] != DANGER]),
    case("two_danger_items", PT_BR[:-1] + [item("Apagar tudo", DANGER), item("Apagar", DANGER)]),
    case("danger_is_the_only_entry", [item("Apagar", DANGER)]),
    case("rename_has_no_signature", PT_BR, action="Rename"),
]


def _run_harness() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        harness = Path(tmp) / "pick_harness.ps1"
        cases = Path(tmp) / "cases.json"
        # utf-8-SIG: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
        harness.write_text(HARNESS, encoding="utf-8-sig")
        cases.write_text(json.dumps(CASES, ensure_ascii=False), encoding="utf-8")
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness),
             "-Script", str(ACTUATOR), "-Cases", str(cases)],
            timeout=120,
        )
    if r.returncode != 0:
        raise AssertionError(f"harness failed ({r.returncode}): {r.stdout}\n{r.stderr}")
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(sys.platform == "win32", "PowerShell actuators are Windows-only")
class StructuralPickTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = _run_harness()
        cls.picks = cls.out.get("picks") or {}

    def pick(self, name):
        self.assertIn(name, self.picks, f"case {name} did not run ({self.out.get('definitions')})")
        return self.picks[name]

    def assertPicked(self, name, label):
        entries = next(c["Entries"] for c in CASES if c["Name"] == name)
        p = self.pick(name)
        self.assertGreaterEqual(p["Index"], 0, f"{name} refused: {p['Why']}")
        self.assertEqual(entries[p["Index"]]["Name"], label)

    def assertRefused(self, name, why_has):
        p = self.pick(name)
        self.assertEqual(p["Index"], -1, f"{name} must refuse, but picked index {p['Index']}")
        self.assertIn(why_has, p["Why"])

    def test_the_menu_path_goes_through_the_tested_decision(self):
        self.assertEqual(self.out["definitions"], {"IsDangerItem": 1, "IsSubmenuItem": 1, "StructuralPick": 1})
        self.assertTrue(self.out["menuItemCallsPick"])

    def test_measured_menus_pick_archive(self):
        self.assertPicked("pt_br_measured", "Arquivar")
        self.assertPicked("es_measured", "Archivar")

    def test_delete_is_the_one_danger_item(self):
        self.assertPicked("delete_is_the_danger_item", "Apagar")

    def test_a_submenu_above_delete_refuses_instead_of_reaching_up_to_fork(self):
        self.assertRefused("archive_missing_submenu_above_delete", "opens a submenu")

    def test_shapes_it_cannot_prove_refuse(self):
        self.assertRefused("danger_not_last", "not the last entry")
        self.assertRefused("no_danger_item", "0 items")
        self.assertRefused("two_danger_items", "2 items")
        self.assertRefused("danger_is_the_only_entry", "nothing sits above")
        self.assertRefused("rename_has_no_signature", "no structural signature")


if __name__ == "__main__":
    unittest.main()
