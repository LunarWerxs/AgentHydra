# Native tray host (spike)

A native Windows tray host, built to answer one question: **how much of an app's launch time is the
PowerShell tray host itself?**

Answer, measured on the author's machine against AgentHydra, alternating runs back to back so both
paths saw identical conditions:

| | daemon process starts | app serving |
|---|---|---|
| `Tray-Launch.vbs` -> `Tray-Host.ps1` | +475 ms | +745-1115 ms |
| native host (`<App>-Tray.exe`) | **+25-27 ms** | **+274 ms** (clean port) / +439-452 ms (same kill-race harness as the PowerShell column) |

Where the PowerShell time goes, measured in isolation (5 runs each):

- `wscript.exe` + the `.vbs` that exists only to suppress a console flash: **~154 ms**
- `powershell.exe -NoProfile -File` reaching the first statement: **~220 ms**
- `Add-Type` of System.Windows.Forms + System.Drawing: **+37 ms**
- parsing and running the real 1,215-line host to its self-test: **~368 ms total**

None of that is the app. A native exe has no script host, no CLR and nothing to parse, and it also
deletes the `.vbs` outright: `CREATE_NO_WINDOW` is what suppresses the console, so the wrapper the
flash-avoidance needed stops being necessary.

## Status: SHIPPING, this is the launcher

The `<App>.lnk` shortcut in AgentHydra, ReDesign, RepoYeti and DevWebUI points straight at this
binary. `misc/*-Tray.ps1` is retained as a working rollback (`Create-Shortcut.ps1 -Legacy`), not as
the primary path. The porting list this section used to carry is done: watchdog, "Rebuild &
Restart", portable-window placement, token-gated shutdown, the sentinel file, balloon tips, the
hide-tray-icon setting, `OnStrayDaemon` and the mutex-loser messages all live here now.

### The one thing WinForms did for free

`Shell_NotifyIcon` is not fire-and-forget, and a hand-rolled host has to cover two cases that
`System.Windows.Forms.NotifyIcon` handled invisibly, which is exactly why they went missing in the
port and stayed missing: nothing is wrong until the machine does something ordinary.

1. **`TaskbarCreated`.** When Explorer restarts, every tray icon on the machine is destroyed and
   each app is expected to add its own back. Register the broadcast with `RegisterWindowMessageW`
   and re-`NIM_ADD` on receipt. This needs a real top-level window: message-only windows do not
   receive broadcasts.
2. **A failed `NIM_ADD` is normal.** Most often the taskbar does not exist yet (a host started at
   logon). Record the actual return value rather than assuming success, and retry; here the health
   tick's visibility sync doubles as a five-second retry loop.

Get either wrong and the failure is silent and permanent: the app runs, the icon is nowhere (not
even in the Windows 11 overflow flyout), and relaunching the shortcut hits the single-instance
branch and just opens the UI, so the user has no way to recover it.

## Design notes

**Zero dependencies, on purpose.** The whole Win32 surface needed is about twenty functions and
four structs, declared in `src/win.rs`. That keeps the kit free of a crate graph it would have to
vendor, audit and build offline, and the release binary is ~291 KB.

**Config is a JSON file beside the exe** (or `argv[1]`), mirroring `$TrayConfig` so the
one-engine-plus-thin-per-app-adapter shape survives the port:

```json
{
  "displayName": "AgentHydra",
  "serviceName": "agenthydra",
  "mutexName": "AgentHydraTrayHost",
  "iconFile": "misc\\AgentHydra.ico",
  "appRoot": "D:\\PublicProjects\\agenthydra",
  "startCommand": "\"C:\\...\\bun.exe\" server/src/index.ts",
  "port": 7787,
  "infoFile": "C:\\Users\\you\\.agenthydra\\runtime.json"
}
```

**Open is the daemon's URL, unless the app has its own window.** By default Open (the menu item, a
double-click, the cold start and a second launch of the shortcut) shows the daemon's live URL in the
browser, or in an app-mode window in portable mode. An app whose window is a native host of its own
names it with `openCommand`, and Open runs that instead, windowless:

```json
"openCommand": {
  "exe": "%SystemRoot%\\System32\\wscript.exe",
  "args": ["//B", "//Nologo", "..\\desk2\\launcher\\start.vbs"],
  "requires": "..\\desk2\\launcher\\start.vbs"
}
```

`exe` and the args are expanded like every other value, a relative `exe` resolves against the
config's folder, the command runs in that folder, and `{URL}` in an arg is the live URL. `requires`
(optional, resolved the same way) names a file the command needs; while it is absent, Open shows the
URL instead, checked at each Open. Name it whenever the window can be missing from a bundle:
`wscript //B` on a missing script fails without a word, so Open would do nothing. A command that
cannot be started falls back to the URL. A malformed `openCommand` is ignored.

