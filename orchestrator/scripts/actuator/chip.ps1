# chip.ps1 - THE SUGGESTION CHIP, driven through the app's own controls (built 2026-09-01).
#
# The desktop app plants a "Suggested task" card - a CHIP - in a chat's pane: a title, a
# description, branch tags, and three controls: 'Dismiss suggestion', 'Start with worktree'
# (the default button) and 'More start options' (a menu: 'Start locally', 'Send to cloud',
# 'Fix in this session'). Starting one creates a NEW chat for the suggested task, running at
# once, in the parent's folder and permission mode (measured live: the new chat was born
# 'Running' and read 'Bypass permissions'). Owner order, 2026-09-01: chips ALWAYS 'Start
# locally' - never in a worktree.
#
# Every control is found by NAME; the only thing that opens the start menu is what a person
# does - focus the button and press Space (a WM_KEYDOWN/UP for VK_SPACE posted to the render
# widget; no foreground change, no cursor). Rails: the chat is selected by its EXACT title
# and two rendered rows with that title are a refusal; the card must carry 'Suggested task'.
#
#   -Instance <dir|name> -Title <chat title> -Scan          -> one JSON line: {found, title, description}
#   -Instance ... -Title ... -StartLocally                  -> starts it; exit 0 when the new row renders
#   -Instance ... -Title ... -Dismiss                       -> presses 'Dismiss suggestion'
#   -Instance ... -Open -Scan                               -> scan whatever chat is OPEN, selecting nothing
# Exit: 0 done - 1 error/ambiguity - 2 acted but not confirmed - 3 no chip / row not rendered.
param(
  [Parameter(Mandatory = $true)][string]$Instance,
  [string]$Title = '',
  [switch]$Open,
  [switch]$Scan,
  [switch]$StartLocally,
  [switch]$Dismiss
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace ChipAx -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
public static IntPtr RenderWidget(IntPtr top) {
  IntPtr found = IntPtr.Zero;
  EnumChildWindows(top, (h, p) => {
    var sb = new System.Text.StringBuilder(256); GetClassName(h, sb, 256);
    if (sb.ToString() == "Chrome_RenderWidgetHostHWND") { found = h; return false; }
    return true; }, IntPtr.Zero);
  return found;
}
'@

$TREE = [System.Windows.Automation.TreeScope]::Descendants
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }

