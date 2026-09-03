# approve_prompt.ps1 - answer a permission prompt in a chat that was never meant to be asked.
#
# WHY (owner, 2026-09-01: "there's literally like four chats currently pending on someone to
# push enter, because they're not set to the proper bypass permissions"). Measured that moment:
# six live chats whose newest transcript record was an unanswered tool call, each showing an
# "Allow once" / "Always allow" prompt in its pane. Their permission mode ON DISK is
# bypassPermissions - they booted before the stamp landed, so the app is running them under the
# OLD mode and asking. The work is stopped dead and only a person can restart it.
#
# ⛔ WHAT THIS IS AND IS NOT. It is NOT a policy decision: the caller has already verified that
# this chat's configured mode is bypassPermissions, i.e. the owner's standing doctrine says it
# should never have been prompted at all. This presses the button that mode would have pressed
# by itself. It refuses on anything else.
#
# THE AIM RAILS, all four required before a single Invoke:
#   1. the instance matches (exact --user-data-dir for a path, substring for a bare name);
#   2. the TARGET CHAT is the one open in that window - proved by its own kebab button,
#      "More options for <Title>", being present in the conversation pane. If the row must be
#      selected first, -Select does that through the sidebar row and re-checks the receipt;
#   2b. with -VerifyText, that chat's OWN WORDS are visible in the conversation pane. A title
#      is not an identity (same-titled chats in two instances are a known fleet shape), so the
#      caller passes a snippet of this chat's transcript tail and nothing is pressed unless the
#      pane shows it - the same proof the courier's composer send demands (review 2026-09-01);
#   3. the button is named "Always allow" or "Allow once" (localised list below) and is
#      ENABLED - never a Deny, never a Reject, never anything else;
#   4. it lives in the conversation pane, right of the sidebar, not in the sidebar chrome.
# "Always allow" is preferred over "Allow once" so the same chat does not stop again.
#
# Exit: 0 pressed - 3 no prompt is showing for that chat - 4 that chat is not the open one and
#       could not be selected - 1 error/no instance.

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Instance,
  [switch]$Select,
  [switch]$OnceOnly,
  # A snippet of the target chat's own last words; when given, it MUST be visible in the pane.
  [string]$VerifyText = '',
  # -SetMode 'Bypass permissions': instead of pressing Allow, set the chat's PERMISSION MODE
  # through the app's own picker (the Button in the composer toolbar named for the current
  # mode; it opens a menu of the modes). Same aim rails as a press. This is how a LIVE chat
  # gets the doctrine mode - a disk stamp cannot stick while the app holds the record in
  # memory (2026-09-01: every deeplink-born chat stalled in default mode on its first shell
  # call). Exit 0 set (or already), 3 no picker in the pane, 4 wrong chat, 6 did not take.
  [string]$SetMode = ''
)
$MODE_NAMES = @('Default permissions', 'Accept edits', 'Plan mode', 'Bypass permissions',
                'Ask permissions', 'Auto-accept edits')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Approve -Name Inv -MemberDefinition @'
[DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, int id, ref System.Guid iid, ref System.IntPtr ppv);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
public static IntPtr RenderWidget(IntPtr top) {
  IntPtr found = IntPtr.Zero;
  EnumChildWindows(top, (h, p) => {
    var sb = new System.Text.StringBuilder(256); GetClassName(h, sb, 256);
    if (sb.ToString() == "Chrome_RenderWidgetHostHWND") { found = h; return false; }
    return true; }, IntPtr.Zero);
  return found;
}
'@

