# =====================================================================================
# Shared tray-host engine (Windows). A parameterized WinForms tray host that runs a
# Bun (or any) daemon with no console window, showing a tray icon menu:
# Open / Rebuild & Restart / Restart / [app action] / Quit.
#
# Reusable engine: a small per-app launcher builds a $TrayConfig hashtable (app name,
# port, start/build commands, icon, health check, etc.), dot-sources this file, then
# calls Start-TrayHost for a normal run or Invoke-TrayHostSelfTest for a headless
# self-check. All app-specific behavior comes from that config; the engine stays generic.
# =====================================================================================

$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Config accessor with defaults ---------------------------------------------------
# Central place for the engine's default timing/policy values, so an app only overrides a
# key when its CURRENT behavior genuinely differs (never silently changed). $Config is the
# hashtable the adapter passed in; $Key missing/$null falls back to $Default.
function Get-TrayConfigValue($Config, [string]$Key, $Default) {
  if ($Config.ContainsKey($Key) -and $null -ne $Config[$Key]) { return $Config[$Key] }
  return $Default
}

# --- Icon helpers (shared by SelfTest and the live host) -----------------------------
# Byte-level ICO validation: a valid header (magic 0,0,1,0) and at least one small (<=48px)
# frame. A 256-only .ico renders BLANK in the notification area (the classic "tray icon is
# broken"), so we require a real tray-sized frame. Width byte 0 means 256px, so it doesn't
# count. Pure byte parse — no GDI+ decode — so it's cheap and dependency-free.
function Test-TrayIconHasSmallFrame([string]$icoPath) {
  try {
    $icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
    if ($icoBytes.Length -le 6 -or $icoBytes[0] -ne 0 -or $icoBytes[1] -ne 0 -or $icoBytes[2] -ne 1 -or $icoBytes[3] -ne 0) { return $false }
    $frameCount = [BitConverter]::ToUInt16($icoBytes, 4)
    for ($fi = 0; $fi -lt $frameCount; $fi++) {
      $fw = $icoBytes[6 + $fi * 16]
      if ($fw -ne 0 -and $fw -le 48) { return $true }
    }
  } catch {}
  return $false
}

# Build a live tray NotifyIcon from the app's icon: validate the bytes, pull the TRAY-SIZED
# frame out of the multi-size .ico so it renders crisply (not blank) in the notification area,
# force a decode, and construct a real NotifyIcon. Hard startup gate — no generic-system-icon
# fallback: the shortcut may only drive the daemon once the REAL notification-area icon exists.
function New-TrayHostIcon([string]$icoPath, [string]$displayName) {
  if (-not (Test-Path $icoPath)) { throw "Tray icon file is missing: $icoPath" }
  if (-not (Test-TrayIconHasSmallFrame $icoPath)) { throw "Tray icon has no small (<=48px) frame for the Windows notification area." }
  $ico = New-Object System.Drawing.Icon($icoPath, [System.Windows.Forms.SystemInformation]::SmallIconSize) -ErrorAction Stop
  $null = $ico.ToBitmap()   # force decode of the chosen frame — catches a corrupt/blank icon now
  $ni = New-Object System.Windows.Forms.NotifyIcon -ErrorAction Stop
  $ni.Text = $displayName
  $ni.Icon = $ico
  return $ni
}

# --- Chromium app-window placement probe (feeds Open-AppUi's sizing decision) ---------
# PowerShell port of the daemon's placement probe (server-lib/portable-window.mjs
# appWindowPlacementKey/hasRememberedBounds and devwebui's rememberedPlacement,
# server/src/window-size.ts), so a COLD start — the tray opening the window before the
# daemon is even up — makes the same sizing decision the daemon's POST
# /api/portable-window makes. Top-level rather than inside Start-TrayHost because both
# are pure: dot-sourcing this file is enough to unit-test them.

# The key Chromium files a saved app-window placement under — its own
# GenerateApplicationNameFromURL: hostname + "_" + path. The PORT and the QUERY STRING
# are both absent from the key (Chromium's omissions, not ours; verified Edge 150), so
# probing with the plain app URL and launching with a ?window-size-tagged one land on
# the SAME slot. $null for a URL that won't parse.
function Get-AppWindowPlacementKey([string]$u) {
  try {
    $uri = [uri]$u
    if (-not $uri.IsAbsoluteUri) { return $null }
    return "$($uri.Host)_$($uri.AbsolutePath)"
  } catch { return $null }
}

# The placement Chromium has saved for $u's window in $profileDir —
# @{ Width; Height; Maximized } — or $null when nothing usable is stored (fresh profile,
# unreadable/corrupt Preferences, junk rect). Carries the daemon probe's two
# verified-on-Edge-150 subtleties:
#   · Chromium writes prefs BY DOTTED PATH, so a placement key containing dots (any URL
#     path with a dot in it) lands as NESTED dicts, not under the flat key its own
#     GenerateApplicationNameFromURL produces. Probe flat first, then walk the key as a
#     dotted path — requiring an object at every hop so a sibling window's dotted key
#     that shares this key as a prefix can't read as "this window was saved".
#   · maximized:true means the rect holds the pre-maximize RESTORE bounds, not the
#     window's live size — surfaced so the caller can skip the size hint for it.
# A rect under 50px a side is junk (zero-area rects, monitor-reconciliation leftovers;
# Chromium's own drag-resize minimum sits well above 50), not a remembered size — the
# same floor the daemon's hint path uses, which also subsumes portable-window.mjs's
# positive-area rule on the --window-size decision.
function Get-RememberedPlacement([string]$profileDir, [string]$u) {
  $key = Get-AppWindowPlacementKey $u
  if (-not $profileDir -or -not $key) { return $null }
  try {
    $prefsPath = Join-Path $profileDir "Default\Preferences"
    if (-not (Test-Path $prefsPath)) { return $null }
    $prefs = Get-Content $prefsPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $placements = $prefs.browser.app_window_placement
    $node = $placements.$key                     # flat probe first…
    if ($null -eq $node) {                       # …then the dotted-path form
      $node = $placements
      foreach ($seg in $key.Split('.')) {
        if ($node -isnot [System.Management.Automation.PSCustomObject]) { return $null }
        $node = $node.$seg
      }
    }
    if ($node -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    foreach ($edge in @('left', 'top', 'right', 'bottom')) {
      $v = $node.$edge
      # Numbers only, as JS `typeof === "number"`: WinPS 5.1 deserializes JSON numbers as
      # int/long/decimal, PS7 as long/double — anything else (missing, string, bool) is
      # not a placement rect.
      if (-not ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal])) { return $null }
    }
    $w = $node.right - $node.left
    $h = $node.bottom - $node.top
    if ($w -lt 50 -or $h -lt 50) { return $null }
    return @{ Width = [int]$w; Height = [int]$h; Maximized = ($node.maximized -eq $true) }
  } catch { return $null }
}

