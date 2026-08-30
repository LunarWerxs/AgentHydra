# misc/Manage-DesktopChat.ps1 - manage a RUNNING Claude desktop app's chats (archive,
# unarchive, rename, list) WITHOUT stealing
# focus and WITHOUT moving the mouse, by invoking the app's own sidebar controls through the
# Windows UI Automation patterns they expose.
#
# WHY THIS EXISTS (owner directive, Michael, 2026-08-29): a running Electron app holds its chat
# list in memory, so a flag flipped on DISK stays on screen until the app restarts - and
# restarting is not an option. The app's OWN archive action is the one channel that is both
# immediate AND durable (the app makes the write, so its later memory->disk re-saves cannot undo
# it). This drives that action with zero focus theft.
#
# THE MECHANISM, measured 2026-08-29 (do not "simplify" back to cursor clicks):
#   - The row's kebab (localized: "More options for <Title>" / "Weitere Optionen fur <Title>")
#     is exposed as an ExpandCollapse control, NOT
#     an Invoke one. `ExpandCollapsePattern.Expand()` opens its context menu - focus-free.
#   - The "Archive" context-menu item exposes InvokePattern. `Invoke()` fires it - focus-free,
#     and it targets that EXACT element, so unlike a coordinate click it can never land on the
#     "Delete" item that sits directly beneath Archive. No point-verification needed.
#   - Neither call moves the mouse or calls SetForegroundWindow. (A cursor-and-foreground variant
#     was the first cut; this replaced it - it is both safer and genuinely focus-free.)
#   - Chromium/Electron builds its accessibility tree LAZILY. A UIA query alone sees only bare
#     panes; the MSAA poke (AccessibleObjectFromWindow on each Chrome_RenderWidgetHostHWND) is
#     what switches the full tree on. Without it every Find returns nothing.
#
# REACH LIMIT, stated honestly because it is fundamental, not a bug here: the accessibility tree
# contains only RENDERED sidebar rows. A chat in a collapsed folder group, or scrolled out of the
# virtualized list, is not present and cannot be actioned - this script reports that (exit 3)
# rather than pretending. It reliably archives a chat that is currently visible in the sidebar
# (the common "I just finished with this chat" case). It will try to expand the chat's own folder
# group first (focus-free) to bring it into view. Bringing a deeply-scrolled row into a virtualized
# viewport focus-free is not solved (Chromium's scroll container is not reliably drivable), so for
# an off-screen chat, scroll it into view first or archive it from its own window.
#
# NOT AVAILABLE, and why (measured 2026-08-29): a Chrome DevTools Protocol route (--remote-
# debugging-port) would sidestep rendering entirely, but Claude Desktop EXITS when launched with a
# debug port (proven A/B: same instance, plain launch runs, debug launch quits). The app refuses
# remote debugging, so CDP is not an option.
#
# USAGE
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "Exact chat title"
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "..." -Instance 5claude
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "..." -Action Unarchive   # (only reaches
#                                              a currently-rendered archived row)
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "..." -Action Rename -NewTitle "Real name"
#   powershell -File misc/Manage-DesktopChat.ps1 -List -Instance 5claude          # rendered rows
#
# RENAME (piece 6 of the rebuild, proven live 2026-08-29): the app's own Rename control is the
# ONE write a running app cannot undo (v1 measured every outside metadata write being re-saved
# away), so this is how a landed chat's DISPLAYED name is fixed immediately. Mechanics: the
# Rename menu item Invokes; the inline editor is an Edit named 'Rename' exposing ValuePattern
# (SetValue is focus-free); the commit is a posted WM_KEYDOWN Enter to the render widget - no
# global focus, no cursor. After committing, the app re-saves the metadata itself, so disk and
# app memory AGREE on the name (verified). -NewTitle must be a real name: generic non-names are
# refused here with the same patterns chat-title.ts owns (that file is canonical; keep in sync).
#
# Exit: 0 done (row left the sidebar) - 1 error - 2 invoked but row still present - 3 not rendered.
param(
  [string]$Title,
  [string]$Instance = '',
  [ValidateSet('Archive', 'Unarchive', 'Rename')][string]$Action = 'Archive',
  [string]$NewTitle = '',
  [switch]$List
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$src = @'
using System;using System.Runtime.InteropServices;using System.Collections.Generic;using System.Text;
public static class Ax{
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumFunc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [In,Out,MarshalAs(UnmanagedType.IUnknown)] ref object p);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  delegate bool EnumFunc(IntPtr h, IntPtr l);
  static List<IntPtr> widgets(IntPtr top){
    var ws = new List<IntPtr>();
    EnumChildWindows(top, (h,l) => { var sb = new StringBuilder(256); GetClassName(h, sb, 256); if (sb.ToString().Contains("Chrome_RenderWidgetHostHWND")) ws.Add(h); return true; }, IntPtr.Zero);
    return ws;
  }
  public static void PostEnter(IntPtr top){
    foreach (var w in widgets(top)) {
      PostMessageW(w, 0x0100, (IntPtr)0x0D, (IntPtr)0x001C0001);
      System.Threading.Thread.Sleep(50);
      PostMessageW(w, 0x0101, (IntPtr)0x0D, unchecked((IntPtr)(long)0xC01C0001));
    }
  }
  public static void Wake(IntPtr top){
    Guid g = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    var ws = new List<IntPtr>();
    EnumChildWindows(top, (h,l) => { var sb = new StringBuilder(256); GetClassName(h, sb, 256); if (sb.ToString().Contains("Chrome_RenderWidgetHostHWND")) ws.Add(h); return true; }, IntPtr.Zero);
    foreach (var w in ws) { object a = null; AccessibleObjectFromWindow(w, 0xFFFFFFFC, ref g, ref a); }
  }
}
'@
Add-Type -TypeDefinition $src

