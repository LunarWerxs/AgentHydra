# Opens Hydra Desk 2 as its own app window, starting the server first when it is not already up.
#
#   1. GET http://127.0.0.1:7798/api/health. Answers = the server is up, skip to 4.
#   2. Otherwise start `bun server/src/index.ts` from the desk folder, hidden and through WMI (outside the
#      caller's process tree and job, so it outlives the shell or worker that ran this), stdout and stderr
#      appended to ~/.hydra-desk-2/logs/server.log, its pids in ~/.hydra-desk-2/server.pid (stop.ps1 reads it).
#      A server this launcher started that is still booting is waited on, never started twice.
#   3. Wait for health up to 20 s; if it never answers, show a message box naming the log and exit 1.
#   4. Run launcher/HydraDesk2.exe (the native WebView2 host). It opens hidden at the place saved in
#      ~/.hydra-desk-2/window.json, then shows; a second run only focuses the open window. On the host's
#      first run (no %LOCALAPPDATA%\HydraDesk2\webview yet) the old Edge app window is asked to close
#      first, so the host can copy its localStorage over.
#
# Safe to run twice: a named mutex serialises launches, and a second run only focuses the window.
# The shortcut runs this through launcher/start.vbs so no console window ever flashes.
#
#   -DryRun    print what it would do and exit 0, with no side effects
#   -NoDialog  report a failure on stderr instead of a message box (tests)
#   -NoWindow  start the server only (restart.ps1: the open window reconnects by itself)
#   -Port      server port (default $env:HYDRA_DESK_PORT, else 7798)
param(
  [switch]$DryRun,
  [switch]$NoDialog,
  [switch]$NoWindow,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

$DeskRoot = Split-Path -Parent $PSScriptRoot
if ($Port -le 0) { $Port = if ($env:HYDRA_DESK_PORT) { [int]$env:HYDRA_DESK_PORT } else { 7798 } }
$Url = "http://127.0.0.1:$Port"
$HealthUrl = "$Url/api/health"
$DeskHome = if ($env:HYDRA_DESK_HOME) { $env:HYDRA_DESK_HOME } else { Join-Path $HOME '.hydra-desk-2' }
$LogDir = Join-Path $DeskHome 'logs'
$ServerLog = Join-Path $LogDir 'server.log'
$LauncherLog = Join-Path $LogDir 'launcher.log'
$PidFile = Join-Path $DeskHome 'server.pid'
$WindowProfile = Join-Path $env:LOCALAPPDATA 'HydraDesk2\window'  # the old Edge app profile (hand-over only)
$WebViewData = Join-Path $env:LOCALAPPDATA 'HydraDesk2\webview'
$HealthTimeoutSec = 20

function Say([string]$msg) {
  if ($DryRun) { Write-Output "[dry-run] $msg"; return }
  # Write-Host, not the pipeline: Say inside a function must not leak into its return value.
  Write-Host $msg
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    Add-Content -Path $LauncherLog -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
  } catch { }
}

function Fail([string]$msg) {
  Say "ERROR: $msg"
  if ($NoDialog -or $DryRun) { [Console]::Error.WriteLine($msg) }
  else {
    # 16 = stop icon. WScript.Shell's Popup needs no WinForms load and shows on the hidden launcher.
    (New-Object -ComObject WScript.Shell).Popup($msg, 0, 'Hydra Desk 2', 16) | Out-Null
  }
  exit 1
}

function Test-Health {
  try {
    $req = [System.Net.WebRequest]::Create($HealthUrl)
    $req.Timeout = 1000
    $req.Proxy = $null  # no proxy autodetect: it costs seconds on a loopback call
    $res = $req.GetResponse()
    try { return ([int]$res.StatusCode -eq 200) } finally { $res.Close() }
  } catch { return $false }
}

# The pid file stays valid only while the recorded process is the same one (pid AND start time),
# so a recycled pid never looks like our server.
function Get-LauncherServer {
  if (-not (Test-Path $PidFile)) { return $null }
  try { $info = Get-Content -Raw -Path $PidFile | ConvertFrom-Json } catch { return $null }
  foreach ($key in 'serverPid', 'wrapperPid') {
    $id = [int]$info.$key
    if ($id -le 0) { continue }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq $info.($key -replace 'Pid$', 'Started')) { return $info }
  }
  return $null
}

