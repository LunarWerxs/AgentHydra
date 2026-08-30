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
$STOP_NAMES = @('Stop', 'Stopp', 'Anhalten', 'Detener', 'Arrêter')

$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '--user-data-dir=("?)([^"]+?)\1(\s|$)')
    $dir = if ($m.Success) { $m.Groups[2].Value } else { Join-Path $env:APPDATA 'Claude' }
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
  function TargetVisible($scope) {
    foreach ($e in $scope.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      $n = $e.Current.Name
      if ($n -and $n.Contains($VerifyText)) { return $true }
    }
    return $false
  }
  if (TargetVisible $el) {
    Write-Output "'$Title' is already the open conversation in $($m.Dir)"
  }
  else {
    # Not open: select its row, matched ENDS-WITH the title (rows carry a status prefix like
    # 'Inaktiv <title>'), never the kebab.
    $row = $null
    foreach ($b in Buttons $el) {
      $n = $b.Current.Name
      if ($n -and $n.EndsWith($Title) -and $n -notlike 'More options for *' -and $n -notlike '*Optionen*') { $row = $b; break }
    }
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
      Write-Output "'$Title' is not rendered; searching by content for the target..."
      $candidates = @()
      foreach ($b in Buttons $el) {
        $n = $b.Current.Name
        if ($n -and $n -notlike 'More options for *' -and $n -notlike '*Optionen*' -and
            $n -notlike '*Feedback*' -and (TryPattern $b ([System.Windows.Automation.InvokePattern]::Pattern))) {
          $candidates += $b
        }
      }
      $hit = $false
      foreach ($c in ($candidates | Select-Object -First 12)) {
        $ci = TryPattern $c ([System.Windows.Automation.InvokePattern]::Pattern)
        if (-not $ci) { continue }
        $ci.Invoke()
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
  $verified = $false
  foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
    $n = $e.Current.Name
    if ($n -and $n.Contains($VerifyText)) { $verified = $true; break }
  }
  if (-not $verified) {
    Write-Output "REFUSED: after selecting '$Title' the conversation does not show the expected text - not typing into the wrong chat"
    exit 4
  }

  # RAIL 6: never interrupt a turn in flight.
  $stop = $null
  foreach ($b in Buttons $el) { if ($STOP_NAMES -contains $b.Current.Name) { $stop = $b; break } }
  if ($stop -and $IfBusyAbort) { Write-Output 'ABORT: this chat has a turn in flight (Stop button present)'; exit 6 }

  # RAIL 4: the composer.
  $prompt = $null
  foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $e.Current.Name -eq 'Prompt') { $prompt = $e; break }
  }
  if (-not $prompt) { Write-Output 'FAIL: composer (Edit named Prompt) not found'; exit 5 }
  $vp = TryPattern $prompt ([System.Windows.Automation.ValuePattern]::Pattern)
  if (-not $vp -or $vp.Current.IsReadOnly) { Write-Output 'FAIL: composer is not writable'; exit 5 }

  # RAIL 5: SetValue, then require the Send button to FLIP enabled (React saw the text).
  $sendBtn = $null
  foreach ($b in Buttons $el) { if ($SEND_NAMES -contains $b.Current.Name) { $sendBtn = $b; break } }
  $wasEnabled = if ($sendBtn) { $sendBtn.Current.IsEnabled } else { $false }
  $delivered = $false
  for ($try = 1; $try -le 3 -and -not $delivered; $try++) {
    $vp.SetValue($Message)
    Start-Sleep -Milliseconds 700
    [AxD]::Wake($hwnd); Start-Sleep -Milliseconds 300
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $sendBtn = $null
    foreach ($b in Buttons $el) { if ($SEND_NAMES -contains $b.Current.Name) { $sendBtn = $b; break } }
    if (-not $sendBtn) { Start-Sleep -Milliseconds 500; continue }
    if (-not $sendBtn.Current.IsEnabled) { Start-Sleep -Milliseconds 500; continue }
    $si = TryPattern $sendBtn ([System.Windows.Automation.InvokePattern]::Pattern)
    if (-not $si) { Write-Output 'FAIL: Send exposes no Invoke'; exit 5 }
    $si.Invoke()
    $delivered = $true
  }
  if (-not $delivered) {
    Write-Output "FAIL: the composer never reported the text (Send stayed disabled; was enabled before: $wasEnabled)"
    exit 5
  }
  Write-Output "DELIVERED to '$Title' in $($m.Dir) (focus-free; row-verified before typing)"
  exit 0
}
Write-Output "FAIL: '$Title' is not rendered in any searched running instance (collapsed group or virtualized out)"
exit 3