$root = [System.Windows.Automation.AutomationElement]::RootElement
$TREE = [System.Windows.Automation.TreeScope]::Descendants
$BTN = [System.Windows.Automation.ControlType]::Button

function Wake([IntPtr]$hwnd) { [Ax]::Wake($hwnd); Start-Sleep -Milliseconds 800; return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
function ByName($scope, $name) { $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name); return $scope.FindFirst($TREE, $c) }
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }

# THE KEBAB IS LOCALIZED (found live 2026-08-30 on a German-locale app: the row menu reads
# 'Weitere Optionen für <title>', not 'More options for <title>'). Matching the English prefix
# found NOTHING there, so archive/rename/list were silently inert on any non-English app -
# they reported "not rendered" for chats sitting in plain view. Match structurally instead:
# the kebab is the Button whose name ENDS WITH the title and exposes ExpandCollapse (the row
# button itself carries a status prefix like 'Inaktiv <title>' and exposes Invoke, not
# ExpandCollapse), so the pattern - not the language - identifies it.
# THE MENU ITEMS ARE LOCALIZED TOO, and their AutomationIds are React churn
# ('base-ui-_r_l0_'), so neither the English name nor an id can find Archive on a German app
# (measured: 'Archivieren', 'Umbenennen', 'Löschen'). Position is NOT an option - Delete sits
# directly below Archive, which is the one mistake this whole script exists to make
# impossible. So: an explicit label table per action, and if nothing matches we REFUSE and
# print the menu we saw. Never invoke an item we cannot name.
$ACTION_LABELS = @{
  'Archive'   = @('Archive', 'Archivieren', 'Archiver', 'Archivar', 'Archiviare', 'Archiveren')
  'Unarchive' = @('Unarchive', 'Nicht mehr archivieren', 'Désarchiver', 'Desarchivar', 'Dearchiviare')
  'Rename'    = @('Rename', 'Umbenennen', 'Renommer', 'Cambiar nombre', 'Rinomina', 'Hernoemen')
}
function MenuItemFor($cond, $action) {
  $wanted = $ACTION_LABELS[$action]
  $seen = @()
  foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    foreach ($e in $t.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.MenuItem') { continue }
      $n = $e.Current.Name
      if (-not $n) { continue }
      $seen += $n
      if ($wanted -contains $n) { return @{ Item = $e; Seen = $seen } }
    }
  }
  return @{ Item = $null; Seen = $seen }
}

