# misc/Restart-Daemon.ps1 — kill this app's daemon AND its tray host, no exceptions, then relaunch.
#
# CONTRACT (owner directive, 2026-07-15): a rebuild must NEVER leave you on old code.
# If something of OURS is running, it dies. There is no "left alone", no advisory note,
# no polite skip. The ONLY thing this script won't kill is a process that isn't ours --
# and "is it ours" is now a question with a hard answer instead of a guess.
#
# WHY THE OLD VERSION FAILED (2026-07-15):
# It probed every bun/node listener's /api/health and treated a body with no `service`
# field as "unidentified -> leave it alone". Three Connections Vite DEV SERVERS (ports
# 4180/4204/4273) answer /api/health with 200 OK and an index.html body, because Vite
# serves the SPA fallback for every unknown path. They therefore looked exactly like "a
# daemon that won't say who it is", and the script printed a note asking us to add a
# `service` field to an app (redesign) that has had one all along.
#
# Wait-Daemon.ps1 had the mirror-image bug, and it was the worse of the two: it ACCEPTED
# an unidentified responder as this app (`if (-not $svc -or $svc -eq $AppName)`), latched
# onto one of those Vite servers, read that stranger's start time, and announced
# "STALE DAEMON: you are still being served the OLD code" -- about a daemon that had in
# fact just restarted perfectly. A false alarm isn't harmless: it sends you hunting a bug
# that doesn't exist, and it teaches you to ignore the alarm on the day it's real.
#
# THE IDENTITY RULE (fixes both directions):
# A listener is OURS only if /api/health returns Content-Type `application/json` AND a
# body with `ok: true` AND `service` equal to this app's package.json `name`. Absence of
# identity is never identity; HTML is never identity. That one rule makes the sweep both
# ruthless (anything that IS us dies, including an orphan the pointer forgot) and safe (a
# Vite dev server, a sibling app, or any unrelated node process can never match).
#
# WHY THE OLD TRAY HOST DIES TOO (2026-07-15, the zero-instance incident):
# This script used to kill only the daemon and then fire the app shortcut. But taskkill /T
# kills a tree DOWNWARD from the daemon -- never its PARENT, the hidden powershell running
# "<App>-Tray.ps1". That old tray host survived, its ~5s watchdog revived a daemon of its
# own, and the shortcut launch raced it with a SECOND tray host. The loser of that mutex
# race blocks forever on an "already starting" MessageBox nobody will ever dismiss (a
# zombie whose open handle also keeps the named mutex alive, poisoning every later launch
# into the loser path). Observed end state: within ~90 seconds the daemon, BOTH tray
# hosts, and everything else were gone -- zero instances, nothing left to revive anything.
# So tray hosts are first-class kill targets now, found by the app's unique "<App>-Tray.ps1"
# adapter filename in powershell/pwsh command lines, and they die in the same sweep BEFORE
# the daemons so no watchdog can fight the restart. Tree-killing a tray host usually reaps
# its cmd->bun daemon in the same stroke; the identity sweep still catches adopted strays,
# orphans, and headless daemons.
#
# WHY THE NATIVE HOST IS A KILL TARGET TOO (2026-09-26, AgentHydra down until fixed by hand):
# Every app's shortcut now runs the NATIVE host, `misc\lunarwerx-tray.exe <App>-Tray.json`, not a
# powershell. This script still looked only for powershell running "<App>-Tray.ps1", so it saw no
# tray host, left the native one alive, and relaunched Tray-Launch.vbs. That PowerShell host lost
# the app's tray mutex to the native one and quit, and the surviving native host never revived the
# daemon we had killed: every AgentHydra MCP tool stayed down until someone replaced the native
# host by hand. The native host is matched by the config filename on its command line. Every kit
# app runs the SAME lunarwerx-tray.exe, so matching the binary name alone would kill a sibling
# app's tray (tray-bootstrap.mjs hit exactly that on 2026-09-11). The relaunch starts the native
# host whenever the app ships one, and falls back to Tray-Launch.vbs only when it does not.
#
# WHY THE RELAUNCH GOES THROUGH WMI:
# Start-Process parents the new tray host under THIS console's process tree, so closing the
# terminal (or the tool/job that ran the rebuild) can tear the whole app down minutes later
# -- silent, nothing in the daemon log, exactly the hard-kill signature of the incident's
# endgame. Win32_Process.Create parents it to WmiPrvSE instead, outside this tree and job
# (the same isolation trick agenthydra uses to keep dispatch supervisors alive across a
# daemon restart), so the app outlives whatever ran this script.
#
# WHY WE ONLY KILL PROCESSES OLDER THAN THIS RUN:
# Kill targets are restricted to processes that started BEFORE this script did. A daemon or
# tray host younger than our start stamp is the fresh build arriving -- our own relaunch
# below, or a dying watchdog getting one last spawn in -- not a survivor. Sparing it is
# also what makes the verify loop terminate instead of fighting a fresh replacement
# forever. Wait-Daemon.ps1 reads the same stamp to prove the daemon that ends up answering
# is younger than the restart, i.e. that it really is a new process.
#
# App-agnostic on purpose: everything derives from package.json `name`, the sibling "*-Tray.ps1"
# adapter and the sibling "*-Tray.json" native config, so the same file works in agenthydra /
# redesign / repoyeti / devwebui. Keep the four copies identical.

