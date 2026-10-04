# Opens Hydra Desk as its own app window, starting the server first when it is not already up.
#
#   1. GET http://127.0.0.1:7795/api/health. Answers = the server is up, skip to 4.
#   2. Otherwise start `bun server/src/index.ts` from the desk folder, hidden, stdout and stderr
#      appended to ~/.hydra-desk/logs/server.log, its pids in ~/.hydra-desk/server.pid (stop.ps1 reads it).
#      A server this launcher started that is still booting is waited on, never started twice.
#   3. Wait for health up to 20 s; if it never answers, show a message box naming the log and exit 1.
#   4. Focus the existing Hydra Desk window, or open Microsoft Edge in app mode (Chrome when Edge is
#      missing) with its own profile in %LOCALAPPDATA%\HydraDesk\window, 1500x950 on first run.
#
# Safe to run twice: a named mutex serialises launches, and a second run only focuses the window.
# The shortcut runs this through launcher/start.vbs so no console window ever flashes.
#
#   -DryRun    print what it would do and exit 0, with no side effects
#   -NoDialog  report a failure on stderr instead of a message box (tests)
#   -NoWindow  start the server only (restart.ps1: the open window reconnects by itself)
#   -Port      server port (default $env:HYDRA_DESK_PORT, else 7795)
param(
  [switch]$DryRun,
  [switch]$NoDialog,
  [switch]$NoWindow,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

$DeskRoot = Split-Path -Parent $PSScriptRoot
if ($Port -le 0) { $Port = if ($env:HYDRA_DESK_PORT) { [int]$env:HYDRA_DESK_PORT } else { 7795 } }
$Url = "http://127.0.0.1:$Port"
$HealthUrl = "$Url/api/health"
$DeskHome = if ($env:HYDRA_DESK_HOME) { $env:HYDRA_DESK_HOME } else { Join-Path $HOME '.hydra-desk' }
$LogDir = Join-Path $DeskHome 'logs'
$ServerLog = Join-Path $LogDir 'server.log'
$LauncherLog = Join-Path $LogDir 'launcher.log'
$PidFile = Join-Path $DeskHome 'server.pid'
$WindowProfile = Join-Path $env:LOCALAPPDATA 'HydraDesk\window'
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
    (New-Object -ComObject WScript.Shell).Popup($msg, 0, 'Hydra Desk', 16) | Out-Null
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

function Find-Browser {
  $candidates = @(
    @{ Name = 'Microsoft Edge'; Exe = 'msedge.exe'; Paths = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe") },
    @{ Name = 'Google Chrome'; Exe = 'chrome.exe'; Paths = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") }
  )
  foreach ($c in $candidates) {
    $paths = @()
    foreach ($hive in 'HKCU', 'HKLM') {
      try {
        $v = (Get-ItemProperty -Path "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($c.Exe)" -ErrorAction Stop).'(default)'
        if ($v) { $paths += $v.Trim('"') }
      } catch { }
    }
    foreach ($p in ($paths + $c.Paths)) {
      if ($p -and (Test-Path -LiteralPath $p)) { return @{ Name = $c.Name; Path = $p; Exe = $c.Exe } }
    }
  }
  return $null
}

# The browser process that owns our profile (not its --type= helpers), if one is running.
function Find-WindowProcess([string]$exe) {
  $needle = $WindowProfile.ToLowerInvariant()
  $procs = Get-CimInstance Win32_Process -Filter "Name='$exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $cmd = [string]$p.CommandLine
    if ($cmd -and $cmd.ToLowerInvariant().Contains($needle) -and $cmd -notmatch '--type=') { return [int]$p.ProcessId }
  }
  return $null
}

function Focus-Window([int]$browserPid) {
  $p = Get-Process -Id $browserPid -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq [IntPtr]::Zero) { return $false }
  Add-Type -Namespace HydraDesk -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@
  $h = $p.MainWindowHandle
  if ([HydraDesk.Win32]::IsIconic($h)) { [HydraDesk.Win32]::ShowWindow($h, 9) | Out-Null }  # 9 = SW_RESTORE
  [HydraDesk.Win32]::SetForegroundWindow($h) | Out-Null
  return $true
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
  if (-not $bun) { Fail "Hydra Desk could not start: bun is not on PATH.`n`nInstall it from https://bun.sh and try again." }
  $entry = Join-Path $DeskRoot 'server\src\index.ts'
  if (-not (Test-Path $entry)) { Fail "Hydra Desk could not start: $entry is missing." }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Add-Content -Path $ServerLog -Value ("`r`n==== {0} start.ps1: bun server/src/index.ts on port {1} ====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Port) -Encoding UTF8

  # cmd /c only to send stdout AND stderr to the one log file; Start-Process cannot point both at
  # the same file. The window is hidden, and bun inherits that hidden console.
  $env:HYDRA_DESK_PORT = "$Port"
  $cmdLine = "/d /c `"`"$($bun.Source)`" server\src\index.ts >> `"$ServerLog`" 2>&1`""
  $wrapper = Start-Process -FilePath "$env:ComSpec" -ArgumentList $cmdLine -WorkingDirectory $DeskRoot -WindowStyle Hidden -PassThru

  # Record bun itself too, so stop.ps1 can kill the right tree even after the wrapper is gone.
  $server = $null
  for ($i = 0; $i -lt 30 -and -not $server; $i++) {
    $server = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($wrapper.Id)" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'bun*' } | Select-Object -First 1
    if (-not $server) { Start-Sleep -Milliseconds 100 }
  }
  $info = [ordered]@{
    wrapperPid = $wrapper.Id
    wrapperStarted = $wrapper.StartTime.ToUniversalTime().ToString('o')
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

$browser = Find-Browser
$firstRun = -not (Test-Path $WindowProfile)
$browserArgs = @("--app=$Url", "--user-data-dir=`"$WindowProfile`"", '--no-first-run', '--no-default-browser-check')
if ($firstRun) { $browserArgs += '--window-size=1500,950' }

if ($DryRun) {
  $up = Test-Health
  Say "desk folder: $DeskRoot"
  Say "health $HealthUrl -> $(if ($up) { 'answers' } else { 'no answer' })"
  if ($up) { Say 'server already up: would not start another' }
  elseif (Get-LauncherServer) { Say "a server this launcher started is still booting (pid file $PidFile): would wait for it, not start another" }
  else {
    $bun = Find-Bun
    Say "would start hidden: $(if ($bun) { $bun.Source } else { 'bun (NOT ON PATH: would fail)' }) server\src\index.ts (cwd $DeskRoot, HYDRA_DESK_PORT=$Port)"
    Say "would append stdout+stderr to $ServerLog and write pids to $PidFile"
    Say "would wait up to $HealthTimeoutSec s for health, else show an error box"
  }
  if (-not (Test-Path (Join-Path $DeskRoot 'web\dist\index.html'))) { Say 'note: web\dist is not built yet (bun run build); the window would be empty' }
  if ($NoWindow) { Say 'would not open or focus a window (-NoWindow)' }
  elseif (-not $browser) { Say 'no Microsoft Edge or Google Chrome found: would fail with an error box' }
  else {
    $existing = Find-WindowProcess $browser.Exe
    if ($existing) { Say "Hydra Desk window already open ($($browser.Name) pid $existing): would focus it" }
    else { Say "would open $($browser.Name): `"$($browser.Path)`" $($browserArgs -join ' ')" }
  }
  exit 0
}

# Serialise launches: two double-clicks in a row must not race into two servers.
$mutex = New-Object System.Threading.Mutex($false, 'Local\HydraDeskLauncher')
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
      Fail ("Hydra Desk's server $why on $HealthUrl.`n`n" +
        "Log: $ServerLog`n`nLast lines:`n$tail")
    }
    Say "server healthy on $Url"
  }

  if (-not (Test-Path (Join-Path $DeskRoot 'web\dist\index.html'))) {
    Say 'warning: web\dist is not built; run `bun run build` in the desk folder'
  }
  if ($NoWindow) { return }

  if (-not $browser) { Fail 'Hydra Desk needs Microsoft Edge or Google Chrome to open its window; neither was found.' }
  $existing = Find-WindowProcess $browser.Exe
  $opened = $false
  if ($existing -and (Focus-Window $existing)) {
    Say "focused the open Hydra Desk window ($($browser.Name) pid $existing)"
  } else {
    Start-Process -FilePath $browser.Path -ArgumentList $browserArgs | Out-Null
    $opened = $true
    Say "opened $($browser.Name) app window on $Url$(if ($firstRun) { ' (first run, 1500x950)' })"
  }
  # The window keeper remembers the window's place and size, and puts a window just opened back there.
  $keeperArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$(Join-Path $PSScriptRoot 'window-keeper.ps1')`"",
    '-BrowserExe', $browser.Exe, '-WindowProfile', "`"$WindowProfile`"", '-StateFile', "`"$(Join-Path $DeskHome 'window.json')`"")
  if ($opened) { $keeperArgs += '-Apply' }
  try { Start-Process -FilePath 'powershell.exe' -ArgumentList $keeperArgs -WindowStyle Hidden | Out-Null } catch { Say "window keeper did not start: $_" }
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
exit 0