function KebabFor($scope, $title) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
  foreach ($b in $scope.FindAll($TREE, $c)) {
    $n = $b.Current.Name
    if ($n -and $n.EndsWith($title) -and (TryPattern $b ([System.Windows.Automation.ExpandCollapsePattern]::Pattern))) { return $b }
  }
  return $null
}
# -List emits each kebab's accessible name VERBATIM - '<localized more-options phrase>
# <title>' - and does NOT try to carve the title out of it. Deriving the title needs the
# localized phrase, and every heuristic for guessing it (longest common suffix against
# sibling rows) produced junk entries on the real tree ('en', 'gen', 'ungen'). The caller
# already knows the exact disk title it is looking for, so IT matches by suffix - exact,
# language-independent, and with nothing to guess. ui-archive.ts parseListOutput owns that end.
function RenderedKebabNames($scope) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
  $out = @()
  foreach ($b in $scope.FindAll($TREE, $c)) {
    $n = $b.Current.Name
    if ($n -and (TryPattern $b ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) -and $out -notcontains $n) {
      $out += $n
    }
  }
  return $out
}

# Running Claude desktop instances: a main process (no --type=) with --user-data-dir is a
# managed instance; one WITHOUT the flag is the DEFAULT %APPDATA%\Claude install (piece-10
# review: the default profile was structurally invisible here, so the most common app - the
# owner's primary install - could never be listed or clicked).
$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '--user-data-dir=("?)([^"]+?)\1(\s|$)')
    $dir = if ($m.Success) { $m.Groups[2].Value } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