[CmdletBinding()]
param(
  # Repo root. Defaults to the parent of misc/, i.e. the app root. Resolved in the body, NOT
  # here: under Windows PowerShell 5.1 a [CmdletBinding()] script evaluates param defaults
  # BEFORE $PSScriptRoot is populated, so a default of (Split-Path $PSScriptRoot) dies with
  # "empty string" the moment the script starts. (pwsh 7 populates it either way.)
  [string]$Root = '',
  # Stop the daemon but don't relaunch the app afterwards.
  [switch]$NoLaunch,
  # DEPLOY WITHOUT TOUCHING THE APP (owner directive, Michael, 2026-08-29: "You also keep
  # launching agent Hydra when it's open. Probably should have a check to stop doing that.").
  #
  # The full restart is deliberately ruthless because a rebuild must never leave you on old
  # code - but it kills the TRAY HOST too and relaunches it, which is what puts the app back on
  # screen. For the common case (ship code, adopt it now, app already running and fine) that is
  # collateral damage: the tray host's own ~5s watchdog revives a killed daemon by itself, so
  # killing ONLY the daemon swaps the code and leaves every window exactly where it was.
  #
  # Falls back to the full path when no healthy tray host exists to do the reviving - otherwise
  # this would stop the daemon and leave nothing to bring it back, which is the one outcome
  # worse than a reopened window.
  [switch]$DaemonOnly,
  # How long to keep killing before admitting defeat.
  [int]$KillTimeoutSeconds = 15,
  # -DaemonOnly with a live tray host: how long its watchdog gets to bring the new daemon up. Both
  # hosts revive after three missed 5s probes plus a 20s grace after their own last revive, so a
  # working one is back well inside this. A tray host that misses it has stopped supervising and is
  # replaced (2026-09-26: a live native host sat on a dead AgentHydra daemon and never revived it).
  [int]$ReviveTimeoutSeconds = 40
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }

$pkgPath = Join-Path $Root 'package.json'
if (-not (Test-Path $pkgPath)) {
  Write-Host "  ! No package.json at $Root - cannot identify the app." -ForegroundColor Red
  exit 1
}
$name = (Get-Content $pkgPath -Raw | ConvertFrom-Json).name
$runtimeFile = Join-Path $env:USERPROFILE ".$name\runtime.json"

# Everything alive before this instant is a kill target; anything that appears after it is
# the replacement. Wait-Daemon.ps1 reads the same stamp to prove the daemon now answering
# is younger than the restart, i.e. that it really is a new process.
$restartStart = Get-Date
Set-Content -Path (Join-Path $env:TEMP "$name-restart.stamp") -Value $restartStart.ToString('o') -Encoding ASCII

# --- Identity ------------------------------------------------------------------------------------
# The single source of truth for "is this us". Deliberately strict: a JSON content-type, ok:true,
# and an exact service match. Anything less returns $null and is treated as somebody else's port.
function Get-HealthService {
  param([int]$Port)
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
  } catch { return $null }
  # Vite's SPA fallback answers 200 text/html for /api/health. Reject on content-type before we
  # ever look at the body -- that is the check whose absence caused the 2026-07-15 false alarm.
  if (($res.Headers['Content-Type'] -join ',') -notmatch 'application/json') { return $null }
  try { $body = $res.Content | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
  if ($body.ok -ne $true -or -not $body.service) { return $null }
  return [string]$body.service
}

# Was this process alive before we started? Unreadable start time => assume yes and kill it: the
# directive is "never serve old code", so an unprovable process is treated as the old one.
function Test-PredatesRestart {
  param([int]$ProcessId)
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  try { return ($proc.StartTime -lt $restartStart) } catch { return $true }
}

