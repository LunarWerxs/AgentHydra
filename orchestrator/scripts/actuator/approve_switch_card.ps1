# approve_switch_card.ps1 - answer Claude Desktop's "Allow Claude to switch ..." permission card,
# unattended, in a loop.
#
# WHY THIS EXISTS (owner, 2026-10-03: "everything I'm doing gets stuck ... automated task
# orchestration while I sleep"). A manager chat that calls set_session_permission_mode stops on
# the app's permission card and nothing restarts it but a click. approve_prompt.ps1 answers that
# card too, but it is driven per-chat from unblock_prompts.py (transcript scan, verdict, target
# JSON, tray arm) - a batch lane, not a resident watcher. This is the resident watcher: it hangs
# on ONE named instance's window and presses the card's own Allow once the moment it appears.
#
# REUSED WHOLESALE FROM approve_prompt.ps1:
#   * instance resolution - exact --user-data-dir for a path-shaped -Instance, exact leaf-folder
#     match for a bare one ('blaarrrggghhh'), never a substring, never "take the first";
#   * Wake $hwnd - the MSAA AccessibleObjectFromWindow poke that switches Electron's lazy
#     accessibility tree on. Without it the app's buttons do not exist to UIA at all;
#   * TryPattern + InvokePattern - the same press approve_prompt.ps1 uses at its Allow button
#     (line ~657): $inv = TryPattern $b ([InvokePattern]::Pattern); $inv.Invoke().
#
# WHAT THIS DOES DIFFERENTLY, and the only thing it aims at:
#   1. it looks for the CARD TEXT, not a sidebar row: a rendered element whose Name starts with
#      -CardText (default 'Allow Claude to switch') or the observed build-2.19675.0 body
#      -CardTextAlso (default 'This one switches'). ⛔ 'Allow Claude to switch' is NOT a string
#      this build ships (checked resources/en-US.json and the ion-dist bundle): the
#      set_session_permission_mode card renders Vxe's "This one switches a session ... to Bypass
#      permissions ... mode." Both phrases are accepted so an older/newer wording still matches,
#      and the log prints the exact card text that was approved;
#   2. from that element it walks UP the control tree until an ancestor holds exactly one enabled,
#      on-screen button named -AllowName (default 'Allow once'), then presses THAT button. One
#      ancestor with several such buttons is ambiguous and refused, not guessed;
#   3. it never touches a Deny/Cancel/Reject - the button name allow-list below has none in it;
#   4. it LOOPS every -IntervalSecs (default 2), and every detection and every press (with the
#      card text and the button label) is appended to a log file.
#
# RUN HIDDEN (the way it is meant to run):
#   pwsh -NoProfile -File approve_switch_card.ps1 -Instance blaarrrggghhh -Hidden
# -Hidden starts THIS script again through Start-Process -WindowStyle Hidden (no console stays
# open) and returns immediately; the detached child does the looping. The log path is printed
# on start and defaults to <orchestrator>/state/logs/approve-switch-card-<instance>.log.
#
# FOREVER-WATCH GUARDS: a card that will not clear is pressed at most 3 times, then only reported
# ("gave up ... still watching") so a wedged window cannot be clicked every 2s all night. The
# window is never brought to the foreground - InvokePattern needs no focus - and an iconic window
# is shown with SW_SHOWNOACTIVATE at most, so the desk the owner left is not rearranged.
#
# Exit: 0 ran (with -Once: pressed) - 3 with -Once, no card was showing - 6 with -Once, a card was
#       showing but its Allow once was missing/disabled/ambiguous - 1 error/no instance.
param(
  [Parameter(Mandatory = $true)][string]$Instance,
  [string]$CardText = 'Allow Claude to switch',
  # The wording Claude Desktop 2.19675.0 actually renders for this card (see header). '' disables it.
  [string]$CardTextAlso = 'This one switches',
  [string]$AllowName = 'Allow once',
  [ValidateRange(1, 3600)][int]$IntervalSecs = 2,
  [string]$LogPath = '',
  # One scan then exit - for a person testing it at the desk instead of an all-night watcher.
  [switch]$Once,
  # Start this same script detached and windowless through Start-Process -WindowStyle Hidden.
  [switch]$Hidden,
  # Internal marker the hidden child carries; never needed by hand.
  [switch]$Detached,
  # Rarely needed: grab the foreground for this window before each scan. InvokePattern does not
  # require it, so the default leaves the owner's focus alone.
  [switch]$Steal
)
$ErrorActionPreference = 'Stop'
# ⛔ UTF-8 ON THE WAY OUT (same reason as approve_prompt.ps1): a non-ASCII title/name must not
# come back as question marks through the pipe or into the log.
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $OutputEncoding
} catch { }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Approve -Name Inv -MemberDefinition @'
[DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, int id, ref System.Guid iid, ref System.IntPtr ppv);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
public static bool Foreground(IntPtr h) {
  if (IsIconic(h)) ShowWindow(h, 9);
  uint tgt = GetWindowThreadProcessId(h, IntPtr.Zero);
  uint me = GetCurrentThreadId();
  if (tgt == me) return SetForegroundWindow(h);
  AttachThreadInput(me, tgt, true);
  bool ok = SetForegroundWindow(h);
  AttachThreadInput(me, tgt, false);
  return ok;
}
'@

