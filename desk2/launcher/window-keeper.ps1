# Remembers where the Hydra Desk 2 window sits and puts it back there on the next launch.
#
# The browser saves an app window's placement in its profile only now and then, so a window that is
# killed (not closed) came back at an old size (Jacob, 2026-10-04). start.ps1 runs this hidden next to
# the window: every 2 s it reads the window's placement (normal bounds, maximized or not) and writes it
# to ~/.hydra-desk-2/window.json when it changed; with -Apply it first restores the saved placement on the
# window just opened. It exits once the window's browser process is gone. One keeper at a time.
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
'@

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
  while ($true) {
    $proc = Find-Window
    $h = if ($proc) { $proc.MainWindowHandle } else { [IntPtr]::Zero }
    if ($h -eq [IntPtr]::Zero) {
      # Gone after it was seen, or never showed up: nothing left to keep.
      if (((Get-Date) - $missingSince).TotalSeconds -gt $(if ($last) { 4 } else { 30 })) { break }
    } else {
      $missingSince = Get-Date
      if (-not $applied) {
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
        }
      }
      $wp = New-Placement
      if ([HydraDesk.Placement]::GetWindowPlacement($h, [ref]$wp) -and $wp.showCmd -ne 2) {  # 2 = minimized: keep the last
        $r = $wp.rcNormalPosition
        $state = [ordered]@{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; maximized = ($wp.showCmd -eq 3) }
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
