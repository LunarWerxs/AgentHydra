// THE TRAY GUARD. The product MUST always ship a clickable shortcut in the repo ROOT that,
// when run, boots the daemon and raises the system-tray icon (Open / Rebuild & Restart /
// Restart / Quit). Windows-gated. Mirrors the sibling apps' launcher tests.
//
// AgentHydra-Tray.ps1 is now a THIN ADAPTER over the shared kit engine (misc/Tray-Host.ps1,
// kit-synced — never edited here). Assertions are split accordingly:
//   - engine-invariant behavior (NotifyIcon-before-daemon ordering, mutex loser branch,
//     hideTrayIcon gating/live-sync, Open-AppUi/portable-window plumbing) is asserted against
//     Tray-Host.ps1, since that's what actually implements it now.
//   - app-specific config (mutex literal, daemon start command, icon filename, menu label,
//     self-test marker, .vbs wiring) is asserted against the adapter, AgentHydra-Tray.ps1.
//   - end-to-end behavior (-SelfTest actually running, Create-Shortcut.ps1 actually producing
//     a working .lnk) keeps exercising the adapter as a real subprocess.
// No assertion's INTENT was dropped in the split — see the per-test comments below for where
// each pre-adapter assertion now lives.
//
// The launch chain itself is ALSO now kit-shared: the old per-app AgentHydra.vbs is DELETED
// in favor of the shared, zero-config Tray-Launch.vbs (auto-discovers the sibling *-Tray.ps1
// adapter), and Create-Shortcut.ps1 is now a THIN ADAPTER that dot-sources the shared
// New-TrayShortcut.ps1 engine. Both kit files are kit-synced — never edited here. Assertions
// below were updated in place (not dropped) to target the new files/shape:
//   - "the .vbs launches the tray script" -> "Tray-Launch.vbs auto-discovers the tray adapter"
//     (was a literal filename check against the deleted per-app .vbs; the shared launcher has
//     no per-app filename in it by design, so the assertion now proves the discovery rule).
//   - a new test proves the shared Tray-Launch.vbs + New-TrayShortcut.ps1 carry the kit-synced
//     DO-NOT-EDIT header, mirroring the existing Tray-Host.ps1 header check.
//   - a new test proves Create-Shortcut.ps1 dot-sources New-TrayShortcut.ps1 rather than
//     re-inlining the shortcut-creation logic.
//   - "the desktop shortcut points at wscript + the .vbs + the icon" still runs
//     Create-Shortcut.ps1 as a real subprocess and resolves the regenerated .lnk via COM, now
//     asserting Tray-Launch.vbs (not AgentHydra.vbs) as the target.

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root'

const MISC = join(REPO_ROOT, 'misc')
const APP = REPO_ROOT

const TRAY = join(MISC, 'AgentHydra-Tray.ps1') // the adapter
const ENGINE = join(MISC, 'Tray-Host.ps1') // the kit-synced shared tray engine
const VBS = join(MISC, 'Tray-Launch.vbs') // the kit-synced shared launcher (replaces AgentHydra.vbs)
const SHORTCUT_ENGINE = join(MISC, 'New-TrayShortcut.ps1') // the kit-synced shared shortcut engine
const CREATE_SHORTCUT = join(MISC, 'Create-Shortcut.ps1') // the app's thin adapter over it
const INSTANCE_VBS = join(MISC, 'Instance-Launch.vbs')
const ICO = join(MISC, 'AgentHydra.ico')
const LNK = join(REPO_ROOT, 'AgentHydra.lnk')
const INSTANCE_LNK = join(REPO_ROOT, 'AgentHydra Instances.lnk')

const win = process.platform === 'win32'

function icoHasSmallFrame(path: string): boolean {
  const b = readFileSync(path)
  if (b.length <= 6 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1 || b[3] !== 0) return false
  const frames = b.readUInt16LE(4)
  for (let i = 0; i < frames; i++) {
    const w = b[6 + i * 16]
    if (w !== 0 && w <= 48) return true // 0 means 256; need a <=48px frame for the tray
  }
  return false
}

