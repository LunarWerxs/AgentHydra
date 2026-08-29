# misc/Archive-DesktopChat.ps1 - archive a chat in a RUNNING Claude desktop app WITHOUT stealing
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
#   - The row's kebab ("More options for <Title>") is exposed as an ExpandCollapse control, NOT
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
#   powershell -File misc/Archive-DesktopChat.ps1 -Title "Exact chat title"
#   powershell -File misc/Archive-DesktopChat.ps1 -Title "..." -Instance 5claude
#   powershell -File misc/Archive-DesktopChat.ps1 -Title "..." -Action Unarchive   # (only reaches
#                                              a currently-rendered archived row)
#   powershell -File misc/Archive-DesktopChat.ps1 -List -Instance 5claude          # rendered rows
#
# Exit: 0 done (row left the sidebar) - 1 error - 2 invoked but row still present - 3 not rendered.
param(
  [string]$Title,
  [string]$Instance = '',
  [ValidateSet('Archive', 'Unarchive')][string]$Action = 'Archive',
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
  delegate bool EnumFunc(IntPtr h, IntPtr l);
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

# Running Claude desktop instances (main process = has --user-data-dir, no --type=).
$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -match '--user-data-dir=("?)([^"]+?)\1(\s|$)' -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object { [pscustomobject]@{ ProcId = $_.ProcessId; Dir = ([regex]::Match($_.CommandLine, '--user-data-dir=("?)([^"]+?)\1(\s|$)').Groups[2].Value) } }
if ($Instance) { $mains = @($mains | Where-Object { $_.Dir -like "*$Instance*" }) }
if (-not $mains) { Write-Output "FAIL: no running Claude desktop instance matches '$Instance'"; exit 1 }

foreach ($m in $mains) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$m.ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { continue }
  $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)

  if ($List) {
    Write-Output "== $($m.Dir) (pid $($m.ProcId)) rendered chats =="
    $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
    foreach ($b in $el.FindAll($TREE, $bc)) { if ($b.Current.Name -like 'More options for *') { '  ' + $b.Current.Name.Substring('More options for '.Length) } }
    continue
  }

  if (-not $Title) { Write-Output 'FAIL: -Title is required (or use -List)'; exit 1 }

  $kebab = ByName $el "More options for $Title"
  if (-not $kebab) {
    # Try to bring it into view by expanding its folder group(s) (focus-free), then re-look.
    foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      $ec = TryPattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($ec -and $ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed -and $e.Current.Name -notlike 'More options for *' -and $e.Current.Name -and $e.Current.Name.Length -lt 40) {
        try { $ec.Expand(); Start-Sleep -Milliseconds 250 } catch { }
      }
    }
    $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)
    $kebab = ByName $el "More options for $Title"
  }
  if (-not $kebab) { continue }  # not in this instance; try the next

  Write-Output "found '$Title' in $($m.Dir)"
  $ec = TryPattern $kebab ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if (-not $ec) { Write-Output 'FAIL: kebab does not expose ExpandCollapse (app UI changed?)'; exit 1 }
  $ec.Expand()
  Start-Sleep -Milliseconds 800

  $item = $null
  foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    $h = ByName $t $Action
    if ($h -and $h.Current.ControlType.ProgrammaticName -eq 'ControlType.MenuItem') { $item = $h; break }
  }
  if (-not $item) { try { $ec.Collapse() } catch { }; Write-Output "FAIL: menu opened but no '$Action' item"; exit 1 }
  $inv = TryPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output "FAIL: '$Action' item does not expose Invoke"; exit 1 }
  $inv.Invoke()
  Start-Sleep -Milliseconds 1200

  $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)
  $still = [bool](ByName $el "More options for $Title")
  if ($Action -eq 'Archive' -and $still) { Write-Output 'INVOKED but row still present - report this, do not blind-retry'; exit 2 }
  Write-Output "$Action done for '$Title' (focus-free: no SetForegroundWindow, no cursor)"
  exit 0
}
if ($List) { exit 0 }
Write-Output "FAIL: '$Title' not rendered in any searched running instance (collapsed group or virtualized out - scroll it into view, then retry)"
exit 3