# --- Tray hosts ------------------------------------------------------------------------------------
# The daemon's supervisor, in one of two forms:
#   · NATIVE, what every app's shortcut runs: misc\lunarwerx-tray.exe <App>-Tray.json.
#   · POWERSHELL, the -Legacy rollback: a hidden powershell running the sibling "<App>-Tray.ps1"
#     adapter, launched by Tray-Launch.vbs.
# Either one's watchdog revives a killed daemon within seconds, so a restart that leaves it alive
# restarts NOTHING durably -- see the zero-instance incident in the header. Each is matched by a
# name unique to THIS app: the adapter filename (RepoYeti-Tray.ps1, DevWebUI-Tray.ps1, ...) in a
# powershell command line, and the config filename (RepoYeti-Tray.json, ...) in a
# lunarwerx-tray.exe command line -- including a mutex-loser zombie stuck on its "already
# starting" MessageBox.
$miscDir = Join-Path $Root 'misc'
$trayAdapter = Get-ChildItem -LiteralPath $miscDir -Filter '*-Tray.ps1' -ErrorAction SilentlyContinue |
  Select-Object -First 1

$nativeExeName = 'lunarwerx-tray.exe'
$nativeExe = Join-Path $miscDir $nativeExeName
# The config the native host runs with: the adapter's twin (<App>-Tray.ps1 -> <App>-Tray.json)
# when there is one, otherwise the only *-Tray.json in misc\. Two candidates and no twin means we
# cannot say which one is ours, so no native host is matched or launched.
$nativeConfig = $null
if ($trayAdapter) {
  $twin = Join-Path $miscDir ($trayAdapter.BaseName + '.json')
  if (Test-Path -LiteralPath $twin) { $nativeConfig = Get-Item -LiteralPath $twin }
}
if (-not $nativeConfig) {
  $configs = @(Get-ChildItem -LiteralPath $miscDir -Filter '*-Tray.json' -ErrorAction SilentlyContinue)
  if ($configs.Count -eq 1) { $nativeConfig = $configs[0] }
}
# The config filename as a WHOLE argument, bare, quoted or at the end of a path. That also finds a
# compiled build's host, which tray-bootstrap.mjs materializes under the app's state dir and starts
# with the same bare filename. Every kit app runs the same binary, so this filename is the only
# thing telling our host from a sibling's.
$nativeNeedle = if ($nativeConfig) { '(^|[\s"\\/])' + [regex]::Escape($nativeConfig.Name) + '("|\s|$)' } else { $null }
$canLaunchNative = $nativeConfig -and (Test-Path -LiteralPath $nativeExe)
# The port the app is configured for, so the revive check below has somewhere to look even when
# the runtime pointer is gone.
$configPort = 0
if ($nativeConfig) {
  try { $configPort = [int](Get-Content -LiteralPath $nativeConfig.FullName -Raw | ConvertFrom-Json).port } catch { }
}

function Get-TrayHostPids {
  param([switch]$IncludeFresh)   # default: only hosts that predate this run (the kill targets)
  $names = @()
  if ($trayAdapter) { $names += "Name='powershell.exe'", "Name='pwsh.exe'" }
  if ($nativeNeedle) { $names += "Name='$nativeExeName'" }
  if ($names.Count -eq 0) { return @() }
  $found = @()
  $procs = Get-CimInstance Win32_Process -Filter ($names -join ' OR ') -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ([int]$p.ProcessId -eq $PID) { continue }
    if (-not $p.CommandLine) { continue }
    $ours = if ($p.Name -ieq $nativeExeName) {
      $p.CommandLine -match $nativeNeedle
    } else {
      $p.CommandLine.IndexOf($trayAdapter.Name, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    if (-not $ours) { continue }
    if (-not $IncludeFresh -and -not (Test-PredatesRestart -ProcessId ([int]$p.ProcessId))) { continue }
    $found += [int]$p.ProcessId
  }
  return $found
}

# A daemon of ours that answers AND started after this run: the replacement, not a survivor. Looks
# where a fresh daemon announces itself (the runtime pointer it rewrites at boot) plus the ports we
# already know, rather than sweeping every listener once a second.
function Get-FreshDaemonPid {
  $ports = New-Object System.Collections.Generic.List[int]
  if (Test-Path $runtimeFile) {
    try {
      $now = Get-Content $runtimeFile -Raw | ConvertFrom-Json
      if ($now.port) { $ports.Add([int]$now.port) }
    } catch { }
  }
  if ($pointerPort) { $ports.Add($pointerPort) }
  if ($configPort) { $ports.Add($configPort) }
  foreach ($port in ($ports | Sort-Object -Unique)) {
    if ((Get-HealthService -Port $port) -ne $name) { continue }
    $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $owners) {
      if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { continue }
      if (-not (Test-PredatesRestart -ProcessId $procId)) { return [int]$procId }
    }
  }
  return $null
}