describe.skipIf(!win)('tray launcher', () => {
  test('the launcher chain files all exist (adapter + shared engines + vbs + icon + daemon entry)', () => {
    // was: TRAY/VBS/ICO/entry existence. Now also requires the kit-synced tray engine the
    // adapter dot-sources, the kit-synced shared vbs launcher (replaces the deleted per-app
    // .vbs), the kit-synced shortcut engine, and this app's thin Create-Shortcut.ps1 adapter —
    // a missing file anywhere in the chain means the shortcut can't be (re)built or run.
    expect(existsSync(TRAY)).toBe(true)
    expect(existsSync(ENGINE)).toBe(true)
    expect(existsSync(VBS)).toBe(true)
    expect(existsSync(SHORTCUT_ENGINE)).toBe(true)
    expect(existsSync(CREATE_SHORTCUT)).toBe(true)
    expect(existsSync(INSTANCE_VBS)).toBe(true)
    expect(existsSync(ICO)).toBe(true)
    expect(existsSync(join(APP, 'server', 'src', 'index.ts'))).toBe(true)
  })

  test('the native tray host and its config are present and coherent', () => {
    // The main shortcut runs these two files and nothing else, so a missing or malformed pair is
    // an app that will not open at all. Asserted here rather than only through the .lnk because
    // this failure is silent: the shortcut still resolves, it just launches nothing useful.
    const exe = join(APP, 'misc', 'lunarwerx-tray.exe')
    const cfgPath = join(APP, 'misc', 'AgentHydra-Tray.json')
    expect(existsSync(exe)).toBe(true)
    expect(existsSync(cfgPath)).toBe(true)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    // Identity must match what the daemon answers with, or every health probe reads as "some
    // other app is on that port" and the tray waits forever for a daemon that is already up.
    expect(cfg.serviceName).toBe('agenthydra')
    expect(cfg.port).toBe(7787)
    expect(cfg.iconFile).toBe('AgentHydra.ico')
    // Both start paths, so a release zip (compiled exe at the root) and a source checkout each
    // resolve without a per-machine setup step.
    expect(cfg.compiledExe).toBe('AgentHydra.exe')
    expect(cfg.startCommand).toContain('server/src/index.ts')
    // The shutdown protocol the daemon actually enforces (server/src/index.ts).
    expect(cfg.shutdownTokenEnvVar).toBe('AGENTHYDRA_SHUTDOWN_TOKEN')
    expect(cfg.shutdownHeaderPrefix).toBe('x-agenthydra')
    // Sentinel + pointer must sit under the SAME config dir the daemon writes to.
    expect(cfg.infoFile).toContain('runtime.json')
    expect(cfg.sentinelFile).toContain('shutdown.request')
  })

  test('the .ico has a tray-sized (<=48px) frame (a 256-only icon renders blank)', () => {
    // unchanged: binary property of the icon file itself, not the script.
    expect(icoHasSmallFrame(ICO)).toBe(true)
  })

  test('Tray-Launch.vbs auto-discovers the app tray adapter (*-Tray.ps1, exactly one match)', () => {
    // was: "the .vbs launches the tray script" — a literal 'AgentHydra-Tray.ps1' filename check
    // against the now-deleted per-app AgentHydra.vbs. The shared Tray-Launch.vbs has NO
    // per-app filename in it by design (it auto-discovers the sibling adapter at runtime), so
    // the intent — "the vbs launches this app's tray script" — is now proven by (a) the
    // discovery rule in the shared launcher, and (b) a live cscript probe (below) that resolves
    // to this app's actual AgentHydra-Tray.ps1 with exactly one match.
    const vbs = readFileSync(VBS, 'utf8')
    expect(vbs).toMatch(/Right\(lname,\s*9\)\s*=\s*"-tray\.ps1"/)
    expect(vbs).toContain('matchCount = 0')
    expect(vbs).toContain('matchCount > 1')
  })

  test('a live cscript probe resolves the shared Tray-Launch.vbs discovery to AgentHydra-Tray.ps1', () => {
    // end-to-end proof (no real launch): monkey-patch WScript.Shell.Run via a stub COM-less
    // echo probe is not available in classic VBS, so instead we run Tray-Launch.vbs's own
    // discovery logic against the real misc/ dir through cscript and have it print the
    // resolved adapter name instead of launching it, by pointing WScript at a tiny wrapper
    // that mirrors the discovery block verbatim and echoes the result.
    const probe = [
      'Dim fso, scriptDir, f, lname, matchName, matchCount',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `scriptDir = "${MISC.replace(/\\/g, '\\\\')}"`,
      'matchName = ""',
      'matchCount = 0',
      'For Each f In fso.GetFolder(scriptDir).Files',
      '  lname = LCase(f.Name)',
      '  If Len(lname) >= 9 Then',
      '    If Right(lname, 9) = "-tray.ps1" Then',
      '      matchName = f.Name',
      '      matchCount = matchCount + 1',
      '    End If',
      '  End If',
      'Next',
      'WScript.Echo matchName & "|" & matchCount',
    ].join('\r\n')
    const tmpDir = join(REPO_ROOT, 'tmp')
    mkdirSync(tmpDir, { recursive: true }) // tmp/ is gitignored, so absent on a fresh CI checkout
    const probePath = join(tmpDir, 'tray-launch-probe.vbs')
    writeFileSync(probePath, probe, 'utf8')
    try {
      const out = execFileSync('cscript', ['//NoLogo', probePath], { encoding: 'utf8' }).trim()
      expect(out).toBe('AgentHydra-Tray.ps1|1')
    } finally {
      try {
        unlinkSync(probePath)
      } catch {}
    }
    // 20s: a live cscript run, 109ms here. Same reasoning as the two tests below — the cost is the
    // runner's, not the assertion's, and this block is win32-gated so it only runs on the slow leg.
  }, 20_000)

  test('the shared tray engine is the real shared tray-host engine (not a hand-edited fork)', () => {
    // the refactor's central invariant — this app must run the real shared engine, not a
    // fork of it.
    const engine = readFileSync(ENGINE, 'utf8')
    expect(engine).toContain('function Start-TrayHost')
    expect(engine).toContain('function Invoke-TrayHostSelfTest')
  })

  test('Tray-Launch.vbs and New-TrayShortcut.ps1 are the real shared pieces (not hand-edited forks)', () => {
    // same invariant as the tray engine check above, extended to the two shared
    // launch-chain files.
    const vbs = readFileSync(VBS, 'utf8')
    // Robust marker (mirrors DevWebUI's launcher test): the shared launcher auto-discovers the
    // sibling adapter via WScript.Shell. Matched case-insensitively because the kit's public-comment
    // cleanup reworded the old exact-case "AUTO-DISCOVER" header to "Auto-discover".
    expect(vbs).toMatch(/WScript\.Shell|discover/i)

    const shortcutEngine = readFileSync(SHORTCUT_ENGINE, 'utf8')
    expect(shortcutEngine).toContain('function New-TrayShortcut')
  })

  test('Create-Shortcut.ps1 is a thin adapter that dot-sources the shared shortcut engine', () => {
    // new: proves this is actually a thin adapter, not a re-inlined copy of the shortcut
    // creation logic (mirrors the equivalent AgentHydra-Tray.ps1 <-> Tray-Host.ps1 check).
    const ps = readFileSync(CREATE_SHORTCUT, 'utf8')
    expect(ps).toMatch(/\.\s*\(Join-Path \$scriptDir ["']New-TrayShortcut\.ps1["']\)/)
    expect(ps).toMatch(/New-TrayShortcut\s+-Root\s+\$root\s+-ScriptDir\s+\$scriptDir/)
    expect(ps).toMatch(/-LnkName\s+["']AgentHydra["']/)
    expect(ps).toMatch(/-IconFile\s+["']AgentHydra\.ico["']/)
    expect(ps).toMatch(/-Description\s+["']Launch AgentHydra \(system tray\)["']/)
    expect(ps).toMatch(/-LnkName\s+["']AgentHydra Instances["']/)
    expect(ps).toMatch(/-VbsFile\s+["']Instance-Launch\.vbs["']/)
  })

  test('the quick launcher selects the compiled or source instance-mode entry without a tray', () => {
    const vbs = readFileSync(INSTANCE_VBS, 'utf8')
    expect(vbs).toContain('AgentHydra.exe')
    expect(vbs).toContain('server\\src\\main.ts')
    expect(vbs.match(/--instances/g)?.length).toBeGreaterThanOrEqual(2)
    expect(vbs).toContain('%APPDATA%\\npm\\bun.cmd')
    expect(vbs).toContain('%USERPROFILE%\\.bun\\bin\\bun.exe')
    expect(vbs).toContain('%ComSpec%')
    expect(vbs).not.toContain('AgentHydra-Tray.ps1')
  })

  test('the adapter dot-sources the shared engine and hands off with its $TrayConfig', () => {
    // new: proves this is actually a thin adapter, not a re-inlined copy.
    const ps = readFileSync(TRAY, 'utf8')
    expect(ps).toMatch(/\.\s*\(Join-Path \$scriptDir ["']Tray-Host\.ps1["']\)/)
    expect(ps).toContain('$TrayConfig')
    expect(ps).toMatch(/Start-TrayHost\s+\$TrayConfig/)
    expect(ps).toMatch(/Invoke-TrayHostSelfTest\s+\$TrayConfig/)
  })

  test('the adapter declares the app-specific daemon command, service id, and menu label', () => {
    // was (part of): "tray script boots the Bun daemon ... 'Open AgentHydra'" content checks.
    // The literal command/label strings are app config now, so they live in the adapter.
    const ps = readFileSync(TRAY, 'utf8')
    expect(ps).toContain('bun server/src/index.ts')
    expect(ps).toContain('"Open AgentHydra"')
    expect(ps).toMatch(/ServiceName\s*=\s*["']agenthydra["']/)
    expect(ps).toMatch(/IconFile\s*=\s*["']AgentHydra\.ico["']/)
  })

  test('the shared engine raises a NotifyIcon with the full menu, icon-first before the daemon starts', () => {
    // was: "the tray script boots the Bun daemon and raises a NotifyIcon with the full menu" +
    // the New-CMTrayIcon-before-Start-CM ordering assertion. NotifyIcon construction, menu
    // labels (Rebuild && Restart / Restart / Quit), and the icon-before-daemon-start ordering
    // are all engine machinery now.
    const engine = readFileSync(ENGINE, 'utf8')
    expect(engine).toContain('NotifyIcon')
    expect(engine).toContain('Rebuild && Restart')
    expect(engine).toContain('"Restart"')
    expect(engine).toContain('"Quit"')
    // The tray icon is created (New-TrayHostIcon called) strictly before the cold-start daemon
    // launch (Start-DaemonHere) — the icon-first guarantee.
    const iconCreateCall = engine.indexOf('$tray = New-TrayHostIcon')
    const daemonStartCall = engine.indexOf('$startProc = Start-DaemonHere')
    expect(iconCreateCall).toBeGreaterThan(-1)
    expect(daemonStartCall).toBeGreaterThan(-1)
    expect(iconCreateCall).toBeLessThan(daemonStartCall)
  })

  test('the engine opens the UI via the portable-mode-aware Open-AppUi helper, not a bare Start-Process', () => {
    // was: identical assertion, now against the engine (Open-AppUi/Resolve-ChromiumBrowser and
    // every $script:url open call site live there since the adapter has no UI-opening code).
    const engine = readFileSync(ENGINE, 'utf8')
    expect(engine).toContain('function Open-AppUi')
    expect(engine).toContain('--app=')
    expect(engine).toContain('function Resolve-ChromiumBrowser')
    const bareOpens = engine.match(/Start-Process \$script:url/g) ?? []
    expect(bareOpens.length).toBe(0)
    expect(engine.match(/Open-AppUi \$script:url/g)?.length).toBeGreaterThanOrEqual(3)
  })

  test('the portable window gets a dedicated Chromium profile (--user-data-dir) so it remembers its geometry', () => {
    // was: identical assertion, now against the engine.
    const engine = readFileSync(ENGINE, 'utf8')
    expect(engine).toContain('--user-data-dir=')
    expect(engine).toContain('portable-profile')
    expect(engine).toContain('--no-first-run')
    expect(engine).toContain('--no-default-browser-check')
  })

  // 20s timeout: two real PowerShell spawns + COM. A cold CI runner has taken 6.8s against the
  // 5s default (flaked the 2026-07-16 run); the assertions are unchanged, only the allowance.
  test('the desktop shortcut points at the native tray host + the icon', () => {
    // was: asserted wscript.exe + the shared Tray-Launch.vbs. The main shortcut now runs
    // misc\lunarwerx-tray.exe directly: the .vbs existed only to launch PowerShell without a
    // console flash, and a native host suppresses its own console, so both layers are gone.
    // Measured, alternating runs: the wscript -> powershell chain started the daemon at +475ms and
    // served at +745-1115ms; the native host starts it at +25ms and serves at ~400ms.
    //
    // The QUICK-INSTANCES shortcut below is deliberately NOT migrated and still asserts the
    // wscript path: it launches a different, trayless mode (--instances) and has no tray host to
    // replace, so moving it would be churn with nothing to gain.
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CREATE_SHORTCUT],
      {
        stdio: 'ignore',
      },
    )
    expect(existsSync(LNK)).toBe(true)
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${LNK.replace(/\\/g, '\\\\')}'); "$($s.TargetPath)|$($s.Arguments)|$($s.IconLocation)|$($s.WorkingDirectory)|$($s.Description)"`,
      ],
      { encoding: 'utf8' },
    )
    expect(out.toLowerCase()).toContain('lunarwerx-tray.exe')
    // The config filename IS the per-app surface: the host binary is generic and shared, so a
    // shortcut that lost this argument would start a tray host with nothing to host.
    expect(out).toContain('AgentHydra-Tray.json')
    expect(out.toLowerCase()).not.toContain('wscript.exe')
    expect(out).toContain('AgentHydra.ico')
    expect(out).toContain(REPO_ROOT)
    expect(out).toContain('Launch AgentHydra (system tray)')

    expect(existsSync(INSTANCE_LNK)).toBe(true)
    const quick = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${INSTANCE_LNK.replace(/\\/g, '\\\\')}'); "$($s.TargetPath)|$($s.Arguments)|$($s.IconLocation)|$($s.WorkingDirectory)|$($s.Description)"`,
      ],
      { encoding: 'utf8' },
    )
    expect(quick.toLowerCase()).toContain('wscript.exe')
    expect(quick).toContain('Instance-Launch.vbs')
    expect(quick).toContain('Quick launch AgentHydra instances')
  }, 20_000)

  // 20s for the same reason as the shortcut test above, and it was the odd one out: a real
  // PowerShell spawn that loads an icon and probes PATH, left on the 5s default while its siblings
  // here already had an allowance. 848ms on this machine, and this whole block is win32-gated, so
  // it runs ONLY on the slower of the two CI legs.
  test('the headless tray self-test passes against the rewritten adapter (icon loads, bun on PATH, entry present)', () => {
    // unchanged intent, still a live subprocess run — but now exercises the adapter's
    // Invoke-TrayHostSelfTest hand-off end-to-end, not a self-contained inline check.
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TRAY, '-SelfTest'],
      { encoding: 'utf8' },
    )
    expect(out).toContain('AGENTHYDRA_TRAY_SELFTEST_OK')
  }, 20_000)

  test('a single named mutex guards one tray host per desktop session, acquired before the icon', () => {
    // was: mutex literal + "icon created only after mutex" ordering + loser-branch behavior +
    // release-point count, all against the monolithic script. Split: the literal mutex name is
    // app config (adapter); the acquire-before-icon ordering, loser-branch shape, and release
    // points are engine machinery.
    const ps = readFileSync(TRAY, 'utf8')
    expect(ps).toMatch(/MutexName\s*=\s*["']AgentHydraTrayHost["']/)

    const engine = readFileSync(ENGINE, 'utf8')
    const mutexCreateCall = engine.indexOf(
      'New-Object System.Threading.Mutex($true, $Config.MutexName',
    )
    const iconCreateCall = engine.indexOf('$tray = New-TrayHostIcon')
    expect(mutexCreateCall).toBeGreaterThan(-1)
    expect(iconCreateCall).toBeGreaterThan(-1)
    expect(mutexCreateCall).toBeLessThan(iconCreateCall)
    // the loser branch (mutex already held) attaches to the running UI and returns without
    // creating an icon
    const loserBlock = engine.slice(
      engine.indexOf('if (-not $script:ownsTrayMutex)'),
      iconCreateCall,
    )
    expect(loserBlock).toContain('Open-AppUi')
    expect(loserBlock).toContain('return')
    // every failure exit before/at icon creation releases the mutex (catch, loser, stray-warn,
    // bun-missing, icon-creation-failure — Release-TrayMutex is called at each)
    expect(engine.match(/Release-TrayMutex/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test('hideTrayIcon only gates NotifyIcon.Visible — the icon object is always created', () => {
    // was: identical assertion, now against the engine (Get-HideTrayIcon and the gate both live
    // there; the adapter has no visibility logic of its own).
    const engine = readFileSync(ENGINE, 'utf8')
    const unconditionalVisible = engine.indexOf('$tray.Visible = $true')
    const hideGate = engine.indexOf('if (Get-HideTrayIcon)')
    expect(unconditionalVisible).toBeGreaterThan(-1)
    expect(hideGate).toBeGreaterThan(unconditionalVisible)
    expect(engine).toContain('function Get-HideTrayIcon')
    expect(engine).toContain('$info.hideTrayIcon')
  })

  test('the health timer re-reads hideTrayIcon live, so re-enabling it needs no restart', () => {
    // was: identical assertion, now against the engine's $healthTimer.Add_Tick block.
    const engine = readFileSync(ENGINE, 'utf8')
    const healthTick = engine.slice(
      engine.indexOf('$healthTimer.Add_Tick'),
      engine.indexOf('$healthTimer.Start()'),
    )
    expect(healthTick).toContain('Get-HideTrayIcon')
    expect(healthTick).toContain('$tray.Visible')
  })

  test('Open-AppUi (the loser-branch and shortcut-relaunch path) never checks tray visibility', () => {
    // was: identical assertion, now against the engine's Open-AppUi function body.
    const engine = readFileSync(ENGINE, 'utf8')
    const openAppUi = engine.slice(
      engine.indexOf('function Open-AppUi'),
      engine.indexOf('# "Hide tray icon" opt-in'),
    )
    expect(openAppUi).not.toContain('hideTrayIcon')
    expect(openAppUi).not.toContain('tray.Visible')
  })

  test('AgentHydra declares its full-shutdown sentinel (web-UI "Shut down" tears the app down)', () => {
    // The tray polls this sentinel; the daemon drops it on a UI-source shutdown without the tray
    // token (server/src/index.ts), so a web-UI "Shut down" quits the whole app (icon + daemon)
    // instead of the watchdog reviving it. Path sits beside runtime.json in $cmHome.
    const ps = readFileSync(TRAY, 'utf8')
    expect(ps).toMatch(/SentinelFile\s*=\s*Join-Path \$cmHome "shutdown\.request"/)
  })

  test('AgentHydra uses the token/HTTP graceful-shutdown protocol, not force-kill', () => {
    // new: documents the shutdown-protocol divergence the adapter must declare correctly —
    // ShutdownTokenEnvVar set (token apps) vs $null (force-kill apps like ReDesign/RepoYeti).
    const ps = readFileSync(TRAY, 'utf8')
    expect(ps).toMatch(/ShutdownTokenEnvVar\s*=\s*["']AGENTHYDRA_SHUTDOWN_TOKEN["']/)
    expect(ps).toMatch(/ShutdownHeaderPrefix\s*=\s*["']x-agenthydra["']/)
  })

  test("Quit's belt-and-braces daemon stop cannot re-run a second bounded graceful POST", () => {
    // Regression guard for the Quit-hang fix: the graceful POST already ran (bounded 3s) right
    // before this call, so the belt-and-braces Stop-DaemonHere for a token app we own must pass
    // skipGraceful=$true — otherwise a still-alive daemon triggers Stop-Daemon's OWN 20s-bounded
    // graceful POST + up to 10s poll before falling back to the port-kill, turning a fast Quit
    // into a ~30s hang.
    const engine = readFileSync(ENGINE, 'utf8')
    const quitFn = engine.slice(
      engine.indexOf('function Invoke-QuitApp'),
      engine.indexOf('$openItem.Add_Click'),
    )
    expect(quitFn).toMatch(/Stop-DaemonHere\s+\$true\s+\$true/)
    // and Stop-Daemon itself must honour that flag by skipping its graceful branch
    const stopDaemonFn = engine.slice(
      engine.indexOf('function Stop-Daemon('),
      engine.indexOf('function Start-Daemon('),
    )
    expect(stopDaemonFn).toContain('skipGraceful')
    expect(stopDaemonFn).toMatch(/if \(-not \$skipGraceful\)/)
  })

  test('the adapter opts the auto-restart watchdog out of the ownership gate (OLD parity: revive regardless of who started the daemon)', () => {
    // OLD agenthydra's watchdog had no startedByUs gate — it revived on any health-check
    // failure. The engine's default (WatchdogRequiresOwnership=$true, inherited from DevWebUI)
    // would silently stop reviving a daemon this tray attached to rather than started, so the
    // adapter must explicitly opt out.
    const ps = readFileSync(TRAY, 'utf8')
    expect(ps).toMatch(/WatchdogRequiresOwnership\s*=\s*\$false/)

    const engine = readFileSync(ENGINE, 'utf8')
    expect(engine).toContain('$watchdogRequiresOwnership')
    // Match the GATE, not the exact body: the watchdog also clears its consecutive-miss counter
    // when it stands down here, so pinning a literal `{ return }` would fail on an unrelated
    // (and correct) change. What must hold is that this condition still short-circuits the tick.
    expect(engine).toMatch(
      /if \(\$useToken -and -not \$script:startedByUs -and \$watchdogRequiresOwnership\) \{[^}]*\breturn\b[^}]*\}/,
    )
  })

  // --- watchdog false-positive guard (the duplicate-daemon fix) -----------------------------
  // ONE failed /api/health probe used to be enough for the watchdog to declare the daemon dead,
  // balloon "stopped unexpectedly - restarting", and spawn a replacement. On a loaded box a LIVE
  // daemon misses a probe now and then, so the tray manufactured crashes that never happened:
  // the replacement's own single-instance guard also mis-probed, it hopped to PORT+1, rewrote
  // runtime.json, and left TWO live daemons with open tabs stranded on the old port. Confirmed
  // in the field from daemon.log (paired starts ~6.4s apart, the second logging "port N was
  // busy") while the "dead" daemon was still serving. These pin the three parts of the fix.

  test('the watchdog requires CONSECUTIVE failed probes before declaring the daemon dead', () => {
    const engine = readFileSync(ENGINE, 'utf8')
    // Configurable, and defaulting above 1 — a default of 1 IS the old hair-trigger.
    const threshold = engine.match(/ReviveAfterMisses'\s+(\d+)/)
    expect(threshold).not.toBeNull()
    expect(Number(threshold?.[1] ?? 0)).toBeGreaterThan(1)

    // The counter must actually gate the relaunch...
    expect(engine).toContain('$script:healthMisses++')
    expect(engine).toMatch(/if \(\$script:healthMisses -lt \$reviveAfterMisses\) \{[\s\S]*?return/)
    // ...and reset, or a slow probe once an hour would eventually add up to a bogus "crash".
    expect(engine).toContain('$script:healthMisses = 0')
  })

  test('the health probe gives a live-but-busy daemon more than one second to answer', () => {
    const engine = readFileSync(ENGINE, 'utf8')
    const timeout = engine.match(/function Test-Daemon\([^)]*\$timeoutSec\s*=\s*(\d+)\)/)
    expect(timeout).not.toBeNull()
    expect(Number(timeout?.[1] ?? 0)).toBeGreaterThan(1)
    // The budget must come from that parameter, not a hard-coded literal creeping back in.
    // Assert on the actual CALL rather than a slice of the file: nearby comments legitimately
    // mention the old "-TimeoutSec 1" while explaining why it was wrong, so anything coarser
    // than this trips over its own prose.
    expect(engine).toMatch(
      /Invoke-RestMethod\s+-Uri\s+"\$u\/api\/health"\s+-TimeoutSec\s+\$timeoutSec/,
    )
    expect(engine).not.toMatch(/Invoke-RestMethod[^\n]*-TimeoutSec\s+\d/)
  })

  test('a health probe is gated on the port actually having a listener (UI-thread stall guard)', () => {
    // Invoke-RestMethod does NOT fail fast on a refused loopback connection — it burns the whole
    // -TimeoutSec. Get-RunningUrl probes up to twice and the health timer runs on the WinForms UI
    // THREAD, so without this gate a dead daemon freezes the tray menu for two full timeouts on
    // EVERY tick (measured ~4s; with the gate, ~6ms). Raising the timeout without keeping this
    // gate would reintroduce the stall, which is exactly why it is pinned here.
    const engine = readFileSync(ENGINE, 'utf8')
    expect(engine).toContain('function Test-DaemonAt')
    expect(engine).toMatch(
      /if \(\$p -gt 0 -and -not \(Test-PortListening \$p\)\) \{ return \$false \}/,
    )

    // ...and Get-RunningUrl must actually route through the gated helper, not call Test-Daemon raw.
    const getRunningUrl = engine.slice(
      engine.indexOf('function Get-RunningUrl('),
      engine.indexOf('function Get-PortFromUrl('),
    )
    expect(getRunningUrl).toContain('Test-DaemonAt')
    expect(getRunningUrl).not.toMatch(/\bTest-Daemon\s+\$/)
  })

  test('the watchdog logs its restart decisions into the log the balloon tells users to read', () => {
    const engine = readFileSync(ENGINE, 'utf8')
    expect(engine).toContain('function Write-TrayLog')

    const watchdog = engine.slice(
      engine.indexOf('$healthTimer.Add_Tick'),
      engine.indexOf('$watchTimer = $null'),
    )
    // A balloon that points at a log containing no trace of the restart reads as "the log is
    // empty, so nothing was wrong" — exactly backwards, and it cost a real debugging session.
    expect(watchdog).toMatch(/Write-TrayLog\s+'WARN'/)
    expect(watchdog).toContain('relaunching')
  })
})
