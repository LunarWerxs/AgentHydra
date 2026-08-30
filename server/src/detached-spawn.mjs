/**
 * Shared "detached launch" primitive for the LunarWerx daemons — the ONE place that knows how to
 * spawn a child process so it OUTLIVES the daemon (survives a tray Quit or an auto-update relaunch).
 *
 * WHY every kit app needs this: the shared tray host (lunarwerx-ui/src/tray-host/Tray-Host.ps1)
 * Quits by force tree-killing the daemon's whole process tree (`taskkill /PID <daemon> /T /F`), and
 * an auto-update relaunch kills+respawns the daemon the same way. So ANY child the daemon spawns
 * that is meant to keep running past that (a launched app instance, an external editor, a portable
 * chromeless window) must NOT be a descendant of the daemon.
 *
 * The catch (all empirically verified 2026-07-12): on Windows neither `.unref()` nor Node/Bun
 * `detached:true` removes a child from the parent's process tree — a direct spawn is still reaped by
 * `taskkill /T`. So the launch must be handed to a DIFFERENT process creator:
 *   · win32:  WMI `Win32_Process.Create`, driven through a transient `powershell`. The WMI service
 *             creates the process, so it is born outside our tree (detach) AND inherits none of our
 *             handles (see the port-leak note below). `detached` stays false on win32: the detach is
 *             the hand-off, never a spawn flag.
 *   · POSIX:  spawn the command directly with `detached:true` (a genuine setsid session detach).
 *
 * WHY NOT `cmd /c start ""` (what this used to do, 2026-07-12 → 2026-07-15): it detached correctly,
 * but CreateProcess passes bInheritHandles=TRUE, so the launched app inherited every inheritable
 * handle the daemon held — INCLUDING THE DAEMON'S LISTENING SOCKET. The child then pinned the
 * daemon's port for its own lifetime: restart the daemon while a portable window was open and the
 * successor found its port still bound by the dead daemon's ghost socket and hopped to port+1.
 * Verified 2026-07-15 with a real msedge --app window: `cmd /c start` leaked the port, WMI released
 * it while the window stayed open. (A trivial `node -e` child does NOT reproduce it — Chromium's
 * process fleet is what holds the handle. Use a real browser if you ever re-test this.)
 *
 * WMI's own quirks, so nobody re-learns them:
 *   · Win32_Process.Create takes ONE CommandLine string, so argv is quoted back into a command line
 *     with the CommandLineToArgvW rules ({@link quoteWinArg}) rather than passed as an array.
 *   · It launches with a default STARTUPINFO, which means a CONSOLE program gets a VISIBLE console
 *     window. A GUI caller (browser, editor) leaves `hideWindow` unset — ShowWindow=0 can also hide
 *     a GUI app's window. A CONSOLE caller (a bun/node daemon relaunching itself) passes
 *     `hideWindow: true`, which adds a Win32_ProcessStartup ShowWindow=0 to the WMI create —
 *     without it, every auto-update relaunch popped a visible console hosting the successor daemon
 *     (found live 2026-08-30: the owner's recurring mystery "command prompt that says starting").
 *   · If WMI is unavailable/blocked, the fallback below is a `Start-Process` in that same transient
 *     powershell — it replaced an older `cmd /c start ""` fallback (see the WHY NOT above) and keeps
 *     cmd.exe out of the path entirely. A second-choice hand-off beats a window that never opens.
 *
 * CALLER RESPONSIBILITIES (this primitive is deliberately dumb about them; each caller keeps its own
 * guard where it matters):
 *   · The `%VAR%`/`^` cmd re-parse hazard is GONE on BOTH paths now: neither the WMI hand-off nor the
 *     `Start-Process` fallback re-parses through cmd.exe. Callers that still refuse `%`/`^` up front
 *     for untrusted/confined paths are belt-and-suspenders, not load-bearing. See RepoYeti's
 *     cmdReparseHazard.
 *   · Neither path is a way to relaunch a spaced-path `.cmd`/`.bat` shim: WMI CreateProcess won't run
 *     a batch file at all, and the fallback is a second choice you cannot count on reaching (the
 *     `cmd /c start` fallback it replaced hit cmd's double-quote-strip on exactly this) — detach a
 *     real `.exe`. A caller holding a `.cmd` shim should launch it on its own plain `cmd /c`
 *     (undetached) rather than route it through here.
 *   · macOS callers that want LaunchServices semantics build an `open`/`open -a` argv themselves and
 *     pass it through — `open` already hands the launch off, so the POSIX `detached:true` is a
 *     harmless belt-and-suspenders.
 *
 * `argv` is the full command line to launch: `[command, ...args]`. Returns the argv to ACTUALLY
 * spawn plus whether to pass `detached:true` to the spawn call — always a fresh array, never the
 * caller's input. Pure + exported so the per-OS detach contract is locked by unit tests
 * (detached-spawn.test.ts). Runtime-agnostic (Bun + Node); the `.d.mts` sibling types the import for
 * the TypeScript apps. Synced from the shared kit — do not edit in an app.
 */