# =====================================================================================
# Invoke-TrayHostSelfTest — headless -SelfTest. Proves the tray can actually start (runtime on
# PATH, daemon entry exists, the icon LOADS into a real NotifyIcon then disposes), then reports
# the exact per-app marker and exits WITHOUT opening a browser, touching the mutex, or entering
# the message loop. A missing/corrupt icon makes this exit non-zero. Safe to run standalone in CI.
# =====================================================================================
function Invoke-TrayHostSelfTest($Config) {
  $scriptDir = $Config.ScriptDir
  $root = $Config.Root
  $marker = $Config.SelfTestMarker
  $runtimeCmd = Get-TrayConfigValue $Config 'RuntimeCheckCommand' 'bun'

  $fail = @()
  if (-not (Get-Command $runtimeCmd -ErrorAction SilentlyContinue)) { $fail += "$runtimeCmd not on PATH" }
  $entry = Join-Path $root $Config.EntryFile
  if (-not (Test-Path $entry)) { $fail += "daemon entry $($Config.EntryFile) missing" }
  $icoPath = Join-Path $scriptDir $Config.IconFile
  if (-not (Test-Path $icoPath)) {
    $fail += "tray icon $($Config.IconFile) missing"
  } else {
    try {
      # Load the TRAY-sized frame (not the 256 jumbo), force a decode, construct+dispose a real
      # NotifyIcon (proves it loads into a tray-capable object, not just that the file exists),
      # then re-parse the bytes for a <=48px frame — catches the 256-only "renders blank" icon.
      $ico = New-Object System.Drawing.Icon($icoPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
      $null = $ico.ToBitmap()
      $ni = New-Object System.Windows.Forms.NotifyIcon
      $ni.Icon = $ico
      $ni.Dispose(); $ico.Dispose()
      if (-not (Test-TrayIconHasSmallFrame $icoPath)) { $fail += "tray icon has no small (<=48px) frame; a 256-only icon renders blank" }
    } catch { $fail += "tray icon failed to load: $($_.Exception.Message)" }
  }
  if ($fail.Count) { Write-Output ("${marker}_FAIL: " + ($fail -join "; ")); exit 1 }
  Write-Output "${marker}_OK"; exit 0
}

# =====================================================================================
# Start-TrayHost — the full host lifecycle. Everything below runs on the UI thread except the
# background $worker runspace (rebuild/restart). Structured to preserve every behavioral
# invariant of the four originals: mutex BEFORE icon; loser attaches + exits without an icon or
# timers; icon ALWAYS created with Visible=$true on the winner path before the hide gate;
# healthTimer live-syncs Visible from the hide setting; Open-AppUi never touches visibility;
# Quit sets intentionalStop before any teardown; watchdog has revive-grace + crash-loop pause;
# mutex released on icon-failure AND on Quit.
# =====================================================================================
function Start-TrayHost($Config) {
  # --- Resolve config into locals (engine idioms match the originals' variable names) ---
  $scriptDir   = $Config.ScriptDir
  $root        = $Config.Root
  $displayName = $Config.DisplayName
  $serviceName = $Config.ServiceName                 # $null ⇒ validate only body.ok
  $infoFile    = $Config.InfoFile
  $logPath     = $Config.DaemonLogPath               # daemon log, for crash balloons ($null ok)
  $script:url  = "http://$(Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'):$($Config.Port)"
  $port        = $Config.Port

  $CrashLoopMax       = Get-TrayConfigValue $Config 'CrashLoopMax' 4          # restarts…
  $CrashLoopWindowSec = Get-TrayConfigValue $Config 'CrashLoopWindowSec' 120  # …within this many seconds ⇒ pause
  # Consecutive failed health probes before the watchdog declares the daemon dead. MUST be > 1:
  # a single missed probe is not evidence of death (see Test-Daemon), and acting on one produced
  # duplicate daemons in the field — the tray relaunched a daemon that was alive the whole time,
  # the successor's own single-instance guard also mis-probed, and it hopped to PORT+1. At the
  # 5s tick this trades ~10s of extra recovery latency on a REAL crash (which answers instantly
  # with connection-refused, so misses accrue every tick) for not inventing crashes that never
  # happened. Set to 1 only if an app truly wants the old hair-trigger behavior.
  $reviveAfterMisses  = Get-TrayConfigValue $Config 'ReviveAfterMisses' 3
  $restartRetries     = Get-TrayConfigValue $Config 'RestartRetries' 0        # extra worker retries (ReDesign: 1)
  $usePortFreeWait    = Get-TrayConfigValue $Config 'UsePortFreeWait' $false  # wait for the socket to release (ReDesign)
  $startupWaitSec     = Get-TrayConfigValue $Config 'StartupWaitSec' 15
  $workerWaitSec      = Get-TrayConfigValue $Config 'WorkerWaitSec' 12
  # Attach apps only (OnStrayDaemon='attach'): does the auto-restart watchdog require THIS tray to
  # own the daemon (startedByUs) before it will revive a crashed one? Default $true preserves the
  # DevWebUI-derived behavior (an attached instance owned by another session is left alone — no
  # revive, no balloon). a sibling app's OLD watchdog had no such gate — it unconditionally relaunched
  # on any health-check failure — so its adapter sets this $false to keep that parity.
  $watchdogRequiresOwnership = Get-TrayConfigValue $Config 'WatchdogRequiresOwnership' $true

  # Shutdown protocol flavor: token+HTTP (DevWebUI/a sibling app) vs force-kill (ReDesign/RepoYeti).
  $tokenEnvVar   = $Config.ShutdownTokenEnvVar       # $null ⇒ no graceful token shutdown
  $headerPrefix  = $Config.ShutdownHeaderPrefix
  $useToken      = [bool]$tokenEnvVar
  $script:shutdownToken = if ($useToken) { [System.Guid]::NewGuid().ToString("N") } else { $null }

  # Stray-daemon policy when we win the mutex but a daemon is already alive.
  $onStray = Get-TrayConfigValue $Config 'OnStrayDaemon' 'attach'

  # Append a tray-side line to the daemon log, so the watchdog's decisions land in the SAME file
  # the balloons tell the user to open. Without this a "stopped unexpectedly - restarting" balloon
  # pointed at a log containing no trace of the restart, which reads as "the log is empty, so
  # nothing was wrong" — exactly backwards. Format matches the daemon's own writer (log-file.mjs:
  # "[ISO] LEVEL text") so the two interleave cleanly. Best-effort: a logging failure (the daemon
  # holds the handle, disk full, mid-rotation) must never take the tray down.
  function Write-TrayLog($level, $text) {
    if (-not $logPath) { return }
    try {
      $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
      Add-Content -LiteralPath $logPath -Value "[$stamp] $($level.PadRight(5)) [tray] $text" -ErrorAction Stop
    } catch {}
  }

  # Full-shutdown sentinel (web-UI "Shut Down" / `<app> stop`). $null ⇒ no sentinel.
  $script:shutdownRequestFile = $Config.SentinelFile

  # $startedByUs: did THIS tray launch the daemon? Only an owned daemon is force-stopped at Quit
  # and revived by the watchdog. For the force-kill apps that always own on the winner path, it's
  # implicitly true; the token/attach apps track it explicitly (an attached instance is left alone).
  $script:startedByUs = $false
  $script:trayMutex = $null
  $script:ownsTrayMutex = $false

  # =====================================================================================
  # Daemon control — defined once as a scriptblock so the EXACT same functions run on the UI
  # thread (launch, quit) AND inside the background worker runspace (rebuild, restart). All
  # stateless: they locate the live instance via the runtime pointer + /api/health and act on
  # the bound port (or ask the daemon to stop, for the token apps), so nothing depends on
  # WinForms or a shared Process handle. Stringified and re-hydrated in the worker via
  # [scriptblock]::Create($helpersText) — so these must stay closure-free of app-scope vars
  # (every input is passed in explicitly). App-specific bits (service-id, start command, env,
  # token/header names, url host) are threaded in as PARAMETERS, never closed over.
  # =====================================================================================
  $ServerControl = {
    # Is OUR daemon answering here? /api/health is unauthenticated; when $service is non-empty
    # we also require body.service -eq $service (case-sensitive) — the anti-collision check that
    # stops the tray mistaking another app's server on the same port for its own. When $service
    # is empty we validate only body.ok, which is a WEAK check every adapter should now avoid:
    # anything answering that port passes it (a Vite dev server returns 200 + its SPA fallback for
    # /api/health). Every app in the family stamps `service` and names it here as of 2026-07-15.
    # $timeoutSec defaults to 2, not 1: a 1-second budget is not enough for a daemon that is
    # ALIVE but momentarily busy (boot-time session scanning, a slow sync tick, a loaded box
    # running many concurrent workloads). A probe that times out against a healthy daemon reads
    # as "dead" and, on the watchdog path, spawns a duplicate. Keep this modest anyway — the
    # health timer ticks on the UI THREAD, so the worst-case tick blocks the tray menu for
    # 2x this (Get-RunningUrl probes the pointer, then the preferred port). The real resilience
    # comes from requiring consecutive misses, not from one long timeout.
    function Test-Daemon($u, $service, $timeoutSec = 2) {
      if (-not $u) { return $false }
      try {
        $r = Invoke-RestMethod -Uri "$u/api/health" -TimeoutSec $timeoutSec -ErrorAction Stop
        if ($service) { return ($r.ok -eq $true -and $r.service -eq $service) }
        return [bool]$r.ok
      } catch { return $false }
    }
    # Health-probe a URL, but ONLY if something is actually bound to its port.
    #
    # Invoke-RestMethod does NOT fail fast on a refused local connection — it burns the whole
    # -TimeoutSec (measured on loopback: ~1.0s at -TimeoutSec 1, ~2.0s at 2). Get-RunningUrl can
    # probe twice, and the health timer runs on the WinForms UI THREAD, so a plainly-dead daemon
    # used to freeze the tray menu for two full timeouts EVERY tick. GetActiveTcpListeners answers
    # "is anything bound to this port" in ~1ms with no timeout at all.
    #
    # This can only skip a probe that was already certain to fail: the listener check matches on
    # port alone (any address, IPv4 AND IPv6), so anything listening still falls through to the
    # real /api/health call. Net effect: a dead daemon is detected instantly, and the generous
    # HTTP timeout is spent only where it does some good — on a daemon that IS up but busy.
    function Test-DaemonAt($u, $service) {
      if (-not $u) { return $false }
      $p = Get-PortFromUrl $u
      if ($p -gt 0 -and -not (Test-PortListening $p)) { return $false }
      return (Test-Daemon $u $service)
    }
    # The URL of a live instance (runtime pointer, else preferred port), or $null.
    function Get-RunningUrl($infoFile, $port, $service, $urlHost) {
      $fallback = "http://${urlHost}:$port"
      $pointerUrl = $null
      if (Test-Path $infoFile) {
        try {
          $info = Get-Content $infoFile -Raw | ConvertFrom-Json
          if ($info.url) {
            $pointerUrl = $info.url
            if (Test-DaemonAt $info.url $service) { return $info.url }
          }
        } catch { }
      }
      # When the pointer already named the preferred port there is nothing new to try: probing the
      # same hung endpoint a second time only doubles the stall for an answer we already have.
      if ($pointerUrl -eq $fallback) { return $null }
      if (Test-DaemonAt $fallback $service) { return $fallback }
      return $null
    }
    function Get-PortFromUrl($u) { try { return ([uri]$u).Port } catch { return 0 } }
    # Is anything LISTENING on this port? Pure .NET, no module dependency, so it works in a
    # fresh runspace where Get-NetTCPConnection may not be auto-loaded.
    function Test-PortListening([int]$p) {
      try {
        foreach ($ep in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
          if ($ep.Port -eq $p) { return $true }
        }
      } catch {}
      return $false
    }
    # PIDs LISTENING on a port (via netstat, always present). Plain `netstat -ano` (no `-p tcp`)
    # so IPv4 AND IPv6 listeners are both included — do NOT "clean up" that omission.
    function Get-PortPids([int]$p) {
      $ids = @()
      try {
        foreach ($line in (& netstat -ano 2>$null)) {
          $t = $line.Trim()
          if ($t -notmatch 'LISTENING') { continue }
          $parts = $t -split '\s+'
          if ($parts.Length -ge 5 -and $parts[1] -match (':' + $p + '$') -and $parts[4] -match '^\d+$') { $ids += [int]$parts[4] }
        }
      } catch {}
      return ($ids | Select-Object -Unique)
    }
    # Wait for the listen socket to actually release after a force-kill (Windows can hold it
    # briefly), so the new instance doesn't lose the port race. Used only by UsePortFreeWait apps.
    function Wait-PortFree([int]$p, [int]$seconds) {
      $deadline = (Get-Date).AddSeconds($seconds)
      while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortListening $p)) { return $true }
        Start-Sleep -Milliseconds 150
      }
      return $false
    }
    # Ask the daemon to shut itself down cleanly (token-gated; only a daemon we started this
    # session honours our token). Header names are '<prefix>-shutdown-token' /
    # '<prefix>-shutdown-source'. Best-effort; returns whether the POST succeeded.
    function Invoke-DaemonShutdown($u, $token, $headerPrefix, $timeoutSec) {
      if (-not $u) { return $false }
      if (-not $timeoutSec) { $timeoutSec = 20 }
      try {
        $headers = @{}
        $headers["$headerPrefix-shutdown-token"] = $token
        $headers["$headerPrefix-shutdown-source"] = "ui"
        Invoke-RestMethod -Uri "$u/api/shutdown" -Method Post -Headers $headers -TimeoutSec $timeoutSec -ErrorAction Stop | Out-Null
        return $true
      } catch { return $false }
    }
    # Stop the live daemon. Token apps: graceful shutdown first (only when $forceKill — i.e. we
    # own it; an attached instance another session owns is left alone), then force-kill the port
    # owner as a fallback. Force-kill apps ($token empty): straight port-owner tree-kill of BOTH
    # the preferred port AND the runtime-pointer's actually-bound port (handles a hop), then wait
    # for it to go quiet. Both paths are stateless and safe on the UI thread and in the worker.
    # $skipGraceful: caller already ran its own bounded graceful POST (e.g. Quit's belt-and-braces
    # sweep) — skip the second 20s-bounded Invoke-DaemonShutdown + 10s poll and go straight to the
    # port-kill so a still-alive daemon can't turn Quit into a ~30s hang.
    function Stop-Daemon($infoFile, $port, $service, $urlHost, $token, $headerPrefix, $forceKill, [bool]$skipGraceful = $false) {
      $u = Get-RunningUrl $infoFile $port $service $urlHost
      if ($token) {
        # --- Token/graceful flavor ---
        if (-not $u) { return }
        if (-not $forceKill) { return }   # only act on a daemon we own
        if (-not $skipGraceful) {
          if (Invoke-DaemonShutdown $u $token $headerPrefix 20) {
            for ($i = 0; $i -lt 40; $i++) {
              if (-not (Get-RunningUrl $infoFile $port $service $urlHost)) { return }
              Start-Sleep -Milliseconds 250
            }
          }
        }
        $ports = @($port); $pp = Get-PortFromUrl $u; if ($pp -gt 0) { $ports += $pp }
        foreach ($pp in ($ports | Select-Object -Unique)) {
          foreach ($procId in (Get-PortPids $pp)) { if ($procId -gt 0) { & taskkill /PID $procId /T /F 2>$null | Out-Null } }
        }
        for ($i = 0; $i -lt 20; $i++) {
          if (-not (Get-RunningUrl $infoFile $port $service $urlHost)) { return }
          Start-Sleep -Milliseconds 200
        }
      } else {
        # --- Force-kill flavor (no token) ---
        $ports = @($port)
        if ($u) { $pp = Get-PortFromUrl $u; if ($pp -gt 0) { $ports += $pp } }
        foreach ($pp in ($ports | Select-Object -Unique)) {
          foreach ($procId in (Get-PortPids $pp)) { if ($procId -gt 0) { & taskkill /PID $procId /T /F 2>$null | Out-Null } }
        }
        # Settle poll so a follow-on Start doesn't race a socket that's still shutting down.
        for ($i = 0; $i -lt 25; $i++) {
          if (-not (Get-RunningUrl $infoFile $port $service $urlHost)) { return }
          Start-Sleep -Milliseconds 200
        }
      }
    }
    # Launch the daemon via cmd.exe /c (so bun.cmd/bun.ps1's PATHEXT shim resolves and taskkill
    # /T can later reap the whole cmd->bun tree). $startCommand is the app's exact payload with
    # any {PORT} token already substituted. $portEnvVar (if non-empty) is set to the port;
    # $extraEnv is the app's StartEnv hashtable (already token/port-substituted). $proc handle
    # returned so a caller can track its PID and fail fast if it exits before serving.
    function Start-Daemon($appRoot, $port, $startCommand, $portEnvVar, $extraEnv) {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = "cmd.exe"
      $psi.Arguments = "/c $startCommand"
      $psi.WorkingDirectory = $appRoot
      $psi.UseShellExecute = $false                 # required so CreateNoWindow works
      $psi.CreateNoWindow = $true
      $psi.WindowStyle = "Hidden"
      if ($portEnvVar) { $psi.EnvironmentVariables[$portEnvVar] = "$port" }
      if ($extraEnv) {
        foreach ($k in $extraEnv.Keys) { $psi.EnvironmentVariables[$k] = "$($extraEnv[$k])" }
      }
      return [System.Diagnostics.Process]::Start($psi)
    }
    # Wait for the daemon to come up and return the URL it ACTUALLY bound (validated via
    # /api/health), which may differ from the preferred port if it hopped. If a process handle is
    # given, bail early when it exits before serving (RepoYeti: usually "no scan root configured").
    function Wait-ForUrl($infoFile, $port, $service, $urlHost, $seconds, $proc) {
      $deadline = (Get-Date).AddSeconds($seconds)
      while ((Get-Date) -lt $deadline) {
        $u = Get-RunningUrl $infoFile $port $service $urlHost
        if ($u) { return $u }
        if ($proc -and $proc.HasExited) { return (Get-RunningUrl $infoFile $port $service $urlHost) }
        Start-Sleep -Milliseconds 250
      }
      return (Get-RunningUrl $infoFile $port $service $urlHost)
    }
  }
  . $ServerControl   # make the functions available on the UI thread

  # Effective start command / env with {PORT} and {TOKEN} tokens substituted, computed once and
  # reused by cold start, worker, and watchdog (so all launch paths are byte-identical).
  $portEnvVar = if ($Config.ContainsKey('PortEnvVar')) { $Config['PortEnvVar'] } else { 'PORT' }
  $startCommand = ($Config.StartCommand -replace '\{PORT\}', "$port")
  $startEnv = @{}
  $rawStartEnv = Get-TrayConfigValue $Config 'StartEnv' @{}
  foreach ($k in $rawStartEnv.Keys) {
    $v = "$($rawStartEnv[$k])" -replace '\{PORT\}', "$port"
    if ($useToken) { $v = $v -replace '\{TOKEN\}', "$script:shutdownToken" }
    $startEnv[$k] = $v
  }
  # Token apps also inject the shutdown-token env var at spawn (the daemon reads it and only
  # honours a shutdown POST bearing the matching token).
  if ($useToken) { $startEnv[$tokenEnvVar] = $script:shutdownToken }

  # Small UI-thread wrappers that bind the app-specific parameters so the rest of the host reads
  # cleanly (the worker binds them itself from the passed-in config args).
  function Get-LiveUrl { return (Get-RunningUrl $infoFile $port $serviceName (Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1')) }
  function Start-DaemonHere($proc) { return (Start-Daemon $root $port $startCommand $portEnvVar $startEnv) }
  function Stop-DaemonHere([bool]$forceKill, [bool]$skipGraceful = $false) { Stop-Daemon $infoFile $port $serviceName (Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1') $script:shutdownToken $headerPrefix $forceKill $skipGraceful }

  # --- Portable-window open path (UI-thread only) --------------------------------------
  # Opt-in portable-window sizing, validated once here (unlike runtime.json, the app's own
  # config can't change mid-run):
  #   · PortableWindowSize = @{ Width; Height } — outer px for a window this profile has
  #     NEVER seen. Without it Chromium's never-seen default is ~the whole work area
  #     (~1905x2092 on a 4K display; verified Edge 150, Windows 11) — comically large for a
  #     small single-purpose window. Passed only while NOTHING usable is remembered:
  #     --window-size overrides a saved placement, so once the user sizes (or maximizes)
  #     the window themselves, their geometry must win on every later launch. A malformed
  #     value degrades to $null (feature off), never to a junk --window-size.
  #   · PortableWindowSizeHint = $true — additionally append ?window-size=WxH to the URL,
  #     for apps whose web build applies it via resizeTo. A FORWARDED --app launch (a
  #     Chromium instance already running on the profile) ignores --window-size AND the
  #     saved placement, inheriting the running window's geometry (verified Edge 150) —
  #     only the page itself can correct that case, so this stays off for apps that don't
  #     implement the applier (devwebui does: web/src/lib/window-size-hint.ts).
  # Neither key set ⇒ Open-AppUi's launch line is byte-identical to what it always was.
  $portableWindowSize = $null
  $rawPortableSize = Get-TrayConfigValue $Config 'PortableWindowSize' $null
  if ($rawPortableSize) {
    try {
      $pwsW = [int][math]::Round([double]$rawPortableSize.Width)
      $pwsH = [int][math]::Round([double]$rawPortableSize.Height)
      if ($pwsW -gt 0 -and $pwsH -gt 0) { $portableWindowSize = @{ Width = $pwsW; Height = $pwsH } }
    } catch {}
  }
  $portableWindowSizeHint = [bool](Get-TrayConfigValue $Config 'PortableWindowSizeHint' $false)

  # First installed Chromium-family browser that understands --app= (msedge preferred, then
  # Chrome), or $null. Mirrors src/portable-window.mjs's Windows candidate list so the tray's
  # cold-start behavior (before the daemon is up) matches the daemon's own.
  function Resolve-ChromiumBrowser {
    $candidates = @()
    $pf86 = ${env:ProgramFiles(x86)}
    if ($pf86) { $candidates += (Join-Path $pf86 "Microsoft\Edge\Application\msedge.exe") }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe") }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe") }
    if ($pf86) { $candidates += (Join-Path $pf86 "Google\Chrome\Application\chrome.exe") }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe") }
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
  }

  # Open the app UI at $url, honouring portableMode: re-reads runtime.json FRESH on every call
  # (so a setting flipped after this tray started is picked up on the next open) and, when
  # portableMode is truthy AND a Chromium browser is found, launches it as a chromeless --app=
  # window (with a dedicated profile) instead of a normal tab. When the app opts in
  # (PortableWindowSize / PortableWindowSizeHint, resolved above), the launch also carries the
  # first-run --window-size and/or the ?window-size hint, so a cold tray start sizes the window
  # the same way the daemon's own POST /api/portable-window path does. Never throws — worst
  # case it falls back. Its body NEVER references hideTrayIcon or $tray.Visible: visibility and
  # where-the-UI-opens are orthogonal concerns (the launcher tests assert this decoupling).
  function Open-AppUi([string]$url) {
    $portable = $false
    try {
      if (Test-Path $infoFile) {
        $info = Get-Content $infoFile -Raw | ConvertFrom-Json
        if ($info.portableMode) { $portable = $true }
      }
    } catch { $portable = $false }
    if ($portable) {
      $browser = Resolve-ChromiumBrowser
      if ($browser) {
        # Dedicated Chromium profile (sibling of runtime.json, named 'portable-profile') so the
        # app window remembers its own size/position across launches instead of sharing/fighting
        # over the default profile — the same convention the daemon's POST /api/portable-window
        # uses, so both open paths agree. If it can't be created, still open the window (just
        # without geometry memory) rather than dropping to a plain tab.
        $profileDir = Join-Path (Split-Path -Parent $infoFile) "portable-profile"
        $profileArgs = @()
        try {
          if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
          $profileArgs = @("--user-data-dir=`"$profileDir`"", "--no-first-run", "--no-default-browser-check")
        } catch {
          $profileArgs = @()
        }
        # First-run sizing: pass --window-size only while the profile remembers NOTHING usable
        # for this URL's placement slot — a placement the user made by resizing (or maximizing:
        # the rect then holds restore bounds, and the window reopens maximized natively) always
        # wins, because --window-size would override it on every launch.
        $sizeArgs = @()
        if ($portableWindowSize) {
          $placement = Get-RememberedPlacement $profileDir $url
          if ($null -eq $placement) {
            $sizeArgs = @("--window-size=$($portableWindowSize.Width),$($portableWindowSize.Height)")
          }
          # ?window-size=WxH hint: the size THIS window should have — remembered when there is
          # one, else first-run, and never for a maximized window (the page's resizeTo would
          # visibly un-maximize it). A forwarded launch ignores $sizeArgs and the saved
          # placement alike, so the page correcting itself is the only fix that reaches that
          # case. The query string is not part of Chromium's placement key, so the hint can't
          # re-key the window; a URL that won't parse just goes out un-hinted.
          if ($portableWindowSizeHint) {
            $hint = $null
            if ($null -eq $placement) {
              $hint = "$($portableWindowSize.Width)x$($portableWindowSize.Height)"
            } elseif (-not $placement.Maximized) {
              $hint = "$($placement.Width)x$($placement.Height)"
            }
            if ($hint) {
              try {
                $b = New-Object System.UriBuilder($url)
                $sizeParam = "window-size=$hint"
                $q = $b.Query.TrimStart('?')
                if ($q) { $b.Query = "$q&$sizeParam" } else { $b.Query = $sizeParam }
                $url = $b.Uri.AbsoluteUri
              } catch {}
            }
          }
        }
        Start-Process $browser -ArgumentList ($profileArgs + $sizeArgs + @("--app=$url"))
        return
      }
    }
    Start-Process $url
  }

  # "Hide tray icon" opt-in (web Settings → runtime.json's hideTrayIcon, same pattern as
  # portableMode). Read fresh every call. Only ever gates the NotifyIcon's .Visible — the icon
  # object itself is ALWAYS created (Quit/menu/watchdog machinery hangs off it). Missing/corrupt
  # runtime.json ⇒ icon stays visible (default).
  function Get-HideTrayIcon {
    try {
      if (Test-Path $infoFile) {
        $info = Get-Content $infoFile -Raw | ConvertFrom-Json
        if ($info.hideTrayIcon) { return $true }
      }
    } catch {}
    return $false
  }

  # --- Rebuild command resolver --------------------------------------------------------
  # RebuildCommand is either a plain string or a scriptblock(appRoot, scriptDir) resolver
  # (ReDesign: Rebuild.bat-first, then npm-run-build fallback). Resolve fresh each time.
  $rebuildSpec = Get-TrayConfigValue $Config 'RebuildCommand' $null
  function Resolve-RebuildCommand {
    if ($null -eq $rebuildSpec) { return $null }
    if ($rebuildSpec -is [scriptblock]) {
      try { return (& $rebuildSpec $root $scriptDir) } catch { return $null }
    }
    return $rebuildSpec
  }
  $rebuildLogName = Get-TrayConfigValue $Config 'RebuildLogName' 'Rebuild.log'
  $isDevTree = [bool]$Config.IsDevTree

  # --- Optional app action: one extra menu item that POSTs to the live daemon ----------
  # For apps that supervise WORK the daemon owns (DevWebUI's managed dev servers), not just the
  # daemon itself: Restart/Quit act on the daemon, this acts on what the daemon is running. Opt-in
  # — no ActionPath, no menu item, and the menu is byte-identical to what it always was.
  #   · ActionPath    — the POST path on the live daemon, e.g. '/api/processes/stop-all'.
  #   · ActionLabel   — menu text.
  #   · ActionOkText / ActionFailText — balloon copy ('{APP}' → DisplayName).
  # Fired on a background runspace (the request can legitimately take seconds — DevWebUI's stop-all
  # waits out each child's SIGTERM grace) so the tray menu never blocks on it, with the result
  # marshalled back to the UI thread by $actionTimer exactly like the rebuild worker's pollTimer.
  $actionPath     = Get-TrayConfigValue $Config 'ActionPath' $null
  $actionLabel    = Get-TrayConfigValue $Config 'ActionLabel' 'Run action'
  $actionOkText   = Get-TrayConfigValue $Config 'ActionOkText' 'Done.'
  $actionFailText = Get-TrayConfigValue $Config 'ActionFailText' "{APP} didn't accept that. Open it to check."
  $actionTimeoutSec = Get-TrayConfigValue $Config 'ActionTimeoutSec' 60

  # --- Mutex: one tray host per (app / checkout). Acquired BEFORE NotifyIcon creation. ---
  # A listening port WITHOUT this mutex means the daemon is running headless. 'attach' hosts a
  # tray for it; 'warn' refuses (ReDesign — a headless orphan the user must stop). Either way the
  # loser branch (mutex already held elsewhere) resolves the running URL, opens it, and returns
  # WITHOUT creating an icon or any timers — so exactly one tray icon ever exists per session.
  function Release-TrayMutex {
    if ($script:ownsTrayMutex -and $script:trayMutex) {
      try { $script:trayMutex.ReleaseMutex() } catch {}
    }
    if ($script:trayMutex) {
      try { $script:trayMutex.Dispose() } catch {}
    }
    $script:trayMutex = $null
    $script:ownsTrayMutex = $false
  }

  $createdMutex = $false
  try {
    $script:trayMutex = New-Object System.Threading.Mutex($true, $Config.MutexName, [ref]$createdMutex)
    $script:ownsTrayMutex = $createdMutex
    if (-not $createdMutex) {
      # A non-abandoned failure to create means someone else owns it — treat as loser below.
      # (WaitOne semantics differ across the originals; New-Object(...,[ref]) is the uniform path.
      # An AbandonedMutexException would surface on a later WaitOne, not here.)
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show("$displayName could not verify that the tray host is available. It will not start without the tray icon.", $displayName) | Out-Null
    Release-TrayMutex
    return
  }

  if (-not $script:ownsTrayMutex) {
    # Loser: open the running UI and exit — no icon, no timers. If Get-LiveUrl finds nothing yet,
    # the winning instance is still cold-starting (daemon not bound to its port yet) — tell the
    # user to wait rather than opening a browser tab against the bare, unvalidated preferred-port
    # guess URL, which would just show a connection-refused error since nothing is listening.
    $u = Get-LiveUrl
    if ($u) {
      Open-AppUi $u
    } else {
      [System.Windows.Forms.MessageBox]::Show("$displayName is already starting in the tray. Wait a moment, then open it from the tray icon.", $displayName) | Out-Null
    }
    if ($script:trayMutex) { try { $script:trayMutex.Dispose() } catch {} }
    $script:trayMutex = $null
    return
  }

  # --- Stray-daemon check (we won the mutex; is a daemon already alive?) ---
  $existing = Get-LiveUrl
  if ($existing) {
    if ($onStray -eq 'warn') {
      # ReDesign: a live daemon without our tray is a headless orphan — refuse and tell the user.
      [System.Windows.Forms.MessageBox]::Show("$displayName is already serving at $existing, but the tray icon is not running. Stop that process, then run the shortcut again.", $displayName) | Out-Null
      Release-TrayMutex
      return
    }
    # 'attach' (RepoYeti/DevWebUI/a sibling app): adopt the live URL, host a tray for it, and don't
    # spin up a second daemon. startedByUs stays $false so Quit/watchdog leave it alone.
    $script:url = $existing
  }

  # --- Bun (runtime) must be on PATH before we try to launch anything ---
  $runtimeCmd = Get-TrayConfigValue $Config 'RuntimeCheckCommand' 'bun'
  if (-not $existing -and -not (Get-Command $runtimeCmd -ErrorAction SilentlyContinue)) {
    [System.Windows.Forms.MessageBox]::Show("$runtimeCmd was not found on PATH.`nInstall it from https://bun.sh then click $displayName again.", $displayName) | Out-Null
    Release-TrayMutex
    return
  }

  # --- Create the tray icon (ALWAYS, on the winner path) ---
  # The NotifyIcon is ALWAYS created here with Visible=$true BEFORE the hide gate — the
  # icon-first guarantee the launcher tests assert. Quit/menu/watchdog all hang off it; only
  # .Visible is ever gated. On failure: dispose, message, release the mutex, and don't start.
  $tray = $null
  try {
    $tray = New-TrayHostIcon (Join-Path $scriptDir $Config.IconFile) $displayName
    $tray.Visible = $true
    # Gate visibility on the saved preference right after the unconditional line above. A LIVE
    # re-read happens on the health timer below so re-enabling from web Settings restores the
    # icon within a few seconds without restarting anything.
    if (Get-HideTrayIcon) { $tray.Visible = $false }
  } catch {
    if ($tray) { try { $tray.Visible = $false; $tray.Dispose() } catch {} }
    [System.Windows.Forms.MessageBox]::Show("$displayName could not start because the tray icon could not be created.`n`n$($_.Exception.Message)", $displayName) | Out-Null
    Release-TrayMutex
    return
  }

  # --- Cold start: first-run bootstrap + launch the daemon (only if none already alive) ---
  if (-not $existing) {
    # First run (blocking, once): the app's install/build-if-missing bootstrap. The tray icon is
    # already visible so the app doesn't look hung. $null to skip.
    $firstRun = Get-TrayConfigValue $Config 'FirstRun' $null
    if ($firstRun) { try { & $firstRun $root } catch {} }

    $startProc = Start-DaemonHere $null
    if ($startProc) { $script:shared.serverPid = $startProc.Id }
    $urlHost = Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'
    $readyUrl = Wait-ForUrl $infoFile $port $serviceName $urlHost $startupWaitSec $startProc
    if ($readyUrl) { $script:url = $readyUrl }
    $script:startedByUs = $true

    # RepoYeti-style "started but not serving" guidance (most-likely cause: no scan root). Only
    # when the app supplied a hint AND nothing is serving after the wait.
    $noScanHint = Get-TrayConfigValue $Config 'NoScanRootHint' $null
    if ($noScanHint -and -not (Get-LiveUrl)) {
      Stop-DaemonHere $true
      [System.Windows.Forms.MessageBox]::Show($noScanHint, $displayName) | Out-Null
      $tray.Visible = $false
      $tray.Dispose()
      Release-TrayMutex
      return
    }
  }

  # =====================================================================================
  # Background worker — runs the whole rebuild+restart (or plain restart) sequence off the UI
  # thread and returns a result object. Self-contained: it re-defines the server-control helpers
  # from the passed-in text so it needs nothing from the parent runspace. Nine positional args
  # (order-dependent, must match the AddArgument sequence in Start-Job-Async exactly).
  # =====================================================================================
  $worker = {
    param($appRoot, $appScriptDir, $infoFile, $appPort, $service, $urlHost, $startCommand, $portEnvVar, $extraEnvJson, $token, $headerPrefix, $doRebuild, $buildCommand, $rebuildLogName, $helpersText, $shared, $isDevTree, $restartRetries, $usePortFreeWait, $workerWaitSec)
    $ErrorActionPreference = 'SilentlyContinue'
    . ([scriptblock]::Create($helpersText))
    # Re-hydrate the extra-env hashtable from JSON (a Synchronized hashtable doesn't marshal
    # cleanly across the runspace as a live object; JSON is the safe wire format).
    $extraEnv = @{}
    if ($extraEnvJson) {
      try {
        $obj = $extraEnvJson | ConvertFrom-Json
        foreach ($p in $obj.PSObject.Properties) { $extraEnv[$p.Name] = $p.Value }
      } catch {}
    }
    $result = [pscustomobject]@{ Ok = $true; Skipped = $false; Ready = $false; Url = $null }

    # Defense-in-depth: refuse a rebuild outside a dev tree even if one was somehow requested
    # (the menu item isn't even added there, and Start-Job-Async re-checks too — triple gate).
    if ($doRebuild -and -not $isDevTree) { $result.Ok = $false; return $result }

    if ($doRebuild) {
      if (-not $buildCommand) {
        $result.Skipped = $true
      } else {
        $logPath = Join-Path $appScriptDir $rebuildLogName
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = "/c cd /d `"$appRoot`" && $buildCommand > `"$logPath`" 2>&1"
        $psi.WorkingDirectory = $appRoot
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WindowStyle = "Hidden"
        $p = [System.Diagnostics.Process]::Start($psi)
        $shared.buildPid = $p.Id
        # Poll HasExited (interruptible) instead of WaitForExit so a Quit can cancel promptly and
        # reap the build tree instead of the UI blocking on it.
        while (-not $p.HasExited) {
          if ($shared.cancel) { try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch {}; $result.Ok = $false; return $result }
          Start-Sleep -Milliseconds 200
        }
        $shared.buildPid = 0
        if ($p.ExitCode -ne 0) { $result.Ok = $false; return $result }
      }
    }
    if ($shared.cancel) { return $result }

    Stop-Daemon $infoFile $appPort $service $urlHost $token $headerPrefix $true
    if ($usePortFreeWait) { Wait-PortFree $appPort 6 | Out-Null }
    Start-Sleep -Milliseconds 300
    $sp = Start-Daemon $appRoot $appPort $startCommand $portEnvVar $extraEnv
    if ($sp) { $shared.serverPid = $sp.Id }
    $u = Wait-ForUrl $infoFile $appPort $service $urlHost $workerWaitSec $sp
    $result.Url = $u
    $result.Ready = [bool]$u

    # Optional extra restart attempts (ReDesign does ONE): slow/failed to bind ⇒ kill the tracked
    # process (even if it never listened), wait for the port, and retry.
    $attempt = 0
    while (-not $result.Ready -and -not $shared.cancel -and $attempt -lt $restartRetries) {
      $attempt++
      if ($shared.serverPid -gt 0) { try { & taskkill /PID $shared.serverPid /T /F 2>$null | Out-Null } catch {} }
      Stop-Daemon $infoFile $appPort $service $urlHost $token $headerPrefix $true
      if ($usePortFreeWait) { Wait-PortFree $appPort 6 | Out-Null }
      Start-Sleep -Milliseconds 400
      $sp = Start-Daemon $appRoot $appPort $startCommand $portEnvVar $extraEnv
      if ($sp) { $shared.serverPid = $sp.Id }
      $u = Wait-ForUrl $infoFile $appPort $service $urlHost $workerWaitSec $sp
      $result.Url = $u
      $result.Ready = [bool]$u
    }
    return $result
  }

  # --- Worker plumbing + watchdog state ------------------------------------------------
  $script:busy = $false
  $script:ps = $null
  $script:psAsync = $null
  $script:jobKind = ''
  # Shared with the worker runspace (same process heap): the worker records the PIDs it spawns so
  # Quit can reap them, and Quit sets `cancel` to stop the worker early.
  $script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
  # Auto-restart watchdog state. Nothing else brings the daemon back if it dies on its own. This
  # host is the natural supervisor: the health timer probes /api/health and relaunches a daemon
  # that died. Guards keep it from fighting deliberate stops:
  #   · $intentionalStop  — set during Quit so we never resurrect a daemon we're closing.
  #   · $script:busy       — a Rebuild/Restart worker owns the daemon; the watchdog stands down.
  #   · $script:startedByUs — only revive a daemon THIS tray launched (attach apps leave an
  #                            externally-owned instance alone).
  #   · reviveGraceUntil   — after firing a relaunch, wait for it to bind before trying again.
  #   · crash-loop guard   — >= MAX restarts within WINDOW seconds ⇒ pause + notify.
  #   · healthMisses       — CONSECUTIVE failed probes; only >= $reviveAfterMisses means "dead".
  $script:intentionalStop = $false
  $script:autoRestartPaused = $false
  $script:reviveGraceUntil = [DateTime]::MinValue
  $script:healthMisses = 0
  $script:restartTimes = New-Object System.Collections.Generic.List[DateTime]
  # Re-entrancy guard: the Quit menu item and the watch timer can both fire the full teardown.
  $script:quitting = $false

  # --- Menu -----------------------------------------------------------------------------
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = New-Object System.Windows.Forms.ToolStripMenuItem($Config.MenuOpenLabel)
  # "Rebuild && Restart" — the literal double-ampersand is deliberate: WinForms treats a single
  # '&' as a mnemonic-underline escape, so '&&' renders one visible '&'. Only shown in a dev tree.
  $rebuildItem = New-Object System.Windows.Forms.ToolStripMenuItem("Rebuild && Restart")
  $restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart")
  # Optional app action (see ActionPath above). Created only when configured, so the object can't
  # be referenced by a handler that shouldn't exist.
  $actionItem = if ($actionPath) { New-Object System.Windows.Forms.ToolStripMenuItem($actionLabel) } else { $null }
  $quitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")

  # --- pollTimer: marshals the async worker result back to the UI thread ---------------
  # Ticks on the UI thread — polls the worker and, once it finishes, reports the outcome, updates
  # the live URL, and re-enables the menu. Only place worker results touch the UI (no cross-thread
  # control access). Interval matches the family default.
  $pollTimer = New-Object System.Windows.Forms.Timer
  $pollTimer.Interval = 350
  $pollTimer.Add_Tick({
    if (-not $script:ps -or -not $script:psAsync) { $pollTimer.Stop(); return }
    if (-not $script:psAsync.IsCompleted) { return }
    $pollTimer.Stop()
    $out = $null
    try {
      $res = $script:ps.EndInvoke($script:psAsync)
      if ($res -and $res.Count -gt 0) { $out = $res[$res.Count - 1] }
    } catch {}
    try { $script:ps.Dispose() } catch {}
    $script:ps = $null; $script:psAsync = $null

    if ($out -and -not $out.Ok) {
      $tray.ShowBalloonTip(3500, $displayName, "Build failed. See misc\$rebuildLogName.", [System.Windows.Forms.ToolTipIcon]::Error)
    } elseif ($out -and $out.Ready) {
      if ($out.Url) { $script:url = $out.Url }
      $script:startedByUs = $true
      if ($script:jobKind -eq 'rebuild') { Open-AppUi $script:url }
    } else {
      $tray.ShowBalloonTip(3500, $displayName, "Restarted, but $displayName isn't answering yet.", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
    $rebuildItem.Enabled = $true
    $restartItem.Enabled = $true
    $script:busy = $false
  })

  # Kick off the worker without blocking the UI thread.
  function Start-Job-Async([bool]$doRebuild) {
    if ($script:busy) { return }
    # Defense-in-depth: the menu item is never even added outside a dev tree, but refuse a rebuild
    # request here too rather than trust only the menu's absence.
    if ($doRebuild -and -not $isDevTree) { return }
    $script:busy = $true
    $script:jobKind = if ($doRebuild) { 'rebuild' } else { 'restart' }
    # An explicit Restart/Rebuild is the user re-arming things: clear any crash-loop pause and the
    # restart history so the watchdog resumes cleanly once the worker hands the daemon back.
    $script:autoRestartPaused = $false
    $script:restartTimes.Clear()
    $rebuildItem.Enabled = $false
    $restartItem.Enabled = $false

    try {
      $script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
      $buildCommand = if ($doRebuild) { Resolve-RebuildCommand } else { $null }
      $urlHost = Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'
      $extraEnvJson = $startEnv | ConvertTo-Json -Compress
      $script:ps = [System.Management.Automation.PowerShell]::Create()
      [void]$script:ps.AddScript($worker.ToString())
      [void]$script:ps.AddArgument($root)              # 1  appRoot
      [void]$script:ps.AddArgument($scriptDir)         # 2  appScriptDir
      [void]$script:ps.AddArgument($infoFile)          # 3  infoFile
      [void]$script:ps.AddArgument($port)              # 4  appPort
      [void]$script:ps.AddArgument($serviceName)       # 5  service
      [void]$script:ps.AddArgument($urlHost)           # 6  urlHost
      [void]$script:ps.AddArgument($startCommand)      # 7  startCommand
      [void]$script:ps.AddArgument($portEnvVar)        # 8  portEnvVar
      [void]$script:ps.AddArgument($extraEnvJson)      # 9  extraEnvJson
      [void]$script:ps.AddArgument($script:shutdownToken) # 10 token
      [void]$script:ps.AddArgument($headerPrefix)      # 11 headerPrefix
      [void]$script:ps.AddArgument($doRebuild)         # 12 doRebuild
      [void]$script:ps.AddArgument($buildCommand)      # 13 buildCommand
      [void]$script:ps.AddArgument($rebuildLogName)    # 14 rebuildLogName
      [void]$script:ps.AddArgument($ServerControl.ToString()) # 15 helpersText
      [void]$script:ps.AddArgument($script:shared)     # 16 shared
      [void]$script:ps.AddArgument($isDevTree)         # 17 isDevTree
      [void]$script:ps.AddArgument($restartRetries)    # 18 restartRetries
      [void]$script:ps.AddArgument($usePortFreeWait)   # 19 usePortFreeWait
      [void]$script:ps.AddArgument($workerWaitSec)     # 20 workerWaitSec
      $script:psAsync = $script:ps.BeginInvoke()
      $pollTimer.Start()
    } catch {
      # Kicking off the runspace failed — never leave the menu stuck disabled.
      if ($script:ps) { try { $script:ps.Dispose() } catch {} }
      $script:ps = $null; $script:psAsync = $null
      $rebuildItem.Enabled = $true
      $restartItem.Enabled = $true
      $script:busy = $false
      $tray.ShowBalloonTip(3500, $displayName, "Couldn't start the background worker. Try again.", [System.Windows.Forms.ToolTipIcon]::Error)
    }
  }

  # --- Optional app action: fire the POST off-thread, report on the UI thread ----------
  # Deliberately independent of the rebuild worker's $script:busy/$script:ps: this touches only the
  # daemon's own state, never the daemon PROCESS, so it must not stand down for (or block) a
  # Rebuild/Restart, and the watchdog has no reason to care about it. Its own in-flight flag just
  # stops a double-click firing it twice.
  $script:actionPs = $null
  $script:actionAsync = $null
  $actionTimer = New-Object System.Windows.Forms.Timer
  $actionTimer.Interval = 350
  $actionTimer.Add_Tick({
    if (-not $script:actionPs -or -not $script:actionAsync) { $actionTimer.Stop(); return }
    if (-not $script:actionAsync.IsCompleted) { return }
    $actionTimer.Stop()
    $ok = $false
    try {
      $res = $script:actionPs.EndInvoke($script:actionAsync)
      if ($res -and $res.Count -gt 0) { $ok = [bool]$res[$res.Count - 1] }
    } catch {}
    try { $script:actionPs.Dispose() } catch {}
    $script:actionPs = $null; $script:actionAsync = $null
    if ($actionItem) { $actionItem.Enabled = $true }
    if ($ok) {
      $tray.ShowBalloonTip(3000, $displayName, ($actionOkText -replace '\{APP\}', $displayName), [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
      $tray.ShowBalloonTip(4000, $displayName, ($actionFailText -replace '\{APP\}', $displayName), [System.Windows.Forms.ToolTipIcon]::Warning)
    }
  })

  function Invoke-AppAction {
    if (-not $actionPath) { return }
    if ($script:actionPs) { return }   # one in flight
    # Resolve the LIVE url (the daemon may have hopped ports, or be down entirely) rather than
    # posting blind at $script:url — a dead daemon has nothing to act on, and saying so beats a
    # silent no-op the user reads as "the menu item is broken".
    $u = Get-LiveUrl
    if (-not $u) {
      $tray.ShowBalloonTip(3500, $displayName, "$displayName isn't running.", [System.Windows.Forms.ToolTipIcon]::Warning)
      return
    }
    $script:url = $u
    if ($actionItem) { $actionItem.Enabled = $false }
    try {
      $script:actionPs = [System.Management.Automation.PowerShell]::Create()
      [void]$script:actionPs.AddScript({
        param($url, $path, $timeoutSec)
        $ErrorActionPreference = 'SilentlyContinue'
        try {
          Invoke-RestMethod -Uri "$url$path" -Method Post -TimeoutSec $timeoutSec -ErrorAction Stop | Out-Null
          return $true
        } catch { return $false }
      }.ToString())
      [void]$script:actionPs.AddArgument($u)
      [void]$script:actionPs.AddArgument($actionPath)
      [void]$script:actionPs.AddArgument($actionTimeoutSec)
      $script:actionAsync = $script:actionPs.BeginInvoke()
      $actionTimer.Start()
    } catch {
      if ($script:actionPs) { try { $script:actionPs.Dispose() } catch {} }
      $script:actionPs = $null; $script:actionAsync = $null
      if ($actionItem) { $actionItem.Enabled = $true }
      $tray.ShowBalloonTip(3500, $displayName, "Couldn't start the background worker. Try again.", [System.Windows.Forms.ToolTipIcon]::Error)
    }
  }

  # --- Quit teardown -------------------------------------------------------------------
  # Called by BOTH the Quit menu item AND the watch timer that fires on a web-UI "Shut Down"
  # (which drops the sentinel). Sets intentionalStop BEFORE any teardown so the watchdog doesn't
  # relaunch what we're stopping. Token apps ask their own daemon to shut down gracefully first
  # (bounded, so Quit can't hang); force-kill apps go straight to the port sweep. Reaps in-flight
  # worker PIDs when busy; releases the mutex; exits the message loop.
  function Invoke-QuitApp {
    if ($script:quitting) { return }   # re-entrancy guard (menu + watch timer could both fire)
    $script:quitting = $true
    $script:intentionalStop = $true
    if ($healthTimer) { try { $healthTimer.Stop() } catch {} }
    if ($script:shutdownRequestFile) { Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue }
    if ($watchTimer) { try { $watchTimer.Stop() } catch {} }
    $script:shared.cancel = $true
    $pollTimer.Stop()
    # Token apps: best-effort graceful shutdown of OUR own daemon, bounded (3s) so Quit can't hang.
    if ($useToken -and $script:startedByUs) {
      try { Invoke-DaemonShutdown $script:url $script:shutdownToken $headerPrefix 3 | Out-Null } catch {}
    }
    # If a job is in flight, reap what the worker spawned (build + a daemon that may not have bound
    # yet) so nothing is orphaned and $script:ps.Stop() doesn't block on the build's WaitForExit.
    # When idle the tracked PIDs are stale (the live daemon is killed by-port below) — skip so we
    # never taskkill a reused PID.
    if ($script:busy) {
      foreach ($k in @('buildPid', 'serverPid')) {
        $procId = $script:shared[$k]
        if ($procId -and $procId -gt 0) { try { & taskkill /PID $procId /T /F 2>$null | Out-Null } catch {} }
      }
    }
    if ($script:ps) { try { $script:ps.Stop(); $script:ps.Dispose() } catch {} }
    # An in-flight app-action POST is just an HTTP call — drop it (we're about to stop the daemon
    # it was talking to) rather than let its poll timer fire a balloon at a disposed tray icon.
    if ($actionTimer) { try { $actionTimer.Stop() } catch {} }
    if ($script:actionPs) { try { $script:actionPs.Stop(); $script:actionPs.Dispose() } catch {}; $script:actionPs = $null; $script:actionAsync = $null }
    # Stop the live daemon. Force-kill apps (ReDesign/RepoYeti) ALWAYS sweep the port at Quit —
    # matching their originals' unconditional Stop-Server/Stop-RepoYeti call (they own the daemon
    # on the winner path). Token apps (DevWebUI/a sibling app) only stop a daemon THEY started, so an
    # attached instance owned by another session is left running. The graceful POST above already
    # ran for token apps (bounded to 3s so Quit can't hang) — pass skipGraceful so this
    # belt-and-braces call goes straight to the port-kill instead of re-running a second,
    # 20s-bounded graceful POST + 10s poll if the daemon is still alive (which would turn a fast
    # Quit into a ~30s hang, the exact case the fast fallback exists for).
    if (-not $useToken) {
      Stop-DaemonHere $true
    } elseif ($script:startedByUs) {
      Stop-DaemonHere $true $true
    }
    $tray.Visible = $false
    $tray.Dispose()
    Release-TrayMutex
    [System.Windows.Forms.Application]::Exit()
  }

  $openItem.Add_Click({ Open-AppUi $script:url })
  $rebuildItem.Add_Click({ Start-Job-Async $true })
  $restartItem.Add_Click({ Start-Job-Async $false })
  if ($actionItem) { $actionItem.Add_Click({ Invoke-AppAction }) }
  $quitItem.Add_Click({ Invoke-QuitApp })

  $menu.Items.Add($openItem) | Out-Null
  # Only shown in a dev tree — a distributed build never gets this menu item at all (not merely a
  # disabled one). Gated here at menu-ADD time; re-checked in Start-Job-Async and the worker.
  if ($isDevTree -and $rebuildSpec) { $menu.Items.Add($rebuildItem) | Out-Null }
  $menu.Items.Add($restartItem) | Out-Null
  # App action sits in its own group between the daemon-lifecycle items and Quit: it acts on what
  # the daemon is RUNNING, not on the daemon, and next to Restart/Quit without a divider it reads
  # as another way to stop the app itself.
  if ($actionItem) {
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    $menu.Items.Add($actionItem) | Out-Null
  }
  $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  $menu.Items.Add($quitItem) | Out-Null
  $tray.ContextMenuStrip = $menu
  $tray.Add_MouseDoubleClick({ Open-AppUi $script:url })

  # --- Auto-restart watchdog -----------------------------------------------------------
  # Ticks on the UI thread; each tick is cheap (one /api/health probe) and NEVER blocks — a
  # relaunch is fire-and-forget (Start-Daemon returns as soon as it spawns), and recovery is
  # observed on a later tick, so the tray stays responsive even while the daemon reboots. Also
  # live-syncs the tray icon's visibility with the hideTrayIcon setting so re-enabling it in web
  # Settings restores the icon within one tick, no restart needed.
  $healthTimer = New-Object System.Windows.Forms.Timer
  $healthTimer.Interval = 5000
  $healthTimer.Add_Tick({
    # Deliberate close, a Rebuild/Restart worker owns the daemon, or (attach apps) this tray never
    # launched the daemon → stand down. The visibility live-sync below still needs to run on every
    # tick, so do it BEFORE this early-return only when we're not shutting down.
    if ($script:intentionalStop -or $script:busy) { $script:healthMisses = 0; return }

    # Live-sync the tray icon's visibility with the web Settings toggle (hideTrayIcon).
    $wantHidden = Get-HideTrayIcon
    if ($tray.Visible -eq $wantHidden) { $tray.Visible = -not $wantHidden }

    # Attach apps: only supervise a daemon we started — UNLESS the app opts out via
    # WatchdogRequiresOwnership=$false (a sibling app: OLD revived regardless of ownership).
    if ($useToken -and -not $script:startedByUs -and $watchdogRequiresOwnership) { $script:healthMisses = 0; return }

    $u = Get-LiveUrl
    if ($u) {                                    # healthy (track where it actually bound)
      $script:url = $u
      # Recovered after one or more misses without ever being dead — that is the false positive
      # this counter exists to absorb. Record it: a box that logs these regularly wants a higher
      # ReviveAfterMisses, and without a line here the near-miss is invisible.
      if ($script:healthMisses -gt 0) {
        Write-TrayLog 'INFO' "health probe recovered after $($script:healthMisses) missed probe(s) - no restart needed"
      }
      $script:healthMisses = 0
      return
    }

    # A probe failed. Not the same thing as "the daemon died" — require consecutive misses
    # before believing it, so one slow/timed-out probe against a live daemon cannot spawn a
    # duplicate. A genuinely dead daemon refuses connections instantly, so it still trips this
    # within $reviveAfterMisses ticks.
    $script:healthMisses++
    if ($script:healthMisses -lt $reviveAfterMisses) {
      Write-TrayLog 'WARN' "health probe missed ($($script:healthMisses)/$reviveAfterMisses) - not restarting yet"
      return
    }

    # Down. Wait out the grace window after a relaunch so a still-booting daemon isn't
    # double-spawned, and honour a crash-loop pause.
    if ((Get-Date) -lt $script:reviveGraceUntil) { return }
    if ($script:autoRestartPaused) { return }

    # Crash-loop guard: prune attempts outside the window, then bail if we've hit the cap.
    $cutoff = (Get-Date).AddSeconds(-$CrashLoopWindowSec)
    for ($i = $script:restartTimes.Count - 1; $i -ge 0; $i--) {
      if ($script:restartTimes[$i] -lt $cutoff) { $script:restartTimes.RemoveAt($i) }
    }
    if ($script:restartTimes.Count -ge $CrashLoopMax) {
      $script:autoRestartPaused = $true
      Write-TrayLog 'ERROR' "auto-restart PAUSED - $($script:restartTimes.Count) restarts within ${CrashLoopWindowSec}s (crash-loop guard)"
      $tray.ShowBalloonTip(6000, $displayName, "$displayName keeps crashing - auto-restart paused. See $logPath, then use Restart to try again.", [System.Windows.Forms.ToolTipIcon]::Error)
      return
    }

    # Relaunch (same path the tray uses everywhere else — cmd->bun so taskkill /T can reap it).
    $script:restartTimes.Add((Get-Date))
    $script:reviveGraceUntil = (Get-Date).AddSeconds(20)
    $script:startedByUs = $true
    Write-TrayLog 'WARN' "daemon unreachable for $($script:healthMisses) consecutive probes - relaunching"
    $relaunched = Start-DaemonHere $null
    if ($relaunched) { $script:shared.serverPid = $relaunched.Id }
    $script:healthMisses = 0
    if ($relaunched) {
      Write-TrayLog 'INFO' "relaunch spawned (pid $($relaunched.Id))"
    } else {
      Write-TrayLog 'ERROR' 'relaunch FAILED to spawn a successor'
    }
    $tray.ShowBalloonTip(4000, $displayName, "$displayName stopped unexpectedly - restarting. Log: $logPath", [System.Windows.Forms.ToolTipIcon]::Warning)
  })

  # --- Watch timer: full-shutdown sentinel + (for some apps) the hide-tray live-sync ----
  # Only created when the app has a sentinel. Polls for the shutdown.request the daemon drops on a
  # web-UI "Shut Down" (or `<app> stop`) and tears the WHOLE app down (reusing Quit's teardown so
  # $intentionalStop is set and the watchdog stands down). Skipped while $script:busy so a
  # Rebuild/Restart's internal stop isn't mistaken for a user quit. Guarded so a Quit already in
  # progress is left alone.
  $watchTimer = $null
  if ($script:shutdownRequestFile) {
    # Clear any stale sentinel from a hard-killed previous run so it can't make us quit instantly.
    Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue
    $watchTimer = New-Object System.Windows.Forms.Timer
    $watchTimer.Interval = 500
    $watchTimer.Add_Tick({
      if ($script:intentionalStop) { return }
      if ($script:busy) { return }
      if (Test-Path $script:shutdownRequestFile) {
        $watchTimer.Stop()
        Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue
        Invoke-QuitApp
      }
    })
    $watchTimer.Start()
  }

  $healthTimer.Start()

  # --- Startup banner + open the UI ----------------------------------------------------
  $tray.ShowBalloonTip(2500, $displayName, "Running in the tray - right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)
  # Wait for a freshly-spawned daemon to bind before opening the browser, so the first paint isn't
  # ERR_CONNECTION_REFUSED (Bun takes ~1s to boot), resolving $script:url to wherever it ACTUALLY
  # bound (it may have hopped past the preferred port). Only meaningful on the cold-start path;
  # when we attached to a live daemon, $script:url is already correct.
  if ($script:startedByUs) {
    $urlHost = Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'
    $readyUrl = Wait-ForUrl $infoFile $port $serviceName $urlHost $startupWaitSec $null
    if ($readyUrl) { $script:url = $readyUrl }
  }
  Open-AppUi $script:url

  # Run the WinForms message loop (keeps the tray alive until Quit). The finally guarantees the
  # mutex is released even on a crashed exit of the loop.
  try {
    [System.Windows.Forms.Application]::Run()
  } finally {
    Release-TrayMutex
  }
}
