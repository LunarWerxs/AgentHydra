# misc/Deliver-DesktopChat.ps1 - DELIVER a prompt INTO a specific chat of a RUNNING Claude
# desktop app, focus-free, by driving the app's own composer through UI Automation.
#
# WHY THIS EXISTS (owner directive, Michael, 2026-08-30, after being told the delivery gap
# would need an app update: "this is unacceptable and you will find a way around this. End of
# story."). Every other unattended channel was measured DEAD on app-1.40609.0:
#   - Writing the app's scheduled-tasks store DOES fire a task (fireAt one-shot, SKILL at
#     ~/.claude/scheduled-tasks/<id>/SKILL.md) - but the session it spawns is flagged
#     UNATTENDED, and `ccd_session_mgmt send_message` REFUSES there: "This tool is unavailable
#     in unattended sessions (scheduled-task runs and remote-dispatched trees)." Measured
#     2026-08-30 with the tool's own error text. So the scheduler cannot relay into a chat.
#   - claude://resume of a transcript ending on an unanswered user turn boots an engine that
#     never runs the turn.
# THIS is what works, proven end to end 2026-08-30: select the target chat's sidebar row
# (Invoke), verify its conversation is really on screen, SetValue the composer, Invoke Send -
# the dormant chat woke and answered. Zero clicks, zero focus theft, no app update.
#
# THE AIM RAILS, because this is the failure mode that got v1's UI injection DELETED (it once
# typed into whichever window really had focus). A send is only ever attempted when ALL hold:
#   1. The instance is matched by EXACT --user-data-dir (path-shaped -Instance must match
#      exactly; substring matching would let '...\i1' hit '...\i10').
#   2. The target row is found by its title. The row button's Name carries a STATUS PREFIX
#      ("Inaktiv <title>" / "Needs input <title>"), so the match is ENDS-WITH the exact title,
#      excluding the kebab ("More options for ..." / "Weitere Optionen ...").
#   3. After Invoke, -VerifyText must be VISIBLE in the conversation pane. This is the proof
#      the composer we are about to fill belongs to the intended chat and not to whatever was
#      open before. No proof = refuse (exit 4), never "send anyway".
#   4. The composer must be a writable Edit named 'Prompt', and SetValue must READ BACK.
#   5. The Send button must FLIP from disabled to enabled after SetValue - that flip is the
#      app's own React state confirming it saw the text. Not enabled = refuse (exit 5).
#   6. -IfBusyAbort: a 'Stop' button in place of Send means a turn is already running; we do
#      not interrupt live work.
# Reach limit (same as Manage-DesktopChat.ps1): only a RENDERED sidebar row can be actioned.
#
# Exit: 0 delivered - 1 error - 3 target row not rendered - 4 wrong chat / unverified -
#       5 composer did not accept the text - 6 chat busy (turn in flight).
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$Instance = '',
  # A snippet that MUST be visible in the target's conversation after selecting it.
  [Parameter(Mandatory = $true)][string]$VerifyText,
  [switch]$IfBusyAbort,
  # When the title is not rendered (an imported chat shows as 'Untitled'), identify the chat
  # by opening candidate rows and matching VerifyText. Safe by construction: the same
  # on-screen proof gates the send, so a wrong guess navigates and then refuses.
  [switch]$SearchByContent
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$src = @'
using System;using System.Runtime.InteropServices;using System.Collections.Generic;using System.Text;
public static class AxD{
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
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }
function Buttons($scope) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
  return $scope.FindAll($TREE, $c)
}
# Send/Stop are LOCALIZED ('Senden' on this box). Key off the known label set; the enabled
# flip is what actually proves the app saw our text, so the label only has to find it.
$SEND_NAMES = @('Send', 'Senden', 'Enviar', 'Envoyer', 'Invia', 'Verzenden')
$STOP_NAMES = @('Stop', 'Stopp', 'Anhalten', 'Detener', 'Arrêter', 'Interrompi', 'Stoppen')
# Only a TIE-BREAK, never the primary lookup: the composer is found structurally (RAIL 4). This
# list exists solely to pick between two writable boxes when both are on screen.
$PROMPT_NAMES = @('Prompt', 'Eingabe', 'Nachricht', 'Message', 'Mensaje', 'Messaggio', 'Bericht')