/**
 * Quote one argv element back into a Windows command-line token, per the CommandLineToArgvW rules
 * every CreateProcess-based launcher parses with: backslashes are literal EXCEPT immediately before
 * a quote, where they double and the quote is escaped. Needed because WMI takes a single string.
 */
export function quoteWinArg(arg) {
  if (arg.length > 0 && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  for (let i = 0; i < arg.length; i++) {
    let slashes = 0;
    while (i < arg.length && arg[i] === "\\") {
      slashes++;
      i++;
    }
    if (i === arg.length) {
      out += "\\".repeat(slashes * 2); // trailing run: doubled so the closing quote stays a quote
      break;
    }
    if (arg[i] === '"') out += `${"\\".repeat(slashes * 2 + 1)}"`;
    else out += "\\".repeat(slashes) + arg[i];
  }
  return `${out}"`;
}

/** Escape a string for a PowerShell single-quoted literal (the only metacharacter is `'`). */
const psLiteral = (s) => `'${s.replace(/'/g, "''")}'`;

export function buildDetachedSpawn(platform, argv, opts = {}) {
  if (platform === "win32") {
    const commandLine = argv.map(quoteWinArg).join(" ");
    // See the header's WMI-quirks note: a console program needs ShowWindow=0 or WMI's default
    // STARTUPINFO gives it a visible console; a GUI program must NOT get it (it can hide the
    // app's own window). The caller knows which kind it is launching.
    const wmiArguments = opts.hideWindow
      ? `@{ CommandLine = ${psLiteral(commandLine)}; ProcessStartupInformation = (New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [UInt16]0 }) }`
      : `@{ CommandLine = ${psLiteral(commandLine)} }`;
    // WMI first (detaches AND inherits no handles); a Start-Process fallback only if WMI refuses,
    // because a leaked handle is a far smaller failure than a process that never launches. `exit 0`
    // keeps a non-zero WMI ReturnValue from reaching the caller as a spawn failure once we've
    // fallen back.
    //
    // NEITHER branch may let an argv element become executable text, and there are THREE parsers to
    // get past, not one. (1) PowerShell CODE: everything is passed as DATA — psLiteral single-quotes
    // each string, so nothing is spliced into the script. (2) cmd.exe: eliminated by not using it —
    // the old `cmd.exe /c "start … <commandLine>"` re-parsed `&` `|` `^` and broke on any path
    // containing them. (3) Start-Process's OWN array-to-command-line flattening: Windows PowerShell
    // (powershell.exe, which `spawn("powershell")` resolves to) space-JOINS -ArgumentList elements
    // WITHOUT quoting ones that contain spaces, so a raw `C:\Program Files\app.exe` element arrived
    // at the child as three tokens — corrupting the successor daemon's args, the very failure this
    // fallback exists to avoid. Fix: pre-quote each element with quoteWinArg (the CommandLineToArgvW
    // token form). The space-join then reconstructs a correct command line, and the child's own
    // CommandLineToArgvW parses it back to the exact original args. quoteWinArg is safe against `&`
    // `|` too: those are inert to CommandLineToArgvW (only cmd treats them specially, and there is
    // no cmd here). `-WindowStyle Hidden` matches the old `start ""` window suppression.
    const psArray = (items) => `@(${items.map((a) => psLiteral(quoteWinArg(a))).join(", ")})`;
    const exe = argv[0];
    const rest = argv.slice(1);
    const startProcess =
      rest.length > 0
        ? `Start-Process -FilePath ${psLiteral(exe)} -ArgumentList ${psArray(rest)} -WindowStyle Hidden`
        : `Start-Process -FilePath ${psLiteral(exe)} -WindowStyle Hidden`;
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      "$rc = 1",
      `try { $rc = (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments ${wmiArguments}).ReturnValue } catch { $rc = 1 }`,
      `if ($rc -ne 0) { ${startProcess} }`,
      "exit 0",
    ].join("; ");
    return {
      argv: ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
      detached: false,
    };
  }
  return { argv: [...argv], detached: true };
}
