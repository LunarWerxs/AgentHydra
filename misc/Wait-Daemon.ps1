# misc/Wait-Daemon.ps1 — confirm the daemon came back, PROVE it serves the code we just built,
# and PROVE it stays up.
#
# WHY: the failure this guards against is silent. On 2026-07-14 a daemon served 10h39m-old code
# while every `Rebuild.bat` run printed "Done." The build was genuinely fresh on disk; the process
# serving it simply never restarted. Nothing in the flow ever looked, so nothing ever complained.
#
# So a rebuild is not "done" when the script ends. It is done when a daemon answers /api/health as
# THIS app AND that process started AFTER we stopped the old one AND it is still that same process,
# still answering, a stability hold later. Each clause earned its place the hard way:
#   * merely UP proves nothing -- the stale daemon was up the entire time too (2026-07-14);
#   * answering ONCE proves liveness, not stability -- on 2026-07-15 this script printed "OK" one
#     second after boot, and within ~90 seconds the daemon, two fighting tray hosts, and everything
#     else were dead (the zero-instance incident; see Restart-Daemon.ps1's header). A supervisor
#     race or a console teardown kills AFTER first health, so the hold is where it gets caught.
#
# HOW THIS SCRIPT ITSELF LIED (2026-07-15), and the rule that fixes it:
# The old Find-Daemon accepted any responder that didn't contradict us --
#   if (-not $svc -or $svc -eq $AppName) { return ... }
# -- so a health body with no `service` field counted as this app. Vite dev servers answer
# /api/health with the SPA fallback (200 OK, text/html, an index.html body), so one of Michael's
# Connections dev planes on port 4273 was mistaken for redesign; this script read THAT stranger's
# start time, found it older than the stamp, and reported "STALE DAEMON: you are still being served
# the OLD code" while the real redesign daemon was up on port 5178 serving the fresh build.
#
# The rule now matches Restart-Daemon.ps1 exactly: a responder is this app only with a JSON
# content-type, `ok: true`, and `service` EQUAL to package.json `name`. Silence is not identity.
# An unidentified responder is a stranger, so we keep looking rather than latch onto it and lie in
# either direction (a false "stale" is as costly as a false "fresh" -- it burns your time hunting a
# bug that doesn't exist, and it trains you to ignore the alarm on the day it's real).
#
# How it knows when the rebuild started: Restart-Daemon.ps1 drops a timestamp file when it runs.
# If that stamp is present and recent, the daemon must be younger than it. If there is no stamp
# (someone ran this script on its own), there is nothing to compare against, so this degrades to a
# plain "is it up (and does it stay up)?" check rather than inventing a threshold and crying wolf.

[CmdletBinding()]
param(
  # Repo root; resolved in the body, NOT here — under Windows PowerShell 5.1 a [CmdletBinding()]
  # script evaluates param defaults BEFORE $PSScriptRoot is populated (pwsh 7 is fine either way).
  [string]$Root = '',
  # How long to give the tray to bring the daemon back up.
  [int]$TimeoutSeconds = 30,
  # How long the daemon must then STAY up -- same pid, still answering -- before the restart is
  # called good. 0 skips the hold (old fire-and-forget behavior; you lose the 2026-07-15 guard).
  [int]$StabilitySeconds = 30
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }

$name = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).name
$stampFile = Join-Path $env:TEMP "$name-restart.stamp"
$runtimeFile = Join-Path $env:USERPROFILE ".$name\runtime.json"

# The moment the restart began, if we have it. Only trust a FRESH stamp: an old one left behind by a
# previous rebuild would make an otherwise-fine daemon look stale.
$restartedAt = $null
if (Test-Path $stampFile) {
  try {
    $parsed = [datetime]::Parse((Get-Content $stampFile -Raw).Trim())
    if (((Get-Date) - $parsed).TotalMinutes -lt 10) { $restartedAt = $parsed }
  } catch { }
}

# Identical identity rule to Restart-Daemon.ps1: JSON content-type + ok:true + exact service match.
# Returns the service name, or $null for "not one of ours".
function Get-HealthService {
  param([int]$Port)
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
  } catch { return $null }
  if (($res.Headers['Content-Type'] -join ',') -notmatch 'application/json') { return $null }
  try { $body = $res.Content | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
  if ($body.ok -ne $true -or -not $body.service) { return $null }
  return [string]$body.service
}

function Find-Daemon {
  param([string]$AppName)

  # The pointer names the port the daemon actually bound, so try it first -- it's both the fastest
  # path and the authoritative one. It is still validated by identity, never trusted on its own.
  $ports = New-Object System.Collections.Generic.List[int]
  if (Test-Path $runtimeFile) {
    try {
      $recorded = (Get-Content $runtimeFile -Raw | ConvertFrom-Json).port
      if ($recorded) { $ports.Add([int]$recorded) }
    } catch { }
  }
  foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -in @('bun', 'node')) { $ports.Add([int]$conn.LocalPort) }
  }

  foreach ($port in ($ports | Select-Object -Unique)) {
    if ((Get-HealthService -Port $port) -ne $AppName) { continue }
    $procId = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -First 1
    $proc = if ($procId) { Get-Process -Id $procId -ErrorAction SilentlyContinue } else { $null }
    if (-not $proc) { continue }
    return [pscustomobject]@{ Port = $port; Pid = $proc.Id; Started = $proc.StartTime }
  }
  return $null
}

