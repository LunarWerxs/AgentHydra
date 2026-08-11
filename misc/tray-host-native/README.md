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
