/**
 * Build the argv that relaunches THIS build of a LunarWerx daemon, pinned to the port it is
 * actually serving on. Returns `[command, ...args]`, ready to hand to buildDetachedSpawn().
 *
 * Every app here self-relaunches to apply an update: it spawns a copy of its own launch command,
 * then shuts down 800ms later to free the port. Each app had hand-rolled that argv, and between
 * them they got it wrong in three different ways. All three fail SILENTLY, which is what made them
 * expensive: spawn() resolves and returns a child object, so the caller's
 * `try { spawn(...) } catch { return /* never exit without a successor *\/ }` guard sees a
 * successor and steps aside. The child dies milliseconds later in a different process. The user
 * sees the app vanish after an update, with nothing in any log.
 *
 * 1. THE EXECUTABLE. `process.argv[0..1]` is the runtime + script only in a source checkout.
 *    Inside a `bun build --compile` binary it is a placeholder pair (verified, Bun 1.3.14):
 *      argv[0] = "bun"                      <- a literal STRING, not a path
 *      argv[1] = "B:/~BUN/root/<app>.exe"   <- virtual, exists only inside the running binary
 *    Respawning that dies with `Module not found "B:/~BUN/root/<app>.exe"` on a machine that
 *    happens to have Bun, and cannot resolve "bun" AT ALL on the machines a compiled release
 *    exists for (no runtime to install is the entire pitch). `process.execPath` is the real
 *    executable in both modes; only the script argument differs.
 *
 * 2. THE COMMAND TOKEN. Apps whose daemon verb is IMPLICIT on a bare launch (`repoyeti` with no
 *    args means `start`; a double-clicked redesign.exe means `serve`) dispatch on argv[0]. Append
 *    a flag to an empty arg list and the FLAG lands in the command slot, so the successor exits
 *    with `Unknown command: --relaunch`. Pass `command` and it is always named explicitly. Omit it
 *    for a bare daemon whose entry takes no verb.
 *
 * 3. THE PORT. `boundPort` is the port the caller is SERVING on, never the one it preferred; those
 *    diverge permanently the first time anything else holds the preferred port. The successor uses
 *    this single value both to wait for the socket to be released and to bind, so the preferred
 *    port makes it wait out its full timeout on a socket nobody is releasing and then bind a port
 *    the user's open tab is not on.
 *
 * The result is a FIXED POINT: feeding a built argv back in returns the same argv. Generation N's
 * argv is generation N+1's input, so blind appending grew it by two tokens per update forever, and
 * Windows command lines are capped. Any inherited port flag and relaunch flag are stripped before
 * the current ones are appended.
 *
 * Runtime-agnostic (Bun + Node) and pure. Synced from the shared kit, do not edit in an app.
 */

/**
 * @param {readonly string[]} argv    Normally `process.argv` (full, including argv[0..1]).
 * @param {object} options
 * @param {string} options.execPath   `process.execPath` — the real executable in both modes.
 * @param {boolean} options.isCompiled  True inside a `bun build --compile` binary.
 * @param {number} options.boundPort  The port actually being served, NOT the preferred one.
 * @param {string} [options.command]  Daemon verb to state explicitly ("start"/"serve"). Omit for
 *                                    an entry that takes no verb.
 * @param {string} [options.portFlag="--port"]
 * @param {string} [options.relaunchFlag="--relaunch"]
 * @param {readonly string[]} [options.valueFlags=[]]  Flags whose NEXT token is a value (e.g.
 *   "--root"). Listed so a value is never re-read as a flag: a root path is allowed to be the
 *   literal string "--port", and mirroring the app's own parse loop is the only way to be sure.
 * @returns {string[]} `[command, ...args]` for buildDetachedSpawn().
 */
export function buildRelaunchArgv(argv, options) {
  const {
    execPath,
    isCompiled,
    boundPort,
    command,
    portFlag = "--port",
    relaunchFlag = "--relaunch",
    valueFlags = [],
  } = options;

  const cli = argv.slice(2);
  // A leading token starting with "-" is a flag, not a verb, so the verb was implicit.
  const hasVerb = command !== undefined && cli.length > 0 && !cli[0].startsWith("-");
  const rest = hasVerb ? cli.slice(1) : cli;
  const verb = command === undefined ? null : hasVerb ? cli[0] : command;

  const kept = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (valueFlags.includes(token) && rest[i + 1] !== undefined) {
      kept.push(token, rest[++i]);
      continue;
    }
    if (token === portFlag && rest[i + 1] !== undefined) {
      i++; // drop the stale pair; the bound port is appended below
      continue;
    }
    if (token === relaunchFlag) continue; // re-appended below, never accumulated
    kept.push(token);
  }

  const tail = [...kept, portFlag, String(boundPort), relaunchFlag];
  const cliOut = verb === null ? tail : [verb, ...tail];
  // Source mode: argv[1] is the real script path and must be passed to the runtime. Compiled:
  // argv[0..1] are placeholders and execPath alone is the whole command.
  return isCompiled || argv[1] === undefined
    ? [execPath, ...cliOut]
    : [execPath, argv[1], ...cliOut];
}
