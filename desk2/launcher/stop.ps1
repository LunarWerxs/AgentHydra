# Stops the AgentHydra server that launcher/start.ps1 started. Chats keep running (SPEC "Chat hosts"): a chat
# AgentHydra runs itself is in its own host process, outside the server's tree, and a CliMayte worker chat runs
# in AgentHydra; the next server takes them over.
#
#   1. POST /api/server/shutdown: the server writes its state and lets go of the chats, then exits.
#   2. Whatever is still running after 15 s goes the hard way: taskkill /T on the pids start.ps1 wrote to
#      ~/.hydra-desk-2/server.pid, each only while the process still has the start time the pid file
#      recorded (a recycled pid is never touched; bun processes at large never are).
#
#   -Chats   end the chats too: the server closes them first; one it cannot reach is ended by the pid in
#            its host file (~/.hydra-desk-2/hosts/<chat>.json), only while that pid is still a bun process
#            started no later than the host says it started
#   -DryRun  print what it would stop and exit 0
param([switch]$Chats, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
$DeskHome = if ($env:HYDRA_DESK_HOME) { $env:HYDRA_DESK_HOME } else { Join-Path $HOME '.hydra-desk-2' }
$PidFile = Join-Path $DeskHome 'server.pid'
$HostsDir = Join-Path $DeskHome 'hosts'
$GraceSec = 15

$info = $null
if (Test-Path $PidFile) { try { $info = Get-Content -Raw -Path $PidFile | ConvertFrom-Json } catch { } }
$Port = if ($info -and [int]$info.port -gt 0) { [int]$info.port } elseif ($env:HYDRA_DESK_PORT) { [int]$env:HYDRA_DESK_PORT } else { 7798 }

$targets = @()
if ($info) {
  foreach ($key in 'serverPid', 'wrapperPid') {
    $id = [int]$info.$key
    if ($id -le 0) { continue }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    $recorded = $info.($key -replace 'Pid$', 'Started')
    if (-not $p) { Write-Output "$key $id is not running"; continue }
    if ($p.StartTime.ToUniversalTime().ToString('o') -ne $recorded) {
      Write-Output "$key $id is a different process now ($($p.ProcessName)); leaving it alone"
      continue
    }
    $targets += $p
  }
}

# The chat hosts still running: a host file whose pid is a bun process that was already running when the host
# wrote its start time (a recycled pid started later).
function Get-ChatHosts {
  $out = @()
  if (-not (Test-Path $HostsDir)) { return $out }
  foreach ($f in Get-ChildItem -Path $HostsDir -Filter '*.json' -File) {
    if ($f.Name -like '*.spec.json') { continue }
    try { $h = Get-Content -Raw -Path $f.FullName | ConvertFrom-Json } catch { continue }
    $p = Get-Process -Id ([int]$h.pid) -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -notlike 'bun*') { continue }
    $hostStarted = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$h.startedAt).UtcDateTime
    if ($p.StartTime.ToUniversalTime() -gt $hostStarted.AddSeconds(1)) { continue }
    $out += [pscustomobject]@{ Chat = [string]$h.chatId; Process = $p }
  }
  return $out
}

function Ask-Shutdown {
  try {
    $body = if ($Chats) { '{"chats":true}' } else { '{}' }
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/server/shutdown" -ContentType 'application/json' -Body $body -TimeoutSec 60 | Out-Null
    return $true
  } catch { return $false }
}

if ($DryRun) {
  Write-Output "[dry-run] would ask http://127.0.0.1:$Port/api/server/shutdown to stop$(if ($Chats) { ', ending the chats' } else { ', the chats running on' })"
  foreach ($p in $targets) { Write-Output "[dry-run] then, if still running after $GraceSec s, would stop $($p.ProcessName) pid $($p.Id) and its children" }
  $hosts = @(Get-ChatHosts)
  if ($Chats) { foreach ($h in $hosts) { Write-Output "[dry-run] would end chat $($h.Chat) (host pid $($h.Process.Id)) if the server does not" } }
  elseif ($hosts) { Write-Output "[dry-run] $($hosts.Count) chat(s) keep running in their hosts" }
  if (-not $targets -and $info) { Write-Output "[dry-run] would remove the stale pid file $PidFile" }
  exit 0
}

if (Ask-Shutdown) {
  Write-Output "asked the server on port $Port to stop$(if ($Chats) { ' and end the chats' })"
  $deadline = (Get-Date).AddSeconds($GraceSec)
  while ((Get-Date) -lt $deadline -and ($targets | Where-Object { -not $_.HasExited })) { Start-Sleep -Milliseconds 200 }
} else {
  Write-Output "the server on port $Port did not answer: stopping it by its pids"
}

foreach ($p in $targets) {
  if ($p.HasExited) { Write-Output "$($p.ProcessName) pid $($p.Id) stopped"; continue }
  & taskkill.exe /PID $p.Id /T /F 2>&1 | ForEach-Object { Write-Output "  $_" }
  try { $p.WaitForExit(5000) | Out-Null } catch { }
  Write-Output "stopped $($p.ProcessName) pid $($p.Id)"
}

$left = @(Get-ChatHosts)
if ($Chats) {
  foreach ($h in $left) {
    & taskkill.exe /PID $h.Process.Id /T /F 2>&1 | ForEach-Object { Write-Output "  $_" }
    Write-Output "ended chat $($h.Chat) (host pid $($h.Process.Id))"
  }
} elseif ($left) {
  Write-Output "$($left.Count) chat(s) keep running in their hosts; the next server takes them over"
}

if (Test-Path $PidFile) {
  Remove-Item -Path $PidFile -Force
  Write-Output "removed $PidFile"
}
exit 0
