// ───────────────────────────────────────────────────────────────────────────────
// Hardcore guard for the one-click launcher. The promise to a user is: there is
// ALWAYS a clickable shortcut in the project root that, when run, boots the daemon
// and shows the tray icon. These tests fail LOUD ("thou shalt not pass") the moment
// any link in that chain is missing, uncommitted, mis-wired, or the icon is broken.
//
// The chain:  DevWebUI.lnk (root)  →  wscript  →  misc/Tray-Launch.vbs (shared,
//             auto-discovering launcher)  →  misc/DevWebUI-Tray.ps1 (adapter)  →
//             misc/Tray-Host.ps1 (shared engine)  →  bun server/src/index.ts
//             +  misc/DevWebUI.ico
//
// DevWebUI-Tray.ps1 is now a THIN ADAPTER over the shared LunarWerx tray-host engine
// (misc/Tray-Host.ps1, kit-synced from lunarwerx-ui — never edited inside this repo).
// The old per-app misc/DevWebUI.vbs is GONE, replaced by the shared, zero-config
// misc/Tray-Launch.vbs (also kit-synced), which auto-discovers the sibling
// "*-Tray.ps1" adapter instead of hard-coding its name. misc/Create-Shortcut.ps1 is
// likewise now a THIN ADAPTER over the shared misc/New-TrayShortcut.ps1 engine
// (kit-synced), supplying only DevWebUI's name / icon / description. Assertions here
// are split accordingly:
//   - ENGINE-INVARIANT tray-host behavior (mutex-before-icon, icon-always-created-
//     then-gated, loser-branch-creates-no-icon, portable-window open path,
//     hideTrayIcon live-sync, generic health-probe shape) is asserted against
//     misc/Tray-Host.ps1, since that's the file that actually implements it, and it
//     must carry the kit-synced header because it must NEVER be edited by hand
//     inside this repo.
//   - SHARED LAUNCHER/SHORTCUT machinery (Tray-Launch.vbs's auto-discovery,
//     New-TrayShortcut.ps1's shortcut-building) is asserted to carry the kit-synced
//     header and to be dot-sourced / delegated to by this app's thin adapters,
//     never reimplemented locally.
//   - APP-SPECIFIC config (mutex literal, daemon start command, icon filename, shutdown
//     token env var + header prefix, sentinel path convention, menu label, self-test
//     marker) is asserted against misc/DevWebUI-Tray.ps1, since that's what this repo
//     actually owns and can drift.
//   - Live end-to-end proofs (-SelfTest subprocess, Create-Shortcut.ps1 + resolving the
//     real .lnk) keep exercising the adapter exactly as before — those are the ONLY
//     assertions that prove the whole chain actually runs, not just that the right
//     strings exist somewhere.
//
// The .lnk itself is gitignored (it stores absolute, per-machine paths), so the
// guarantee is enforced via the COMMITTED machinery that regenerates it
// (Create-Shortcut.ps1) — and, on Windows, by actually regenerating + resolving it
// and by running the tray's headless self-test.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../shared/routes";

const ROOT = join(import.meta.dir, "..");
const MISC = join(ROOT, "misc");
const isWin = process.platform === "win32";

/** Loud assertion — a failure here should read like a stop sign, not a diff. */
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`THOU SHALT NOT PASS — ${msg}`);
}
const read = (p: string): string => readFileSync(p, "utf8");
/** Is this path committed (in git's index)? Untracked files never reach a clone. */
function tracked(relFromRoot: string): boolean {
  return (
    Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", relFromRoot], { cwd: ROOT })
      .exitCode === 0
  );
}

// The committed pieces that let ANY clone regenerate a working shortcut + tray. The
// shared engine (Tray-Host.ps1), the shared launcher (Tray-Launch.vbs), and the shared
// shortcut engine (New-TrayShortcut.ps1) are all kit-synced but still must be present
// + committed — without them the adapters can't dot-source or discover anything.
const REQUIRED = [
  "Create-Shortcut.ps1",
  "New-TrayShortcut.ps1",
  "Tray-Launch.vbs",
  "DevWebUI-Tray.ps1",
  "Tray-Host.ps1",
  "DevWebUI.ico",
] as const;