$ALLOW_ALWAYS_NAMES = @('Always allow', 'Immer erlauben', 'Permitir siempre', 'Toujours autoriser')
$ALLOW_ONCE_NAMES = @('Allow once', 'Einmal erlauben', 'Permitir una vez', 'Autoriser une fois')
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
if ($Instance -match '[\\/]') {
  $procs = @($procs | Where-Object { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') })
} else {
  $procs = @($procs | Where-Object { $_.Dir -like "*$Instance*" })
}
if (-not $procs) { Write-Output "FAIL: no running instance matches '$Instance'"; exit 1 }
# RAIL 1b: a bare name that matches MORE THAN ONE instance dir is ambiguous, and CIM's
# enumeration order must never pick the window (review 2026-09-01: the fleet already holds
# 'pap3r rotate' and 'pap3r rotate2', so '-Instance "pap3r rotate"' matched both, and a same-
# titled chat in the wrong one would have been approved). Refuse loudly; the caller passes the
# full --user-data-dir path to disambiguate.
$dirs = @($procs | ForEach-Object { $_.Dir.TrimEnd('\').ToLowerInvariant() } | Sort-Object -Unique)
if ($dirs.Count -gt 1) {
  Write-Output "FAIL: ambiguous instance match - '$Instance' matches $($dirs.Count) running instances ($($dirs -join '; ')); pass the exact --user-data-dir path"
  exit 1
}
$proc = $procs | Select-Object -First 1
$hwnd = (Get-Process -Id $proc.ProcId -ErrorAction SilentlyContinue).MainWindowHandle
if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) { Write-Output 'FAIL: that instance has no window'; exit 1 }

# Chromium builds its accessibility tree lazily; the MSAA poke switches the full tree on.
function Wake($h) {
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
  Start-Sleep -Milliseconds 900
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

$el = Wake $hwnd
$BTN = [System.Windows.Automation.ControlType]::Button
$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)

function PaneMinX($root) { $r = $root.Current.BoundingRectangle; return $r.Left + ($r.Width * 0.38) }

# RAIL 2: is OUR chat the open one? Its kebab renders in the conversation pane header.
function OpenChatIs($root, $title) {
  $minX = PaneMinX $root
  foreach ($b in $root.FindAll($TREE, $btnCond)) {
    try {
      $n = $b.Current.Name
      if (-not $n -or -not $n.StartsWith('More options for ')) { continue }
      $r = $b.Current.BoundingRectangle
      if ($r.IsEmpty -or $r.Left -lt $minX) { continue }   # the sidebar rows have one too
      if ($n.Substring(17).Trim() -eq $title.Trim()) { return $true }
    } catch { continue }
  }
  return $false
}

if (-not (OpenChatIs $el $Title)) {
  if (-not $Select) { Write-Output "REFUSED: '$Title' is not the chat open in $($proc.Dir)"; exit 4 }
  # Bring it up through its own sidebar row, then re-check the receipt - never press a button
  # in a pane we have not proved belongs to this chat.
  $minX = PaneMinX $el
  $row = $null
  foreach ($b in $el.FindAll($TREE, $btnCond)) {
    try {
      $n = $b.Current.Name
      $r = $b.Current.BoundingRectangle
      if (-not $n -or $r.IsEmpty -or $r.Left -ge $minX) { continue }
      if ($n.EndsWith($Title.Trim())) { $row = $b; break }
    } catch { continue }
  }
  if (-not $row) { Write-Output "REFUSED: no sidebar row for '$Title' in $($proc.Dir)"; exit 4 }
  $inv = TryPattern $row ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output 'REFUSED: that row exposes no Invoke'; exit 4 }
  $inv.Invoke()
  Start-Sleep -Milliseconds 1200
  $el = Wake $hwnd
  if (-not (OpenChatIs $el $Title)) {
    Write-Output "REFUSED: selected the row but the pane still does not show '$Title'"; exit 4
  }
}

# RAIL 2b: THE CHAT'S OWN WORDS ON SCREEN. The kebab proves a chat with this TITLE is open;
# this proves it is THIS chat. Any rendered element right of the sidebar whose name carries the
# snippet counts (the pane exposes message text through element names, as the courier's
# actuator relies on). Absent = refuse; a title alone never earns a press.
# -SetMode is CONFIGURATION, not an act on the chat's work: bypass is the wanted state for
# every chat, so a same-titled neighbour getting it instead is not a wrong press - and the
# title-collision pass renames such neighbours anyway. The words rail stays for pressing
# Allow, where the wrong chat would be a real mistake (2026-09-01: the rail blocked the mode
# fix on most chats because the pane exposes fragments, not lines).
# A CHIP ON THE WAY PAST (2026-09-01): the chat is open now, so if its pane carries a
# 'Suggested task' card, say so - the chips lane (scripts/chips.py) starts it locally on its
# own clock. One line, never an act here.
try {
  $minXc = PaneMinX $el
  $cardLabel = $null
  foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($e.Current.Name -ne 'Suggested task') { continue }
      $rc = $e.Current.BoundingRectangle
      if ($rc.IsEmpty -or $rc.Left -lt $minXc) { continue }
      $cardLabel = $e; break
    } catch { continue }
  }
  if ($cardLabel) {
    $ly = $cardLabel.Current.BoundingRectangle.Y
    $chipTitle = ''
    foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Text') { continue }
        $rc = $e.Current.BoundingRectangle
        if ($rc.IsEmpty -or $rc.Left -lt $minXc -or $rc.Y -le $ly -or $rc.Y -gt ($ly + 60)) { continue }
        $t = $e.Current.Name
        if ($t -and $t -notmatch '^[a-z0-9]+-[a-z0-9-]+$') { $chipTitle = $t; break }
      } catch { continue }
    }
    if ($chipTitle) { Write-Output "CHIP: $chipTitle" }
  }
} catch {}

