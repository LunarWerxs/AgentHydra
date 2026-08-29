# misc/Ensure-Daemon.ps1 - make sure this app's daemon is UP, and start it if it is not.
#
# WHY THIS EXISTS (owner directive, Michael, 2026-08-28): automations talk to AgentHydra over
# HTTP every wake. On 2026-08-28 the daemon and its tray host were gone (no tray icon, port 7787
# refusing), and the caller simply failed its curl and reported the outage instead of fixing
# it. "Anything that might need AgentHydra should make sure AgentHydra is running first" -
# so this is that preflight, and it is meant to be called before the first API call of a wake.
#
# THE DIFFERENCE FROM Restart-Daemon.ps1, which is the whole point:
#   Restart-Daemon.ps1 is a RESTART - it kills everything of ours older than the run, always, so a
#   rebuild can never leave you on stale code. Calling it as a preflight would murder a perfectly
#   healthy daemon (and every in-flight request) once a minute.
#   This script is an ENSURE - if a healthy daemon of OURS is answering, it does nothing at all and
#   exits 0. Only when nothing of ours answers does it delegate to Restart-Daemon.ps1 (which also
#   relaunches the tray host, detached via WMI, so the icon comes back and the app outlives this
#   console) and then to Wait-Daemon.ps1 to PROVE it came up and stayed up.
#
# IDENTITY RULE, copied deliberately from its two siblings rather than loosened: a listener is ours
# only if /api/health returns JSON with ok:true and `service` equal to this app's package.json
# name. Absence of identity is never identity - a Vite dev server answering /api/health with an
# index.html body has fooled these scripts before, in both directions.
#
# Exit codes: 0 = a healthy daemon of ours is answering (already up, or up after the restart).
#             1 = it is not, and the restart did not fix it. The caller must NOT proceed.
[CmdletBinding()]
param(
  # Seconds to wait for the daemon to answer after a restart. Wait-Daemon.ps1 does its own
  # stability hold on top of this; 90 covers a cold `bun install` / `bun run build` first run.
  [int]$TimeoutSec = 90,
  # Skip the restart and only report. For a caller that wants to decide for itself.
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$appName = 'agenthydra'
try {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.name) { $appName = $pkg.name }
} catch { }

# The port the app actually bound last time, when it recorded one; the config default otherwise.
$port = 7787
$home_ = if ($env:AGENTHYDRA_HOME) { $env:AGENTHYDRA_HOME } else { Join-Path $env:USERPROFILE '.agenthydra' }
$runtimeFile = Join-Path $home_ 'runtime.json'
if (Test-Path $runtimeFile) {
  try {
    $rt = Get-Content $runtimeFile -Raw | ConvertFrom-Json
    if ($rt.port) { $port = [int]$rt.port }
  } catch { }
}

function Test-OurDaemon {
  param([int]$Port, [string]$AppName)
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -TimeoutSec 4 -UseBasicParsing -ErrorAction Stop
  } catch { return $null }
  if ($r.Headers['Content-Type'] -notmatch 'application/json') { return $null }   # HTML is never identity
  try { $b = $r.Content | ConvertFrom-Json } catch { return $null }
  if (-not $b.ok) { return $null }
  if ($b.service -ne $AppName) { return $null }                                   # a stranger, not us
  return $b
}

$health = Test-OurDaemon -Port $port -AppName $appName
if ($health) {
  Write-Host "  UP: '$appName' is already answering on port $port (version $($health.version))."
  exit 0
}

if ($CheckOnly) {
  Write-Host "  DOWN: nothing of '$appName' is answering on port $port."
  exit 1
}

Write-Host "  DOWN: nothing of '$appName' is answering on port $port - starting it."
& (Join-Path $here 'Restart-Daemon.ps1')
& (Join-Path $here 'Wait-Daemon.ps1') -TimeoutSeconds $TimeoutSec

$health = Test-OurDaemon -Port $port -AppName $appName
if ($health) {
  Write-Host "  RECOVERED: '$appName' is live on port $port (version $($health.version))."
  exit 0
}
Write-Host "  FAILED: '$appName' did not come up on port $port. Do not proceed against the API."
exit 1