$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    # ⛔ SAME PARSE, SAME BUG - see the long note in Manage-DesktopChat.ps1. Windows quotes the
    # WHOLE argument ("--user-data-dir=C:\...\pap3r rotate2"), so a pattern expecting the quote
    # after the '=' truncated any profile path at its first space and that account became
    # undeliverable as well as unmanageable. Kept identical in both files on purpose: one of
    # them silently disagreeing about which instance is which is worse than either being wrong.
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir="([^"]+)"') }
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
if ($Instance) {
  $mains = @($mains | Where-Object {
      if ($Instance -match '[\\/]') { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') }
      else { $_.Dir -like "*$Instance*" }
    })
}
if (-not $mains) { Write-Output "FAIL: no running Claude desktop instance matches '$Instance'"; exit 1 }

foreach ($m in $mains) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$m.ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { continue }
  $hwnd = [IntPtr]$win.Current.NativeWindowHandle
  [AxD]::Wake($hwnd); Start-Sleep -Milliseconds 1000
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

  # RAIL 2: get the target chat ON SCREEN. It may ALREADY be the open conversation - an open
  # chat renders no selectable sidebar row (measured), so requiring a row would refuse the
  # easiest case. Ask the aim question first: is the target's own text already visible?
  # The proof must be ON SCREEN, not merely present somewhere in the window's tree. The
  # sidebar renders other chats' titles and preview snippets, so an un-scoped Contains() could
  # "verify" against a DIFFERENT chat's preview and type into the wrong conversation
  # (review-confirmed). IsOffscreen is UIA's own answer to exactly that.
  # Returns the MATCHING ELEMENT (truthy) or $null, not merely a boolean: RAIL 4 needs to know
  # WHERE the proof was found, because a window can hold two chat panes side by side and each has
  # its own composer (measured 2026-08-30: one real window, two writable Edits both named
  # 'Prompt', 308x44 each at x=995 and x=1423). Verifying in one pane and then typing into "the"
  # composer is how a proven aim still ends up in the wrong conversation.
  function TargetVisible($scope) {
    foreach ($e in $scope.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      $n = $e.Current.Name
      if (-not $n -or -not $n.Contains($VerifyText)) { continue }
      try { if ($e.Current.IsOffscreen) { continue } } catch { continue }
      # ⛔ A SIDEBAR PREVIEW IS NOT THE CONVERSATION. IsOffscreen alone is NOT enough: a chat
      # row's own preview snippet renders the chat's newest turn ON SCREEN in the sidebar, so
      # a window-wide scan can "prove" the target while a DIFFERENT conversation is open -
      # and if the row click silently no-opped, the prompt then goes into that other chat's
      # composer. Measured live 2026-08-31: a staged drill prompt was typed into a real work
      # chat twice this way. Conversation text does not live inside a Button/ListItem;
      # sidebar previews do. Walk up: any Button/ListItem ancestor disqualifies the match.
      $inRow = $false
      $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
      $p = $e
      for ($i = 0; $i -lt 20 -and $p; $i++) {
        try { $p = $walker.GetParent($p) } catch { break }
        if (-not $p) { break }
        try {
          $ct = $p.Current.ControlType
          if ($ct -eq [System.Windows.Automation.ControlType]::Button -or
              $ct -eq [System.Windows.Automation.ControlType]::ListItem) { $inRow = $true; break }
        } catch { break }
      }
      if ($inRow) { continue }
      return $e
    }
    return $null
  }
  if (TargetVisible $el) {
    Write-Output "'$Title' is already the open conversation in $($m.Dir)"
  }
  else {
    # Not open: select its row, matched ENDS-WITH the title (rows carry a status prefix like
    # 'Inaktiv <title>'), never the kebab.
    # AMBIGUITY IS A REFUSAL, not a coin flip: a suffix match means chat 'Notes' also matches
    # a row for 'My Notes', and taking the first hit in tree order would silently target the
    # wrong chat (review-confirmed). Collect them all and refuse if more than one survives.
    # THE KEBAB IS EXCLUDED BY WHAT IT IS, NOT BY WHAT IT IS CALLED. This used to test the name
    # against two literals ('More options for *' and '*Optionen*') in a file that supports six
    # languages everywhere else - so on a French, Spanish, Italian or Dutch app the kebab's own
    # name ALSO ends with the chat title, both survive, and the ambiguity guard below then refuses
    # the delivery outright. The sibling script settled this months ago: the kebab exposes
    # ExpandCollapse, the row itself exposes Invoke. The pattern identifies it, in every language.
    $rowMatches = @()
    foreach ($b in Buttons $el) {
      $n = $b.Current.Name
      if (-not $n -or -not $n.EndsWith($Title)) { continue }
      if (TryPattern $b ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) { continue }
      if (-not (TryPattern $b ([System.Windows.Automation.InvokePattern]::Pattern))) { continue }
      $rowMatches += $b
    }
    $ambiguous = @()
    if ($rowMatches.Count -gt 1) {
      # An exact-name row (no status prefix) is unambiguous; otherwise refuse.
      $exact = @($rowMatches | Where-Object { $_.Current.Name -eq $Title })
      if ($exact.Count -eq 1) { $rowMatches = $exact }
      elseif ($SearchByContent) {
        # A NAME COLLISION IS NOT A REASON TO GIVE UP, IT IS A REASON TO USE THE STRONGER
        # TEST. Refusing here was correct only while the name was the sole evidence available;
        # this script already carries a better one - open a row and see whether the
        # conversation itself shows the expected text. Two rows bearing one title is the NORMAL
        # state after a chat has been surfaced more than once, and a flat refusal made those
        # chats permanently undeliverable: the prompt stayed staged, the chat stayed dormant,
        # and the fleet looked unmanaged (measured 2026-08-31 on a chat with three such rows).
        # Narrowing the content search to exactly the colliding rows is also STRICTER than the
        # untargeted fallback below - every candidate already carries the right title - and the
        # send is still gated by RAIL 3, which proves the conversation on screen before typing.
        # So this can no more reach the wrong chat than the refusal could.
        Write-Output ("'$Title' matches " + $rowMatches.Count +
          ' rendered rows - identifying by content rather than refusing')
        $ambiguous = $rowMatches
        $rowMatches = @()
      }
      else {
        Write-Output ("REFUSED: '$Title' is ambiguous - " + $rowMatches.Count + " rendered rows end with it (" +
          (($rowMatches | ForEach-Object { "'" + $_.Current.Name + "'" }) -join ', ') +
          ') - rerun with -SearchByContent to resolve it by conversation content')
        exit 4
      }
    }
    $row = if ($rowMatches.Count -eq 1) { $rowMatches[0] } else { $null }
    if ($row) {
      Write-Output "found '$Title' in $($m.Dir) (row '$($row.Current.Name)')"
      $inv = TryPattern $row ([System.Windows.Automation.InvokePattern]::Pattern)
      if (-not $inv) { Write-Output 'FAIL: chat row does not expose Invoke'; exit 1 }
      $inv.Invoke()
      Start-Sleep -Milliseconds 2000
      [AxD]::Wake($hwnd); Start-Sleep -Milliseconds 800
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    }
    elseif ($SearchByContent) {
      # THE TITLE THE APP RENDERS IS NOT ALWAYS THE TITLE ON DISK: an imported chat renders
      # as 'Untitled' until it is renamed through the app (banked behaviour), so a
      # title-only lookup strands exactly the chats the courier most needs to reach.
      # Fall back to identifying the chat BY ITS CONTENT: open candidate rows one at a time
      # and keep the one whose conversation shows VerifyText. This can never deliver to the
      # wrong chat - the same on-screen proof still gates the send below - it only costs a
      # few navigations. Bounded, and it skips rows that already matched another title.
      $candidates = @()
      if ($ambiguous.Count -gt 0) {
        # Already narrowed to the rows that carry this exact title - do not widen back out to
        # every button on screen, which would only add ways to open the wrong conversation.
        Write-Output ('  candidates: the ' + $ambiguous.Count + ' rows carrying this title')
        $candidates = $ambiguous
      }
      else {
        Write-Output "'$Title' is not rendered; searching by content for the target..."
        foreach ($b in Buttons $el) {
          $n = $b.Current.Name
          if ($n -and $n -notlike 'More options for *' -and $n -notlike '*Optionen*' -and
              $n -notlike '*Feedback*' -and (TryPattern $b ([System.Windows.Automation.InvokePattern]::Pattern))) {
            $candidates += $b
          }
        }
      }
      $hit = $false
      foreach ($c in ($candidates | Select-Object -First 12)) {
        $ci = TryPattern $c ([System.Windows.Automation.InvokePattern]::Pattern)
        if (-not $ci) { continue }
        # A DISABLED candidate must be SKIPPED, not fatal: Invoke on one throws
        # ElementNotEnabledException, and before this guard a single greyed-out button
        # anywhere in the candidate list crashed the whole delivery pass (measured
        # 2026-08-31, first live run of the content-search fallback).
        try { $ci.Invoke() } catch { continue }
        Start-Sleep -Milliseconds 1400
        [AxD]::Wake($hwnd); Start-Sleep -Milliseconds 500
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if (TargetVisible $el) {
          Write-Output "  identified by content: row '$($c.Current.Name)'"
          $hit = $true
          break
        }
      }
      if (-not $hit) { continue }  # not in this instance; try the next
    }
    else { continue }  # not rendered in this instance; try the next
  }

  # RAIL 3: PROVE the intended conversation is the one on screen.
  # ⛔ THIS CALLS TargetVisible, it does NOT re-implement it. It used to: the same scan pasted
  # a second time, minus the IsOffscreen filter. That made the file's most important gate the
  # WEAKEST of the two copies, and in the common path (a title-matched sidebar row we just
  # Invoked) nothing else confirms the click actually switched conversations - so if the
  # Invoke silently no-opped, the target's own still-rendered SIDEBAR PREVIEW satisfied this
  # check and the prompt went into whatever chat happened to be open. Found by an adversarial
  # audit 2026-08-30, after the offscreen fix had already been applied - to one copy.
  $proof = TargetVisible $el
  if (-not $proof) {
    Write-Output "REFUSED: after selecting '$Title' the conversation does not show the expected text - not typing into the wrong chat"
    exit 4
  }

  # RAIL 6: never interrupt a turn in flight.
  $stop = $null
  foreach ($b in Buttons $el) { if ($STOP_NAMES -contains $b.Current.Name) { $stop = $b; break } }
  if ($stop -and $IfBusyAbort) { Write-Output 'ABORT: this chat has a turn in flight (Stop button present)'; exit 6 }

  # RAIL 4: the composer, found STRUCTURALLY.
  # ⛔ IT USED TO BE `Name -eq 'Prompt'`, a bare English literal in a file that carries six-language
  # lists for Send and Stop - so on the owner's GERMAN app the whole delivery channel would have
  # exited 5 and typed nothing, forever, while every other rail worked. The sibling script already
  # proved these Edit names ARE localized ('Sitzungsname' for the rename editor), so the string was
  # never safe. What actually identifies the composer is what it IS: an on-screen Edit you can
  # write to. That is language-independent, and on a chat window it is normally unique.
  function WritableEdits($scope) {
    $out = @()
    foreach ($e in $scope.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit') { continue }
      try { if ($e.Current.IsOffscreen) { continue } } catch { continue }
      $p = TryPattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($p -and -not $p.Current.IsReadOnly) { $out += $e }
    }
    return $out
  }

  # FIRST, AND THIS IS THE ONE THAT MATTERS: climb from the ELEMENT that proved our aim until we
  # reach the smallest container that also holds a writable box. That box belongs to the same pane
  # as the proof, which is the whole guarantee this script exists to make. Without it, a window
  # showing two conversations side by side verifies in one pane and types into whichever composer
  # happens to come first in tree order - a proven aim landing in the wrong chat.
  $prompt = $null
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $proof
  for ($up = 0; $up -lt 12 -and $node -ne $null; $up++) {
    $here = WritableEdits $node
    if ($here.Count -eq 1) { $prompt = $here[0]; break }
    if ($here.Count -gt 1) { break }  # this ancestor already spans both panes - stop climbing
    try { $node = $walker.GetParent($node) } catch { break }
  }

  if (-not $prompt) {
    # The proof's own subtree told us nothing (a flat tree, or the proof sits outside the pane).
    # Fall back to the window: one writable box on screen is unambiguous by itself.
    $writable = WritableEdits $el
    if ($writable.Count -eq 1) { $prompt = $writable[0] }
    elseif ($writable.Count -gt 1) {
      $named = @($writable | Where-Object { $PROMPT_NAMES -contains $_.Current.Name })
      if ($named.Count -eq 1) { $prompt = $named[0] }
      else {
        Write-Output ('REFUSED: ' + $writable.Count + ' writable text boxes are on screen and none could be tied to the verified conversation (' +
          (($writable | ForEach-Object { "'" + $_.Current.Name + "'" }) -join ', ') + ') - not typing into a guess')
        exit 5
      }
    }
  }
  if (-not $prompt) { Write-Output 'FAIL: no writable text box on screen - the composer was not found'; exit 5 }
  $vp = TryPattern $prompt ([System.Windows.Automation.ValuePattern]::Pattern)
  if (-not $vp -or $vp.Current.IsReadOnly) { Write-Output 'FAIL: composer is not writable'; exit 5 }

  # RAIL 5: SetValue, then require the Send button to FLIP enabled (React saw the text).
  # THE SEND BUTTON MUST BE THE COMPOSER'S OWN. A two-pane window has two of them, and taking the
  # first in tree order means typing into one pane and watching the other pane's button for the
  # enabled flip - which never comes, so a delivery that actually landed reports as failed and the
  # courier retries it. Climb from the composer to the nearest container that holds a Send button.
  function SendScopeFor($edit) {
    $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $n = $edit
    for ($u = 0; $u -lt 12 -and $n -ne $null; $u++) {
      foreach ($b in Buttons $n) { if ($SEND_NAMES -contains $b.Current.Name) { return $n } }
      try { $n = $w.GetParent($n) } catch { break }
    }
    return $null
  }
  function SendIn($scope) {
    foreach ($b in Buttons $scope) { if ($SEND_NAMES -contains $b.Current.Name) { return $b } }
    return $null
  }
  $sendScope = SendScopeFor $prompt
  if (-not $sendScope) { $sendScope = $el }
  $sendBtn = SendIn $sendScope
  $wasEnabled = if ($sendBtn) { $sendBtn.Current.IsEnabled } else { $false }
  $delivered = $false
  for ($try = 1; $try -le 3 -and -not $delivered; $try++) {
    $vp.SetValue($Message)
    Start-Sleep -Milliseconds 700
    [AxD]::Wake($hwnd); Start-Sleep -Milliseconds 300
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    # Re-read within the composer's own scope. The refreshed tree invalidates the old handles, so
    # re-derive the scope from the composer rather than reusing a stale container.
    $rescope = SendScopeFor $prompt
    if (-not $rescope) { $rescope = $el }
    $sendBtn = SendIn $rescope
    if (-not $sendBtn) { Start-Sleep -Milliseconds 500; continue }
    if (-not $sendBtn.Current.IsEnabled) { Start-Sleep -Milliseconds 500; continue }
    $si = TryPattern $sendBtn ([System.Windows.Automation.InvokePattern]::Pattern)
    if (-not $si) { Write-Output 'FAIL: Send exposes no Invoke'; exit 5 }
    $si.Invoke()
    $delivered = $true
  }
  if (-not $delivered) {
    # Leave nothing behind: an un-sent message sitting in the owner's composer is our litter,
    # and worse, he could send it by hand later without context (review-confirmed).
    try { $vp.SetValue('') } catch { }
    Write-Output "FAIL: the composer never reported the text (Send stayed disabled; was enabled before: $wasEnabled) - composer cleared"
    exit 5
  }
  Write-Output "DELIVERED to '$Title' in $($m.Dir) (focus-free; row-verified before typing)"
  exit 0
}
Write-Output "FAIL: '$Title' is not rendered in any searched running instance (collapsed group or virtualized out)"
exit 3
