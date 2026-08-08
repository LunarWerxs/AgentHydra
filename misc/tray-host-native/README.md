# lunarwerx-tray (spike)

A native Windows tray host, built to answer one question: **how much of an app's launch time is the
PowerShell tray host itself?**

Answer, measured on the author's machine against AgentHydra, alternating runs back to back so both
paths saw identical conditions:

| | daemon process starts | app serving |
|---|---|---|
| `Tray-Launch.vbs` -> `Tray-Host.ps1` | +475 ms | +745-1115 ms |
| `lunarwerx-tray.exe` | **+25-27 ms** | **+274 ms** (clean port) / +439-452 ms (same kill-race harness as the PowerShell column) |

Where the PowerShell time goes, measured in isolation (5 runs each):

- `wscript.exe` + the `.vbs` that exists only to suppress a console flash: **~154 ms**
- `powershell.exe -NoProfile -File` reaching the first statement: **~220 ms**
- `Add-Type` of System.Windows.Forms + System.Drawing: **+37 ms**
- parsing and running the real 1,215-line host to its self-test: **~368 ms total**

None of that is the app. A native exe has no script host, no CLR and nothing to parse, and it also
deletes the `.vbs` outright: `CREATE_NO_WINDOW` is what suppresses the console, so the wrapper the
flash-avoidance needed stops being necessary.

## Status: NOT wired to anything

Nothing uses this. `misc/*-Tray.ps1` remains every app's launcher. This is a spike that proves the
number and the approach; it is not a replacement yet.

**What it does today**: single-instance mutex, spawn the daemon (before building any UI, so the
daemon's ~120 ms boot overlaps our setup), tray icon from the app's own `.ico`, right-click menu
(Open / Restart / Quit), double-click to open, health probe with the PowerShell host's exact
identity rule (`ok:true` AND a matching `service`), runtime-pointer port discovery, and the same
ramped startup poll.

**What it does NOT do yet.** Every one of these exists in `Tray-Host.ps1`, and several were written
in response to real incidents, so they need porting deliberately rather than quickly:

- the crash-loop-guarded auto-restart watchdog (consecutive-miss counting, revive grace, ownership)
- "Rebuild & Restart" and its background worker
- portable-window placement (reading Chromium's `Preferences` for a remembered rect) and the
  dedicated `--app` profile
- token-gated graceful shutdown, and the full-shutdown sentinel file
- balloon tips, the hide-tray-icon setting, the stray/attached-daemon policy (`OnStrayDaemon`)
- the mutex-loser branch's user-facing messages

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

## Three Win32 traps this hit, all of them silent

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
   daemon now gets `NUL` for all three handles (it already tees its output to `logs/daemon.log`).

## Build and try

```
cargo build --release
# write lunarwerx-tray.json beside the exe, then:
LUNARWERX_TRAY_BENCH=1 ./target/release/lunarwerx-tray.exe   # prints timings, no icon
./target/release/lunarwerx-tray.exe                          # real run
LUNARWERX_TRAY_DIAG=1 ./target/release/lunarwerx-tray.exe    # + window/icon diagnostics
```
