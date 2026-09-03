# tray.ps1 - THE ORCHESTRATOR TRAY: the human on/off switch, as a status-bar icon.
#
# What it is (owner ask, 2026-08-31: "a little icon so I can close it later if I don't want
# it"): a green dot in the notification area while the robot eyes (the Orchestrator-*
# scheduled tasks) are firing, a gray dot while they are paused. Right-click:
#
#   Open dashboard          the read-only decision dashboard (127.0.0.1:7799)
#   Open the remote dashboard   the same thing from anywhere, at the permanent address
#   Copy the remote address     that URL, for a phone
#   Remote access: on/off   opens or closes the Cloudflare tunnel
#   Restart remote access   stop + start the gateway (after a config change)
#   What is running now     balloon listing the orchestrator jobs alive this second
#   Pause the eyes          schtasks /Change /DISABLE on ALL of them - registered but silent
#   Resume the eyes         /ENABLE - firing again on the next boundary
#   STOP EVERYTHING NOW     pause the eyes AND kill every orchestrator job already running
#   Open the logs folder    every tick's output, one log per job
#   Stop dashboard server   kills the pythonw serving :7799 (the keepalive task revives it
#                           within 5 minutes UNLESS the eyes are paused)
#   Exit tray               closes the icon, pauses the eyes AND closes remote access -
#                           nothing acts, and nothing is reachable, without the icon
#
# THIS ICON OWNS REMOTE ACCESS (owner ask, 2026-09-02: "I wouldn't want this open in like a
# console... I would want this open in like a status bar icon"). It starts the gateway
# (server/src/main.ts) on launch, watchdogs it every 15 seconds, and stops it on Exit. The
# gateway watches back: started with ORCH_TRAY_SUPERVISED it reads this same heartbeat and
# shuts itself down when the beat goes stale, so even a HARD kill of this icon takes remote
# access with it. Pausing the eyes deliberately does NOT close the tunnel - a paused icon still
# beats - because otherwise pausing from your phone would cut the connection you need to
# un-pause. Only Exit, or "Remote access: off", shuts the door.
#
# ⛔ THE ICON IS THE SWITCH (owner, 2026-09-01: "it can't be running without the status bar
# icon, so I can terminate it if I want"). While this icon is up it writes a HEARTBEAT
# (state/tray.json: pid, time, paused) every 15 seconds, and every acting lane - moving,
# waking, archiving, pressing, stamping, writing - checks that heartbeat (lib/armlib) before
# it touches anything. No icon, a stale beat, a dead pid, or Pause from this menu all read as
# DISARMED: the lanes plan and report, nothing more. Starting the icon PUTS the switch in reach
# without throwing it - it comes up paused (see the Set-Eyes call at the bottom); Exit (or
# killing the process) stops everything with it. There is nothing to remember.
#
# Honesty notes: pausing the eyes stops the WATCHERS. It does not touch the AgentHydra
# daemon, the desktop apps, or any chat - the orchestrator never restarts or closes those,
# and neither does this. Pausing also does NOT stop a job already mid-run; that is what
# STOP EVERYTHING NOW is for.
#
# Install: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray.ps1 -InstallShortcut
# puts "Orchestrator" on the Desktop; double-click starts the icon (hidden window).
# Add -Startup to also start it automatically at every login.

param([switch]$InstallShortcut, [switch]$Startup, [switch]$SelfTest, [switch]$Resumed)

$ErrorActionPreference = "SilentlyContinue"
$Repo = Split-Path $PSScriptRoot -Parent
$DashUrl = "http://127.0.0.1:7799"
$Logs = Join-Path $Repo "state\logs"
# The heartbeat armlib reads. ORCHESTRATOR_STATE_DIR is honoured so a test can point it away.
$StateDir = if ($env:ORCHESTRATOR_STATE_DIR) { $env:ORCHESTRATOR_STATE_DIR } else { Join-Path $Repo "state" }
$Heartbeat = Join-Path $StateDir "tray.json"
# One-shot resume/pause request dropped by `orch.py resume|pause`; the tick applies and clears it.
$EyesRequest = Join-Path $StateDir "eyes-request.json"
# The icon now starts PAUSED unless -Resumed is passed (see the Set-Eyes call at the bottom).
$script:Paused = $true

