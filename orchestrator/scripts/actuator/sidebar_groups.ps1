# sidebar_groups.ps1 - open the Claude desktop app's COLLAPSED sidebar project groups so the chat
# rows inside them are rendered, and fold back exactly the groups a run opened. Dot-sourced by
# deliver_desktop_chat.ps1 and approve_prompt.ps1 (moved here verbatim from the delivery script's
# inline copy on 2026-09-24, board ruling on AgentHydra to-do 5f8bde91: the approval actuator had no
# expand step at all, so a stuck permission prompt in a chat inside a collapsed group never cleared).
#
# EXPAND EVERY COLLAPSED SIDEBAR GROUP (2026-09-01). "Not rendered in any searched running
# instance (collapsed group or virtualized out)" was the single commonest delivery refusal on a
# real fleet - and for a COLLAPSED group it is not a reach limit at all, it is a closed drawer. The
# app exposes ExpandCollapse on those group headers, so open them and the rows underneath become
# ordinary rendered rows. Read-only in effect (expanding a list changes no chat) and bounded.
#
# IDENTIFY A GROUP POSITIVELY - A BLACKLIST IS NOT GOOD ENOUGH (owner, 2026-09-01: "it's still
# clicking random shit... I think it's the script trying to select the model"). The first cut
# expanded EVERY ExpandCollapse element in the window and skipped only the kebabs by name. The
# MODEL PICKER is an ExpandCollapse control too, and so is every other dropdown in the app - so it
# opened the model menu, on a real account, repeatedly. THE ALLOW-LIST IS BUILT FROM THE APP
# ITSELF: every project group in the sidebar has a companion button named "New session in <that
# group>" (measured across five live instances 2026-09-01), and nothing else in the window has one.
# So the set of names worth expanding is derived, not guessed, and cannot include 'More models',
# 'Effort: Max', 'Bypass permissions', the account menu, 'Filter', 'Remote Control' or a
# 'Ran 6 commands' disclosure. At most 40 groups per run.
#
# LEAVE THE SIDEBAR AS IT WAS FOUND (owner, 2026-09-04: "something keeps clicking interface buttons
# on my Claude desktop, like the repo names or whatever"). Every group a run opens is remembered and
# Restore-SidebarGroups collapses it again - callers run it on EVERY exit path. The list lives in a
# GLOBAL so an exit-event action (approve_prompt.ps1's PowerShell.Exiting handler) can reach it too.
#
# Reach limit that remains: a row scrolled far out of a VIRTUALIZED sidebar is still not rendered
# after this; bringing it into view focus-free is not solved (misc/Manage-DesktopChat.ps1 records
# why) and is deliberately not attempted here.

$global:AhOpenedSidebarGroups = @()

# Expands the collapsed sidebar project groups of window element $el. Returns ONLY the number it
# opened (an [int]); the caller re-reads the window after a short settle when that is above zero.
function global:Expand-SidebarGroups($el) {
  $expanded = 0
  try {
    $groupNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($b in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                               [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $n = $b.Current.Name
        if ($n -and $n.Length -gt 15 -and $n.StartsWith('New session in ')) {
          [void]$groupNames.Add($n.Substring(15).Trim())
        }
      } catch { continue }
    }
    foreach ($g in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                               [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $n = $g.Current.Name
        if (-not $n -or -not $groupNames.Contains($n.Trim())) { continue }
        $ecp = $null
        try { $ecp = $g.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern) } catch { $ecp = $null }
        if (-not $ecp) { continue }
        if ($ecp.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Collapsed) { continue }
        $ecp.Expand(); $global:AhOpenedSidebarGroups += $ecp; $expanded++
        if ($expanded -ge 40) { break }
      } catch { continue }
    }
  } catch { }
  return [int]$expanded
}

# Collapses every group this run opened, once, and says how many. Safe to call repeatedly.
function global:Restore-SidebarGroups {
  $n = 0
  foreach ($ecp in @($global:AhOpenedSidebarGroups)) { try { $ecp.Collapse(); $n++ } catch { } }
  $global:AhOpenedSidebarGroups = @()
  if ($n -gt 0) { Write-Output "collapsed $n sidebar group(s) back the way they were" }
}