# The localized Allow-once labels approve_prompt.ps1 already carries. -AllowName is the primary;
# these are the same observed translations so a non-English app still matches. NOTHING in here is
# a Deny/Cancel/Reject.
$ALLOW_NAMES = @($AllowName, 'Allow once', 'Einmal erlauben', 'Permitir una vez', 'Autoriser une fois') |
  Where-Object { $_ } | Select-Object -Unique
# Every card-text phrase this watcher will match, on any locale ('Allow Claude to switch' as asked,
# plus the build's observed body). A match needs the element Name to START WITH one of these.
$CARD_PHRASES = @($CardText, $CardTextAlso) | Where-Object { $_ } | Select-Object -Unique
$TREE = [System.Windows.Automation.TreeScope]::Descendants
$BTN = [System.Windows.Automation.ControlType]::Button
$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }

# ⛔ THE CHEAP LOOK (2026-10-04). Find-Card walks every Text element and, when none matches (every
# tick with no card up), EVERY element of the window, one cross-process call per element: six
# watchers did that every 2 s all night and grew to ~1.2 GB each. A card is only pressable through
# an Allow button, so each tick first asks for the buttons' names alone, in one cached round trip
# that keeps no element alive; the full walk runs when one starts with an Allow name, while a card
# is up, and every FULL_SCAN_EVERY ticks so a card with no enabled Allow is still reported.
$FULL_SCAN_EVERY = 30
# A watcher whose private memory passes this starts a fresh copy of itself and exits.
$MAX_PRIVATE_MB = 400
function Test-AllowButton($roots) {
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
  foreach ($root in $roots) {
    $found = $null
    $scope = $cr.Activate()
    try { $found = $root.FindAll($TREE, $btnCond) } catch { $found = $null } finally { $scope.Dispose() }
    if (-not $found) { continue }
    foreach ($b in $found) {
      $n = $null
      try { $n = [string]$b.Cached.Name } catch { continue }
      if ($n -and @($ALLOW_NAMES | Where-Object { $n.StartsWith($_) }).Count -gt 0) { return $true }
    }
  }
  return $false
}