# Every process that identifies as this app AND predates this run. Recomputed each pass so the
# loop below is a real verification, not a fire-and-hope.
function Get-StaleTargets {
  param([int]$PointerPort)

  $probe = New-Object System.Collections.Generic.List[int]
  # The pointer's port is probed unconditionally: it's the one port we have a recorded claim on,
  # even if the daemon somehow isn't running under a bun/node image.
  if ($PointerPort) { $probe.Add($PointerPort) }
  # The bun/node prefilter keeps the sweep cheap (a 2s probe per listening port would crawl).
  foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    # A dead OwningProcess is a zombie socket (a killed daemon's port not yet reaped); it answers
    # nothing and can't be killed, so it drops out naturally.
    if ($proc -and $proc.ProcessName -in @('bun', 'node')) { $probe.Add([int]$conn.LocalPort) }
  }

  $targets = @{}
  foreach ($port in ($probe | Sort-Object -Unique)) {
    if ((Get-HealthService -Port $port) -ne $name) { continue }
    $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $owners) {
      if (-not (Test-PredatesRestart -ProcessId $procId)) { continue }  # the fresh one, leave it
      $targets[[int]$procId] = "serving '$name' on port $port"
    }
  }
  return $targets
}

# A daemon that has HUNG (won't answer /api/health) can't be found by identity, so the recorded
# pointer is the only handle on it. Guarded against PID reuse: the process must still be a
# bun/node image AND its start time must line up with the startedAt the daemon recorded.
function Get-HungPointerTarget {
  param($Info)
  if (-not $Info -or -not $Info.pid) { return $null }
  $proc = Get-Process -Id ([int]$Info.pid) -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -notin @('bun', 'node')) { return $null }
  if (-not (Test-PredatesRestart -ProcessId $proc.Id)) { return $null }
  if ($Info.startedAt) {
    try {
      $recorded = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Info.startedAt).LocalDateTime
      # The daemon writes startedAt within a second or two of booting. A recycled PID now owned by
      # an unrelated bun/node run won't land anywhere near it.
      if ([math]::Abs(($proc.StartTime - $recorded).TotalSeconds) -gt 120) { return $null }
    } catch { }
  }
  return $proc.Id
}

# --- Stop ----------------------------------------------------------------------------------------
$info = $null
if (Test-Path $runtimeFile) {
  try { $info = Get-Content $runtimeFile -Raw | ConvertFrom-Json } catch { }
}
$pointerPort = if ($info.port) { [int]$info.port } else { 0 }

$killed = @{}
$deadline = (Get-Date).AddSeconds($KillTimeoutSeconds)
$survivors = @{}

# -DaemonOnly keeps the APP off the screen either way; only the mechanism differs.
#   · tray host alive -> kill just the daemon; its watchdog (native or PowerShell) brings the new
#                        one up, and we wait to SEE it do so. One that does not is replaced.
#   · no tray host    -> kill the daemon and start a BARE daemon ourselves (no Tray-Launch.vbs,
#                        so no window). Deploying must never be a reason for the app to appear
#                        (owner directive, 2026-08-29) - and a headless daemon is exactly what a
#                        machine with no tray host had a moment ago anyway.
$trayAlive = @(Get-TrayHostPids -IncludeFresh).Count -gt 0
$daemonOnlyMode = [bool]$DaemonOnly
if ($daemonOnlyMode) {
  Write-Host $(if ($trayAlive) {
      '  -DaemonOnly: leaving the tray host and every window alone; its watchdog starts the new daemon.'
    } else {
      '  -DaemonOnly: no tray host, so a BARE daemon will be started - still no app window.'
    })
}