test("launcher machinery exists, is non-empty, and is COMMITTED (a clone must be able to make the shortcut)", () => {
  for (const name of REQUIRED) {
    const abs = join(MISC, name);
    assert(existsSync(abs), `misc/${name} is MISSING — the tray launcher is incomplete`);
    assert(statSync(abs).size > 0, `misc/${name} is EMPTY`);
    assert(
      tracked(`misc/${name}`),
      `misc/${name} is NOT committed to git — a fresh clone would have NO shortcut or tray. Run: git add misc/`,
    );
  }
  // 20s: tracked() shells out to `git ls-files` once PER required file, so this loop is several
  // real subprocesses, not the file reads it looks like. 176ms here; a cold CI runner has been
  // measured at ~9.5x local on this class, which puts it past the 5s default.
}, 20000);

test("the tray icon is a real .ico file (so the tray icon can't silently be broken)", () => {
  const buf = readFileSync(join(MISC, "DevWebUI.ico"));
  // ICO header: reserved=0x0000, type=0x0001(icon), count>=1.
  const headerOk = buf.length > 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0;
  const count = buf.length > 6 ? buf[4]! | (buf[5]! << 8) : 0;
  assert(
    headerOk && count >= 1,
    `misc/DevWebUI.ico is not a valid icon (bad header / 0 images) — the tray icon would be broken`,
  );
  // The Windows tray needs a SMALL frame (16/24/32/48). A 256-only icon renders BLANK in
  // the tray (the classic "tray icon is broken"). Walk the ICONDIR and require a <=48px
  // frame. Each 16-byte ICONDIRENTRY starts at 6 + i*16; byte 0 is the width (0 => 256).
  const frames: number[] = [];
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16]!;
    frames.push(w === 0 ? 256 : w);
  }
  assert(
    frames.some((w) => w >= 1 && w <= 48),
    `misc/DevWebUI.ico has no small (<=48px) frame (frames: ${frames.join(",")}) — a 256-only icon renders blank in the tray`,
  );
});

test("misc/Tray-Host.ps1 is the real shared tray-host engine (must never be hand-edited in this repo)", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));
  assert(
    /function\s+Start-TrayHost/.test(engine),
    "Tray-Host.ps1 is missing function Start-TrayHost — has it been replaced with a local fork?",
  );
  assert(
    /function\s+Invoke-TrayHostSelfTest/.test(engine),
    "Tray-Host.ps1 is missing function Invoke-TrayHostSelfTest — has it been replaced with a local fork?",
  );
});

test("misc/Tray-Launch.vbs and misc/New-TrayShortcut.ps1 are the real shared pieces (must never be hand-edited in this repo)", () => {
  const vbs = read(join(MISC, "Tray-Launch.vbs"));
  assert(
    /WScript\.Shell|discover/i.test(vbs),
    "Tray-Launch.vbs doesn't look like the shared auto-discovering launcher — has it been replaced with a local per-app fork?",
  );

  const engine = read(join(MISC, "New-TrayShortcut.ps1"));
  assert(
    /function\s+New-TrayShortcut/.test(engine),
    "New-TrayShortcut.ps1 is missing function New-TrayShortcut — has it been replaced with a local per-app fork?",
  );
});

test("misc/Tray-Launch.vbs auto-discovers the sibling *-Tray.ps1 adapter (zero-config, no hard-coded name)", () => {
  const vbs = read(join(MISC, "Tray-Launch.vbs"));
  assert(
    /Right\(lname,\s*9\)\s*=\s*"-tray\.ps1"/.test(vbs),
    "Tray-Launch.vbs doesn't auto-discover the sibling adapter by matching '*-tray.ps1'",
  );
  assert(
    !/DevWebUI-Tray\.ps1/.test(vbs),
    "Tray-Launch.vbs must stay zero-config — it must NOT hard-code DevWebUI-Tray.ps1 by name",
  );
  assert(
    /matchCount\s*=\s*0/.test(vbs) && /matchCount\s*>\s*1/.test(vbs),
    "Tray-Launch.vbs doesn't abort when zero or more than one adapter is found",
  );
});