function Write-Heartbeat([bool]$paused) {
    # Atomic: write beside, then move over - a lane must never read a half-written beat.
    try {
        if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
        $ms = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $flag = if ($paused) { "true" } else { "false" }
        $json = '{"pid": ' + $PID + ', "at": ' + $ms + ', "paused": ' + $flag + '}'
        $tmp = "$Heartbeat.$PID.tmp"
        [System.IO.File]::WriteAllText($tmp, $json)
        Move-Item -Force $tmp $Heartbeat
    } catch { }
}

function Remove-Heartbeat {
    try { Remove-Item -Force $Heartbeat -ErrorAction SilentlyContinue } catch { }
}

# ── THE REMOTE FRONT-END ───────────────────────────────────────────────────────
# This icon OWNS the remote gateway (server/src/main.ts): it starts it, watches it, and takes
# it down again on Exit. That is not tidiness, it is the owner's rule applied to the one part
# of the system that can be reached from outside the house - the gateway can throw the arm
# switch from a phone, so a gateway running with no icon on screen would be a way to arm this
# machine with no kill switch in reach. The gateway enforces the same thing from its own side
# (ORCH_TRAY_SUPERVISED + server/src/switch.ts watchTray), so a HARD kill of this icon takes
# remote access down too, not just an orderly Exit.
#
# PAUSE KEEPS IT UP, deliberately. A paused icon still beats, so the lanes stop while the
# dashboard stays reachable - otherwise pausing from the phone would cut the connection you
# need to un-pause. Only Exit (or "Remote access: off") closes the door.
$RemotePrefFile = Join-Path $StateDir "remote\tray-remote.json"
$RemoteStatusFile = Join-Path $StateDir "remote\status.json"
$RemotePort = if ($env:ORCH_REMOTE_PORT) { [int]$env:ORCH_REMOTE_PORT } else { 7790 }
$RemoteLocalUrl = "http://127.0.0.1:$RemotePort"
$script:RemoteFailures = 0
# After this many consecutive failed starts the icon stops retrying and says so. A watchdog
# that hammers a broken start forever is the v2 mistake this whole program was rebuilt to avoid.
$RemoteFailureCap = 3

function Get-RemoteEnabled {
    try {
        if (Test-Path $RemotePrefFile) {
            return [bool]((Get-Content -Raw $RemotePrefFile | ConvertFrom-Json).enabled)
        }
    } catch { }
    return $true   # remote access is the point of the feature; default it on
}

function Set-RemoteEnabled([bool]$on) {
    try {
        $dir = Split-Path -Parent $RemotePrefFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
        $flag = if ($on) { "true" } else { "false" }
        [System.IO.File]::WriteAllText($RemotePrefFile, '{"enabled": ' + $flag + '}')
    } catch { }
}

