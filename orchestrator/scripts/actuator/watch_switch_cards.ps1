# watch_switch_cards.ps1 - keep ONE approve_switch_card.ps1 watcher alive per running Claude
# account, idempotently.
#
# WHY THIS EXISTS (owner, 2026-10-03: "This needs to be automatic or whatever. It can't just sit
# there."). approve_switch_card.ps1 presses the "Allow Claude to switch ..." card, but a watcher
# only exists while someone started it - and nothing kept one running, so a card sat unanswered
# until a person closed it. This is the keeper: run it (by hand, or every few minutes from a
# scheduled task registered by install_switch_card_watchers.ps1) and it starts a hidden watcher
# for every account that is running WITHOUT one. Running it again is a no-op for accounts already
# watched, so it is safe on a timer.
#
# WHAT IT WILL NOT DO:
#   * it does not choose an account the watcher could not (a leaf matching 0 or >1 claude.exe
#     main processes is SKIPPED and logged - the default profile, whose bare claude.exe CLI
#     processes share the leaf 'Claude', is one such account);
#   * it never touches a chat, a window or a permission card itself - it only starts the watcher,
#     which is the thing with the aim rails;
#   * overlapping runs cannot double-start: a named mutex makes the second run log and exit.
#
# Exit: 0 every running account is watched (or was started now) - 1 error.
param(
  # Only these account leaves (default: every running account). Matched like the watcher:
  # exact leaf-folder name, case-insensitive.
  [string[]]$Instance = @(),
  [string]$LogPath = '',
  # For a look, not a start: report what it WOULD start and change nothing.
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
# UTF-8 out (same reason as the siblings): a non-ASCII account dir must not mangle in the log.
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $OutputEncoding
} catch { }

if (-not $LogPath) {
  try {
    $stateRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'state'
    $dir = Join-Path $stateRoot 'logs'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $LogPath = Join-Path $dir 'watch-switch-cards.log'
  } catch {
    $LogPath = Join-Path $env:TEMP 'watch-switch-cards.log'
  }
}
function Write-Log([string]$msg) {
  $line = '{0} [watch-switch-cards] {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
  Write-Output $line
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

$watcher = Join-Path $PSScriptRoot 'approve_switch_card.ps1'
if (-not (Test-Path -LiteralPath $watcher)) {
  Write-Log "FAIL: $watcher is missing - nothing to supervise"
  exit 1
}

# ONE SUPERVISOR AT A TIME. A scheduled tick and a hand-run can overlap; the process check below
# still cannot stop both from deciding an account is unwatched in the same instant. A named
# mutex is the cheap, correct answer, and a mutex that cannot be created must not block the work.
$mutex = $null; $haveLock = $true
try {
  $mutex = New-Object System.Threading.Mutex($false, 'Global\AgentHydraSwitchCardWatcherSupervisor')
  $haveLock = $mutex.WaitOne(0)
} catch { $haveLock = $true }
if (-not $haveLock) {
  Write-Log 'another supervisor run is already in progress - exiting'
  exit 0
}

try {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object {
      $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
      if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
      $d = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
      [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $d }
    }

  # leaf -> how many main claude.exe processes carry that profile.
  $accounts = @{}
  foreach ($p in $procs) {
    $leaf = Split-Path -Leaf ($p.Dir.TrimEnd('\'))
    if (-not $leaf) { continue }
    if ($accounts.ContainsKey($leaf)) { $accounts[$leaf]++ } else { $accounts[$leaf] = 1 }
  }
  if ($Instance.Count -gt 0) {
    $keep = @{}
    foreach ($want in $Instance) {
      foreach ($leaf in $accounts.Keys) {
        if ($leaf.Equals($want, [System.StringComparison]::OrdinalIgnoreCase)) { $keep[$leaf] = $accounts[$leaf] }
      }
    }
    $accounts = $keep
  }

  # The watchers already alive: pwsh/powershell running approve_switch_card.ps1 -Instance <leaf>.
  # The hidden child carries -Detached; the intermediate -Hidden process exits in a moment, so a
  # transient miss just means the next tick re-checks (and then finds the real child).
  $watcherProcs = @(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe' OR Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'approve_switch_card\.ps1' })
  function Test-WatcherRunning([string]$leaf) {
    $pat = '-Instance\s+["'']?' + [regex]::Escape($leaf) + '["'']?(\s|$)'
    foreach ($p in $watcherProcs) { if ($p.CommandLine -match $pat) { return $true } }
    return $false
  }

  $exe = (Get-Process -Id $PID).Path
  $started = 0; $already = 0; $skipped = 0
  foreach ($leaf in ($accounts.Keys | Sort-Object)) {
    $n = $accounts[$leaf]
    if ($n -ne 1) {
      Write-Log "skip '$leaf': $n claude.exe main process(es) carry this profile (the watcher needs exactly 1)"
      $skipped++
      continue
    }
    if (Test-WatcherRunning $leaf) {
      Write-Log "already watching '$leaf'"
      $already++
      continue
    }
    if ($WhatIf) {
      Write-Log "WOULD start a watcher for '$leaf'"
      $started++
      continue
    }
    try {
      # The intermediate runs approve_switch_card.ps1 -Hidden, which Start-Proceses the real
      # watcher hidden and returns; the watcher then outlives this supervisor.
      & $exe -NoProfile -ExecutionPolicy Bypass -File $watcher -Instance $leaf -Hidden 2>&1 | Out-Null
      Write-Log "started watcher for '$leaf'"
      $started++
      Start-Sleep -Milliseconds 600   # let it register before the next account is checked
    } catch {
      Write-Log "FAIL: could not start a watcher for '$leaf': $($_.Exception.Message)"
    }
  }
  Write-Log "done: $started started, $already already watching, $skipped skipped (of $(@($accounts.Keys).Count) account(s))"
  exit 0
} finally {
  if ($mutex) { try { if ($haveLock) { $mutex.ReleaseMutex() } } catch { }; try { $mutex.Dispose() } catch { } }
}
