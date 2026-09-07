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
# THE PICKER'S OWN LABELS, read off a live window 2026-09-07 (probe: focus the composer's
# mode button, press Space, enumerate the RadioButtons). The five it actually renders are
# 'Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions'. Three names in the old list
# ('Default permissions', 'Ask permissions', 'Auto-accept edits') exist nowhere in the app,
# and 'Plan mode' has been 'Plan' for long enough that nobody noticed - which mattered,
# because Find-ModeBtn matches the COMPOSER BUTTON against this list, so a chat sitting in
# Auto or Manual reported "no permission picker is showing" and could never be moved to
# bypass at all. The dead names are kept: an older build may still render them, and a name
# that matches nothing costs one string comparison.
$MODE_NAMES = @('Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions',
                'Default permissions', 'Plan mode', 'Ask permissions', 'Auto-accept edits')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Approve -Name Inv -MemberDefinition @'
[DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, int id, ref System.Guid iid, ref System.IntPtr ppv);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
// ⛔ THE FOREGROUND GRAB IS LOAD-BEARING, NOT A COURTESY (measured 2026-09-07).
// Press-Space posts WM_KEYDOWN/WM_KEYUP straight at the render widget and the header used
// to claim that was focus-free - "no foreground change, no cursor". It is not: with the app
// in the BACKGROUND the picker never opens, the posted key is swallowed with no error, and
// Press-Space still returns $true because all it ever checked was that PostMessage was
// called. That is the whole reason a human kept having to click Bypass permissions by hand,
// and why the confirm-dialog hunt below found nothing to click - there was never a dialog,
// because the menu it comes from never opened. Proven both ways on one live window: same
// process, same button, same posted key - background = 0 picker items, foreground = 5.
// SetForegroundWindow alone is a no-op for a background process, so attach to the target's
// input queue first. Callers restore the previous foreground window afterwards.
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
# RAIL: a BLANK -Instance is a refusal for any action that clicks, types or presses - this
# script always ends in one of those, so blank is never accepted (review 2026-09-06).
if (-not $Instance -or $Instance.Trim() -eq '') {
  Write-Output 'FAIL: -Instance is blank - refusing to act without a positively identified window'
  exit 1
}
$allDirs = @($procs | ForEach-Object { $_.Dir } | Sort-Object -Unique)
if ($Instance -match '[\\/]') {
  $procs = @($procs | Where-Object { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') })
} else {
  # RAIL 1: a BARE -Instance matches the profile dir's LEAF folder name EXACTLY and
  # case-insensitively - never '-like "*$Instance*"'. That substring match let
  # '-Instance "pap3r rotate"' also match 'pap3r rotate2' (review 2026-09-06).
  $procs = @($procs | Where-Object {
    (Split-Path -Leaf $_.Dir.TrimEnd('\')).Equals($Instance, [System.StringComparison]::OrdinalIgnoreCase)
  })
}
# RAIL 1b: ZERO or MORE THAN ONE match is a refusal that prints every candidate dir - never
# take the first (review 2026-09-01/2026-09-06: the fleet already holds near-duplicate leaf
# names like 'pap3r rotate' and 'pap3r rotate2', and CIM's enumeration order must never pick
# the window for us). The caller passes the full --user-data-dir path to disambiguate.
if ($procs.Count -ne 1) {
  Write-Output "FAIL: '$Instance' matches $($procs.Count) running instances; candidates: $($allDirs -join '; ')"
  exit 1
}
$proc = $procs | Select-Object -First 1
$hwnd = (Get-Process -Id $proc.ProcId -ErrorAction SilentlyContinue).MainWindowHandle
if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) { Write-Output 'FAIL: that instance has no window'; exit 1 }

# Chromium builds its accessibility tree lazily; the MSAA poke switches the full tree on.
function Wake($h, [int]$SleepMs = 900) {
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
  # $SleepMs defaults to 900 so the original call ($el = Wake $hwnd) keeps its exact prior
  # behaviour; a caller polling for a post-condition passes 0 and sleeps itself between pokes.
  if ($SleepMs -gt 0) { Start-Sleep -Milliseconds $SleepMs }
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

$el = Wake $hwnd
$BTN = [System.Windows.Automation.ControlType]::Button
$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)

function PaneMinX($root) {
  # RAIL (review 2026-09-06): prefer the composer row's own anchor ('Model: ...') over a width
  # fraction when it is on screen - measured 2026-09-05, the 38% line missed the true sidebar
  # boundary on a narrow window. The fraction stays only as the documented fallback.
  try {
    foreach ($b in $root.FindAll($TREE, $btnCond)) {
      $n = $b.Current.Name
      if ($n -and $n.StartsWith('Model: ')) {
        $br = $b.Current.BoundingRectangle
        if (-not $br.IsEmpty) { return $br.Left - 40 }
      }
    }
  } catch {}
  $r = $root.Current.BoundingRectangle
  return $r.Left + ($r.Width * 0.38)
}

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
  # RAIL 2: exact Name equality to $Title after stripping known decoration - never
  # EndsWith/StartsWith/Contains (review 2026-09-06: EndsWith let a row decorated with a
  # status prefix, or a longer neighbour title, match a chat it was not). Two exact matches
  # is a refusal, not "take the first".
  function StripRowDecoration($n) {
    $s = $n
    foreach ($p in @('Idle ', 'Running ')) { if ($s.StartsWith($p)) { $s = $s.Substring($p.Length) } }
    return $s.Trim()
  }
  $rows = @()
  foreach ($b in $el.FindAll($TREE, $btnCond)) {
    try {
      $n = $b.Current.Name
      $r = $b.Current.BoundingRectangle
      if (-not $n -or $r.IsEmpty -or $r.Left -ge $minX) { continue }
      if ((StripRowDecoration $n) -eq $Title.Trim()) { $rows += $b }
    } catch { continue }
  }
  if ($rows.Count -eq 0) { Write-Output "REFUSED: no sidebar row for '$Title' in $($proc.Dir)"; exit 4 }
  if ($rows.Count -gt 1) {
    Write-Output "REFUSED: $($rows.Count) sidebar rows exactly match '$Title' in $($proc.Dir) - ambiguous"
    exit 4
  }
  $row = $rows[0]
  $inv = TryPattern $row ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output 'REFUSED: that row exposes no Invoke'; exit 4 }
  $inv.Invoke()
  # LATENCY (review 2026-09-06): poll for the row's chat to become the open one instead of a
  # flat 1200ms + 900ms wait - same 2100ms total ceiling. The accessibility poke inside Wake
  # still runs on every look; only the sleep after it is skipped mid-poll.
  $selectDeadline = (Get-Date).AddMilliseconds(2100)
  $el = Wake $hwnd 0
  while (-not (OpenChatIs $el $Title) -and (Get-Date) -lt $selectDeadline) {
    Start-Sleep -Milliseconds 200
    $el = Wake $hwnd 0
  }
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
  # LATENCY (review 2026-09-06): push the Name/ControlType filter into a PropertyCondition
  # passed to FindAll instead of walking TrueCondition and filtering every element client-side.
  $chipNameCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'Suggested task')
  foreach ($e in $el.FindAll($TREE, $chipNameCond)) {
    try {
      $rc = $e.Current.BoundingRectangle
      if ($rc.IsEmpty -or $rc.Left -lt $minXc) { continue }
      $cardLabel = $e; break
    } catch { continue }
  }
  if ($cardLabel) {
    $ly = $cardLabel.Current.BoundingRectangle.Y
    $chipTitle = ''
    $chipTextCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text)
    foreach ($e in $el.FindAll($TREE, $chipTextCond)) {
      try {
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
  # ⛔ THE COMPOSER ROW IS THE ANCHOR, NOT A FRACTION OF THE WINDOW WIDTH (measured
  # 2026-09-05 on a live 1082px-wide window): 'Bypass permissions' rendered at x=2678 while
  # PaneMinX computed 2782, so the `-lt $minXm` guard rejected the very button it was hunting
  # and every chat came back "no permission picker is showing". That is why the whole in-app
  # mechanism looked wired and did nothing: mode-confirmed.json held TWO rows for the entire
  # fleet and the mode ledger held ZERO, so the one thing that can set a live chat's mode had
  # never once aimed successfully. The 38% rule is calibrated for a wide window; a narrow one
  # (or a collapsed sidebar) pushes the line right of the composer's left-hand controls.
  # The composer toolbar is ONE ROW - 'Bypass permissions', 'Model: ...' and 'Effort: ...'
  # all render at the same Y - so the Model button is a structural anchor no window width can
  # move. The fraction stays only as the fallback for a window with no anchor on screen.
  function ComposerRowY($root) {
    foreach ($b in $root.FindAll($TREE, $btnCond)) {
      try {
        $n = $b.Current.Name
        if (-not $n -or -not $n.StartsWith('Model: ')) { continue }
        $r = $b.Current.BoundingRectangle
        if ($r.IsEmpty) { continue }
        return $r.Top
      } catch { continue }
    }
    return $null
  }
  $rowY = ComposerRowY $el
  function Find-ModeBtn($root) {
    $midY = $root.Current.BoundingRectangle.Top + ($root.Current.BoundingRectangle.Height * 0.5)
    foreach ($b in $root.FindAll($TREE, $btnCond)) {
      try {
        $n = $b.Current.Name
        if (-not $n -or ($MODE_NAMES -notcontains $n)) { continue }
        $r = $b.Current.BoundingRectangle
        if ($r.IsEmpty) { continue }
        if ($null -ne $rowY) {
          if ([Math]::Abs($r.Top - $rowY) -gt 40) { continue }   # a different row is a different control
        } else {
          # RAIL (review 2026-09-06): no composer-row anchor is on screen - keep the name
          # allow-list AND require the candidate to sit in the composer's vertical band
          # (below the pane's midline), never "any button anywhere". No hit here means
          # refuse (exit 3 below), not "accept whatever matched the name".
          if ($r.Left -lt $minXm -or $r.Top -lt $midY) { continue }
        }
        return $b
      } catch { continue }
    }
    return $null
  }
  $modeBtn = Find-ModeBtn $el
  if (-not $modeBtn) { Write-Output "no permission picker is showing in '$Title' (looked for: $($MODE_NAMES -join ', '))"; exit 3 }
  $before = $modeBtn.Current.Name
  # WHERE THE COMPOSER'S OWN PICKER SITS, read BEFORE the menu opens. The confirmation dialog
  # below carries a button with the SAME NAME as the mode being set ('Bypass permissions'),
  # so the only thing separating the dialog's confirm from the picker that raised it is
  # position. The composer toolbar does not move while a modal is up, and a rect survives the
  # React re-render that a RuntimeId does not, which is why this is the discriminator.
  $pickerRect = $modeBtn.Current.BoundingRectangle
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
      if ($parentBtn) {
        # RAIL (review 2026-09-06): only invoke the PARENT when $modeBtn is its ONE invokable
        # descendant - else the parent could hold a sibling control and invoking it would press
        # something we never aimed at. Skip this fallback rather than guess.
        $modeRid = $modeBtn.GetRuntimeId()
        $invokableKids = @($parentBtn.FindAll($TREE, $btnCond) | Where-Object {
          $null -ne (TryPattern $_ ([System.Windows.Automation.InvokePattern]::Pattern))
        })
        $isOnlyKid = ($invokableKids.Count -eq 1) -and
                     (-not (Compare-Object $invokableKids[0].GetRuntimeId() $modeRid))
        if ($isOnlyKid) {
          $ppi = TryPattern $parentBtn ([System.Windows.Automation.InvokePattern]::Pattern)
          if ($ppi) { $ppi.Invoke(); $opened = $true }
        }
      }
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
  # Whatever the person was working in, given back when we are done. Captured ONCE, on the
  # first grab, so a run that foregrounds three times still returns to where it started.
  $script:PriorFg = [IntPtr]::Zero
  function Restore-Foreground {
    if ($script:PriorFg -ne [IntPtr]::Zero) {
      [void][Approve.Inv]::Foreground($script:PriorFg)
      $script:PriorFg = [IntPtr]::Zero
    }
  }
  # Covers every `exit N` path below without wrapping the whole block in a try/finally.
  [void](Register-EngineEvent PowerShell.Exiting -Action { Restore-Foreground })
  function Press-Space($target) {
    # THE WINDOW MUST BE FOREGROUND BEFORE THE KEY (see Approve.Inv::Foreground). This used
    # to go straight to SetFocus and post, which does nothing at all to a background app.
    if ($script:PriorFg -eq [IntPtr]::Zero) {
      $fg = [Approve.Inv]::GetForegroundWindow()
      if ($fg -ne $hwnd) { $script:PriorFg = $fg }
    }
    [void][Approve.Inv]::Foreground($hwnd)
    Start-Sleep -Milliseconds 250
    try { $target.SetFocus() } catch { return $false }
    Start-Sleep -Milliseconds 150
    # RAIL 4 (review 2026-09-06): never post a key into unknown focus - this is the most
    # likely way the project selector got activated by a misdirected key. Confirm focus
    # actually landed on the element we meant before posting anything; retry SetFocus once,
    # then refuse loudly and name what actually had focus.
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $targetRid = $target.GetRuntimeId()
    if (-not $focused -or (Compare-Object $focused.GetRuntimeId() $targetRid)) {
      try { $target.SetFocus() } catch {}
      Start-Sleep -Milliseconds 150
      $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
      if (-not $focused -or (Compare-Object $focused.GetRuntimeId() $targetRid)) {
        $seenName = try { $focused.Current.Name } catch { '<unknown>' }
        Write-Output "REFUSED: focus did not land on the intended control before pressing Space (focus is on '$seenName')"
        return $false
      }
    }
    $rw = [Approve.Inv]::RenderWidget($hwnd)
    if ($rw -eq [IntPtr]::Zero) { return $false }
    [void][Approve.Inv]::PostMessage($rw, 0x0100, [IntPtr]0x20, [IntPtr]0)
    Start-Sleep -Milliseconds 60
    [void][Approve.Inv]::PostMessage($rw, 0x0101, [IntPtr]0x20, [IntPtr]0)
    return $true
  }
  if (-not $opened) { $opened = Press-Space $modeBtn }
  if (-not $opened) { Write-Output "REFUSED: the permission picker ('$before') could not be opened (no Invoke, no Expand, and the focused Space key found no render widget)"; exit 6 }
  # LATENCY (review 2026-09-06): the picker's menu populates asynchronously - poll for it
  # instead of a flat 700ms wait followed by four 400ms retries; same 2300ms total ceiling.
  $item = $null
  $itemDeadline = (Get-Date).AddMilliseconds(2300)
  while ($true) {
    $item = Find-ModeItem ([System.Windows.Automation.AutomationElement]::FromHandle($hwnd))
    if ($item -or (Get-Date) -ge $itemDeadline) { break }
    Start-Sleep -Milliseconds 175
  }
  if (-not $item) {
    # ⛔ DISTINGUISH "the menu opened and lacked my item" FROM "the menu never opened"
    # (2026-09-07). Press-Space returns true when it POSTED the key, not when anything
    # happened, so the old single message blamed the item list for a picker that had not
    # opened at all - and sent two investigations hunting for a locale/label problem that
    # did not exist. Count what is on screen and say which failure this actually is.
    $anyItems = 0
    $namesSeen = @()
    foreach ($e in ([System.Windows.Automation.AutomationElement]::FromHandle($hwnd)).FindAll(
                     $TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        if ($e.Current.ControlType.ProgrammaticName -notmatch 'RadioButton|MenuItem|ListItem') { continue }
        $en = $e.Current.Name
        if (-not $en -or $e.Current.BoundingRectangle.IsEmpty) { continue }
        $anyItems++
        if ($namesSeen.Count -lt 8) { $namesSeen += ($en -split '\s{2,}')[0] }
      } catch { continue }
    }
    if ($anyItems -eq 0) {
      Write-Output ("REFUSED: the picker ('$before') did not open - the Space key was posted but " +
        "nothing rendered. The app must be FOREGROUND for its render widget to take a posted key.")
      exit 6
    }
    Write-Output ("REFUSED: opened the picker ('$before') but no item starting with '$SetMode' appeared" +
      " (menu showed: $($namesSeen -join ' | '))")
    exit 6
  }
  # RAIL (review 2026-09-06): snapshot every button's RuntimeId BEFORE the mode item is
  # invoked by ANY method (Select, Invoke or Press-Space), so the confirmation-dialog hunt
  # below can require its match to be NEW rather than trusting a name match alone against
  # whatever button already happened to be on screen.
  # THE APP'S WINDOWS, main first. The confirmation dialog is its own top-level HWND owned by
  # the same process, so a hunt rooted at MainWindowHandle alone never sees it. `IsMain` is
  # carried because Find-Confirm's positional guards only make sense in the main window: the
  # composer's picker and the sidebar chips live THERE, so a mode-named button in a separate
  # dialog window cannot be either of them and must not be rejected for sitting in the wrong
  # place. Never widens WHAT may be pressed - the deny list and the must-be-new rail are
  # unchanged, and the snapshot below covers these same roots so nothing pre-existing qualifies.
  # ⛔ DEFINED HERE, ABOVE ITS FIRST USE: PowerShell binds functions as the script runs, so a
  # definition further down would leave the snapshot call in a catch{} with an EMPTY set -
  # which silently disarms must-be-new and lets an unrelated button be pressed as the confirm.
  function Get-ProcRoots($procId, $mainHwnd) {
    $roots = @()
    try { if ($mainHwnd) { $roots += [pscustomobject]@{ Elem = [System.Windows.Automation.AutomationElement]::FromHandle($mainHwnd); IsMain = $true } } } catch {}
    try {
      $pidCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$procId)
      foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                       [System.Windows.Automation.TreeScope]::Children, $pidCond)) {
        try {
          $h = $w.Current.NativeWindowHandle
          if ($mainHwnd -and $h -eq [int]$mainHwnd) { continue }
          if ($w.Current.IsOffscreen) { continue }
          $roots += [pscustomobject]@{ Elem = $w; IsMain = $false }
        } catch { continue }
      }
    } catch {}
    return $roots
  }
  # ⛔ AND IT MUST COVER EVERY TOP-LEVEL WINDOW OF THE APP, NOT JUST ITS MAIN ONE (owner,
  # 2026-09-07: "stuck on the popup again. I had to click it"). This dialog is an OWNED
  # top-level window with its own HWND, so it is NOT a descendant of MainWindowHandle and a
  # scan rooted there cannot see it however long it polls. Both failures read the same way -
  # "waited 9s for a confirmation, pressed 0" while the diagnostic listed the main frame's own
  # Minimize/Maximize - which looks like "no dialog appeared" and was really "looked in the
  # wrong window". Roots are recomputed each look because the dialog does not exist yet here.
  $preInvokeIds = New-Object System.Collections.Generic.HashSet[string]
  try {
    foreach ($root in (Get-ProcRoots $proc.ProcId $hwnd)) {
      try {
        foreach ($b in $root.Elem.FindAll($TREE, $btnCond)) {
          try { [void]$preInvokeIds.Add(($b.GetRuntimeId() -join ',')) } catch {}
        }
      } catch {}
    }
  } catch {}
  $picked = $false
  $sp = TryPattern $item ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($sp) { try { $sp.Select(); $picked = $true } catch {} }
  if (-not $picked) {
    $ii = TryPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($ii) { try { $ii.Invoke(); $picked = $true } catch {} }
  }
  if (-not $picked) { $picked = Press-Space $item }
  if (-not $picked) { Write-Output "REFUSED: the '$SetMode' item took neither Select, Invoke nor a focused Space"; exit 6 }
  # LATENCY (review 2026-09-06): the confirm-dialog poll below already waits for the dialog or
  # the picker to change; the flat 250ms here bought it nothing extra, so it is removed rather
  # than folded.
  # THE CONFIRMATION POPUP, AND WHY THIS IS A POLL AND NOT THREE ROUNDS (owner, 2026-09-06:
  # "a pop-up opens ... otherwise everything hangs. The pop-up happened, I accepted them for
  # you"). Switching to bypass raises the app's acceptance dialog - the desktop's form of the
  # CLI's "Yes, I accept" gate - and until it is answered the mode never takes and the chat
  # sits there waiting for a human. Two defects put it there, both measured on the 5-chat
  # Carlos migration of 2026-09-06 where two of five landed `disk-only`:
  #
  #   1. THE RETRY LOOP NEVER RETRIED. `foreach ($round in 1..3) { ... if (-not $dlgBtn)
  #      { break } }` left the loop the FIRST time a round found nothing, so the comment
  #      promising three rounds "since the dialog can arrive after the picker already reads
  #      the new mode" described behaviour the code did not have: after one 800ms sleep it
  #      gave up forever. A dialog that renders slower than that was never seen at all.
  #   2. THE GUARD SKIPPED THE VERY BUTTON IT NEEDED. This dialog's confirm is named for the
  #      MODE - 'Bypass permissions' - and `if ($MODE_NAMES -contains $n) { continue }` threw
  #      it away as though it were the composer's picker. The failing run's own diagnostic
  #      printed it on screen ("... | Cancel | Bypass p") while reporting the mode did not
  #      take, which is the tell.
  #
  # So: poll until the picker actually reads the target mode, take a mode-named button only
  # when it is NOT where the composer's picker sits, and answer POSITIVELY by name only.
  # ⛔ NOTHING IN $DENY_NAMES IS EVER PRESSED. Dismissing this dialog is a refusal to enable
  # bypass, not a way past it, and pressing one would be inventing the opposite of consent.
  $ACCEPT_NAMES = @('Yes, I accept', 'I accept', 'Accept', 'Yes, enable', 'Enable', 'Turn on',
                    'Confirm', 'Continue', 'I understand', 'Got it', 'OK', 'Yes',
                    'Ja, ich akzeptiere', 'Akzeptieren', 'Aktivieren', 'Bestätigen', 'Weiter', 'Ja')
  $DENY_NAMES = @('Cancel', 'Dismiss', 'No', 'Deny', 'Not now', 'Never', 'Exit', 'Abbrechen',
                  'Nein', 'Cancelar', 'Annuler', 'Reject')
  # How long the dialog is given to render before we call it absent. Costs nothing on the
  # common path: the loop leaves the moment the picker reads $SetMode, which for a chat that
  # needs no confirmation is the first look.
  $CONFIRM_WAIT_MS = 9000
  $CONFIRM_MAX_CLICKS = 4
  function Same-Spot($r1, $r2) {
    if ($r1.IsEmpty -or $r2.IsEmpty) { return $false }
    return ([Math]::Abs($r1.Left - $r2.Left) -lt 8) -and ([Math]::Abs($r1.Top - $r2.Top) -lt 8)
  }
  # One tree scan per look, not one PER CANDIDATE NAME. The old shape ran FindAll once for
  # each of eighteen accept labels - eighteen full descendant walks of an Electron tree, every
  # round - which is a real part of why a batch of these felt slow.
  function Find-Confirm($root, $pRect, $preIds, $isMain = $true) {
    $byName = @{}
    $modeHit = $null
    foreach ($b in $root.FindAll($TREE, $btnCond)) {
      try {
        $n = $b.Current.Name
        if (-not $n) { continue }
        $n = $n.Trim()
        if (-not $b.Current.IsEnabled -or $b.Current.IsOffscreen) { continue }
        $r = $b.Current.BoundingRectangle
        if ($r.IsEmpty) { continue }
        if ($DENY_NAMES -contains $n) { continue }
        if ($n -eq $SetMode) {
          # The dialog's confirm carries the mode's own name. The composer's picker carries it
          # too once the mode has taken, so position - not the name - is what tells them apart.
          # ⛔ AND THE SIDEBAR CHIPS CARRY IT AS WELL: a row's chip reads out its chat's mode
          # (chip.ps1), so a name-only match could click ANOTHER CHAT'S ROW and select it.
          # Same pane guard Find-ModeBtn uses - a modal is in the conversation pane, a chip
          # never is - which is why dropping the old $MODE_NAMES guard needs this in its place.
          # AND IT MUST BE NEW (review 2026-09-06): the same snapshot rule the named-accept
          # branch below obeys. A mode-named button that already existed before the item was
          # invoked - the picker itself after the mode took, a chip, a second composer's picker
          # - is not this dialog's confirm whatever its position says.
          $rid = ($b.GetRuntimeId() -join ',')
          # The pane/position guards discriminate the dialog's confirm from the composer's own
          # picker and the sidebar chips - all of which live in the MAIN window. In a separate
          # dialog window there is nothing to confuse it with, so requiring it to sit right of
          # the pane would reject the very button we came for. Must-be-new still applies.
          $placeOk = if ($isMain) { $r.Left -ge $minXm -and -not (Same-Spot $r $pRect) } else { $true }
          if ($placeOk -and -not $preIds.Contains($rid)) {
            if (-not $modeHit) { $modeHit = $b }
          }
          continue
        }
        if ($MODE_NAMES -contains $n) { continue }   # a picker/sidebar row is never a confirm
        if (-not $byName.ContainsKey($n)) {
          # RAIL (review 2026-09-06): only a button that is NEW since before the mode item was
          # invoked qualifies as this dialog's confirm - a same-named button already on screen
          # beforehand (unrelated to this action) must never be pressed as though it were.
          $rid = ($b.GetRuntimeId() -join ',')
          if (-not $preIds.Contains($rid)) { $byName[$n] = $b }
        }
      } catch { continue }
    }
    foreach ($want in $ACCEPT_NAMES) { if ($byName.ContainsKey($want)) { return $byName[$want] } }
    return $modeHit
  }
  $confirmNote = ''
  $clicks = 0
  $confirmDeadline = (Get-Date).AddMilliseconds($CONFIRM_WAIT_MS)
  while ($true) {
    $fresh = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $cur = Find-ModeBtn $fresh
    # THE ONLY SUCCESS CONDITION. Not "a dialog was clicked" and not "no dialog appeared" -
    # the picker itself reading the mode we asked for.
    if ($cur -and $cur.Current.Name -eq $SetMode) { break }
    # Look in the main window FIRST (the common case, and the cheapest), then in any other
    # top-level window the app owns - which is where this dialog actually lives.
    $dlgBtn = $null
    foreach ($root in (Get-ProcRoots $proc.ProcId $hwnd)) {
      $dlgBtn = Find-Confirm $root.Elem $pickerRect $preInvokeIds $root.IsMain
      if ($dlgBtn) { break }
    }
    if (-not $dlgBtn) {
      if ((Get-Date) -ge $confirmDeadline) { break }
      Start-Sleep -Milliseconds 300
      continue
    }
    $label = $dlgBtn.Current.Name
    if ($DENY_NAMES -contains $label.Trim()) {
      Write-Output "REFUSED: the only confirmation on screen was '$label', which is a refusal - not pressing it"; exit 6
    }
    $done = $false
    $dpi = TryPattern $dlgBtn ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($dpi) { try { $dpi.Invoke(); $done = $true } catch {} }
    if (-not $done) { $done = Press-Space $dlgBtn }
    if (-not $done) { Write-Output "REFUSED: a confirmation asked ('$label') and it took neither Invoke nor a focused Space"; exit 6 }
    $clicks++
    $confirmNote = " (confirmed the app's '$label' prompt)"
    if ($clicks -ge $CONFIRM_MAX_CLICKS) { break }
    # LATENCY (review 2026-09-06): poll for the picker to read the new mode instead of a flat
    # 500ms wait - same 500ms ceiling.
    $postClickDeadline = (Get-Date).AddMilliseconds(500)
    while ($true) {
      $probe = Find-ModeBtn ([System.Windows.Automation.AutomationElement]::FromHandle($hwnd))
      if (($probe -and $probe.Current.Name -eq $SetMode) -or (Get-Date) -ge $postClickDeadline) { break }
      Start-Sleep -Milliseconds 200
    }
  }
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $after = Find-ModeBtn $el
  $now = if ($after) { $after.Current.Name } else { 'gone' }
  if ($now -ne $SetMode) {
    # Name what is on screen so an UNKNOWN confirmation dialog (a button label in neither
    # ACCEPT_NAMES nor DENY_NAMES) can be read off the lane's log and added, instead of
    # failing mutely. Disabled and offscreen buttons are marked rather than hidden: the last
    # failure's list looked complete and was not.
    # ⛔ AND IT MUST LIST EVERY WINDOW THE APP OWNS, not just the main one (2026-09-07). This
    # scan used to root at $el, so when the confirm sat in its own top-level dialog the list
    # came back as the main frame's Minimize/Maximize and read as "no dialog appeared" - the
    # message that sent the last two investigations down the wrong path. A button found
    # outside the main window is tagged so the two can never be confused again.
    $seenBtns = @()
    $diagRoots = @()
    try { $diagRoots = Get-ProcRoots $proc.ProcId $hwnd } catch { $diagRoots = @([pscustomobject]@{ Elem = $el; IsMain = $true }) }
    foreach ($dr in $diagRoots) {
    foreach ($b in $dr.Elem.FindAll($TREE, $btnCond)) {
      try {
        $n = $b.Current.Name
        if (-not $n) { continue }
        $n = $n.Trim()
        if ($n.Length -gt 60) { $n = $n.Substring(0, 60) }
        if ($n -like 'More options*' -or $n -like 'Idle *' -or $n -like 'Running *') { continue }
        if ($b.Current.IsOffscreen) { $n = "$n(offscreen)" }
        elseif (-not $b.Current.IsEnabled) { $n = "$n(disabled)" }
        if (-not $dr.IsMain) { $n = "$n[dialog]" }
        $seenBtns += $n
      } catch { continue }
    }
    }
    $seenBtns = @($seenBtns | Select-Object -Unique | Select-Object -First 30)
    Write-Output "REFUSED: picked '$SetMode' but the picker now reads '$now' - the mode did not take$confirmNote (waited $([int]($CONFIRM_WAIT_MS/1000))s for a confirmation, pressed $clicks; buttons on screen: $($seenBtns -join ' | '))"
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