# do/while so a 0-second timeout still probes once.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  $found = Find-Daemon -AppName $name
  if ($found) { break }
  Start-Sleep -Milliseconds 700
} while ((Get-Date) -lt $deadline)

if (-not $found) {
  Write-Host ""
  Write-Host "  ! No daemon identifying as '$name' came back within $TimeoutSeconds seconds." -ForegroundColor Red
  Write-Host "    Launch the app from its shortcut / tray, then reload the page."
  exit 1
}

$age = (Get-Date) - $found.Started

# The freshness proof. Allow a couple of seconds of slack for clock/handoff jitter.
if ($restartedAt -and $found.Started -lt $restartedAt.AddSeconds(-2)) {
  Write-Host ""
  Write-Host "  ! STALE DAEMON: '$name' answers on port $($found.Port) (pid $($found.Pid))," -ForegroundColor Red
  Write-Host ("    but that process started {0:hh\:mm\:ss} ago, BEFORE this rebuild restarted it." -f $age) -ForegroundColor Red
  Write-Host "    You are still being served the OLD code." -ForegroundColor Red
  Write-Host "    Try:  powershell -ExecutionPolicy Bypass -File misc\Restart-Daemon.ps1" -ForegroundColor Yellow
  Remove-Item $stampFile -Force -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item $stampFile -Force -ErrorAction SilentlyContinue

# --- Stability hold --------------------------------------------------------------------------------
# The daemon must keep answering -- as the SAME process -- for $StabilitySeconds before the rebuild
# is called good. A pid change mid-hold is a failure even though something is serving: the daemon we
# just blessed died and a second supervisor replaced it, which is exactly the fighting-supervisors
# class (two tray hosts, a watchdog race, a console teardown) this hold exists to expose.
if ($StabilitySeconds -gt 0) {
  $holdStart = Get-Date
  $misses = 0
  while (((Get-Date) - $holdStart).TotalSeconds -lt $StabilitySeconds) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $found.Pid -ErrorAction SilentlyContinue)) {
      $lived = [int]((Get-Date) - $found.Started).TotalSeconds
      Write-Host ""
      Write-Host "  ! UNSTABLE: '$name' (pid $($found.Pid), port $($found.Port)) DIED about $lived seconds after boot," -ForegroundColor Red
      Write-Host "    during the $StabilitySeconds-second stability hold. Something killed it AFTER it came up:" -ForegroundColor Red
      Write-Host "    the classic causes are a second supervisor (an old tray host's watchdog fighting the" -ForegroundColor Red
      Write-Host "    relaunch) or the console that launched it being closed. Check ~\.$name\logs\daemon.log," -ForegroundColor Red
      Write-Host "    look for a stray lunarwerx-tray.exe naming this app's *-Tray.json, or a powershell running" -ForegroundColor Red
      Write-Host "    '*-Tray.ps1', then re-run misc\Restart-Daemon.ps1." -ForegroundColor Red
      exit 1
    }
    # Tolerate a transient flake (a busy box can miss one 2s probe); three consecutive misses
    # (~6s unresponsive) while the process is still alive means it has hung -- fail loudly.
    if ((Get-HealthService -Port $found.Port) -ne $name) {
      $misses++
      if ($misses -ge 3) {
        Write-Host ""
        Write-Host "  ! UNSTABLE: '$name' (pid $($found.Pid)) is still alive but stopped answering /api/health" -ForegroundColor Red
        Write-Host "    on port $($found.Port) during the stability hold -- it has hung." -ForegroundColor Red
        Write-Host "    Re-run:  powershell -ExecutionPolicy Bypass -File misc\Restart-Daemon.ps1" -ForegroundColor Yellow
        exit 1
      }
    } else {
      $misses = 0
    }
  }
}

$age = (Get-Date) - $found.Started
$held = if ($StabilitySeconds -gt 0) { ", held stable for ${StabilitySeconds}s" } else { "" }
if ($restartedAt) {
  Write-Host ("  OK: '{0}' is live on port {1} (pid {2}), started {3:N0}s ago{4} - it IS the fresh build." -f $name, $found.Port, $found.Pid, $age.TotalSeconds, $held)
} else {
  Write-Host ("  '{0}' is live on port {1} (pid {2}), up for {3:hh\:mm\:ss}{4}. (No restart stamp, so freshness was not asserted.)" -f $name, $found.Port, $found.Pid, $age, $held)
}
exit 0