if ($VerifyText -and -not $SetMode) {
  $minXv = PaneMinX $el
  $wordsSeen = $false
  # Several candidate snippets may be passed, separated by '|||' (its last words, its first
  # prompt as the pane renders it): the pane shows the END of a long message and renders
  # markdown, so any one of the chat's own lines on screen proves it is this chat.
  $alts = @($VerifyText -split '\|\|\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  # THE PANE EXPOSES FRAGMENTS, NOT LINES (measured 2026-09-01 on a live window: message text
  # arrives as Text elements split at every inline-code/bold boundary - "just refuses any
  # live pid.", "= pid 55980). Delivering both decisions."). An exact snippet therefore
  # almost never sits inside one element's Name, and the rail refused real chats all
  # evening. So: the pane's names are joined into one text, an exact hit anywhere passes,
  # and failing that the chat's DISTINCTIVE words (5+ letters) must mostly be present -
  # at least four of them and at least 60% - which a same-titled other chat does not share.
  $paneParts = New-Object System.Collections.Generic.List[string]
  foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $n = $e.Current.Name
      if (-not $n) { continue }
      $r = $e.Current.BoundingRectangle
      if ($r.IsEmpty -or $r.Left -lt $minXv) { continue }
      $paneParts.Add($n)
    } catch { continue }
  }
  $paneText = (($paneParts -join ' ') -replace '\s+', ' ')
  $paneLower = $paneText.ToLowerInvariant()
  foreach ($a in $alts) {
    if ($paneText.Contains($a)) { $wordsSeen = $true; break }
    $words = @(($a.ToLowerInvariant() -split '[^a-z0-9]+') | Where-Object { $_.Length -ge 5 } | Select-Object -Unique)
    if ($words.Count -lt 4) { continue }
    $hits = @($words | Where-Object { $paneLower.Contains($_) }).Count
    if ($hits -ge 4 -and $hits -ge [Math]::Ceiling($words.Count * 0.6)) { $wordsSeen = $true; break }
  }
  if (-not $wordsSeen) {
    Write-Output "REFUSED: '$Title' is open by title, but its pane does not show its own words ('$VerifyText') - not pressing on a title alone"
    exit 4
  }
}