if ($Instance) {
  # A path-shaped hint (contains a slash) must match the dir EXACTLY - an unanchored substring
  # let '...\i1' also match '...\i10' (piece-10 review), and a wrong instance means a wrong
  # chat archived. Short names keep the convenient substring match for manual use.
  $mains = @($mains | Where-Object {
    if ($Instance -match '[\\/]') { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') }
    else { $_.Dir -like "*$Instance*" }
  })
}
if (-not $mains) { Write-Output "FAIL: no running Claude desktop instance matches '$Instance'"; exit 1 }

if ($Action -eq 'Rename') {
  # THE NAMING LAW (chat-title.ts is canonical; these mirror its patterns): a rename must land
  # a real name. Canonicalize the same way: strip zero-width chars, collapse whitespace.
  $canon = ($NewTitle -replace "[\u200B-\u200D\uFEFF\u00AD]", '') -replace '\s+', ' '
  $canon = $canon.Trim()
  if (-not $canon -or $canon -match '^(untitled|general coding session|new (chat|session))$' -or $canon -match '^\[orchestrator\]') {
    Write-Output "FAIL: -NewTitle '$NewTitle' is a generic non-name (owner rule: real names only)"
    exit 1
  }
  $NewTitle = $canon
}

foreach ($m in $mains) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$m.ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { continue }
  $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)

  if ($List) {
    Write-Output "== $($m.Dir) (pid $($m.ProcId)) rendered chats =="
    $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
    foreach ($t in RenderedKebabNames $el) { '  ' + $t }
    continue
  }

  if (-not $Title) { Write-Output 'FAIL: -Title is required (or use -List)'; exit 1 }

  $kebab = KebabFor $el $Title
  if (-not $kebab) {
    # Try to bring it into view by expanding its folder group(s) (focus-free), then re-look.
    foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      $ec = TryPattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($ec -and $ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed -and $e.Current.Name -and $e.Current.Name.Length -lt 40 -and -not $e.Current.Name.EndsWith($Title)) {
        try { $ec.Expand(); Start-Sleep -Milliseconds 250 } catch { }
      }
    }
    $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)
    $kebab = KebabFor $el $Title
  }
  if (-not $kebab) { continue }  # not in this instance; try the next

  Write-Output "found '$Title' in $($m.Dir)"
  $ec = TryPattern $kebab ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if (-not $ec) { Write-Output 'FAIL: kebab does not expose ExpandCollapse (app UI changed?)'; exit 1 }
  $ec.Expand()
  Start-Sleep -Milliseconds 800

  $found = MenuItemFor $cond $Action
  $item = $found.Item
  if (-not $item) {
    try { $ec.Collapse() } catch { }
    Write-Output ("FAIL: menu opened but no '$Action' item matched a known label. Menu showed: " +
      ($found.Seen -join ' | ') +
      ". Add this locale's label to `$ACTION_LABELS - refusing rather than guessing by position, because Delete sits next to Archive.")
    exit 1
  }
  $inv = TryPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output "FAIL: '$Action' item does not expose Invoke"; exit 1 }
  $inv.Invoke()
  Start-Sleep -Milliseconds 1200

  if ($Action -eq 'Rename') {
    # The inline editor: an Edit named 'Rename' exposing ValuePattern. SetValue is focus-free;
    # the commit is a posted Enter to the render widget.
    $hwndTop = [IntPtr]$win.Current.NativeWindowHandle
    [Ax]::Wake($hwndTop); Start-Sleep -Milliseconds 800
    # The editor may live under a sibling top-level pane, not the main window subtree - search
    # every top-level element of this process (how the working probe found it).
    # RENAME IS ENGLISH-ONLY AND KNOWN-INCOMPLETE (2026-08-30). Archive/Unarchive are now
    # locale-independent (structural kebab + the $ACTION_LABELS table), but the inline rename
    # EDITOR is not: on a German app the Rename item invokes and the menu closes, yet no
    # writable Edit holding the old title ever appears in the tree - only the composer. The
    # editor is presumably rendered in a way this build does not expose. Rather than ship a
    # guess, this path stays as it was: it works on an English app, and says so plainly
    # elsewhere. The delivery actuator does not depend on it.
    $edit = $null
    $ecEdit = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Rename')
    foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      foreach ($e in $t.FindAll($TREE, $ecEdit)) {
        if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit') { $edit = $e; break }
      }
      if ($edit) { break }
    }
    if (-not $edit) {
      Write-Output 'FAIL: rename editor did not open (known limit: the inline editor is not exposed on non-English builds - archive/unarchive are locale-independent, rename is not)'
      exit 1
    }
    $vp = TryPattern $edit ([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $vp) { Write-Output 'FAIL: rename editor exposes no ValuePattern'; exit 1 }
    # Commit loop: SetValue, verify the editor actually holds the new text, post Enter, check
    # the row; retry up to 3 times (a posted keystroke can race the editor's first paint).
    $renamed = $false
    for ($try = 1; $try -le 3 -and -not $renamed; $try++) {
      $vp.SetValue($NewTitle)
      Start-Sleep -Milliseconds 500
      $held = try { $vp.Current.Value } catch { '' }
      if ($held -ne $NewTitle) { Start-Sleep -Milliseconds 500; continue }
      [Ax]::PostEnter($hwndTop)
      Start-Sleep -Milliseconds 1500
      $el = Wake $hwndTop
      $renamed = [bool](KebabFor $el $NewTitle)
    }
    if (-not $renamed) { Write-Output 'RENAME INVOKED but the row does not render the new name - report this'; exit 2 }
    Write-Output "Rename done: '$Title' -> '$NewTitle' (focus-free; committed through the app, so disk and app memory agree)"
    exit 0
  }

  $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)
  $still = [bool](KebabFor $el $Title)
  if ($Action -eq 'Archive' -and $still) { Write-Output 'INVOKED but row still present - report this, do not blind-retry'; exit 2 }
  Write-Output "$Action done for '$Title' (focus-free: no SetForegroundWindow, no cursor)"
  exit 0
}
if ($List) { exit 0 }
Write-Output "FAIL: '$Title' not rendered in any searched running instance (collapsed group or virtualized out - scroll it into view, then retry)"
exit 3
