"""The archive re-aim proves which row a menu belongs to by IDENTITY, and refuses anything less.

Found 2026-09-18 on instance 13: every in-app archive was refused, four runs in a row, with the row
plainly rendered and the right menu open. The actuator's last-moment re-aim re-read the Name of the
kebab handle it had taken BEFORE opening the menu, and that handle had gone blank for good. The app
REBUILDS a row's kebab the first time its menu opens (measured on two rows: kebab ...4.664 ->
...4.1452 and ...4.693 -> ...4.1662, each still hanging off the same raw-view parent, ...4.663 and
...4.692). Every real archive is a first open, so every archive was refused, and since the stale
handle's Collapse also throws, every refusal left its menu standing open.

The fix finds the row again by the ids taken before the menu opened (the kebab's own, or the parent
the rebuilt kebab still hangs off), reads the title from THAT element, and keeps the old name check
as the assertion. What these tests hold down is the part that makes it SAFE, because archiving a
neighbouring row is the one mistake the guard exists to prevent:

- a kebab that merely carries the right NAME is never a candidate - no name-only re-resolve;
- the matched kebab must be the one holding the open menu, and exactly one;
- the item must come from the one menu THIS run opened, not one an earlier run left open;
- an unreadable or unfound identity is "could not read", and refuses.

The decision is `ReAimVerdict` in misc/Manage-DesktopChat.ps1, kept free of UI Automation so it can
be run here. The test parses the SHIPPED script with PowerShell's own parser and runs the function's
own text - never a copy retyped into this file, or the test would keep passing after the shipped one
was edited. The UIA half (reading those ids off a live app) is proven live; see CHANGELOG.
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

#: Parses the shipped actuator, defines ONLY ReAimVerdict from its own text, runs every case, and
#: reports what the script does between opening the menu and invoking the item.
HARNESS = r"""
param([string]$Script, [string]$Cases)
$ErrorActionPreference = 'Stop'
try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding } catch { }
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errs)
if ($errs.Count) { throw ("the shipped actuator does not parse: " + $errs[0].Message) }
$out = [ordered]@{}

$fns = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
$verdictFn = @($fns | Where-Object { $_.Name -eq 'ReAimVerdict' })
$out.verdictDefinitions = $verdictFn.Count
$rk = @($fns | Where-Object { $_.Name -eq 'RuntimeKey' })
$out.runtimeKeyDefinitions = $rk.Count
$out.runtimeKeyTopLevel = [bool]($rk.Count -eq 1 -and $rk[0].Parent.Parent -eq $ast)
$rkUses = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'RuntimeKey' }, $true))
$out.runtimeKeyDefinedBeforeFirstUse = [bool]($rk.Count -eq 1 -and $rkUses.Count -gt 0 -and
  ($rkUses | ForEach-Object { $_.Extent.StartOffset } | Measure-Object -Minimum).Minimum -gt $rk[0].Extent.EndOffset)

# The span that matters: from the kebab's Expand() to the menu item's Invoke().
$invokes = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
  $n.Member.Value -eq 'Invoke' -and $n.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
  $n.Expression.VariablePath.UserPath -eq 'inv' }, $true))
$out.itemInvokes = $invokes.Count
$invAt = if ($invokes.Count) { $invokes[0].Extent.StartOffset } else { -1 }
$expands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
  $n.Member.Value -eq 'Expand' -and $n.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
  $n.Expression.VariablePath.UserPath -eq 'ec' -and $n.Extent.StartOffset -lt $invAt }, $true))
$expAt = if ($expands.Count) { ($expands | ForEach-Object { $_.Extent.StartOffset } | Measure-Object -Maximum).Maximum } else { -1 }
$out.spanFound = [bool]($invAt -gt 0 -and $expAt -gt 0)
$named = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and
  $n.Extent.StartOffset -gt $expAt -and $n.Extent.StartOffset -lt $invAt -and
  @('KebabFor', 'ByName', 'RenderedKebabNames') -contains $n.GetCommandName() }, $true))
$out.nameLookupsBetweenOpenAndInvoke = @($named | ForEach-Object { $_.Extent.Text })
$reads = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.MemberExpressionAst] -and
  $n.Extent.StartOffset -gt $expAt -and $n.Extent.StartOffset -lt $invAt -and
  $n.Member.Value -eq 'Name' -and $n.Expression -is [System.Management.Automation.Language.MemberExpressionAst] -and
  $n.Expression.Member.Value -eq 'Current' -and $n.Expression.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
  $n.Expression.Expression.VariablePath.UserPath -eq 'kebab' }, $true))