**`--background`** (`<App>-Tray.exe <App>-Tray.json --background`) starts the tray without
opening anything, and exits quietly when the tray is already running. It is for an app's own window
launcher, which starts the tray beside the window it is opening anyway.

## What the watchdog writes to `misc/Tray.log`

Every 5 s the health tick probes `/api/health`. Three silent probes in a row count as a death, and
then it either revives the daemon or stands down. Both leave a line (local time), so "why did
nothing restart it" is answered by the log, not by reading code:

- `spawn pid N (tray start | tray Restart | watchdog revive)`, or `respawn pid N (...) - answering
  death of pid M (exit code C, up 12.3s)` when the tray saw the previous wrapper die.
- `death of pid N (exit code C, up 12.3s)`, written by the thread holding that child. A wrapper
  that ends non-zero inside 10 s adds ` - it said: <its stderr>`, so a launch that failed outright
  names why (cmd.exe's own "The system cannot find the path specified.", for one).
- `daemon pid N ended (exit code C: meaning, watched 12s)`, for the daemon itself, whoever started
  it. Every tick that finds it answering opens the pid its runtime pointer names (only when that
  pointer's own url answers) and waits on it, so a self-update successor or a daemon opened by hand
  leaves its exit code too: `3` is a runtime abort, `1` with no `exiting code=` line in
  `logs/daemon.log` an outside kill, `0xC000013A` a closed console.
- `watchdog: the daemon is not answering, and it is NOT being revived: <guard>`, once per guard,
  not every tick. The guards are a Restart/Rebuild still running, a daemon another session owns
  (`watchdogRequiresOwnership`), the 20 s grace after a revive, and the crash-loop pause.
- `watchdog: the daemon answers again` when a stand-down ends, and `watchdog: re-armed` when the
  crash-loop pause lifts.

**The crash-loop pause lifts itself.** Four revives inside 120 s pause auto-restart, and a manual
Restart clears the pause, as before. So does a daemon that then answers for a full 120 s: it has
stopped crash-looping by the guard's own definition. A pause that outlived that once left
AgentHydra's watchdog standing down for 31 hours, until a killed daemon stayed dead.

A daemon this tray starts has its stderr in `logs/daemon-stderr.log` beside the runtime pointer
(the `infoFile` folder). Each launch first writes `-- <why>: <configured start command> --`, never
the token; the file rolls to `daemon-stderr.log.1` past 4 MB when the next launch opens it.

## Four Win32 traps this hit, all of them silent

Worth keeping in the file, because each one presented as "it started fine and then nothing
happened":

1. `CREATE_NO_WINDOW | DETACHED_PROCESS` is an **invalid combination**. CreateProcessW fails with
   ERROR_INVALID_PARAMETER and starts nothing, so an unchecked return reads as success.
2. `cmd /c "C:\path with spaces\x.exe" args` loses the quotes protecting the path, because when the
   text after `/c` begins with a quote cmd strips the first and last quote of the whole line. The
   fix is one more wrapping pair. `cmd.exe` itself starts perfectly, so CreateProcessW still reports
   success while the daemon never runs.
3. A child **inherits the parent's stdio**. A tray launched from a terminal handed the daemon that
   terminal's pipe; nothing drained it, the buffer filled, and the daemon blocked on a console write
   *before binding its port*: a live process with no listening socket and no runtime pointer. The
   daemon now gets `NUL` for stdin and stdout (it already tees its output to `logs/daemon.log`) and
   a file for stderr, `logs/daemon-stderr.log`, which nothing has to drain.
4. `cmd.exe` **cannot run a program named by a `\\?\` path**. `canonicalize()` puts that verbatim
   prefix on every Windows path, the compiled start command is `"<root>\App.exe"`, and cmd answers
   "The system cannot find the path specified." and exits 1 in 0.03 s. Rust's `current_dir` strips
   the prefix itself, so the spawn succeeds and only the wrapper dies. AgentHydra, 2026-10-05: four
   watchdog revives ended `exit code 1, up 0.0s`, the crash-loop guard paused, and the app stayed
   down 35 minutes. The root is now made plain (`plain_path` in `config.rs`); a source checkout
   never showed it, because its command names the interpreter, not the root.

## Build and try

```
cargo build --release
# write <App>-Tray.json beside the exe, then:
LUNARWERX_TRAY_BENCH=1 ./target/release/lunarwerx-tray.exe   # prints timings, no icon
./target/release/lunarwerx-tray.exe                          # real run
LUNARWERX_TRAY_DIAG=1 ./target/release/lunarwerx-tray.exe    # + window/icon diagnostics
```