while ($true) {
  # Ordered kill list: tray hosts FIRST -- each carries a watchdog that would revive the daemon
  # mid-sweep, and tree-killing the host usually reaps its cmd->bun daemon in the same stroke.
  # In -DaemonOnly mode that watchdog is the POINT: the tray host lives, and revives the daemon
  # we are about to kill, so the app never leaves the screen.
  $targets = @{}
  $order = New-Object System.Collections.Generic.List[int]
  if (-not $daemonOnlyMode) {
    foreach ($trayPid in @(Get-TrayHostPids)) {
      $targets[[int]$trayPid] = "old tray host (its watchdog would revive the daemon we're stopping)"
      $order.Add([int]$trayPid)
    }
  }
  foreach ($entry in (Get-StaleTargets -PointerPort $pointerPort).GetEnumerator()) {
    if (-not $targets.ContainsKey([int]$entry.Key)) {
      $targets[[int]$entry.Key] = $entry.Value
      $order.Add([int]$entry.Key)
    }
  }
  $hungPid = Get-HungPointerTarget -Info $info
  if ($hungPid -and -not $targets.ContainsKey([int]$hungPid)) {
    $targets[[int]$hungPid] = "recorded in runtime.json but not answering /api/health (hung)"
    $order.Add([int]$hungPid)
  }

  if ($targets.Count -eq 0) { break }   # nothing of ours from before this run is left: verified.

  if ((Get-Date) -gt $deadline) { $survivors = $targets; break }

  foreach ($procId in $order) {
    # /T reaps whatever the target actually parented (a tray host's cmd->bun daemon; a daemon's
    # children). Note what it does NOT reach, and must not: work the app has already dispatched.
    # agenthydra launches a run's supervisor through WMI (Win32_Process.Create) precisely so it is
    # parented to WmiPrvSE, outside this tree AND outside the daemon's job object -- restarting the
    # app is not a reason to destroy a run in flight. (Verified 2026-07-15: a run survives this
    # exact taskkill with no daemon alive at all, and the reopened app reattaches and finalizes it
    # 'completed'. agenthydra guards the property with the WmiPrvSE-parent test in
    # server/tests/dispatch.test.ts.)
    taskkill /PID $procId /T /F *> $null
    if (-not $killed.ContainsKey($procId)) {
      $killed[$procId] = $targets[$procId]
      Write-Host ("  Killed pid {0} - {1}." -f $procId, $targets[$procId])
    }
  }
  Start-Sleep -Milliseconds 400   # let Windows reap them, then re-verify on the next pass
}

if ($survivors.Count -gt 0) {
  Write-Host ""
  Write-Host "  ! COULD NOT KILL everything of '$name' within $KillTimeoutSeconds seconds:" -ForegroundColor Red
  foreach ($procId in $survivors.Keys) {
    Write-Host ("    pid {0} - {1}" -f $procId, $survivors[$procId]) -ForegroundColor Red
  }
  Write-Host "    The OLD code (or its supervisor) is still alive. Kill it by hand, then re-run." -ForegroundColor Red
  exit 1
}

if ($killed.Count -eq 0) {
  Write-Host "  Nothing of '$name' was running (verified via /api/health identity + tray-host scan, not a guess)."
}

# A pointer that outlives its daemon is a landmine for the NEXT restart, so clear it -- but only if
# it still describes a process that's gone. A fresh daemon that appeared during the kill loop has
# already rewritten this file, and deleting ITS pointer would strand the launcher.
if (Test-Path $runtimeFile) {
  $current = $null
  try { $current = Get-Content $runtimeFile -Raw | ConvertFrom-Json } catch { }
  $ownerAlive = $current.pid -and (Get-Process -Id ([int]$current.pid) -ErrorAction SilentlyContinue)
  if (-not $ownerAlive) { Remove-Item $runtimeFile -Force -ErrorAction SilentlyContinue }
}

# --- Relaunch ------------------------------------------------------------------------------------
if ($NoLaunch) { exit 0 }