# The old Edge/Chrome app window (our profile, not its --type= helpers), if one is running.
function Find-OldWindowProcess {
  $needle = $WindowProfile.ToLowerInvariant()
  foreach ($exe in 'msedge.exe', 'chrome.exe') {
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='$exe'" -ErrorAction SilentlyContinue)) {
      $cmd = [string]$p.CommandLine
      if ($cmd -and $cmd.ToLowerInvariant().Contains($needle) -and $cmd -notmatch '--type=') { return [int]$p.ProcessId }
    }
  }
  return $null
}

# Hand-over at the host's first launch: ask the old window to close (up to 5 s) so its localStorage can be copied.
function Close-OldWindow {
  $id = Find-OldWindowProcess
  if (-not $id) { return }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p) {
    [void]$p.CloseMainWindow()
    [void]$p.WaitForExit(5000)
    Say "asked the old Edge app window (pid $id) to close before the first host run"
  }
}

# The bun that cmd.exe can run: bun.exe, else a .cmd/.bat shim. An npm-installed bun puts bun.ps1 first
# on PATH, and `Get-Command bun` returned it; cmd /c cannot run a .ps1, so the server never started
# (2026-10-04: AppData\Roaming\npm\bun.ps1 ahead of bun.cmd on the second PC).
function Find-Bun {
  $exe = Get-Command bun.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($exe) { return $exe }
  return Get-Command bun -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.exe', '.cmd', '.bat' } | Select-Object -First 1
}