# ---- Logging -------------------------------------------------------------------------------
# Default: <orchestrator>/state/logs/approve-switch-card-<instance>.log. Falls back to %TEMP% if
# the state dir is not writable, because a watcher that cannot log must still watch.
if (-not $LogPath) {
  $leaf = Split-Path -Leaf ($Instance.TrimEnd('\'))
  if (-not $leaf) { $leaf = 'claude' }
  $safe = ($leaf -replace '[^\w.\-]', '_')
  $name = "approve-switch-card-$safe.log"
  try {
    $stateRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'state'
    $dir = Join-Path $stateRoot 'logs'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $LogPath = Join-Path $dir $name
  } catch {
    $LogPath = Join-Path $env:TEMP $name
  }
}
function Write-Log([string]$msg) {
  $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Instance, $msg
  Write-Output $line
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

# ---- Start hidden --------------------------------------------------------------------------
# CommandLineToArgvW quoting, so a spaced instance dir / log path survives Start-Process's
# space-join of -ArgumentList (same hazard detached-spawn.mjs documents).
function Quote-WinArg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $out = '"'; $slashes = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq '\') { $slashes++; continue }
    if ($ch -eq '"') { $out += ('\' * ($slashes * 2 + 1)); $out += '"'; $slashes = 0; continue }
    if ($slashes -gt 0) { $out += ('\' * $slashes); $slashes = 0 }
    $out += $ch
  }
  $out += ('\' * ($slashes * 2))
  return $out + '"'
}
function Start-HiddenWatcher {
  $exe = (Get-Process -Id $PID).Path
  $raw = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
           '-Instance', $Instance, '-IntervalSecs', "$IntervalSecs",
           '-CardText', $CardText, '-CardTextAlso', $CardTextAlso, '-AllowName', $AllowName,
           '-LogPath', $LogPath, '-Detached')
  if ($Once) { $raw += '-Once' }
  if ($Steal) { $raw += '-Steal' }
  $quoted = @($raw | ForEach-Object { Quote-WinArg $_ })
  Start-Process -FilePath $exe -ArgumentList $quoted -WindowStyle Hidden
}
if ($Hidden -and -not $Detached) {
  Start-HiddenWatcher
  Write-Log "started hidden watcher (child of pid $PID)"
  exit 0
}

# ---- Find THIS instance's window (approve_prompt.ps1's rail 1/1b, verbatim in spirit) -------
$procs = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
if (-not $Instance -or $Instance.Trim() -eq '') {
  Write-Log 'FAIL: -Instance is blank - refusing to act without a positively identified window'
  exit 1
}
$allDirs = @($procs | ForEach-Object { $_.Dir } | Sort-Object -Unique)
if ($Instance -match '[\\/]') {
  $procs = @($procs | Where-Object { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') })
} else {
  $procs = @($procs | Where-Object {
    (Split-Path -Leaf $_.Dir.TrimEnd('\')).Equals($Instance, [System.StringComparison]::OrdinalIgnoreCase)
  })
}
if ($procs.Count -ne 1) {
  Write-Log "FAIL: '$Instance' matches $($procs.Count) running instances; candidates: $($allDirs -join '; ')"
  exit 1
}
$proc = $procs | Select-Object -First 1

function Window-Inventory([int]$procId) {
  $out = @()
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$procId)
    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                     [System.Windows.Automation.TreeScope]::Children, $cond)) {
      try {
        $r = $w.Current.BoundingRectangle
        $empty = $r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0
        $out += [pscustomobject]@{
          Hwnd = [int]$w.Current.NativeWindowHandle
          Name = [string]$w.Current.Name
          Offscreen = [bool]$w.Current.IsOffscreen
          Area = if ($empty) { 0 } else { [int]($r.Width * $r.Height) }
        }
      } catch { continue }
    }
  } catch { }
  return $out
}

$hwnd = (Get-Process -Id $proc.ProcId -ErrorAction SilentlyContinue).MainWindowHandle
if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) {
  $best = @(Window-Inventory $proc.ProcId | Where-Object { -not $_.Offscreen -and $_.Area -gt 0 } |
            Sort-Object Area -Descending) | Select-Object -First 1
  if ($best) { $hwnd = [IntPtr]$best.Hwnd }
}
if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) {
  Write-Log "FAIL: that instance has no window (pid $($proc.ProcId))"
  exit 1
}

# The MSAA poke (approve_prompt.ps1's Wake, reused): switches Electron's lazy accessibility tree
# on so buttons exist to UIA at all.
function Wake($h, [int]$SleepMs = 0) {
  $cb = [Approve.Inv+EnumProc]{
    param($c, $lp)
    $sb = New-Object System.Text.StringBuilder 256
    [void][Approve.Inv]::GetClassName($c, $sb, 256)
    if ($sb.ToString() -eq 'Chrome_RenderWidgetHostHWND') {
      $iid = [Guid]'618736e0-3c3d-11cf-810c-00aa00389b71'; $ppv = [IntPtr]::Zero
      [void][Approve.Inv]::AccessibleObjectFromWindow($c, -4, [ref]$iid, [ref]$ppv)
    }
    return $true
  }
  [void][Approve.Inv]::EnumChildWindows($h, $cb, [IntPtr]::Zero)
  if ($SleepMs -gt 0) { Start-Sleep -Milliseconds $SleepMs }
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

# The main window first, then every visible top-level window this pid owns (a card can also be a
# separate owned window), scoped to this process so no other instance is ever read.
function Get-Roots([int]$procId, $mainHwnd) {
  $roots = @()
  try {
    $main = [System.Windows.Automation.AutomationElement]::FromHandle($mainHwnd)
    if ($main) { $roots += $main }
  } catch { }
  try {
    $pidCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$procId)
    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                     [System.Windows.Automation.TreeScope]::Children, $pidCond)) {
      try {
        if ($mainHwnd -and $w.Current.NativeWindowHandle -eq [int]$mainHwnd) { continue }
        if ($w.Current.IsOffscreen -or $w.Current.BoundingRectangle.IsEmpty) { continue }
        $roots += $w
      } catch { continue }
    }
  } catch { }
  return $roots
}

# From a matched card-text element: walk UP until an ancestor holds exactly one enabled, on-screen
# Allow button, then return that button. Several in one ancestor is ambiguous - refused, not
# guessed. (This is the "up to the card container, then down to its button".)
# ⛔ The walk stops at an ancestor with more than $CARD_MAX_BUTTONS buttons of any kind: a card
# holds a handful, a chat pane holds dozens. Without the stop, chat text that merely starts with a
# card phrase could climb to the pane and press the lone Allow once of a different permission card.
$CARD_MAX_BUTTONS = 8
function Find-AllowButton($start) {
  $node = $start
  for ($depth = 0; $depth -lt 12; $depth++) {
    try { $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node) } catch { $node = $null }
    if (-not $node) { break }
    try { if ($node.Current.BoundingRectangle.IsEmpty) { continue } } catch { break }
    $all = $node.FindAll($TREE, $btnCond)
    if ($all.Count -gt $CARD_MAX_BUTTONS) { return @{ Button = $null; Card = $null; Why = 'too-wide'; Count = $all.Count } }
    $btns = @()
    foreach ($b in $all) {
      try {
        $n = $b.Current.Name
        if (-not $n) { continue }
        if (@($ALLOW_NAMES | Where-Object { $n.StartsWith($_) }).Count -eq 0) { continue }
        if (-not $b.Current.IsEnabled -or $b.Current.IsOffscreen) { continue }
        if ($b.Current.BoundingRectangle.IsEmpty) { continue }
        $btns += $b
      } catch { continue }
    }
    if ($btns.Count -eq 1) { return @{ Button = $btns[0]; Card = $node; Why = 'ok' } }
    if ($btns.Count -gt 1) { return @{ Button = $null; Card = $node; Why = 'ambiguous' } }
  }
  return @{ Button = $null; Card = $null; Why = 'no-button' }
}