# -SetMode: the permission picker in the conversation pane, driven positively by name.
if ($SetMode) {
  $minXm = PaneMinX $el
  function Find-ModeBtn($root) {
    foreach ($b in $root.FindAll($TREE, $btnCond)) {
      try {
        $n = $b.Current.Name
        if (-not $n -or ($MODE_NAMES -notcontains $n)) { continue }
        $r = $b.Current.BoundingRectangle
        if ($r.IsEmpty -or $r.Left -lt $minXm) { continue }
        return $b
      } catch { continue }
    }
    return $null
  }
  $modeBtn = Find-ModeBtn $el
  if (-not $modeBtn) { Write-Output "no permission picker is showing in '$Title' (looked for: $($MODE_NAMES -join ', '))"; exit 3 }
  $before = $modeBtn.Current.Name
  if ($before -eq $SetMode) { Write-Output "MODE already '$SetMode' for '$Title' in $($proc.Dir)"; exit 0 }
  # OPENING THE PICKER (measured 2026-09-01 on a live window): the picker Button exposes
  # ExpandCollapse and ScrollItem, NOT Invoke - so requiring Invoke refused every chat whose
  # mode was wrong ("the permission picker ('Accept edits') exposes no Invoke"). Its parent
  # Group is the element that exposes Invoke. Try each way the control offers, in order.
  $opened = $false
  $pi = TryPattern $modeBtn ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($pi) { try { $pi.Invoke(); $opened = $true } catch {} }
  if (-not $opened) {
    $ecp = TryPattern $modeBtn ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($ecp) { try { $ecp.Expand(); $opened = $true } catch {} }
  }
  if (-not $opened) {
    try {
      $parentBtn = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($modeBtn)
      $ppi = if ($parentBtn) { TryPattern $parentBtn ([System.Windows.Automation.InvokePattern]::Pattern) } else { $null }
      if ($ppi) { $ppi.Invoke(); $opened = $true }
    } catch {}
  }
  # MEASURED 2026-09-01 on a live window: none of the patterns open this popover - Expand
  # throws "not valid in the current state", the parent's Invoke does nothing. What DOES
  # open it is what a person does: focus the button and press Space. UIA SetFocus plus a
  # WM_KEYDOWN/WM_KEYUP for VK_SPACE posted to the render widget - no foreground change,
  # no cursor. The menu is then five RadioButtons whose names are the label FOLLOWED BY a
  # description ('Bypass permissions Accepts all permissions Default'), which is why an
  # exact-name match found "no item"; SelectionItem.Select on the radio switches the mode.
  function Find-ModeItem($root) {
    foreach ($e in $root.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $n = $e.Current.Name
        if (-not $n -or -not $n.StartsWith($SetMode)) { continue }
        $ct = $e.Current.ControlType.ProgrammaticName
        if ($ct -notmatch 'RadioButton|MenuItem|ListItem') { continue }
        $r = $e.Current.BoundingRectangle
        if ($r.IsEmpty) { continue }
        return $e
      } catch { continue }
    }
    return $null
  }
  function Press-Space($target) {
    try { $target.SetFocus() } catch { return $false }
    Start-Sleep -Milliseconds 150
    $rw = [Approve.Inv]::RenderWidget($hwnd)
    if ($rw -eq [IntPtr]::Zero) { return $false }
    [void][Approve.Inv]::PostMessage($rw, 0x0100, [IntPtr]0x20, [IntPtr]0)
    Start-Sleep -Milliseconds 60
    [void][Approve.Inv]::PostMessage($rw, 0x0101, [IntPtr]0x20, [IntPtr]0)
    return $true
  }
  if (-not $opened) { $opened = Press-Space $modeBtn }
  if (-not $opened) { Write-Output "REFUSED: the permission picker ('$before') could not be opened (no Invoke, no Expand, and the focused Space key found no render widget)"; exit 6 }
  Start-Sleep -Milliseconds 700
  $item = $null
  foreach ($try in 1..4) {
    $item = Find-ModeItem ([System.Windows.Automation.AutomationElement]::FromHandle($hwnd))
    if ($item) { break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $item) { Write-Output "REFUSED: opened the picker ('$before') but no item starting with '$SetMode' appeared"; exit 6 }
  $picked = $false
  $sp = TryPattern $item ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($sp) { try { $sp.Select(); $picked = $true } catch {} }
  if (-not $picked) {
    $ii = TryPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($ii) { try { $ii.Invoke(); $picked = $true } catch {} }
  }
  if (-not $picked) { $picked = Press-Space $item }
  if (-not $picked) { Write-Output "REFUSED: the '$SetMode' item took neither Select, Invoke nor a focused Space"; exit 6 }
  Start-Sleep -Milliseconds 800
  # THE CONFIRMATION POPUP (owner, 2026-09-01: "when enabling bypass permissions, frequently a
  # popup shows up to confirm"). Switching to bypass can raise the app's acceptance dialog
  # (the desktop's form of the CLI's "Yes, I accept" gate). It is answered POSITIVELY by
  # name, never by position: a Button whose name is one of the accept labels, tried in
  # order; Cancel/No/Exit are never touched. Up to three rounds, since the dialog can arrive
  # after the picker already reads the new mode.
  $ACCEPT_NAMES = @('Yes, I accept', 'I accept', 'Accept', 'Yes, enable', 'Enable', 'Turn on',
                    'Confirm', 'Continue', 'I understand', 'Got it', 'OK', 'Yes',
                    'Ja, ich akzeptiere', 'Akzeptieren', 'Aktivieren', 'Bestätigen', 'Weiter', 'Ja')
  $confirmNote = ''
  foreach ($round in 1..3) {
    $dlgBtn = $null
    $fresh = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    foreach ($want in $ACCEPT_NAMES) {
      foreach ($b in $fresh.FindAll($TREE, $btnCond)) {
        try {
          $n = $b.Current.Name
          if (-not $n) { continue }
          $n = $n.Trim()
          if ($n -ne $want) { continue }
          # the picker button and the sidebar rows are never a dialog's confirm button
          if ($MODE_NAMES -contains $n) { continue }
          $r = $b.Current.BoundingRectangle
          if ($r.IsEmpty -or $b.Current.IsOffscreen) { continue }
          $dlgBtn = $b; break
        } catch { continue }
      }
      if ($dlgBtn) { break }
    }
    if (-not $dlgBtn) { break }
    $label = $dlgBtn.Current.Name
    $done = $false
    $dpi = TryPattern $dlgBtn ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($dpi) { try { $dpi.Invoke(); $done = $true } catch {} }
    if (-not $done) { $done = Press-Space $dlgBtn }
    if (-not $done) { Write-Output "REFUSED: a confirmation asked ('$label') and it took neither Invoke nor a focused Space"; exit 6 }
    $confirmNote = " (confirmed the app's '$label' prompt)"
    Start-Sleep -Milliseconds 900
  }
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $after = Find-ModeBtn $el
  $now = if ($after) { $after.Current.Name } else { 'gone' }
  if ($now -ne $SetMode) {
    # Name what is on screen so an UNKNOWN confirmation dialog (a button label not in
    # ACCEPT_NAMES) can be read off the lane's log and added, instead of failing mutely.
    $seenBtns = @()
    foreach ($b in $el.FindAll($TREE, $btnCond)) { try { $n = $b.Current.Name; if ($n -and -not $b.Current.IsOffscreen -and $n.Length -le 40 -and $n -notlike 'More options*' -and $n -notlike 'Idle *' -and $n -notlike 'Running *') { $seenBtns += $n } } catch {} }
    $seenBtns = @($seenBtns | Select-Object -Unique | Select-Object -First 25)
    Write-Output "REFUSED: picked '$SetMode' but the picker now reads '$now' - the mode did not take$confirmNote (buttons on screen: $($seenBtns -join ' | '))"
    exit 6
  }
  Write-Output "MODE SET '$before' -> '$SetMode' for '$Title' in $($proc.Dir)$confirmNote"
  exit 0
}