function Test-RemoteUp {
    try {
        $r = Invoke-WebRequest "$RemoteLocalUrl/api/health" -TimeoutSec 4 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch { return $false }
}

# The public address the gateway settled on, straight from the file it writes. A named tunnel
# reports its own stable hostname; a quick tunnel reports the relay's permanent /r/<id> URL.
function Get-RemoteAddress {
    try {
        $s = Get-Content -Raw $RemoteStatusFile | ConvertFrom-Json
        if ($s.stableUrl) { return $s.stableUrl }
        if ($s.tunnelUrl) { return $s.tunnelUrl }
    } catch { }
    return $RemoteLocalUrl
}

function Start-Remote {
    if (Test-RemoteUp) { return $true }
    # ORCH_TRAY_SUPERVISED is what tells the gateway to die with this icon. The child inherits
    # it, and remote.py spawns bun detached and window-less, so nothing ever flashes a console.
    $env:ORCH_TRAY_SUPERVISED = "1"
    & python (Join-Path $PSScriptRoot "remote.py") --start --quiet 2>&1 | Out-Null
    if (Test-RemoteUp) { $script:RemoteFailures = 0; return $true }
    $script:RemoteFailures++
    return $false
}

function Stop-Remote {
    & python (Join-Path $PSScriptRoot "remote.py") --stop 2>&1 | Out-Null
}

# The task list is DISCOVERED, never hardcoded. A hardcoded list is exactly how "Pause the
# eyes" turned into a half-off switch: on 2026-09-01 this file named 4 tasks while 9 were
# registered, so pausing left doctrine, groundskeeper, saturate, twins and unblock firing
# every few minutes behind an icon that read PAUSED. A false off-switch is worse than no
# switch, so the tray now asks Windows what exists each time it looks.
# The two lanes the icon never touches: the dashboard only looks, and the doctrine lane only
# configures - owner, 2026-09-01: "a constant check for any chats that are not bypass
# permissions... autonomously, as long as it's programmatically." They stay enabled whether
# the icon is up, paused or gone (schedule_jobs.UNGATED_JOBS is the same list).
# chat-journal joined them on 2026-09-02: it only WRITES DOWN what happened to chats (who
# archived/moved/renamed what, and whether this orchestrator can prove it was us). Pausing it
# with the acting lanes would blind the record during exactly the window you later need
# explained - "the orchestrator was off" is when you most want to know what touched a chat.
# ⛔ THIS LIST IS DUPLICATED in schedule_jobs.UNGATED_JOBS and the two MUST agree; adding a
# lane to one and not the other is how this file's own 4-vs-9 false off-switch happened.
$AlwaysOn = @('Orchestrator-dashboard', 'Orchestrator-doctrine', 'Orchestrator-chat-journal')

function Get-OrchTaskNames {
    $rows = schtasks /query /fo csv 2>$null | ConvertFrom-Csv
    $names = $rows |
        Where-Object { $_.TaskName -match '^\\Orchestrator-' } |
        ForEach-Object { $_.TaskName.TrimStart('\') } |
        Where-Object { $AlwaysOn -notcontains $_ } |
        Sort-Object -Unique
    if (-not $names) { return @() }
    return @($names)
}

if ($InstallShortcut -or $Startup) {
    $sh = New-Object -ComObject WScript.Shell
    $targets = @()
    if ($InstallShortcut) { $targets += Join-Path ([Environment]::GetFolderPath("Desktop")) "Orchestrator.lnk" }
    if ($Startup) { $targets += Join-Path ([Environment]::GetFolderPath("Startup")) "Orchestrator Tray.lnk" }
    foreach ($lnk in $targets) {
        $s = $sh.CreateShortcut($lnk)
        # wscript + a .vbs stub, NOT powershell.exe directly: -WindowStyle Hidden still creates
        # a console and hides it a beat later, so a shortcut to powershell flashes a black box on
        # every launch and again at every login (owner, 2026-09-02: "I wouldn't want this open in
        # like a console"). Windows Script Host with mode 0 never creates one at all - the same
        # pattern the LunarWerx tray apps use.
        $s.TargetPath = "wscript.exe"
        $s.Arguments = "`"$(Join-Path $PSScriptRoot 'tray-launch.vbs')`""
        $s.WorkingDirectory = $Repo
        $s.IconLocation = "shell32.dll,22"
        $s.Description = "Orchestrator: the arm switch, the dashboard, and remote access"
        $s.Save()
        Write-Host "Shortcut created: $lnk"
    }
    exit 0
}

# -SelfTest: prove every moving part WITHOUT showing an icon and WITHOUT touching the lanes.
# The icon now comes up paused, so a real launch no longer arms anything by itself - but it does
# put an icon on the owner's screen, start remote access, and open a public tunnel, none of which
# belong in a check that a script parses. (It mattered more than that once: an audit agent told
# only "do not launch the tray for real" launched it anyway, back when launching armed every lane
# - see the shared memory note on briefing agents against a live machine.)
# Same idea as the LunarWerx tray engine's own self-test.
if ($SelfTest) {
    $fail = 0
    function Check([string]$what, [bool]$ok, [string]$detail = "") {
        if ($ok) { Write-Host "  ok    $what $detail" }
        else { Write-Host "  FAIL  $what $detail"; $script:selfTestFail = $true }
    }
    $script:selfTestFail = $false
    Write-Host "Orchestrator tray self-test (nothing is armed, no icon is shown)"
    Check "repo resolved" (Test-Path (Join-Path $Repo "orch.py")) $Repo
    Check "launcher present" (Test-Path (Join-Path $PSScriptRoot "tray-launch.vbs"))
    Check "remote.py present" (Test-Path (Join-Path $PSScriptRoot "remote.py"))
    Check "state dir writable" (Test-Path $StateDir) $StateDir
    $tasks = Get-OrchTaskNames
    Check "gated lanes discovered" ($tasks.Count -gt 0) "$($tasks.Count) task(s), always-on excluded"
    Check "no ungated remote lane" (-not (schtasks /query /tn "Orchestrator-remote" 2>$null)) "a keepalive here would outlive the icon"
    Write-Host "  info  remote preference: $(if (Get-RemoteEnabled) { 'ON' } else { 'OFF' })"
    $up = Test-RemoteUp
    Write-Host "  info  gateway on ${RemoteLocalUrl}: $(if ($up) { 'serving' } else { 'not serving' })"
    if ($up) { Write-Host "  info  public address: $(Get-RemoteAddress)" }
    if ($script:selfTestFail) { Write-Host "SELF-TEST FAILED"; exit 1 }
    Write-Host "SELF-TEST PASSED"
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# One tray per machine: a second launch just exits (the mutex is per-session, which is
# exactly the scope a tray icon has).
$script:mutex = New-Object System.Threading.Mutex($false, "OrchestratorTray")
if (-not $script:mutex.WaitOne(0)) { exit 0 }

$script:Tasks = Get-OrchTaskNames

function Get-EnabledCount {
    $script:Tasks = Get-OrchTaskNames
    $n = 0
    foreach ($t in $script:Tasks) {
        $rows = schtasks /query /tn $t /fo csv /v 2>$null | ConvertFrom-Csv
        if ($rows -and $rows[0].'Scheduled Task State' -ne 'Disabled') { $n++ }
    }
    return $n
}

# Every python process whose command line points inside this repo - the dashboard server and
# whatever job a tick has spawned. Matching on the repo path (not on "python") is what keeps
# this from reaching into unrelated python work running on the same machine.
function Get-OrchProcesses {
    $pattern = [regex]::Escape($Repo)
    return @(Get-CimInstance Win32_Process |
        Where-Object { $_.Name -match "python" -and $_.CommandLine -match $pattern })
}

function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = "AntiAlias"
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 2, 2, 12, 12)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$iconOn = New-DotIcon ([System.Drawing.Color]::FromArgb(46, 160, 67))
$iconOff = New-DotIcon ([System.Drawing.Color]::FromArgb(140, 140, 140))

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = $true

function Update-Face {
    $on = Get-EnabledCount
    $total = $script:Tasks.Count
    $live = (Get-OrchProcesses).Count
    if ($total -eq 0) {
        $notify.Icon = $iconOff
        $head = "Orchestrator: no scheduled tasks registered"
    } elseif ($on -eq $total) {
        $notify.Icon = $iconOn
        $head = "Orchestrator eyes: ON ($total tasks, $live job(s) running)"
    } elseif ($on -eq 0) {
        $notify.Icon = $iconOff
        $head = "Orchestrator eyes: PAUSED ($live job(s) still running)"
    } else {
        $notify.Icon = $iconOn
        $head = "Orchestrator eyes: PARTIAL ($on of $total on)"
    }
    $remote = if (-not (Get-RemoteEnabled)) { "remote off" } elseif (Test-RemoteUp) { "remote on" } else { "remote starting" }
    # A tooltip is capped at 63 characters by the shell and is silently TRUNCATED past it, so
    # the state that matters (the eyes) leads and the remote clause is trimmed, never the other
    # way round.
    $text = "$head - $remote"
    if ($text.Length -gt 63) { $text = $text.Substring(0, 60) + "..." }
    $notify.Text = $text
    return $on
}

function Set-Eyes([bool]$enable) {
    foreach ($t in $script:Tasks) {
        $flag = if ($enable) { "/ENABLE" } else { "/DISABLE" }
        schtasks /change /tn $t $flag 2>&1 | Out-Null
    }
    # The heartbeat carries the pause too: a paused icon is visible but reads as disarmed.
    $script:Paused = -not $enable
    Write-Heartbeat $script:Paused
    $on = Update-Face
    $word = if ($enable) { "resumed - firing again on the next boundary" } else { "paused - registered but silent until Resume" }
    $notify.ShowBalloonTip(2500, "Orchestrator", "The eyes are $word.", [System.Windows.Forms.ToolTipIcon]::Info)
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = $menu.Items.Add("...")
$miStatus.Enabled = $false
$menu.Items.Add("-") | Out-Null
$miDash = $menu.Items.Add("Open dashboard (this machine)")
$miDash.add_Click({ Start-Process $DashUrl })

# ── remote access ──────────────────────────────────────────────────────────────
$miRemoteOpen = $menu.Items.Add("Open the remote dashboard")
$miRemoteOpen.add_Click({ Start-Process (Get-RemoteAddress) })
$miRemoteCopy = $menu.Items.Add("Copy the remote address")
$miRemoteCopy.add_Click({
    $addr = Get-RemoteAddress
    try { Set-Clipboard -Value $addr } catch { }
    $notify.ShowBalloonTip(4000, "Orchestrator", "Copied: $addr", [System.Windows.Forms.ToolTipIcon]::Info)
})
$miRemoteToggle = $menu.Items.Add("...")
$miRemoteToggle.add_Click({
    if (Get-RemoteEnabled) {
        Set-RemoteEnabled $false
        Stop-Remote
        $notify.ShowBalloonTip(4000, "Orchestrator",
            "Remote access is OFF. The tunnel is closed and the permanent address answers nothing until you turn it back on.",
            [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Set-RemoteEnabled $true
        $script:RemoteFailures = 0
        if (Start-Remote) {
            $notify.ShowBalloonTip(5000, "Orchestrator", "Remote access is ON: $(Get-RemoteAddress)",
                [System.Windows.Forms.ToolTipIcon]::Info)
        } else {
            $notify.ShowBalloonTip(6000, "Orchestrator",
                "The gateway did not come up. See state\logs\remote-gateway.log.",
                [System.Windows.Forms.ToolTipIcon]::Error)
        }
    }
    Update-Face | Out-Null
})
$miRemoteRestart = $menu.Items.Add("Restart remote access")
$miRemoteRestart.add_Click({
    Stop-Remote
    $script:RemoteFailures = 0
    Set-RemoteEnabled $true
    if (Start-Remote) {
        $notify.ShowBalloonTip(5000, "Orchestrator", "Remote access restarted: $(Get-RemoteAddress)",
            [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        $notify.ShowBalloonTip(6000, "Orchestrator",
            "The gateway did not come back. See state\logs\remote-gateway.log.",
            [System.Windows.Forms.ToolTipIcon]::Error)
    }
})
$menu.Items.Add("-") | Out-Null
$miRunning = $menu.Items.Add("What is running right now")
$miRunning.add_Click({
    $procs = Get-OrchProcesses
    if ($procs.Count -eq 0) {
        $body = "No orchestrator jobs are running this second."
    } else {
        $body = ($procs | ForEach-Object {
            $leaf = ($_.CommandLine -split '\\')[-1] -replace '"', ''
            "$leaf (pid $($_.ProcessId))"
        }) -join "`n"
    }
    $notify.ShowBalloonTip(6000, "Orchestrator jobs running", $body, [System.Windows.Forms.ToolTipIcon]::Info)
})
$miToggle = $menu.Items.Add("...")
$miToggle.add_Click({
    if ((Get-EnabledCount) -eq $script:Tasks.Count) { Set-Eyes $false } else { Set-Eyes $true }
})
$miPanic = $menu.Items.Add("STOP EVERYTHING NOW (pause + kill running jobs)")
$miPanic.add_Click({
    Set-Eyes $false
    $procs = Get-OrchProcesses
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Update-Face | Out-Null
    $notify.ShowBalloonTip(5000, "Orchestrator",
        "Eyes paused and $($procs.Count) running job(s) killed. Nothing starts again until you pick Resume.",
        [System.Windows.Forms.ToolTipIcon]::Warning)
})
$miLogs = $menu.Items.Add("Open the logs folder")
$miLogs.add_Click({
    if (-not (Test-Path $Logs)) { New-Item -ItemType Directory -Force $Logs | Out-Null }
    Start-Process $Logs
})
$miKillDash = $menu.Items.Add("Stop dashboard server")
$miKillDash.add_Click({
    Get-CimInstance Win32_Process |
        Where-Object { $_.Name -match "python" -and $_.CommandLine -match "dashboard\.py" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    $notify.ShowBalloonTip(2500, "Orchestrator",
        "Dashboard server stopped. The keepalive revives it within 5 minutes unless the eyes are paused.",
        [System.Windows.Forms.ToolTipIcon]::Info)
})
$menu.Items.Add("-") | Out-Null
$miExit = $menu.Items.Add("Exit tray (pauses the eyes - nothing acts without the icon)")
$miExit.add_Click({
    # No icon = nothing acts: the beat goes first, so a tick landing mid-exit already
    # reads DISARMED, then the eyes are paused so they do not even fire.
    Remove-Heartbeat
    foreach ($t in $script:Tasks) { schtasks /change /tn $t /DISABLE 2>&1 | Out-Null }
    # ...and no icon = nothing REACHABLE either. The gateway would notice the dead heartbeat
    # and stop itself within ~30s anyway; closing it here makes the door shut immediately.
    Stop-Remote
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$menu.add_Opening({
    $on = Update-Face
    $miStatus.Text = $notify.Text
    $miToggle.Text = if ($on -eq $script:Tasks.Count -and $script:Tasks.Count -gt 0) { "Pause the eyes ($($script:Tasks.Count) tasks)" } else { "Resume the eyes ($($script:Tasks.Count) tasks)" }
    # Say what is TRUE right now, not what the preference says: a gateway that died reads OFF
    # here rather than pretending the address still answers.
    $remoteUp = Test-RemoteUp
    $miRemoteToggle.Text = if (Get-RemoteEnabled) { "Remote access: ON - turn it off" } else { "Remote access: OFF - turn it on" }
    $miRemoteOpen.Enabled = $remoteUp
    $miRemoteCopy.Enabled = $remoteUp
    $miRemoteOpen.Text = if ($remoteUp) { "Open the remote dashboard  ($(Get-RemoteAddress))" } else { "Open the remote dashboard  (not serving)" }
})
$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Start-Process $DashUrl })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000   # armlib.HEARTBEAT_SECS; STALE_SECS is 60, so three missed beats = gone
$timer.add_Tick({
    # THE CLI'S HALF OF THE SWITCH. The icon owns the heartbeat and rewrites it every tick, so
    # a command-line resume cannot just poke state\tray.json - this tick would stamp its own
    # $script:Paused straight back over it within 15 seconds. Instead `orch.py resume|pause`
    # drops a one-shot request here and the icon, which is the only thing allowed to move the
    # switch, applies it and deletes it. Same door as the menu item, reachable without a mouse.
    try {
        if (Test-Path $EyesRequest) {
            $want = (Get-Content -Raw $EyesRequest) -match '"resume"\s*:\s*true'
            Remove-Item -Force $EyesRequest -ErrorAction SilentlyContinue
            if ($want -ne (-not $script:Paused)) { Set-Eyes ([bool]$want) }
        }
    } catch { }
    Write-Heartbeat $script:Paused
    # THE GATEWAY WATCHDOG. It replaces the scheduled keepalive lane the remote front-end
    # shipped with, and it had to: that task was ungated, so it revived remote access within
    # five minutes of the icon being closed - a kill switch the machine quietly undid. The
    # watchdog lives here instead, where it can only ever run while the icon is on screen.
    if ((Get-RemoteEnabled) -and $script:RemoteFailures -lt $RemoteFailureCap) {
        if (-not (Test-RemoteUp)) {
            $wasFailing = $script:RemoteFailures
            if (Start-Remote) {
                if ($wasFailing -gt 0) {
                    $notify.ShowBalloonTip(4000, "Orchestrator", "Remote access recovered: $(Get-RemoteAddress)",
                        [System.Windows.Forms.ToolTipIcon]::Info)
                }
            } elseif ($script:RemoteFailures -ge $RemoteFailureCap) {
                # Say it once and stop trying. A watchdog that hammers a broken start forever
                # is exactly the futile-retry shape this program was rebuilt to eliminate.
                $notify.ShowBalloonTip(8000, "Orchestrator",
                    "Remote access failed to start $RemoteFailureCap times - no more attempts. Use 'Restart remote access' after checking state\logs\remote-gateway.log.",
                    [System.Windows.Forms.ToolTipIcon]::Error)
            }
        }
    }
    Update-Face | Out-Null
})
$timer.Start()

# STARTING THE ICON PUTS THE SWITCH IN REACH - IT DOES NOT THROW IT (owner, 2026-09-02:
# "it should probably launch on pause so that it doesn't just immediately start working").
# The icon used to call `Set-Eyes $true` here unconditionally, so arming and ACTING were the
# same keystroke: every registered lane went live on the next 5-minute boundary before anyone
# had looked at what was queued. Now the default is PAUSED - visible, beating, reachable, and
# silent - and starting the lanes is a second, deliberate act (`orch.py resume`, or Resume on
# this menu). `-Resumed` restores the old one-step behaviour for callers that really mean it.
Set-Eyes ([bool]$Resumed)
if (-not $Resumed) {
    $notify.ShowBalloonTip(4000, "Orchestrator",
        "Armed but PAUSED - nothing acts. Pick 'Resume the eyes' (or run: python orch.py resume).",
        [System.Windows.Forms.ToolTipIcon]::Info)
}
if (Get-RemoteEnabled) { Start-Remote | Out-Null }
Update-Face | Out-Null
[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$notify.Visible = $false
# Every exit path, not just the menu's: a crash or a closed session must close the door too.
Stop-Remote
# Any way out of the loop (Exit, a closed session, a script error) takes the beat with it:
# a lane reading a beat from an icon that is no longer on screen would be the false ON this
# whole design exists to rule out.
Remove-Heartbeat