test("DevWebUI-Tray.ps1 is a thin adapter that dot-sources the shared engine and calls into it", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /\.\s*\(Join-Path\s+\$scriptDir\s+["']Tray-Host\.ps1["']\)/.test(tray),
    "DevWebUI-Tray.ps1 doesn't dot-source misc/Tray-Host.ps1 — it's no longer a thin adapter",
  );
  assert(
    /Invoke-TrayHostSelfTest\s+\$TrayConfig/.test(tray),
    "DevWebUI-Tray.ps1 doesn't call the engine's Invoke-TrayHostSelfTest",
  );
  assert(
    /Start-TrayHost\s+\$TrayConfig/.test(tray),
    "DevWebUI-Tray.ps1 doesn't call the engine's Start-TrayHost",
  );
  assert(
    /\[switch\]\$SelfTest/.test(tray),
    "DevWebUI-Tray.ps1 is missing the [switch]$SelfTest param",
  );
  assert(
    /\[int\]\$Port\s*=\s*4000/.test(tray),
    "DevWebUI-Tray.ps1's default port drifted from 4000",
  );
});

test("Create-Shortcut.ps1 is a thin adapter: it dot-sources New-TrayShortcut.ps1 rather than reimplementing it", () => {
  const cs = read(join(MISC, "Create-Shortcut.ps1"));
  assert(
    /\.\s*\(Join-Path\s+\$scriptDir\s+["']New-TrayShortcut\.ps1["']\)/.test(cs),
    "Create-Shortcut.ps1 doesn't dot-source misc/New-TrayShortcut.ps1 — it's no longer a thin adapter",
  );
  assert(/New-TrayShortcut\b/.test(cs), "Create-Shortcut.ps1 doesn't call New-TrayShortcut");
  assert(
    /-LnkName\s+["']DevWebUI["']/.test(cs),
    "Create-Shortcut.ps1 doesn't pass -LnkName DevWebUI",
  );
  assert(
    /-IconFile\s+["']DevWebUI\.ico["']/.test(cs),
    "Create-Shortcut.ps1 doesn't pass -IconFile DevWebUI.ico",
  );
  assert(
    /-Description\s+["']Launch DevWebUI \(system tray\)["']/.test(cs),
    "Create-Shortcut.ps1 doesn't pass the expected -Description",
  );
  // Must NOT reimplement the shortcut-building machinery itself (that lives in the
  // shared engine now) — a stray CreateShortcut call would mean drift back to a full copy.
  assert(
    !/New-Object -ComObject WScript\.Shell/.test(cs),
    "Create-Shortcut.ps1 still builds the .lnk itself instead of delegating to New-TrayShortcut.ps1",
  );
});

test("launcher chain is wired: shortcut → wscript → Tray-Launch.vbs → DevWebUI-Tray.ps1 → daemon + icon", () => {
  const cs = read(join(MISC, "Create-Shortcut.ps1"));
  assert(/DevWebUI\.ico/.test(cs), "Create-Shortcut.ps1 doesn't set the tray icon");

  const vbs = read(join(MISC, "Tray-Launch.vbs"));
  assert(
    /sh\.Run\s+"powershell/.test(vbs),
    "Tray-Launch.vbs doesn't launch the discovered adapter via powershell",
  );

  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /server[\\/]src[\\/]index\.ts/.test(tray),
    "DevWebUI-Tray.ps1's EntryFile doesn't point at the daemon (server/src/index.ts)",
  );
  assert(
    /StartCommand\s*=\s*["']bun server\/src\/index\.ts["']/.test(tray),
    "DevWebUI-Tray.ps1's StartCommand doesn't start the daemon (bun server/src/index.ts)",
  );
  assert(/DevWebUI\.ico/.test(tray), "DevWebUI-Tray.ps1 doesn't load the tray icon DevWebUI.ico");
  assert(
    /DEVWEBUI_TRAY_SHUTDOWN_TOKEN/.test(tray),
    "DevWebUI-Tray.ps1 doesn't wire the tray shutdown-token env var to the daemon",
  );
  assert(
    /x-devwebui/.test(tray),
    "DevWebUI-Tray.ps1 doesn't set the x-devwebui shutdown header prefix",
  );

  // The actual shutdown HTTP call (/api/shutdown, x-devwebui-shutdown-token header) is
  // generic engine machinery now — assert it lives in the engine, parameterized by the
  // adapter's ShutdownTokenEnvVar/ShutdownHeaderPrefix above.
  const engine = read(join(MISC, "Tray-Host.ps1"));
  assert(/\/api\/shutdown/.test(engine), "Tray-Host.ps1 doesn't request daemon shutdown");
  assert(
    /\$headerPrefix-shutdown-token/.test(engine),
    "Tray-Host.ps1 doesn't build the shutdown-token header from the app's header prefix",
  );
});

test("engine: mutex is acquired BEFORE the tray icon, and a losing launch creates no icon", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));

  assert(
    /New-Object System\.Threading\.Mutex\(\$true,\s*\$Config\.MutexName/.test(engine),
    "Tray-Host.ps1 doesn't acquire a named single-instance mutex from $Config.MutexName",
  );

  const mutexIdx = engine.indexOf("New-Object System.Threading.Mutex($true, $Config.MutexName");
  const trayVisibleIdx = engine.indexOf("$tray.Visible = $true");
  assert(mutexIdx >= 0, "Tray-Host.ps1 mutex acquisition not found");
  assert(trayVisibleIdx >= 0, "Tray-Host.ps1 never unconditionally makes the tray icon visible");
  assert(
    mutexIdx < trayVisibleIdx,
    "Tray-Host.ps1 must acquire the single-instance mutex BEFORE creating the tray icon",
  );

  // The loser branch (mutex not owned by us) must resolve the running UI and return —
  // WITHOUT creating a NotifyIcon or starting any timer — so a relaunch never stacks a
  // second tray icon while still opening/focusing the existing instance's UI.
  const loserBlock = engine.match(/if \(-not \$script:ownsTrayMutex\)\s*\{([\s\S]*?)\n {2}\}/);
  assert(loserBlock, "Tray-Host.ps1 doesn't branch on losing the single-instance mutex");
  const loserBody = loserBlock[1] ?? "";
  assert(
    /Open-AppUi/.test(loserBody),
    "Tray-Host.ps1's mutex-loser branch doesn't open the running instance's UI",
  );
  assert(
    /\breturn\b/.test(loserBody),
    "Tray-Host.ps1's mutex-loser branch doesn't exit without creating a tray icon",
  );
  assert(
    !/New-TrayHostIcon|New-Object System\.Windows\.Forms\.NotifyIcon/.test(loserBody),
    "Tray-Host.ps1's mutex-loser branch must not create a NotifyIcon — exactly one tray icon total",
  );
});

test("engine: the NotifyIcon is always created; only .Visible is gated on hideTrayIcon, then live-resynced", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));

  assert(
    /function Get-HideTrayIcon/.test(engine),
    "Tray-Host.ps1 is missing a Get-HideTrayIcon reader",
  );
  assert(
    /\.hideTrayIcon/.test(engine),
    "Tray-Host.ps1 doesn't read the hideTrayIcon field from runtime.json",
  );

  // Icon creation + the unconditional Visible=$true line must stay unconditional (launcher
  // tests hard-assert icon-first ordering, and Quit/menu/watchdog hang off $tray existing).
  // The hideTrayIcon gate must come strictly AFTER that unconditional line, never replace it.
  const trayVisibleIdx = engine.indexOf("$tray.Visible = $true");
  const gateIdx = engine.indexOf("if (Get-HideTrayIcon) { $tray.Visible = $false }");
  assert(trayVisibleIdx >= 0, "Tray-Host.ps1 never unconditionally makes the tray icon visible");
  assert(
    gateIdx >= 0,
    "Tray-Host.ps1 doesn't gate tray visibility on the saved hideTrayIcon preference",
  );
  assert(
    trayVisibleIdx < gateIdx,
    "Tray-Host.ps1 must set Visible=$true unconditionally BEFORE gating it on hideTrayIcon",
  );

  // Live re-sync: the health timer tick re-reads the preference and flips .Visible to
  // match, so re-enabling from web Settings restores the icon within a few seconds — no
  // restart. (DevWebUI's OLD script did this on its 500ms watchTimer; the engine folds
  // it into the 5s healthTimer tick instead — a documented, intentional engine behavior,
  // not a per-app divergence, so this test targets the engine.)
  assert(
    /\$healthTimer\.Add_Tick\(\{[\s\S]*?Get-HideTrayIcon[\s\S]*?\$tray\.Visible[\s\S]*?\}\)/.test(
      engine,
    ),
    "Tray-Host.ps1 doesn't live-resync tray visibility with hideTrayIcon on the health timer tick",
  );
});

