/** The argv to actually spawn plus whether to pass `detached:true` to the spawn call. */
export interface DetachedSpawn {
  /**
   * The full argv to spawn: on win32 a transient `powershell` that hands the launch to WMI
   * (`Win32_Process.Create`, falling back to a `Start-Process` in that same powershell if WMI
   * refuses); on POSIX the input unchanged. Always a fresh array (never aliases the caller's input).
   */
  argv: string[];
  /**
   * Pass `detached:true` to the spawn call (a POSIX setsid session detach). Always false on win32 —
   * there the WMI hand-off does the detaching, not the spawn flag.
   */
  detached: boolean;
}

/**
 * Quote one argv element into a Windows command-line token (CommandLineToArgvW rules). Exported for
 * the unit tests; callers pass argv arrays and never need this directly.
 */
export function quoteWinArg(arg: string): string;

/**
 * Build the launch for `argv` (`[command, ...args]`) so the spawned child OUTLIVES the daemon (a
 * tray Quit / auto-update relaunch tree-kills the daemon). On win32 the launch is handed to WMI via a
 * transient `powershell`: the WMI service creates the process, so it is born outside our tree AND
 * inherits none of our handles — the latter matters because a `cmd /c start` child inherited the
 * daemon's LISTENING SOCKET and pinned its port (see the `.mjs` header). Returns `detached:false`
 * there. POSIX spawns the command directly with `detached:true` (setsid). Pure + exported for unit
 * tests. See the `.mjs` for the caller responsibilities around `%`/`^` and `.cmd`/`.bat` shims, and
 * for why a console program must not be routed through the win32 path.
 */
export function buildDetachedSpawn(platform: NodeJS.Platform, argv: string[]): DetachedSpawn;
