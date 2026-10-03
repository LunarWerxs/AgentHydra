<#
.SYNOPSIS
  Move what the owner RUNS (daemon, tray, supervisor, watchdog, orchestrator jobs and dashboard)
  onto a second, clean checkout that only ever receives pushed code: a git worktree on branch
  `live` whose upstream is origin/main. See docs/LIVE-CHECKOUT.md.

.DESCRIPTION
  WHY (docs/CLIMAYTE-FIELD-NOTES.md, notes 74-75): the running app loaded its code straight from
  the working checkout, which workers and chats edit all day. A restart on 2026-10-03 loaded a
  half-written file and every queue upload failed. The live checkout is updated ONLY by
  `git pull --ff-only`, so a restart can only ever load committed, pushed code.

  -Plan  (default) prints every change and changes nothing. Exit 0 = the plan is coherent.
  -Apply makes the changes, idempotently. It never stops, kills or restarts anything: it prints
         the one restart step for the operator to run.
  -Undo  points tasks, job wrappers and launchers back to the working checkout. The orchestrator
         state stays in its one canonical place (reached from both checkouts by a junction).
         `-Undo -Plan` previews it.

  Orchestrator state is kept in exactly ONE place: %USERPROFILE%\.agenthydra\orchestrator\state
  (or the user's ORCHESTRATOR_STATE_DIR when already set). Both checkouts' orchestrator\state are
  junctions to it, and ORCHESTRATOR_STATE_DIR is set for the user.

  ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
#>
[CmdletBinding()]
param(
  [switch]$Plan,
  [switch]$Apply,
  [switch]$Undo,
  # Where the live worktree goes. Default: a sibling of this checkout named `live`.
  [string]$LivePath = '',
  # Where the one orchestrator state dir goes. Default: the user's ORCHESTRATOR_STATE_DIR, else
  # %USERPROFILE%\.agenthydra\orchestrator\state.
  [string]$StateDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if ($Apply -and ($Plan -or $Undo)) { Write-Host 'Use -Apply alone (or -Undo, or -Undo -Plan).'; exit 2 }
$Direction = if ($Undo) { 'back' } else { 'forward' }
$DryRun = -not ($Apply -or ($Undo -and -not $Plan))
$ModeName = if ($Undo) { if ($DryRun) { 'Undo (preview)' } else { 'Undo' } } elseif ($Apply) { 'Apply' } else { 'Plan' }

$script:Problems = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]

function Section([string]$title) { Write-Host ''; Write-Host "== $title" }
function Step([string]$text) { if ($DryRun) { Write-Host "  [would] $text" } else { Write-Host "  [do]    $text" } }
function Info([string]$text) { Write-Host "  $text" }
function Problem([string]$text) { $script:Problems.Add($text); Write-Host "  [PROBLEM] $text" }
function Warn([string]$text) { $script:Warnings.Add($text); Write-Host "  [warn]  $text" }

function Invoke-Git {
  param([string[]]$GitArgs, [string]$Dir)
  # Native stderr under ErrorActionPreference=Stop throws in Windows PowerShell 5.1; read the exit code instead.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & git -C $Dir @GitArgs 2>$null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  [pscustomobject]@{ Code = $code; Out = ((@($out) | ForEach-Object { "$_" }) -join "`n").Trim() }
}

function Fail([string]$text) { Write-Host ''; Write-Host "STOPPED: $text"; exit 1 }

# ---------------------------------------------------------------------------------------------
# Where things are. The working checkout is the MAIN worktree of this repository, found from git
# itself, so the script gives the same answer whether it is run from app\ or from live\.
# ---------------------------------------------------------------------------------------------
$here = Split-Path $PSScriptRoot -Parent
$common = Invoke-Git @('rev-parse', '--path-format=absolute', '--git-common-dir') $here
if ($common.Code -ne 0) { Write-Host "Not a git checkout: $here"; exit 1 }
$App = (Split-Path ($common.Out -replace '/', '\') -Parent).TrimEnd('\')
$Live = if ($LivePath) { [IO.Path]::GetFullPath($LivePath).TrimEnd('\') } else { Join-Path (Split-Path $App -Parent) 'live' }
$userStateVar = [Environment]::GetEnvironmentVariable('ORCHESTRATOR_STATE_DIR', 'User')
$Canonical = if ($StateDir) { [IO.Path]::GetFullPath($StateDir).TrimEnd('\') }
             elseif ($userStateVar) { [IO.Path]::GetFullPath($userStateVar).TrimEnd('\') }
             else { Join-Path $env:USERPROFILE '.agenthydra\orchestrator\state' }
$SrcState = Join-Path $App 'orchestrator\state'
$LiveState = Join-Path $Live 'orchestrator\state'
$MovingRoot = Join-Path $App 'orchestrator\tmp'
$Marker = '.live-checkout-copy'
$Fairjob = Join-Path $env:USERPROFILE '.claude\tools\fairjob.cmd'

Write-Host "live-checkout.ps1 - $ModeName"
Info "working checkout : $App"
Info "live checkout    : $Live"
Info "orchestrator state (the one place): $Canonical"

$originMain = Invoke-Git @('rev-parse', '--verify', '--quiet', 'origin/main') $App
if ($originMain.Code -ne 0) { Problem 'origin/main does not exist in this repository (git fetch origin first).' }
else { Info ("origin/main      : " + $originMain.Out.Substring(0, 12)) }

# ---------------------------------------------------------------------------------------------
# Path mapping. Forward: <app>\orchestrator\state\... -> the canonical state dir; any other
# <app>\<rel> -> <live>\<rel> ONLY when <rel> is tracked on origin/main (the live checkout has
# nothing else); anything untracked stays on app\ and is reported. Back: <live>\ -> <app>\.
# ---------------------------------------------------------------------------------------------
$script:Tracked = @{}
function Test-Tracked([string]$rel) {
  $key = ($rel -replace '\\', '/').TrimEnd('/')
  if (-not $script:Tracked.ContainsKey($key)) {
    $r = Invoke-Git @('cat-file', '-e', "origin/main:$key") $App
    $script:Tracked[$key] = ($r.Code -eq 0)
  }
  return $script:Tracked[$key]
}

$AppRx = '(?i)' + [regex]::Escape($App) + '(\\[^"''\s]*)?(?=["''\s]|$)'
$LiveRx = '(?i)' + [regex]::Escape($Live) + '(?=[\\"''\s]|$)'
$script:Hit = $null

function Convert-PathText([string]$text) {
  $script:Hit = [pscustomobject]@{ State = 0; Live = 0; Back = 0; Kept = (New-Object System.Collections.Generic.List[string]) }
  if (-not $text) { return $text }
  if ($Direction -eq 'back') {
    return [regex]::Replace($text, $LiveRx, [System.Text.RegularExpressions.MatchEvaluator] {
      param($m) $script:Hit.Back++; return $App })
  }
  return [regex]::Replace($text, $AppRx, [System.Text.RegularExpressions.MatchEvaluator] {
    param($m)
    $rel = $m.Groups[1].Value.TrimStart('\')
    if ($rel -eq '') { $script:Hit.Live++; return $Live }
    if ($rel -match '(?i)^orchestrator\\state(\\|$)') {
      $script:Hit.State++
      return $Canonical + $rel.Substring('orchestrator\state'.Length)
    }
    if (Test-Tracked $rel) { $script:Hit.Live++; return (Join-Path $Live $rel) }
    $script:Hit.Kept.Add($rel)
    return $m.Value
  })
}

function Get-JunctionTarget([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $item = Get-Item -LiteralPath $path -Force
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
  $t = @($item.Target)
  if ($t.Count -eq 0 -or -not $t[0]) { return '?' }
  return ([string]$t[0]) -replace '^\\\\\?\\', '' -replace '^\\\?\?\\', ''
}

function Test-SamePath([string]$a, [string]$b) {
  return ([IO.Path]::GetFullPath($a).TrimEnd('\')) -ieq ([IO.Path]::GetFullPath($b).TrimEnd('\'))
}

function Get-AppProcesses {
  # Processes whose command line or executable is under the working checkout: they run app\
  # code (or hold its state) until restarted. Only pid, name and the matched path are shown.
  $rx = '(?i)' + [regex]::Escape($App) + '\\[^"''\s]*'
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and (("$($_.CommandLine) $($_.ExecutablePath)") -match $rx)
    } | ForEach-Object {
      $m = [regex]::Matches("$($_.ExecutablePath) $($_.CommandLine)", $rx) | ForEach-Object { $_.Value } |
        Where-Object { $_ -notmatch '(?i)\\(bun|node|python|pythonw|pwsh|powershell)\.exe$' } | Select-Object -Last 1
      if (-not $m) { $m = $_.ExecutablePath }
      [pscustomobject]@{ Id = $_.ProcessId; Name = $_.Name; Path = $m }
    })
}

function Invoke-Robocopy([string]$from, [string]$to, [string[]]$extra) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & robocopy $from $to /E /COPY:DAT /DCOPY:T /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP @extra | Out-Null
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($code -ge 8) { Fail "robocopy $from -> $to failed (exit $code)." }
}

function Test-Copied([string]$from, [string]$to) {
  # Every file of $from is in $to, byte-identical or newer there (written after the cut).
  $bad = New-Object System.Collections.Generic.List[string]
  foreach ($f in Get-ChildItem -LiteralPath $from -Recurse -File -Force) {
    $rel = $f.FullName.Substring($from.Length).TrimStart('\')
    $dest = Join-Path $to $rel
    if (-not (Test-Path -LiteralPath $dest)) { $bad.Add("$rel (missing)"); continue }
    $d = Get-Item -LiteralPath $dest -Force
    if ($d.LastWriteTimeUtc -gt $f.LastWriteTimeUtc) { continue }
    if ((Get-FileHash -LiteralPath $f.FullName).Hash -ne (Get-FileHash -LiteralPath $dest).Hash) { $bad.Add("$rel (differs)") }
  }
  return ,$bad
}

function Invoke-Heavy([string]$what, [string]$dir) {
  # Heavy steps go through fairjob when it is installed (exit 75 = it did NOT start: never run
  # the bare command instead). Without fairjob the command runs directly.
  Push-Location $dir
  try {
    if (Test-Path -LiteralPath $Fairjob) { & $Fairjob -Weight 3 -Run $what } else { & cmd /c $what }
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  if ($code -eq 75) { Fail "fairjob did not start '$what' (exit 75: low memory). Find out why, then rerun -Apply." }
  if ($code -ne 0) { Fail "'$what' in $dir failed (exit $code)." }
}

# =============================================================================================
# 1. The live worktree
# =============================================================================================
$headBefore = $null
Section 'Live checkout (git worktree on branch live, upstream origin/main, ff-only)'
if ($Direction -eq 'back') {
  Info "left in place. To remove it later: cmd /c rmdir `"$LiveState`"  then  git -C `"$App`" worktree remove `"$Live`""
} elseif (Test-Path -LiteralPath $Live) {
  $lc = Invoke-Git @('rev-parse', '--path-format=absolute', '--git-common-dir') $Live
  $branch = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD') $Live
  $up = Invoke-Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') $Live
  if ($lc.Code -ne 0 -or -not (Test-SamePath ($lc.Out -replace '/', '\') (Join-Path $App '.git'))) {
    Problem "$Live exists but is not a worktree of $App."
  } elseif ($branch.Out -ne 'live') {
    Problem "$Live is on branch '$($branch.Out)', not 'live'."
  } else {
    if ($up.Out -ne 'origin/main') { Step "git -C `"$Live`" branch --set-upstream-to=origin/main live   (upstream is '$($up.Out)')" }
    $dirty = Invoke-Git @('status', '--porcelain', '--untracked-files=no') $Live
    if ($dirty.Out) { Problem "$Live has local edits; the live checkout only ever takes ff-only pulls. Discard them there first." }
    $headBefore = (Invoke-Git @('rev-parse', 'HEAD') $Live).Out
    Info ("exists, on live at " + $headBefore.Substring(0, 12))
    Step "git -C `"$App`" fetch origin main; git -C `"$Live`" pull --ff-only"
  }
} else {
  if (-not (Test-Path -LiteralPath (Split-Path $Live -Parent))) { Problem "parent folder of $Live does not exist." }
  $hasBranch = (Invoke-Git @('show-ref', '--verify', '--quiet', 'refs/heads/live') $App).Code -eq 0
  Step "git -C `"$App`" fetch origin main"
  if ($hasBranch) { Step "git -C `"$App`" worktree add `"$Live`" live   (branch live already exists)" }
  else { Step "git -C `"$App`" worktree add -b live `"$Live`" origin/main" }
  Step "git -C `"$App`" branch --set-upstream-to=origin/main live"
}

if (-not $DryRun -and $Direction -eq 'forward' -and $script:Problems.Count -eq 0) {
  $r = Invoke-Git @('fetch', 'origin', 'main') $App
  if ($r.Code -ne 0) { Fail 'git fetch origin main failed.' }
  if (-not (Test-Path -LiteralPath $Live)) {
    $hasBranch = (Invoke-Git @('show-ref', '--verify', '--quiet', 'refs/heads/live') $App).Code -eq 0
    $r = if ($hasBranch) { Invoke-Git @('worktree', 'add', $Live, 'live') $App } else { Invoke-Git @('worktree', 'add', '-b', 'live', $Live, 'origin/main') $App }
    if ($r.Code -ne 0) { Fail "git worktree add $Live failed." }
  }
  $r = Invoke-Git @('branch', '--set-upstream-to=origin/main', 'live') $App
  if ($r.Code -ne 0) { Fail 'could not set the upstream of branch live to origin/main.' }
  $r = Invoke-Git @('pull', '--ff-only') $Live
  if ($r.Code -ne 0) { Fail "git pull --ff-only in $Live failed (the live branch must only ever fast-forward to origin/main)." }
}

# =============================================================================================
# 2. Dependencies and the web build in the live checkout
# =============================================================================================
Section 'Install and build in the live checkout'
$bunDir = Join-Path $env:USERPROFILE '.bun\bin'
$haveBun = (Test-Path -LiteralPath (Join-Path $bunDir 'bun.exe')) -or [bool](Get-Command bun -ErrorAction SilentlyContinue)
if ($Direction -eq 'forward') {
  if (-not $haveBun) { Problem 'bun was not found (~\.bun\bin\bun.exe or PATH).' }
  $via = if (Test-Path -LiteralPath $Fairjob) { 'fairjob.cmd -Weight 3 -Run' } else { 'directly (fairjob.cmd not installed)' }
  Step "bun install          in $Live   via $via   (when HEAD moved or node_modules is missing)"
  Step "bun run build        in $Live   via $via   (web\dist; when HEAD moved or it is missing)"
  if (-not $DryRun -and $script:Problems.Count -eq 0) {
    if (Test-Path -LiteralPath $bunDir) { $env:Path = "$bunDir;$env:Path" }
    $headAfter = (Invoke-Git @('rev-parse', 'HEAD') $Live).Out
    $moved = ($headBefore -ne $headAfter)
    if ($moved -or -not (Test-Path -LiteralPath (Join-Path $Live 'node_modules'))) { Invoke-Heavy 'bun install' $Live } else { Info '[skip] bun install: up to date' }
    if ($moved -or -not (Test-Path -LiteralPath (Join-Path $Live 'web\dist\index.html'))) { Invoke-Heavy 'bun run build' $Live } else { Info '[skip] web build: up to date' }
  }
} else { Info 'nothing to undo.' }

# =============================================================================================
# 3. Orchestrator state: ONE place, reached from both checkouts by a junction
# =============================================================================================
Section 'Orchestrator state (one place)'
$srcTarget = Get-JunctionTarget $SrcState
$srcIsDir = (Test-Path -LiteralPath $SrcState) -and -not $srcTarget
$canonHas = (Test-Path -LiteralPath $Canonical) -and @(Get-ChildItem -LiteralPath $Canonical -Force | Where-Object { $_.Name -ne $Marker }).Count -gt 0
$canonOurs = Test-Path -LiteralPath (Join-Path $Canonical $Marker)
$leftovers = @(if (Test-Path -LiteralPath $MovingRoot) { Get-ChildItem -LiteralPath $MovingRoot -Directory -Filter 'state-moving-*' })

if ($Direction -eq 'back') {
  Info "stays in $Canonical. $SrcState stays a junction to it and ORCHESTRATOR_STATE_DIR stays set:"
  Info 'moving it back would split it again. Nothing to undo.'
} else {
  if ($srcTarget) {
    if (Test-SamePath $srcTarget $Canonical) { Info "already moved: $SrcState -> $Canonical (junction)" }
    else { Problem "$SrcState is a junction to $srcTarget, not to $Canonical." }
  } elseif ($srcIsDir) {
    $files = @(Get-ChildItem -LiteralPath $SrcState -Recurse -File -Force)
    $mb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
    $links = @(Get-ChildItem -LiteralPath $SrcState -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)
    if ($links.Count) { Problem "$SrcState contains $($links.Count) junction/symlink(s); move them by hand first." }
    if ($canonHas -and -not $canonOurs) { Problem "$Canonical already holds state that this script did not copy: two state dirs. Reconcile them by hand." }
    Info "$SrcState is a real folder: $($files.Count) files, $mb MB"
    Step "robocopy `"$SrcState`" `"$Canonical`" /E /COPY:DAT /XJ   (bulk copy; marker file $Marker)"
    Step "rename $SrcState -> $MovingRoot\state-moving-<stamp>   (the cut; refused while a process holds a file in it)"
    Step "junction $SrcState -> $Canonical"
    Step "robocopy catch-up /XO from the renamed folder, verify every file (same SHA-256, or newer in $Canonical), delete the renamed folder"
    $holders = @(Get-AppProcesses | Where-Object { $_.Path -match '(?i)\\orchestrator\\' })
    foreach ($h in $holders) { Info "  may hold a state file until stopped: pid $($h.Id) $($h.Name) $($h.Path)" }
  } else {
    Step "junction $SrcState -> $Canonical   (no state folder there yet)"
  }
  foreach ($l in $leftovers) { Step "finish an earlier cut: catch-up, verify and delete $($l.FullName)" }

  $liveTarget = Get-JunctionTarget $LiveState
  if ($liveTarget) {
    if (Test-SamePath $liveTarget $Canonical) { Info "already linked: $LiveState -> $Canonical" }
    else { Problem "$LiveState is a junction to $liveTarget, not to $Canonical." }
  } elseif ((Test-Path -LiteralPath $LiveState) -and @(Get-ChildItem -LiteralPath $LiveState -Force).Count -gt 0) {
    Problem "$LiveState is a real, non-empty folder: a second state dir. Merge it into $Canonical by hand."
  } else {
    Step "junction $LiveState -> $Canonical"
  }
}

if (-not $DryRun -and $Direction -eq 'forward' -and $script:Problems.Count -eq 0) {
  New-Item -ItemType Directory -Force -Path $Canonical | Out-Null
  if ($srcIsDir) {
    Set-Content -LiteralPath (Join-Path $Canonical $Marker) -Value "copy from $SrcState in progress" -Encoding ASCII
    Invoke-Robocopy $SrcState $Canonical @()
    New-Item -ItemType Directory -Force -Path $MovingRoot | Out-Null
    $moving = Join-Path $MovingRoot ('state-moving-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try { [IO.Directory]::Move($SrcState, $moving) }
    catch {
      Write-Host "  The cut was refused: a process holds a file in $SrcState ($($_.Exception.Message))."
      $holders = @(Get-AppProcesses | Where-Object { $_.Path -match '(?i)\\orchestrator\\' })
      foreach ($h in $holders) { Write-Host "    pid $($h.Id) $($h.Name) $($h.Path)" }
      if ($holders.Count) { Write-Host ("  Stop it (the dashboard's task restarts it within 5 minutes): Stop-Process -Id " + (($holders | ForEach-Object { $_.Id }) -join ',')) }
      Fail 'then rerun -Apply. The bulk copy is kept and recognised.'
    }
    $leftovers = @($leftovers) + @(Get-Item -LiteralPath $moving)
  }
  if (-not (Get-JunctionTarget $SrcState)) {
    if (Test-Path -LiteralPath $SrcState) {
      # Something wrote between the rename and the junction: fold it in, then link.
      Invoke-Robocopy $SrcState $Canonical @('/XO')
      Remove-Item -LiteralPath $SrcState -Recurse -Force
    }
    New-Item -ItemType Junction -Path $SrcState -Target $Canonical | Out-Null
    Info "junction $SrcState -> $Canonical"
  }
  foreach ($l in $leftovers) {
    Invoke-Robocopy $l.FullName $Canonical @('/XO')
    $bad = Test-Copied $l.FullName $Canonical
    if ($bad.Count) { Warn ("kept $($l.FullName): " + $bad.Count + ' file(s) not verified in the state dir: ' + (($bad | Select-Object -First 5) -join ', ')) }
    else { Remove-Item -LiteralPath $l.FullName -Recurse -Force; Info "verified and removed $($l.FullName)" }
  }
  Remove-Item -LiteralPath (Join-Path $Canonical $Marker) -ErrorAction SilentlyContinue
  if (-not (Get-JunctionTarget $LiveState)) {
    if (Test-Path -LiteralPath $LiveState) { Remove-Item -LiteralPath $LiveState -Force }   # empty, checked above
    New-Item -ItemType Junction -Path $LiveState -Target $Canonical | Out-Null
    Info "junction $LiveState -> $Canonical"
  }
}

# =============================================================================================
# 4. Environment
# =============================================================================================
Section 'Environment (user)'
if ($Direction -eq 'forward') {
  if ($userStateVar -and (Test-SamePath $userStateVar $Canonical)) { Info "ORCHESTRATOR_STATE_DIR already = $Canonical" }
  else {
    $old = if ($userStateVar) { $userStateVar } else { '<unset>' }
    Step "ORCHESTRATOR_STATE_DIR: $old -> $Canonical"
    if (-not $DryRun -and $script:Problems.Count -eq 0) { [Environment]::SetEnvironmentVariable('ORCHESTRATOR_STATE_DIR', $Canonical, 'User') }
  }
} else { Info 'ORCHESTRATOR_STATE_DIR stays (the state stays in one place).' }

# =============================================================================================
# 5. Orchestrator job wrappers (state\jobs\*.cmd / *.vbs): rewritten by text, not regenerated
# =============================================================================================
Section 'Orchestrator job wrappers'
$jobsDir = if ($srcIsDir -and $DryRun) { Join-Path $SrcState 'jobs' } else { Join-Path $Canonical 'jobs' }
if (-not (Test-Path -LiteralPath $jobsDir)) { Info "no job wrappers in $jobsDir" }
else {
  Info "in $jobsDir (shown as they will read after the state move)"
  foreach ($f in Get-ChildItem -LiteralPath $jobsDir -File | Where-Object { $_.Extension -in '.cmd', '.vbs' } | Sort-Object Name) {
    $text = [IO.File]::ReadAllText($f.FullName)
    $new = Convert-PathText $text
    $hit = $script:Hit
    $pin = $false
    if ($Direction -eq 'forward' -and $f.Extension -eq '.cmd' -and $f.Name -notlike '*.work.cmd' -and
        $new -match '^@echo off\r?\n' -and $new -notmatch 'ORCHESTRATOR_STATE_DIR=') {
      $nl = if ($new -match '\r\n') { "`r`n" } else { "`n" }
      $new = $new -replace '^@echo off\r?\n', ("@echo off" + $nl + "set `"ORCHESTRATOR_STATE_DIR=$Canonical`"" + $nl)
      $pin = $true
    }
    foreach ($k in ($hit.Kept | Select-Object -Unique)) { Warn "$($f.Name) keeps app\$k (not on origin/main, so the live checkout has no copy)" }
    if ($new -ceq $text) { Info "$($f.Name): no change"; continue }
    $what = if ($Direction -eq 'back') { "$($hit.Back) live path(s) -> app" }
            else { "$($hit.State) path(s) -> state dir, $($hit.Live) -> live" + $(if ($pin) { ', pins ORCHESTRATOR_STATE_DIR' } else { '' }) }
    Step "$($f.Name): $what"
    if (-not $DryRun -and $script:Problems.Count -eq 0) { [IO.File]::WriteAllText($f.FullName, $new, (New-Object System.Text.UTF8Encoding($false))) }
  }
}

# =============================================================================================
# 6. Scheduled tasks: same executable, same switches, same triggers; only paths change
# =============================================================================================
Section 'Scheduled tasks'
$needle = if ($Direction -eq 'back') { $LiveRx } else { $AppRx }
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    ($_.Actions | Where-Object { $_.PSObject.Properties['Execute'] } | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -match $needle
  } | Sort-Object TaskName)
if (-not $tasks.Count) { Info ('no task points at the ' + $(if ($Direction -eq 'back') { 'live' } else { 'working' }) + ' checkout.') }
foreach ($t in $tasks) {
  $newActions = @()
  Info "$($t.TaskPath)$($t.TaskName)"
  foreach ($a in $t.Actions) {
    $exe = Convert-PathText $a.Execute; $kept = @($script:Hit.Kept)
    $arg = Convert-PathText $a.Arguments; $kept += @($script:Hit.Kept)
    $wd = Convert-PathText $a.WorkingDirectory; $kept += @($script:Hit.Kept)
    foreach ($k in $kept) { Warn "$($t.TaskName) keeps app\$k (not on origin/main)" }
    Info "    old: $($a.Execute) $($a.Arguments)$(if ($a.WorkingDirectory) { "   [in $($a.WorkingDirectory)]" })"
    Info "    new: $exe $arg$(if ($wd) { "   [in $wd]" })"
    $p = @{ Execute = $exe }
    if ($arg) { $p.Argument = $arg }
    if ($wd) { $p.WorkingDirectory = $wd }
    $newActions += New-ScheduledTaskAction @p
  }
  Step "Set-ScheduledTask -TaskPath '$($t.TaskPath)' -TaskName '$($t.TaskName)' -Action <new>"
  if (-not $DryRun -and $script:Problems.Count -eq 0) {
    try { Set-ScheduledTask -TaskPath $t.TaskPath -TaskName $t.TaskName -Action $newActions | Out-Null }
    catch { Warn "could not update $($t.TaskName): $($_.Exception.Message)" }
  }
}

# =============================================================================================
# 7. Launchers: shortcuts and the Run key that start the tray (its config is relative, so only
#    the launch path moves)
# =============================================================================================
Section 'Launchers (tray and instance shortcuts, Run key)'
$shell = New-Object -ComObject WScript.Shell
$lnkDirs = @($App, [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('Programs')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$lnks = @(foreach ($d in $lnkDirs) { Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File -ErrorAction SilentlyContinue })
$lnks += @(Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Programs')) -Directory -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.lnk' -File -ErrorAction SilentlyContinue })
$anyLauncher = $false
foreach ($f in $lnks) {
  $l = $shell.CreateShortcut($f.FullName)
  $tp = Convert-PathText $l.TargetPath; $h1 = $script:Hit
  $ar = Convert-PathText $l.Arguments; $h2 = $script:Hit
  $wd = Convert-PathText $l.WorkingDirectory; $h3 = $script:Hit
  if ($tp -ceq $l.TargetPath -and $ar -ceq $l.Arguments -and $wd -ceq $l.WorkingDirectory) { continue }
  $anyLauncher = $true
  foreach ($k in @($h1.Kept) + @($h2.Kept) + @($h3.Kept)) { Warn "$($f.Name) keeps app\$k (not on origin/main)" }
  Info "$($f.FullName)"
  Info "    old: $($l.TargetPath) $($l.Arguments)   [in $($l.WorkingDirectory)]"
  Info "    new: $tp $ar   [in $wd]"
  Step "rewrite shortcut $($f.Name)"
  if (-not $DryRun -and $script:Problems.Count -eq 0) { $l.TargetPath = $tp; $l.Arguments = $ar; $l.WorkingDirectory = $wd; $l.Save() }
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$run = Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
if ($run) {
  foreach ($p in $run.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' }) {
    $v = [string]$p.Value
    $nv = Convert-PathText $v
    if ($nv -ceq $v) { continue }
    $anyLauncher = $true
    Step "Run key '$($p.Name)': $v -> $nv"
    if (-not $DryRun -and $script:Problems.Count -eq 0) { Set-ItemProperty -LiteralPath $runKey -Name $p.Name -Value $nv }
  }
}
if (-not $anyLauncher) { Info 'none to change.' }

# =============================================================================================
# 8. What still runs the old code, and the one restart step
# =============================================================================================
Section 'Running now from the working checkout (left running; nothing is stopped by this script)'
$procs = @(Get-AppProcesses)
if (-not $procs.Count) { Info 'none.' }
foreach ($p in $procs) { Info "pid $($p.Id) $($p.Name) $($p.Path)" }

$restartRoot = if ($Direction -eq 'back') { $App } else { $Live }
Section 'Restart step (for the operator; this script never runs it)'
Info "powershell -NoProfile -ExecutionPolicy Bypass -File `"$restartRoot\misc\Restart-Daemon.ps1`""
Info '(restarts the daemon and the tray from that checkout; CliMayte runners and the HSwarm sidecar follow the daemon.'
Info ' The job lanes start from the rewritten tasks on their next tick. A dashboard listed above keeps the old code'
Info ' until it is stopped; its task then restarts it from the live checkout within 5 minutes.)'

Write-Host ''
if ($script:Problems.Count) {
  Write-Host "NOT COHERENT: $($script:Problems.Count) problem(s), $($script:Warnings.Count) warning(s). Nothing was changed past the first problem."
  exit 1
}
$verb = if ($DryRun) { 'Plan is coherent' } else { 'Done' }
Write-Host "$verb ($ModeName): 0 problems, $($script:Warnings.Count) warning(s)."
exit 0