function Start-Server {
  $bun = Find-Bun
  if (-not $bun) { Fail "Hydra Desk 2 could not start: bun is not on PATH.`n`nInstall it from https://bun.sh and try again." }
  $entry = Join-Path $DeskRoot 'server\src\index.ts'
  if (-not (Test-Path $entry)) { Fail "Hydra Desk 2 could not start: $entry is missing." }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Add-Content -Path $ServerLog -Value ("`r`n==== {0} start.ps1: bun server/src/index.ts on port {1} ====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Port) -Encoding UTF8

  # cmd /c only to send stdout AND stderr to the one log file. The window is hidden, and bun inherits that
  # hidden console. WMI (Win32_Process.Create) starts it, so it is born outside this launcher's process tree
  # and job: 2026-10-05, a server a CliMayte worker restarted from its shell sat in the worker's kill-on-close
  # job and died the moment the worker finished, leaving the window on "No messages yet" and "Failed to fetch".
  # A WMI-started process has the user's own environment, not this script's, so port and home go on the
  # command line. Start-Process (which stays in the caller's job) only when WMI refuses.
  $env:HYDRA_DESK_PORT = "$Port"
  $envSet = "set `"HYDRA_DESK_PORT=$Port`""
  if ($env:HYDRA_DESK_HOME) { $envSet += " && set `"HYDRA_DESK_HOME=$($env:HYDRA_DESK_HOME)`"" }
  $cmdLine = "/d /c `"$envSet && `"$($bun.Source)`" server\src\index.ts >> `"$ServerLog`" 2>&1`""
  $wrapper = $null
  $wrapperPid = 0
  try {
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [UInt16]0 }
    $made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = "`"$env:ComSpec`" $cmdLine"; CurrentDirectory = $DeskRoot; ProcessStartupInformation = $startup
    }
    if ($made.ReturnValue -eq 0) {
      $wrapperPid = [int]$made.ProcessId
      $wrapper = Get-Process -Id $wrapperPid -ErrorAction SilentlyContinue
    }
  } catch { }
  if (-not $wrapperPid) {
    Say 'WMI did not start the server: starting it with Start-Process, so it ends with this launcher''s job, if it has one'
    $wrapper = Start-Process -FilePath "$env:ComSpec" -ArgumentList $cmdLine -WorkingDirectory $DeskRoot -WindowStyle Hidden -PassThru
    $wrapperPid = $wrapper.Id
  }

  # Record bun itself too, so stop.ps1 can kill the right tree even after the wrapper is gone.
  $server = $null
  for ($i = 0; $i -lt 30 -and -not $server; $i++) {
    $server = Get-CimInstance Win32_Process -Filter "ParentProcessId=$wrapperPid" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'bun*' } | Select-Object -First 1
    if (-not $server) { Start-Sleep -Milliseconds 100 }
  }
  $info = [ordered]@{
    wrapperPid = $wrapperPid
    wrapperStarted = if ($wrapper) { $wrapper.StartTime.ToUniversalTime().ToString('o') } else { '' }
    serverPid = 0
    serverStarted = ''
    port = $Port
    deskRoot = $DeskRoot
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  if ($server) {
    $sp = Get-Process -Id ([int]$server.ProcessId) -ErrorAction SilentlyContinue
    if ($sp) {
      $info.serverPid = $sp.Id
      $info.serverStarted = $sp.StartTime.ToUniversalTime().ToString('o')
    }
  }
  $info | ConvertTo-Json | Set-Content -Path $PidFile -Encoding UTF8
  Say "started server: wrapper pid $($info.wrapperPid), bun pid $($info.serverPid), log $ServerLog"
  return $wrapper
}

function Wait-Health($wrapper) {
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health) { return $true }
    if ($wrapper -and $wrapper.HasExited) { return $false }  # it died; no point waiting out the clock
    Start-Sleep -Milliseconds 250
  }
  return (Test-Health)
}

# ---------------------------------------------------------------------------------------------

$HostExe = Join-Path $PSScriptRoot 'HydraDesk2.exe'
$FirstRun = -not (Test-Path $WebViewData)

if ($DryRun) {
  $up = Test-Health
  Say "desk folder: $DeskRoot"
  Say "health $HealthUrl -> $(if ($up) { 'answers' } else { 'no answer' })"
  if ($up) { Say 'server already up: would not start another' }
  elseif (Get-LauncherServer) { Say "a server this launcher started is still booting (pid file $PidFile): would wait for it, not start another" }
  else {
    $bun = Find-Bun
    Say "would start hidden through WMI (outside this shell's job): $(if ($bun) { $bun.Source } else { 'bun (NOT ON PATH: would fail)' }) server\src\index.ts (cwd $DeskRoot, HYDRA_DESK_PORT=$Port)"
    Say "would append stdout+stderr to $ServerLog and write pids to $PidFile"
    Say "would wait up to $HealthTimeoutSec s for health, else show an error box"
  }
  if (-not (Test-Path (Join-Path $DeskRoot 'web\dist\index.html'))) { Say 'note: web\dist is not built yet (bun run build); the window would be empty' }
  if ($NoWindow) { Say 'would not open or focus a window (-NoWindow)' }
  elseif (-not (Test-Path -LiteralPath $HostExe)) { Say "$HostExe is missing: would fail with an error box" }
  else {
    Say "would run $HostExe (opens hidden at the placement saved in $(Join-Path $DeskHome 'window.json'), then shows; a second run focuses the open window)"
    if ($FirstRun) { Say "first host run ($WebViewData does not exist): would ask the old Edge app window to close, and the host would copy its localStorage" }
    & $HostExe --url $Url --dry-run 2>&1 | ForEach-Object { Say "  $_" }
  }
  exit 0
}

# Serialise launches: two double-clicks in a row must not race into two servers.
$mutex = New-Object System.Threading.Mutex($false, 'Local\HydraDesk2Launcher')
try {
  try { [void]$mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { }

  if (Test-Health) {
    Say "server already answers on $Url"
  } else {
    $wrapper = $null
    $mine = Get-LauncherServer
    if ($mine) {
      Say "server started earlier (wrapper pid $($mine.wrapperPid)) is not answering yet: waiting for it"
      $wrapper = Get-Process -Id ([int]$mine.wrapperPid) -ErrorAction SilentlyContinue
    } else {
      $wrapper = Start-Server
    }
    if (-not (Wait-Health $wrapper)) {
      $tail = ''
      if (Test-Path $ServerLog) { $tail = (Get-Content -Path $ServerLog -Tail 8 -ErrorAction SilentlyContinue) -join "`n" }
      $why = if ($wrapper -and $wrapper.HasExited) { 'stopped before it answered' } else { "did not answer within $HealthTimeoutSec seconds" }
      Fail ("Hydra Desk 2's server $why on $HealthUrl.`n`n" +
        "Log: $ServerLog`n`nLast lines:`n$tail")
    }
    Say "server healthy on $Url"
  }

  if (-not (Test-Path (Join-Path $DeskRoot 'web\dist\index.html'))) {
    Say 'warning: web\dist is not built; run `bun run build` in the desk folder'
  }
  if ($NoWindow) { return }

  if (-not (Test-Path -LiteralPath $HostExe)) { Fail "Hydra Desk 2's window host is missing: $HostExe`n`nBuild it in launcher\host (cargo build --release) and copy it here." }
  if ($FirstRun) { Close-OldWindow }
  Start-Process -FilePath $HostExe -ArgumentList @("--url", $Url) -WorkingDirectory $PSScriptRoot | Out-Null
  Say "ran $HostExe on $Url$(if ($FirstRun) { ' (first run)' })"
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
exit 0