test("engine: routes every browser-open through Open-AppUi with a dedicated portable-window profile", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));
  assert(
    /function Resolve-ChromiumBrowser/.test(engine),
    "Tray-Host.ps1 is missing Resolve-ChromiumBrowser",
  );
  assert(/function Open-AppUi/.test(engine), "Tray-Host.ps1 is missing Open-AppUi");
  assert(/--app=\$url/.test(engine), "Open-AppUi doesn't launch a chromeless --app= window");
  assert(
    /\.portableMode/.test(engine),
    "Open-AppUi doesn't read the portableMode field from runtime.json",
  );
  assert(
    /--user-data-dir=/.test(engine),
    "Open-AppUi doesn't give the portable window a dedicated profile via --user-data-dir",
  );
  assert(
    /portable-profile/.test(engine),
    "Open-AppUi doesn't derive the shared portable-profile dir from runtime.json's location",
  );
  // Open-AppUi's own body must never gate on tray visibility — opening the UI and hiding
  // the icon are orthogonal concerns.
  const fnBlock = engine.match(/function Open-AppUi[\s\S]*?\n {2}\}/);
  assert(fnBlock, "Tray-Host.ps1's Open-AppUi function body could not be extracted");
  assert(
    !/\$tray\.Visible/.test(fnBlock[0]),
    "Tray-Host.ps1's Open-AppUi must not reference $tray.Visible — opening the UI must not depend on icon visibility",
  );
});