# RAILS 3 + 4: an ENABLED allow button, in the conversation pane. Always-allow wins.
$minX = PaneMinX $el
# ⛔ NAME THESE APART FROM THE NAME LISTS. PowerShell variables are CASE-INSENSITIVE, so
# `$once = $null` silently ERASED the `$ONCE` list of button names and the match loop then
# iterated nothing - the button was found, reported as a candidate, and never matched.
$hitAlways = $null; $hitOnce = $null
foreach ($b in $el.FindAll($TREE, $btnCond)) {
  try {
    $n = $b.Current.Name
    if (-not $n) { continue }
    $r = $b.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Left -lt $minX) { continue }
    if (-not $b.Current.IsEnabled) { continue }
    foreach ($a in $ALLOW_ALWAYS_NAMES) { if ($n.StartsWith($a) -and -not $hitAlways) { $hitAlways = $b } }
    foreach ($o in $ALLOW_ONCE_NAMES) { if ($n.StartsWith($o) -and -not $hitOnce) { $hitOnce = $b } }
  } catch { continue }
}
$target = if ($OnceOnly) { $hitOnce } elseif ($hitAlways) { $hitAlways } else { $hitOnce }
if (-not $target) { Write-Output "no permission prompt is showing for '$Title'"; exit 3 }
$inv = TryPattern $target ([System.Windows.Automation.InvokePattern]::Pattern)
if (-not $inv) { Write-Output 'REFUSED: the allow button exposes no Invoke'; exit 1 }
$inv.Invoke()
Write-Output "APPROVED '$($target.Current.Name)' for '$Title' in $($proc.Dir)"
exit 0
