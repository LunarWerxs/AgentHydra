<#
.SYNOPSIS
  Register (or remove) the scheduled task that keeps the AgentHydra daemon alive.

.DESCRIPTION
  WHY THIS EXISTS (owner directive, Michael, 2026-08-30, after an orchestration pass found the
  hole): every piece needed to keep the daemon up already existed - Ensure-Daemon.ps1 is a proper
  idempotent preflight, Restart-Daemon.ps1 kills stale code, Wait-Daemon.ps1 proves recovery -
  and NOTHING EVER CALLED THEM ON A SCHEDULE. The daemon was alive only because a person had
  typed a command into a console 5.5 hours earlier; its parent was a bare `cmd /c bun
  server/src/index.ts` with no supervisor above it. A census that day found no scheduled task, no
  Startup shortcut and no Run key entry for this app on the machine that runs the fleet.

  That is the worst shape an outage can take: orchestration does not crash loudly, it simply
  stops happening, and every automation that talks to it fails one HTTP call at a time until a
  human happens to notice. This closes it with the smallest possible addition - a schedule in
  front of the ensure script that already knew how to do the work.

  WHAT IT DOES NOT DO, deliberately:
    * No elevation. The task runs as the current user, in their own session. A supervisor that
      demands Administrator is one that gets installed once and never reinstalled.
    * No credential storage, so no "run whether user is logged on or not". The daemon serves a
      desktop fleet that only exists inside an interactive session anyway; a session-0 copy
      would answer the port while being unable to see or drive a single Claude window.
    * No second start path. It invokes Ensure-Daemon.ps1, which no-ops when a healthy daemon of
      ours is already answering. It can never race the tray into starting a duplicate.

.PARAMETER IntervalMinutes
  How often to check. Default 5. The check is a single HTTP call against /api/health when
  everything is healthy, so this is cheap; the cost of a longer interval is dead-air minutes
  where orchestration is silently down.

.PARAMETER TaskName
  Scheduled task name. Default 'AgentHydra Daemon Supervisor'.

.PARAMETER Uninstall
  Remove the task instead of creating it.

.PARAMETER Status
  Report what is registered and what the last run did, and change nothing.

.EXAMPLE
  .\Install-DaemonSupervisor.ps1

.EXAMPLE
  .\Install-DaemonSupervisor.ps1 -Status

.EXAMPLE
  .\Install-DaemonSupervisor.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 5,
  [string]$TaskName = 'AgentHydra Daemon Supervisor',
  [switch]$Uninstall,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
# Resolved in the body, not in param(): under Windows PowerShell 5.1 a [CmdletBinding()] script
# evaluates param defaults BEFORE $PSScriptRoot is populated. Same note as Wait-Daemon.ps1.
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$tick = Join-Path $here 'Supervisor-Tick.vbs'

function Get-Task {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

if ($Status) {
  $t = Get-Task
  if (-not $t) { Write-Host "  NOT INSTALLED: no scheduled task named '$TaskName'."; exit 1 }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "  INSTALLED: '$TaskName' is $($t.State)."
  Write-Host "    action     : $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
  Write-Host "    last run   : $($info.LastRunTime)  result=$($info.LastTaskResult)"
  Write-Host "    next run   : $($info.NextRunTime)"
  # LastTaskResult is Ensure-Daemon's own exit code, forwarded by the VBS: 0 = a healthy daemon
  # of ours answered, anything else = it did not and the recovery failed. Say so in words, since
  # a bare integer in a task list is exactly the kind of thing nobody reads.
  if ($null -ne $info.LastTaskResult -and $info.LastTaskResult -ne 0 -and $info.LastRunTime) {
    Write-Host "    ⚠ the last tick FAILED to bring the daemon up - investigate before trusting it."
  }
  exit 0
}

if ($Uninstall) {
  if (-not (Get-Task)) { Write-Host "  Nothing to remove: no task named '$TaskName'."; exit 0 }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  REMOVED: '$TaskName'. The daemon is now unsupervised again."
  exit 0
}

if (-not (Test-Path $tick)) {
  throw "Supervisor-Tick.vbs not found beside this script ($tick). Restore it before installing."
}

# Two triggers, because they cover different outages and neither covers the other:
#   AtLogOn  - the machine rebooted, or the user signed back in. Nothing else brings it back.
#   Once+rep - the daemon died mid-session (crash, an errant kill, a rebuild that never
#              relaunched). A logon trigger would wait for the next reboot to notice.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument "//nologo `"$tick`"" -WorkingDirectory (Split-Path -Parent $here)

# Interactive/Limited: the current user, their own desktop session, no elevation and no stored
# password. RunLevel Limited is not a compromise here - the daemon must run at the same integrity
# level as the Claude windows it drives, and an elevated daemon could not talk to them.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

# IgnoreNew: a tick that is still working (a cold start can take ~90s) must never have a second
# tick stacked on top of it racing to start the same daemon twice.
# ExecutionTimeLimit: a wedged ensure has to die rather than occupy the slot forever.
# The battery settings matter on a laptop: the default is to stop the task on battery, which
# would silently switch the supervisor off exactly when nobody is watching the machine.
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Trigger @($atLogon, $repeat) -Action $action `
  -Principal $principal -Settings $settings -Force -Description @'
Keeps the AgentHydra daemon alive. Runs misc/Ensure-Daemon.ps1, which does nothing when a
healthy daemon of ours is already answering and restarts it when nothing is. Installed by
misc/Install-DaemonSupervisor.ps1; remove with that script's -Uninstall switch.
'@ | Out-Null

Write-Host "  INSTALLED: '$TaskName' - checks every $IntervalMinutes min, and at logon."
Write-Host "    tick: wscript //nologo `"$tick`""
Write-Host "    Verify with: .\Install-DaemonSupervisor.ps1 -Status"