test("engine: health probe validates body.ok, and honours a per-app service-id when the adapter sets one", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));
  assert(/function Test-Daemon/.test(engine), "Tray-Host.ps1 is missing Test-Daemon");
  assert(/\/api\/health/.test(engine), "Tray-Host.ps1 doesn't probe /api/health");
  assert(
    /r\.service\s+-eq\s+\$service/.test(engine),
    "Tray-Host.ps1's Test-Daemon doesn't validate body.service against the per-app ServiceName when set",
  );
  assert(
    /return\s+\[bool\]\$r\.ok/.test(engine),
    "Tray-Host.ps1's Test-Daemon doesn't fall back to a bare body.ok check when ServiceName is $null",
  );

  // DevWebUI's health payload carried no 'service' field until 2026-07-15, so its adapter declared
  // ServiceName = $null and the tray accepted ANY responder on the port. That is the same hole that
  // let misc/Restart-Daemon.ps1 mistake a Vite dev server (which answers /api/health with a 200
  // text/html SPA fallback) for an app daemon. The payload now stamps `service`, so the adapter
  // names it and the tray can reject an impostor on a recycled port like every sibling app does.
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /ServiceName\s*=\s*["']devwebui["']/.test(tray),
    "DevWebUI-Tray.ps1 must declare ServiceName = 'devwebui' (its /api/health stamps that service id)",
  );
});