$procs = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
if ($Instance -match '[\\/]') { $procs = @($procs | Where-Object { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') }) }
else { $procs = @($procs | Where-Object { $_.Dir -like "*$Instance*" }) }
if (-not $procs) { Write-Output "FAIL: no running instance matches '$Instance'"; exit 1 }
if ((@($procs | ForEach-Object { $_.Dir.ToLowerInvariant() } | Sort-Object -Unique)).Count -gt 1) { Write-Output "FAIL: ambiguous instance '$Instance'"; exit 1 }
$proc = $procs | Select-Object -First 1
$hwnd = (Get-Process -Id $proc.ProcId -ErrorAction SilentlyContinue).MainWindowHandle
if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) { Write-Output 'FAIL: that instance has no window'; exit 1 }

function Root { return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
function AllNamed($root) {
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($e in $root.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $n = $e.Current.Name
      if (-not $n) { continue }
      $r = $e.Current.BoundingRectangle
      $out.Add([pscustomobject]@{ el = $e; name = $n; y = [double]$r.Y; x = [double]$r.X
                                  type = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType.', '') })
    } catch { continue }
  }
  return $out
}
function Press-Space($e) {
  try { $e.SetFocus() } catch { return $false }
  Start-Sleep -Milliseconds 150
  $rw = [ChipAx.W]::RenderWidget($hwnd)
  if ($rw -eq [IntPtr]::Zero) { return $false }
  [void][ChipAx.W]::PostMessage($rw, 0x0100, [IntPtr]0x20, [IntPtr]0); Start-Sleep -Milliseconds 60
  [void][ChipAx.W]::PostMessage($rw, 0x0101, [IntPtr]0x20, [IntPtr]0)
  return $true
}

# 1. Select the chat (unless -Open: act on whatever is open).
if (-not $Open) {
  if (-not $Title) { Write-Output 'FAIL: -Title required unless -Open'; exit 1 }
  $rows = @(AllNamed (Root) | Where-Object { $_.type -eq 'Button' -and -not $_.name.StartsWith('More options') -and
                                             ($_.name -eq $Title -or $_.name.EndsWith(' ' + $Title)) })
  if ($rows.Count -eq 0) { Write-Output "not rendered: no sidebar row for '$Title'"; exit 3 }
  if ($rows.Count -gt 1) { Write-Output "AMBIGUOUS: $($rows.Count) rendered rows end with '$Title' - refusing to guess"; exit 1 }
  $inv = TryPattern $rows[0].el ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output 'FAIL: the row exposes no Invoke'; exit 1 }
  $inv.Invoke(); Start-Sleep -Milliseconds 1500
}

# 2. Find the card: the 'Suggested task' label, then the title and description below it.
$all = AllNamed (Root)
$rr = (Root).Current.BoundingRectangle; $minX = $rr.Left + ($rr.Width * 0.38)
$pane = @($all | Where-Object { $_.x -ge $minX })
$label = $pane | Where-Object { $_.type -eq 'Text' -and $_.name -eq 'Suggested task' } | Select-Object -First 1
$dismissBtn = $pane | Where-Object { $_.type -eq 'Button' -and $_.name -eq 'Dismiss suggestion' } | Select-Object -First 1
if (-not $label -or -not $dismissBtn) {
  if ($Scan) { Write-Output '{"found": false}'; exit 3 }
  Write-Output 'no chip: this chat shows no Suggested task card'; exit 3
}
$texts = @($pane | Where-Object { $_.type -eq 'Text' -and $_.y -gt $label.y -and $_.y -lt ($label.y + 140) -and
                                  $_.name -notmatch '^[a-z0-9]+-[a-z0-9-]+$' } | Sort-Object y)
$chipTitle = if ($texts.Count -ge 1) { $texts[0].name } else { '' }
$chipDesc = if ($texts.Count -ge 2) { $texts[1].name } else { '' }
if ($Scan) {
  $payload = @{ found = $true; title = $chipTitle; description = $chipDesc; chat = $Title } | ConvertTo-Json -Compress
  Write-Output $payload
  exit 0
}

# 3. Act.
if ($Dismiss) {
  $inv = TryPattern $dismissBtn.el ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output 'FAIL: Dismiss suggestion exposes no Invoke'; exit 1 }
  $inv.Invoke(); Start-Sleep -Milliseconds 800
  $still = AllNamed (Root) | Where-Object { $_.type -eq 'Button' -and $_.name -eq 'Dismiss suggestion' -and $_.x -ge $minX } | Select-Object -First 1
  if ($still) { Write-Output "dismiss invoked but the card is still showing ('$chipTitle')"; exit 2 }
  Write-Output "dismissed the suggestion '$chipTitle'"; exit 0
}
if ($StartLocally) {
  $more = $pane | Where-Object { $_.type -eq 'Button' -and $_.name -eq 'More start options' } | Select-Object -First 1
  if (-not $more) { Write-Output "FAIL: no 'More start options' beside the card ('$chipTitle')"; exit 1 }
  if (-not (Press-Space $more.el)) { Write-Output 'FAIL: could not open the start menu (no focus / no render widget)'; exit 1 }
  Start-Sleep -Milliseconds 900
  $item = $null
  foreach ($try in 1..4) {
    $item = AllNamed (Root) | Where-Object { $_.type -eq 'MenuItem' -and $_.name -eq 'Start locally' } | Select-Object -First 1
    if ($item) { break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $item) { Write-Output "FAIL: the start menu opened but no 'Start locally' item appeared"; exit 1 }
  $inv = TryPattern $item.el ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output "FAIL: 'Start locally' exposes no Invoke"; exit 1 }
  $inv.Invoke()
  # The new chat's row renders under the suggestion's title, running.
  $seen = $null
  foreach ($try in 1..10) {
    Start-Sleep -Milliseconds 1000
    $seen = AllNamed (Root) | Where-Object { $_.type -eq 'Button' -and -not $_.name.StartsWith('More options') -and
                                            $_.name.EndsWith(' ' + $chipTitle) } | Select-Object -First 1
    if ($seen) { break }
  }
  if (-not $seen) { Write-Output "started locally, but no sidebar row titled '$chipTitle' rendered within 10s - check the app"; exit 2 }
  Write-Output "STARTED LOCALLY: '$chipTitle' -> new chat row '$($seen.name)'"; exit 0
}
Write-Output 'pass -Scan, -StartLocally or -Dismiss'; exit 1