# -DaemonOnly never launches the app while the app can be kept running without it. With a tray
# host alive its watchdog has the job, and we WAIT for it to prove it did it: a tray host that is
# alive but not supervising (2026-09-26) is no better than none. One that misses the deadline is
# killed and replaced through the full relaunch below. That opens the app window, which is still
# better than a dead daemon. Without a tray host we start the daemon BY ITSELF, detached the same way
# (WMI) so it outlives this console. Both paths leave the screen exactly as it was.
if ($daemonOnlyMode) {
  if ($trayAlive) {
    Write-Host "  Daemon stopped; waiting up to $ReviveTimeoutSeconds s for the live tray host's watchdog to start the new one..."
    $until = (Get-Date).AddSeconds($ReviveTimeoutSeconds)
    $revived = $null
    while (-not $revived -and (Get-Date) -lt $until) {
      $revived = Get-FreshDaemonPid
      if (-not $revived) { Start-Sleep -Seconds 1 }
    }
    if ($revived) {
      Write-Host "  The tray host's watchdog brought the new daemon up (pid $revived). No window touched."
      exit 0
    }
    Write-Host "  ! The tray host is alive but did not revive the daemon within $ReviveTimeoutSeconds s - replacing it." -ForegroundColor Yellow
    foreach ($trayPid in @(Get-TrayHostPids)) {
      taskkill /PID $trayPid /T /F *> $null
      Write-Host "  Killed pid $trayPid - tray host that stopped supervising its daemon."
    }
    # Let Windows reap them first: one still listed would pass for a fresh host below, and then
    # nothing would be launched at all.
    $reaped = (Get-Date).AddSeconds(5)
    while (@(Get-TrayHostPids).Count -gt 0 -and (Get-Date) -lt $reaped) { Start-Sleep -Milliseconds 400 }
    # Fall through to the full relaunch below.
  } else {
    $spawn = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine      = "cmd.exe /c bun run --cwd server start"
      CurrentDirectory = $Root
    } -ErrorAction SilentlyContinue
    if ($spawn -and $spawn.ReturnValue -eq 0) {
      Write-Host "  Started a bare daemon, detached (WMI). No tray host, no app window."
    } else {
      Write-Host "  ! Could not start the bare daemon - run 'bun run --cwd server start' yourself." -ForegroundColor Red
    }
    exit 0
  }
}

# Anything still standing after the sweep is FRESH by construction (stale hosts were kill targets
# above): a tray host someone started while we were sweeping. Launching another would only mint a
# mutex loser that blocks forever on an "already starting" MessageBox. One supervisor, ever.
$freshTray = @(Get-TrayHostPids -IncludeFresh)
if ($freshTray.Count -gt 0) {
  Write-Host "  A fresh tray host is already up (pid $($freshTray -join ', ')) - not starting a second."
  exit 0
}

# Launch DETACHED via WMI: Win32_Process.Create parents the new tray host to WmiPrvSE, outside
# this console's tree and job object, so closing the terminal (or the tool run that invoked this
# script) can no longer tear the whole app down minutes later. See the header for the incident
# this prevents.
#
# The NATIVE host first, exactly as the app shortcut starts it (the host resolves the bare config
# name against its own directory). Tray-Launch.vbs starts the PowerShell host, which is the -Legacy
# rollback, so it runs only when the app ships no native host or WMI could not start it.
if ($canLaunchNative) {
  $configArg = if ($nativeConfig.Name -match '\s') { "`"$($nativeConfig.Name)`"" } else { $nativeConfig.Name }
  $spawn = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = "`"$nativeExe`" $configArg"
    CurrentDirectory = $miscDir
  } -ErrorAction SilentlyContinue
  if ($spawn -and $spawn.ReturnValue -eq 0) {
    Write-Host "  Relaunched the native tray host ($nativeExeName $($nativeConfig.Name)), detached (WMI), so it survives this console closing."
    exit 0
  }
  Write-Host "  ! WMI could not start $nativeExeName - falling back to the PowerShell tray host." -ForegroundColor Yellow
}

$launcherVbs = if ($trayAdapter) { Join-Path $trayAdapter.DirectoryName 'Tray-Launch.vbs' } else { $null }
if ($launcherVbs -and (Test-Path $launcherVbs)) {
  $spawn = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = "wscript.exe `"$launcherVbs`""
    CurrentDirectory = $Root
  } -ErrorAction SilentlyContinue
  if ($spawn -and $spawn.ReturnValue -eq 0) {
    Write-Host "  Relaunched the tray host, detached (WMI), so it survives this console closing."
    exit 0
  }
}

# Fallback: the app shortcut. Works, but the new host is parented under THIS console -- if the
# terminal closes soon after, the app may silently die with it.
$lnk = Get-ChildItem -LiteralPath $Root -Filter *.lnk -ErrorAction SilentlyContinue | Select-Object -First 1
if ($lnk) {
  Start-Process -FilePath $lnk.FullName
  Write-Host "  Relaunched via the desktop shortcut (WMI launch unavailable; keep this console open)."
} else {
  Write-Host "  No misc\Tray-Launch.vbs and no .lnk shortcut in the repo root - launch the app manually."
}
exit 0