test("engine: full-shutdown sentinel is polled and cleared, reusing Quit's teardown", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));
  assert(
    /\$script:shutdownRequestFile\s*=\s*\$Config\.SentinelFile/.test(engine),
    "Tray-Host.ps1 doesn't read the per-app SentinelFile from config",
  );
  assert(
    /Remove-Item \$script:shutdownRequestFile/.test(engine),
    "Tray-Host.ps1 doesn't clear a stale sentinel",
  );
  assert(
    /\$watchTimer\.Add_Tick\(\{[\s\S]*?Test-Path \$script:shutdownRequestFile[\s\S]*?Invoke-QuitApp[\s\S]*?\}\)/.test(
      engine,
    ),
    "Tray-Host.ps1's watch timer doesn't poll the sentinel and invoke the Quit teardown",
  );

  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /SentinelFile\s*=\s*Join-Path \$dwHome "shutdown\.request"/.test(tray),
    "DevWebUI-Tray.ps1 doesn't declare its shutdown.request sentinel path (sibling of runtime.json)",
  );
});

test("tray 'Stop all processes': posts the same route the GUI does, off the UI thread, without touching the daemon", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));

  // Opt-in: no ActionPath ⇒ no extra menu item at all (the sibling apps have none).
  assert(
    /\$actionPath\s*=\s*Get-TrayConfigValue \$Config 'ActionPath' \$null/.test(engine),
    "Tray-Host.ps1 doesn't read the optional ActionPath from config",
  );
  assert(
    /if \(\$actionItem\) \{\s*\$menu\.Items\.Add/.test(engine),
    "Tray-Host.ps1 adds the app-action menu item unconditionally — it must exist only when ActionPath is configured",
  );

  // The POST runs in a background runspace and reports via its own poll timer. A daemon that
  // takes seconds to answer (DevWebUI waits out each child's SIGTERM grace) must never freeze
  // the tray menu, which is exactly what an Invoke-RestMethod on the UI thread would do.
  const fn = engine.match(/function Invoke-AppAction[\s\S]*?\n {2}\}/);
  assert(fn, "Tray-Host.ps1 is missing Invoke-AppAction");
  assert(
    /PowerShell\]::Create\(\)[\s\S]*?BeginInvoke\(\)/.test(fn[0]),
    "Invoke-AppAction doesn't run the POST on a background runspace — a slow daemon would block the tray menu",
  );
  assert(
    /\$actionTimer\.Add_Tick\(\{[\s\S]*?EndInvoke[\s\S]*?ShowBalloonTip[\s\S]*?\}\)/.test(engine),
    "Tray-Host.ps1 doesn't marshal the app-action result back to the UI thread with a balloon",
  );
  // It acts on what the daemon RUNS, never on the daemon process: no stop/kill/quit path here.
  assert(
    !/Stop-DaemonHere|Invoke-QuitApp|taskkill/.test(fn[0]),
    "Invoke-AppAction must not stop or kill the daemon — it only POSTs to it",
  );

  // The adapter points it at the same route the web UI's "Stop all" and `devwebui stop-all` use.
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    new RegExp(`ActionPath\\s*=\\s*"${ROUTES.stopAll}"`).test(tray),
    `DevWebUI-Tray.ps1 must point ActionPath at ${ROUTES.stopAll} (shared/routes.ts stopAll)`,
  );
  assert(
    /ActionLabel\s*=\s*"Stop all processes"/.test(tray),
    'DevWebUI-Tray.ps1 must label the item "Stop all processes" — a bare "Stop all" reads as "stop DevWebUI itself" next to Restart and Quit',
  );
});