# Look for the card text (Name starts with any of $CARD_PHRASES), then its Allow once. Text
# elements first (the common case and the cheap walk), then any element, because an Electron
# header can surface under a non-Text control type.
function Find-Card($root, $phrases) {
  $textCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)
  $candidates = @()
  foreach ($e in $root.FindAll($TREE, $textCond)) {
    try {
      $n = $e.Current.Name
      if (-not $n) { continue }
      $hit = @($phrases | Where-Object { $n.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
      if (-not $hit) { continue }
      if ($e.Current.IsOffscreen -or $e.Current.BoundingRectangle.IsEmpty) { continue }
      $candidates += [pscustomobject]@{ El = $e; Name = $n }
    } catch { continue }
  }
  if ($candidates.Count -eq 0) {
    foreach ($e in $root.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $n = $e.Current.Name
        if (-not $n) { continue }
        $hit = @($phrases | Where-Object { $n.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        if (-not $hit) { continue }
        if ($e.Current.IsOffscreen -or $e.Current.BoundingRectangle.IsEmpty) { continue }
        $candidates += [pscustomobject]@{ El = $e; Name = $n }
      } catch { continue }
    }
  }
  $last = $null
  foreach ($c in $candidates) {
    $found = Find-AllowButton $c.El
    if ($found.Button) { return @{ Header = $c.Name; Button = $found.Button; Why = 'ok' } }
    if ($found.Why -in 'ambiguous', 'too-wide') { $last = @{ Header = $c.Name; Button = $null; Why = $found.Why; Count = $found.Count } }
    elseif (-not $last) { $last = @{ Header = $c.Name; Button = $null; Why = 'no-button' } }
  }
  return $last
}

# ---- The loop ------------------------------------------------------------------------------
$script:CardVisible = $false
$script:Attempts = 0
$script:LastPressAt = [DateTime]::MinValue
$script:LoggedDisabled = $false
$script:GaveUpLogged = $false
$script:LastRefusal = ''

Write-Log ("watcher start: pid $($proc.ProcId) hwnd $hwnd, every ${IntervalSecs}s, card text " +
           ($CARD_PHRASES | ForEach-Object { "'$_'" }) + ", button '" + ($ALLOW_NAMES -join "'/'") + "', log '$LogPath'" + $(if ($Once) { ' (once)' } else { '' }))

$script:OncePressed = $false
$script:OnceCardSeen = $false
$script:OnceUnpressable = ''
$script:Tick = 0
try {
  while ($true) {
    try {
      if ([Approve.Inv]::IsIconic($hwnd)) {
        [void][Approve.Inv]::ShowWindow($hwnd, 4)   # SW_SHOWNOACTIVATE - render, do not steal focus
        Start-Sleep -Milliseconds 400
      }
      if ($Steal) { [void][Approve.Inv]::Foreground($hwnd); Start-Sleep -Milliseconds 150 }
      $el = Wake $hwnd 0
      $card = $null
      $roots = @(Get-Roots $proc.ProcId $hwnd)
      $full = $Once -or $script:CardVisible -or ($script:Tick % $FULL_SCAN_EVERY -eq 0) -or (Test-AllowButton $roots)
      $script:Tick++
      if ($full) {
        foreach ($root in $roots) {
          $card = Find-Card $root $CARD_PHRASES
          if ($card -and $card.Button) { break }
        }
      }

      if (-not $card -or -not $card.Button) {
        if ($script:CardVisible) {
          Write-Log "card cleared"
          $script:CardVisible = $false; $script:Attempts = 0
          $script:LoggedDisabled = $false; $script:GaveUpLogged = $false
        }
        if ($card -and $card.Why -eq 'ambiguous') {
          $script:OnceCardSeen = $true; $script:OnceUnpressable = "the card '$($card.Header)' holds more than one Allow button - refused"
          if (-not $script:CardVisible) { Write-Log "REFUSED: '$($card.Header)' is a container with more than one Allow button - not guessing" }
        } elseif ($card -and $card.Why -eq 'too-wide') {
          $script:OnceCardSeen = $true; $script:OnceUnpressable = "'$($card.Header)' reached a container of $($card.Count) buttons before any Allow - refused"
          $msg = "REFUSED: '$($card.Header)' reached a container of $($card.Count) buttons (over $CARD_MAX_BUTTONS) before any Allow - chat text, not a card"
          if ($msg -ne $script:LastRefusal) { Write-Log $msg; $script:LastRefusal = $msg }
        } elseif ($card -and $card.Why -eq 'no-button') {
          $script:OnceCardSeen = $true; $script:OnceUnpressable = "the card '$($card.Header)' has no enabled Allow once"
          if (-not $script:CardVisible) { Write-Log "card '$($card.Header)' is showing but no enabled '$AllowName' is inside it" }
        }
      } else {
        $header = $card.Header
        $btn = $card.Button
        try { $label = [string]$btn.Current.Name } catch { $label = $AllowName }
        $script:OnceCardSeen = $true
        if (-not $script:CardVisible) {
          Write-Log "card showing: '$header' -> '$label'"
          $script:CardVisible = $true; $script:Attempts = 0
          $script:LoggedDisabled = $false; $script:GaveUpLogged = $false
        }
        $enabled = $false
        try { $enabled = [bool]$btn.Current.IsEnabled } catch { $enabled = $false }
        if (-not $enabled) {
          if (-not $script:LoggedDisabled) { Write-Log "card '$header' is up but '$label' is disabled - waiting"; $script:LoggedDisabled = $true }
          $script:OnceUnpressable = "'$label' on '$header' was disabled"
        } elseif ($script:Attempts -ge 3) {
          if (-not $script:GaveUpLogged) { Write-Log "gave up on '$header' after 3 presses - it is not clearing; still watching"; $script:GaveUpLogged = $true }
          $script:OnceUnpressable = "'$header' did not clear after 3 presses"
        } elseif (((Get-Date) - $script:LastPressAt).TotalSeconds -ge 5) {
          $inv = TryPattern $btn ([System.Windows.Automation.InvokePattern]::Pattern)
          if (-not $inv) {
            Write-Log "REFUSED: '$label' on '$header' exposes no InvokePattern"
            $script:OnceUnpressable = "'$label' exposes no InvokePattern"
          } else {
            try {
              $inv.Invoke()
              $script:LastPressAt = Get-Date
              $script:Attempts++
              $script:OncePressed = $true
              Write-Log "APPROVED '$label' on '$header' (press #$($script:Attempts))"
            } catch {
              Write-Log "invoke failed on '$label' on '$header': $($_.Exception.Message)"
              $script:OnceUnpressable = "invoke failed: $($_.Exception.Message)"
            }
          }
        }
      }
    } catch {
      Write-Log "scan error: $($_.Exception.Message)"
      # The window is cached at start. When the instance quits (an app restart gives it a new pid), every
      # scan fails on the dead window forever, and while this runs the supervisor counts the instance as
      # watched, so no fresh watcher starts (six of eight, 2026-10-04 to 10-07). Exit instead; the
      # supervisor's next run starts one on the new process. A recreated window is followed in place.
      $live = Get-Process -Id $proc.ProcId -ErrorAction SilentlyContinue
      if (-not $live) {
        Write-Log "instance pid $($proc.ProcId) is gone - exiting so the supervisor starts a fresh watcher"
        break
      }
      if ($live.MainWindowHandle -ne [IntPtr]::Zero -and $live.MainWindowHandle -ne $hwnd) {
        Write-Log "window changed: $hwnd -> $($live.MainWindowHandle)"
        $hwnd = $live.MainWindowHandle
      }
    }
    if ($Once) { break }
    # The UIA wrappers are tiny managed objects pinning native ones, so the GC never feels the
    # pressure on its own: collect each tick, and recycle a watcher that grows anyway.
    $roots = $null; $card = $null; $el = $null
    [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
    if ($script:Tick % $FULL_SCAN_EVERY -eq 0) {
      $mb = [math]::Round((Get-Process -Id $PID).PrivateMemorySize64 / 1MB)
      if ($mb -gt $MAX_PRIVATE_MB) {
        Write-Log "recycling: $mb MB private (over $MAX_PRIVATE_MB MB) - a fresh watcher takes over"
        Start-HiddenWatcher
        exit 0
      }
    }
    Start-Sleep -Seconds $IntervalSecs
  }
} finally {
  Write-Log 'watcher stopped'
}

if ($Once) {
  if ($script:OncePressed) { exit 0 }
  if (-not $script:OnceCardSeen) { exit 3 }
  if ($script:OnceUnpressable) { Write-Log "not pressed: $($script:OnceUnpressable)" }
  exit 6
}