$out.staleHandleNameReadsBetweenOpenAndInvoke = @($reads | ForEach-Object { $_.Extent.Text })
$gates = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and
  $n.Extent.StartOffset -gt $expAt -and $n.Extent.StartOffset -lt $invAt -and $n.GetCommandName() -eq 'ReAimVerdict' }, $true))
$out.verdictCallsBetweenOpenAndInvoke = $gates.Count

# Only the verdict's own text is defined here: if it leaned on anything else in the script, the
# cases below would fail, which is the point - it must stand alone to be the thing tested.
if ($verdictFn.Count -eq 1) {
  . ([ScriptBlock]::Create($verdictFn[0].Extent.Text))
  $res = [ordered]@{}
  foreach ($c in (Get-Content -Raw -Encoding UTF8 $Cases | ConvertFrom-Json)) {
    $p = @{ Title = [string]$c.Title; AimKey = [string]$c.AimKey; RowKey = [string]$c.RowKey
            Kebabs = @($c.Kebabs); MenusBefore = @($c.MenusBefore); Menus = @($c.Menus); ItemKey = [string]$c.ItemKey }
    $v = ReAimVerdict @p
    $res[[string]$c.Name] = [ordered]@{ Ok = [bool]$v.Ok; Retry = [bool]$v.Retry; Aimed = [string]$v.Aimed
      Why = [string]$v.Why; KebabKey = $(if ($v.Kebab) { [string]$v.Kebab.Key } else { '' }) }
  }
  $out.verdicts = $res
}
$out | ConvertTo-Json -Depth 6 -Compress
"""

# Real ids and names, as measured on instance 13 (see the module docstring).
TITLE = "GlimmerAC collector enablement"
KEBAB_NAME = "More options for " + TITLE
ROW = "42.5771536.4.7.4.663"        # the kebab's raw-view parent: kept its id
OLD = "42.5771536.4.7.4.664"        # the kebab as found, before its first open
NEW = "42.5771536.4.7.4.1452"       # the kebab the app rebuilt when the menu opened
N_ROW = "42.5771536.4.7.4.692"      # the neighbouring row's parent
N_KEBAB = "42.5771536.4.7.4.1662"
MENU = "42.5771536.4.7.4.1708"
ITEMS = [f"42.5771536.4.7.4.{n}" for n in range(1710, 1718)]
ARCHIVE = ITEMS[6]
OLD_MENU = "42.5771536.4.7.4.1500"
OLD_ITEMS = [f"42.5771536.4.7.4.{n}" for n in range(1502, 1510)]


def kebab(key, parent, state, name):
    return {"Key": key, "ParentKey": parent, "State": state, "Name": name}


#: The rest of a real sidebar, always present: two Expanded group headers (they are ExpandCollapse
#: buttons too, and the verdict must not mistake them for the row) and a neighbour's collapsed kebab.
SIDEBAR = [
    kebab("42.5771536.4.7.4.640", "42.5771536.4.7.4.635", "Expanded", "NEWProjects"),
    kebab("42.5771536.4.7.4.675", "42.5771536.4.7.4.670", "Expanded", "PublicProjects"),
    kebab(N_KEBAB, N_ROW, "Collapsed", "More options for SageThumbs"),
]
OUR_MENU = {"Key": MENU, "ItemKeys": ITEMS}


def case(name, kebabs, *, aim=OLD, row=ROW, before=(), menus=(OUR_MENU,), item=ARCHIVE, title=TITLE):
    return {"Name": name, "Title": title, "AimKey": aim, "RowKey": row, "Kebabs": list(kebabs),
            "MenusBefore": list(before), "Menus": list(menus), "ItemKey": item}


CASES = [
    # --- acted on ---------------------------------------------------------------------------------
    # THE BUG'S OWN SHAPE: first open, the kebab is rebuilt under the same parent.
    case("first_open_rebuilt_kebab", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)]),
    # A later open in the same app session: the kebab kept its id.
    case("kebab_kept_its_id", SIDEBAR + [kebab(OLD, ROW, "Expanded", KEBAB_NAME)]),
    case("only_the_row_id_was_readable", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)], aim=""),
    case("only_the_kebab_id_was_readable", SIDEBAR + [kebab(OLD, ROW, "Expanded", KEBAB_NAME)], row=""),
    # A menu some earlier run left open is not a reason to refuse, as long as the item is in OURS.
    case("a_leftover_menu_beside_ours", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)],
         before=[OLD_MENU], menus=[{"Key": OLD_MENU, "ItemKeys": OLD_ITEMS}, OUR_MENU]),
    case("non_ascii_title", SIDEBAR + [kebab(NEW, ROW, "Expanded", "More options for Alcancé mi límite")],
         title="Alcancé mi límite"),
    case("null_records_are_skipped", [None] + SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)]),
    # --- refused: identity ------------------------------------------------------------------------
    case("no_identity_was_readable", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)], aim="", row=""),
    case("the_row_is_gone", SIDEBAR),
    # ⛔ THE NEIGHBOUR: a kebab carrying EXACTLY the right name, holding the open menu, but not this
    # row's identity. A name-only re-resolve would act on it.
    case("an_identically_named_neighbour_is_not_a_candidate",
         SIDEBAR + [kebab("42.5771536.4.7.4.2000", "42.5771536.4.7.4.1999", "Expanded", KEBAB_NAME)]),
    # Our row is here but the menu is on a neighbour, even one that ends with the same title.
    case("the_menu_is_on_a_neighbour",
         SIDEBAR + [kebab(NEW, ROW, "Collapsed", KEBAB_NAME),
                    kebab("42.5771536.4.7.4.2000", "42.5771536.4.7.4.1999", "Expanded", KEBAB_NAME)]),
    case("two_expanded_kebabs_carry_the_identity",
         SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME), kebab(OLD, ROW, "Expanded", KEBAB_NAME)]),
    # An unreadable parent must never match an unreadable RowKey.
    case("an_empty_parent_never_matches_an_empty_row_id",
         SIDEBAR + [kebab("42.5771536.4.7.4.2000", "", "Expanded", KEBAB_NAME)], row=""),
    # --- refused: the name assertion --------------------------------------------------------------
    case("the_name_cannot_be_read", SIDEBAR + [kebab(NEW, ROW, "Expanded", "")]),
    case("the_row_now_reads_another_title", SIDEBAR + [kebab(NEW, ROW, "Expanded", "More options for SageThumbs")]),
    # --- refused: the menu ------------------------------------------------------------------------
    case("the_only_open_menu_was_already_open", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)],
         before=[MENU]),
    case("two_new_menus", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)],
         menus=[OUR_MENU, {"Key": OLD_MENU, "ItemKeys": OLD_ITEMS}]),
    case("the_item_is_from_a_leftover_menu", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)],
         before=[OLD_MENU], menus=[{"Key": OLD_MENU, "ItemKeys": OLD_ITEMS}, OUR_MENU], item=OLD_ITEMS[6]),
    case("the_item_id_was_not_readable", SIDEBAR + [kebab(NEW, ROW, "Expanded", KEBAB_NAME)], item=""),
]


def _run_harness() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        harness = Path(tmp) / "reaim_harness.ps1"
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
class ReAimByIdentityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = _run_harness()
        cls.v = cls.out.get("verdicts") or {}

    def verdict(self, name):
        self.assertIn(name, self.v, f"case {name} did not run")
        return self.v[name]

    def assertActed(self, name, kebab_key, aimed=KEBAB_NAME):
        v = self.verdict(name)
        self.assertTrue(v["Ok"], f"{name} should be acted on, but refused: {v['Why']}")
        self.assertEqual(v["Aimed"], aimed)
        self.assertEqual(v["KebabKey"], kebab_key)

    def assertRefused(self, name, why_has, *, retry):
        v = self.verdict(name)
        self.assertFalse(v["Ok"], f"{name} must refuse, but was acted on (aimed at {v['Aimed']!r})")
        self.assertIn(why_has, v["Why"])
        self.assertEqual(v["Retry"], retry, f"{name}: Retry should be {retry} ({v['Why']})")

    # --- the shipped script's shape -------------------------------------------------------------
    def test_the_verdict_is_one_standalone_function(self):
        self.assertEqual(self.out["verdictDefinitions"], 1)
        self.assertEqual(len(self.v), len(CASES), "every case must run against the shipped verdict")

    def test_runtime_key_is_defined_once_at_top_level_before_it_is_used(self):
        """It used to be defined inside the Delete branch, far below the re-aim that now needs it -
        a PowerShell function does not exist until its definition statement has run."""
        self.assertEqual(self.out["runtimeKeyDefinitions"], 1)
        self.assertTrue(self.out["runtimeKeyTopLevel"])
        self.assertTrue(self.out["runtimeKeyDefinedBeforeFirstUse"])

    def test_nothing_between_opening_the_menu_and_invoking_the_item_looks_a_row_up_by_name(self):
        """⛔ The rule the whole fix rests on: a name-only re-resolve while the menu is open is how
        you aim at a neighbouring row. Nothing in that span may call a name-based finder."""
        self.assertTrue(self.out["spanFound"], "could not locate the kebab's Expand() and the item's Invoke()")
        self.assertEqual(self.out["itemInvokes"], 1)
        self.assertEqual(self.out["nameLookupsBetweenOpenAndInvoke"], [])

    def test_the_stale_handle_s_name_is_never_read_as_the_verdict(self):
        """The bug itself: $kebab.Current.Name, read after the menu opened, from a handle the app
        had already replaced. It must not come back in any form."""
        self.assertEqual(self.out["staleHandleNameReadsBetweenOpenAndInvoke"], [])

    def test_the_verdict_gates_the_invoke(self):
        self.assertGreaterEqual(self.out["verdictCallsBetweenOpenAndInvoke"], 1)

    # --- acted on --------------------------------------------------------------------------------
    def test_the_first_open_rebuild_is_acted_on_through_the_rebuilt_kebab(self):
        """The exact shape measured on instance 13, where every archive was refused."""
        self.assertActed("first_open_rebuilt_kebab", NEW)

    def test_a_kebab_that_kept_its_id_is_acted_on(self):
        self.assertActed("kebab_kept_its_id", OLD)

    def test_either_id_alone_is_enough(self):
        self.assertActed("only_the_row_id_was_readable", NEW)
        self.assertActed("only_the_kebab_id_was_readable", OLD)

    def test_a_leftover_menu_is_tolerated_when_the_item_is_in_ours(self):
        self.assertActed("a_leftover_menu_beside_ours", NEW)

    def test_a_non_ascii_title(self):
        self.assertActed("non_ascii_title", NEW, aimed="More options for Alcancé mi límite")

    def test_null_records_are_skipped(self):
        self.assertActed("null_records_are_skipped", NEW)

    # --- refused: identity -----------------------------------------------------------------------
    def test_no_readable_identity_refuses(self):
        self.assertRefused("no_identity_was_readable", "could not be read", retry=False)

    def test_a_row_that_is_gone_refuses(self):
        self.assertRefused("the_row_is_gone", "no kebab carries this row's identity", retry=True)

    def test_an_identically_named_neighbour_is_never_a_candidate(self):
        """⛔ The neighbour. Right name, holding the open menu, wrong identity: refuse."""
        self.assertRefused("an_identically_named_neighbour_is_not_a_candidate",
                           "no kebab carries this row's identity", retry=True)

    def test_a_menu_on_a_neighbour_refuses(self):
        self.assertRefused("the_menu_is_on_a_neighbour", "not the one holding the open menu", retry=True)

    def test_two_expanded_kebabs_with_the_identity_refuse(self):
        self.assertRefused("two_expanded_kebabs_carry_the_identity", "2 expanded kebabs", retry=False)

    def test_an_empty_parent_never_matches_an_empty_row_id(self):
        self.assertRefused("an_empty_parent_never_matches_an_empty_row_id",
                           "no kebab carries this row's identity", retry=True)

    # --- refused: the name assertion -------------------------------------------------------------
    def test_an_unreadable_name_refuses(self):
        self.assertRefused("the_name_cannot_be_read", "its name could not be read", retry=True)

    def test_a_row_that_reads_another_title_refuses_and_says_what_it_read(self):
        self.assertRefused("the_row_now_reads_another_title", "sidebar moved", retry=False)
        self.assertEqual(self.verdict("the_row_now_reads_another_title")["Aimed"], "More options for SageThumbs")

    # --- refused: the menu -----------------------------------------------------------------------
    def test_a_menu_this_run_did_not_open_refuses(self):
        self.assertRefused("the_only_open_menu_was_already_open", "0 new menus", retry=False)

    def test_two_new_menus_refuse(self):
        self.assertRefused("two_new_menus", "2 new menus", retry=False)

    def test_an_item_from_a_leftover_menu_refuses(self):
        """MenuItemFor searches every menu in the process, so a menu left open by an earlier run
        could hand over ITS row's Archive. The item must be in the menu this run opened."""
        self.assertRefused("the_item_is_from_a_leftover_menu", "not in the menu this run opened", retry=False)

    def test_an_unreadable_item_id_refuses(self):
        self.assertRefused("the_item_id_was_not_readable", "not in the menu this run opened", retry=False)


if __name__ == "__main__":
    unittest.main()
