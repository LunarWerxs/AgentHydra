# misc/Archive-DesktopChat.ps1 - archive a chat in a RUNNING Claude desktop app by driving
# the app's OWN sidebar UI, so the row disappears immediately and the app itself writes the
# archive flag (which therefore survives the app's metadata re-saves - the write is the app's).
#
# WHY THIS EXISTS (owner directive, Michael, 2026-08-29): a running app holds its chat list in
# memory, so a flag flipped on DISK stays on screen until that app restarts - and restarting is
# not an option. The app's own archive control is the one channel that is immediate AND durable
# on a live app. This automates exactly that: find the row, open its "More options" menu, click
# Archive. Proven live 2026-08-29 on the 5claude instance (row gone instantly, disk flag flipped
# by the app within a second).
#
# MECHANICS worth knowing before editing:
#   - Chromium/Electron builds its accessibility tree LAZILY. A UIA query alone can see only
#     bare panes; the MSAA poke (AccessibleObjectFromWindow on each Chrome_RenderWidgetHostHWND)
#     is what switches the full tree on. Without it every Find returns nothing.
#   - Sidebar rows are named "<State> <Title>" (e.g. "Idle My chat", "Running My chat",
#     "Unread response My chat"); the kebab is literally named "More options for <Title>".
#   - InvokePattern is NOT exposed through the bridge, so this clicks with a real cursor.
#     EVERY click is point-verified first (AutomationElement.FromPoint must resolve to the
#     element we intend) because the menu's Archive item sits directly above Delete - a blind
#     click that lands one item off would destroy a chat instead of archiving it. On any
#     verification failure the script presses Esc and aborts; it never guesses.
#   - Clicking needs the window on top: the script foregrounds the app (and restores it if
#     minimized), which briefly steals focus and moves the real cursor (restored afterwards).
#     Fine unattended; intrusive mid-use - do not run it while the owner is actively typing.
#
# USAGE
#   powershell -File misc/Archive-DesktopChat.ps1 -Title "Exact chat title"
#   powershell -File misc/Archive-DesktopChat.ps1 -Title "Exact chat title" -Instance 5claude
#   powershell -File misc/Archive-DesktopChat.ps1 -Title "..." -DryRun   # prove reachability, Esc out
#
# Exit codes: 0 archived (or DryRun reachable) · 1 not found / not verifiable · 2 clicked but
# the row did not disappear (report it - do not retry blind).
param(
  [Parameter(Mandatory = $true)][string]$Title,
  # Substring of the instance's --user-data-dir (e.g. "5claude"). Omitted = search every
  # running Claude desktop window until the chat row is found.
  [string]$Instance = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public static class Native {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumFunc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [In, Out, MarshalAs(UnmanagedType.IUnknown)] ref object ppv);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumFunc(IntPtr hWnd, IntPtr lp);
  public static List<IntPtr> RenderWidgets(IntPtr top) {
    var found = new List<IntPtr>();
    EnumChildWindows(top, (h, l) => {
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString().Contains("Chrome_RenderWidgetHostHWND")) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void WakeAccessibility(IntPtr top) {
    Guid iidAcc = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    foreach (var w in RenderWidgets(top)) { object acc = null; AccessibleObjectFromWindow(w, 0xFFFFFFFC, ref iidAcc, ref acc); }
  }
  public static void Click() {
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(70);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Escape() { keybd_event(0x1B, 0, 0, UIntPtr.Zero); keybd_event(0x1B, 0, 2, UIntPtr.Zero); }
}
'@
Add-Type -TypeDefinition $src

function Find-Named([System.Windows.Automation.AutomationElement]$scope, [string]$name) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}
# Move the cursor to an element's center and confirm the OS resolves that exact point back to
# an element of the expected name. The only way a click is allowed to happen.
function Approach([System.Windows.Automation.AutomationElement]$el, [string]$expectName) {
  $r = $el.Current.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { return $false }
  $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  [void][Native]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 350
  try { $under = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch { return $false }
  return ($under.Current.Name -eq $expectName)
}

# The chat's desktop instances: every main claude.exe with a --user-data-dir.
$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -match '--user-data-dir=("?)([^"]+?)\1(\s|$)' -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object { [pscustomobject]@{ ProcId = $_.ProcessId; DataDir = ([regex]::Match($_.CommandLine, '--user-data-dir=("?)([^"]+?)\1(\s|$)').Groups[2].Value) } }
if ($Instance) { $mains = @($mains | Where-Object { $_.DataDir -like "*$Instance*" }) }
if (-not $mains) { Write-Output "FAIL: no running Claude desktop instance matches '$Instance'"; exit 1 }

$saved = New-Object Native+POINT; [void][Native]::GetCursorPos([ref]$saved)
$root = [System.Windows.Automation.AutomationElement]::RootElement
$STATES = @('Idle', 'Running', 'Unread response')

foreach ($m in $mains) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$m.ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { continue }
  $hwnd = [IntPtr]$win.Current.NativeWindowHandle
  if ([Native]::IsIconic($hwnd)) { [void][Native]::ShowWindow($hwnd, 9); Start-Sleep -Milliseconds 600 } # SW_RESTORE
  [Native]::WakeAccessibility($hwnd)
  Start-Sleep -Milliseconds 800

  # The row: state-prefixed name, or bare title as fallback.
  $row = $null
  foreach ($s in $STATES) { $row = Find-Named $win "$s $Title"; if ($row) { break } }
  if (-not $row) { $row = Find-Named $win $Title }
  if (-not $row) { continue }
  Write-Output "row found in instance '$($m.DataDir)' (pid $($m.ProcId))"

  [void][Native]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 300

  # The kebab may be hover-revealed: hover the row first when it has no rect.
  $kebabName = "More options for $Title"
  $kebab = Find-Named $win $kebabName
  if (-not $kebab -or $kebab.Current.BoundingRectangle.Width -le 0) {
    $rr = $row.Current.BoundingRectangle
    [void][Native]::SetCursorPos([int]($rr.X + $rr.Width / 2), [int]($rr.Y + $rr.Height / 2))
    Start-Sleep -Milliseconds 500
    $kebab = Find-Named $win $kebabName
  }
  if (-not $kebab) { Write-Output 'FAIL: kebab (More options) not exposed'; exit 1 }
  if (-not (Approach $kebab $kebabName)) { Write-Output 'FAIL: could not verify cursor on the kebab'; exit 1 }
  $kr = $kebab.Current.BoundingRectangle
  [Native]::Click()
  # Park the cursor OFF the menu immediately: left where it is, it hovers the first item
  # ("Open in"), whose fly-out submenu can cover Archive and fail the point-verify below.
  [void][Native]::SetCursorPos([int]($kr.X - 350), [int]$kr.Y)
  Start-Sleep -Milliseconds 700

  # The context menu, freshly enumerated. Point-verified: an unverified click here could hit
  # Delete, which sits directly under Archive. Verified with retries - the menu needs a beat
  # to settle before FromPoint resolves its items.
  $archive = $null
  foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    $h = Find-Named $t 'Archive'
    if ($h -and $h.Current.ControlType.ProgrammaticName -eq 'ControlType.MenuItem') { $archive = $h; break }
  }
  if (-not $archive) { Write-Output 'FAIL: menu opened but no Archive item found'; [Native]::Escape(); exit 1 }
  $onArchive = $false
  for ($try = 1; $try -le 3 -and -not $onArchive; $try++) {
    $onArchive = Approach $archive 'Archive'
    if (-not $onArchive) { Start-Sleep -Milliseconds 450 }
  }
  if (-not $onArchive) { Write-Output 'FAIL: cursor did not verify on Archive - aborting, nothing clicked'; [Native]::Escape(); exit 1 }
  if ($DryRun) {
    Write-Output 'DRYRUN OK: Archive item reachable and point-verified; closing menu untouched'
    [Native]::Escape()
    [void][Native]::SetCursorPos($saved.X, $saved.Y)
    exit 0
  }
  [Native]::Click()
  Start-Sleep -Milliseconds 1200

  # Verify: the row must be gone. (The app also rewrites the metadata file itself within ~1s;
  # callers wanting the disk proof can hit GET /api/chats/dossier afterwards.)
  $still = $null
  foreach ($s in $STATES) { $still = Find-Named $win "$s $Title"; if ($still) { break } }
  [void][Native]::SetCursorPos($saved.X, $saved.Y)
  if ($still) { Write-Output 'CLICKED BUT ROW STILL PRESENT - report this, do not blind-retry'; exit 2 }
  Write-Output "ARCHIVED: '$Title' left the sidebar of '$($m.DataDir)'"
  exit 0
}
Write-Output "FAIL: chat row '$Title' not found in any searched running instance"
[void][Native]::SetCursorPos($saved.X, $saved.Y)
exit 1
