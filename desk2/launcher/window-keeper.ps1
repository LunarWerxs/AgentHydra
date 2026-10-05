# Remembers where the Hydra Desk 2 window sits and puts it back there on the next launch.
#
# The browser saves an app window's placement in its profile only now and then, so a window that is
# killed (not closed) came back at an old size (Jacob, 2026-10-04). start.ps1 runs this hidden next to
# the window: every 2 s it reads the window's placement (normal bounds, maximized or not) and writes it
# to ~/.hydra-desk-2/window.json when it changed; with -Apply it first restores the saved placement on the
# window just opened. It exits once the window's browser process is gone. One keeper at a time.
#
# A snapped window (Win+arrow, a snap layout, dragged to an edge) is not "moved" as far as its placement
# goes: its normal bounds stay where it floated before the snap, so the window came back there, not where
# it was closed (owner, 2026-10-04: "HD2 needs to remember the size and placement of the window when
# closed"). So it also keeps the window's rectangle as it is on screen, and a window that was not maximized
# goes back to exactly that.
param(
  [Parameter(Mandatory)] [string]$BrowserExe,
  [Parameter(Mandatory)] [string]$WindowProfile,
  [Parameter(Mandatory)] [string]$StateFile,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace HydraDesk -Name Placement -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
  public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition;
}
[DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
[DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
'@

# Real pixels on every monitor: a DPI-unaware reader gets scaled figures that do not round-trip on a
# monitor scaled differently from the main one. -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
# Windows before 10 1607 has no such call: the keeper then reads scaled figures, as it always did.
try { [void][HydraDesk.Placement]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) } catch { }  # floor-ok: the fallback is the old behaviour

# The browser process that owns our profile (not its --type= helpers), as start.ps1 finds it.
function Find-Window {
  $needle = $WindowProfile.ToLowerInvariant()
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='$BrowserExe'" -ErrorAction SilentlyContinue)) {
    $cmd = [string]$p.CommandLine
    if ($cmd -and $cmd.ToLowerInvariant().Contains($needle) -and $cmd -notmatch '--type=') {
      $proc = Get-Process -Id ([int]$p.ProcessId) -ErrorAction SilentlyContinue
      if ($proc) { return $proc }
    }
  }
  return $null
}

function New-Placement {
  $wp = New-Object HydraDesk.Placement+WINDOWPLACEMENT
  $wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)
  return $wp
}

function Read-Saved {
  try {
    $s = Get-Content -Raw -Path $StateFile | ConvertFrom-Json
    if ($s.right -le $s.left -or $s.bottom -le $s.top) { return $null }
    return $s
  } catch { return $null }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\HydraDesk2WindowKeeper')
# A keeper whose window just closed exits within one tick; wait for it rather than give up.
try { if (-not $mutex.WaitOne(10000)) { exit 0 } } catch [System.Threading.AbandonedMutexException] { }
try {
  $applied = -not $Apply
  $last = ''
  $missingSince = Get-Date
  $proc = $null
  while ($true) {
    # Looked up once, then followed: Find-Window's process query took half a second, every 2 s, for as
    # long as the window was open. Refresh() re-reads the window handle of the process already found.
    if (-not $proc -or $proc.HasExited) { $proc = Find-Window } else { $proc.Refresh() }
    $h = if ($proc) { $proc.MainWindowHandle } else { [IntPtr]::Zero }
    if ($h -eq [IntPtr]::Zero) {
      # Gone after it was seen, or never showed up: nothing left to keep.
      if (((Get-Date) - $missingSince).TotalSeconds -gt $(if ($last) { 4 } else { 30 })) { break }
    } else {
      $missingSince = Get-Date
      # Applied once the window shows, so the browser's own restore (its normal bounds, from before any
      # snap) is already done and does not land on top of ours.
      if (-not $applied -and [HydraDesk.Placement]::IsWindowVisible($h)) {
        $applied = $true
        $s = Read-Saved
        if ($s) {
          $wp = New-Placement
          [void][HydraDesk.Placement]::GetWindowPlacement($h, [ref]$wp)
          $wp.rcNormalPosition.Left = [int]$s.left
          $wp.rcNormalPosition.Top = [int]$s.top
          $wp.rcNormalPosition.Right = [int]$s.right
          $wp.rcNormalPosition.Bottom = [int]$s.bottom
          $wp.showCmd = if ($s.maximized) { 3 } else { 1 }  # SW_SHOWMAXIMIZED / SW_SHOWNORMAL
          $wp.flags = 0
          [void][HydraDesk.Placement]::SetWindowPlacement($h, [ref]$wp)
          # Then the rectangle it had on screen (a snapped one included), only while both ends of its title
          # bar are still on a monitor: one left mostly on a monitor since unplugged could not be dragged
          # back. SetWindowPlacement above already pulled an off-screen window back onto one.
          $w = $s.window
          if (-not $s.maximized -and $w -and $w.right -gt $w.left -and $w.bottom -gt $w.top) {
            $rect = New-Object HydraDesk.Placement+RECT
            $rect.Left = [int]$w.left; $rect.Top = [int]$w.top; $rect.Right = [int]$w.right; $rect.Bottom = [int]$w.bottom
            $onMonitor = {
              param([int]$x, [int]$y)
              $pt = New-Object HydraDesk.Placement+POINT
              $pt.X = $x; $pt.Y = $y
              [HydraDesk.Placement]::MonitorFromPoint($pt, 0) -ne [IntPtr]::Zero  # 0 = MONITOR_DEFAULTTONULL
            }
            # 16 px in: past the invisible resize border a window's rectangle includes, inside its title bar.
            if ((& $onMonitor ($rect.Left + 16) ($rect.Top + 16)) -and (& $onMonitor ($rect.Right - 16) ($rect.Top + 16))) {
              # 0x14 = SWP_NOZORDER | SWP_NOACTIVATE
              [void][HydraDesk.Placement]::SetWindowPos($h, [IntPtr]::Zero, $rect.Left, $rect.Top, $rect.Right - $rect.Left, $rect.Bottom - $rect.Top, 0x14)
            }
          }
        }
      }
      $wp = New-Placement
      if ([HydraDesk.Placement]::GetWindowPlacement($h, [ref]$wp) -and $wp.showCmd -ne 2) {  # 2 = minimized: keep the last
        $r = $wp.rcNormalPosition
        $state = [ordered]@{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; maximized = ($wp.showCmd -eq 3) }
        # Where it is on screen while it is not maximized: a snapped window's own rectangle, which its
        # normal bounds above do not follow.
        $onScreen = New-Object HydraDesk.Placement+RECT
        if ($wp.showCmd -ne 3 -and [HydraDesk.Placement]::GetWindowRect($h, [ref]$onScreen)) {
          $state.window = [ordered]@{ left = $onScreen.Left; top = $onScreen.Top; right = $onScreen.Right; bottom = $onScreen.Bottom }
        }
        $json = $state | ConvertTo-Json -Compress
        if ($json -ne $last) {
          $dir = Split-Path -Parent $StateFile
          if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
          $tmp = "$StateFile.tmp"
          Set-Content -Path $tmp -Value $json -Encoding UTF8
          Move-Item -Force -Path $tmp -Destination $StateFile
          $last = $json
        }
      }
    }
    Start-Sleep -Seconds 2
  }
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