test("adapter: single-instance mutex name is the exact literal DevWebUITrayHost", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /MutexName\s*=\s*"DevWebUITrayHost"/.test(tray),
    'DevWebUI-Tray.ps1 must declare MutexName = "DevWebUITrayHost" (exact literal — a rename breaks single-instance continuity for existing installs)',
  );
});

test("adapter: declares its icon, display name, self-test marker, and menu label", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(/IconFile\s*=\s*"DevWebUI\.ico"/.test(tray), "DevWebUI-Tray.ps1 doesn't declare IconFile");
  assert(
    /DisplayName\s*=\s*"DevWebUI"/.test(tray),
    "DevWebUI-Tray.ps1 doesn't declare DisplayName",
  );
  assert(
    /SelfTestMarker\s*=\s*"DEVWEBUI_TRAY_SELFTEST"/.test(tray),
    "DevWebUI-Tray.ps1 doesn't declare the DEVWEBUI_TRAY_SELFTEST marker",
  );
  assert(
    /MenuOpenLabel\s*=\s*"Open DevWebUI"/.test(tray),
    'DevWebUI-Tray.ps1 doesn\'t declare MenuOpenLabel = "Open DevWebUI"',
  );
});

test("adapter: resolves the config dir via DEVWEBUI_HOME (else ~/.devwebui), matching server/src/data-dir.ts", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /\$env:DEVWEBUI_HOME/.test(tray),
    "DevWebUI-Tray.ps1 doesn't honour the DEVWEBUI_HOME env override",
  );
  assert(/\.devwebui/.test(tray), "DevWebUI-Tray.ps1 doesn't fall back to ~/.devwebui");
  assert(
    /InfoFile\s*=\s*Join-Path \$dwHome "runtime\.json"/.test(tray),
    "DevWebUI-Tray.ps1 doesn't point InfoFile at $dwHome/runtime.json",
  );
});

test("adapter: dev-tree gate for Rebuild & Restart requires DEVWEBUI_DEV=1 only", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /IsDevTree\s*=\s*\(\$env:DEVWEBUI_DEV -eq "1"\)/.test(tray),
    "DevWebUI-Tray.ps1's IsDevTree rule drifted from (DEVWEBUI_DEV=1)",
  );
  assert(
    !/IsDevTree\s*=\s*\(\$env:DEVWEBUI_DEV -eq "1"\)\s*-or/.test(tray),
    "DevWebUI-Tray.ps1's IsDevTree rule still has a -or clause (server\\src should no longer gate this)",
  );
});

test("adapter: first-run bootstrap installs deps and builds the GUI only when missing", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /FirstRun\s*=\s*\{/.test(tray),
    "DevWebUI-Tray.ps1 doesn't supply a FirstRun bootstrap scriptblock",
  );
  const firstRunBlock = tray.match(/FirstRun\s*=\s*\{[\s\S]*?\n {2}\}/);
  assert(firstRunBlock, "DevWebUI-Tray.ps1's FirstRun scriptblock body could not be extracted");
  assert(
    /node_modules/.test(firstRunBlock[0]) && /bun install/.test(firstRunBlock[0]),
    "DevWebUI-Tray.ps1's FirstRun doesn't install deps when node_modules is missing",
  );
  assert(
    /web\\dist/.test(firstRunBlock[0]) && /bun run build/.test(firstRunBlock[0]),
    "DevWebUI-Tray.ps1's FirstRun doesn't build the GUI when web\\dist is missing",
  );
});

test("adapter: rebuild command and its log filename are declared", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /RebuildCommand\s*=\s*"bun run build"/.test(tray),
    'DevWebUI-Tray.ps1 must declare RebuildCommand = "bun run build"',
  );
  assert(
    /RebuildLogName\s*=\s*"DevWebUI-Rebuild\.log"/.test(tray),
    'DevWebUI-Tray.ps1 must declare RebuildLogName = "DevWebUI-Rebuild.log"',
  );
});

test("adapter: attaches to a live daemon rather than warning/refusing (OnStrayDaemon = attach)", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  assert(
    /OnStrayDaemon\s*=\s*"attach"/.test(tray),
    'DevWebUI-Tray.ps1 must declare OnStrayDaemon = "attach"',
  );
});

// ── Windows-only runtime proofs (the tray is Windows-only) ────────────────────────

test.skipIf(!isWin)(
  "tray self-test passes: bun on PATH + daemon entry + the icon LOADS into a real NotifyIcon (through the real engine)",
  () => {
    const r = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(MISC, "DevWebUI-Tray.ps1"),
        "-SelfTest",
      ],
      { cwd: ROOT },
    );
    const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    assert(
      out.includes("DEVWEBUI_TRAY_SELFTEST_OK"),
      `the tray self-test did not pass:\n${out.trim()}`,
    );
    assert(r.exitCode === 0, `tray self-test exit code ${r.exitCode}:\n${out.trim()}`);
  },
  // 20s: a real PowerShell run that loads an icon into a NotifyIcon and probes PATH. 462ms here.
  20000,
);

test.skipIf(!isWin)(
  "a root shortcut can be (re)generated and resolves to the tray launcher + icon",
  () => {
    // Regenerate the root shortcut — gitignored + per-machine, so this is the canonical
    // way "there is always a shortcut in the root". Then resolve it and prove every hop.
    const gen = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(MISC, "Create-Shortcut.ps1"),
      ],
      { cwd: ROOT },
    );
    assert(gen.exitCode === 0, `Create-Shortcut.ps1 failed:\n${gen.stderr?.toString()?.trim()}`);

    const lnk = join(ROOT, "DevWebUI.lnk");
    assert(
      existsSync(lnk),
      "no DevWebUI.lnk in the project root after running Create-Shortcut.ps1",
    );

    const resolve = [
      `$ws = New-Object -ComObject WScript.Shell;`,
      `$s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}');`,
      `$icon = ($s.IconLocation -split ',')[0];`,
      `$arg = $s.Arguments.Trim([char]34);`,
      // Resolved relative to the EXE's folder, which is how the host itself resolves it.
      `$cfg = Join-Path (Split-Path -Parent $s.TargetPath) $arg;`,
      `[pscustomobject]@{ target=$s.TargetPath; args=$s.Arguments; iconExists=[bool](Test-Path $icon); targetExists=[bool](Test-Path $s.TargetPath); configExists=[bool](Test-Path $cfg) } | ConvertTo-Json -Compress`,
    ].join(" ");
    const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", resolve], { cwd: ROOT });
    const info = JSON.parse((r.stdout?.toString() ?? "{}").trim()) as {
      target: string;
      args: string;
      iconExists: boolean;
      targetExists: boolean;
      configExists: boolean;
    };
    // The shortcut now runs the NATIVE tray host directly. wscript + Tray-Launch.vbs existed only
    // to start PowerShell without a console flash, and the native host suppresses its own console,
    // so both layers are gone: the daemon is created at ~25ms instead of ~475ms.
    assert(
      /lunarwerx-tray\.exe$/i.test(info.target),
      `shortcut target isn't the native tray host: ${info.target}`,
    );
    assert(!/wscript/i.test(info.target), `shortcut still goes through wscript: ${info.target}`);
    // The config filename IS the per-app surface: the binary is generic and shared.
    assert(
      /DevWebUI-Tray\.json/i.test(info.args),
      `shortcut doesn't pass DevWebUI-Tray.json: ${info.args}`,
    );
    assert(info.targetExists, "shortcut points at a lunarwerx-tray.exe that doesn't exist");
    assert(info.configExists, "shortcut names a DevWebUI-Tray.json that doesn't exist");
    assert(info.iconExists, "shortcut's tray icon (DevWebUI.ico) doesn't exist");
    expect(info.iconExists && info.targetExists && info.configExists).toBe(true);
  },
  // 20s: two PowerShell runs, one of which regenerates the .lnk through COM. 882ms here, the
  // slowest test in the file and the one closest to the 5s default.
  20000,
);
